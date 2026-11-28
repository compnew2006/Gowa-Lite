import './schedule-account-line-dom.ts';
import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
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
import {WebSocketServer, type WebSocket} from 'ws';
import {ScheduledPanelBody} from '../src/features/chat/drawer-schedules-panel.tsx';
import {
  getSchedulePreviewText,
  getScheduleRecipient,
} from '../src/features/schedules/schedule-utils.ts';
import {loadEnglishTranslations, useI18n} from '../src/lib/i18n.ts';
import ScheduledPage from '../src/pages/scheduled.tsx';
import type {RegistryDevice, ScheduledSend, UnifiedChat, User} from '../src/api/types.ts';
import {useAuthStore} from '../src/stores/auth.ts';

/**
 * Phase 2 path B (P1-1 + P1-19 + P1-2 + P1-22): schedule surfaces — the chat
 * drawer + the scheduled page.
 *
 * - P1-1 (decision 9): the drawer shows the chat's schedules from ALL of the
 *   user's allowed devices, with the owning device on every row.
 * - P1-19: the drawer's empty state links to /scheduled.
 * - P1-2: content reads `content || message || summary || caption ||
 *   filename || '—'` (summary is the live gateway field — see the report)
 *   and the recipient falls back through `recipient || phone || to || '—'`.
 * - P1-22: the status filter explains active vs running — only because the
 *   gateway code confirms `running` means "claimed by the worker, sending
 *   now" (ClaimNextScheduledSend sets status='running' for a due job).
 *
 * Never compare DOM nodes with assert.equal/deepEqual in this file: on
 * failure Node inspects the nodes into the error message, and React-rendered
 * nodes carry __reactFiber$ trees whose inspection never finishes (the test
 * file hangs and can OOM). Compare with assert.ok(a === b) instead.
 */

// ---------------------------------------------------------------------------
// Shared DOM harness (same pattern as schedule-account-line.test.ts)
// ---------------------------------------------------------------------------

const deviceAsir: RegistryDevice = {
  id: 'dev-asir',
  phone_number: '966500000001',
  display_name: 'Asir Account',
  alias: 'Asir alias',
  resolved_name: 'خدمات عسير',
  state: 'logged_in',
  created_at: '',
};

const deviceTayba: RegistryDevice = {
  id: 'dev-tayba',
  phone_number: '966500000002',
  display_name: 'Tayba Account',
  resolved_name: 'خدمات طيبة',
  state: 'logged_in',
  created_at: '',
};

const devices = [deviceAsir, deviceTayba];

const writerUser: User = {
  id: 1,
  username: 'writer',
  display_name: 'Writer',
  role: 'admin',
  role_id: 1,
  role_slug: 'admin',
  role_name: 'Admin',
  permissions: ['schedules:write', 'schedules:manage', 'schedules:read'],
  allowed_device_ids: [],
  is_active: true,
  created_at: '',
  theme: 'light',
  language: 'ar',
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function makeQueryClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: {queries: {staleTime: Infinity, retry: false, gcTime: 0}},
  });
  client.setQueryData(['devices'], devices);
  return client;
}

function flushTimers() {
  return act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

function render(element: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  return act(async () => {
    root!.render(element);
  });
}

function bodyText(): string {
  return document.body.textContent ?? '';
}

beforeEach(() => {
  useAuthStore.setState({language: 'ar', user: writerUser, status: 'authenticated'});
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
  useAuthStore.setState({user: null, status: 'unauthenticated', language: 'ar'});
});

// ---------------------------------------------------------------------------
// P1-2 — display fallbacks (pure helpers)
// ---------------------------------------------------------------------------

describe('P1-2 schedule display fallbacks', () => {
  const base: ScheduledSend = {
    id: 's1',
    message_type: 'text',
    recipient: '966501000001',
    scheduled_at: '2026-11-29T10:00:00Z',
    timezone: 'Asia/Riyadh',
    recurrence: 'once',
    occurrence_count: 0,
    status: 'active',
    created_at: '2026-11-28T10:00:00Z',
    updated_at: '2026-11-28T10:00:00Z',
  };

  it('preview prefers content, then message when content is empty', () => {
    assert.equal(getSchedulePreviewText({...base, content: 'from content'}), 'from content');
    assert.equal(
      getSchedulePreviewText({...base, content: '', message: 'from message'}),
      'from message',
    );
    assert.equal(
      getSchedulePreviewText({...base, message: 'from message'}),
      'from message',
    );
  });

  it('preview reads the live gateway summary field when content/message are absent', () => {
    assert.equal(
      getSchedulePreviewText({...base, summary: 'live summary text'}),
      'live summary text',
    );
    assert.equal(
      getSchedulePreviewText({...base, message: 'msg wins over summary', summary: 'summary'}),
      'msg wins over summary',
    );
  });

  it('preview falls through caption/filename to the em dash', () => {
    assert.equal(
      getSchedulePreviewText({...base, caption: 'a caption'}),
      'a caption',
    );
    assert.equal(
      getSchedulePreviewText({...base, filename: 'invoice.pdf'}),
      'invoice.pdf',
    );
    assert.equal(getSchedulePreviewText({...base}), '—');
  });

  it('recipient falls back through recipient, phone, to, then the em dash', () => {
    assert.equal(getScheduleRecipient({...base, recipient: '966501000001'}), '966501000001');
    assert.equal(
      getScheduleRecipient({...base, recipient: '', phone: '966502000002'}),
      '966502000002',
    );
    assert.equal(
      getScheduleRecipient({...base, recipient: '', to: '120363000001@g.us'}),
      '120363000001@g.us',
    );
    assert.equal(getScheduleRecipient({...base, recipient: ''}), '—');
  });
});

// ---------------------------------------------------------------------------
// i18n — new keys in Arabic + English (P1-19, P1-1, P1-22)
// ---------------------------------------------------------------------------

function I18nProbe() {
  const {t} = useI18n();
  return el(
    'div',
    {'data-testid': 'i18n-probe'},
    [
      t.chats.viewAllScheduled,
      t.chats.scheduleDeviceName('X'),
      t.scheduled.statusActiveHint,
      t.scheduled.statusRunningHint,
      t.scheduled.statusFilterHint,
    ].join(' | '),
  );
}

describe('phase2 schedule-surfaces i18n keys (ar + en)', () => {
  it('has Arabic strings for the drawer link, device label and status hints', async () => {
    const client = makeQueryClient();
    await render(el(QueryClientProvider, {client}, el(I18nProbe, {})));
    await flushTimers();
    const probe = document.querySelector('[data-testid="i18n-probe"]');
    assert.ok(probe, 'i18n probe renders');
    const text = probe.textContent ?? '';
    assert.ok(text.includes('عرض كل الرسائل المجدولة'), 'P1-19 link label (ar)');
    assert.ok(text.includes('الحساب: X'), 'P1-1 owning-device label (ar)');
    assert.ok(text.includes('نشط: بانتظار موعدها'), 'P1-22 active hint (ar)');
    assert.ok(text.includes('قيد التنفيذ: تُرسل الآن'), 'P1-22 running hint (ar)');
  });

  it('has English strings for the same keys', async () => {
    await loadEnglishTranslations();
    useAuthStore.setState({language: 'en', user: writerUser, status: 'authenticated'});
    const client = makeQueryClient();
    await render(el(QueryClientProvider, {client}, el(I18nProbe, {})));
    await flushTimers();
    const probe = document.querySelector('[data-testid="i18n-probe"]');
    assert.ok(probe, 'i18n probe renders (en)');
    const text = probe.textContent ?? '';
    assert.ok(text.includes('View all scheduled messages'), 'P1-19 link label (en)');
    assert.ok(text.includes('Account: X'), 'P1-1 owning-device label (en)');
    assert.ok(text.includes('Active: waiting for its scheduled time'), 'P1-22 active hint (en)');
    assert.ok(text.includes('Running: being sent now'), 'P1-22 running hint (en)');
  });
});

// ---------------------------------------------------------------------------
// P1-19 + P1-1 — drawer DOM: empty-state link, owning device per row
// ---------------------------------------------------------------------------

function chatOnDevice(deviceId: string): UnifiedChat {
  return {
    device_id: deviceId,
    jid: '966501000001@s.whatsapp.net',
    name: 'Test Chat',
    device_display_name: 'خدمات عسير',
    device_state: 'logged_in',
  } as unknown as UnifiedChat;
}

function drawerSchedule(overrides: Partial<ScheduledSend> & {id: string}): ScheduledSend {
  return {
    message_type: 'text',
    recipient: '966501000001@s.whatsapp.net',
    content: 'hello scheduled',
    scheduled_at: '2026-11-29T10:00:00Z',
    timezone: 'Asia/Riyadh',
    recurrence: 'once',
    occurrence_count: 0,
    status: 'active',
    created_at: '2026-11-28T10:00:00Z',
    updated_at: '2026-11-28T10:00:00Z',
    ...overrides,
  };
}

describe('P1-19 drawer empty state + P1-1 owning device (DOM)', () => {
  it('empty state links to /scheduled', async () => {
    const client = makeQueryClient();
    const chat = chatOnDevice('dev-asir');
    client.setQueryData(['unified-chat-schedules', chat.device_id, chat.jid], {
      data: [],
      pagination: {limit: 100, offset: 0, total: 0},
    });
    await render(
      el(
        MemoryRouter,
        {},
        el(QueryClientProvider, {client}, el(ScheduledPanelBody, {
          chat,
          onOpenCreateSchedule: () => {},
        })),
      ),
    );
    await flushTimers();
    const link = document.querySelector('a[href="/scheduled"]');
    assert.ok(link, 'empty state must link to /scheduled');
    assert.ok(
      (link.textContent ?? '').includes('عرض كل الرسائل المجدولة'),
      'link label is the view-all label',
    );
  });

  it('rows show the owning device and a view-all link sits below the list', async () => {
    const client = makeQueryClient();
    const chat = chatOnDevice('dev-asir');
    client.setQueryData(['unified-chat-schedules', chat.device_id, chat.jid], {
      data: [
        drawerSchedule({id: 's-a', device_id: 'dev-asir', device_name: 'خدمات عسير'}),
        drawerSchedule({
          id: 's-b',
          device_id: 'dev-tayba',
          device_name: 'خدمات طيبة',
          content: 'from the other device',
        }),
      ],
      pagination: {limit: 100, offset: 0, total: 2},
    });
    await render(
      el(
        MemoryRouter,
        {},
        el(QueryClientProvider, {client}, el(ScheduledPanelBody, {
          chat,
          onOpenCreateSchedule: () => {},
        })),
      ),
    );
    await flushTimers();
    const text = bodyText();
    assert.ok(text.includes('خدمات عسير'), 'owning device shown for the current-device row');
    assert.ok(text.includes('خدمات طيبة'), 'owning device shown for the other-device row');
    assert.ok(text.includes('from the other device'), 'other-device schedule content renders');
    const link = document.querySelector('a[href="/scheduled"]');
    assert.ok(link, 'view-all link is also shown below a non-empty list');
  });
});

// ---------------------------------------------------------------------------
// P1-22 — scheduled page status-filter tooltip (DOM)
// ---------------------------------------------------------------------------

describe('P1-22 scheduled page status filter hint (DOM)', () => {
  it('the status filter row explains active vs running', async () => {
    const client = makeQueryClient();
    client.setQueryData(['schedules', 'dev-asir', 'all', 'all', '', 0], {
      data: [
        drawerSchedule({id: 's-page-1', recipient: '966501000001'}),
      ],
      pagination: {limit: 25, offset: 0, total: 1},
    });
    await render(
      el(MemoryRouter, {}, el(QueryClientProvider, {client}, el(ScheduledPage, {}))),
    );
    await flushTimers();
    const filters = document.querySelector('[data-testid="schedule-status-filters"]');
    assert.ok(filters, 'status filter row renders');
    const title = filters.getAttribute('title') ?? '';
    assert.ok(title.includes('بانتظار موعدها'), 'hint explains active waits for its time');
    assert.ok(title.includes('تُرسل الآن'), 'hint explains running is sending now');
  });
});

// ---------------------------------------------------------------------------
// P1-1 — drawer route integration: multi-device scan, allowed-only, cap
// ---------------------------------------------------------------------------

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

interface MockDevice {
  id: string;
  phone_number?: string;
  state: string;
}

interface MockGatewaySchedule {
  id: string;
  device: string;
  recipient?: string;
  phone?: string;
  message?: string;
  summary?: string;
  content?: string;
  status: string;
  scheduled_at: string;
  next_run_at: string;
  recurrence: string;
  message_type: string;
  created_at: string;
  updated_at: string;
  occurrence_count: number;
}

function digitsOf(value: string): string {
  return value.replace(/\D/g, '');
}

describe('P1-1 drawer route multi-device scan (integration)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gowa-lite-sched-surfaces-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const chatJid = '966501000001@s.whatsapp.net';

  let mockGowaServer: http.Server;
  let mockGowaWss: WebSocketServer;
  const mockWsClients = new Map<string, WebSocket>();
  let mockGowaPort = 0;
  let appPort = 0;
  let baseUrl = '';
  let serverProc: ChildProcess;

  let mockDevices: MockDevice[] = [
    {id: 'dev-a', phone_number: '966500000001', state: 'logged_in'},
    {id: 'dev-b', phone_number: '966500000002', state: 'logged_in'},
    {id: 'dev-c', phone_number: '966500000003', state: 'logged_in'},
  ];
  let schedules: MockGatewaySchedule[] = [];
  let scheduleHits: string[] = [];

  let adminToken = '';
  let agentToken = '';
  let agentId = 0;

  function futureIso(hoursFromNow = 2): string {
    return new Date(Date.now() + hoursFromNow * 3_600_000).toISOString();
  }

  function seedSchedule(partial: Partial<MockGatewaySchedule> & {id: string; device: string}) {
    const now = new Date().toISOString();
    const item: MockGatewaySchedule = {
      status: 'active',
      scheduled_at: futureIso(),
      next_run_at: futureIso(),
      recurrence: 'once',
      message_type: 'text',
      created_at: now,
      updated_at: now,
      occurrence_count: 0,
      ...partial,
    };
    schedules.push(item);
    return item;
  }

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

  function listData(body: Record<string, unknown> | null): Array<Record<string, unknown>> {
    const results = body?.results as {data?: Array<Record<string, unknown>>} | undefined;
    return results?.data ?? [];
  }

  async function createUser(
    username: string,
    displayName: string,
    roleSlug: string,
    allowedDeviceIds: string[],
  ): Promise<{id: number; token: string}> {
    const roleRes = await api('/api/roles', {token: adminToken});
    const roles = (roleRes.body?.results as Array<{id: number; slug: string}>) ?? [];
    const role = roles.find((r) => r.slug === roleSlug);
    assert.ok(role, `role ${roleSlug} should exist`);
    const createRes = await api('/api/users', {
      method: 'POST',
      token: adminToken,
      body: {
        display_name: displayName,
        username,
        password: 'Password123',
        role_id: role.id,
        allowed_device_ids: allowedDeviceIds,
      },
    });
    assert.equal(createRes.status, 201, `create user ${username}: ${JSON.stringify(createRes.body)}`);
    const userId = (createRes.body?.results as {id: number}).id;
    const loginRes = await api('/api/auth/login', {
      method: 'POST',
      body: {username, password: 'Password123'},
    });
    assert.equal(loginRes.status, 200, `login ${username}`);
    const token = (loginRes.body?.results as {token: string}).token;
    assert.ok(token, `token for ${username}`);
    return {id: userId, token};
  }

  before(async () => {
    mockGowaServer = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      res.setHeader('Content-Type', 'application/json');

      if (url.pathname === '/devices' && req.method === 'GET') {
        res.end(JSON.stringify({code: 'SUCCESS', message: 'ok', results: mockDevices}));
        return;
      }
      if (/^\/devices\/[^/]+\/status$/.test(url.pathname) && req.method === 'GET') {
        res.end(
          JSON.stringify({
            code: 'SUCCESS',
            message: 'ok',
            results: {device_id: 'dev-a', is_connected: true, is_logged_in: true},
          }),
        );
        return;
      }
      if (url.pathname === '/send/schedules' && req.method === 'GET') {
        const rawDeviceId = req.headers['x-device-id'];
        const deviceId = decodeURIComponent(
          Array.isArray(rawDeviceId) ? rawDeviceId[0] ?? '' : rawDeviceId || '',
        );
        scheduleHits.push(deviceId);
        const search = (url.searchParams.get('search') || '').trim();
        const status = (url.searchParams.get('status') || '').trim();
        const limit = Number(url.searchParams.get('limit') || '100');
        const offset = Number(url.searchParams.get('offset') || '0');
        let items = schedules.filter((item) => item.device === deviceId);
        if (search) {
          const searchDigits = digitsOf(search);
          items = items.filter((item) => {
            const target = String(item.recipient || item.phone || '');
            return (
              (searchDigits && digitsOf(target).includes(searchDigits)) ||
              String(item.content || item.message || item.summary || '').includes(search)
            );
          });
        }
        if (status && status !== 'all') {
          items = items.filter((item) => item.status === status);
        }
        const total = items.length;
        const page = items.slice(offset, offset + limit);
        res.end(
          JSON.stringify({
            code: 'SUCCESS',
            message: 'ok',
            results: {data: page, pagination: {limit, offset, total}},
          }),
        );
        return;
      }
      res.end(JSON.stringify({code: 'SUCCESS', message: 'ok', results: []}));
    });

    mockGowaWss = new WebSocketServer({server: mockGowaServer, path: '/ws'});
    mockGowaWss.on('connection', (ws, req) => {
      const reqUrl = new URL(req.url || '/ws', 'http://127.0.0.1');
      mockWsClients.set(reqUrl.searchParams.get('device_id') || 'default', ws);
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
      env: {...process.env, NODE_ENV: 'test', PORT: String(appPort), GOWA_LITE_DB_PATH: dbPath},
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let ready = false;
    // Generous window: sibling worktrees run their suites on the same VM,
    // and tsx boot is slow under that contention.
    for (let i = 0; i < 240; i += 1) {
      try {
        const ping = await fetch(`${baseUrl}/api/auth/status`);
        if (ping.ok) {
          ready = true;
          break;
        }
      } catch {
        // Wait for boot
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal(ready, true, 'Express server failed to start');

    const setupRes = await api('/api/auth/setup', {
      method: 'POST',
      body: {
        display_name: 'Admin User',
        username: 'admin',
        password: 'AdminPassword123',
        gowa_url: `http://127.0.0.1:${mockGowaPort}`,
        gowa_username: 'gowa',
        gowa_password: 'gowa-password',
      },
    });
    assert.equal(setupRes.status, 201, `setup: ${JSON.stringify(setupRes.body)}`);
    adminToken = (setupRes.body?.results as {token: string}).token;

    const agent = await createUser('surface_agent', 'Surface Agent', 'agent', [
      'dev-a',
      'dev-b',
    ]);
    agentId = agent.id;
    agentToken = agent.token;

    // The agent owns the test chat on dev-a so inbox schedule routes pass
    // content access.
    const assignRes = await api(
      `/api/unified/chats/dev-a/${encodeURIComponent(chatJid)}/assign`,
      {
        method: 'POST',
        token: adminToken,
        body: {assigned_user_id: agentId},
      },
    );
    assert.equal(assignRes.status, 200, `assign chat: ${JSON.stringify(assignRes.body)}`);

    // Schedules for the same chat JID, stored under different devices.
    // dev-b uses the LIVE gateway record shape: phone + summary, no
    // recipient / content / message fields.
    seedSchedule({id: 'sched-a1', device: 'dev-a', recipient: chatJid, message: 'from device A'});
    seedSchedule({
      id: 'sched-b1',
      device: 'dev-b',
      phone: '966501000001',
      summary: 'live text from device B',
    });
    seedSchedule({id: 'sched-c1', device: 'dev-c', recipient: chatJid, message: 'forbidden device'});
    // A schedule for a different chat must never leak into this drawer.
    seedSchedule({
      id: 'sched-other-chat',
      device: 'dev-b',
      recipient: '966509999999@s.whatsapp.net',
      message: 'another chat',
    });
  });

  after(async () => {
    for (const client of mockWsClients.values()) {
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

  it('all_devices=1 returns the schedule stored under another device, with its owner', async () => {
    const res = await api(
      `/api/unified/chats/dev-a/${encodeURIComponent(chatJid)}/schedules?all_devices=1`,
      {token: adminToken},
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const rows = listData(res.body);
    const byId = new Map(rows.map((row) => [row.id, row]));
    assert.ok(byId.has('sched-a1'), 'current-device schedule is returned');
    const other = byId.get('sched-b1');
    assert.ok(other, 'schedule stored under dev-b is returned for the same JID');
    assert.equal(other.device_id, 'dev-b', 'row carries the owning device id');
    assert.ok(
      typeof other.device_name === 'string' && other.device_name.length > 0,
      'row carries the owning device name',
    );
    assert.ok(!byId.has('sched-other-chat'), 'schedules for other chats are excluded');
  });

  it('the multi-device scan only covers the user-allowed devices', async () => {
    const res = await api(
      `/api/unified/chats/dev-a/${encodeURIComponent(chatJid)}/schedules?all_devices=1`,
      {token: agentToken},
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const ids = listData(res.body).map((row) => row.id);
    assert.ok(ids.includes('sched-a1'), 'allowed device dev-a is scanned');
    assert.ok(ids.includes('sched-b1'), 'allowed device dev-b is scanned');
    assert.ok(!ids.includes('sched-c1'), 'forbidden device dev-c is never scanned');
  });

  it('without all_devices the drawer keeps its single-device scope (no regression)', async () => {
    const res = await api(
      `/api/unified/chats/dev-a/${encodeURIComponent(chatJid)}/schedules`,
      {token: adminToken},
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const ids = listData(res.body).map((row) => row.id);
    assert.ok(ids.includes('sched-a1'), 'current-device schedule is returned');
    assert.ok(!ids.includes('sched-b1'), 'other-device schedule stays hidden without the flag');
  });

  it('the multi-device scan is capped at a reasonable number of devices', async () => {
    // 12 allowed devices for the admin (empty allow-list = all devices).
    mockDevices = Array.from({length: 12}, (_v, i) => ({
      id: `dev-cap-${i}`,
      phone_number: `9665000000${String(i).padStart(2, '0')}`,
      state: 'logged_in',
    }));
    for (let i = 0; i < 12; i += 1) {
      seedSchedule({
        id: `sched-cap-${i}`,
        device: `dev-cap-${i}`,
        recipient: chatJid,
        message: `cap ${i}`,
      });
    }
    scheduleHits = [];
    const res = await api(
      `/api/unified/chats/dev-a/${encodeURIComponent(chatJid)}/schedules?all_devices=1`,
      {token: adminToken},
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const distinctHitDevices = new Set(scheduleHits);
    assert.ok(
      distinctHitDevices.size <= 10,
      `at most 10 devices may be queried, got ${distinctHitDevices.size}`,
    );
    const returnedDevices = new Set(listData(res.body).map((row) => row.device_id));
    assert.ok(returnedDevices.size <= 10, 'returned rows cover at most 10 devices');
  });
});
