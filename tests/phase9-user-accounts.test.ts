import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, it} from 'node:test';
import {WebSocket} from 'ws';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gowa-lite-phase9-'));
const tempDbPath = path.join(tempDir, 'phase9.db');
process.env.GOWA_LITE_DB_PATH = tempDbPath;

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

describe('Phase 9 User Account Access Helpers & DB Catalog (TDD)', () => {
  let dbMod: typeof import('../server/db.ts');
  let accessHelpers: typeof import('../src/features/users/device-access-helpers.ts');

  before(async () => {
    dbMod = await import('../server/db.ts');
    accessHelpers = await import('../src/features/users/device-access-helpers.ts');
  });

  after(() => {
    dbMod?.closeDatabaseSafely();
    fs.rmSync(tempDir, {recursive: true, force: true});
  });

  it('prevents silent fallback to All Accounts when mode is specific with zero selected accounts', () => {
    const invalidSpecific = accessHelpers.validateDeviceAccessSelection('specific', []);
    assert.equal(invalidSpecific.ok, false);

    const validSpecific = accessHelpers.validateDeviceAccessSelection('specific', [
      ' dev-1 ',
      'dev-1',
      'dev-2',
    ]);
    assert.deepEqual(validSpecific, {ok: true, deviceIds: ['dev-1', 'dev-2']});

    const validAll = accessHelpers.validateDeviceAccessSelection('all', ['dev-1']);
    assert.deepEqual(validAll, {ok: true, deviceIds: []});

    assert.deepEqual(accessHelpers.mergeManualDeviceId(['dev-1'], ' dev-2 '), ['dev-1', 'dev-2']);
    assert.deepEqual(accessHelpers.mergeManualDeviceId(['dev-1'], 'dev-1'), ['dev-1']);
    assert.deepEqual(accessHelpers.mergeManualDeviceId(['dev-1'], '   '), ['dev-1']);
  });

  it('summarizes assigned account names cleanly without dropping overflow count', () => {
    const map = new Map([
      ['dev-1', 'مبيعات الرياض'],
      ['dev-2', 'الدعم الفني'],
      ['dev-3', 'خدمة VIP'],
    ]);
    assert.equal(
      accessHelpers.summarizeAssignedAccounts(['dev-1', 'dev-2'], map, 'كل الحسابات'),
      'مبيعات الرياض · الدعم الفني',
    );
    assert.equal(
      accessHelpers.summarizeAssignedAccounts(['dev-1', 'dev-2', 'dev-3'], map, 'كل الحسابات'),
      'مبيعات الرياض · الدعم الفني (+1)',
    );
    assert.equal(
      accessHelpers.summarizeAssignedAccounts([], map, 'كل الحسابات'),
      'كل الحسابات',
    );
  });

  it('collects listKnownDeviceIds from persisted aliases and user assignments', () => {
    dbMod.setAccountAlias('cached-sales', 'Sales Line');
    dbMod.createUser({
      username: 'catalog_agent',
      display_name: 'Catalog Agent',
      role: 'agent',
      password: 'Password123',
      allowed_device_ids: ['assigned-support', 'cached-sales'],
    });
    const known = dbMod.listKnownDeviceIds();
    assert.ok(known.includes('cached-sales'));
    assert.ok(known.includes('assigned-support'));
  });
});

describe('Phase 9 Assignable Accounts Resilience, Live WS Sync & Message Scoping (TDD)', () => {
  const srvDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gowa-lite-phase9-srv-'));
  const srvDbPath = path.join(srvDir, 'srv.db');
  let appPort = 0;
  let mockGowaPort = 0;
  let gowaOnline = true;
  let mockGowaServer: http.Server;
  let childProc: ReturnType<typeof spawn>;

  before(async () => {
    appPort = await getFreePort();
    mockGowaPort = await getFreePort();

    mockGowaServer = http.createServer((req, res) => {
      if (!gowaOnline) {
        req.socket.destroy();
        return;
      }
      const reqUrl = new URL(req.url || '/', `http://127.0.0.1:${mockGowaPort}`);
      const deviceHeader = req.headers['x-device-id'];
      res.setHeader('Content-Type', 'application/json');

      if (reqUrl.pathname === '/devices') {
        res.end(
          JSON.stringify({
            code: 'SUCCESS',
            message: 'ok',
            results: [
              {id: 'dev-1', display_name: 'Line 1', phone_number: '966500000001', state: 'logged_in', created_at: ''},
              {id: 'dev-2', display_name: 'Line 2', phone_number: '966500000002', state: 'logged_in', created_at: ''},
            ],
          }),
        );
        return;
      }

      if (reqUrl.pathname === '/chats') {
        const chats =
          deviceHeader === 'dev-1'
            ? [{jid: '111@s.whatsapp.net', name: 'Customer 1', last_message_time: '2026-11-24T01:00:00Z', ephemeral_expiration: 0, created_at: '', updated_at: '', archived: false}]
            : [{jid: '222@s.whatsapp.net', name: 'Customer 2', last_message_time: '2026-11-24T01:00:00Z', ephemeral_expiration: 0, created_at: '', updated_at: '', archived: false}];
        res.end(JSON.stringify({code: 'SUCCESS', message: 'ok', results: {data: chats, pagination: {limit: 100, offset: 0, total: 1}}}));
        return;
      }

      if (/^\/chat\/[^/]+\/messages$/.test(reqUrl.pathname)) {
        res.end(
          JSON.stringify({
            code: 'SUCCESS',
            message: 'ok',
            results: {
              data: [
                {
                  id: `msg-${String(deviceHeader)}`,
                  chat_jid: decodeURIComponent(reqUrl.pathname.split('/')[2]),
                  sender_jid: '966500000099@s.whatsapp.net',
                  content: `Secret from ${String(deviceHeader)}`,
                  timestamp: '2026-11-24T01:00:00Z',
                  is_from_me: false,
                  media_type: '',
                  filename: '',
                  url: '',
                  file_length: 0,
                },
              ],
              pagination: {limit: 50, offset: 0, total: 1},
            },
          }),
        );
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({code: 'NOT_FOUND', message: 'not found'}));
    });
    await new Promise<void>((resolve) => mockGowaServer.listen(mockGowaPort, '127.0.0.1', resolve));

    childProc = spawn('node', ['server.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'production',
        PORT: String(appPort),
        GOWA_LITE_DB_PATH: srvDbPath,
        GOWA_URL: `http://127.0.0.1:${mockGowaPort}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://127.0.0.1:${appPort}/api/auth/status`);
        if (r.ok) break;
      } catch {
        // wait
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  });

  after(async () => {
    if (childProc && !childProc.killed) {
      childProc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 300));
    }
    await new Promise<void>((resolve) => mockGowaServer.close(() => resolve()));
    fs.rmSync(srvDir, {recursive: true, force: true});
  });

  it('serves offline fallback assignable accounts, scopes messages by device, and pushes USER_ACCESS_UPDATED live', async () => {
    const base = `http://127.0.0.1:${appPort}`;

    const setupRes = await fetch(`${base}/api/auth/setup`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        display_name: 'Admin 9',
        username: 'admin9',
        password: 'Password123',
        gowa_url: `http://127.0.0.1:${mockGowaPort}`,
      }),
    });
    assert.equal(setupRes.status, 201);
    const adminToken = ((await setupRes.json()) as {results: {token: string}}).results.token;

    // Create agent restricted to dev-1 only
    const createAgentRes = await fetch(`${base}/api/users`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}`},
      body: JSON.stringify({
        display_name: 'Agent 9',
        username: 'agent9',
        password: 'Password123',
        role: 'agent',
        allowed_device_ids: ['dev-1'],
      }),
    });
    assert.equal(createAgentRes.status, 201);
    const agentUser = ((await createAgentRes.json()) as {results: {id: number}}).results;

    // Catalog returns live devices while GOWA is online
    const onlineCatRes = await fetch(`${base}/api/users/assignable-accounts`, {
      headers: {Authorization: `Bearer ${adminToken}`},
    });
    assert.equal(onlineCatRes.status, 200);
    const onlineCat = (await onlineCatRes.json()) as {
      results: {gowa_reachable: boolean; accounts: Array<{id: string}>};
    };
    assert.equal(onlineCat.results.gowa_reachable, true);
    assert.deepEqual(
      onlineCat.results.accounts.map((a) => a.id).sort(),
      ['dev-1', 'dev-2'],
    );

    // Log in agent and verify message scoping (dev-1 allowed, dev-2 forbidden)
    const loginRes = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({username: 'agent9', password: 'Password123'}),
    });
    assert.equal(loginRes.status, 200);
    const agentToken = ((await loginRes.json()) as {results: {token: string}}).results.token;

    const okMsgs = await fetch(
      `${base}/api/unified/chats/dev-1/${encodeURIComponent('111@s.whatsapp.net')}/messages`,
      {headers: {Authorization: `Bearer ${agentToken}`}},
    );
    assert.equal(okMsgs.status, 200);

    const blockedMsgs = await fetch(
      `${base}/api/unified/chats/dev-2/${encodeURIComponent('222@s.whatsapp.net')}/messages`,
      {headers: {Authorization: `Bearer ${agentToken}`}},
    );
    assert.equal(blockedMsgs.status, 403);

    // Connect agent WebSocket and update user's allowed_device_ids -> ['dev-2']
    const ticketRes = await fetch(`${base}/api/auth/ws-ticket`, {
      method: 'POST',
      headers: {Authorization: `Bearer ${agentToken}`},
    });
    assert.equal(ticketRes.status, 200);
    const ticket = ((await ticketRes.json()) as {results: {ticket: string}}).results.ticket;

    const ws = new WebSocket(`ws://127.0.0.1:${appPort}/ws?ticket=${ticket}`);
    await new Promise<void>((resolve) => ws.once('open', resolve));

    const accessEventPromise = new Promise<{code: string; result: {user?: {allowed_device_ids?: string[]}}}>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for USER_ACCESS_UPDATED')), 5_000);
      ws.on('message', (raw) => {
        const parsed = JSON.parse(raw.toString()) as {code?: string; result?: {user?: {allowed_device_ids?: string[]}}};
        if (parsed.code === 'USER_ACCESS_UPDATED') {
          clearTimeout(timer);
          resolve(parsed as {code: string; result: {user?: {allowed_device_ids?: string[]}}});
        }
      });
    });

    const patchRes = await fetch(`${base}/api/users/${agentUser.id}`, {
      method: 'PATCH',
      headers: {'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}`},
      body: JSON.stringify({allowed_device_ids: ['dev-2']}),
    });
    assert.equal(patchRes.status, 200);

    const wsEvent = await accessEventPromise;
    assert.deepEqual(wsEvent.result.user?.allowed_device_ids, ['dev-2']);
    ws.close();

    // Immediately verify dev-1 is now 403 and dev-2 is now 200
    const nowBlocked = await fetch(
      `${base}/api/unified/chats/dev-1/${encodeURIComponent('111@s.whatsapp.net')}/messages`,
      {headers: {Authorization: `Bearer ${agentToken}`}},
    );
    assert.equal(nowBlocked.status, 403);

    const nowAllowed = await fetch(
      `${base}/api/unified/chats/dev-2/${encodeURIComponent('222@s.whatsapp.net')}/messages`,
      {headers: {Authorization: `Bearer ${agentToken}`}},
    );
    assert.equal(nowAllowed.status, 200);

    // When GOWA goes offline, assignable-accounts still returns 200 with cached device IDs
    gowaOnline = false;
    const offlineCatRes = await fetch(`${base}/api/users/assignable-accounts`, {
      headers: {Authorization: `Bearer ${adminToken}`},
    });
    assert.equal(offlineCatRes.status, 200);
    const offlineCat = (await offlineCatRes.json()) as {
      results: {gowa_reachable: boolean; accounts: Array<{id: string}>};
    };
    assert.equal(offlineCat.results.gowa_reachable, false);
    assert.ok(offlineCat.results.accounts.some((a) => a.id === 'dev-2'));
  });
});
