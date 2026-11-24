import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, it} from 'node:test';
import {WebSocket, WebSocketServer} from 'ws';
import {shouldAlertIncomingChat} from '../src/lib/notifications.ts';

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

describe('Phase 6 Notification Alert Gating (CHAT-TABS-03)', () => {
  const restrictedAgent = {
    id: 11,
    role: 'agent' as const,
    role_slug: 'agent',
    permissions: ['chats:read', 'chats:write', 'chats:assign', 'chats:close'],
    allowed_device_ids: ['dev-1'],
    is_active: true,
  };

  const supervisor = {
    id: 12,
    role: 'agent' as const,
    role_slug: 'supervisor',
    permissions: ['chats:read', 'chats:write', 'chats:view_all', 'chats:assign', 'chats:close'],
    allowed_device_ids: [],
    is_active: true,
  };

  it('allows pending, own-open, and auto-reopening closed chats on allowed devices while blocking others', () => {
    // Inactive or missing user
    assert.equal(
      shouldAlertIncomingChat({
        user: null,
        deviceId: 'dev-1',
        chatJid: '966500000001@s.whatsapp.net',
      }),
      false,
    );
    assert.equal(
      shouldAlertIncomingChat({
        user: {...restrictedAgent, is_active: false},
        deviceId: 'dev-1',
        chatJid: '966500000001@s.whatsapp.net',
      }),
      false,
    );

    // Excludes newsletters and WhatsApp Status broadcasts
    assert.equal(
      shouldAlertIncomingChat({
        user: supervisor,
        deviceId: 'dev-1',
        chatJid: 'status@broadcast',
      }),
      false,
    );
    assert.equal(
      shouldAlertIncomingChat({
        user: supervisor,
        deviceId: 'dev-1',
        chatJid: '120363001@newsletter',
      }),
      false,
    );

    // Enforces chats:read and allowed_device_ids
    assert.equal(
      shouldAlertIncomingChat({
        user: {...restrictedAgent, permissions: ['notes:read']},
        deviceId: 'dev-1',
        chatJid: '966500000001@s.whatsapp.net',
      }),
      false,
    );
    assert.equal(
      shouldAlertIncomingChat({
        user: restrictedAgent,
        deviceId: 'dev-2',
        chatJid: '966500000001@s.whatsapp.net',
      }),
      false,
    );

    // Pending chat -> alerts allowed agent
    assert.equal(
      shouldAlertIncomingChat({
        user: restrictedAgent,
        deviceId: 'dev-1',
        chatJid: '966500000001@s.whatsapp.net',
        lifecycle: {status: 'pending', assigned_user_id: null},
      }),
      true,
    );

    // Open chat owned by another agent -> suppressed for regular agent, allowed for supervisor
    assert.equal(
      shouldAlertIncomingChat({
        user: restrictedAgent,
        deviceId: 'dev-1',
        chatJid: '966500000001@s.whatsapp.net',
        lifecycle: {status: 'open', assigned_user_id: 99},
      }),
      false,
    );
    assert.equal(
      shouldAlertIncomingChat({
        user: supervisor,
        deviceId: 'dev-1',
        chatJid: '966500000001@s.whatsapp.net',
        lifecycle: {status: 'open', assigned_user_id: 99},
      }),
      true,
    );

    // Open chat owned by self -> alerts agent
    assert.equal(
      shouldAlertIncomingChat({
        user: restrictedAgent,
        deviceId: 'dev-1',
        chatJid: '966500000001@s.whatsapp.net',
        lifecycle: {status: 'open', assigned_user_id: restrictedAgent.id},
      }),
      true,
    );

    // Closed chat (reopens automatically on incoming customer message) -> alerts agent
    assert.equal(
      shouldAlertIncomingChat({
        user: restrictedAgent,
        deviceId: 'dev-1',
        chatJid: '966500000001@s.whatsapp.net',
        lifecycle: {status: 'closed', assigned_user_id: null},
      }),
      true,
    );
  });
});

describe('Phase 5 & Phase 6 End-to-End Verification (TEST-PHASE5-01 & CHAT-TABS-01)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gowa-lite-phase5-all-'));
  const dbPath = path.join(tmpDir, 'phase5.db');

  let mockGowaServer: http.Server;
  let mockGowaWss: WebSocketServer;
  const mockGowaWsClients = new Map<string, WebSocket>();
  let mockGowaPort = 0;
  let appPort = 0;
  let baseUrl = '';
  let serverProc: ReturnType<typeof spawn> | null = null;
  let serverLogs = '';
  let gowaChatsFetchCount = 0;

  const mockDevices = [
    {
      id: 'dev-1',
      display_name: 'Sales Main',
      phone_number: '966500000100',
      state: 'logged_in',
      created_at: '2026-11-20T00:00:00Z',
    },
    {
      id: 'dev-2',
      display_name: 'Support Desk',
      phone_number: '966500000200',
      state: 'logged_in',
      created_at: '2026-11-20T00:00:00Z',
    },
  ];

  const mockChatsByDevice: Record<string, Array<Record<string, unknown>>> = {
    'dev-1': [
      {
        jid: '966510000001@s.whatsapp.net',
        name: 'Customer Pending One',
        last_message_time: '2026-11-24T03:00:00Z',
        ephemeral_expiration: 0,
        created_at: '2026-11-24T00:00:00Z',
        updated_at: '2026-11-24T03:00:00Z',
        archived: false,
      },
      {
        jid: '966510000002@s.whatsapp.net',
        name: 'Customer Claim Race',
        last_message_time: '2026-11-24T02:50:00Z',
        ephemeral_expiration: 0,
        created_at: '2026-11-24T00:00:00Z',
        updated_at: '2026-11-24T02:50:00Z',
        archived: false,
      },
      {
        jid: '966510000003@s.whatsapp.net',
        name: 'Customer Closed Three',
        last_message_time: '2026-11-24T02:40:00Z',
        ephemeral_expiration: 0,
        created_at: '2026-11-24T00:00:00Z',
        updated_at: '2026-11-24T02:40:00Z',
        archived: false,
      },
    ],
    'dev-2': [
      {
        jid: '966520000001@s.whatsapp.net',
        name: 'Support Customer Alpha',
        last_message_time: '2026-11-24T02:55:00Z',
        ephemeral_expiration: 0,
        created_at: '2026-11-24T00:00:00Z',
        updated_at: '2026-11-24T02:55:00Z',
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
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return {status: res.status, body};
  }

  before(async () => {
    mockGowaServer = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const deviceId = String(req.headers['x-device-id'] || 'dev-1');
      res.setHeader('Content-Type', 'application/json');

      if (url.pathname === '/devices' && req.method === 'GET') {
        res.end(JSON.stringify({code: 'SUCCESS', message: 'ok', results: mockDevices}));
        return;
      }
      if (/^\/devices\/[^/]+\/status$/.test(url.pathname)) {
        const dev = decodeURIComponent(url.pathname.split('/')[2]);
        res.end(
          JSON.stringify({
            code: 'SUCCESS',
            message: 'ok',
            results: {device_id: dev, is_connected: true, is_logged_in: true},
          }),
        );
        return;
      }
      if (url.pathname === '/chats' && req.method === 'GET') {
        gowaChatsFetchCount += 1;
        const list = mockChatsByDevice[deviceId] ?? [];
        res.end(
          JSON.stringify({
            code: 'SUCCESS',
            message: 'ok',
            results: {data: list, pagination: {limit: 100, offset: 0, total: list.length}},
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
      res.end(JSON.stringify({code: 'SUCCESS', message: 'ok', results: []}));
    });

    mockGowaWss = new WebSocketServer({server: mockGowaServer, path: '/ws'});
    mockGowaWss.on('connection', (ws, req) => {
      const reqUrl = new URL(req.url || '/ws', 'http://127.0.0.1');
      const devId = reqUrl.searchParams.get('device_id') || 'default';
      mockGowaWsClients.set(devId, ws);
      ws.on('close', () => {
        if (mockGowaWsClients.get(devId) === ws) {
          mockGowaWsClients.delete(devId);
        }
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
    for (const client of mockGowaWsClients.values()) {
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

  it('validates custom roles, device scoping, concurrent claim 409 conflict, customer auto-reopen, and inbox tabs + SQLite closed pagination', async () => {
    // 1. Bootstrap admin & GOWA connection
    const setupRes = await api('/api/auth/setup', {
      method: 'POST',
      body: JSON.stringify({
        display_name: 'System Admin',
        username: 'admin',
        password: 'Password123',
        gowa_url: `http://127.0.0.1:${mockGowaPort}`,
      }),
    });
    assert.equal(setupRes.status, 201);
    const adminToken = (setupRes.body?.results as {token: string}).token;

    // Wait for GOWA WS bridge to connect for dev-1
    const wsWaitStart = Date.now();
    while (!mockGowaWsClients.has('dev-1') && Date.now() - wsWaitStart < 5000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(mockGowaWsClients.has('dev-1'), 'Expected GowaWsBridge to connect dev-1 to mock GOWA /ws');

    // 2. Create custom role (Team Lead) and fetch system agent role
    const rolesRes = await api('/api/roles', {token: adminToken});
    assert.equal(rolesRes.status, 200);
    const rolesList = rolesRes.body?.results as Array<{id: number; slug: string}>;
    const agentRoleId = rolesList.find((r) => r.slug === 'agent')!.id;

    const createLeadRoleRes = await api('/api/roles', {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({
        name: 'Team Lead Custom',
        description: 'Handles escalated inbox chats and roles view',
        permissions: [
          'chats:read',
          'chats:write',
          'chats:view_all',
          'chats:assign',
          'chats:close',
          'roles:read',
          'roles:write',
        ],
      }),
    });
    assert.equal(createLeadRoleRes.status, 201);
    const leadRoleId = (createLeadRoleRes.body?.results as {id: number}).id;

    // 3. Create Restricted Agent A (dev-1 only), Agent B (dev-1 + dev-2), and Team Lead
    const createUserA = await api('/api/users', {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({
        display_name: 'Agent One',
        username: 'agent1',
        password: 'Password123',
        role_id: agentRoleId,
        allowed_device_ids: ['dev-1'],
      }),
    });
    const createUserB = await api('/api/users', {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({
        display_name: 'Agent Two',
        username: 'agent2',
        password: 'Password123',
        role_id: agentRoleId,
        allowed_device_ids: ['dev-1', 'dev-2'],
      }),
    });
    const createLead = await api('/api/users', {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({
        display_name: 'Lead Supervisor',
        username: 'lead1',
        password: 'Password123',
        role_id: leadRoleId,
        allowed_device_ids: [],
      }),
    });
    assert.equal(createUserA.status, 201);
    assert.equal(createUserB.status, 201);
    assert.equal(createLead.status, 201);

    const agent1Login = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({username: 'agent1', password: 'Password123'}),
    });
    const agent2Login = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({username: 'agent2', password: 'Password123'}),
    });
    const leadLogin = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({username: 'lead1', password: 'Password123'}),
    });

    const agent1Token = (agent1Login.body?.results as {token: string}).token;
    const agent1Id = (agent1Login.body?.results as {user: {id: number}}).user.id;
    const agent2Token = (agent2Login.body?.results as {token: string}).token;
    const agent2Id = (agent2Login.body?.results as {user: {id: number}}).user.id;
    const leadToken = (leadLogin.body?.results as {token: string}).token;

    // 4. Verify RBAC guards: non-privileged user blocked from roles CRUD; Team Lead blocked from escalating unheld settings:write
    const deniedRoleCreate = await api('/api/roles', {
      method: 'POST',
      token: agent1Token,
      body: JSON.stringify({name: 'Hack Role', permissions: ['chats:read']}),
    });
    assert.equal(deniedRoleCreate.status, 403);

    const escalationAttempt = await api('/api/roles', {
      method: 'POST',
      token: leadToken,
      body: JSON.stringify({name: 'Escalated', permissions: ['chats:read', 'settings:write']}),
    });
    assert.equal(escalationAttempt.status, 403);

    // 5. Verify device scoping on Agent 1
    const dev2Forbidden = await api('/api/unified/chats?deviceId=dev-2', {token: agent1Token});
    assert.equal(dev2Forbidden.status, 403);
    assert.equal(dev2Forbidden.body?.code, 'DEVICE_FORBIDDEN');

    // 6. Concurrent Claim Race -> 200 vs 409 ALREADY_CLAIMED
    const raceJid = '966510000002@s.whatsapp.net';
    const [claimRes1, claimRes2] = await Promise.all([
      api(`/api/unified/chats/dev-1/${encodeURIComponent(raceJid)}/claim`, {
        method: 'POST',
        token: agent1Token,
        body: JSON.stringify({cached_title: 'Customer Claim Race'}),
      }),
      api(`/api/unified/chats/dev-1/${encodeURIComponent(raceJid)}/claim`, {
        method: 'POST',
        token: agent2Token,
        body: JSON.stringify({cached_title: 'Customer Claim Race'}),
      }),
    ]);
    const statuses = [claimRes1.status, claimRes2.status].sort((a, b) => a - b);
    assert.deepEqual(statuses, [200, 409]);

    const winnerToken = claimRes1.status === 200 ? agent1Token : agent2Token;
    const winnerId = claimRes1.status === 200 ? agent1Id : agent2Id;
    const loserToken = claimRes1.status === 200 ? agent2Token : agent1Token;

    // Non-owner regular agent cannot release or close
    const hijackRelease = await api(`/api/unified/chats/dev-1/${encodeURIComponent(raceJid)}/release`, {
      method: 'POST',
      token: loserToken,
      body: JSON.stringify({}),
    });
    assert.equal(hijackRelease.status, 403);

    // Transfer to Agent 1 if Agent 2 won, so Agent 1 owns raceJid; then Agent 2 claims dev-2 chat
    if (winnerId !== agent1Id) {
      const transferRes = await api(`/api/unified/chats/dev-1/${encodeURIComponent(raceJid)}/assign`, {
        method: 'POST',
        token: leadToken,
        body: JSON.stringify({user_id: agent1Id}),
      });
      assert.equal(transferRes.status, 200);
    } else {
      assert.ok(winnerToken);
    }

    const claimDev2 = await api(
      `/api/unified/chats/dev-2/${encodeURIComponent('966520000001@s.whatsapp.net')}/claim`,
      {
        method: 'POST',
        token: agent2Token,
        body: JSON.stringify({cached_title: 'Support Customer Alpha'}),
      },
    );
    assert.equal(claimDev2.status, 200);

    // 7. Close multiple chats on dev-1 (1 live + 4 archive-only) to test Closed tab pagination & search
    const closedTargets = [
      {device_id: 'dev-1', chat_jid: '966510000003@s.whatsapp.net', cached_title: 'Customer Closed Three'},
      {device_id: 'dev-1', chat_jid: '966590000001@s.whatsapp.net', cached_title: 'VIP Billing Resolved'},
      {device_id: 'dev-1', chat_jid: '966590000002@s.whatsapp.net', cached_title: 'VIP Order Refunded'},
      {device_id: 'dev-1', chat_jid: '966590000003@s.whatsapp.net', cached_title: 'General Inquiry Closed'},
      {device_id: 'dev-1', chat_jid: '966590000004@s.whatsapp.net', cached_title: 'Archive Followup Done'},
    ];
    const bulkCloseRes = await api('/api/unified/chats/bulk-lifecycle', {
      method: 'POST',
      token: leadToken,
      body: JSON.stringify({action: 'close', items: closedTargets}),
    });
    assert.equal(bulkCloseRes.status, 200);
    assert.equal((bulkCloseRes.body?.results as {succeeded: unknown[]}).succeeded.length, 5);

    // 8. Incoming customer message over GOWA WS auto-reopens 'Customer Closed Three' -> pending
    const reopenTargetJid = '966510000003@s.whatsapp.net';
    const wsClient = mockGowaWsClients.get('dev-1')!;
    wsClient.send(
      JSON.stringify({
        code: 'MESSAGE_RECEIVED',
        device_id: 'dev-1',
        message: 'incoming',
        result: {
          id: 'incoming-reopen-1',
          chat_jid: reopenTargetJid,
          sender_jid: reopenTargetJid,
          content: 'Reopening my closed ticket please',
          timestamp: new Date().toISOString(),
          is_from_me: false,
        },
      }),
    );

    // Poll until auto-reopen updates DB state to pending (4 closed remaining)
    let reopened = false;
    for (let i = 0; i < 20; i += 1) {
      const checkLead = await api('/api/unified/chats?tab=all', {token: leadToken});
      const counts = (checkLead.body?.results as {tab_counts?: {closed: number}})?.tab_counts;
      if (counts && counts.closed === 4) {
        reopened = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(reopened, true, 'Incoming customer message should auto-reopen closed chat');

    // 9. CHAT-TABS-01 Validation & Permission checks
    const badTabRes = await api('/api/unified/chats?tab=invalid', {token: leadToken});
    assert.equal(badTabRes.status, 400);
    assert.equal(badTabRes.body?.code, 'VALIDATION_ERROR');

    const badAssignedRes = await api('/api/unified/chats?tab=me&assignedTo=abc', {token: leadToken});
    assert.equal(badAssignedRes.status, 400);

    // Regular Agent 1 denied 'all' and viewing Agent 2's chats, while 'closed' is accessible for allowed devices
    const agentAllDenied = await api('/api/unified/chats?tab=all', {token: agent1Token});
    assert.equal(agentAllDenied.status, 403);
    const agentClosedAllowed = await api('/api/unified/chats?tab=closed', {token: agent1Token});
    assert.equal(agentClosedAllowed.status, 200);
    const agentClosedData = (agentClosedAllowed.body?.results as {data: Array<{jid: string}>}).data;
    assert.equal(agentClosedData.length, 4);
    const agentOtherDenied = await api(`/api/unified/chats?tab=me&assignedTo=${agent2Id}`, {
      token: agent1Token,
    });
    assert.equal(agentOtherDenied.status, 403);

    // Agent 1 tab_counts & scoped views
    const agentMeRes = await api('/api/unified/chats?tab=me', {token: agent1Token});
    assert.equal(agentMeRes.status, 200);
    const agentMeResults = agentMeRes.body?.results as {
      data: Array<{jid: string; device_id: string}>;
      tab_counts: {all: number; me: number; pending: number; closed: number};
    };
    assert.equal(agentMeResults.tab_counts.me, 1);
    assert.equal(agentMeResults.tab_counts.pending, 2); // Customer Pending One + reopened Customer Closed Three
    assert.equal(agentMeResults.tab_counts.all, 0);
    assert.equal(agentMeResults.tab_counts.closed, 4);
    assert.deepEqual(
      agentMeResults.data.map((c) => c.jid),
      [raceJid],
    );

    const agentPendingRes = await api('/api/unified/chats?tab=pending', {token: agent1Token});
    assert.equal(agentPendingRes.status, 200);
    const pendingJids = (agentPendingRes.body?.results as {data: Array<{jid: string}>}).data.map(
      (c) => c.jid,
    );
    assert.equal(pendingJids.includes('966510000001@s.whatsapp.net'), true);
    assert.equal(pendingJids.includes(reopenTargetJid), true);
    assert.equal(pendingJids.includes(raceJid), false);

    // 10. Supervisor Me filter: assignedTo=all (both open chats) vs assignedTo=me (0)
    const leadAllOpenRes = await api('/api/unified/chats?tab=me&assignedTo=all', {token: leadToken});
    assert.equal(leadAllOpenRes.status, 200);
    const leadAllOpenData = (leadAllOpenRes.body?.results as {data: Array<{jid: string}>}).data;
    assert.equal(leadAllOpenData.length, 2);

    const leadMineOnlyRes = await api('/api/unified/chats?tab=me&assignedTo=me', {token: leadToken});
    assert.equal(leadMineOnlyRes.status, 200);
    const leadMineResults = leadMineOnlyRes.body?.results as {
      data: Array<{jid: string}>;
      tab_counts: {all: number; me: number; pending: number; closed: number};
    };
    assert.equal(leadMineResults.data.length, 0);
    assert.equal(leadMineResults.tab_counts.me, 0);
    assert.equal(leadMineResults.tab_counts.closed, 4);
    assert.equal(leadMineResults.tab_counts.pending, 2);
    assert.equal(leadMineResults.tab_counts.all, 8); // 4 remote chats + 4 cache-only closed rows

    // 11. Closed tab direct SQLite pagination skips GOWA /chats when offset > 0 + supports search
    const closedPage1 = await api('/api/unified/chats?tab=closed&limit=2&offset=0', {
      token: leadToken,
    });
    assert.equal(closedPage1.status, 200);
    const page1Payload = closedPage1.body?.results as {
      data: Array<{jid: string; name: string}>;
      pagination: {total: number; has_more: boolean};
    };
    assert.equal(page1Payload.data.length, 2);
    assert.equal(page1Payload.pagination.total, 4);
    assert.equal(page1Payload.pagination.has_more, true);

    const gowaCallsBeforePage2 = gowaChatsFetchCount;
    const closedPage2 = await api('/api/unified/chats?tab=closed&limit=2&offset=2', {
      token: leadToken,
    });
    assert.equal(closedPage2.status, 200);
    assert.equal(
      gowaChatsFetchCount,
      gowaCallsBeforePage2,
      'tab=closed offset > 0 must paginate SQLite directly without hitting GOWA /chats',
    );
    const page2Payload = closedPage2.body?.results as {
      data: Array<{jid: string; name: string}>;
      pagination: {total: number; has_more: boolean};
    };
    assert.equal(page2Payload.data.length, 2);
    assert.equal(page2Payload.pagination.has_more, false);

    // Search closed archive by cached_title
    const closedSearch = await api('/api/unified/chats?tab=closed&search=VIP', {token: leadToken});
    assert.equal(closedSearch.status, 200);
    const vipClosed = (closedSearch.body?.results as {data: Array<{name: string}>}).data;
    assert.equal(vipClosed.length, 2);
    assert.equal(
      vipClosed.every((c) => c.name.includes('VIP')),
      true,
    );
  });
});
