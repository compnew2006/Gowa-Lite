import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, it} from 'node:test';
import type {UnifiedChat, User} from '../src/api/types.ts';
import {computeChatMenuPosition} from '../src/features/chat/chat-menu-positioning.ts';
import {mergePaginatedChats} from '../src/features/chat/use-paginated-chats.ts';
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

describe('Chat Row Context Menu (Unit)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gowa-lite-menu-unit-'));
  const unitDbPath = path.join(tmpDir, 'unit.db');

  let dbMod: typeof import('../server/db.ts');
  let schemasMod: typeof import('../server/validation/schemas.ts');

  before(async () => {
    process.env.GOWA_LITE_DB_PATH = unitDbPath;
    dbMod = await import('../server/db.ts');
    schemasMod = await import('../server/validation/schemas.ts');
  });

  after(() => {
    dbMod?.closeDatabaseSafely();
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  it('positions main menu and cascading mute submenu inside viewport bounds for LTR and RTL', () => {
    // LTR bottom-right near edge should flip/clamp safely inside viewport
    const ltrEdge = computeChatMenuPosition({
      anchorX: 1240,
      anchorY: 760,
      menuWidth: 228,
      menuHeight: 360,
      viewportWidth: 1280,
      viewportHeight: 800,
      isRtl: false,
      submenuWidth: 176,
      submenuHeight: 148,
      muteItemTopOffset: 44,
    });
    assert.ok(ltrEdge.left >= 8 && ltrEdge.left + 228 <= 1280 - 8);
    assert.ok(ltrEdge.top >= 8 && ltrEdge.top + 360 <= 800 - 8);
    assert.ok(ltrEdge.submenuLeft >= 8 && ltrEdge.submenuLeft + 176 <= 1280 - 8);
    assert.equal(ltrEdge.submenuSide, 'left');

    // RTL sidebar anchor on right expands leftward and cascades submenu leftward
    const rtlSidebar = computeChatMenuPosition({
      anchorX: 980,
      anchorY: 160,
      menuWidth: 228,
      menuHeight: 360,
      viewportWidth: 1280,
      viewportHeight: 800,
      isRtl: true,
      submenuWidth: 176,
      submenuHeight: 148,
      muteItemTopOffset: 44,
    });
    assert.equal(rtlSidebar.left, 980 - 228);
    assert.equal(rtlSidebar.submenuSide, 'left');
    assert.equal(rtlSidebar.submenuLeft, rtlSidebar.left - 176 + 4);
  });

  it('suppresses incoming alerts in shouldAlertIncomingChat when chat key is muted', () => {
    const user: Pick<
      User,
      'id' | 'role' | 'role_slug' | 'permissions' | 'allowed_device_ids' | 'is_active'
    > = {
      id: 10,
      role: 'agent',
      role_slug: 'agent',
      permissions: ['chats:read'],
      allowed_device_ids: ['dev-1'],
      is_active: true,
    };

    assert.equal(
      shouldAlertIncomingChat({
        user,
        deviceId: 'dev-1',
        chatJid: '966501112233@s.whatsapp.net',
        mutedKeys: new Set(['dev-1::966501112233@s.whatsapp.net']),
      }),
      false,
    );

    assert.equal(
      shouldAlertIncomingChat({
        user,
        deviceId: 'dev-1',
        chatJid: '966509998877@s.whatsapp.net',
        mutedKeys: new Set(['dev-1::966501112233@s.whatsapp.net']),
      }),
      true,
    );
  });

  it('sorts pinned chats ahead of unpinned chats in mergePaginatedChats', () => {
    const base = {
      ephemeral_expiration: 0,
      created_at: '2026-11-24T00:00:00Z',
      updated_at: '2026-11-24T00:00:00Z',
      archived: false,
      device_id: 'dev-1',
      device_display_name: 'Line 1',
      device_state: 'logged_in' as const,
    };
    const newerUnpinned: UnifiedChat = {
      ...base,
      jid: '111@s.whatsapp.net',
      name: 'Newer Unpinned',
      last_message_time: '2026-11-24T12:00:00Z',
      is_pinned: false,
    };
    const olderPinned: UnifiedChat = {
      ...base,
      jid: '222@s.whatsapp.net',
      name: 'Older Pinned',
      last_message_time: '2026-11-24T08:00:00Z',
      is_pinned: true,
      pinned_at_ms: 1_700_000_000_000,
    };
    const newerPinned: UnifiedChat = {
      ...base,
      jid: '333@s.whatsapp.net',
      name: 'Newer Pinned',
      last_message_time: '2026-11-24T07:00:00Z',
      is_pinned: true,
      pinned_at_ms: 1_700_000_500_000,
    };

    const merged = mergePaginatedChats([newerUnpinned], [olderPinned, newerPinned]);
    assert.deepEqual(
      merged.map((c) => c.jid),
      ['333@s.whatsapp.net', '222@s.whatsapp.net', '111@s.whatsapp.net'],
    );
  });

  it('persists pin, archive override, block, mute, manual unread, favourites, lists, clear, and delete in SQLite', () => {
    const roles = dbMod.listRoles();
    const agentRole = roles.find((r) => r.slug === 'agent')!;
    const userA = dbMod.createUser({
      username: 'menu_u1',
      display_name: 'Menu User 1',
      role: 'agent',
      role_id: agentRole.id,
      allowed_device_ids: [],
      password: 'Password123',
    });
    const userB = dbMod.createUser({
      username: 'menu_u2',
      display_name: 'Menu User 2',
      role: 'agent',
      role_id: agentRole.id,
      allowed_device_ids: [],
      password: 'Password123',
    });

    const devId = 'dev-menu';
    const jid = '966501234567@s.whatsapp.net';

    // Pin & archive & block
    const pinned = dbMod.setChatPinState(devId, jid, true);
    assert.equal(pinned.is_pinned, true);
    assert.ok(pinned.pinned_at_ms > 0);
    const unpinned = dbMod.setChatPinState(devId, jid, false);
    assert.equal(unpinned.is_pinned, false);
    assert.equal(unpinned.pinned_at_ms, 0);

    const archived = dbMod.setChatArchiveOverride(devId, jid, true);
    assert.equal(archived.archived_override, true);

    assert.equal(dbMod.isChatBlocked(devId, jid), false);
    dbMod.setChatBlockedState(devId, jid, true);
    assert.equal(dbMod.isChatBlocked(devId, jid), true);

    // Mute per user
    const mutedAlways = dbMod.setUserChatMute(userA.id, devId, jid, 'always');
    assert.equal(mutedAlways, -1);
    assert.deepEqual(dbMod.getUserMutedChatKeys(userA.id), [`${devId}::${jid}`]);
    assert.deepEqual(dbMod.getUserMutedChatKeys(userB.id), []);
    dbMod.setUserChatMute(userA.id, devId, jid, 'unmute');
    assert.deepEqual(dbMod.getUserMutedChatKeys(userA.id), []);

    // Manual unread isolated per user
    dbMod.markChatUnreadForUser(userA.id, devId, jid);
    const countsA = dbMod.getUnreadCountsForUser(userA, [{device_id: devId, chat_jid: jid}]);
    const countsB = dbMod.getUnreadCountsForUser(userB, [{device_id: devId, chat_jid: jid}]);
    assert.equal(countsA.get(`${devId}::${jid}`), 1);
    assert.equal(countsB.get(`${devId}::${jid}`) ?? 0, 0);
    dbMod.markChatReadForUser(userA.id, devId, jid);
    const countsAAfterRead = dbMod.getUnreadCountsForUser(userA, [
      {device_id: devId, chat_jid: jid},
    ]);
    assert.equal(countsAAfterRead.get(`${devId}::${jid}`) ?? 0, 0);

    // Favourite & custom lists
    dbMod.setUserChatFavourite(userA.id, devId, jid, true);
    const prefsA = dbMod.getUserChatPreferencesMap(userA.id, [devId]);
    assert.equal(prefsA.get(`${devId}::${jid}`)?.is_favourite, true);

    const vipList = dbMod.createChatListForUser(userA.id, 'VIP');
    assert.throws(() => dbMod.createChatListForUser(userA.id, 'vip'));
    const assigned = dbMod.setChatListMembership(userA.id, devId, jid, [vipList.id]);
    assert.deepEqual(assigned, [vipList.id]);
    assert.equal(dbMod.listChatListsForUser(userA.id)[0]?.chat_count, 1);
    assert.equal(dbMod.deleteChatListForUser(userA.id, vipList.id), true);
    assert.equal(dbMod.listChatListsForUser(userA.id).length, 0);

    // Clear chat hides earlier messages while preserving newer ones
    const tOld = '2026-11-24T01:00:00.000Z';
    const tNew = new Date(Date.now() + 60_000).toISOString();
    const clearResult = dbMod.clearChatHistoryInDb(devId, jid);
    assert.ok(clearResult.clearedBeforeMs > 0);
    const merged = dbMod.syncAndMergeChatMessages(
      devId,
      jid,
      [
        {
          id: 'old-1',
          chat_jid: jid,
          sender_jid: jid,
          content: 'Old hidden',
          timestamp: tOld,
          is_from_me: false,
          media_type: '',
          filename: '',
          url: '',
          file_length: 0,
        },
        {
          id: 'new-1',
          chat_jid: jid,
          sender_jid: jid,
          content: 'New visible',
          timestamp: tNew,
          is_from_me: false,
          media_type: '',
          filename: '',
          url: '',
          file_length: 0,
        },
      ],
      {
        offset: 0,
        limit: 40,
      },
    );
    assert.deepEqual(
      merged.messages.map((m) => m.id),
      ['new-1'],
    );

    // Zod validation schemas
    assert.equal(schemasMod.chatArchiveBodySchema.parse({archived: true}).archived, true);
    assert.equal(schemasMod.chatPinBodySchema.parse({pinned: true}).pinned, true);
    assert.equal(schemasMod.chatMuteBodySchema.parse({duration: '8h'}).duration, '8h');
    assert.throws(() => schemasMod.chatMuteBodySchema.parse({duration: '99d'}));
    assert.equal(schemasMod.chatListCreateSchema.parse({name: '  Leads  '}).name, 'Leads');
    assert.throws(() => schemasMod.chatListCreateSchema.parse({name: '   '}));
  });
});

describe('Chat Row Context Menu (HTTP Integration)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gowa-lite-menu-int-'));
  const dbPath = path.join(tmpDir, 'int.db');

  let mockGowaServer: http.Server;
  let mockGowaPort = 0;
  let appPort = 0;
  let baseUrl = '';
  let serverProc: ReturnType<typeof spawn> | undefined;
  let serverLogs = '';

  const jidA = '966501000001@s.whatsapp.net';
  const jidB = '966501000002@s.whatsapp.net';
  let chatATime = '2026-11-24T01:00:00.000Z';
  const chatBTime = '2026-11-24T03:00:00.000Z';
  const remoteCalls: Array<{path: string; body: Record<string, unknown>}> = [];

  async function api(pathName: string, options: RequestInit & {token?: string} = {}) {
    const headers = new Headers(options.headers);
    if (options.token) headers.set('Authorization', `Bearer ${options.token}`);
    if (options.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }
    const res = await fetch(`${baseUrl}${pathName}`, {...options, headers});
    const text = await res.text();
    let json: Record<string, unknown> | null = null;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = null;
    }
    return {status: res.status, text, body: json};
  }

  before(async () => {
    mockGowaServer = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      let bodyRaw = '';
      for await (const chunk of req) {
        bodyRaw += chunk.toString();
      }
      let parsedBody: Record<string, unknown> = {};
      try {
        if (bodyRaw) parsedBody = JSON.parse(bodyRaw) as Record<string, unknown>;
      } catch {
        parsedBody = {};
      }

      res.setHeader('Content-Type', 'application/json');

      if (url.pathname === '/devices' && req.method === 'GET') {
        res.end(
          JSON.stringify({
            code: 'SUCCESS',
            message: 'ok',
            results: [
              {
                id: 'dev-1',
                phone_number: '966500000001',
                display_name: 'Main Desk',
                state: 'logged_in',
                created_at: '2026-11-24T00:00:00Z',
              },
            ],
          }),
        );
        return;
      }

      if (/^\/devices\/[^/]+\/status$/.test(url.pathname)) {
        res.end(
          JSON.stringify({
            code: 'SUCCESS',
            message: 'ok',
            results: {device_id: 'dev-1', is_connected: true, is_logged_in: true},
          }),
        );
        return;
      }

      if (url.pathname === '/chats' && req.method === 'GET') {
        const list = [
          {
            jid: jidB,
            name: 'Customer Beta',
            last_message_time: chatBTime,
            ephemeral_expiration: 0,
            created_at: '2026-11-24T00:00:00Z',
            updated_at: chatBTime,
            archived: false,
          },
          {
            jid: jidA,
            name: 'Customer Alpha',
            last_message_time: chatATime,
            ephemeral_expiration: 0,
            created_at: '2026-11-24T00:00:00Z',
            updated_at: chatATime,
            archived: false,
          },
        ];
        res.end(
          JSON.stringify({
            code: 'SUCCESS',
            message: 'ok',
            results: {data: list, pagination: {limit: 100, offset: 0, total: list.length}},
          }),
        );
        return;
      }

      if (/^\/chat\/[^/]+\/(archive|pin)$/.test(url.pathname) && req.method === 'POST') {
        remoteCalls.push({path: url.pathname, body: parsedBody});
        res.end(JSON.stringify({code: 'SUCCESS', message: 'ok', results: {}}));
        return;
      }

      if (/^\/chat\/[^/]+\/messages$/.test(url.pathname) && req.method === 'GET') {
        res.end(
          JSON.stringify({
            code: 'SUCCESS',
            message: 'ok',
            results: {
              data: [
                {
                  id: 'm-old',
                  chat_jid: jidA,
                  sender_jid: jidA,
                  content: 'Before clear',
                  timestamp: '2026-11-24T01:00:00.000Z',
                  is_from_me: false,
                  media_type: '',
                  filename: '',
                  url: '',
                  file_length: 0,
                },
              ],
              pagination: {limit: 40, offset: 0, total: 1},
              chat_info: {
                jid: jidA,
                name: 'Customer Alpha',
                last_message_time: chatATime,
                ephemeral_expiration: 0,
                created_at: '2026-11-24T00:00:00Z',
                updated_at: chatATime,
                archived: false,
              },
            },
          }),
        );
        return;
      }

      if (url.pathname === '/send/message' && req.method === 'POST') {
        res.end(
          JSON.stringify({
            code: 'SUCCESS',
            message: 'ok',
            results: {message_id: 'sent-1', status: 'queued'},
          }),
        );
        return;
      }

      res.end(JSON.stringify({code: 'SUCCESS', message: 'ok', results: {}}));
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
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: String(appPort),
        GOWA_LITE_DB_PATH: dbPath,
        BLOCK_PRIVATE_GOWA_URL: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.stdout?.on('data', (c) => (serverLogs += c.toString()));
    serverProc.stderr?.on('data', (c) => (serverLogs += c.toString()));

    const start = Date.now();
    let healthy = false;
    while (Date.now() - start < 15_000) {
      try {
        const res = await fetch(`${baseUrl}/api/auth/status`);
        if (res.ok) {
          healthy = true;
          break;
        }
      } catch {
        // retry
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

  it('executes archive, pin ordering, mute, unread, favourite, custom lists, block guard, clear, delete, and RBAC checks', async () => {
    const setupRes = await api('/api/auth/setup', {
      method: 'POST',
      body: JSON.stringify({
        display_name: 'Admin Menu',
        username: 'admin',
        password: 'Password123',
        gowa_url: `http://127.0.0.1:${mockGowaPort}`,
      }),
    });
    assert.equal(setupRes.status, 201);
    const adminToken = (setupRes.body?.results as {token: string}).token;

    const rolesRes = await api('/api/roles', {token: adminToken});
    const roles = (rolesRes.body?.results as Array<{id: number; slug: string}>) || [];
    const agentRoleId = roles.find((r) => r.slug === 'agent')!.id;

    await api('/api/users', {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({
        display_name: 'Agent Menu',
        username: 'agent1',
        password: 'Password123',
        role_id: agentRoleId,
        allowed_device_ids: ['dev-1'],
      }),
    });
    const agentToken = (
      (
        await api('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({username: 'agent1', password: 'Password123'}),
        })
      ).body?.results as {token: string}
    ).token;

    // 1. Pin older chatA -> syncs to GOWA and rises above newer chatB
    const pinRes = await api(`/api/unified/chats/dev-1/${encodeURIComponent(jidA)}/pin`, {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({pinned: true}),
    });
    assert.equal(pinRes.status, 200);
    assert.equal((pinRes.body?.results as {synced_remote: boolean}).synced_remote, true);
    assert.ok(remoteCalls.some((c) => c.path.endsWith('/pin') && c.body.pinned === true));

    // 2. Archive chatB -> syncs to GOWA and sets archived=true
    const archRes = await api(`/api/unified/chats/dev-1/${encodeURIComponent(jidB)}/archive`, {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({archived: true}),
    });
    assert.equal(archRes.status, 200);
    assert.equal((archRes.body?.results as {synced_remote: boolean}).synced_remote, true);
    assert.ok(remoteCalls.some((c) => c.path.endsWith('/archive') && c.body.archived === true));

    // 3. Mute, Mark unread, Favourite, Custom Lists for adminToken
    const muteRes = await api(`/api/unified/chats/dev-1/${encodeURIComponent(jidA)}/mute`, {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({duration: '8h'}),
    });
    assert.equal(muteRes.status, 200);
    assert.ok((muteRes.body?.results as {muted_until_ms: number}).muted_until_ms > Date.now());

    const unreadRes = await api(`/api/unified/chats/dev-1/${encodeURIComponent(jidA)}/unread`, {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({unread: true}),
    });
    assert.equal(unreadRes.status, 200);

    const favRes = await api(`/api/unified/chats/dev-1/${encodeURIComponent(jidA)}/favourite`, {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({favourite: true}),
    });
    assert.equal(favRes.status, 200);

    const listCreate = await api('/api/unified/chat-lists', {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({name: 'Priority Leads'}),
    });
    assert.equal(listCreate.status, 201);
    const listId = (listCreate.body?.results as {id: number}).id;

    const listAssign = await api(`/api/unified/chats/dev-1/${encodeURIComponent(jidA)}/lists`, {
      method: 'PUT',
      token: adminToken,
      body: JSON.stringify({list_ids: [listId]}),
    });
    assert.equal(listAssign.status, 200);

    // Verify enriched GET /api/unified/chats reflects pin ordering + states
    const listRes = await api('/api/unified/chats', {token: adminToken});
    assert.equal(listRes.status, 200);
    const listBody = listRes.body?.results as {
      data: Array<{
        jid: string;
        is_pinned: boolean;
        archived: boolean;
        is_favourite: boolean;
        muted_until_ms: number;
        unread_count: number;
        list_ids: number[];
      }>;
      muted_keys: string[];
      chat_lists: Array<{id: number; name: string; chat_count: number}>;
    };
    assert.equal(listBody.data[0].jid, jidA);
    assert.equal(listBody.data[0].is_pinned, true);
    assert.equal(listBody.data[0].is_favourite, true);
    assert.ok(listBody.data[0].muted_until_ms > Date.now());
    assert.equal(listBody.data[0].unread_count, 1);
    assert.deepEqual(listBody.data[0].list_ids, [listId]);
    assert.equal(listBody.data[1].jid, jidB);
    assert.equal(listBody.data[1].archived, true);
    assert.deepEqual(listBody.muted_keys, [`dev-1::${jidA}`]);
    assert.equal(listBody.chat_lists[0]?.name, 'Priority Leads');

    // 4. Block chatA -> sending returns 403 CHAT_BLOCKED; unblock -> send succeeds
    const blockRes = await api(`/api/unified/chats/dev-1/${encodeURIComponent(jidA)}/block`, {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({blocked: true}),
    });
    assert.equal(blockRes.status, 200);

    const sendWhileBlocked = await api(`/api/unified/chats/dev-1/${encodeURIComponent(jidA)}/send`, {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({message: 'Hello blocked'}),
    });
    assert.equal(sendWhileBlocked.status, 403);
    assert.equal(sendWhileBlocked.body?.code, 'CHAT_BLOCKED');

    const unblockRes = await api(`/api/unified/chats/dev-1/${encodeURIComponent(jidA)}/block`, {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({blocked: false}),
    });
    assert.equal(unblockRes.status, 200);

    const sendAfterUnblock = await api(`/api/unified/chats/dev-1/${encodeURIComponent(jidA)}/send`, {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({message: 'Hello unblocked'}),
    });
    assert.equal(sendAfterUnblock.status, 200);

    // 5. RBAC: standard agent lacks chats:revoke -> clear & delete return 403
    const agentClearRes = await api(`/api/unified/chats/dev-1/${encodeURIComponent(jidA)}/clear`, {
      method: 'POST',
      token: agentToken,
    });
    assert.equal(agentClearRes.status, 403);

    const agentDeleteRes = await api(`/api/unified/chats/dev-1/${encodeURIComponent(jidA)}/delete`, {
      method: 'POST',
      token: agentToken,
    });
    assert.equal(agentDeleteRes.status, 403);

    // 6. Admin clears chatA -> old cached/live message prior to clear is hidden
    const clearRes = await api(`/api/unified/chats/dev-1/${encodeURIComponent(jidA)}/clear`, {
      method: 'POST',
      token: adminToken,
    });
    assert.equal(clearRes.status, 200);

    const msgsAfterClear = await api(`/api/unified/chats/dev-1/${encodeURIComponent(jidA)}/messages`, {
      token: adminToken,
    });
    assert.equal(msgsAfterClear.status, 200);
    assert.equal((msgsAfterClear.body?.results as {data: unknown[]}).data.length, 0);

    // 7. Admin deletes chatA -> hidden from GET /api/unified/chats until newer message arrives
    const deleteRes = await api(`/api/unified/chats/dev-1/${encodeURIComponent(jidA)}/delete`, {
      method: 'POST',
      token: adminToken,
    });
    assert.equal(deleteRes.status, 200);

    const afterDeleteChats = await api('/api/unified/chats', {token: adminToken});
    const afterDeleteData = (afterDeleteChats.body?.results as {data: Array<{jid: string}>}).data;
    assert.equal(afterDeleteData.some((c) => c.jid === jidA), false);

    // Simulate newer incoming message timestamp -> chatA resurfaces
    chatATime = new Date(Date.now() + 120_000).toISOString();
    const afterNewMsgChats = await api('/api/unified/chats', {token: adminToken});
    const afterNewMsgData = (afterNewMsgChats.body?.results as {data: Array<{jid: string}>}).data;
    assert.equal(afterNewMsgData.some((c) => c.jid === jidA), true);
  });
});
