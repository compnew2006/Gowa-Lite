import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, it} from 'node:test';
import type {AccountSummary, UnifiedChat} from '../src/api/types.ts';

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

describe('Server-Side Chat Content Redaction (Unit)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gowa-lite-blur-unit-'));
  const unitDbPath = path.join(tmpDir, 'unit.db');

  let dbMod: typeof import('../server/db.ts');
  let lifecycleMod: typeof import('../server/services/chat-lifecycle.ts');
  let wsMod: typeof import('../server/ws-bridge.ts');

  before(async () => {
    process.env.GOWA_LITE_DB_PATH = unitDbPath;
    dbMod = await import('../server/db.ts');
    lifecycleMod = await import('../server/services/chat-lifecycle.ts');
    wsMod = await import('../server/ws-bridge.ts');
  });

  after(() => {
    dbMod?.closeDatabaseSafely();
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  it('redacts WS message and lifecycle payloads for pending, assigned_other, and closed chats while keeping supervisor & owner intact', () => {
    const roles = dbMod.listRoles();
    const agentRole = roles.find((r) => r.slug === 'agent')!;
    const managerRole = roles.find((r) => r.slug === 'manager')!;

    const agentA = dbMod.createUser({
      username: 'blur_agent_a',
      display_name: 'Blur Agent A',
      role: 'agent',
      role_id: agentRole.id,
      allowed_device_ids: ['dev-1'],
      password: 'Password123',
    });
    const agentB = dbMod.createUser({
      username: 'blur_agent_b',
      display_name: 'Blur Agent B',
      role: 'agent',
      role_id: agentRole.id,
      allowed_device_ids: ['dev-1'],
      password: 'Password123',
    });
    const supervisor = dbMod.createUser({
      username: 'blur_sup',
      display_name: 'Blur Supervisor',
      role: 'agent',
      role_id: managerRole.id,
      allowed_device_ids: [],
      password: 'Password123',
    });

    const jid = '966509998888@s.whatsapp.net';

    assert.equal(lifecycleMod.isLifecycleApplicableJid(jid), true);
    assert.equal(lifecycleMod.isLifecycleApplicableJid('status@broadcast'), false);
    assert.equal(lifecycleMod.isLifecycleApplicableJid('120363000001@newsletter'), false);

    // 1. Pending state -> agentA redacted, supervisor full access
    const pendingStateAgent = lifecycleMod.getChatContentAccessState(agentA, 'dev-1', jid);
    assert.equal(pendingStateAgent.allowed, false);
    assert.equal(pendingStateAgent.reason, 'pending');

    const pendingStateSup = lifecycleMod.getChatContentAccessState(supervisor, 'dev-1', jid);
    assert.equal(pendingStateSup.allowed, true);

    const rawWsMessage = {
      code: 'MESSAGE_RECEIVED',
      message: 'ok',
      device_id: 'dev-1',
      result: {
        id: 'ws-msg-1',
        chat_jid: jid,
        sender_jid: jid,
        sender_display_name: 'Noura Client',
        content: 'Confidential OTP 774422',
        caption: 'Secret caption',
        media_type: 'image',
        filename: 'secret-invoice.png',
        url: 'https://cdn.example/secret-invoice.png',
        file_length: 4096,
        context_metadata: JSON.stringify({replied_to_id: 'old-msg'}),
        reactions: [{emoji: '👍', sender_jid: jid, is_from_me: false, timestamp: '2026-11-24T01:00:00Z'}],
        timestamp: '2026-11-24T01:00:00Z',
        is_from_me: false,
      },
    };

    const wsPendingAgent = wsMod.shouldDeliverWsEventToUser(agentA, rawWsMessage);
    assert.equal(wsPendingAgent.allowed, true);
    const filteredPending = wsPendingAgent.filteredPayload as {result: Record<string, unknown>};
    assert.ok(filteredPending?.result);
    assert.equal(filteredPending.result.content_redacted, true);
    assert.equal(filteredPending.result.redaction_reason, 'pending');
    assert.equal(filteredPending.result.content, '');
    assert.equal(filteredPending.result.caption, '');
    assert.equal(filteredPending.result.media_type, '');
    assert.equal(filteredPending.result.filename, '');
    assert.equal(filteredPending.result.url, '');
    assert.equal(filteredPending.result.context_metadata, '');
    assert.deepEqual(filteredPending.result.reactions, []);
    assert.equal(filteredPending.result.id, 'ws-msg-1');
    assert.equal(filteredPending.result.chat_jid, jid);
    assert.equal(filteredPending.result.sender_display_name, 'Noura Client');

    const {chat_jid: remoteJid, ...alternateResult} = rawWsMessage.result;
    const alternate = wsMod.shouldDeliverWsEventToUser(agentA, {
      ...rawWsMessage, result: {...alternateResult, remote_jid: remoteJid},
    });
    assert.equal((alternate.filteredPayload as typeof filteredPending)?.result.content, '');
    assert.equal(wsMod.shouldDeliverWsEventToUser(agentA, {...rawWsMessage, result: alternateResult}).allowed, false);

    // Original payload must NOT be mutated
    assert.equal(rawWsMessage.result.content, 'Confidential OTP 774422');

    // Supervisor receives unredacted WS payload
    const wsPendingSup = wsMod.shouldDeliverWsEventToUser(supervisor, rawWsMessage);
    assert.equal(wsPendingSup.allowed, true);
    assert.equal(wsPendingSup.filteredPayload, undefined);

    // 2. Claimed by agentA -> agentA unredacted, agentB redacted with 'assigned_other'
    lifecycleMod.claimChat(agentA, 'dev-1', jid, {cachedTitle: 'Noura Client'});
    const wsOwnerOpen = wsMod.shouldDeliverWsEventToUser(agentA, rawWsMessage);
    assert.equal(wsOwnerOpen.allowed, true);
    assert.equal(wsOwnerOpen.filteredPayload, undefined);

    const wsOtherAgent = wsMod.shouldDeliverWsEventToUser(agentB, rawWsMessage);
    assert.equal(wsOtherAgent.allowed, true);
    const filteredOther = wsOtherAgent.filteredPayload as {result: Record<string, unknown>};
    assert.equal(filteredOther.result.content_redacted, true);
    assert.equal(filteredOther.result.redaction_reason, 'assigned_other');
    assert.equal(filteredOther.result.content, '');

    // 3. Closed -> agentA redacted with 'closed', lifecycle event note stripped
    lifecycleMod.closeChat(agentA, 'dev-1', jid, {reason: 'Secret internal close note'});
    const wsClosedAgent = wsMod.shouldDeliverWsEventToUser(agentA, rawWsMessage);
    assert.equal(wsClosedAgent.allowed, true);
    const filteredClosed = wsClosedAgent.filteredPayload as {result: Record<string, unknown>};
    assert.equal(filteredClosed.result.content_redacted, true);
    assert.equal(filteredClosed.result.redaction_reason, 'closed');
    assert.equal(filteredClosed.result.content, '');

    const lifecyclePayload = {
      code: 'CHAT_LIFECYCLE_UPDATED',
      device_id: 'dev-1',
      result: {
        device_id: 'dev-1',
        chat_jid: jid,
        assignment: lifecycleMod.getChatLifecycleState('dev-1', jid),
        event: {
          id: 99,
          device_id: 'dev-1',
          chat_jid: jid,
          event_type: 'closed',
          note: 'Private supervisor escalation note',
          created_at: new Date().toISOString(),
        },
      },
    };
    const wsLifecycleAgent = wsMod.shouldDeliverWsEventToUser(agentB, lifecyclePayload);
    assert.equal(wsLifecycleAgent.allowed, true);
    const filteredLifecycle = wsLifecycleAgent.filteredPayload as {
      result: {event: {note: string}; assignment: {status: string}};
    };
    assert.equal(filteredLifecycle.result.event.note, '');
    assert.equal(filteredLifecycle.result.assignment.status, 'closed');
    assert.equal(lifecyclePayload.result.event.note, 'Private supervisor escalation note');
  });

  it('retains selected chat across tab refetches after claim or reopen until explicitly cleared', async () => {
    const {resolveSelectedUnifiedChat} = await import('../src/features/chat/selected-chat.ts');
    const accounts: AccountSummary[] = [
      {
        id: 'dev-alpha',
        display_name: 'Sales Line',
        phone_number: '966500000001',
        state: 'logged_in',
      },
    ];
    const pendingChat: UnifiedChat = {
      jid: '966555000111@s.whatsapp.net',
      name: 'Customer A',
      last_message_time: '2026-11-24T10:00:00Z',
      ephemeral_expiration: 0,
      created_at: '2026-11-24T09:00:00Z',
      updated_at: '2026-11-24T10:00:00Z',
      archived: false,
      device_id: 'dev-alpha',
      device_display_name: 'Sales Line',
      device_state: 'logged_in',
      unread_count: 1,
      lifecycle: {
        status: 'pending',
        assigned_user_id: null,
        assigned_user_name: null,
        closed_by_id: null,
        closed_by_name: null,
        closed_at: null,
        close_reason: '',
      },
    };

    const key = 'dev-alpha::966555000111@s.whatsapp.net';
    const otherAccountChat = {...pendingChat, device_id: 'dev-beta', device_display_name: 'Support Line'};
    const initial = resolveSelectedUnifiedChat({
      selectedKey: key,
      chats: [otherAccountChat, pendingChat],
      retainedChat: pendingChat,
      adHocChat: null,
      accounts,
    });
    assert.equal(initial, pendingChat);

    // A refetch can remove the selected row while the same contact stays visible on another account.
    const afterRefetch = resolveSelectedUnifiedChat({
      selectedKey: key,
      chats: [otherAccountChat],
      retainedChat: pendingChat,
      adHocChat: null,
      accounts: [{...accounts[0], state: 'disconnected'}],
    });
    assert.ok(afterRefetch, 'Selected chat must remain mounted after list refetch removes it');
    assert.equal(afterRefetch.jid, pendingChat.jid);
    assert.equal(afterRefetch.device_state, 'disconnected');
    assert.equal(afterRefetch.device_id, pendingChat.device_id);

    const cleared = resolveSelectedUnifiedChat({
      selectedKey: null,
      chats: [pendingChat],
      retainedChat: null,
      adHocChat: null,
      accounts,
    });
    assert.equal(cleared, null);
  });

  it('triggers scroll to bottom as soon as chat is unredacted/claimed and preserves scroll anchor when loading older pages', async () => {
    const {
      computeTimelineScrollAction,
      isNearBottom,
      scrollContainerToBottom,
    } = await import('../src/features/chat/scroll-behavior.ts');

    // Never consume initial scroll while chat content is still redacted/blurred
    assert.equal(
      computeTimelineScrollAction({
        hasElement: true,
        itemCount: 5,
        isContentRedacted: true,
        initialScrolled: false,
        prevAnchor: null,
        stickToBottom: true,
      }),
      'none',
    );

    // Once claimed/reopened and unredacted, immediately scroll to very bottom
    assert.equal(
      computeTimelineScrollAction({
        hasElement: true,
        itemCount: 12,
        isContentRedacted: false,
        initialScrolled: false,
        prevAnchor: null,
        stickToBottom: false,
      }),
      'scroll_bottom',
    );

    // Loading older messages above preserves scroll anchor instead of snapping to bottom
    assert.equal(
      computeTimelineScrollAction({
        hasElement: true,
        itemCount: 40,
        isContentRedacted: false,
        initialScrolled: true,
        prevAnchor: {scrollHeight: 1200, scrollTop: 80},
        stickToBottom: false,
      }),
      'preserve_anchor',
    );

    // When sticky at bottom (including media resize after claim), snaps scrollTop to scrollHeight
    const el = {scrollTop: 120, scrollHeight: 2400, clientHeight: 600};
    assert.equal(isNearBottom(el), false);
    scrollContainerToBottom(el);
    assert.equal(el.scrollTop, 2400);
    assert.equal(isNearBottom({scrollTop: 1800, scrollHeight: 2400, clientHeight: 600}), true);
  });
});

describe('Server-Side Chat Content Redaction (HTTP & WS Integration)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gowa-lite-blur-int-'));
  const dbPath = path.join(tmpDir, 'int.db');

  let mockGowaServer: http.Server;
  let mockGowaPort = 0;
  let appPort = 0;
  let baseUrl = '';
  let serverProc: ReturnType<typeof spawn> | undefined;
  let serverLogs = '';

  const secretText = 'SECRET_CONTRACT_998811';
  const secretNote = 'INTERNAL_AGENT_NOTE_XYZ';
  const secretSchedule = 'FOLLOW_UP_SECRET_SCHEDULE';
  const secretFilename = 'confidential-quote.pdf';
  const targetJid = '966507771111@s.whatsapp.net';
  const mockAvatarBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
  const mockMediaBytes = Buffer.from('CONFIDENTIAL_PDF_BYTES');
  const seenGowaMessageQueries: Array<string> = [];

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
    return {status: res.status, headers: res.headers, text, body: json};
  }

  before(async () => {
    mockGowaServer = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');

      if (url.pathname === '/avatar-image.png') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'image/png');
        res.end(mockAvatarBytes);
        return;
      }

      if (url.pathname === '/media/confidential-quote.pdf') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/pdf');
        res.end(mockMediaBytes);
        return;
      }

      res.setHeader('Content-Type', 'application/json');

      if (url.pathname === '/devices' && req.method === 'GET') {
        res.end(
          JSON.stringify({
            code: 'SUCCESS',
            message: 'ok',
            results: [
              {
                id: 'dev-alpha',
                phone_number: '966500000001',
                display_name: 'Alpha Line',
                state: 'logged_in',
                created_at: '2026-11-24T00:00:00Z',
              },
            ],
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

      if (url.pathname === '/chats' && req.method === 'GET') {
        const list = [
          {
            jid: targetJid,
            name: 'Vip Prospect',
            last_message_time: '2026-11-24T02:00:00Z',
            ephemeral_expiration: 0,
            created_at: '2026-11-24T00:00:00Z',
            updated_at: '2026-11-24T02:00:00Z',
            archived: false,
          },
        ];
        res.end(
          JSON.stringify({
            code: 'SUCCESS',
            message: 'ok',
            results: {data: list, pagination: {limit: 50, offset: 0, total: list.length}},
          }),
        );
        return;
      }

      if (url.pathname === '/user/avatar' && req.method === 'GET') {
        res.end(
          JSON.stringify({
            code: 'SUCCESS',
            message: 'ok',
            results: {
              url: `http://127.0.0.1:${mockGowaPort}/avatar-image.png`,
              id: 'av-1',
              type: 'preview',
            },
          }),
        );
        return;
      }

      if (/^\/chat\/[^/]+\/messages$/.test(url.pathname) && req.method === 'GET') {
        seenGowaMessageQueries.push(url.search);
        res.end(
          JSON.stringify({
            code: 'SUCCESS',
            message: 'ok',
            results: {
              data: [
                {
                  id: 'm-secret-1',
                  chat_jid: targetJid,
                  sender_jid: targetJid,
                  sender_display_name: 'Vip Prospect',
                  content: secretText,
                  timestamp: '2026-11-24T02:00:00Z',
                  is_from_me: false,
                  media_type: 'document',
                  filename: secretFilename,
                  url: `http://127.0.0.1:${mockGowaPort}/media/confidential-quote.pdf`,
                  file_length: mockMediaBytes.byteLength,
                },
              ],
              pagination: {limit: 40, offset: 0, total: 1},
              chat_info: {
                jid: targetJid,
                name: 'Vip Prospect',
                last_message_time: '2026-11-24T02:00:00Z',
                ephemeral_expiration: 0,
                created_at: '2026-11-24T00:00:00Z',
                updated_at: '2026-11-24T02:00:00Z',
                archived: false,
              },
            },
          }),
        );
        return;
      }

      if (/^\/message\/[^/]+\/download$/.test(url.pathname) && req.method === 'GET') {
        res.end(
          JSON.stringify({
            code: 'SUCCESS',
            message: 'ok',
            results: {
              message_id: 'm-secret-1',
              media_type: 'document',
              filename: secretFilename,
              file_path: '/media/confidential-quote.pdf',
              file_size: mockMediaBytes.byteLength,
            },
          }),
        );
        return;
      }

      if (url.pathname === '/send/schedules' && req.method === 'GET') {
        res.end(
          JSON.stringify({
            code: 'SUCCESS',
            message: 'ok',
            results: {
              data: [
                {
                  id: 'sched-1',
                  recipient: targetJid,
                  message: secretSchedule,
                  status: 'active',
                  scheduled_at: '2026-11-25T10:00:00Z',
                },
              ],
              pagination: {limit: 100, offset: 0, total: 1},
            },
          }),
        );
        return;
      }

      res.end(JSON.stringify({code: 'SUCCESS', message: 'ok', results: {}}));
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
        BLOCK_PRIVATE_GOWA_URL: 'false',
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

  it('withholds content on pending, assigned_other, and closed chats via HTTP & WS while allowing name/number/avatar and supervisor access', async () => {
    // Setup admin + agents + manager
    const setupRes = await api('/api/auth/setup', {
      method: 'POST',
      body: JSON.stringify({
        display_name: 'Admin Blur',
        username: 'admin',
        password: 'Password123',
        gowa_url: `http://127.0.0.1:${mockGowaPort}`,
      }),
    });
    assert.equal(setupRes.status, 201);
    const adminToken = (setupRes.body?.results as {token: string}).token;

    const rolesRes = await api('/api/roles', {token: adminToken});
    const roles = (rolesRes.body?.results as Array<{id: number; slug: string; permissions?: string[]}>) || [];
    const agentRole = roles.find((r) => r.slug === 'agent')!;
    const agentRoleId = agentRole.id;
    const managerRoleId = roles.find((r) => r.slug === 'manager')!.id;

    const customAgentRoleRes = await api('/api/roles', {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({
        name: 'Senior Agent No ViewAll',
        description: 'Agent with revoke without view_all',
        permissions: [
          'chats:read',
          'chats:write',
          'chats:revoke',
          'chats:assign',
          'chats:close',
          'notes:read',
          'notes:write',
          'schedules:read',
          'schedules:write',
          'schedules:manage',
        ],
      }),
    });
    assert.equal(customAgentRoleRes.status, 201);
    const customAgentRoleId = (customAgentRoleRes.body?.results as {id: number}).id;

    await api('/api/users', {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({
        display_name: 'Sara Agent',
        username: 'sara',
        password: 'Password123',
        role_id: customAgentRoleId,
        allowed_device_ids: ['dev-alpha'],
      }),
    });
    await api('/api/users', {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({
        display_name: 'Omar Agent',
        username: 'omar',
        password: 'Password123',
        role_id: agentRoleId,
        allowed_device_ids: ['dev-alpha'],
      }),
    });
    await api('/api/users', {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({
        display_name: 'Lina Manager',
        username: 'lina',
        password: 'Password123',
        role_id: managerRoleId,
        allowed_device_ids: [],
      }),
    });

    const saraToken = (
      (
        await api('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({username: 'sara', password: 'Password123'}),
        })
      ).body?.results as {token: string}
    ).token;

    const omarToken = (
      (
        await api('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({username: 'omar', password: 'Password123'}),
        })
      ).body?.results as {token: string}
    ).token;

    const linaToken = (
      (
        await api('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({username: 'lina', password: 'Password123'}),
        })
      ).body?.results as {token: string}
    ).token;

    // Admin adds a secret internal note while chat is still unclaimed/open via admin claim->note->release
    await api(`/api/unified/chats/dev-alpha/${encodeURIComponent(targetJid)}/claim`, {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({}),
    });
    const noteRes = await api(`/api/unified/chats/dev-alpha/${encodeURIComponent(targetJid)}/notes`, {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({content: secretNote, is_pinned: true}),
    });
    assert.equal(noteRes.status, 201);
    await api(`/api/unified/chats/dev-alpha/${encodeURIComponent(targetJid)}/release`, {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({note: 'Private release handoff note'}),
    });

    // 1. Unified chats list still returns name + jid for pending chat, with no secret text
    const chatsRes = await api('/api/unified/chats?tab=pending', {token: saraToken});
    assert.equal(chatsRes.status, 200);
    assert.equal(chatsRes.text.includes(secretText), false);
    const chatList = (chatsRes.body?.results as {data: Array<{jid: string; name: string}>}).data;
    assert.ok(chatList.some((c) => c.jid === targetJid && c.name === 'Vip Prospect'));

    // 2. Sara CAN reach avatar endpoint on pending chat (never 403 CHAT_CONTENT_REDACTED; 204 when mock localhost CDN is filtered by SSRF check)
    const avatarRes = await fetch(
      `${baseUrl}/api/unified/avatar?deviceId=dev-alpha&jid=${encodeURIComponent(targetJid)}`,
      {headers: {Authorization: `Bearer ${saraToken}`}},
    );
    assert.ok(avatarRes.status === 200 || avatarRes.status === 204, `Unexpected avatar status: ${avatarRes.status}`);

    // 3. Pending chat messages for Sara -> 200 with content_redacted: true, data: [], zero leaks
    seenGowaMessageQueries.length = 0;
    const saraPendingMsgs = await api(
      `/api/unified/chats/dev-alpha/${encodeURIComponent(targetJid)}/messages?search=${encodeURIComponent(secretText)}&media_only=true`,
      {token: saraToken},
    );
    assert.equal(saraPendingMsgs.status, 200);
    assert.equal(saraPendingMsgs.text.includes(secretText), false);
    assert.equal(saraPendingMsgs.text.includes(secretFilename), false);
    const pendingResults = saraPendingMsgs.body?.results as {
      content_redacted?: boolean;
      redaction_reason?: string;
      data: unknown[];
      pagination: {total: number};
      chat_info: {jid: string; name: string};
    };
    assert.equal(pendingResults.content_redacted, true);
    assert.equal(pendingResults.redaction_reason, 'pending');
    assert.equal(pendingResults.data.length, 0);
    assert.equal(pendingResults.pagination.total, 0);
    assert.equal(pendingResults.chat_info.jid, targetJid);
    assert.equal(pendingResults.chat_info.name, 'Vip Prospect');
    // Search & media_only must not be leaked to upstream as an oracle
    for (const q of seenGowaMessageQueries) {
      assert.equal(q.includes('search='), false);
      assert.equal(q.includes('media_only='), false);
    }

    // 4. Notes & Schedules return 200 redacted empty payload
    const saraPendingNotes = await api(
      `/api/unified/chats/dev-alpha/${encodeURIComponent(targetJid)}/notes`,
      {token: saraToken},
    );
    assert.equal(saraPendingNotes.status, 200);
    assert.equal(saraPendingNotes.text.includes(secretNote), false);
    assert.equal((saraPendingNotes.body?.results as {content_redacted?: boolean}).content_redacted, true);
    assert.equal((saraPendingNotes.body?.results as {notes: unknown[]}).notes.length, 0);

    const saraPendingSchedules = await api(
      `/api/unified/chats/dev-alpha/${encodeURIComponent(targetJid)}/schedules`,
      {token: saraToken},
    );
    assert.equal(saraPendingSchedules.status, 200);
    assert.equal(saraPendingSchedules.text.includes(secretSchedule), false);
    assert.equal((saraPendingSchedules.body?.results as {content_redacted?: boolean}).content_redacted, true);
    assert.equal((saraPendingSchedules.body?.results as {data: unknown[]}).data.length, 0);

    // Lifecycle event note is also stripped when chat is redacted
    const saraLifecycle = await api(
      `/api/unified/chats/dev-alpha/${encodeURIComponent(targetJid)}/lifecycle`,
      {token: saraToken},
    );
    assert.equal(saraLifecycle.status, 200);
    assert.equal(saraLifecycle.text.includes('Private release handoff note'), false);

    // 5. Read route does NOT clear unread state while redacted
    const saraReadRes = await api(
      `/api/unified/chats/dev-alpha/${encodeURIComponent(targetJid)}/read`,
      {method: 'POST', token: saraToken},
    );
    assert.equal(saraReadRes.status, 200);
    assert.equal((saraReadRes.body?.results as {content_redacted?: boolean}).content_redacted, true);

    // 6. Content-accessing endpoints reject with 403 CHAT_CONTENT_REDACTED on pending chat
    const blockedHistory = await api(
      `/api/unified/chats/dev-alpha/${encodeURIComponent(targetJid)}/history`,
      {method: 'POST', token: saraToken, body: JSON.stringify({count: 20})},
    );
    assert.equal(blockedHistory.status, 403);
    assert.equal(blockedHistory.body?.code, 'CHAT_CONTENT_REDACTED');

    const blockedReaction = await api(
      `/api/unified/chats/dev-alpha/${encodeURIComponent(targetJid)}/messages/m-secret-1/reaction`,
      {method: 'POST', token: saraToken, body: JSON.stringify({emoji: '👍'})},
    );
    assert.equal(blockedReaction.status, 403);
    assert.equal(blockedReaction.body?.code, 'CHAT_CONTENT_REDACTED');

    const blockedRevoke = await api(
      `/api/unified/chats/dev-alpha/${encodeURIComponent(targetJid)}/messages/m-secret-1/revoke`,
      {method: 'POST', token: saraToken},
    );
    assert.equal(blockedRevoke.status, 403);
    assert.equal(blockedRevoke.body?.code, 'CHAT_CONTENT_REDACTED');

    const blockedForward = await api(
      `/api/unified/chats/dev-alpha/${encodeURIComponent(targetJid)}/messages/m-secret-1/forward`,
      {
        method: 'POST',
        token: saraToken,
        body: JSON.stringify({target_device_id: 'dev-alpha', target_jid: '966501234567@s.whatsapp.net'}),
      },
    );
    assert.equal(blockedForward.status, 403);
    assert.equal(blockedForward.body?.code, 'CHAT_CONTENT_REDACTED');

    const blockedNoteCreate = await api(
      `/api/unified/chats/dev-alpha/${encodeURIComponent(targetJid)}/notes`,
      {method: 'POST', token: saraToken, body: JSON.stringify({content: 'hijack note'})},
    );
    assert.equal(blockedNoteCreate.status, 403);
    assert.equal(blockedNoteCreate.body?.code, 'CHAT_CONTENT_REDACTED');

    const blockedSchedCreate = await api(
      `/api/unified/chats/dev-alpha/${encodeURIComponent(targetJid)}/schedules`,
      {
        method: 'POST',
        token: saraToken,
        body: JSON.stringify({
          message: 'hi',
          scheduled_at: new Date(Date.now() + 3600_000).toISOString(),
        }),
      },
    );
    assert.equal(blockedSchedCreate.status, 403);
    assert.equal(blockedSchedCreate.body?.code, 'CHAT_CONTENT_REDACTED');

    const blockedMediaDl = await api(
      `/api/unified/media/download?deviceId=dev-alpha&messageId=m-secret-1&phone=${encodeURIComponent(targetJid)}`,
      {token: saraToken},
    );
    assert.equal(blockedMediaDl.status, 403);
    assert.equal(blockedMediaDl.body?.code, 'CHAT_CONTENT_REDACTED');

    const blockedMediaFile = await api(
      `/api/unified/media/file?deviceId=dev-alpha&path=${encodeURIComponent('/media/confidential-quote.pdf')}&chatJid=${encodeURIComponent(targetJid)}`,
      {token: saraToken},
    );
    assert.equal(blockedMediaFile.status, 403);
    assert.equal(blockedMediaFile.body?.code, 'CHAT_CONTENT_REDACTED');

    // 7. Supervisor (Lina) CAN read everything while pending
    const linaPendingMsgs = await api(
      `/api/unified/chats/dev-alpha/${encodeURIComponent(targetJid)}/messages`,
      {token: linaToken},
    );
    assert.equal(linaPendingMsgs.status, 200);
    assert.equal(linaPendingMsgs.text.includes(secretText), true);
    assert.equal((linaPendingMsgs.body?.results as {content_redacted?: boolean}).content_redacted, undefined);

    const linaPendingNotes = await api(
      `/api/unified/chats/dev-alpha/${encodeURIComponent(targetJid)}/notes`,
      {token: linaToken},
    );
    assert.equal(linaPendingNotes.status, 200);
    assert.equal(linaPendingNotes.text.includes(secretNote), true);

    // 8. Sara claims chat -> Sara sees full messages/notes/schedules/media; Omar sees redacted 'assigned_other'
    const claimRes = await api(
      `/api/unified/chats/dev-alpha/${encodeURIComponent(targetJid)}/claim`,
      {method: 'POST', token: saraToken, body: JSON.stringify({})},
    );
    assert.equal(claimRes.status, 200);

    const saraOpenMsgs = await api(
      `/api/unified/chats/dev-alpha/${encodeURIComponent(targetJid)}/messages`,
      {token: saraToken},
    );
    assert.equal(saraOpenMsgs.status, 200);
    assert.equal(saraOpenMsgs.text.includes(secretText), true);
    assert.equal((saraOpenMsgs.body?.results as {content_redacted?: boolean}).content_redacted, undefined);

    const openMediaLink = await api(
      `/api/unified/media/download?deviceId=dev-alpha&messageId=m-secret-1&phone=${encodeURIComponent(targetJid)}`,
      {token: saraToken},
    );
    assert.equal(openMediaLink.status, 200);
    const proxyUrl = (openMediaLink.body?.results as {proxy_url: string}).proxy_url;
    const saraOpenMedia = await api(proxyUrl, {token: saraToken});
    assert.equal(saraOpenMedia.status, 200);

    const omarOtherMsgs = await api(
      `/api/unified/chats/dev-alpha/${encodeURIComponent(targetJid)}/messages`,
      {token: omarToken},
    );
    assert.equal(omarOtherMsgs.status, 200);
    assert.equal(omarOtherMsgs.text.includes(secretText), false);
    assert.equal((omarOtherMsgs.body?.results as {redaction_reason?: string}).redaction_reason, 'assigned_other');

    // 9. Sara closes chat -> now even Sara is redacted with 'closed', while Lina still sees content
    const closeRes = await api(
      `/api/unified/chats/dev-alpha/${encodeURIComponent(targetJid)}/close`,
      {method: 'POST', token: saraToken, body: JSON.stringify({reason: 'Done'})},
    );
    assert.equal(closeRes.status, 200);

    const saraClosedMsgs = await api(
      `/api/unified/chats/dev-alpha/${encodeURIComponent(targetJid)}/messages`,
      {token: saraToken},
    );
    assert.equal(saraClosedMsgs.status, 200);
    assert.equal(saraClosedMsgs.text.includes(secretText), false);
    assert.equal((saraClosedMsgs.body?.results as {content_redacted?: boolean}).content_redacted, true);
    assert.equal((saraClosedMsgs.body?.results as {redaction_reason?: string}).redaction_reason, 'closed');

    const saraClosedNotes = await api(
      `/api/unified/chats/dev-alpha/${encodeURIComponent(targetJid)}/notes`,
      {token: saraToken},
    );
    assert.equal(saraClosedNotes.status, 200);
    assert.equal(saraClosedNotes.text.includes(secretNote), false);

    const saraClosedMedia = await api(proxyUrl, {token: saraToken});
    assert.equal(saraClosedMedia.status, 403);
    assert.equal(saraClosedMedia.body?.code, 'CHAT_CONTENT_REDACTED');

    const linaClosedMsgs = await api(
      `/api/unified/chats/dev-alpha/${encodeURIComponent(targetJid)}/messages`,
      {token: linaToken},
    );
    assert.equal(linaClosedMsgs.status, 200);
    assert.equal(linaClosedMsgs.text.includes(secretText), true);

    // 10. Another regular agent (Omar) CAN list tab=closed, sees Sara's closed chat (still redacted!), and CAN reopen+claim it
    const omarClosedTab = await api('/api/unified/chats?tab=closed', {token: omarToken});
    assert.equal(omarClosedTab.status, 200);
    const omarClosedResults = omarClosedTab.body?.results as {
      data: Array<{jid: string; name: string}>;
      tab_counts: {closed: number};
    };
    assert.ok(omarClosedResults.tab_counts.closed >= 1);
    assert.ok(omarClosedResults.data.some((c) => c.jid === targetJid));

    const omarClosedMsgs = await api(
      `/api/unified/chats/dev-alpha/${encodeURIComponent(targetJid)}/messages`,
      {token: omarToken},
    );
    assert.equal(omarClosedMsgs.status, 200);
    assert.equal(omarClosedMsgs.text.includes(secretText), false);
    assert.equal((omarClosedMsgs.body?.results as {redaction_reason?: string}).redaction_reason, 'closed');

    const omarReopenRes = await api(
      `/api/unified/chats/dev-alpha/${encodeURIComponent(targetJid)}/reopen`,
      {
        method: 'POST',
        token: omarToken,
        body: JSON.stringify({assign_to_self: true}),
      },
    );
    assert.equal(omarReopenRes.status, 200);

    const omarReopenedMsgs = await api(
      `/api/unified/chats/dev-alpha/${encodeURIComponent(targetJid)}/messages`,
      {token: omarToken},
    );
    assert.equal(omarReopenedMsgs.status, 200);
    assert.equal(omarReopenedMsgs.text.includes(secretText), true);
    assert.equal((omarReopenedMsgs.body?.results as {content_redacted?: boolean}).content_redacted, undefined);

    const saraAfterOmarReopen = await api(
      `/api/unified/chats/dev-alpha/${encodeURIComponent(targetJid)}/messages`,
      {token: saraToken},
    );
    assert.equal(saraAfterOmarReopen.status, 200);
    assert.equal(saraAfterOmarReopen.text.includes(secretText), false);
    assert.equal(
      (saraAfterOmarReopen.body?.results as {redaction_reason?: string}).redaction_reason,
      'assigned_other',
    );
  });
});
