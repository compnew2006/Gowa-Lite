import './phase5-note-history-dom.ts';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHmac} from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {after, afterEach, before, beforeEach, describe, it} from 'node:test';
import React, {act, createElement as el} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {MemoryRouter} from 'react-router-dom';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {NotesPanelBody} from '../src/features/chat/drawer-notes-panel.tsx';
import {MessageBubble} from '../src/features/chat/message-bubble.tsx';
import type {ConversationNote, MessageInfo, UnifiedChat, User} from '../src/api/types.ts';
import type {NoteEditHistoryEntry} from '../src/api/contracts/chats.ts';
import {formatDate, formatShortTime} from '../src/lib/format.ts';
import {useAuthStore} from '../src/stores/auth.ts';

/**
 * Phase 5 Path E — P2-7 (decision 12 parts b/c): note edit history +
 * "edited" badge + edit time on edited messages.
 *
 * Rendered with React 19 + jsdom (no JSX: tsx does not parse JSX in .ts
 * test files, and the `npm test` glob only matches `*.test.ts`).
 *
 * Never compare DOM nodes with assert.equal/deepEqual in this file: on
 * failure Node inspects the nodes into the error message, and React-rendered
 * nodes carry __reactFiber$ trees whose inspection never finishes (the test
 * file hangs and can OOM). Compare with assert.ok(a === b) instead.
 */

// ---------------------------------------------------------------------------
// Unit: note edit history repo + MESSAGE_EDITED flag on cached messages
// ---------------------------------------------------------------------------
// One shared temp DB for all unit tests in this file: server/db.ts is a
// module singleton, so a second describe importing it again would reuse the
// first DB (already closed by the first describe's after hook).
describe('P2-7 unit: note history + edited-message flags', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gowa-lite-note-history-unit-'));
  const unitDbPath = path.join(tmpDir, 'unit.db');

  let dbMod: typeof import('../server/db.ts');
  let syncMod: typeof import('../server/services/chat-sync.ts');

  before(async () => {
    process.env.GOWA_LITE_DB_PATH = unitDbPath;
    dbMod = await import('../server/db.ts');
    syncMod = await import('../server/services/chat-sync.ts');
  });

  after(() => {
    dbMod?.closeDatabaseSafely();
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  it('records one history row per real content edit, newest first', () => {
    const roles = dbMod.listRoles();
    const agentRole = roles.find((r) => r.slug === 'agent')!;
    const sara = dbMod.createUser({
      username: 'sara',
      display_name: 'سارة علي',
      role: 'agent',
      role_id: agentRole.id,
      allowed_device_ids: ['dev-1'],
      password: 'Password123',
    });
    const omar = dbMod.createUser({
      username: 'omar',
      display_name: 'عمر خالد',
      role: 'agent',
      role_id: agentRole.id,
      allowed_device_ids: ['dev-1'],
      password: 'Password123',
    });
    const jid = '966500000001@s.whatsapp.net';
    const note = dbMod.createConversationNote({
      deviceId: 'dev-1',
      chatJid: jid,
      createdById: sara.id,
      createdByName: 'سارة علي',
      content: 'النص الأول',
    });

    dbMod.updateConversationNote(
      note.id,
      'dev-1',
      jid,
      {content: 'النص الثاني'},
      {id: sara.id, name: 'سارة علي'},
    );
    dbMod.updateConversationNote(
      note.id,
      'dev-1',
      jid,
      {content: 'النص الثالث'},
      {id: omar.id, name: 'عمر خالد'},
    );

    const history = dbMod.listNoteEditHistory(note.id, 'dev-1', jid);
    assert.equal(history.length, 2, `expected 2 history rows, got ${JSON.stringify(history)}`);
    // Newest first: the Omar edit, then the Sara edit.
    assert.equal(history[0].new_content, 'النص الثالث');
    assert.equal(history[0].previous_content, 'النص الثاني');
    assert.equal(history[0].edited_by_id, omar.id);
    assert.equal(history[0].edited_by_name, 'عمر خالد');
    assert.ok(history[0].edited_at.length > 0, 'edit time must be recorded');
    assert.equal(history[1].new_content, 'النص الثاني');
    assert.equal(history[1].previous_content, 'النص الأول');
    assert.equal(history[1].edited_by_name, 'سارة علي');
    assert.equal(history[1].note_id, note.id);
  });

  it('records nothing for a pin-only change or an unchanged-content edit', () => {
    const jid = '966500000001@s.whatsapp.net';
    const notes = dbMod.listConversationNotes('dev-1', jid);
    assert.equal(notes.length, 1);
    const note = notes[0];
    const before = dbMod.listNoteEditHistory(note.id, 'dev-1', jid).length;

    dbMod.updateConversationNote(note.id, 'dev-1', jid, {is_pinned: true}, {id: 1, name: 'سارة علي'});
    assert.equal(
      dbMod.listNoteEditHistory(note.id, 'dev-1', jid).length,
      before,
      'pin-only change must not add a history row',
    );

    dbMod.updateConversationNote(
      note.id,
      'dev-1',
      jid,
      {content: 'النص الثالث'},
      {id: 1, name: 'سارة علي'},
    );
    assert.equal(
      dbMod.listNoteEditHistory(note.id, 'dev-1', jid).length,
      before,
      'editing to the identical text must not add a history row',
    );
  });

  it('deleting a note removes its history', () => {
    const jid = '966500000001@s.whatsapp.net';
    const note = dbMod.listConversationNotes('dev-1', jid)[0];
    assert.ok(dbMod.listNoteEditHistory(note.id, 'dev-1', jid).length > 0);
    dbMod.deleteConversationNote(note.id, 'dev-1', jid);
    assert.equal(dbMod.listNoteEditHistory(note.id, 'dev-1', jid).length, 0);
    assert.equal(dbMod.listConversationNotes('dev-1', jid).length, 0);
  });

  it('MESSAGE_EDITED flags the cached message with the edit time; a replay keeps it', () => {
    const jid = '966500000003@s.whatsapp.net';
    const originalTs = '2026-11-28T14:00:00.000Z';
    dbMod.upsertCachedMessages('dev-1', jid, [
      {
        id: 'm-1',
        chat_jid: jid,
        sender_jid: jid,
        sender_display_name: 'عميل التحرير',
        content: 'النص الأصلي',
        timestamp: originalTs,
        is_from_me: false,
        media_type: '',
        filename: '',
        url: '',
        file_length: 0,
      },
    ]);
    const before = dbMod.getCachedMessage('dev-1', jid, 'm-1')!;
    assert.ok(!before.is_edited, 'unedited message must not be flagged');
    assert.ok(!before.edited_at, 'unedited message must have no edit time');

    const editTs = '2026-11-28T15:30:00.000Z';
    const editedEvent = (body: string, ts: string) => ({
      code: 'MESSAGE_EDITED',
      message: '',
      result: {
        original_message_id: 'm-1',
        chat_id: jid,
        from: jid,
        sender_display_name: 'عميل التحرير',
        content: body,
        timestamp: ts,
        is_from_me: false,
      },
    });
    syncMod.handleUpstreamGowaEvent('dev-1', editedEvent('النص المعدّل', editTs));
    const edited = dbMod.getCachedMessage('dev-1', jid, 'm-1')!;
    assert.equal(edited.content, 'النص المعدّل');
    assert.ok(edited.is_edited === true, 'edited message must be flagged');
    assert.equal(edited.edited_at, editTs, 'edit time must come from the edit event');

    // Exact replay (WS + webhook double delivery): flag stays, time unchanged.
    syncMod.handleUpstreamGowaEvent('dev-1', editedEvent('النص المعدّل', '2026-11-28T15:31:00.000Z'));
    const replayed = dbMod.getCachedMessage('dev-1', jid, 'm-1')!;
    assert.ok(replayed.is_edited === true);
    assert.equal(replayed.edited_at, editTs, 'a replay must not move the edit time');

    // A genuinely different edit updates the flag time.
    syncMod.handleUpstreamGowaEvent('dev-1', editedEvent('النص المعدّل مرة أخرى', '2026-11-28T15:45:00.000Z'));
    const editedAgain = dbMod.getCachedMessage('dev-1', jid, 'm-1')!;
    assert.equal(editedAgain.edited_at, '2026-11-28T15:45:00.000Z');
  });

  it('merge carries the edited flag to the API payload; unedited messages stay unflagged', () => {
    const jid = '966500000004@s.whatsapp.net';
    dbMod.upsertCachedMessages('dev-1', jid, [
      {
        id: 'm-e',
        chat_jid: jid,
        sender_jid: jid,
        sender_display_name: 'عميل',
        content: 'معدّلة',
        timestamp: '2026-11-28T14:00:00.000Z',
        is_from_me: false,
        media_type: '',
        filename: '',
        url: '',
        file_length: 0,
        is_edited: true,
        edited_at: '2026-11-28T15:30:00.000Z',
      },
      {
        id: 'm-p',
        chat_jid: jid,
        sender_jid: jid,
        sender_display_name: 'عميل',
        content: 'عادية',
        timestamp: '2026-11-28T14:05:00.000Z',
        is_from_me: false,
        media_type: '',
        filename: '',
        url: '',
        file_length: 0,
      },
    ]);
    const live = (dbMod.getCachedMessage('dev-1', jid, 'm-e')!);
    const livePlain = dbMod.getCachedMessage('dev-1', jid, 'm-p')!;
    // Simulate the gateway returning both messages without any edit flags.
    const gatewayView = [
      {...live, is_edited: undefined, edited_at: undefined},
      {...livePlain, is_edited: undefined, edited_at: undefined},
    ];
    const merged = dbMod.syncAndMergeChatMessages('dev-1', jid, gatewayView, {offset: 0});
    const editedMsg = merged.messages.find((m) => m.id === 'm-e')!;
    assert.ok(editedMsg.is_edited === true, 'merged payload must keep the edited flag');
    assert.equal(editedMsg.edited_at, '2026-11-28T15:30:00.000Z');
    const plainMsg = merged.messages.find((m) => m.id === 'm-p')!;
    assert.ok(!plainMsg.is_edited, 'unedited message must not gain a phantom flag');
    assert.ok(!plainMsg.edited_at, 'unedited message must not gain a phantom edit time');
  });
});

// ---------------------------------------------------------------------------
// DOM: message bubble badge + notes drawer history section
// ---------------------------------------------------------------------------
const adminUser: User = {
  id: 1,
  username: 'admin',
  display_name: 'Admin',
  role: 'admin',
  role_id: 1,
  role_slug: 'admin',
  role_name: 'Admin',
  permissions: ['notes:write', 'notes:delete', 'accounts:read', 'accounts:write', 'chats:read'],
  allowed_device_ids: [],
  is_active: true,
  created_at: '',
  theme: 'light',
  language: 'ar',
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const clients: QueryClient[] = [];

function makeQueryClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: {queries: {staleTime: Infinity, retry: false, gcTime: 0}},
  });
  clients.push(client);
  return client;
}

function flushTimers() {
  return act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

function renderWithProviders(element: React.ReactElement, client: QueryClient) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  return act(async () => {
    root!.render(el(MemoryRouter, {}, el(QueryClientProvider, {client}, element)));
  });
}

function bodyText(): string {
  return document.body.textContent ?? '';
}

beforeEach(() => {
  window.localStorage.clear();
  useAuthStore.setState({language: 'ar', user: adminUser, status: 'authenticated'});
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  if (container) {
    container.remove();
    container = null;
  }
  document.body.innerHTML = '';
  for (const client of clients.splice(0)) client.clear();
  window.localStorage.clear();
  useAuthStore.setState({user: null, status: 'unauthenticated'});
});

function messageFixture(overrides: Partial<MessageInfo> = {}): MessageInfo {
  return {
    id: 'm-1',
    chat_jid: '966500000001@s.whatsapp.net',
    sender_jid: '966500000001@s.whatsapp.net',
    sender_display_name: 'Customer',
    content: 'رسالة عادية',
    timestamp: '2026-11-28T14:00:00.000Z',
    is_from_me: false,
    media_type: '',
    filename: '',
    url: '',
    file_length: 0,
    ...overrides,
  };
}

describe('P2-7 DOM: edited message bubble shows the badge and edit time', () => {
  it('shows "معدّلة" and the edit time on an edited message', async () => {
    const editedAt = '2026-11-28T15:30:00.000Z';
    const client = makeQueryClient();
    await renderWithProviders(
      el(MessageBubble, {
        message: messageFixture({is_edited: true, edited_at: editedAt}),
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
        onJumpToMessage: () => {},
      }),
      client,
    );
    await flushTimers();
    const text = bodyText();
    assert.ok(text.includes('معدّلة'), `edited badge missing: ${text}`);
    assert.ok(
      text.includes(formatShortTime(editedAt, 'ar')),
      `edit time missing: ${text}`,
    );
    const timeEl = container!.querySelector('time[dateTime="2026-11-28T15:30:00.000Z"]');
    assert.ok(timeEl !== null, 'edit time element must carry the edit timestamp');
    assert.ok(
      (timeEl as HTMLElement).title.includes(formatDate(editedAt, 'ar')) ||
        (timeEl as HTMLElement).getAttribute('title') === formatDate(editedAt, 'ar'),
      'edit time title must show the full date-time',
    );
  });

  it('shows no badge and no edit time on an unedited message', async () => {
    const client = makeQueryClient();
    await renderWithProviders(
      el(MessageBubble, {
        message: messageFixture(),
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
        onJumpToMessage: () => {},
      }),
      client,
    );
    await flushTimers();
    const text = bodyText();
    assert.ok(!text.includes('معدّلة'), `unedited message must not show the badge: ${text}`);
  });
});

describe('P2-7 DOM: notes drawer shows the per-note edit history', () => {
  const chatJid = '966511111111@s.whatsapp.net';
  const chat = {
    device_id: 'dev-tayba',
    jid: chatJid,
    name: 'Test Chat',
    device_display_name: 'خدمات طيبة',
    device_state: 'logged_in',
  } as unknown as UnifiedChat;

  const note: ConversationNote = {
    id: 1,
    device_id: 'dev-tayba',
    chat_jid: chatJid,
    created_by_id: 1,
    created_by_name: 'Writer',
    content: 'النص الثالث',
    is_pinned: false,
    created_at: '2026-11-19T09:00:00.000Z',
    updated_at: '2026-11-20T10:30:00.000Z',
  };

  const history: NoteEditHistoryEntry[] = [
    {
      id: 2,
      note_id: 1,
      device_id: 'dev-tayba',
      chat_jid: chatJid,
      edited_by_id: 2,
      edited_by_name: 'عمر خالد',
      previous_content: 'النص الثاني',
      new_content: 'النص الثالث',
      edited_at: '2026-11-20T10:30:00.000Z',
    },
    {
      id: 1,
      note_id: 1,
      device_id: 'dev-tayba',
      chat_jid: chatJid,
      edited_by_id: 1,
      edited_by_name: 'سارة علي',
      previous_content: 'النص الأول',
      new_content: 'النص الثاني',
      edited_at: '2026-11-19T11:00:00.000Z',
    },
  ];

  it('expands the history and shows editor, time, before and after', async () => {
    const client = makeQueryClient();
    client.setQueryData(['unified-chat-notes', 'dev-tayba', chatJid], {
      notes: [note],
      total: 1,
    });
    client.setQueryData(['unified-chat-notes-history', 'dev-tayba', chatJid, 1], {
      history,
      total: 2,
    });
    await renderWithProviders(el(NotesPanelBody, {chat}), client);
    await flushTimers();

    // Collapsed by default: no history text yet.
    assert.ok(
      !bodyText().includes('النص الأول'),
      'history must start collapsed',
    );

    const toggle = container!.querySelector('button[aria-label="عرض سجل التعديلات"]');
    assert.ok(toggle !== null, 'history toggle button must exist');
    await act(async () => {
      (toggle as HTMLButtonElement).click();
    });
    await flushTimers();

    const text = bodyText();
    assert.ok(text.includes('سجل التعديلات'), `history title missing: ${text}`);
    assert.ok(text.includes('عمر خالد'), 'latest editor name must show');
    assert.ok(text.includes('سارة علي'), 'earlier editor name must show');
    assert.ok(text.includes('النص الأول'), 'previous text must show');
    assert.ok(text.includes('النص الثاني'), 'intermediate text must show');
    assert.ok(
      text.includes(formatDate('2026-11-20T10:30:00.000Z', 'ar')),
      'edit time must show',
    );
  });

  it('shows the empty-history state for a never-edited note', async () => {
    const client = makeQueryClient();
    client.setQueryData(['unified-chat-notes', 'dev-tayba', chatJid], {
      notes: [note],
      total: 1,
    });
    client.setQueryData(['unified-chat-notes-history', 'dev-tayba', chatJid, 1], {
      history: [],
      total: 0,
    });
    await renderWithProviders(el(NotesPanelBody, {chat}), client);
    await flushTimers();

    const toggle = container!.querySelector('button[aria-label="عرض سجل التعديلات"]');
    assert.ok(toggle !== null, 'history toggle button must exist');
    await act(async () => {
      (toggle as HTMLButtonElement).click();
    });
    await flushTimers();
    assert.ok(
      bodyText().includes('لا توجد تعديلات مسجلة'),
      `empty history state missing: ${bodyText()}`,
    );
  });
});

// ---------------------------------------------------------------------------
// HTTP: PATCH records history, GET history serves it, edits flag messages
// ---------------------------------------------------------------------------
describe('P2-7 HTTP: note history endpoint + edited flag through the API', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gowa-lite-note-history-int-'));
  const dbPath = path.join(tmpDir, 'int.db');
  const webhookSecret = 'note-history-fixture-secret';

  let mockGowaServer: http.Server;
  let mockGowaPort = 0;
  let appPort = 0;
  let baseUrl = '';
  let serverProc: ReturnType<typeof spawn> | null = null;
  let serverLogs = '';

  const chat1Jid = '966501111111@s.whatsapp.net';
  const deviceJid = '966500000001@s.whatsapp.net';
  const editTs = '2026-11-28T15:30:00.000Z';

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

  async function postWebhook(event: string, payload: Record<string, unknown>) {
    const body = JSON.stringify({event, device_id: deviceJid, payload});
    const digest = createHmac('sha256', webhookSecret).update(body).digest('hex');
    return fetch(`${baseUrl}/api/webhooks/gowa`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-Hub-Signature-256': `sha256=${digest}`},
      body,
    });
  }

  before(async () => {
    mockGowaServer = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      res.setHeader('Content-Type', 'application/json');
      if (url.pathname === '/devices' && req.method === 'GET') {
        res.end(JSON.stringify({code: 'SUCCESS', message: 'ok', results: [
          {id: 'dev-alpha', jid: deviceJid, phone_number: '966500000001', display_name: 'Alpha Desk', state: 'logged_in'},
        ]}));
        return;
      }
      if (/^\/devices\/[^/]+\/status$/.test(url.pathname)) {
        res.end(JSON.stringify({code: 'SUCCESS', message: 'ok', results: {
          device_id: 'dev-alpha', is_connected: true, is_logged_in: true,
        }}));
        return;
      }
      if (url.pathname === '/chats' && req.method === 'GET') {
        res.end(JSON.stringify({code: 'SUCCESS', message: 'ok', results: {data: [
          {jid: chat1Jid, name: 'Customer One', last_message_time: '2026-11-24T01:00:00Z', archived: false},
        ], pagination: {limit: 50, offset: 0, total: 1}}}));
        return;
      }
      if (/^\/chat\/[^/]+\/messages$/.test(url.pathname) && req.method === 'GET') {
        res.end(JSON.stringify({code: 'SUCCESS', message: 'ok', results: {
          data: [
            {
              id: 'm-orig-1',
              chat_jid: chat1Jid,
              sender_jid: chat1Jid,
              sender_display_name: 'عميل التحرير',
              content: 'النص المعدّل',
              timestamp: editTs,
              is_from_me: false,
              media_type: '',
              filename: '',
              url: '',
              file_length: 0,
            },
            {
              id: 'm-plain-1',
              chat_jid: chat1Jid,
              sender_jid: chat1Jid,
              sender_display_name: 'عميل التحرير',
              content: 'رسالة عادية',
              timestamp: '2026-11-28T14:00:00.000Z',
              is_from_me: false,
              media_type: '',
              filename: '',
              url: '',
              file_length: 0,
            },
          ],
          pagination: {limit: 40, offset: 0, total: 2},
          chat_info: {},
        }}));
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
        GOWA_URL: `http://127.0.0.1:${mockGowaPort}`,
        GOWA_WEBHOOK_SECRET: webhookSecret,
        BLOCK_PRIVATE_GOWA_URL: 'false',
      },
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

  it('PATCH records history rows and GET history serves them; pin-only adds none', async () => {
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
    const saraLogin = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({username: 'sara', password: 'Password123'}),
    });
    const saraToken = (saraLogin.body?.results as {token: string}).token;

    const claim = await api(`/api/unified/chats/dev-alpha/${encodeURIComponent(chat1Jid)}/claim`, {
      method: 'POST',
      token: saraToken,
    });
    assert.equal(claim.status, 200, JSON.stringify(claim.body));

    const noteRes = await api(`/api/unified/chats/dev-alpha/${encodeURIComponent(chat1Jid)}/notes`, {
      method: 'POST',
      token: saraToken,
      body: JSON.stringify({content: 'النص الأول'}),
    });
    assert.equal(noteRes.status, 201, JSON.stringify(noteRes.body));
    const noteId = (noteRes.body?.results as {id: number}).id;

    const historyUrl = `/api/unified/chats/dev-alpha/${encodeURIComponent(chat1Jid)}/notes/${noteId}/history`;

    const edit1 = await api(`/api/unified/chats/dev-alpha/${encodeURIComponent(chat1Jid)}/notes/${noteId}`, {
      method: 'PATCH',
      token: saraToken,
      body: JSON.stringify({content: 'النص الثاني'}),
    });
    assert.equal(edit1.status, 200, JSON.stringify(edit1.body));

    const pin = await api(`/api/unified/chats/dev-alpha/${encodeURIComponent(chat1Jid)}/notes/${noteId}`, {
      method: 'PATCH',
      token: saraToken,
      body: JSON.stringify({is_pinned: true}),
    });
    assert.equal(pin.status, 200, JSON.stringify(pin.body));

    const edit2 = await api(`/api/unified/chats/dev-alpha/${encodeURIComponent(chat1Jid)}/notes/${noteId}`, {
      method: 'PATCH',
      token: saraToken,
      body: JSON.stringify({content: 'النص الثالث'}),
    });
    assert.equal(edit2.status, 200, JSON.stringify(edit2.body));

    const historyRes = await api(historyUrl, {token: saraToken});
    assert.equal(historyRes.status, 200, JSON.stringify(historyRes.body));
    const history = (historyRes.body?.results as {history: Array<Record<string, unknown>>}).history;
    assert.equal(history.length, 2, `expected 2 history rows, got ${JSON.stringify(history)}`);
    assert.equal(history[0].new_content, 'النص الثالث');
    assert.equal(history[0].previous_content, 'النص الثاني');
    assert.equal(history[0].edited_by_name, 'Sara Alpha');
    assert.equal(history[1].new_content, 'النص الثاني');
    assert.equal(history[1].previous_content, 'النص الأول');

    const missing = await api(
      `/api/unified/chats/dev-alpha/${encodeURIComponent(chat1Jid)}/notes/999999/history`,
      {token: saraToken},
    );
    assert.equal(missing.status, 404, JSON.stringify(missing.body));

    // Message edit via webhook: the messages list flags the edited message
    // only, with the edit time — and leaves the plain message unflagged.
    const editWebhook = await postWebhook('message.edited', {
      original_message_id: 'm-orig-1',
      body: 'النص المعدّل',
      from: chat1Jid,
      chat_id: chat1Jid,
      sender_display_name: 'عميل التحرير',
      is_from_me: false,
      timestamp: editTs,
    });
    assert.equal(editWebhook.status, 204, await editWebhook.text());

    const messagesRes = await api(
      `/api/unified/chats/dev-alpha/${encodeURIComponent(chat1Jid)}/messages`,
      {token: saraToken},
    );
    assert.equal(messagesRes.status, 200, JSON.stringify(messagesRes.body));
    const messages = (messagesRes.body?.results as {data: Array<Record<string, unknown>>}).data;
    const editedMsg = messages.find((m) => m.id === 'm-orig-1');
    assert.ok(editedMsg, `edited message missing: ${JSON.stringify(messages)}`);
    assert.equal(editedMsg.is_edited, true, 'edited message must be flagged');
    assert.equal(editedMsg.edited_at, editTs, 'edited message must carry the edit time');
    const plainMsg = messages.find((m) => m.id === 'm-plain-1');
    assert.ok(plainMsg, 'plain message missing');
    assert.ok(!plainMsg.is_edited, 'unedited message must not be flagged');
    assert.ok(!plainMsg.edited_at, 'unedited message must not carry an edit time');
  });
});
