import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, it} from 'node:test';
import {WebSocket} from 'ws';

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

function createJsonCollector(ws: WebSocket): {
  waitFor: (predicate: (msg: Record<string, unknown>) => boolean, timeoutMs?: number) => Promise<Record<string, unknown>>;
  messages: Array<Record<string, unknown>>;
} {
  const messages: Array<Record<string, unknown>> = [];
  const waiters: Array<{
    predicate: (msg: Record<string, unknown>) => boolean;
    resolve: (msg: Record<string, unknown>) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  ws.on('message', (raw) => {
    try {
      const parsed = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
      messages.push(parsed);
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        const w = waiters[i];
        if (w.predicate(parsed)) {
          clearTimeout(w.timer);
          waiters.splice(i, 1);
          w.resolve(parsed);
        }
      }
    } catch {
      // ignore non-json frames
    }
  });

  return {
    messages,
    waitFor(predicate, timeoutMs = 4000) {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.findIndex((w) => w.resolve === resolve);
          if (idx !== -1) waiters.splice(idx, 1);
          reject(new Error(`Timed out waiting for WS event after ${timeoutMs}ms`));
        }, timeoutMs);
        waiters.push({predicate, resolve, reject, timer});
      });
    },
  };
}

describe('Phase 5 Chat Lifecycle Unit & State Machine Verification', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gowa-lite-lifecycle-unit-'));
  const unitDbPath = path.join(tmpDir, 'unit.db');

  let dbMod: typeof import('../server/db.ts');
  let lifecycleMod: typeof import('../server/services/chat-lifecycle.ts');
  let syncMod: typeof import('../server/services/chat-sync.ts');
  let wsMod: typeof import('../server/ws-bridge.ts');

  before(async () => {
    process.env.GOWA_LITE_DB_PATH = unitDbPath;
    dbMod = await import('../server/db.ts');
    lifecycleMod = await import('../server/services/chat-lifecycle.ts');
    syncMod = await import('../server/services/chat-sync.ts');
    wsMod = await import('../server/ws-bridge.ts');
  });

  after(() => {
    dbMod?.closeDatabaseSafely();
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  it('enforces atomic claimChat race (409 ALREADY_CLAIMED), supervisor guards, user deletion reset, and customer auto-reopen', () => {
    const roles = dbMod.listRoles();
    const agentRole = roles.find((r) => r.slug === 'agent')!;
    const managerRole = roles.find((r) => r.slug === 'manager')!;

    const agentA = dbMod.createUser({
      username: 'agent_a',
      display_name: 'Agent Alpha',
      role: 'agent',
      role_id: agentRole.id,
      allowed_device_ids: ['dev-1'],
      password: 'Password123',
    });
    const agentB = dbMod.createUser({
      username: 'agent_b',
      display_name: 'Agent Beta',
      role: 'agent',
      role_id: agentRole.id,
      allowed_device_ids: ['dev-1', 'dev-2'],
      password: 'Password123',
    });
    const supervisor = dbMod.createUser({
      username: 'sup_one',
      display_name: 'Supervisor One',
      role: 'agent',
      role_id: managerRole.id,
      allowed_device_ids: [],
      password: 'Password123',
    });

    const jid = '966500001111@s.whatsapp.net';

    // 1. Agent A claims pending chat
    const claimed = lifecycleMod.claimChat(agentA, 'dev-1', jid, {cachedTitle: 'VIP Lead'});
    assert.equal(claimed.assignment.status, 'open');
    assert.equal(claimed.assignment.assigned_user_id, agentA.id);
    assert.equal(claimed.assignment.assigned_user_name, 'Agent Alpha');
    assert.equal(claimed.event.event_type, 'claimed');

    // 2. Agent B attempts to claim same chat -> 409 ALREADY_CLAIMED with owner details
    assert.throws(
      () => lifecycleMod.claimChat(agentB, 'dev-1', jid),
      (err: unknown) => {
        const gErr = err as {status?: number; code?: string; details?: {assignment?: {assigned_user_name?: string}}};
        return (
          gErr.status === 409 &&
          gErr.code === 'ALREADY_CLAIMED' &&
          gErr.details?.assignment?.assigned_user_name === 'Agent Alpha'
        );
      },
    );

    // 3. Agent B (non-supervisor) cannot release or reassign Agent A's open chat
    assert.throws(
      () => lifecycleMod.releaseChat(agentB, 'dev-1', jid),
      (err: unknown) => (err as {status?: number; code?: string}).status === 403,
    );
    assert.throws(
      () => lifecycleMod.assignChat(agentB, 'dev-1', jid, agentB.id),
      (err: unknown) => (err as {status?: number; code?: string}).status === 403,
    );

    // 4. Supervisor CAN transfer open chat to Agent B
    const transferred = lifecycleMod.assignChat(supervisor, 'dev-1', jid, agentB.id, {
      note: 'Escalated to tier 2',
    });
    assert.equal(transferred.assignment.status, 'open');
    assert.equal(transferred.assignment.assigned_user_id, agentB.id);
    assert.equal(transferred.event?.event_type, 'transferred');
    assert.equal(transferred.event?.note, 'Escalated to tier 2');

    // 5. Assign to device-restricted user on unauthorized device fails 403 TARGET_DEVICE_FORBIDDEN
    assert.throws(
      () => lifecycleMod.assignChat(supervisor, 'dev-2', '966500002222@s.whatsapp.net', agentA.id),
      (err: unknown) => (err as {status?: number; code?: string}).code === 'TARGET_DEVICE_FORBIDDEN',
    );

    // 6. Close chat clears assigned_user_id and blocks claim until reopen
    const closed = lifecycleMod.closeChat(agentB, 'dev-1', jid, {reason: 'Resolved'});
    assert.equal(closed.assignment.status, 'closed');
    assert.equal(closed.assignment.assigned_user_id, null);
    assert.equal(closed.assignment.closed_by_id, agentB.id);
    assert.equal(closed.assignment.close_reason, 'Resolved');

    assert.throws(
      () => lifecycleMod.claimChat(agentA, 'dev-1', jid),
      (err: unknown) => (err as {status?: number; code?: string}).code === 'CHAT_CLOSED',
    );

    // 7. Outgoing message (is_from_me: true) in closed chat does NOT auto-reopen
    const outgoingRes = syncMod.handleUpstreamGowaEvent('dev-1', {
      code: 'MESSAGE_RECEIVED',
      message: 'ok',
      result: {
        id: 'm-out-1',
        chat_jid: jid,
        sender_jid: 'me@s.whatsapp.net',
        content: 'Internal follow-up',
        timestamp: new Date().toISOString(),
        is_from_me: true,
      },
    });
    assert.equal(outgoingRes, null);
    assert.equal(lifecycleMod.getChatLifecycleState('dev-1', jid).status, 'closed');

    // 8. Incoming customer message (is_from_me: false) auto-reopens closed chat to pending
    const reopenPayload = syncMod.handleUpstreamGowaEvent('dev-1', {
      code: 'MESSAGE_RECEIVED',
      message: 'ok',
      result: {
        id: 'm-in-2',
        chat_jid: jid,
        sender_jid: jid,
        content: 'Actually I need one more thing',
        timestamp: new Date().toISOString(),
        is_from_me: false,
      },
    });
    assert.ok(reopenPayload);
    assert.equal(reopenPayload?.code, 'CHAT_LIFECYCLE_UPDATED');
    assert.equal(reopenPayload?.result.assignment.status, 'pending');
    assert.equal(reopenPayload?.result.event?.event_type, 'reopened_by_customer');

    // 9. Deleting a user resets their open chats back to pending
    lifecycleMod.claimChat(agentA, 'dev-1', jid);
    assert.equal(lifecycleMod.getChatLifecycleState('dev-1', jid).status, 'open');
    dbMod.deleteUser(agentA.id);
    const afterDelete = lifecycleMod.getChatLifecycleState('dev-1', jid);
    assert.equal(afterDelete.status, 'pending');
    assert.equal(afterDelete.assigned_user_id, null);

    // 10. Verify WS delivery rules for CHAT_LIFECYCLE_UPDATED and INBOX_POLICY_UPDATED
    assert.equal(
      wsMod.shouldDeliverWsEventToUser(agentB, {
        code: 'CHAT_LIFECYCLE_UPDATED',
        device_id: 'dev-1',
        result: {device_id: 'dev-1', chat_jid: jid},
      }).allowed,
      true,
    );
    assert.equal(
      wsMod.shouldDeliverWsEventToUser(
        {...agentA, is_active: true},
        {
          code: 'CHAT_LIFECYCLE_UPDATED',
          device_id: 'dev-2',
          result: {device_id: 'dev-2', chat_jid: jid},
        },
      ).allowed,
      false,
    );
    assert.equal(
      wsMod.shouldDeliverWsEventToUser(agentB, {
        code: 'INBOX_POLICY_UPDATED',
        result: {unassigned_reply_policy: 'require_claim', closed_reply_policy: 'block'},
      }).allowed,
      true,
    );
  });
});

describe('Phase 5 Lifecycle HTTP, Policy & WebSocket Integration', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gowa-lite-lifecycle-int-'));
  const dbPath = path.join(tmpDir, 'int.db');

  let mockGowaServer: http.Server;
  let mockGowaPort = 0;
  let appPort = 0;
  let baseUrl = '';
  let wsBaseUrl = '';
  let serverProc: ReturnType<typeof spawn> | null = null;
  let serverLogs = '';
  let sentMessagesCount = 0;

  const mockDevices = [
    {
      id: 'dev-alpha',
      display_name: 'Alpha Desk',
      phone_number: '1001',
      state: 'logged_in',
      created_at: '2026-01-01T00:00:00Z',
    },
    {
      id: 'dev-beta',
      display_name: 'Beta Desk',
      phone_number: '1002',
      state: 'logged_in',
      created_at: '2026-01-01T00:00:00Z',
    },
  ];

  const mockChatsByDevice: Record<string, Array<Record<string, unknown>>> = {
    'dev-alpha': [
      {
        jid: '966501111111@s.whatsapp.net',
        name: 'Alpha Customer One',
        last_message_time: '2026-11-24T01:00:00Z',
        ephemeral_expiration: 0,
        created_at: '2026-11-24T00:00:00Z',
        updated_at: '2026-11-24T01:00:00Z',
        archived: false,
      },
      {
        jid: '966502222222@s.whatsapp.net',
        name: 'Alpha Customer Two',
        last_message_time: '2026-11-24T00:50:00Z',
        ephemeral_expiration: 0,
        created_at: '2026-11-24T00:00:00Z',
        updated_at: '2026-11-24T00:50:00Z',
        archived: false,
      },
    ],
    'dev-beta': [
      {
        jid: '966503333333@s.whatsapp.net',
        name: 'Beta Customer One',
        last_message_time: '2026-11-24T00:40:00Z',
        ephemeral_expiration: 0,
        created_at: '2026-11-24T00:00:00Z',
        updated_at: '2026-11-24T00:40:00Z',
        archived: false,
      },
    ],
  };

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

  before(async () => {
    mockGowaServer = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const deviceHeader = String(req.headers['x-device-id'] || 'dev-alpha');
      res.setHeader('Content-Type', 'application/json');

      if (url.pathname === '/devices' && req.method === 'GET') {
        res.end(JSON.stringify({code: 'SUCCESS', message: 'ok', results: mockDevices}));
        return;
      }
      if (/^\/devices\/[^/]+\/status$/.test(url.pathname)) {
        const devId = decodeURIComponent(url.pathname.split('/')[2]);
        res.end(
          JSON.stringify({
            code: 'SUCCESS',
            message: 'ok',
            results: {device_id: devId, is_connected: true, is_logged_in: true},
          }),
        );
        return;
      }
      if (url.pathname === '/chats' && req.method === 'GET') {
        const list = mockChatsByDevice[deviceHeader] ?? [];
        res.end(
          JSON.stringify({
            code: 'SUCCESS',
            message: 'ok',
            results: {data: list, pagination: {limit: 50, offset: 0, total: list.length}},
          }),
        );
        return;
      }
      if (/^\/chat\/[^/]+\/messages$/.test(url.pathname) && req.method === 'GET') {
        res.end(
          JSON.stringify({
            code: 'SUCCESS',
            message: 'ok',
            results: {data: [], pagination: {limit: 40, offset: 0, total: 0}, chat_info: {}},
          }),
        );
        return;
      }
      if (url.pathname === '/send/message' && req.method === 'POST') {
        sentMessagesCount += 1;
        res.end(
          JSON.stringify({
            code: 'SUCCESS',
            message: 'ok',
            results: {message_id: `sent-${sentMessagesCount}`, status: 'sent'},
          }),
        );
        return;
      }
      res.end(JSON.stringify({code: 'SUCCESS', message: 'ok', results: []}));
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
    wsBaseUrl = `ws://127.0.0.1:${appPort}/ws`;

    serverProc = spawn('node', ['--import', 'tsx', 'server.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: String(appPort),
        GOWA_LITE_DB_PATH: dbPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    serverProc.stdout?.on('data', (chunk) => {
      serverLogs += chunk.toString();
    });
    serverProc.stderr?.on('data', (chunk) => {
      serverLogs += chunk.toString();
    });

    const startedAt = Date.now();
    let healthy = false;
    while (Date.now() - startedAt < 15000) {
      try {
        const res = await fetch(`${baseUrl}/api/auth/status`);
        if (res.ok) {
          healthy = true;
          break;
        }
      } catch {
        // wait
      }
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

  it('exercises concurrent claims, assignable-agents load counts, policy enforcement, bulk-lifecycle, and WS broadcasts', async () => {
    // 1. Setup Admin + configure mock GOWA
    const setupRes = await api('/api/auth/setup', {
      method: 'POST',
      body: JSON.stringify({
        display_name: 'Admin User',
        username: 'admin',
        password: 'Password123',
        gowa_url: `http://127.0.0.1:${mockGowaPort}`,
      }),
    });
    assert.equal(setupRes.status, 201);
    const adminToken = (setupRes.body?.results as {token: string}).token;

    // Fetch role IDs
    const rolesRes = await api('/api/roles', {token: adminToken});
    const roles = (rolesRes.body?.results as Array<{id: number; slug: string}>) || [];
    const agentRoleId = roles.find((r) => r.slug === 'agent')!.id;
    const managerRoleId = roles.find((r) => r.slug === 'manager')!.id;

    // Create Agent 1 (dev-alpha only), Agent 2 (all devices), Manager (all devices)
    await api('/api/users', {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({
        display_name: 'Sara Alpha',
        username: 'sara',
        password: 'Password123',
        role_id: agentRoleId,
        allowed_device_ids: ['dev-alpha'],
      }),
    });
    await api('/api/users', {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({
        display_name: 'Omar All',
        username: 'omar',
        password: 'Password123',
        role_id: agentRoleId,
        allowed_device_ids: [],
      }),
    });
    await api('/api/users', {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({
        display_name: 'Lina Supervisor',
        username: 'lina',
        password: 'Password123',
        role_id: managerRoleId,
        allowed_device_ids: [],
      }),
    });

    const saraLogin = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({username: 'sara', password: 'Password123'}),
    });
    const omarLogin = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({username: 'omar', password: 'Password123'}),
    });
    const linaLogin = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({username: 'lina', password: 'Password123'}),
    });
    const saraToken = (saraLogin.body?.results as {token: string}).token;
    const omarToken = (omarLogin.body?.results as {token: string}).token;
    const omarId = (omarLogin.body?.results as {user: {id: number}}).user.id;
    const saraId = (saraLogin.body?.results as {user: {id: number}}).user.id;
    const linaToken = (linaLogin.body?.results as {token: string}).token;

    // 2. Connect WS for Sara (dev-alpha only) and Omar (all devices) using ws-ticket
    const saraTicketRes = await api('/api/auth/ws-ticket', {method: 'POST', token: saraToken});
    const omarTicketRes = await api('/api/auth/ws-ticket', {method: 'POST', token: omarToken});
    assert.equal(saraTicketRes.status, 200);
    assert.equal(omarTicketRes.status, 200);
    const saraTicket = (saraTicketRes.body?.results as {ticket: string}).ticket;
    const omarTicket = (omarTicketRes.body?.results as {ticket: string}).ticket;

    const wsSara = new WebSocket(`${wsBaseUrl}?ticket=${encodeURIComponent(saraTicket)}`);
    const wsOmar = new WebSocket(`${wsBaseUrl}?ticket=${encodeURIComponent(omarTicket)}`);
    await Promise.all([
      new Promise<void>((res, rej) => {
        wsSara.once('open', () => res());
        wsSara.once('error', rej);
      }),
      new Promise<void>((res, rej) => {
        wsOmar.once('open', () => res());
        wsOmar.once('error', rej);
      }),
    ]);
    const saraCollector = createJsonCollector(wsSara);
    const omarCollector = createJsonCollector(wsOmar);

    try {
      // 3. Assignable agents endpoint respects device access
      const betaAgentsRes = await api('/api/unified/assignable-agents?deviceId=dev-beta', {
        token: omarToken,
      });
      assert.equal(betaAgentsRes.status, 200);
      const betaAgents = betaAgentsRes.body?.results as Array<{id: number; username: string; open_chat_count: number}>;
      assert.equal(betaAgents.some((a) => a.username === 'sara'), false);
      assert.equal(betaAgents.some((a) => a.username === 'omar'), true);

      // 4. Concurrent Claim race on chat1 via Promise.all
      const chat1Jid = '966501111111@s.whatsapp.net';
      const [claim1, claim2] = await Promise.all([
        api(`/api/unified/chats/dev-alpha/${encodeURIComponent(chat1Jid)}/claim`, {
          method: 'POST',
          token: saraToken,
        }),
        api(`/api/unified/chats/dev-alpha/${encodeURIComponent(chat1Jid)}/claim`, {
          method: 'POST',
          token: omarToken,
        }),
      ]);
      const statuses = [claim1.status, claim2.status].sort((a, b) => a - b);
      assert.deepEqual(statuses, [200, 409]);

      const loser = claim1.status === 409 ? claim1 : claim2;
      const winnerToken = claim1.status === 200 ? saraToken : omarToken;
      const loserToken = claim1.status === 200 ? omarToken : saraToken;
      const winnerId = claim1.status === 200 ? saraId : omarId;
      const winnerName = claim1.status === 200 ? 'Sara Alpha' : 'Omar All';

      assert.equal(loser.body?.code, 'ALREADY_CLAIMED');
      const loserAssignment = (loser.body?.results as {assignment: {assigned_user_name: string}})?.assignment;
      assert.equal(loserAssignment.assigned_user_name, winnerName);

      // Both WS clients receive CHAT_LIFECYCLE_UPDATED for dev-alpha
      const wsEvent = await omarCollector.waitFor(
        (m) =>
          m.code === 'CHAT_LIFECYCLE_UPDATED' &&
          (m.result as {chat_jid?: string})?.chat_jid === chat1Jid,
      );
      assert.equal((wsEvent.result as {assignment: {assigned_user_id: number}}).assignment.assigned_user_id, winnerId);

      // 5. Assignable agents open_chat_count reflects live open chat
      const alphaAgentsRes = await api('/api/unified/assignable-agents?deviceId=dev-alpha', {
        token: adminToken,
      });
      const alphaAgents = alphaAgentsRes.body?.results as Array<{id: number; open_chat_count: number}>;
      assert.equal(alphaAgents.find((a) => a.id === winnerId)?.open_chat_count, 1);

      // 6. Loser agent cannot send to another agent's open chat -> 403 CHAT_ASSIGNED_TO_OTHER
      const blockedSend = await api(
        `/api/unified/chats/dev-alpha/${encodeURIComponent(chat1Jid)}/send`,
        {
          method: 'POST',
          token: loserToken,
          body: JSON.stringify({message: 'Should fail'}),
        },
      );
      assert.equal(blockedSend.status, 403);
      assert.equal(blockedSend.body?.code, 'CHAT_ASSIGNED_TO_OTHER');

      // Winner CAN send
      const okSend = await api(
        `/api/unified/chats/dev-alpha/${encodeURIComponent(chat1Jid)}/send`,
        {
          method: 'POST',
          token: winnerToken,
          body: JSON.stringify({message: 'Hello from owner'}),
        },
      );
      assert.equal(okSend.status, 200);

      // 7. Only settings:write (Admin) can update inbox policy -> broadcasts INBOX_POLICY_UPDATED
      const agentPolicyTry = await api('/api/settings/inbox-policy', {
        method: 'PUT',
        token: saraToken,
        body: JSON.stringify({unassigned_reply_policy: 'require_claim'}),
      });
      assert.equal(agentPolicyTry.status, 403);

      const adminPolicyPut = await api('/api/settings/inbox-policy', {
        method: 'PUT',
        token: adminToken,
        body: JSON.stringify({
          unassigned_reply_policy: 'require_claim',
          closed_reply_policy: 'block',
        }),
      });
      assert.equal(adminPolicyPut.status, 200);
      await saraCollector.waitFor((m) => m.code === 'INBOX_POLICY_UPDATED');

      // 8. require_claim blocks replying to pending chat2
      const chat2Jid = '966502222222@s.whatsapp.net';
      const requireClaimErr = await api(
        `/api/unified/chats/dev-alpha/${encodeURIComponent(chat2Jid)}/send`,
        {
          method: 'POST',
          token: saraToken,
          body: JSON.stringify({message: 'Blocked before claim'}),
        },
      );
      assert.equal(requireClaimErr.status, 409);
      assert.equal(requireClaimErr.body?.code, 'CLAIM_REQUIRED');

      // Switch to auto_claim -> sending to pending chat2 succeeds and assigns to Sara
      await api('/api/settings/inbox-policy', {
        method: 'PUT',
        token: adminToken,
        body: JSON.stringify({
          unassigned_reply_policy: 'auto_claim',
          closed_reply_policy: 'block',
        }),
      });
      const autoClaimSend = await api(
        `/api/unified/chats/dev-alpha/${encodeURIComponent(chat2Jid)}/send`,
        {
          method: 'POST',
          token: saraToken,
          body: JSON.stringify({message: 'Auto claim reply'}),
        },
      );
      assert.equal(autoClaimSend.status, 200);

      const lifeChat2 = await api(
        `/api/unified/chats/dev-alpha/${encodeURIComponent(chat2Jid)}/lifecycle`,
        {token: saraToken},
      );
      const lifeData = lifeChat2.body?.results as {
        assignment: {status: string; assigned_user_id: number};
        events: Array<{event_type: string}>;
      };
      assert.equal(lifeData.assignment.status, 'open');
      assert.equal(lifeData.assignment.assigned_user_id, saraId);
      assert.equal(lifeData.events.at(-1)?.event_type, 'auto_claimed');

      // 9. Close chat2 -> block prevents send; reopen_and_claim permits send & reopens
      const closeRes = await api(
        `/api/unified/chats/dev-alpha/${encodeURIComponent(chat2Jid)}/close`,
        {method: 'POST', token: linaToken, body: JSON.stringify({reason: 'Done'})},
      );
      assert.equal(closeRes.status, 200);

      const closedSendBlocked = await api(
        `/api/unified/chats/dev-alpha/${encodeURIComponent(chat2Jid)}/send`,
        {
          method: 'POST',
          token: saraToken,
          body: JSON.stringify({message: 'Blocked when closed'}),
        },
      );
      assert.equal(closedSendBlocked.status, 409);
      assert.equal(closedSendBlocked.body?.code, 'CHAT_CLOSED');

      await api('/api/settings/inbox-policy', {
        method: 'PUT',
        token: adminToken,
        body: JSON.stringify({
          unassigned_reply_policy: 'auto_claim',
          closed_reply_policy: 'reopen_and_claim',
        }),
      });
      const reopenedOnSend = await api(
        `/api/unified/chats/dev-alpha/${encodeURIComponent(chat2Jid)}/send`,
        {
          method: 'POST',
          token: saraToken,
          body: JSON.stringify({message: 'Reopen via reply'}),
        },
      );
      assert.equal(reopenedOnSend.status, 200);
      const afterReopenSend = await api(
        `/api/unified/chats/dev-alpha/${encodeURIComponent(chat2Jid)}/lifecycle`,
        {token: saraToken},
      );
      assert.equal(
        (afterReopenSend.body?.results as {assignment: {status: string; assigned_user_id: number}}).assignment.status,
        'open',
      );
      assert.equal(
        (afterReopenSend.body?.results as {assignment: {status: string; assigned_user_id: number}}).assignment.assigned_user_id,
        saraId,
      );

      // 10. GET /api/unified/chats enriches rows with lifecycle summary
      const unifiedRes = await api('/api/unified/chats', {token: saraToken});
      assert.equal(unifiedRes.status, 200);
      const unifiedRows = (unifiedRes.body?.results as {data: Array<{jid: string; lifecycle?: {status: string}}>}).data;
      assert.equal(unifiedRows.find((r) => r.jid === chat2Jid)?.lifecycle?.status, 'open');

      // 11. Bulk lifecycle enforces per-item device access & returns partial results
      const betaChatJid = '966503333333@s.whatsapp.net';
      const bulkRes = await api('/api/unified/chats/bulk-lifecycle', {
        method: 'POST',
        token: saraToken,
        body: JSON.stringify({
          action: 'close',
          reason: 'Bulk cleanup',
          items: [
            {device_id: 'dev-alpha', chat_jid: chat2Jid},
            {device_id: 'dev-beta', chat_jid: betaChatJid},
          ],
        }),
      });
      assert.equal(bulkRes.status, 200);
      const bulkData = bulkRes.body?.results as {
        succeeded: Array<{device_id: string; chat_jid: string; status: string}>;
        failed: Array<{device_id: string; chat_jid: string; code: string}>;
      };
      assert.equal(bulkData.succeeded.length, 1);
      assert.equal(bulkData.succeeded[0].chat_jid, chat2Jid);
      assert.equal(bulkData.succeeded[0].status, 'closed');
      assert.equal(bulkData.failed.length, 1);
      assert.equal(bulkData.failed[0].device_id, 'dev-beta');
      assert.equal(bulkData.failed[0].code, 'DEVICE_FORBIDDEN');

      // 12. Verify dev-beta lifecycle WS event is never delivered to Sara (dev-alpha only)
      const beforeBetaCount = saraCollector.messages.length;
      const betaClaim = await api(
        `/api/unified/chats/dev-beta/${encodeURIComponent(betaChatJid)}/claim`,
        {method: 'POST', token: omarToken},
      );
      assert.equal(betaClaim.status, 200);
      await omarCollector.waitFor(
        (m) =>
          m.code === 'CHAT_LIFECYCLE_UPDATED' &&
          (m.result as {device_id?: string})?.device_id === 'dev-beta',
      );
      await new Promise((r) => setTimeout(r, 150));
      const saraReceivedBeta = saraCollector.messages
        .slice(beforeBetaCount)
        .some((m) => (m.result as {device_id?: string})?.device_id === 'dev-beta');
      assert.equal(saraReceivedBeta, false);
    } finally {
      wsSara.close();
      wsOmar.close();
    }
  });
});
