import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, it} from 'node:test';
import {WebSocket} from 'ws';
import {ALL_PERMISSION_KEYS, PERMISSION_GROUPS} from '../server/rbac.ts';

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

describe('Phase 4 RBAC Unit & Migration Verification', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gowa-lite-rbac-unit-'));
  const unitDbPath = path.join(tmpDir, 'unit.db');

  let dbMod: typeof import('../server/db.ts');
  let wsMod: typeof import('../server/ws-bridge.ts');

  before(async () => {
    process.env.GOWA_LITE_DB_PATH = unitDbPath;
    dbMod = await import('../server/db.ts');
    wsMod = await import('../server/ws-bridge.ts');
  });

  after(() => {
    dbMod?.closeDatabaseSafely();
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  it('seeds 29 canonical permissions across 9 resources and 3 system roles idempotently', () => {
    assert.equal(PERMISSION_GROUPS.length, 9);
    assert.equal(ALL_PERMISSION_KEYS.length, 29);

    const rolesBefore = dbMod.listRoles();
    assert.equal(rolesBefore.length, 3);
    const slugs = rolesBefore.map((r) => r.slug);
    assert.deepEqual(slugs.sort(), ['admin', 'agent', 'manager']);

    const adminRole = rolesBefore.find((r) => r.slug === 'admin')!;
    const agentRole = rolesBefore.find((r) => r.slug === 'agent')!;
    assert.equal(adminRole.is_system, true);
    assert.equal(adminRole.permissions.length, 29);
    assert.equal(agentRole.is_system, true);
    assert.equal(agentRole.is_default, true);

    // Simulate legacy users with role_id = NULL and ensure idempotent migration backfills them
    const legacyAdmin = dbMod.createUser({
      username: 'legacyadmin',
      display_name: 'Legacy Admin',
      role: 'admin',
      password: 'Password123',
    });
    const legacyAgent = dbMod.createUser({
      username: 'legacyagent',
      display_name: 'Legacy Agent',
      role: 'agent',
      password: 'Password123',
    });
    dbMod.db.prepare('UPDATE users SET role_id = NULL WHERE id IN (?, ?)').run(legacyAdmin.id, legacyAgent.id);

    dbMod.seedAndMigrateRbac();
    dbMod.seedAndMigrateRbac();

    assert.equal(dbMod.listRoles().length, 3);
    assert.equal(dbMod.getUserById(legacyAdmin.id)?.role_slug, 'admin');
    assert.equal(dbMod.getUserById(legacyAdmin.id)?.permissions.length, 29);
    assert.equal(dbMod.getUserById(legacyAgent.id)?.role_slug, 'agent');
  });

  it('filters WebSocket broadcasts by permissions and allowed_device_ids via shouldDeliverWsEventToUser', () => {
    const baseUser = {
      id: 99,
      username: 'wsagent',
      display_name: 'WS Agent',
      role: 'agent' as const,
      role_id: 3,
      role_slug: 'agent',
      role_name: 'وكيل خدمة',
      permissions: ['chats:read', 'accounts:read'],
      allowed_device_ids: ['dev-1'],
      is_active: true,
      created_at: new Date().toISOString(),
      theme: 'system' as const,
      language: 'ar' as const,
    };

    // Device restriction rejects unauthorized device events
    assert.equal(
      wsMod.shouldDeliverWsEventToUser(baseUser, {
        code: 'MESSAGE_RECEIVED',
        device_id: 'dev-2',
        result: {chat_jid: '123@s.whatsapp.net'},
      }).allowed,
      false,
    );

    // Authorized device + chats:read allows normal message event
    assert.equal(
      wsMod.shouldDeliverWsEventToUser(baseUser, {
        code: 'MESSAGE_RECEIVED',
        device_id: 'dev-1',
        result: {chat_jid: '123@s.whatsapp.net'},
      }).allowed,
      true,
    );

    // status@broadcast requires misc:status.read (even if chats:read is granted)
    assert.equal(
      wsMod.shouldDeliverWsEventToUser(baseUser, {
        code: 'MESSAGE_RECEIVED',
        device_id: 'dev-1',
        result: {chat_jid: 'status@broadcast'},
      }).allowed,
      false,
    );

    // Notes and schedules updates respect notes:read and schedules:read
    assert.equal(
      wsMod.shouldDeliverWsEventToUser(baseUser, {
        code: 'CONVERSATION_NOTE_UPDATED',
        device_id: 'dev-1',
        result: {},
      }).allowed,
      false,
    );
    assert.equal(
      wsMod.shouldDeliverWsEventToUser(
        {...baseUser, permissions: [...baseUser.permissions, 'notes:read']},
        {code: 'CONVERSATION_NOTE_UPDATED', device_id: 'dev-1', result: {}},
      ).allowed,
      true,
    );
    assert.equal(
      wsMod.shouldDeliverWsEventToUser(baseUser, {
        code: 'SCHEDULE_UPDATED',
        device_id: 'dev-1',
        result: {},
      }).allowed,
      false,
    );

    // LIST_DEVICES filters result array to user's allowed_device_ids
    const listDecision = wsMod.shouldDeliverWsEventToUser(baseUser, {
      code: 'LIST_DEVICES',
      result: [{id: 'dev-1'}, {id: 'dev-2'}],
    });
    assert.equal(listDecision.allowed, true);
    assert.deepEqual(listDecision.filteredPayload, {
      code: 'LIST_DEVICES',
      result: [{id: 'dev-1'}],
    });

    // Deactivated users never receive WS events
    assert.equal(
      wsMod.shouldDeliverWsEventToUser(
        {...baseUser, is_active: false},
        {code: 'MESSAGE_RECEIVED', device_id: 'dev-1', result: {chat_jid: '123@s.whatsapp.net'}},
      ).allowed,
      false,
    );
  });
});

describe('Phase 4 RBAC HTTP & Fail-Closed Integration (RBAC-01, RBAC-02, RBAC-03)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gowa-lite-rbac-int-'));
  const dbPath = path.join(tmpDir, 'int.db');

  let mockGowaServer: http.Server;
  let mockGowaPort = 0;
  let appPort = 0;
  let baseUrl = '';
  let serverProc: ReturnType<typeof spawn> | null = null;
  let serverLogs = '';

  const mockDevices = [
    {id: 'dev-alpha', display_name: 'Alpha Sales', phone_number: '1001', state: 'logged_in', created_at: '2026-01-01T00:00:00Z'},
    {id: 'dev-beta', display_name: 'Beta Support', phone_number: '1002', state: 'logged_in', created_at: '2026-01-01T00:00:00Z'},
  ];

  async function api(pathName: string, options: RequestInit & {token?: string} = {}) {
    const headers = new Headers(options.headers);
    if (options.token) {
      headers.set('Authorization', `Bearer ${options.token}`);
    }
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
      res.setHeader('Content-Type', 'application/json');

      if (url.pathname === '/devices' && req.method === 'GET') {
        res.end(JSON.stringify({code: 'SUCCESS', message: 'ok', results: mockDevices}));
        return;
      }
      if (url.pathname === '/devices' && req.method === 'POST') {
        res.statusCode = 201;
        res.end(
          JSON.stringify({
            code: 'SUCCESS',
            message: 'ok',
            results: {id: 'dev-gamma', display_name: 'Gamma', state: 'disconnected', created_at: '2026-01-01T00:00:00Z'},
          }),
        );
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
      if (url.pathname === '/chats' || url.pathname === '/user/my/groups' || url.pathname === '/user/my/newsletters') {
        res.end(JSON.stringify({code: 'SUCCESS', message: 'ok', results: {data: [], pagination: {limit: 50, offset: 0, total: 0}}}));
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

    serverProc = spawn('node', ['server.ts'], {
      env: {
        ...process.env,
        NODE_ENV: 'production',
        PORT: String(appPort),
        GOWA_LITE_DB_PATH: dbPath,
        GOWA_URL: `http://127.0.0.1:${mockGowaPort}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.stdout?.on('data', (chunk: Buffer) => {
      serverLogs += chunk.toString();
    });
    serverProc.stderr?.on('data', (chunk: Buffer) => {
      serverLogs += chunk.toString();
    });

    for (let i = 0; i < 40; i++) {
      try {
        const res = await fetch(`${baseUrl}/api/auth/status`);
        if (res.ok) return;
      } catch {
        // retry while booting
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`RBAC test server failed to boot:\n${serverLogs}`);
  });

  after(async () => {
    if (serverProc && !serverProc.killed) {
      serverProc.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await new Promise<void>((resolve) => mockGowaServer?.close(() => resolve()));
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  it('enforces custom roles CRUD, privilege escalation guards, device scoping, instant reload, and immediate deactivation', async () => {
    // 1. Setup primary admin
    const setupRes = await api('/api/auth/setup', {
      method: 'POST',
      body: JSON.stringify({
        display_name: 'Root Admin',
        username: 'rootadmin',
        password: 'StrongPassword123',
      }),
    });
    assert.equal(setupRes.status, 201);
    const adminToken = (setupRes.body!.results as {token: string; user: {id: number; role_id: number}}).token;
    const adminUserId = (setupRes.body!.results as {user: {id: number}}).user.id;

    // 2. Permissions & system role protection
    const permsRes = await api('/api/permissions', {token: adminToken});
    assert.equal(permsRes.status, 200);
    assert.equal((permsRes.body!.results as unknown[]).length, 9);

    const rolesRes = await api('/api/roles', {token: adminToken});
    assert.equal(rolesRes.status, 200);
    const roles = rolesRes.body!.results as Array<{id: number; slug: string}>;
    const agentRole = roles.find((r) => r.slug === 'agent')!;
    const adminRole = roles.find((r) => r.slug === 'admin')!;

    // Invalid permission key returns 400 INVALID_PERMISSION
    const badPermRole = await api('/api/roles', {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({name: 'Bad Role', permissions: ['chats:hack']}),
    });
    assert.equal(badPermRole.status, 400);
    assert.equal(badPermRole.body!.code, 'INVALID_PERMISSION');

    // System roles cannot be edited or deleted
    const editSystem = await api(`/api/roles/${agentRole.id}`, {
      method: 'PATCH',
      token: adminToken,
      body: JSON.stringify({name: 'Hacked Agent'}),
    });
    assert.equal(editSystem.status, 403);
    assert.equal(editSystem.body!.code, 'SYSTEM_ROLE_PROTECTED');

    const deleteSystem = await api(`/api/roles/${adminRole.id}`, {
      method: 'DELETE',
      token: adminToken,
    });
    assert.equal(deleteSystem.status, 403);
    assert.equal(deleteSystem.body!.code, 'SYSTEM_ROLE_PROTECTED');

    // Last admin protection (cannot demote or deactivate or delete last active admin)
    const demoteLastAdmin = await api(`/api/users/${adminUserId}`, {
      method: 'PATCH',
      token: adminToken,
      body: JSON.stringify({role_id: agentRole.id}),
    });
    assert.equal(demoteLastAdmin.status, 400);
    assert.equal(demoteLastAdmin.body!.code, 'LAST_ADMIN_PROTECTED');

    const deactivateLastAdmin = await api(`/api/users/${adminUserId}`, {
      method: 'PATCH',
      token: adminToken,
      body: JSON.stringify({is_active: false}),
    });
    assert.equal(deactivateLastAdmin.status, 400);
    assert.equal(deactivateLastAdmin.body!.code, 'LAST_ADMIN_PROTECTED');

    // 3. Create custom role "Alpha Reader" (chats:read + notes:read)
    const customRoleRes = await api('/api/roles', {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({
        name: 'Alpha Reader',
        description: 'Read-only chats and notes',
        permissions: ['chats:read', 'notes:read'],
      }),
    });
    assert.equal(customRoleRes.status, 201);
    const customRole = customRoleRes.body!.results as {id: number; permissions: string[]};

    // Assign a user to custom role -> ROLE_IN_USE prevents deletion
    const alphaUserRes = await api('/api/users', {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({
        username: 'alphareader',
        display_name: 'Alpha Reader User',
        password: 'StrongPassword123',
        role_id: customRole.id,
        allowed_device_ids: ['dev-alpha'],
      }),
    });
    assert.equal(alphaUserRes.status, 201);
    const alphaUser = alphaUserRes.body!.results as {id: number};

    const deleteInUse = await api(`/api/roles/${customRole.id}`, {
      method: 'DELETE',
      token: adminToken,
    });
    assert.equal(deleteInUse.status, 409);
    assert.equal(deleteInUse.body!.code, 'ROLE_IN_USE');

    // 4. Login as Alpha Reader and verify Fail-Closed RBAC + Device Scope
    const alphaLogin = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({username: 'alphareader', password: 'StrongPassword123'}),
    });
    assert.equal(alphaLogin.status, 200);
    const alphaToken = (alphaLogin.body!.results as {token: string}).token;

    // Accounts list filtered strictly to dev-alpha
    const unifiedAccounts = await api('/api/unified/accounts', {token: alphaToken});
    assert.equal(unifiedAccounts.status, 200);
    const accountIds = (unifiedAccounts.body!.results as Array<{id: string}>).map((a) => a.id);
    assert.deepEqual(accountIds, ['dev-alpha']);

    // Denied endpoints return 403 FORBIDDEN (Fail-Closed)
    const forbiddenChecks: Array<[string, RequestInit]> = [
      ['/api/devices', {method: 'GET'}], // lacks accounts:read
      ['/api/settings/gowa', {method: 'GET'}], // lacks settings:read
      ['/api/roles', {method: 'GET'}], // lacks roles:read
      ['/api/users', {method: 'GET'}], // lacks users:read
      ['/api/unified/groups', {method: 'GET'}], // lacks groups:read
      ['/api/misc/statuses', {method: 'GET'}], // lacks misc:status.read
      ['/api/unified/chats/dev-alpha/123@s.whatsapp.net/send', {method: 'POST', body: JSON.stringify({message: 'hi'})}], // lacks chats:write
      ['/api/unified/chats/dev-alpha/123@s.whatsapp.net/notes', {method: 'POST', body: JSON.stringify({content: 'note'})}], // lacks notes:write
    ];
    for (const [routePath, init] of forbiddenChecks) {
      const checkRes = await api(routePath, {...init, token: alphaToken});
      assert.equal(checkRes.status, 403, `Expected 403 for ${routePath}, got ${checkRes.status}`);
      assert.equal(checkRes.body!.code, 'FORBIDDEN');
    }

    // Permitted route for dev-alpha works (notes:read), unauthorized device dev-beta returns 403 DEVICE_FORBIDDEN
    const alphaNotes = await api('/api/unified/chats/dev-alpha/123@s.whatsapp.net/notes', {token: alphaToken});
    assert.equal(alphaNotes.status, 200);

    const betaNotes = await api('/api/unified/chats/dev-beta/123@s.whatsapp.net/notes', {token: alphaToken});
    assert.equal(betaNotes.status, 403);
    assert.equal(betaNotes.body!.code, 'DEVICE_FORBIDDEN');

    // 5. Instant role permission propagation without re-login
    const addWritePerm = await api(`/api/roles/${customRole.id}`, {
      method: 'PATCH',
      token: adminToken,
      body: JSON.stringify({permissions: ['chats:read', 'chats:write', 'notes:read', 'notes:write']}),
    });
    assert.equal(addWritePerm.status, 200);

    const alphaMeAfterUpdate = await api('/api/auth/me', {token: alphaToken});
    assert.equal(alphaMeAfterUpdate.status, 200);
    assert.ok((alphaMeAfterUpdate.body!.results as {permissions: string[]}).permissions.includes('chats:write'));

    // Forward checks target_device_id access as well
    const crossForward = await api('/api/unified/chats/dev-alpha/123@s.whatsapp.net/messages/msg1/forward', {
      method: 'POST',
      token: alphaToken,
      body: JSON.stringify({target_device_id: 'dev-beta', target_jid: '456@s.whatsapp.net', content: 'hello'}),
    });
    assert.equal(crossForward.status, 403);
    assert.equal(crossForward.body!.code, 'DEVICE_FORBIDDEN');

    // 6. Privilege escalation protections for non-admin user managers
    const subManagerRoleRes = await api('/api/roles', {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({
        name: 'Team Submanager',
        permissions: ['roles:read', 'roles:write', 'users:read', 'users:write', 'accounts:read', 'accounts:write', 'chats:read'],
      }),
    });
    assert.equal(subManagerRoleRes.status, 201);
    const subManagerRole = subManagerRoleRes.body!.results as {id: number};

    const subMgrRes = await api('/api/users', {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({
        username: 'submgr',
        display_name: 'Sub Manager',
        password: 'StrongPassword123',
        role_id: subManagerRole.id,
        allowed_device_ids: ['dev-alpha'],
      }),
    });
    assert.equal(subMgrRes.status, 201);

    const subMgrLogin = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({username: 'submgr', password: 'StrongPassword123'}),
    });
    const subMgrToken = (subMgrLogin.body!.results as {token: string}).token;

    // Cannot create role containing permissions not owned (settings:write)
    const escalateRole = await api('/api/roles', {
      method: 'POST',
      token: subMgrToken,
      body: JSON.stringify({name: 'Escalated', permissions: ['chats:read', 'settings:write']}),
    });
    assert.equal(escalateRole.status, 403);
    assert.equal(escalateRole.body!.code, 'PRIVILEGE_ESCALATION_FORBIDDEN');

    // Cannot assign admin role to a new user
    const assignAdmin = await api('/api/users', {
      method: 'POST',
      token: subMgrToken,
      body: JSON.stringify({
        username: 'fakeadmin',
        display_name: 'Fake Admin',
        password: 'StrongPassword123',
        role_id: adminRole.id,
      }),
    });
    assert.equal(assignAdmin.status, 403);
    assert.equal(assignAdmin.body!.code, 'PRIVILEGE_ESCALATION_FORBIDDEN');

    // Cannot modify an existing admin user
    const editAdmin = await api(`/api/users/${adminUserId}`, {
      method: 'PATCH',
      token: subMgrToken,
      body: JSON.stringify({display_name: 'Hijacked'}),
    });
    assert.equal(editAdmin.status, 403);
    assert.equal(editAdmin.body!.code, 'PRIVILEGE_ESCALATION_FORBIDDEN');

    // Device-restricted user cannot create brand-new WhatsApp devices
    const createDeviceRestricted = await api('/api/devices', {
      method: 'POST',
      token: subMgrToken,
      body: JSON.stringify({device_id: 'dev-gamma'}),
    });
    assert.equal(createDeviceRestricted.status, 403);
    assert.equal(createDeviceRestricted.body!.code, 'DEVICE_FORBIDDEN');

    // 7. Instant deactivation invalidates existing HTTP token AND closes active WebSocket with 4001
    const ticketRes = await api('/api/auth/ws-ticket', {method: 'POST', token: alphaToken});
    assert.equal(ticketRes.status, 200);
    const ticket = (ticketRes.body!.results as {ticket: string}).ticket;

    const wsCloseCodePromise = new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${appPort}/ws?ticket=${ticket}`);
      ws.on('open', async () => {
        try {
          const deactivateRes = await api(`/api/users/${alphaUser.id}`, {
            method: 'PATCH',
            token: adminToken,
            body: JSON.stringify({is_active: false}),
          });
          assert.equal(deactivateRes.status, 200);
          await api('/api/unified/chats/dev-alpha/123@s.whatsapp.net/notes', {
            method: 'POST',
            token: adminToken,
            body: JSON.stringify({content: 'trigger ws disconnect check'}),
          });
        } catch (err) {
          reject(err);
        }
      });
      ws.on('close', (code) => resolve(code));
      ws.on('error', reject);
    });

    const wsCloseCode = await wsCloseCodePromise;
    assert.equal(wsCloseCode, 4001);

    const alphaAfterDeactivate = await api('/api/auth/me', {token: alphaToken});
    assert.equal(alphaAfterDeactivate.status, 401);

    // 8. Reassign user to agent role and verify custom role can now be deleted cleanly
    const reassign = await api(`/api/users/${alphaUser.id}`, {
      method: 'PATCH',
      token: adminToken,
      body: JSON.stringify({role_id: agentRole.id}),
    });
    assert.equal(reassign.status, 200);

    const deleteCustomRole = await api(`/api/roles/${customRole.id}`, {
      method: 'DELETE',
      token: adminToken,
    });
    assert.equal(deleteCustomRole.status, 200);
  });
});
