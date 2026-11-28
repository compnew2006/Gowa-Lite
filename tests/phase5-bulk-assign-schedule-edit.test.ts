import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, it} from 'node:test';
import {buildBulkLifecycleRequest} from '../src/features/chat/use-inbox-controller.ts';
import type {UnifiedChat} from '../src/api/types.ts';

/**
 * Phase 5 path F — P2-8 (bulk assign to a chosen agent) + P2-9 (edit a
 * schedule from the Scheduled page).
 *
 * P2-8: the bulk-lifecycle endpoint already accepts `assign` with
 * `options.assignedUserId` (chat-lifecycle.ts); only the frontend is
 * missing — the request builder must carry an explicit target agent instead
 * of always the current user, and the bar must offer the choice.
 *
 * P2-9: the Scheduled page has no edit route at all (only GET / POST create
 * / POST action in routes/schedules.ts). The new PATCH route reuses the
 * drawer's reschedule service (PATCH-first, recreate-then-cancel fallback).
 * Order matters: create the new schedule first, then cancel the old one;
 * if the old cancel fails the new one is rolled back so the two are never
 * silently active together — and if even the rollback fails the error must
 * say so explicitly (RESCHEDULE_ROLLBACK_FAILED) instead of claiming a
 * rollback that did not happen.
 */

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

function makeChat(deviceId: string, jid: string): UnifiedChat {
  return {device_id: deviceId, jid} as UnifiedChat;
}

describe('P2-8 buildBulkLifecycleRequest carries an explicit assignee', () => {
  const chats = [
    makeChat('dev-alpha', '966501111111@s.whatsapp.net'),
    makeChat('dev-alpha', '966502222222@s.whatsapp.net'),
  ];

  it('assigns the selection to the chosen agent, not to the current user', () => {
    const req = buildBulkLifecycleRequest('assign', chats, 11, 22);
    assert.equal(req.assigned_user_id, 22);
    assert.equal(req.items.length, 2);
  });

  it('falls back to the current user when no target agent is given (bulk claim)', () => {
    const req = buildBulkLifecycleRequest('assign', chats, 11);
    assert.equal(req.assigned_user_id, 11);
  });

  it('fails closed when neither a target nor a signed-in user exists', () => {
    assert.throws(
      () => buildBulkLifecycleRequest('assign', chats, undefined, undefined),
      /signed-in user/,
    );
  });
});

describe('P2-8 + P2-9 HTTP integration', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gowa-lite-bulk-assign-'));
  const dbPath = path.join(tmpDir, 'int.db');

  let mockGowaServer: http.Server;
  let mockGowaPort = 0;
  let appPort = 0;
  let baseUrl = '';
  let serverProc: ReturnType<typeof spawn> | null = null;
  let serverLogs = '';

  type MockSchedule = {
    id: string;
    recipient: string;
    phone: string;
    content: string;
    message_type: string;
    status: string;
    scheduled_at: string;
    next_run_at: string;
    recurrence: string;
    timezone: string;
  };

  const mockState = {
    schedules: new Map<string, MockSchedule>(),
    calls: [] as string[],
    patchMode: 'ok' as 'ok' | '404',
    cancelFailAll: false,
    cancelFailIds: new Set<string>(),
    nextId: 1,
    lastCreatedId: '',
  };

  const mockDevices = [
    {id: 'dev-alpha', display_name: 'Alpha Desk', phone_number: '1001', state: 'logged_in', created_at: '2026-01-01T00:00:00Z'},
  ];
  const mockChats = [
    {jid: '966501111111@s.whatsapp.net', name: 'Alpha Customer One', last_message_time: '2026-11-24T01:00:00Z', ephemeral_expiration: 0, created_at: '2026-11-24T00:00:00Z', updated_at: '2026-11-24T01:00:00Z', archived: false},
    {jid: '966502222222@s.whatsapp.net', name: 'Alpha Customer Two', last_message_time: '2026-11-24T00:50:00Z', ephemeral_expiration: 0, created_at: '2026-11-24T00:00:00Z', updated_at: '2026-11-24T00:50:00Z', archived: false},
  ];

  async function api(pathName: string, options: RequestInit & {token?: string} = {}) {
    const headers = new Headers(options.headers);
    if (options.token) headers.set('Authorization', `Bearer ${options.token}`);
    if (options.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    const res = await fetch(`${baseUrl}${pathName}`, {...options, headers});
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return {status: res.status, body: json};
  }

  function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => { body += chunk; });
      req.on('end', () => {
        try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); }
      });
    });
  }

  before(async () => {
    mockGowaServer = http.createServer((req, res) => {
      void (async () => {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        res.setHeader('Content-Type', 'application/json');
        if (url.pathname === '/devices' && req.method === 'GET') {
          res.end(JSON.stringify({code: 'SUCCESS', message: 'ok', results: mockDevices}));
          return;
        }
        if (/^\/devices\/[^/]+\/status$/.test(url.pathname)) {
          const devId = decodeURIComponent(url.pathname.split('/')[2]);
          res.end(JSON.stringify({code: 'SUCCESS', message: 'ok', results: {device_id: devId, is_connected: true, is_logged_in: true}}));
          return;
        }
        if (url.pathname === '/chats' && req.method === 'GET') {
          res.end(JSON.stringify({code: 'SUCCESS', message: 'ok', results: {data: mockChats, pagination: {limit: 50, offset: 0, total: mockChats.length}}}));
          return;
        }
        if (/^\/chat\/[^/]+\/messages$/.test(url.pathname) && req.method === 'GET') {
          res.end(JSON.stringify({code: 'SUCCESS', message: 'ok', results: {data: [], pagination: {limit: 40, offset: 0, total: 0}, chat_info: {}}}));
          return;
        }
        if (url.pathname === '/send/schedules' && req.method === 'GET') {
          const search = (url.searchParams.get('search') || '').replace(/\D/g, '');
          const limit = Number(url.searchParams.get('limit') || 100);
          const offset = Number(url.searchParams.get('offset') || 0);
          const all = [...mockState.schedules.values()].filter((s) =>
            !search || s.phone.replace(/\D/g, '').includes(search) || s.recipient.replace(/\D/g, '').includes(search),
          );
          const page = all.slice(offset, offset + limit);
          res.end(JSON.stringify({code: 'SUCCESS', message: 'ok', results: {data: page, pagination: {limit, offset, total: all.length}}}));
          return;
        }
        if (url.pathname === '/send/message' && req.method === 'POST') {
          const body = await readJsonBody(req);
          mockState.calls.push('POST /send/message');
          const id = `sched-mock-${mockState.nextId}`;
          mockState.nextId += 1;
          mockState.lastCreatedId = id;
          const rec: MockSchedule = {
            id,
            recipient: String(body.phone || ''),
            phone: String(body.phone || ''),
            content: String(body.message || ''),
            message_type: 'text',
            status: 'active',
            scheduled_at: String(body.scheduled_at || ''),
            next_run_at: String(body.scheduled_at || ''),
            recurrence: String(body.recurrence || 'once'),
            timezone: String(body.timezone || ''),
          };
          mockState.schedules.set(id, rec);
          res.end(JSON.stringify({code: 'SUCCESS', message: 'ok', results: {id, schedule_id: id, status: 'active'}}));
          return;
        }
        const patchMatch = /^\/send\/schedules\/([^/]+)$/.exec(url.pathname);
        if (patchMatch && req.method === 'PATCH') {
          const id = decodeURIComponent(patchMatch[1]);
          mockState.calls.push(`PATCH ${id}`);
          if (mockState.patchMode === '404') {
            res.statusCode = 404;
            res.end(JSON.stringify({code: 'NOT_FOUND', message: 'not found'}));
            return;
          }
          const rec = mockState.schedules.get(id);
          if (!rec) {
            res.statusCode = 404;
            res.end(JSON.stringify({code: 'NOT_FOUND', message: 'not found'}));
            return;
          }
          const body = await readJsonBody(req);
          if (typeof body.scheduled_at === 'string') {
            rec.scheduled_at = body.scheduled_at;
            rec.next_run_at = body.scheduled_at;
          }
          if (typeof body.message === 'string') rec.content = body.message;
          res.end(JSON.stringify({code: 'SUCCESS', message: 'ok', results: {...rec}}));
          return;
        }
        const actionMatch = /^\/send\/schedules\/([^/]+)\/(pause|resume|cancel)$/.exec(url.pathname);
        if (actionMatch && req.method === 'POST') {
          const id = decodeURIComponent(actionMatch[1]);
          const action = actionMatch[2];
          mockState.calls.push(`POST ${action} ${id}`);
          if (action === 'cancel' && (mockState.cancelFailAll || mockState.cancelFailIds.has(id))) {
            res.statusCode = 500;
            res.end(JSON.stringify({code: 'CANCEL_FAILED', message: 'gateway cancel failed'}));
            return;
          }
          const rec = mockState.schedules.get(id);
          if (!rec) {
            res.statusCode = 404;
            res.end(JSON.stringify({code: 'NOT_FOUND', message: 'not found'}));
            return;
          }
          rec.status = action === 'pause' ? 'paused' : action === 'resume' ? 'active' : 'cancelled';
          res.end(JSON.stringify({code: 'SUCCESS', message: 'ok', results: {...rec}}));
          return;
        }
        res.end(JSON.stringify({code: 'SUCCESS', message: 'ok', results: []}));
      })().catch(() => {
        try { res.statusCode = 500; res.end(JSON.stringify({code: 'INTERNAL_ERROR', message: 'mock error'})); } catch { /* closed */ }
      });
    });

    await new Promise<void>((resolve) => {
      mockGowaServer.listen(0, '127.0.0.1', () => {
        const addr = mockGowaServer.address() as net.AddressInfo;
        mockGowaPort = addr.port;
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
    serverProc.stdout?.on('data', (chunk) => { serverLogs += chunk.toString(); });
    serverProc.stderr?.on('data', (chunk) => { serverLogs += chunk.toString(); });

    const startedAt = Date.now();
    let healthy = false;
    while (Date.now() - startedAt < 30000) {
      try {
        const res = await fetch(`${baseUrl}/api/auth/status`);
        if (res.ok) { healthy = true; break; }
      } catch { /* wait */ }
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(healthy, true, `Server failed to start:\n${serverLogs}`);
  });

  after(async () => {
    if (serverProc && serverProc.exitCode === null) {
      serverProc.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (serverProc && serverProc.exitCode === null) serverProc.kill('SIGKILL');
          resolve();
        }, 1000);
        serverProc!.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    mockGowaServer?.closeAllConnections?.();
    await new Promise<void>((resolve) => mockGowaServer.close(() => resolve()));
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  it('bulk-assigns the selection to a chosen agent and edits schedules from the page', async () => {
    const setupRes = await api('/api/auth/setup', {
      method: 'POST',
      body: JSON.stringify({
        display_name: 'Admin User',
        username: 'admin',
        password: 'Password123',
        gowa_url: `http://127.0.0.1:${mockGowaPort}`,
      }),
    });
    assert.equal(setupRes.status, 201, JSON.stringify(setupRes.body));
    const adminToken = (setupRes.body?.results as {token: string}).token;

    const rolesRes = await api('/api/roles', {token: adminToken});
    const roles = (rolesRes.body?.results as Array<{id: number; slug: string}>) || [];
    const agentRoleId = roles.find((r) => r.slug === 'agent')!.id;

    for (const [displayName, username] of [['Sara Owner', 'sara'], ['Omar Target', 'omar']] as const) {
      const created = await api('/api/users', {
        method: 'POST',
        token: adminToken,
        body: JSON.stringify({
          display_name: displayName,
          username,
          password: 'Password123',
          role_id: agentRoleId,
          allowed_device_ids: ['dev-alpha'],
        }),
      });
      assert.equal(created.status, 201, JSON.stringify(created.body));
    }

    const login = async (username: string) => {
      const res = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({username, password: 'Password123'}),
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const results = res.body?.results as {token: string; user: {id: number}};
      return {token: results.token, id: results.user.id};
    };
    const sara = await login('sara');
    const omar = await login('omar');

    // --- P2-8: bulk assign the two pending chats to Omar (not to Sara) ---
    const bulkRes = await api('/api/unified/chats/bulk-lifecycle', {
      method: 'POST',
      token: sara.token,
      body: JSON.stringify({
        action: 'assign',
        assigned_user_id: omar.id,
        items: mockChats.map((c) => ({device_id: 'dev-alpha', chat_jid: c.jid})),
      }),
    });
    assert.equal(bulkRes.status, 200, JSON.stringify(bulkRes.body));
    const succeeded = (bulkRes.body?.results as {succeeded: Array<{assigned_user_id: number}>}).succeeded;
    assert.equal(succeeded.length, 2);
    assert.ok(succeeded.every((s) => s.assigned_user_id === omar.id));
    for (const chat of mockChats) {
      const state = await api(`/api/unified/chats/dev-alpha/${encodeURIComponent(chat.jid)}/lifecycle`, {token: sara.token});
      assert.equal(state.status, 200, JSON.stringify(state.body));
      const assignment = (state.body?.results as {assignment: {assigned_user_id: number; status: string}}).assignment;
      assert.equal(assignment.assigned_user_id, omar.id);
      assert.equal(assignment.status, 'open');
    }

    // --- P2-9 setup: Sara creates a schedule (ownership: Sara) ---
    async function createScheduleAs(token: string, message: string, at: string) {
      const res = await api('/api/devices/dev-alpha/schedules', {
        method: 'POST',
        token,
        body: JSON.stringify({phone: '966511111111', message, scheduled_at: at, recurrence: 'once'}),
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      return (res.body?.results as {id: string; schedule_id: string}).schedule_id;
    }

    // --- P2-9a: time-only edit goes through the gateway PATCH, old schedule untouched ---
    mockState.patchMode = 'ok';
    mockState.calls.length = 0;
    const schedA = await createScheduleAs(sara.token, 'hello time-only', '2027-01-10T12:00:00.000Z');
    mockState.calls.length = 0;
    const patchA = await api(`/api/devices/dev-alpha/schedules/${encodeURIComponent(schedA)}`, {
      method: 'PATCH',
      token: sara.token,
      body: JSON.stringify({scheduled_at: '2027-01-11T12:00:00.000Z'}),
    });
    assert.equal(patchA.status, 200, JSON.stringify(patchA.body));
    assert.ok(mockState.calls.includes(`PATCH ${schedA}`));
    assert.equal(mockState.calls.filter((c) => c === 'POST /send/message').length, 0);
    assert.equal(mockState.schedules.get(schedA)?.scheduled_at, '2027-01-11T12:00:00.000Z');
    assert.equal(mockState.schedules.get(schedA)?.status, 'active');

    // --- P2-9b: text change forces recreate (no PATCH call) + old cancelled ---
    mockState.patchMode = '404';
    mockState.calls.length = 0;
    const schedB = await createScheduleAs(sara.token, 'old text', '2027-01-12T12:00:00.000Z');
    mockState.calls.length = 0;
    const patchB = await api(`/api/devices/dev-alpha/schedules/${encodeURIComponent(schedB)}`, {
      method: 'PATCH',
      token: sara.token,
      body: JSON.stringify({scheduled_at: '2027-01-13T12:00:00.000Z', message: 'new text'}),
    });
    assert.equal(patchB.status, 200, JSON.stringify(patchB.body));
    assert.equal(mockState.calls.filter((c) => c.startsWith('PATCH')).length, 0);
    assert.equal(mockState.calls.filter((c) => c === 'POST /send/message').length, 1);
    assert.ok(mockState.calls.includes(`POST cancel ${schedB}`));
    assert.equal(mockState.schedules.get(schedB)?.status, 'cancelled');
    const newB = [...mockState.schedules.values()].find(
      (s) => s.id !== schedB && s.content === 'new text' && s.status === 'active',
    );
    assert.ok(newB, 'recreated schedule with the new text must be the only active one');
    assert.equal(newB?.scheduled_at, '2027-01-13T12:00:00.000Z');
    // Ownership followed the recreate: the old id is no longer manageable,
    // the new one is (Sara can PATCH it again).
    const patchOld = await api(`/api/devices/dev-alpha/schedules/${encodeURIComponent(schedB)}`, {
      method: 'PATCH',
      token: sara.token,
      body: JSON.stringify({scheduled_at: '2027-01-14T12:00:00.000Z'}),
    });
    assert.equal(patchOld.status, 403, JSON.stringify(patchOld.body));
    mockState.patchMode = 'ok';
    const patchNew = await api(`/api/devices/dev-alpha/schedules/${encodeURIComponent(newB!.id)}`, {
      method: 'PATCH',
      token: sara.token,
      body: JSON.stringify({scheduled_at: '2027-01-14T12:00:00.000Z'}),
    });
    assert.equal(patchNew.status, 200, JSON.stringify(patchNew.body));

    // --- P2-9c: old-cancel failure rolls the new schedule back — never two actives ---
    mockState.patchMode = '404';
    mockState.cancelFailAll = true;
    const schedC = await createScheduleAs(sara.token, 'rollback me', '2027-01-15T12:00:00.000Z');
    mockState.calls.length = 0;
    const patchC = await api(`/api/devices/dev-alpha/schedules/${encodeURIComponent(schedC)}`, {
      method: 'PATCH',
      token: sara.token,
      body: JSON.stringify({scheduled_at: '2027-01-16T12:00:00.000Z', message: 'rollback me v2'}),
    });
    // The old cancel fails AND the rollback cancel of the new schedule fails:
    // the server must NOT claim a rollback — it must report ROLLBACK_FAILED.
    assert.equal(patchC.status, 502, JSON.stringify(patchC.body));
    assert.equal(patchC.body?.code, 'RESCHEDULE_ROLLBACK_FAILED');
    const newCId = (patchC.body?.results as {new_schedule_id?: string} | undefined)?.new_schedule_id;
    assert.ok(typeof newCId === 'string' && newCId.length > 0);
    assert.equal(newCId, mockState.lastCreatedId);
    assert.ok(String(patchC.body?.message || '').length > 0);
    mockState.cancelFailAll = false;

    // Same failure, but only the OLD cancel fails and the rollback cancel
    // of the new schedule succeeds: exactly one active schedule (the old
    // one) remains, and the error code says the edit was rolled back.
    mockState.patchMode = '404';
    const schedD = await createScheduleAs(sara.token, 'rollback ok', '2027-01-17T12:00:00.000Z');
    mockState.cancelFailIds.add(schedD);
    mockState.calls.length = 0;
    const patchD = await api(`/api/devices/dev-alpha/schedules/${encodeURIComponent(schedD)}`, {
      method: 'PATCH',
      token: sara.token,
      body: JSON.stringify({scheduled_at: '2027-01-18T12:00:00.000Z', message: 'rollback ok v2'}),
    });
    assert.equal(patchD.status, 502, JSON.stringify(patchD.body));
    assert.equal(patchD.body?.code, 'RESCHEDULE_CANCEL_FAILED');
    const newD = [...mockState.schedules.values()].find((s) => s.content === 'rollback ok v2');
    assert.ok(newD, 'the recreated schedule must exist (rolled back, not deleted)');
    assert.equal(newD?.status, 'cancelled');
    assert.equal(mockState.schedules.get(schedD)?.status, 'active');
    const actives = [...mockState.schedules.values()].filter(
      (s) => s.status === 'active' && (s.id === schedD || s.id === newD?.id),
    );
    assert.equal(actives.length, 1, 'exactly one of old/new may stay active');
    mockState.cancelFailIds.clear();
    mockState.patchMode = 'ok';

    // --- P2-9d: an agent editing another agent's schedule gets 403 ---
    const schedAdmin = await createScheduleAs(adminToken, 'admin only', '2027-01-20T12:00:00.000Z');
    const patchOther = await api(`/api/devices/dev-alpha/schedules/${encodeURIComponent(schedAdmin)}`, {
      method: 'PATCH',
      token: sara.token,
      body: JSON.stringify({scheduled_at: '2027-01-21T12:00:00.000Z'}),
    });
    assert.equal(patchOther.status, 403, JSON.stringify(patchOther.body));

    // --- P2-9e: time-only edit of a non-text schedule works through PATCH ---
    mockState.patchMode = 'ok';
    const mediaId = 'sched-mock-media-1';
    mockState.schedules.set(mediaId, {
      id: mediaId,
      recipient: '966511111111@s.whatsapp.net',
      phone: '966511111111',
      content: '',
      message_type: 'image',
      status: 'active',
      scheduled_at: '2027-01-22T12:00:00.000Z',
      next_run_at: '2027-01-22T12:00:00.000Z',
      recurrence: 'once',
      timezone: 'Asia/Riyadh',
    });
    const patchMedia = await api(`/api/devices/dev-alpha/schedules/${encodeURIComponent(mediaId)}`, {
      method: 'PATCH',
      token: adminToken,
      body: JSON.stringify({scheduled_at: '2027-01-23T12:00:00.000Z'}),
    });
    assert.equal(patchMedia.status, 200, JSON.stringify(patchMedia.body));
    assert.equal(mockState.schedules.get(mediaId)?.scheduled_at, '2027-01-23T12:00:00.000Z');
  });
});
