import './phase5-system-lines-dom.ts';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHmac} from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {after, afterEach, before, describe, it} from 'node:test';
import React, {act, createElement as el} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {LifecycleTimelineLine} from '../src/features/chat/lifecycle-timeline-line.tsx';
import type {ChatLifecycleEvent} from '../src/api/contracts/workflow.ts';
import {useAuthStore} from '../src/stores/auth.ts';

const NEW_EVENT_TYPES = [
  'note_added',
  'note_edited',
  'note_deleted',
  'schedule_created',
  'schedule_paused',
  'schedule_resumed',
  'schedule_cancelled',
  'message_revoked',
  'message_edited',
  'rating_submitted',
] as const;

const OLD_EVENT_TYPES = [
  'claimed',
  'auto_claimed',
  'assigned',
  'transferred',
  'released',
  'closed',
  'reopened',
  'reopened_by_customer',
] as const;

function makeEvent(
  eventType: ChatLifecycleEvent['event_type'],
  overrides: Partial<ChatLifecycleEvent> = {},
): ChatLifecycleEvent {
  return {
    id: 1,
    device_id: 'dev-1',
    chat_jid: '966500000001@s.whatsapp.net',
    event_type: eventType,
    actor_user_id: 7,
    actor_name: 'سارة علي',
    target_user_id: null,
    target_name: '',
    note: '',
    created_at: '2026-11-25T08:30:00.000Z',
    created_at_ms: Date.parse('2026-11-25T08:30:00.000Z'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Unit: server-side recording helper + gateway-driven events
// ---------------------------------------------------------------------------
describe('P2-11 unit: action lifecycle events are recorded server-side', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gowa-lite-system-lines-unit-'));
  const unitDbPath = path.join(tmpDir, 'unit.db');

  let dbMod: typeof import('../server/db.ts');
  let lifecycleRepoMod: typeof import('../server/db/lifecycle-repo.ts');
  let syncMod: typeof import('../server/services/chat-sync.ts');
  let ownershipMod: typeof import('../server/services/schedule-ownership.ts');

  before(async () => {
    process.env.GOWA_LITE_DB_PATH = unitDbPath;
    dbMod = await import('../server/db.ts');
    lifecycleRepoMod = await import('../server/db/lifecycle-repo.ts');
    syncMod = await import('../server/services/chat-sync.ts');
    ownershipMod = await import('../server/services/schedule-ownership.ts');
  });

  after(() => {
    dbMod?.closeDatabaseSafely();
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  it('records every new action event type with actor, target and note', () => {
    const roles = dbMod.listRoles();
    const agentRole = roles.find((r) => r.slug === 'agent')!;
    const actor = dbMod.createUser({
      username: 'sara',
      display_name: 'سارة علي',
      role: 'agent',
      role_id: agentRole.id,
      allowed_device_ids: ['dev-1'],
      password: 'Password123',
    });
    const jid = '966500000001@s.whatsapp.net';
    for (const eventType of NEW_EVENT_TYPES) {
      const event = lifecycleRepoMod.recordChatActionEvent({
        deviceId: 'dev-1',
        chatJid: jid,
        eventType,
        actorUserId: actor.id,
        actorName: 'سارة علي',
        targetName: eventType === 'note_added' ? '' : undefined,
        note: eventType === 'rating_submitted' ? '5' : 'ملاحظة تجريبية',
      });
      assert.ok(event, `${eventType} must be recorded`);
      assert.equal(event.event_type, eventType);
      assert.equal(event.actor_user_id, actor.id);
      assert.equal(event.actor_name, 'سارة علي');
      assert.equal(event.device_id, 'dev-1');
      assert.equal(event.chat_jid, jid);
    }
    const rows = lifecycleRepoMod.listChatLifecycleEventRows('dev-1', jid);
    assert.equal(rows.length, NEW_EVENT_TYPES.length);
    for (const eventType of NEW_EVENT_TYPES) {
      assert.ok(
        rows.some((row) => row.event_type === eventType),
        `missing ${eventType} row`,
      );
    }
  });

  it('records nothing for groups, newsletters and status broadcasts (no noise)', () => {
    const beforeCount = lifecycleRepoMod.listChatLifecycleEventRows(
      'dev-1',
      '966500000001@s.whatsapp.net',
    ).length;
    for (const chatJid of [
      '120363012345@g.us',
      '120363001234@newsletter',
      'status@broadcast',
    ]) {
      const event = lifecycleRepoMod.recordChatActionEvent({
        deviceId: 'dev-1',
        chatJid,
        eventType: 'note_added',
        actorUserId: 7,
        actorName: 'سارة علي',
      });
      assert.equal(event, null, `${chatJid} must not produce an event`);
    }
    assert.equal(
      lifecycleRepoMod.listChatLifecycleEventRows('dev-1', '966500000001@s.whatsapp.net').length,
      beforeCount,
    );
  });

  it('stores the schedule chat_jid in ownership and copies it on reschedule transfer', async () => {
    const created = await ownershipMod.recordCreatedScheduleOwnership(
      'dev-1',
      {phone: '966501111111', message: 'تذكير', scheduled_at: '2026-11-29T10:00:00Z'},
      {schedule_id: 'sch-1'},
      {id: 7, display_name: 'سارة علي'},
    );
    assert.equal(created, 'sch-1');
    assert.equal(
      ownershipMod.getScheduleChatJid('dev-1', 'sch-1'),
      '966501111111@s.whatsapp.net',
    );
    ownershipMod.transferScheduleOwnership('dev-1', 'sch-1', 'sch-2');
    assert.equal(
      ownershipMod.getScheduleChatJid('dev-1', 'sch-2'),
      '966501111111@s.whatsapp.net',
    );
    assert.equal(ownershipMod.getScheduleChatJid('dev-1', 'sch-1'), null);
  });

  it('records message_edited once per real edit and ignores replays', () => {
    const jid = '966500000002@s.whatsapp.net';
    dbMod.upsertCachedMessages('dev-1', jid, [
      {
        id: 'm-1',
        chat_jid: jid,
        sender_jid: jid,
        sender_display_name: 'عميل التحرير',
        content: 'النص الأصلي',
        timestamp: new Date().toISOString(),
        is_from_me: false,
        media_type: '',
        filename: '',
        url: '',
        file_length: 0,
      },
    ]);
    const editedEvent = (body: string) => ({
      code: 'MESSAGE_EDITED',
      message: '',
      result: {
        original_message_id: 'm-1',
        chat_id: jid,
        from: jid,
        sender_display_name: 'عميل التحرير',
        content: body,
        timestamp: new Date().toISOString(),
        is_from_me: false,
      },
    });
    const countEdits = () =>
      lifecycleRepoMod
        .listChatLifecycleEventRows('dev-1', jid)
        .filter((row) => row.event_type === 'message_edited').length;

    syncMod.handleUpstreamGowaEvent('dev-1', editedEvent('النص المعدّل'));
    assert.equal(countEdits(), 1);
    const first = lifecycleRepoMod
      .listChatLifecycleEventRows('dev-1', jid)
      .find((row) => row.event_type === 'message_edited');
    assert.equal(first?.actor_name, 'عميل التحرير');

    // Exact replay of the same edit (WS + webhook double delivery): no dup.
    syncMod.handleUpstreamGowaEvent('dev-1', editedEvent('النص المعدّل'));
    assert.equal(countEdits(), 1);

    // A genuinely different edit is a new event.
    syncMod.handleUpstreamGowaEvent('dev-1', editedEvent('النص المعدّل مرة أخرى'));
    assert.equal(countEdits(), 2);

    // Group edits never produce a system line.
    syncMod.handleUpstreamGowaEvent('dev-1', {
      code: 'MESSAGE_EDITED',
      message: '',
      result: {
        original_message_id: 'm-g-1',
        chat_id: '120363012345@g.us',
        from: '966500000009@s.whatsapp.net',
        sender_display_name: 'عضو المجموعة',
        content: 'تعديل جماعي',
        timestamp: new Date().toISOString(),
        is_from_me: false,
      },
    });
    assert.equal(
      lifecycleRepoMod.listChatLifecycleEventRows('dev-1', '120363012345@g.us').length,
      0,
    );
  });
});

// ---------------------------------------------------------------------------
// HTTP integration: every action group produces a lifecycle event + system line
// ---------------------------------------------------------------------------
describe('P2-11 HTTP: notes, schedules, revoke, rating and edits record events', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gowa-lite-system-lines-int-'));
  const dbPath = path.join(tmpDir, 'int.db');
  const webhookSecret = 'system-lines-fixture-secret';

  let mockGowaServer: http.Server;
  let mockGowaPort = 0;
  let appPort = 0;
  let baseUrl = '';
  let serverProc: ReturnType<typeof spawn> | null = null;
  let serverLogs = '';
  let sentCounter = 0;
  let scheduleCounter = 0;

  const chat1Jid = '966501111111@s.whatsapp.net';
  const chat2Jid = '966502222222@s.whatsapp.net';
  const deviceJid = '966500000001@s.whatsapp.net';

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

  async function getLifecycleEvents(jid: string, token: string) {
    const res = await api(
      `/api/unified/chats/dev-alpha/${encodeURIComponent(jid)}/lifecycle`,
      {token},
    );
    assert.equal(res.status, 200, `lifecycle fetch failed: ${JSON.stringify(res.body)}`);
    return (res.body?.results as {events: Array<{event_type: string; actor_name: string; note: string}>}).events;
  }

  function countEvents(events: Array<{event_type: string}>, type: string): number {
    return events.filter((e) => e.event_type === type).length;
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
          {jid: chat2Jid, name: 'Customer Two', last_message_time: '2026-11-24T00:50:00Z', archived: false},
        ], pagination: {limit: 50, offset: 0, total: 2}}}));
        return;
      }
      if (/^\/chat\/[^/]+\/messages$/.test(url.pathname) && req.method === 'GET') {
        res.end(JSON.stringify({code: 'SUCCESS', message: 'ok', results: {
          data: [], pagination: {limit: 40, offset: 0, total: 0}, chat_info: {},
        }}));
        return;
      }
      if (url.pathname === '/send/message' && req.method === 'POST') {
        let raw = '';
        req.setEncoding('utf8');
        req.on('data', (chunk: string) => { raw += chunk; });
        req.on('end', () => {
          const body = JSON.parse(raw) as Record<string, unknown>;
          if (body.scheduled_at) {
            scheduleCounter += 1;
            res.end(JSON.stringify({code: 'SUCCESS', message: 'ok', results: {schedule_id: `sch-${scheduleCounter}`}}));
          } else {
            sentCounter += 1;
            res.end(JSON.stringify({code: 'SUCCESS', message: 'ok', results: {message_id: `sent-${sentCounter}`, status: 'sent'}}));
          }
        });
        return;
      }
      if (/^\/send\/schedules\/[^/]+\/(pause|resume|cancel)$/.test(url.pathname) && req.method === 'POST') {
        res.end(JSON.stringify({code: 'SUCCESS', message: 'ok', results: {}}));
        return;
      }
      if (/^\/message\/[^/]+\/revoke$/.test(url.pathname) && req.method === 'POST') {
        res.end(JSON.stringify({code: 'SUCCESS', message: 'ok', results: {}}));
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
    while (Date.now() - startedAt < 20000) {
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

  it('records note/schedule/revoke/rating/edit events with actor names', async () => {
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

    // Claim chat1 so note/schedule/revoke content access is allowed.
    const claim = await api(`/api/unified/chats/dev-alpha/${encodeURIComponent(chat1Jid)}/claim`, {
      method: 'POST',
      token: saraToken,
    });
    assert.equal(claim.status, 200, JSON.stringify(claim.body));

    // 1. Notes: add / edit / pin-only (no event) / delete.
    const noteRes = await api(`/api/unified/chats/dev-alpha/${encodeURIComponent(chat1Jid)}/notes`, {
      method: 'POST',
      token: saraToken,
      body: JSON.stringify({content: 'عميل VIP — اتصل به غداً'}),
    });
    assert.equal(noteRes.status, 201, JSON.stringify(noteRes.body));
    const noteId = (noteRes.body?.results as {id: number}).id;
    let events = await getLifecycleEvents(chat1Jid, saraToken);
    assert.equal(countEvents(events, 'note_added'), 1);
    assert.equal(events.find((e) => e.event_type === 'note_added')?.actor_name, 'Sara Alpha');

    const editRes = await api(`/api/unified/chats/dev-alpha/${encodeURIComponent(chat1Jid)}/notes/${noteId}`, {
      method: 'PATCH',
      token: saraToken,
      body: JSON.stringify({content: 'عميل VIP — اتصل به بعد غد'}),
    });
    assert.equal(editRes.status, 200, JSON.stringify(editRes.body));
    events = await getLifecycleEvents(chat1Jid, saraToken);
    assert.equal(countEvents(events, 'note_edited'), 1);
    assert.equal(events.find((e) => e.event_type === 'note_edited')?.actor_name, 'Sara Alpha');

    const pinRes = await api(`/api/unified/chats/dev-alpha/${encodeURIComponent(chat1Jid)}/notes/${noteId}`, {
      method: 'PATCH',
      token: saraToken,
      body: JSON.stringify({is_pinned: true}),
    });
    assert.equal(pinRes.status, 200, JSON.stringify(pinRes.body));
    events = await getLifecycleEvents(chat1Jid, saraToken);
    assert.equal(countEvents(events, 'note_edited'), 1, 'pin-only change must not add a line');

    const delRes = await api(`/api/unified/chats/dev-alpha/${encodeURIComponent(chat1Jid)}/notes/${noteId}`, {
      method: 'DELETE',
      token: saraToken,
    });
    assert.equal(delRes.status, 200, JSON.stringify(delRes.body));
    events = await getLifecycleEvents(chat1Jid, saraToken);
    assert.equal(countEvents(events, 'note_deleted'), 1);
    assert.equal(events.find((e) => e.event_type === 'note_deleted')?.actor_name, 'Sara Alpha');

    // 2. Schedules from the chat drawer: create / pause / resume / cancel.
    const future = new Date(Date.now() + 2 * 3_600_000).toISOString();
    const schedRes = await api(`/api/unified/chats/dev-alpha/${encodeURIComponent(chat1Jid)}/schedules`, {
      method: 'POST',
      token: saraToken,
      body: JSON.stringify({message: 'تذكير بالدفع', scheduled_at: future, recurrence: 'once', timezone: 'Asia/Riyadh'}),
    });
    assert.equal(schedRes.status, 201, JSON.stringify(schedRes.body));
    const scheduleId = (schedRes.body?.results as {schedule_id: string}).schedule_id;
    assert.ok(scheduleId, 'gateway must return a schedule id');
    events = await getLifecycleEvents(chat1Jid, saraToken);
    assert.equal(countEvents(events, 'schedule_created'), 1);
    assert.equal(events.find((e) => e.event_type === 'schedule_created')?.actor_name, 'Sara Alpha');

    for (const [action, type] of [
      ['pause', 'schedule_paused'],
      ['resume', 'schedule_resumed'],
      ['cancel', 'schedule_cancelled'],
    ] as const) {
      const actionRes = await api(
        `/api/unified/chats/dev-alpha/${encodeURIComponent(chat1Jid)}/schedules/${encodeURIComponent(scheduleId)}/${action}`,
        {method: 'POST', token: saraToken},
      );
      assert.equal(actionRes.status, 200, `${action} failed: ${JSON.stringify(actionRes.body)}`);
      events = await getLifecycleEvents(chat1Jid, saraToken);
      assert.equal(countEvents(events, type), 1, `${type} missing after ${action}`);
      assert.equal(events.find((e) => e.event_type === type)?.actor_name, 'Sara Alpha');
    }

    // 3. Schedules page (no chat in the URL): create + pause resolve the chat
    // from the payload / ownership record.
    const pageSchedRes = await api('/api/devices/dev-alpha/schedules', {
      method: 'POST',
      token: saraToken,
      body: JSON.stringify({phone: '966502222222', message: 'متابعة', scheduled_at: future, recurrence: 'once'}),
    });
    assert.equal(pageSchedRes.status, 201, JSON.stringify(pageSchedRes.body));
    const pageScheduleId = (pageSchedRes.body?.results as {schedule_id: string}).schedule_id;
    assert.ok(pageScheduleId, 'page create must return a schedule id');
    let events2 = await getLifecycleEvents(chat2Jid, saraToken);
    assert.equal(countEvents(events2, 'schedule_created'), 1);
    assert.equal(events2.find((e) => e.event_type === 'schedule_created')?.actor_name, 'Sara Alpha');

    const pagePause = await api(`/api/devices/dev-alpha/schedules/${encodeURIComponent(pageScheduleId)}/pause`, {
      method: 'POST',
      token: saraToken,
    });
    assert.equal(pagePause.status, 200, JSON.stringify(pagePause.body));
    events2 = await getLifecycleEvents(chat2Jid, saraToken);
    assert.equal(countEvents(events2, 'schedule_paused'), 1);

    // 4. Revoke: send a message, then revoke it from the UI.
    const sendRes = await api(`/api/unified/chats/dev-alpha/${encodeURIComponent(chat1Jid)}/send`, {
      method: 'POST',
      token: saraToken,
      body: JSON.stringify({message: 'رسالة ستُسحب'}),
    });
    assert.equal(sendRes.status, 200, JSON.stringify(sendRes.body));
    const sentId = (sendRes.body?.results as {message_id: string}).message_id;
    const revokeRes = await api(
      `/api/unified/chats/dev-alpha/${encodeURIComponent(chat1Jid)}/messages/${encodeURIComponent(sentId)}/revoke`,
      {method: 'POST', token: saraToken},
    );
    assert.equal(revokeRes.status, 200, JSON.stringify(revokeRes.body));
    events = await getLifecycleEvents(chat1Jid, saraToken);
    assert.equal(countEvents(events, 'message_revoked'), 1);
    assert.equal(events.find((e) => e.event_type === 'message_revoked')?.actor_name, 'Sara Alpha');

    // 5. Rating: enable prompts, close chat2, customer replies '5'.
    const ratingOn = await api('/api/devices/dev-alpha/close-ratings', {
      method: 'PUT',
      token: adminToken,
      body: JSON.stringify({enabled: true}),
    });
    assert.equal(ratingOn.status, 200, JSON.stringify(ratingOn.body));
    const closeRes = await api(`/api/unified/chats/dev-alpha/${encodeURIComponent(chat2Jid)}/close`, {
      method: 'POST',
      token: saraToken,
      body: JSON.stringify({reason: 'Done'}),
    });
    assert.equal(closeRes.status, 200, JSON.stringify(closeRes.body));
    assert.equal((closeRes.body?.results as {rating_prompt?: string}).rating_prompt, 'sent');

    const ratingWebhook = await postWebhook('message', {
      id: 'rating-1',
      body: '5',
      from: chat2Jid,
      chat_id: chat2Jid,
      sender_display_name: 'عميل التقييم',
      is_from_me: false,
      timestamp: new Date().toISOString(),
    });
    assert.equal(ratingWebhook.status, 204, await ratingWebhook.text());
    // Chat2 is closed: an agent's lifecycle read redacts event notes, so
    // the score is asserted through the admin (supervisor-view) read.
    events2 = await getLifecycleEvents(chat2Jid, adminToken);
    assert.equal(countEvents(events2, 'rating_submitted'), 1);
    const ratingEvent = events2.find((e) => e.event_type === 'rating_submitted');
    assert.equal(ratingEvent?.actor_name, 'عميل التقييم');
    assert.ok(ratingEvent?.note.includes('5'), `rating note must carry the score, got ${ratingEvent?.note}`);

    // Duplicate rating reply: no second line.
    const dupWebhook = await postWebhook('message', {
      id: 'rating-1',
      body: '5',
      from: chat2Jid,
      chat_id: chat2Jid,
      sender_display_name: 'عميل التقييم',
      is_from_me: false,
      timestamp: new Date().toISOString(),
    });
    assert.equal(dupWebhook.status, 204);
    events2 = await getLifecycleEvents(chat2Jid, adminToken);
    assert.equal(countEvents(events2, 'rating_submitted'), 1, 'duplicate rating must not add a line');

    // 6. Message edit via gateway webhook: one line per real edit, replays ignored.
    const editWebhook = await postWebhook('message.edited', {
      original_message_id: 'm-orig-1',
      body: 'النص المعدّل',
      from: chat1Jid,
      chat_id: chat1Jid,
      sender_display_name: 'عميل التحرير',
      is_from_me: false,
      timestamp: new Date().toISOString(),
    });
    assert.equal(editWebhook.status, 204, await editWebhook.text());
    events = await getLifecycleEvents(chat1Jid, saraToken);
    assert.equal(countEvents(events, 'message_edited'), 1);
    assert.equal(events.find((e) => e.event_type === 'message_edited')?.actor_name, 'عميل التحرير');

    const replayWebhook = await postWebhook('message.edited', {
      original_message_id: 'm-orig-1',
      body: 'النص المعدّل',
      from: chat1Jid,
      chat_id: chat1Jid,
      sender_display_name: 'عميل التحرير',
      is_from_me: false,
      timestamp: new Date().toISOString(),
    });
    assert.equal(replayWebhook.status, 204);
    events = await getLifecycleEvents(chat1Jid, saraToken);
    assert.equal(countEvents(events, 'message_edited'), 1, 'replayed edit must not add a line');

    const secondEditWebhook = await postWebhook('message.edited', {
      original_message_id: 'm-orig-1',
      body: 'النص المعدّل مرة أخرى',
      from: chat1Jid,
      chat_id: chat1Jid,
      sender_display_name: 'عميل التحرير',
      is_from_me: false,
      timestamp: new Date().toISOString(),
    });
    assert.equal(secondEditWebhook.status, 204);
    events = await getLifecycleEvents(chat1Jid, saraToken);
    assert.equal(countEvents(events, 'message_edited'), 2, 'a different edit is a new line');
  });
});

// ---------------------------------------------------------------------------
// DOM: every system line (old 8 + new 9) renders name + full date-time
// ---------------------------------------------------------------------------
describe('P2-11 DOM: system lines show actor and full date-time', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  async function render(element: React.ReactElement) {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
      root = null;
    }
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(element);
    });
    return container;
  }

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
      root = null;
    }
    document.body.innerHTML = '';
    useAuthStore.setState({user: null, status: 'unauthenticated', language: 'ar'});
  });

  it('renders all 17 event types with the actor name and a full date-time', async () => {
    useAuthStore.setState({user: null, status: 'unauthenticated', language: 'ar'});
    for (const eventType of [...OLD_EVENT_TYPES, ...NEW_EVENT_TYPES]) {
      const note = eventType === 'rating_submitted' ? '5' : '';
      const domNode = await render(
        el(LifecycleTimelineLine, {event: makeEvent(eventType, {note})}),
      );
      const text = domNode.textContent ?? '';
      assert.ok(text.length > 0, `${eventType} must render text`);
      // Full date-time inside the line itself: day + month + year + time.
      // (The old formatShortTime showed time-only for today and date-only
      // otherwise — a ':' proves the time is present alongside the date.)
      assert.ok(text.includes('نوفمبر'), `${eventType} must show the month: ${text}`);
      assert.ok(text.includes('2026'), `${eventType} must show the year: ${text}`);
      assert.ok(text.includes('25'), `${eventType} must show the day: ${text}`);
      assert.ok(text.includes(':'), `${eventType} must show the time: ${text}`);
      if (eventType !== 'reopened_by_customer') {
        assert.ok(text.includes('سارة علي'), `${eventType} must show the actor: ${text}`);
      }
    }
  });

  it('renders the Arabic wording for the new action types', async () => {
    useAuthStore.setState({user: null, status: 'unauthenticated', language: 'ar'});
    const cases: Array<{type: ChatLifecycleEvent['event_type']; fragment: string}> = [
      {type: 'note_added', fragment: 'أضاف سارة علي ملاحظة'},
      {type: 'note_edited', fragment: 'عدّل سارة علي ملاحظة'},
      {type: 'note_deleted', fragment: 'حذف سارة علي ملاحظة'},
      {type: 'schedule_created', fragment: 'جدول سارة علي رسالة'},
      {type: 'schedule_paused', fragment: 'أوقف سارة علي رسالة مجدولة'},
      {type: 'schedule_resumed', fragment: 'استأنف سارة علي رسالة مجدولة'},
      {type: 'schedule_cancelled', fragment: 'ألغى سارة علي رسالة مجدولة'},
      {type: 'message_revoked', fragment: 'سحب سارة علي رسالة'},
      {type: 'message_edited', fragment: 'عدّل سارة علي رسالة'},
      {type: 'rating_submitted', fragment: 'قيّم سارة علي المحادثة بـ 5/5'},
    ];
    for (const {type, fragment} of cases) {
      const note = type === 'rating_submitted' ? '5' : '';
      const domNode = await render(el(LifecycleTimelineLine, {event: makeEvent(type, {note})}));
      assert.ok(
        (domNode.textContent ?? '').includes(fragment),
        `${type} must render "${fragment}", got "${domNode.textContent ?? ''}"`,
      );
    }
  });

  it('renders an actor-less edit and an anonymous rating without a dangling name', async () => {
    useAuthStore.setState({user: null, status: 'unauthenticated', language: 'ar'});
    const edited = await render(
      el(LifecycleTimelineLine, {event: makeEvent('message_edited', {actor_name: ''})}),
    );
    assert.ok((edited.textContent ?? '').includes('تم تعديل رسالة'));
    const rated = await render(
      el(LifecycleTimelineLine, {event: makeEvent('rating_submitted', {actor_name: '', note: '4'})}),
    );
    assert.ok((rated.textContent ?? '').includes('قيّم العميل المحادثة بـ 4/5'));
  });

  it('keeps the old eight lines on the full date-time (no time-only regression)', async () => {
    useAuthStore.setState({user: null, status: 'unauthenticated', language: 'ar'});
    // A same-day event: the old formatShortTime showed time-only here.
    const todayIso = new Date().toISOString();
    const domNode = await render(
      el(LifecycleTimelineLine, {
        event: makeEvent('claimed', {
          created_at: todayIso,
          created_at_ms: Date.parse(todayIso),
        }),
      }),
    );
    const text = domNode.textContent ?? '';
    assert.ok(
      text.includes(String(new Date().getFullYear())),
      `same-day line must still show the year: ${text}`,
    );
    assert.ok(text.includes(':'), `same-day line must show the time: ${text}`);
  });
});
