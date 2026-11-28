import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, it} from 'node:test';
import {WebSocketServer, type WebSocket} from 'ws';

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('Failed to allocate port')));
      }
    });
  });
}

interface MockSchedule {
  id: string;
  recipient: string;
  content: string;
  scheduled_at: string;
  next_run_at: string;
  status: string;
  recurrence: string;
  message_type: string;
  created_at: string;
  updated_at: string;
  occurrence_count: number;
}

type CreateResponseMode = 'schedule_id' | 'id' | 'none';
type PatchMode = 'ok' | 'missing';

function digitsOf(value: string): string {
  return value.replace(/\D/g, '');
}

describe('P0-2 schedule ownership (integration)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gowa-lite-sched-own-'));
  const dbPath = path.join(tmpDir, 'test.db');

  let mockGowaServer: http.Server;
  let mockGowaWss: WebSocketServer;
  const mockWsClients = new Map<string, WebSocket>();
  let mockGowaPort = 0;
  let appPort = 0;
  let baseUrl = '';
  let serverProc: ChildProcess;

  // Stateful mock gateway schedules.
  let schedules: MockSchedule[] = [];
  let scheduleSeq = 0;
  let createResponseMode: CreateResponseMode = 'schedule_id';
  let patchMode: PatchMode = 'ok';
  let lastCreatedId = '';

  let adminToken = '';
  let agentAToken = '';
  let agentBToken = '';
  let supervisorToken = '';
  let agentAId = 0;

  const chatJid = '966501000001@s.whatsapp.net';

  function futureIso(hoursFromNow = 2): string {
    return new Date(Date.now() + hoursFromNow * 3_600_000).toISOString();
  }

  function seedSchedule(partial: Partial<MockSchedule> & {recipient: string}): MockSchedule {
    scheduleSeq += 1;
    const now = new Date().toISOString();
    const item: MockSchedule = {
      id: `sched-seed-${scheduleSeq}`,
      content: partial.content ?? 'seeded message',
      scheduled_at: partial.scheduled_at ?? futureIso(),
      next_run_at: partial.next_run_at ?? partial.scheduled_at ?? futureIso(),
      status: partial.status ?? 'active',
      recurrence: partial.recurrence ?? 'once',
      message_type: partial.message_type ?? 'text',
      created_at: partial.created_at ?? now,
      updated_at: partial.updated_at ?? now,
      occurrence_count: 0,
      ...partial,
    };
    schedules.push(item);
    return item;
  }

  async function api(
    urlPath: string,
    opts: {method?: string; token?: string; body?: unknown} = {},
  ): Promise<{status: number; body: Record<string, unknown> | null}> {
    const res = await fetch(`${baseUrl}${urlPath}`, {
      method: opts.method ?? 'GET',
      headers: {
        ...(opts.body ? {'Content-Type': 'application/json'} : {}),
        ...(opts.token ? {Authorization: `Bearer ${opts.token}`} : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let body: Record<string, unknown> | null = null;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = null;
    }
    return {status: res.status, body};
  }

  function listData(body: Record<string, unknown> | null): Array<Record<string, unknown>> {
    const results = body?.results as {data?: Array<Record<string, unknown>>} | undefined;
    return results?.data ?? [];
  }

  async function createUser(
    username: string,
    displayName: string,
    roleSlug: string,
  ): Promise<{id: number; token: string}> {
    const roleRes = await api('/api/roles', {token: adminToken});
    const roles = (roleRes.body?.results as Array<{id: number; slug: string}>) ?? [];
    const role = roles.find((r) => r.slug === roleSlug);
    assert.ok(role, `role ${roleSlug} should exist`);
    const createRes = await api('/api/users', {
      method: 'POST',
      token: adminToken,
      body: {display_name: displayName, username, password: 'Password123', role_id: role.id},
    });
    assert.equal(createRes.status, 201, `create user ${username}: ${JSON.stringify(createRes.body)}`);
    const userId = (createRes.body?.results as {id: number}).id;
    const loginRes = await api('/api/auth/login', {
      method: 'POST',
      body: {username, password: 'Password123'},
    });
    assert.equal(loginRes.status, 200, `login ${username}`);
    const token = (loginRes.body?.results as {token: string}).token;
    assert.ok(token, `token for ${username}`);
    return {id: userId, token};
  }

  before(async () => {
    mockGowaServer = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      res.setHeader('Content-Type', 'application/json');

      if (url.pathname === '/devices' && req.method === 'GET') {
        res.end(
          JSON.stringify({
            code: 'SUCCESS',
            message: 'ok',
            results: [{id: 'dev-1', phone_number: '966500000000', state: 'logged_in'}],
          }),
        );
        return;
      }
      if (/^\/devices\/[^/]+\/status$/.test(url.pathname) && req.method === 'GET') {
        res.end(
          JSON.stringify({
            code: 'SUCCESS',
            message: 'ok',
            results: {device_id: 'dev-1', is_connected: true, is_logged_in: true},
          }),
        );
        return;
      }
      if (url.pathname === '/send/schedules' && req.method === 'GET') {
        const search = (url.searchParams.get('search') || '').trim();
        const status = (url.searchParams.get('status') || '').trim();
        const limit = Number(url.searchParams.get('limit') || '100');
        const offset = Number(url.searchParams.get('offset') || '0');
        let items = [...schedules];
        if (search) {
          const searchDigits = digitsOf(search);
          items = items.filter(
            (item) =>
              (searchDigits && digitsOf(item.recipient).includes(searchDigits)) ||
              item.content.includes(search),
          );
        }
        if (status && status !== 'all') {
          items = items.filter((item) => item.status === status);
        }
        const total = items.length;
        const page = items.slice(offset, offset + limit);
        res.end(
          JSON.stringify({
            code: 'SUCCESS',
            message: 'ok',
            results: {data: page, pagination: {limit, offset, total}},
          }),
        );
        return;
      }
      if (url.pathname === '/send/message' && req.method === 'POST') {
        let raw = '';
        req.on('data', (chunk: Buffer) => {
          raw += chunk.toString('utf8');
        });
        req.on('end', () => {
          const payload = JSON.parse(raw || '{}') as Record<string, unknown>;
          scheduleSeq += 1;
          const now = new Date().toISOString();
          const id = `sched-${scheduleSeq}`;
          lastCreatedId = id;
          const item: MockSchedule = {
            id,
            recipient: String(payload.phone || ''),
            content: String(payload.message || ''),
            scheduled_at: String(payload.scheduled_at || ''),
            next_run_at: String(payload.scheduled_at || ''),
            status: 'active',
            recurrence: String(payload.recurrence || 'once'),
            message_type: 'text',
            created_at: now,
            updated_at: now,
            occurrence_count: 0,
          };
          schedules.push(item);
          let results: Record<string, unknown>;
          if (createResponseMode === 'schedule_id') {
            results = {schedule_id: id, status: 'scheduled'};
          } else if (createResponseMode === 'id') {
            results = {id, status: 'scheduled'};
          } else {
            // No schedule id anywhere: forces the list-match fallback.
            // Deliberately includes a message_id which MUST NOT be treated as the schedule id.
            results = {message_id: `WAMID-${scheduleSeq}`, status: 'scheduled'};
          }
          res.end(JSON.stringify({code: 'SUCCESS', message: 'ok', results}));
        });
        return;
      }
      const scheduleAction = url.pathname.match(/^\/send\/schedules\/([^/]+)\/(pause|resume|cancel)$/);
      if (scheduleAction && req.method === 'POST') {
        const [, id, action] = scheduleAction;
        const item = schedules.find((s) => s.id === id);
        if (!item) {
          res.statusCode = 404;
          res.end(JSON.stringify({code: 'NOT_FOUND', message: 'schedule not found'}));
          return;
        }
        item.status = action === 'pause' ? 'paused' : action === 'resume' ? 'active' : 'cancelled';
        item.updated_at = new Date().toISOString();
        res.end(JSON.stringify({code: 'SUCCESS', message: 'ok', results: {id}}));
        return;
      }
      const schedulePatch = url.pathname.match(/^\/send\/schedules\/([^/]+)$/);
      if (schedulePatch && req.method === 'PATCH') {
        if (patchMode === 'missing') {
          res.statusCode = 404;
          res.end(JSON.stringify({code: 'NOT_FOUND', message: 'schedule patch not supported'}));
          return;
        }
        const [, id] = schedulePatch;
        const item = schedules.find((s) => s.id === id);
        if (!item) {
          res.statusCode = 404;
          res.end(JSON.stringify({code: 'NOT_FOUND', message: 'schedule not found'}));
          return;
        }
        let raw = '';
        req.on('data', (chunk: Buffer) => {
          raw += chunk.toString('utf8');
        });
        req.on('end', () => {
          const payload = JSON.parse(raw || '{}') as Record<string, unknown>;
          if (typeof payload.scheduled_at === 'string') {
            item.scheduled_at = payload.scheduled_at;
            item.next_run_at = payload.scheduled_at;
          }
          item.updated_at = new Date().toISOString();
          res.end(
            JSON.stringify({code: 'SUCCESS', message: 'ok', results: {id, scheduled_at: item.scheduled_at}}),
          );
        });
        return;
      }
      res.end(JSON.stringify({code: 'SUCCESS', message: 'ok', results: []}));
    });

    mockGowaWss = new WebSocketServer({server: mockGowaServer, path: '/ws'});
    mockGowaWss.on('connection', (ws, req) => {
      const reqUrl = new URL(req.url || '/ws', 'http://127.0.0.1');
      mockWsClients.set(reqUrl.searchParams.get('device_id') || 'default', ws);
    });

    await new Promise<void>((resolve) => {
      mockGowaServer.listen(0, '127.0.0.1', () => {
        mockGowaPort = (mockGowaServer.address() as net.AddressInfo).port;
        resolve();
      });
    });

    appPort = await getFreePort();
    baseUrl = `http://127.0.0.1:${appPort}`;

    serverProc = spawn('node', ['--import', 'tsx', 'server.ts'], {
      cwd: process.cwd(),
      env: {...process.env, NODE_ENV: 'test', PORT: String(appPort), GOWA_LITE_DB_PATH: dbPath},
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let ready = false;
    // Generous window: sibling worktrees may be running their suites on the same VM.
    for (let i = 0; i < 120; i += 1) {
      try {
        const ping = await fetch(`${baseUrl}/api/auth/status`);
        if (ping.ok) {
          ready = true;
          break;
        }
      } catch {
        // Wait for boot
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(ready, true, 'Express server failed to start');

    const setupRes = await api('/api/auth/setup', {
      method: 'POST',
      body: {
        display_name: 'Admin User',
        username: 'admin',
        password: 'Password123',
        gowa_url: `http://127.0.0.1:${mockGowaPort}`,
        gowa_username: 'gowa',
        gowa_password: 'secret',
      },
    });
    assert.equal(setupRes.status, 201, `setup: ${JSON.stringify(setupRes.body)}`);
    adminToken = (setupRes.body?.results as {token: string}).token;

    const agentA = await createUser('own_agent_a', 'Owner Agent A', 'agent');
    agentAId = agentA.id;
    agentAToken = agentA.token;
    const agentB = await createUser('own_agent_b', 'Other Agent B', 'agent');
    agentBToken = agentB.token;
    const supervisor = await createUser('own_supervisor', 'Supervisor', 'manager');
    supervisorToken = supervisor.token;

    // Agent A owns the test chat so inbox schedule routes pass content access.
    const assignRes = await api(`/api/unified/chats/dev-1/${encodeURIComponent(chatJid)}/assign`, {
      method: 'POST',
      token: adminToken,
      body: {assigned_user_id: agentAId},
    });
    assert.equal(assignRes.status, 200, `assign chat: ${JSON.stringify(assignRes.body)}`);
  });

  after(async () => {
    for (const client of mockWsClients.values()) {
      client.close();
    }
    mockGowaWss?.close();
    if (serverProc && serverProc.exitCode === null) {
      serverProc.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (serverProc && serverProc.exitCode === null) serverProc.kill('SIGKILL');
          resolve();
        }, 1000);
        serverProc!.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    mockGowaServer?.closeAllConnections?.();
    await new Promise<void>((resolve) => mockGowaServer.close(() => resolve()));
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  it('seed grants the agent role schedules:manage', async () => {
    const roleRes = await api('/api/roles', {token: adminToken});
    assert.equal(roleRes.status, 200);
    const roles = (roleRes.body?.results as Array<{slug: string; permissions: string[]}>) ?? [];
    const agentRole = roles.find((r) => r.slug === 'agent');
    assert.ok(agentRole, 'agent role should exist');
    assert.ok(
      agentRole.permissions.includes('schedules:manage'),
      'agent role must include schedules:manage',
    );
  });

  it('creation via the devices route records ownership: owner acts, other agent gets 403, admin succeeds, lists annotate can_manage', async () => {
    createResponseMode = 'schedule_id';
    const phone = '966501000101';
    const createRes = await api('/api/devices/dev-1/schedules', {
      method: 'POST',
      token: agentAToken,
      body: {phone, message: 'owner-device-create', scheduled_at: futureIso(), recurrence: 'once'},
    });
    assert.equal(createRes.status, 201, JSON.stringify(createRes.body));
    const scheduleId = (createRes.body?.results as {schedule_id?: string}).schedule_id;
    assert.ok(scheduleId, 'create response should carry the schedule id');

    const listA = await api('/api/devices/dev-1/schedules?search=966501000101', {token: agentAToken});
    const rowA = listData(listA.body).find((row) => row.id === scheduleId);
    assert.ok(rowA, 'owner list should contain the schedule');
    assert.equal(rowA.can_manage, true, 'owner must see can_manage=true');

    const listB = await api('/api/devices/dev-1/schedules?search=966501000101', {token: agentBToken});
    const rowB = listData(listB.body).find((row) => row.id === scheduleId);
    assert.ok(rowB, 'other agent list should still contain the schedule (read is not scoped)');
    assert.equal(rowB.can_manage, false, 'other agent must see can_manage=false');

    const listAdmin = await api('/api/devices/dev-1/schedules?search=966501000101', {token: adminToken});
    const rowAdmin = listData(listAdmin.body).find((row) => row.id === scheduleId);
    assert.equal(rowAdmin?.can_manage, true, 'admin must see can_manage=true');

    const otherPause = await api(`/api/devices/dev-1/schedules/${scheduleId}/pause`, {
      method: 'POST',
      token: agentBToken,
    });
    assert.equal(otherPause.status, 403, `other agent pause must be 403, got ${otherPause.status}`);

    const ownerPause = await api(`/api/devices/dev-1/schedules/${scheduleId}/pause`, {
      method: 'POST',
      token: agentAToken,
    });
    assert.equal(ownerPause.status, 200, JSON.stringify(ownerPause.body));

    const adminResume = await api(`/api/devices/dev-1/schedules/${scheduleId}/resume`, {
      method: 'POST',
      token: adminToken,
    });
    assert.equal(adminResume.status, 200, JSON.stringify(adminResume.body));
  });

  it('creation with no id in the gateway response records ownership via unambiguous list match', async () => {
    createResponseMode = 'none';
    const phone = '966501000102';
    const createRes = await api('/api/devices/dev-1/schedules', {
      method: 'POST',
      token: agentAToken,
      body: {phone, message: 'fallback-match-create', scheduled_at: futureIso(), recurrence: 'once'},
    });
    assert.equal(createRes.status, 201, JSON.stringify(createRes.body));
    assert.ok(lastCreatedId, 'mock should have recorded the created id');

    const ownerPause = await api(`/api/devices/dev-1/schedules/${lastCreatedId}/pause`, {
      method: 'POST',
      token: agentAToken,
    });
    assert.equal(ownerPause.status, 200, `owner pause via list-match ownership: ${JSON.stringify(ownerPause.body)}`);

    const otherResume = await api(`/api/devices/dev-1/schedules/${lastCreatedId}/resume`, {
      method: 'POST',
      token: agentBToken,
    });
    assert.equal(otherResume.status, 403, 'other agent must not manage a list-matched schedule');
  });

  it('ambiguous list match records nothing: schedule stays admin-only', async () => {
    createResponseMode = 'none';
    const phone = '966501000103';
    const scheduledAt = futureIso();
    const message = 'ambiguous-create';
    // Two pre-existing identical schedules: same phone + time + text, created just now.
    seedSchedule({recipient: phone, content: message, scheduled_at: scheduledAt});
    seedSchedule({recipient: phone, content: message, scheduled_at: scheduledAt});

    const createRes = await api('/api/devices/dev-1/schedules', {
      method: 'POST',
      token: agentAToken,
      body: {phone, message, scheduled_at: scheduledAt, recurrence: 'once'},
    });
    assert.equal(createRes.status, 201, JSON.stringify(createRes.body));
    const createdId = lastCreatedId;
    assert.ok(createdId, 'mock should have recorded the created id');

    const ownerPause = await api(`/api/devices/dev-1/schedules/${createdId}/pause`, {
      method: 'POST',
      token: agentAToken,
    });
    assert.equal(ownerPause.status, 403, 'ambiguous create must leave the schedule admin-only');

    const adminPause = await api(`/api/devices/dev-1/schedules/${createdId}/pause`, {
      method: 'POST',
      token: adminToken,
    });
    assert.equal(adminPause.status, 200, JSON.stringify(adminPause.body));
  });

  it('unmapped pre-existing schedule: agent gets 403, admin succeeds', async () => {
    const seeded = seedSchedule({recipient: '966501000104', content: 'pre-existing schedule'});
    const agentPause = await api(`/api/devices/dev-1/schedules/${seeded.id}/pause`, {
      method: 'POST',
      token: agentAToken,
    });
    assert.equal(agentPause.status, 403, 'agent must not manage an unmapped schedule');
    const adminPause = await api(`/api/devices/dev-1/schedules/${seeded.id}/pause`, {
      method: 'POST',
      token: adminToken,
    });
    assert.equal(adminPause.status, 200, JSON.stringify(adminPause.body));
  });

  it('cancel deletes the ownership mapping', async () => {
    createResponseMode = 'schedule_id';
    const phone = '966501000105';
    const createRes = await api('/api/devices/dev-1/schedules', {
      method: 'POST',
      token: agentAToken,
      body: {phone, message: 'cancel-deletes-mapping', scheduled_at: futureIso(), recurrence: 'once'},
    });
    assert.equal(createRes.status, 201, JSON.stringify(createRes.body));
    const scheduleId = (createRes.body?.results as {schedule_id?: string}).schedule_id;
    assert.ok(scheduleId);

    const cancelRes = await api(`/api/devices/dev-1/schedules/${scheduleId}/cancel`, {
      method: 'POST',
      token: agentAToken,
    });
    assert.equal(cancelRes.status, 200, JSON.stringify(cancelRes.body));

    const listA = await api('/api/devices/dev-1/schedules?search=966501000105&status=all', {
      token: agentAToken,
    });
    const rowA = listData(listA.body).find((row) => row.id === scheduleId);
    assert.ok(rowA, 'cancelled schedule should still be listed with status=all');
    assert.equal(rowA.can_manage, false, 'cancel must delete the ownership mapping');
  });

  it('reschedule via PATCH keeps ownership; other agent PATCH gets 403', async () => {
    createResponseMode = 'schedule_id';
    patchMode = 'ok';
    // Devices route has no PATCH; use the inbox PATCH path on the assigned chat.
    const inboxCreate = await api(
      `/api/unified/chats/dev-1/${encodeURIComponent(chatJid)}/schedules`,
      {
        method: 'POST',
        token: agentAToken,
        body: {message: 'patch-keeps-ownership-inbox', scheduled_at: futureIso(), recurrence: 'once'},
      },
    );
    assert.equal(inboxCreate.status, 201, JSON.stringify(inboxCreate.body));
    const inboxId = (inboxCreate.body?.results as {schedule_id?: string}).schedule_id;
    assert.ok(inboxId, 'inbox create should return the schedule id');

    const otherPatch = await api(
      `/api/unified/chats/dev-1/${encodeURIComponent(chatJid)}/schedules/${inboxId}`,
      {
        method: 'PATCH',
        token: agentBToken,
        body: {scheduled_at: futureIso(3)},
      },
    );
    assert.equal(otherPatch.status, 403, `other agent PATCH must be 403, got ${otherPatch.status}`);

    const ownerPatch = await api(
      `/api/unified/chats/dev-1/${encodeURIComponent(chatJid)}/schedules/${inboxId}`,
      {
        method: 'PATCH',
        token: agentAToken,
        body: {scheduled_at: futureIso(3)},
      },
    );
    assert.equal(ownerPatch.status, 200, JSON.stringify(ownerPatch.body));

    const ownerPause = await api(
      `/api/unified/chats/dev-1/${encodeURIComponent(chatJid)}/schedules/${inboxId}/pause`,
      {method: 'POST', token: agentAToken},
    );
    assert.equal(ownerPause.status, 200, 'ownership must survive a PATCH reschedule');
  });

  it('reschedule fallback (gateway PATCH 404) transfers ownership to the new id', async () => {
    createResponseMode = 'schedule_id';
    patchMode = 'missing';
    const inboxCreate = await api(
      `/api/unified/chats/dev-1/${encodeURIComponent(chatJid)}/schedules`,
      {
        method: 'POST',
        token: agentAToken,
        body: {message: 'fallback-transfer', scheduled_at: futureIso(), recurrence: 'once'},
      },
    );
    assert.equal(inboxCreate.status, 201, JSON.stringify(inboxCreate.body));
    const oldId = (inboxCreate.body?.results as {schedule_id?: string}).schedule_id;
    assert.ok(oldId);

    const ownerPatch = await api(
      `/api/unified/chats/dev-1/${encodeURIComponent(chatJid)}/schedules/${oldId}`,
      {
        method: 'PATCH',
        token: agentAToken,
        body: {scheduled_at: futureIso(4)},
      },
    );
    assert.equal(ownerPatch.status, 200, JSON.stringify(ownerPatch.body));
    const newId = (ownerPatch.body?.results as {schedule_id?: string}).schedule_id;
    assert.ok(newId, 'fallback reschedule should return the new schedule id');
    assert.notEqual(newId, oldId, 'fallback reschedule must create a new schedule id');

    const ownerPauseNew = await api(
      `/api/unified/chats/dev-1/${encodeURIComponent(chatJid)}/schedules/${newId}/pause`,
      {method: 'POST', token: agentAToken},
    );
    assert.equal(ownerPauseNew.status, 200, 'owner must manage the transferred schedule');

    const otherPauseNew = await api(
      `/api/unified/chats/dev-1/${encodeURIComponent(chatJid)}/schedules/${newId}/pause`,
      {method: 'POST', token: agentBToken},
    );
    assert.equal(otherPauseNew.status, 403, 'other agent must not manage the transferred schedule');

    const listA = await api(`/api/unified/chats/dev-1/${encodeURIComponent(chatJid)}/schedules`, {
      token: agentAToken,
    });
    const rows = listData(listA.body);
    const oldRow = rows.find((row) => row.id === oldId);
    const newRow = rows.find((row) => row.id === newId);
    assert.ok(newRow, 'transferred schedule should be listed');
    assert.equal(newRow.can_manage, true, 'transferred schedule must be manageable by its owner');
    if (oldRow) {
      assert.equal(oldRow.can_manage, false, 'old id must lose its ownership mapping');
    }
    patchMode = 'ok';
  });

  it('inbox routes enforce ownership: supervisor-owned schedule is 403 for the chat assignee, owner schedule works, lists annotate', async () => {
    createResponseMode = 'schedule_id';
    patchMode = 'ok';

    // Supervisor (manager, view_all) creates a schedule on agent A's assigned chat.
    const supCreate = await api(
      `/api/unified/chats/dev-1/${encodeURIComponent(chatJid)}/schedules`,
      {
        method: 'POST',
        token: supervisorToken,
        body: {message: 'supervisor schedule', scheduled_at: futureIso(), recurrence: 'once'},
      },
    );
    assert.equal(supCreate.status, 201, JSON.stringify(supCreate.body));
    const supId = (supCreate.body?.results as {schedule_id?: string}).schedule_id;
    assert.ok(supId);

    // Agent A owns the chat (content access passes) but not the schedule.
    const agentAction = await api(
      `/api/unified/chats/dev-1/${encodeURIComponent(chatJid)}/schedules/${supId}/pause`,
      {method: 'POST', token: agentAToken},
    );
    assert.equal(agentAction.status, 403, `agent must not manage supervisor schedule, got ${agentAction.status}`);

    const agentPatch = await api(
      `/api/unified/chats/dev-1/${encodeURIComponent(chatJid)}/schedules/${supId}`,
      {method: 'PATCH', token: agentAToken, body: {scheduled_at: futureIso(3)}},
    );
    assert.equal(agentPatch.status, 403, 'agent PATCH on supervisor schedule must be 403');

    const adminAction = await api(
      `/api/unified/chats/dev-1/${encodeURIComponent(chatJid)}/schedules/${supId}/pause`,
      {method: 'POST', token: adminToken},
    );
    assert.equal(adminAction.status, 200, 'admin must manage any schedule');

    // Agent A creates their own schedule on the same chat.
    const ownCreate = await api(
      `/api/unified/chats/dev-1/${encodeURIComponent(chatJid)}/schedules`,
      {
        method: 'POST',
        token: agentAToken,
        body: {message: 'agent own inbox schedule', scheduled_at: futureIso(), recurrence: 'once'},
      },
    );
    assert.equal(ownCreate.status, 201, JSON.stringify(ownCreate.body));
    const ownId = (ownCreate.body?.results as {schedule_id?: string}).schedule_id;
    assert.ok(ownId);

    const ownPause = await api(
      `/api/unified/chats/dev-1/${encodeURIComponent(chatJid)}/schedules/${ownId}/pause`,
      {method: 'POST', token: agentAToken},
    );
    assert.equal(ownPause.status, 200, 'owner must manage their own inbox schedule');

    const listA = await api(`/api/unified/chats/dev-1/${encodeURIComponent(chatJid)}/schedules`, {
      token: agentAToken,
    });
    const rows = listData(listA.body);
    const supRow = rows.find((row) => row.id === supId);
    const ownRow = rows.find((row) => row.id === ownId);
    assert.ok(supRow && ownRow, 'both schedules should be listed');
    assert.equal(supRow.can_manage, false, 'supervisor schedule must show can_manage=false for agent A');
    assert.equal(ownRow.can_manage, true, 'own schedule must show can_manage=true for agent A');
  });
});
