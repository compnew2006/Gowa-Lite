import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import fs from 'node:fs';
import {createServer, type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, it} from 'node:test';
import {WebSocket} from 'ws';

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

describe('Daily Assigned-Chat Reset Service & Scheduler', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gowa-lite-daily-reset-unit-'));
  const unitDbPath = path.join(tmpDir, 'unit.db');

  let dbMod: typeof import('../server/db.ts');
  let lifecycleMod: typeof import('../server/services/chat-lifecycle.ts');
  let dailyResetMod: typeof import('../server/services/chat-daily-reset.ts');
  let wsMod: typeof import('../server/ws-bridge.ts');

  before(async () => {
    process.env.GOWA_LITE_DB_PATH = unitDbPath;
    dbMod = await import('../server/db.ts');
    lifecycleMod = await import('../server/services/chat-lifecycle.ts');
    dailyResetMod = await import('../server/services/chat-daily-reset.ts');
    wsMod = await import('../server/ws-bridge.ts');
  });

  after(() => {
    dbMod?.closeDatabaseSafely();
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  it('resets only assigned open customer chats for the target device and skips closed, pending, and other devices', () => {
    const roles = dbMod.listRoles();
    const agentRole = roles.find((r) => r.slug === 'agent')!;
    const adminRole = roles.find((r) => r.slug === 'admin')!;

    const admin = dbMod.createUser({
      username: 'reset_admin',
      display_name: 'Reset Admin',
      role: 'admin',
      role_id: adminRole.id,
      password: 'Password123',
    });
    const agent = dbMod.createUser({
      username: 'reset_agent',
      display_name: 'Reset Agent',
      role: 'agent',
      role_id: agentRole.id,
      allowed_device_ids: ['line-a', 'line-b'],
      password: 'Password123',
    });

    const openJid1 = '201000001001@s.whatsapp.net';
    const openJid2 = '201000001002@s.whatsapp.net';
    const closedJid = '201000001003@s.whatsapp.net';
    const pendingJid = '201000001004@s.whatsapp.net';
    const otherDeviceJid = '201000001005@s.whatsapp.net';

    lifecycleMod.claimChat(agent, 'line-a', openJid1);
    lifecycleMod.claimChat(agent, 'line-a', openJid2);
    lifecycleMod.claimChat(agent, 'line-a', closedJid);
    lifecycleMod.closeChat(admin, 'line-a', closedJid, {reason: 'done'});

    // Pending row (claimed then released)
    lifecycleMod.claimChat(agent, 'line-a', pendingJid);
    lifecycleMod.releaseChat(admin, 'line-a', pendingJid);

    // Assigned open chat on another device
    lifecycleMod.claimChat(agent, 'line-b', otherDeviceJid);

    const result = dailyResetMod.resetAssignedChatsForDevice('line-a', {
      actorUserId: null,
      actorName: 'System',
      trigger: 'manual',
    });
    assert.ok(result);
    assert.equal(result.reset_count, 2);
    assert.deepEqual(result.chat_jids.sort(), [openJid1, openJid2].sort());

    const after1 = lifecycleMod.getChatLifecycleState('line-a', openJid1);
    assert.equal(after1.status, 'pending');
    assert.equal(after1.assigned_user_id, null);

    const after2 = lifecycleMod.getChatLifecycleState('line-a', openJid2);
    assert.equal(after2.status, 'pending');
    assert.equal(after2.assigned_user_id, null);

    const closedAfter = lifecycleMod.getChatLifecycleState('line-a', closedJid);
    assert.equal(closedAfter.status, 'closed');

    const otherAfter = lifecycleMod.getChatLifecycleState('line-b', otherDeviceJid);
    assert.equal(otherAfter.status, 'open');
    assert.equal(otherAfter.assigned_user_id, agent.id);

    const events1 = lifecycleMod.listChatLifecycleEvents('line-a', openJid1);
    assert.equal(events1[events1.length - 1]?.event_type, 'released');
    assert.equal(events1[events1.length - 1]?.actor_name, 'System');

    // Idempotent second run
    const second = dailyResetMod.resetAssignedChatsForDevice('line-a', {trigger: 'manual'});
    assert.ok(second);
    assert.equal(second.reset_count, 0);
  });

  it('runs scheduled resets once per local day in the configured timezone and survives missed minutes', () => {
    const roles = dbMod.listRoles();
    const agentRole = roles.find((r) => r.slug === 'agent')!;
    const agent = dbMod.createUser({
      username: 'sched_agent',
      display_name: 'Sched Agent',
      role: 'agent',
      role_id: agentRole.id,
      allowed_device_ids: ['line-tz'],
      password: 'Password123',
    });

    const defaults = dailyResetMod.getDailyResetSettings('line-tz');
    assert.equal(defaults.enabled, false);
    assert.equal(defaults.reset_hour, 2);

    assert.throws(
      () => dailyResetMod.updateDailyResetSettings('line-tz', {enabled: true, reset_hour: 24}),
      /23/,
    );
    assert.throws(
      () =>
        dailyResetMod.updateDailyResetSettings('line-tz', {
          enabled: true,
          reset_hour: 2,
          timezone: 'Invalid/Zone_Name',
        }),
    );

    // 2026-06-15T22:30:00Z == 2026-06-16 01:30 in Asia/Riyadh (UTC+3).
    // Configure reset_hour = 2 in Asia/Riyadh. Because local hour is 1 (< 2), it is armed for 02:00.
    const tBefore = new Date('2026-06-15T22:30:00.000Z');
    const saved = dailyResetMod.updateDailyResetSettings(
      'line-tz',
      {enabled: true, reset_hour: 2, timezone: 'Asia/Riyadh'},
      tBefore,
    );
    assert.equal(saved.enabled, true);
    assert.equal(saved.reset_hour, 2);
    assert.equal(saved.timezone, 'Asia/Riyadh');
    assert.equal(saved.last_run_date, '');

    const chatJid = '201000002001@s.whatsapp.net';
    lifecycleMod.claimChat(agent, 'line-tz', chatJid);

    const broadcasted: unknown[] = [];
    const fakeWs = {
      broadcast(payload: unknown) {
        broadcasted.push(payload);
      },
    } as unknown as import('../server/ws-bridge.ts').GowaWsBridge;

    // 01:30 Riyadh -> must NOT run yet
    const earlyRun = dailyResetMod.runDailyChatResetTick(fakeWs, tBefore);
    assert.equal(earlyRun.length, 0);
    assert.equal(lifecycleMod.getChatLifecycleState('line-tz', chatJid).status, 'open');

    // 2026-06-15T23:12:00Z == 2026-06-16 02:12 in Asia/Riyadh -> MUST run (even at :12 past the hour)
    const tDue = new Date('2026-06-15T23:12:00.000Z');
    const dueRun = dailyResetMod.runDailyChatResetTick(fakeWs, tDue);
    assert.equal(dueRun.length, 1);
    assert.equal(dueRun[0].reset_count, 1);
    assert.equal(dueRun[0].run_date, '2026-06-16');
    assert.equal(lifecycleMod.getChatLifecycleState('line-tz', chatJid).status, 'pending');
    assert.equal(broadcasted.length, 1);

    // Agent claims chat again later the same local day (10:00 Riyadh) -> tick at 10:05 must NOT re-run
    lifecycleMod.claimChat(agent, 'line-tz', chatJid);
    const tSameDay = new Date('2026-06-16T07:05:00.000Z');
    const sameDayRun = dailyResetMod.runDailyChatResetTick(fakeWs, tSameDay);
    assert.equal(sameDayRun.length, 0);
    assert.equal(lifecycleMod.getChatLifecycleState('line-tz', chatJid).status, 'open');

    // Next local day 02:00 Riyadh (2026-06-16T23:00:00Z) -> MUST run again
    const tNextDay = new Date('2026-06-16T23:00:00.000Z');
    const nextDayRun = dailyResetMod.runDailyChatResetTick(fakeWs, tNextDay);
    assert.equal(nextDayRun.length, 1);
    assert.equal(nextDayRun[0].reset_count, 1);
    assert.equal(nextDayRun[0].run_date, '2026-06-17');
    assert.equal(lifecycleMod.getChatLifecycleState('line-tz', chatJid).status, 'pending');
  });

  it('prevents mid-day ambush when enabling a past hour and authorizes WS delivery by device and role', () => {
    // 15:00 UTC -> enabling reset_hour = 2 marks today as already passed so it starts tomorrow
    const afternoon = new Date('2026-06-20T15:00:00.000Z');
    const settings = dailyResetMod.updateDailyResetSettings(
      'line-afternoon',
      {enabled: true, reset_hour: 2, timezone: 'UTC'},
      afternoon,
    );
    assert.equal(settings.last_run_date, '2026-06-20');

    const sameAfternoonRun = dailyResetMod.runDailyChatResetTick(
      undefined,
      new Date('2026-06-20T15:05:00.000Z'),
    );
    assert.equal(
      sameAfternoonRun.some((r) => r.device_id === 'line-afternoon'),
      false,
    );

    // WS authorization check
    const roles = dbMod.listRoles();
    const agentRole = roles.find((r) => r.slug === 'agent')!;
    const restrictedAgent = dbMod.createUser({
      username: 'restricted_ws_agent',
      display_name: 'Restricted',
      role: 'agent',
      role_id: agentRole.id,
      allowed_device_ids: ['line-other'],
      password: 'Password123',
    });
    const allowedAgent = dbMod.createUser({
      username: 'allowed_ws_agent',
      display_name: 'Allowed',
      role: 'agent',
      role_id: agentRole.id,
      allowed_device_ids: ['line-tz'],
      password: 'Password123',
    });

    const payload = dailyResetMod.buildDailyResetWsPayload({
      device_id: 'line-tz',
      reset_count: 1,
      chat_jids: ['201000002001@s.whatsapp.net'],
      run_at: new Date().toISOString(),
      run_date: '2026-06-20',
      trigger: 'schedule',
    });

    assert.equal(wsMod.shouldDeliverWsEventToUser(restrictedAgent, payload).allowed, false);
    assert.equal(wsMod.shouldDeliverWsEventToUser(allowedAgent, payload).allowed, true);
  });
});

describe('Daily Assigned-Chat Reset HTTP & WebSocket Integration', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'gowa-lite-daily-reset-int-'));
  let gateway: Server;
  let app: ChildProcess;
  let base: string;
  let adminToken: string;
  let agentToken: string;
  let agentId: number;

  function api(routePath: string, method = 'GET', body?: unknown, auth = adminToken) {
    return fetch(base + '/api' + routePath, {
      method,
      headers: {Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  before(async () => {
    gateway = createServer((req, res) => {
      const reqPath = new URL(req.url!, 'http://localhost').pathname;
      if (reqPath === '/devices') {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            code: 'SUCCESS',
            results: [
              {id: 'line-1', jid: '201000000001@s.whatsapp.net', state: 'logged_in'},
              {id: 'line-2', jid: '201000000002@s.whatsapp.net', state: 'logged_in'},
            ],
          }),
        );
        return;
      }
      res.writeHead(404).end();
    });
    const gatewayPort = await listen(gateway);
    const probe = createServer();
    const appPort = await listen(probe);
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    base = `http://127.0.0.1:${appPort}`;
    app = spawn(process.execPath, ['server.ts'], {
      env: {
        ...process.env,
        NODE_ENV: 'production',
        PORT: String(appPort),
        ADMIN_PASSCODE: 'DailyResetPasscode123',
        GOWA_LITE_DB_PATH: joinDb(folder),
        GOWA_URL: `http://127.0.0.1:${gatewayPort}`,
        BLOCK_PRIVATE_GOWA_URL: 'false',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    app.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    for (let attempt = 0; attempt < 60; attempt++) {
      if (await fetch(base + '/api/auth/status').then((r) => r.ok).catch(() => false)) break;
      if (attempt === 59) assert.fail(stderr || 'Server did not start');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const adminLogin = await (
      await api('/auth/login', 'POST', {username: 'admin', password: 'DailyResetPasscode123'}, '')
    ).json();
    adminToken = adminLogin.results.token;

    const rolesRes = await (await api('/roles')).json();
    const agentRole = rolesRes.results.find((r: {slug: string}) => r.slug === 'agent');
    const createdAgent = await (
      await api('/users', 'POST', {
        username: 'ops_agent',
        display_name: 'Ops Agent',
        password: 'AgentPassword123',
        role_id: agentRole.id,
        allowed_device_ids: ['line-1'],
      })
    ).json();
    agentId = createdAgent.results.id;

    const agentLogin = await (
      await api('/auth/login', 'POST', {username: 'ops_agent', password: 'AgentPassword123'}, '')
    ).json();
    agentToken = agentLogin.results.token;
  });

  after(async () => {
    if (app && app.exitCode === null) {
      await new Promise<void>((resolve) => {
        app.once('exit', () => resolve());
        app.kill('SIGTERM');
      });
    }
    gateway?.closeAllConnections();
    if (gateway) await new Promise<void>((resolve) => gateway.close(() => resolve()));
    fs.rmSync(folder, {recursive: true, force: true});
  });

  it('enforces RBAC, validates hour/timezone, runs manual reset, and broadcasts CHAT_DAILY_RESET over WS', async () => {
    // Agent can read allowed device settings, forbidden from unpermitted device or writes
    const agentReadOk = await api('/devices/line-1/daily-reset', 'GET', undefined, agentToken);
    assert.equal(agentReadOk.status, 200);
    const agentReadForbidden = await api('/devices/line-2/daily-reset', 'GET', undefined, agentToken);
    assert.equal(agentReadForbidden.status, 403);
    const agentPutForbidden = await api(
      '/devices/line-1/daily-reset',
      'PUT',
      {enabled: true, reset_hour: 4, timezone: 'UTC'},
      agentToken,
    );
    assert.equal(agentPutForbidden.status, 403);
    const agentRunForbidden = await api('/devices/line-1/daily-reset/run', 'POST', {}, agentToken);
    assert.equal(agentRunForbidden.status, 403);

    // Validation errors
    const badHour = await api('/devices/line-1/daily-reset', 'PUT', {
      enabled: true,
      reset_hour: 25,
      timezone: 'UTC',
    });
    assert.equal(badHour.status, 400);

    const badTz = await api('/devices/line-1/daily-reset', 'PUT', {
      enabled: true,
      reset_hour: 3,
      timezone: 'Mars/Olympus',
    });
    assert.equal(badTz.status, 400);

    // Valid update
    const saveRes = await api('/devices/line-1/daily-reset', 'PUT', {
      enabled: true,
      reset_hour: 3,
      timezone: 'Asia/Riyadh',
    });
    assert.equal(saveRes.status, 200);
    const saveJson = await saveRes.json();
    assert.equal(saveJson.results.enabled, true);
    assert.equal(saveJson.results.reset_hour, 3);
    assert.equal(saveJson.results.timezone, 'Asia/Riyadh');

    // Claim a chat as the agent on line-1
    const jid = '201000009999@s.whatsapp.net';
    const claimRes = await api(
      `/unified/chats/line-1/${encodeURIComponent(jid)}/claim`,
      'POST',
      {},
      agentToken,
    );
    assert.equal(claimRes.status, 200);

    // Open WS connection as admin and wait for CHAT_DAILY_RESET
    const ticketRes = await (await api('/auth/ws-ticket', 'POST', {})).json();
    const wsUrl = base.replace('http://', 'ws://') + `/ws?ticket=${ticketRes.results.ticket}`;
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    const resetWsPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for CHAT_DAILY_RESET')), 4000);
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
        if (msg.code === 'CHAT_DAILY_RESET') {
          clearTimeout(timer);
          resolve(msg);
        }
      });
    });

    try {
      const runRes = await api('/devices/line-1/daily-reset/run', 'POST', {});
      assert.equal(runRes.status, 200);
      const runJson = await runRes.json();
      assert.equal(runJson.results.reset_count, 1);
      assert.deepEqual(runJson.results.chat_jids, [jid]);

      const wsMsg = await resetWsPromise;
      assert.equal(wsMsg.device_id, 'line-1');

      const lifecycleRes = await (
        await api(`/unified/chats/line-1/${encodeURIComponent(jid)}/lifecycle`)
      ).json();
      assert.equal(lifecycleRes.results.assignment.status, 'pending');
      assert.equal(lifecycleRes.results.assignment.assigned_user_id, null);

      const settingsAfter = await (await api('/devices/line-1/daily-reset')).json();
      assert.equal(settingsAfter.results.last_reset_count, 1);
      assert.ok(settingsAfter.results.last_run_at);
      assert.ok(agentId > 0);
    } finally {
      ws.terminate();
    }
  });
});

function joinDb(folder: string): string {
  return path.join(folder, 'integration.db');
}
