import './phase3-claim-copy-dom.ts';
import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {after, afterEach, before, describe, it} from 'node:test';
import React, {act, createElement as el, createRef} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import type {MessageInfo} from '../src/api/types.ts';
import {MessageBubble} from '../src/features/chat/message-bubble.tsx';
import {MessageComposer} from '../src/features/chat/message-composer.tsx';
import {resolveDeviceOwnJid, resolveIsFromMe} from '../shared/whatsapp-identity.ts';

/**
 * Phase 3 Path E (P1-18, decision 19): `is_from_me` is derived on the
 * server from `sender_jid == device JID` (ground truth), not from the
 * gateway flag alone.
 *
 * - A message whose sender_jid equals the device's own JID is outgoing
 *   even when the gateway omits both `is_from_me` / `from_me`.
 * - A message from any other sender is incoming.
 * - An explicit gateway flag is never flipped: `true` stays `true`
 *   (e.g. locally cached sends use sender_jid 'me'), and a `false`
 *   flag loses to the ground-truth sender JID.
 * - Derivation is unified in the WS ingest path (`handleUpstreamGowaEvent`,
 *   MESSAGE_RECEIVED + MESSAGE_EDITED) and in the REST fetch path
 *   (`GET .../messages`).
 *
 * No live gateway is used: the gateway is mocked, exactly like the other
 * server integration suites. A live repro of the faulty gateway path is
 * deferred as fragile follow-up verification (decision 19).
 *
 * Rendered with React 19 + jsdom (no JSX: tsx does not parse JSX in .ts
 * test files). Never compare DOM nodes with assert.equal/deepEqual: on
 * failure Node inspects the nodes into the error message, and
 * React-rendered nodes carry __reactFiber$ trees whose inspection never
 * finishes. Compare with assert.ok(a === b) instead, or read textContent.
 */

const DEVICE_ID = 'dev-1';
const DEVICE_PHONE = '966500000000';
const DEVICE_JID = '966500000000@s.whatsapp.net';
const CUSTOMER_JID = '966501000001@s.whatsapp.net';

describe('Phase 3 Path E — resolveIsFromMe (pure derivation rule)', () => {
  it('derives outgoing when sender_jid equals the device JID and no flag is present', () => {
    assert.equal(resolveIsFromMe(DEVICE_JID, DEVICE_JID, undefined), true);
    assert.equal(resolveIsFromMe(DEVICE_JID, DEVICE_JID, null), true);
  });

  it('derives outgoing for a companion-device sender JID (phone:device suffix)', () => {
    assert.equal(resolveIsFromMe('966500000000:12@s.whatsapp.net', DEVICE_JID, undefined), true);
  });

  it('derives outgoing across the @c.us / @s.whatsapp.net spelling', () => {
    assert.equal(resolveIsFromMe('966500000000@c.us', DEVICE_JID, undefined), true);
  });

  it('derives incoming for any other sender when no flag is present', () => {
    assert.equal(resolveIsFromMe(CUSTOMER_JID, DEVICE_JID, undefined), false);
    assert.equal(resolveIsFromMe('', DEVICE_JID, undefined), false);
    assert.equal(resolveIsFromMe(undefined, DEVICE_JID, undefined), false);
  });

  it('never flips an explicit true flag, even when the sender cannot be matched', () => {
    assert.equal(resolveIsFromMe('me@s.whatsapp.net', DEVICE_JID, true), true);
    assert.equal(resolveIsFromMe(CUSTOMER_JID, DEVICE_JID, true), true);
    assert.equal(resolveIsFromMe('', DEVICE_JID, true), true);
  });

  it('lets the sender JID win over an explicit false flag (sender_jid is ground truth)', () => {
    assert.equal(resolveIsFromMe(DEVICE_JID, DEVICE_JID, false), true);
  });

  it('keeps an explicit false flag for a foreign sender', () => {
    assert.equal(resolveIsFromMe(CUSTOMER_JID, DEVICE_JID, false), false);
  });

  it('cannot derive outgoing when the device JID is unknown', () => {
    assert.equal(resolveIsFromMe(DEVICE_JID, undefined, undefined), false);
    assert.equal(resolveIsFromMe(DEVICE_JID, '', undefined), false);
    // …but an explicit true flag still stands on its own.
    assert.equal(resolveIsFromMe(DEVICE_JID, undefined, true), true);
  });
});

describe('Phase 3 Path E — resolveDeviceOwnJid (device identity)', () => {
  it('prefers the gateway jid, then the phone number, then the device id itself', () => {
    assert.equal(
      resolveDeviceOwnJid({id: DEVICE_ID, jid: DEVICE_JID, phone_number: DEVICE_PHONE}),
      DEVICE_JID,
    );
    assert.equal(
      resolveDeviceOwnJid({id: DEVICE_ID, phone_number: DEVICE_PHONE}),
      DEVICE_JID,
    );
    assert.equal(
      resolveDeviceOwnJid({id: DEVICE_PHONE}),
      DEVICE_JID,
    );
  });

  it('returns empty when nothing usable identifies the device', () => {
    assert.equal(resolveDeviceOwnJid({id: DEVICE_ID}), '');
    assert.equal(resolveDeviceOwnJid({id: ''}), '');
  });
});

describe('Phase 3 Path E — WS ingest derives is_from_me from sender_jid', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gowa-lite-isfromme-ws-'));
  process.env.GOWA_LITE_DB_PATH = path.join(tempDir, 'test.db');

  type DbModule = typeof import('../server/db.ts');
  type ChatSyncModule = typeof import('../server/services/chat-sync.ts');

  let dbMod: DbModule;
  let chatSyncMod: ChatSyncModule;

  before(async () => {
    dbMod = await import('../server/db.ts');
    chatSyncMod = await import('../server/services/chat-sync.ts');
  });

  after(() => {
    try {
      dbMod?.db.close();
    } catch {
      // ignore
    }
    fs.rmSync(tempDir, {recursive: true, force: true});
  });

  function receive(
    id: string,
    senderJid: string,
    overrides: Record<string, unknown> = {},
    deviceOwnJid: string | undefined = DEVICE_JID,
  ): void {
    chatSyncMod.handleUpstreamGowaEvent(
      DEVICE_ID,
      {
        code: 'MESSAGE_RECEIVED',
        message: 'ok',
        result: {
          id,
          chat_jid: CUSTOMER_JID,
          sender_jid: senderJid,
          content: `body ${id}`,
          timestamp: '2026-11-28T12:00:00.000Z',
          ...overrides,
        },
      },
      undefined,
      undefined,
      deviceOwnJid,
    );
  }

  it('stores an own message as outgoing when the gateway omits both flags', () => {
    receive('ws-own-noflag', DEVICE_JID);
    const cached = dbMod.getCachedMessage(DEVICE_ID, CUSTOMER_JID, 'ws-own-noflag');
    assert.ok(cached, 'message should be cached');
    assert.equal(cached!.is_from_me, true);
  });

  it('stores a foreign message as incoming when the gateway omits both flags', () => {
    receive('ws-in-noflag', CUSTOMER_JID);
    const cached = dbMod.getCachedMessage(DEVICE_ID, CUSTOMER_JID, 'ws-in-noflag');
    assert.ok(cached, 'message should be cached');
    assert.equal(cached!.is_from_me, false);
  });

  it('keeps an explicit true flag for a locally cached send (sender_jid "me")', () => {
    receive('ws-own-flag', 'me@s.whatsapp.net', {is_from_me: true});
    const cached = dbMod.getCachedMessage(DEVICE_ID, CUSTOMER_JID, 'ws-own-flag');
    assert.ok(cached, 'message should be cached');
    assert.equal(cached!.is_from_me, true);
  });

  it('derives outgoing for an edited own message without flags', () => {
    receive('ws-edit-own', DEVICE_JID);
    chatSyncMod.handleUpstreamGowaEvent(
      DEVICE_ID,
      {
        code: 'MESSAGE_EDITED',
        message: 'ok',
        result: {
          original_message_id: 'ws-edit-own',
          chat_jid: CUSTOMER_JID,
          sender_jid: DEVICE_JID,
          body: 'edited body',
          timestamp: '2026-11-28T12:01:00.000Z',
        },
      },
      undefined,
      undefined,
      DEVICE_JID,
    );
    const cached = dbMod.getCachedMessage(DEVICE_ID, CUSTOMER_JID, 'ws-edit-own');
    assert.ok(cached, 'message should be cached');
    assert.equal(cached!.is_from_me, true);
    assert.equal(cached!.content, 'edited body');
  });

  it('falls back to the flag alone when the device JID is unknown', () => {
    // Call the handler with no 5th argument at all (as older callers do):
    // passing explicit `undefined` would hit the helper's default, so this
    // exercises the real "device JID unknown" path.
    chatSyncMod.handleUpstreamGowaEvent(DEVICE_ID, {
      code: 'MESSAGE_RECEIVED',
      message: 'ok',
      result: {
        id: 'ws-unknown-device',
        chat_jid: CUSTOMER_JID,
        sender_jid: DEVICE_JID,
        content: 'body ws-unknown-device',
        timestamp: '2026-11-28T12:00:00.000Z',
      },
    });
    const cached = dbMod.getCachedMessage(DEVICE_ID, CUSTOMER_JID, 'ws-unknown-device');
    assert.ok(cached, 'message should be cached');
    assert.equal(cached!.is_from_me, false);
  });
});

describe('Phase 3 Path E — fetch path derives is_from_me from sender_jid', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gowa-lite-isfromme-fetch-'));
  const dbPath = path.join(tmpDir, 'test.db');

  let mockGowaServer: http.Server;
  let mockGowaPort = 0;
  let appPort = 0;
  let baseUrl = '';
  let serverProc: ChildProcess;

  const mockMessages: Array<Record<string, unknown>> = [
    {
      id: 'm-own-noflag',
      chat_jid: CUSTOMER_JID,
      sender_jid: DEVICE_JID,
      content: 'my quoted reply',
      timestamp: '2026-11-28T12:05:00.000Z',
      media_type: '',
      filename: '',
      url: '',
      file_length: 0,
    },
    {
      id: 'm-in-noflag',
      chat_jid: CUSTOMER_JID,
      sender_jid: CUSTOMER_JID,
      sender_display_name: 'Customer',
      content: 'hello',
      timestamp: '2026-11-28T12:04:00.000Z',
      media_type: '',
      filename: '',
      url: '',
      file_length: 0,
    },
    {
      id: 'm-own-flag',
      chat_jid: CUSTOMER_JID,
      sender_jid: 'me@s.whatsapp.net',
      content: 'sent from this device',
      timestamp: '2026-11-28T12:03:00.000Z',
      is_from_me: true,
      media_type: '',
      filename: '',
      url: '',
      file_length: 0,
    },
    {
      id: 'm-in-flagfalse',
      chat_jid: CUSTOMER_JID,
      sender_jid: CUSTOMER_JID,
      sender_display_name: 'Customer',
      content: 'another one',
      timestamp: '2026-11-28T12:02:00.000Z',
      is_from_me: false,
      media_type: '',
      filename: '',
      url: '',
      file_length: 0,
    },
    {
      id: 'm-own-flagfalse',
      chat_jid: CUSTOMER_JID,
      sender_jid: DEVICE_JID,
      content: 'gateway said false, sender says me',
      timestamp: '2026-11-28T12:01:00.000Z',
      is_from_me: false,
      media_type: '',
      filename: '',
      url: '',
      file_length: 0,
    },
  ];

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

  async function getFreePort(): Promise<number> {
    const srv = net.createServer();
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
    const port = (srv.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
    return port;
  }

  before(async () => {
    mockGowaServer = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      res.setHeader('Content-Type', 'application/json');
      if (url.pathname === '/devices' && req.method === 'GET') {
        // No `jid` on purpose: the server must fall back to phone_number.
        res.end(JSON.stringify({
          code: 'SUCCESS',
          message: 'ok',
          results: [{id: DEVICE_ID, phone_number: DEVICE_PHONE, state: 'logged_in'}],
        }));
        return;
      }
      if (/^\/devices\/[^/]+\/status$/.test(url.pathname)) {
        res.end(JSON.stringify({
          code: 'SUCCESS',
          message: 'ok',
          results: {device_id: DEVICE_ID, is_connected: true, is_logged_in: true},
        }));
        return;
      }
      if (/^\/chat\/[^/]+\/messages$/.test(url.pathname) && req.method === 'GET') {
        res.end(JSON.stringify({
          code: 'SUCCESS',
          message: 'ok',
          results: {
            data: mockMessages,
            pagination: {limit: 50, offset: 0, total: mockMessages.length},
            chat_info: {
              jid: CUSTOMER_JID,
              name: 'Customer',
              last_message_time: '2026-11-28T12:05:00.000Z',
              ephemeral_expiration: 0,
              created_at: '',
              updated_at: '',
              archived: false,
            },
          },
        }));
        return;
      }
      res.end(JSON.stringify({code: 'SUCCESS', message: 'ok', results: []}));
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
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let ready = false;
    for (let i = 0; i < 200; i += 1) {
      try {
        const ping = await fetch(`${baseUrl}/api/auth/status`);
        if (ping.ok) {
          ready = true;
          break;
        }
      } catch {
        // Wait for boot
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(ready, true, 'Express server failed to start within 30s');
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

  it('returns server-derived is_from_me on the messages fetch', async () => {
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
    assert.equal(setupRes.status, 201);
    const token = (setupRes.body?.results as {token: string}).token;

    const res = await api(
      `/api/unified/chats/${DEVICE_ID}/${encodeURIComponent(CUSTOMER_JID)}/messages?limit=50`,
      {token},
    );
    assert.equal(res.status, 200);
    const data = (res.body?.results as {data: Array<{id: string; is_from_me: boolean}>}).data;
    assert.ok(Array.isArray(data), 'expected a messages array');
    const byId = new Map(data.map((m) => [m.id, m.is_from_me]));
    assert.equal(byId.get('m-own-noflag'), true, 'own sender without a flag must read outgoing');
    assert.equal(byId.get('m-in-noflag'), false, 'foreign sender without a flag must read incoming');
    assert.equal(byId.get('m-own-flag'), true, 'explicit true flag must be preserved');
    assert.equal(byId.get('m-in-flagfalse'), false, 'explicit false flag for a foreign sender stays false');
    assert.equal(byId.get('m-own-flagfalse'), true, 'own sender wins over an explicit false flag');

    // A second fetch reads the resolved flag back from the cache.
    const again = await api(
      `/api/unified/chats/${DEVICE_ID}/${encodeURIComponent(CUSTOMER_JID)}/messages?limit=50`,
      {token},
    );
    assert.equal(again.status, 200);
    const againData = (again.body?.results as {data: Array<{id: string; is_from_me: boolean}>}).data;
    const againById = new Map(againData.map((m) => [m.id, m.is_from_me]));
    assert.equal(againById.get('m-own-noflag'), true, 'resolved flag must persist in the cache');
  });
});

describe('Phase 3 Path E — no regression in "أنت" (reply preview + reply bar)', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  function messageFixture(overrides: Partial<MessageInfo> = {}): MessageInfo {
    return {
      id: 'm-1',
      chat_jid: CUSTOMER_JID,
      sender_jid: CUSTOMER_JID,
      sender_display_name: 'Customer',
      content: 'hello',
      timestamp: '2026-11-28T12:00:00.000Z',
      is_from_me: false,
      media_type: '',
      filename: '',
      url: '',
      file_length: 0,
      ...overrides,
    };
  }

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container?.remove();
    container = null;
  });

  it('quoted preview shows "أنت" for an outgoing quoted message and the sender name otherwise', async () => {
    const ownQuoted = messageFixture({
      id: 'm-own',
      sender_jid: DEVICE_JID,
      sender_display_name: 'Main Desk',
      content: 'my quoted reply',
      is_from_me: true,
    });
    const incoming = messageFixture({id: 'm-in', content: 'replying to my message'});

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        el(MessageBubble, {
          message: incoming,
          quoted: ownQuoted,
          deviceId: DEVICE_ID,
          isDeviceReady: true,
          canReactAndReply: true,
          isReactionPickerOpen: false,
          onToggleReactionPicker: () => {},
          onCloseReactionPicker: () => {},
          onReact: () => {},
          onReply: () => {},
          onForward: () => {},
          onJumpToMessage: () => {},
        }),
      );
    });
    assert.ok(
      container.textContent?.includes('أنت'),
      `quoted outgoing message must show "أنت", got: ${container.textContent}`,
    );
    assert.ok(
      !container.textContent?.includes('Main Desk'),
      'quoted outgoing message must not show the sender name',
    );

    await act(async () => {
      root!.render(
        el(MessageBubble, {
          message: messageFixture({id: 'm-in-2', sender_jid: DEVICE_JID, is_from_me: true}),
          quoted: messageFixture({id: 'm-q-in', content: 'customer words'}),
          deviceId: DEVICE_ID,
          isDeviceReady: true,
          canReactAndReply: true,
          isReactionPickerOpen: false,
          onToggleReactionPicker: () => {},
          onCloseReactionPicker: () => {},
          onReact: () => {},
          onReply: () => {},
          onForward: () => {},
          onJumpToMessage: () => {},
        }),
      );
    });
    assert.ok(
      container.textContent?.includes('Customer'),
      `quoted incoming message must show the sender name, got: ${container.textContent}`,
    );
  });

  it('reply bar shows "الرد على أنت" when replying to an outgoing message', async () => {
    const replyingTo = messageFixture({
      id: 'm-own',
      sender_jid: DEVICE_JID,
      sender_display_name: 'Main Desk',
      content: 'my message',
      is_from_me: true,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        el(MessageComposer, {
          inputRef: createRef<HTMLInputElement>(),
          deviceDisplayName: 'Main Desk',
          isDeviceReady: true,
          draft: '',
          attachment: null,
          replyingTo,
          isSending: false,
          onDraftChange: () => {},
          onAttachmentChange: () => {},
          onCancelReply: () => {},
          onOpenSchedule: () => {},
          onSubmit: () => {},
        }),
      );
    });
    assert.ok(
      container.textContent?.includes('الرد على أنت'),
      `reply bar must show "الرد على أنت", got: ${container.textContent}`,
    );
  });
});
