import './schedule-account-line-dom.ts';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {after, afterEach, before, describe, it} from 'node:test';
import React, {act, createElement as el} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import type {MessageInfo} from '../src/api/types.ts';
import {MessageBubble} from '../src/features/chat/message-bubble.tsx';
import {
  ALL_PERMISSION_KEYS,
  PERMISSION_SET,
  SYSTEM_ROLE_DEFINITIONS,
} from '../server/rbac.ts';

/**
 * Phase 3 Path B (P1-4, decision 3): split the message-revoke permission
 * off `chats:revoke`.
 *
 * - New key `chats:revoke_own` lets an agent revoke only their own messages.
 * - `chats:revoke` keeps guarding chat-history clear and chat delete.
 * - The revoke route enforces ownership from the cached message and fails
 *   closed when there is no ownership proof.
 * - The revoke button is governed by the new key + message ownership.
 *
 * Rendered with React 19 + jsdom (no JSX: tsx does not parse JSX in .ts
 * test files). Never compare DOM nodes with assert.equal/deepEqual: on
 * failure Node inspects the nodes into the error message, and
 * React-rendered nodes carry __reactFiber$ trees whose inspection never
 * finishes. Compare with assert.ok(a === b) instead.
 */

describe('Phase 3 Path B — chats:revoke_own permission definition & seed', () => {
  it('defines chats:revoke_own in the chats permission group', () => {
    assert.ok(PERMISSION_SET.has('chats:revoke_own'), 'chats:revoke_own is a known key');
    assert.ok(ALL_PERMISSION_KEYS.includes('chats:revoke_own'));
  });

  it('seeds the agent role with chats:revoke_own but NOT the full chats:revoke', () => {
    const agent = SYSTEM_ROLE_DEFINITIONS.find((def) => def.slug === 'agent')!;
    assert.ok(agent.permissions.includes('chats:revoke_own'), 'agent gets revoke_own');
    assert.ok(
      !agent.permissions.includes('chats:revoke'),
      'agent must NOT get full chats:revoke (it also guards clear/delete)',
    );
  });

  it('keeps full chats:revoke on manager and admin', () => {
    const manager = SYSTEM_ROLE_DEFINITIONS.find((def) => def.slug === 'manager')!;
    assert.ok(manager.permissions.includes('chats:revoke'), 'manager keeps full revoke');
    const admin = SYSTEM_ROLE_DEFINITIONS.find((def) => def.slug === 'admin')!;
    assert.ok(admin.permissions.includes('chats:revoke'));
    assert.ok(admin.permissions.includes('chats:revoke_own'));
  });
});

describe('Phase 3 Path B — revoke button visibility (MessageBubble)', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  const revokeLabel = 'حذف لدى الجميع';

  function messageFixture(overrides: Partial<MessageInfo> = {}): MessageInfo {
    return {
      id: 'm-own-1',
      chat_jid: '966501000001@s.whatsapp.net',
      sender_jid: '966500000001@s.whatsapp.net',
      sender_display_name: 'Main Desk',
      content: 'hello from me',
      timestamp: '2026-11-28T12:00:00.000Z',
      is_from_me: true,
      media_type: '',
      filename: '',
      url: '',
      file_length: 0,
      ...overrides,
    };
  }

  async function renderBubble(props: {
    message?: MessageInfo;
    onRevoke?: (message: MessageInfo) => void;
  }) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        el(MessageBubble, {
          message: props.message ?? messageFixture(),
          quoted: null,
          deviceId: 'dev-1',
          isDeviceReady: true,
          canReactAndReply: true,
          isReactionPickerOpen: false,
          onToggleReactionPicker: () => {},
          onCloseReactionPicker: () => {},
          onReact: () => {},
          onReply: () => {},
          onForward: () => {},
          onRevoke: props.onRevoke,
          onJumpToMessage: () => {},
        }),
      );
    });
  }

  function revokeButton(): Element | null {
    return document.querySelector(`button[aria-label="${revokeLabel}"]`);
  }

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container?.remove();
    container = null;
  });

  it('shows the revoke button for an own message when onRevoke is provided', async () => {
    await renderBubble({onRevoke: () => {}});
    assert.ok(revokeButton() !== null, 'revoke button visible for own message');
  });

  it('hides the revoke button when onRevoke is not provided (no revoke_own key)', async () => {
    await renderBubble({});
    assert.ok(revokeButton() === null, 'no revoke button without onRevoke');
  });

  it('hides the revoke button for an incoming message even when onRevoke is provided', async () => {
    await renderBubble({
      message: messageFixture({
        id: 'm-other-1',
        sender_jid: '966501000001@s.whatsapp.net',
        is_from_me: false,
      }),
      onRevoke: () => {},
    });
    assert.ok(revokeButton() === null, 'no revoke button for incoming message');
  });

  it('gates the revoke action in message-view on chats:revoke_own (not full chats:revoke)', () => {
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'src/features/chat/message-view.tsx'),
      'utf8',
    );
    assert.ok(
      src.includes('chats:revoke_own'),
      'message-view references the new chats:revoke_own key',
    );
    assert.ok(
      src.includes('onRevoke={canRevokeOwnChats ? handleRevokeRequest : undefined}'),
      'message-view passes onRevoke only when the agent may revoke own messages',
    );
    assert.ok(
      !src.includes('onRevoke={canRevokeChats ? handleRevokeRequest : undefined}'),
      'message-view no longer gates the revoke button on full chats:revoke',
    );
  });
});

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

describe('Phase 3 Path B — revoke route ownership (HTTP Integration)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gowa-lite-revoke-split-'));
  const dbPath = path.join(tmpDir, 'int.db');

  let mockGowaServer: http.Server;
  let mockGowaPort = 0;
  let appPort = 0;
  let baseUrl = '';
  let serverProc: ReturnType<typeof spawn> | undefined;
  let serverLogs = '';

  const jidA = '966501000001@s.whatsapp.net';
  const ownJid = '966500000001@s.whatsapp.net';
  const revokeCalls: Array<{path: string; body: Record<string, unknown>}> = [];

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
        res.end(
          JSON.stringify({
            code: 'SUCCESS',
            message: 'ok',
            results: {
              data: [
                {
                  jid: jidA,
                  name: 'Customer Alpha',
                  last_message_time: '2026-11-28T10:00:00.000Z',
                  ephemeral_expiration: 0,
                  created_at: '2026-11-24T00:00:00Z',
                  updated_at: '2026-11-28T10:00:00.000Z',
                  archived: false,
                },
              ],
              pagination: {limit: 100, offset: 0, total: 1},
            },
          }),
        );
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
                  id: 'm-own',
                  chat_jid: jidA,
                  sender_jid: ownJid,
                  sender_display_name: 'Main Desk',
                  content: 'My own message',
                  timestamp: '2026-11-28T10:00:00.000Z',
                  is_from_me: true,
                  media_type: '',
                  filename: '',
                  url: '',
                  file_length: 0,
                },
                {
                  id: 'm-other',
                  chat_jid: jidA,
                  sender_jid: jidA,
                  sender_display_name: 'Customer Alpha',
                  content: 'Customer message',
                  timestamp: '2026-11-28T10:01:00.000Z',
                  is_from_me: false,
                  media_type: '',
                  filename: '',
                  url: '',
                  file_length: 0,
                },
              ],
              pagination: {limit: 40, offset: 0, total: 2},
              chat_info: {
                jid: jidA,
                name: 'Customer Alpha',
                last_message_time: '2026-11-28T10:01:00.000Z',
                ephemeral_expiration: 0,
                created_at: '2026-11-24T00:00:00Z',
                updated_at: '2026-11-28T10:01:00.000Z',
                archived: false,
              },
            },
          }),
        );
        return;
      }

      if (/^\/message\/[^/]+\/revoke$/.test(url.pathname) && req.method === 'POST') {
        revokeCalls.push({path: url.pathname, body: parsedBody});
        res.end(JSON.stringify({code: 'SUCCESS', message: 'ok', results: {}}));
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
    while (Date.now() - start < 60_000) {
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

  async function createUser(
    adminToken: string,
    username: string,
    roleId: number,
  ): Promise<{id: number; token: string}> {
    const createRes = await api('/api/users', {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({
        display_name: username,
        username,
        password: 'Password123',
        role_id: roleId,
        allowed_device_ids: ['dev-1'],
      }),
    });
    assert.equal(createRes.status, 201, `create user ${username}: ${JSON.stringify(createRes.body)}`);
    const userId = (createRes.body?.results as {id: number}).id;
    const loginRes = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({username, password: 'Password123'}),
    });
    assert.equal(loginRes.status, 200, `login ${username}`);
    const token = (loginRes.body?.results as {token: string}).token;
    assert.ok(token, `token for ${username}`);
    return {id: userId, token};
  }

  it('agent revokes own message, is refused others/unknown, and clear/delete stay 403; admin revokes any', async () => {
    const setupRes = await api('/api/auth/setup', {
      method: 'POST',
      body: JSON.stringify({
        display_name: 'Admin Revoke',
        username: 'admin',
        password: 'Password123',
        gowa_url: `http://127.0.0.1:${mockGowaPort}`,
      }),
    });
    assert.equal(setupRes.status, 201, `setup: ${JSON.stringify(setupRes.body)}`);
    const adminToken = (setupRes.body?.results as {token: string}).token;

    const rolesRes = await api('/api/roles', {token: adminToken});
    const roles = (rolesRes.body?.results as Array<{
      id: number;
      slug: string;
      permissions: string[];
    }>) || [];
    const agentRole = roles.find((r) => r.slug === 'agent')!;
    assert.ok(
      agentRole.permissions.includes('chats:revoke_own'),
      'seeded agent role carries chats:revoke_own',
    );
    assert.ok(
      !agentRole.permissions.includes('chats:revoke'),
      'seeded agent role must NOT carry full chats:revoke',
    );

    const agent = await createUser(adminToken, 'revoke_agent', agentRole.id);

    // Role without the new key: revoke must be refused at the gate.
    const bareRoleRes = await api('/api/roles', {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({
        name: 'Agent Without Revoke',
        description: 'no revoke_own key',
        permissions: ['chats:read', 'chats:write', 'chats:assign', 'chats:close'],
      }),
    });
    assert.equal(bareRoleRes.status, 201, `create bare role: ${JSON.stringify(bareRoleRes.body)}`);
    const bareRoleId = (bareRoleRes.body?.results as {id: number}).id;
    const bareAgent = await createUser(adminToken, 'bare_agent', bareRoleId);

    // The agent owns the chat so content-access passes on the revoke route.
    const assignRes = await api(
      `/api/unified/chats/dev-1/${encodeURIComponent(jidA)}/assign`,
      {
        method: 'POST',
        token: adminToken,
        body: JSON.stringify({assigned_user_id: agent.id}),
      },
    );
    assert.equal(assignRes.status, 200, `assign chat: ${JSON.stringify(assignRes.body)}`);

    // Populate the server-side message cache via the messages list.
    const listRes = await api(
      `/api/unified/chats/dev-1/${encodeURIComponent(jidA)}/messages`,
      {token: agent.token},
    );
    assert.equal(listRes.status, 200, `list messages: ${JSON.stringify(listRes.body)}`);
    const listed = ((listRes.body?.results as {data?: Array<{id: string}>} | null)?.data ?? []).map(
      (m) => m.id,
    );
    assert.ok(listed.includes('m-own'), 'own message listed');
    assert.ok(listed.includes('m-other'), 'other message listed');

    const revokeUrl = (messageId: string) =>
      `/api/unified/chats/dev-1/${encodeURIComponent(jidA)}/messages/${messageId}/revoke`;

    // 1. Agent revokes their OWN message -> success, gateway called.
    const ownRes = await api(revokeUrl('m-own'), {method: 'POST', token: agent.token});
    assert.equal(ownRes.status, 200, `revoke own: ${JSON.stringify(ownRes.body)}`);
    assert.ok(
      revokeCalls.some((c) => c.path === '/message/m-own/revoke'),
      'gateway revoke called for own message',
    );

    // 2. Agent revokes ANOTHER agent's/customer message -> 403, gateway NOT called.
    const otherRes = await api(revokeUrl('m-other'), {method: 'POST', token: agent.token});
    assert.equal(otherRes.status, 403, `revoke other: ${JSON.stringify(otherRes.body)}`);
    assert.ok(
      !revokeCalls.some((c) => c.path === '/message/m-other/revoke'),
      'gateway revoke must NOT be called for another message',
    );

    // 3. Agent revokes an UNCached message id -> 403 fail-closed, gateway NOT called.
    const unknownRes = await api(revokeUrl('m-unknown'), {method: 'POST', token: agent.token});
    assert.equal(unknownRes.status, 403, `revoke unknown: ${JSON.stringify(unknownRes.body)}`);
    assert.ok(
      !revokeCalls.some((c) => c.path === '/message/m-unknown/revoke'),
      'gateway revoke must NOT be called without ownership proof',
    );

    // 4. Agent without the new key cannot revoke even their own message -> 403.
    const bareRes = await api(revokeUrl('m-own'), {method: 'POST', token: bareAgent.token});
    assert.equal(bareRes.status, 403, `revoke without key: ${JSON.stringify(bareRes.body)}`);

    // 5. Clear history and delete chat stay on full chats:revoke -> 403 for the agent.
    const clearRes = await api(`/api/unified/chats/dev-1/${encodeURIComponent(jidA)}/clear`, {
      method: 'POST',
      token: agent.token,
    });
    assert.equal(clearRes.status, 403, `clear chat: ${JSON.stringify(clearRes.body)}`);
    const deleteRes = await api(`/api/unified/chats/dev-1/${encodeURIComponent(jidA)}/delete`, {
      method: 'POST',
      token: agent.token,
    });
    assert.equal(deleteRes.status, 403, `delete chat: ${JSON.stringify(deleteRes.body)}`);

    // 6. Admin (full chats:revoke) revokes ANY message.
    const adminRes = await api(revokeUrl('m-other'), {method: 'POST', token: adminToken});
    assert.equal(adminRes.status, 200, `admin revoke other: ${JSON.stringify(adminRes.body)}`);
    assert.ok(
      revokeCalls.some((c) => c.path === '/message/m-other/revoke'),
      'gateway revoke called for admin',
    );
  });
});
