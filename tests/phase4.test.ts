import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, it} from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gowa-lite-phase4-'));
process.env.GOWA_LITE_DB_PATH = path.join(tempDir, 'test.db');

type DbModule = typeof import('../server/db.ts');
type GowaModule = typeof import('../server/gowa-client.ts');
type ChatSyncModule = typeof import('../server/services/chat-sync.ts');
type PhoneModule = typeof import('../src/lib/phone.ts');
type EventsModule = typeof import('../src/lib/events.ts');
type NotificationsModule = typeof import('../src/lib/notifications.ts');
type PaginatedChatsModule = typeof import('../src/features/chat/use-paginated-chats.ts');
type OtherAccountsModule = typeof import('../src/features/chat/other-accounts.ts');
type StatusHelpersModule = typeof import('../src/features/misc/status-helpers.ts');
type HttpModule = typeof import('../src/lib/http.ts');

let dbMod: DbModule;
let gowaMod: GowaModule;
let chatSyncMod: ChatSyncModule;
let phoneMod: PhoneModule;
let eventsMod: EventsModule;
let notificationsMod: NotificationsModule;
let paginatedChatsMod: PaginatedChatsModule;
let otherAccountsMod: OtherAccountsModule;
let statusHelpersMod: StatusHelpersModule;
let httpMod: HttpModule;

before(async () => {
  dbMod = await import('../server/db.ts');
  gowaMod = await import('../server/gowa-client.ts');
  chatSyncMod = await import('../server/services/chat-sync.ts');
  phoneMod = await import('../src/lib/phone.ts');
  eventsMod = await import('../src/lib/events.ts');
  notificationsMod = await import('../src/lib/notifications.ts');
  paginatedChatsMod = await import('../src/features/chat/use-paginated-chats.ts');
  otherAccountsMod = await import('../src/features/chat/other-accounts.ts');
  statusHelpersMod = await import('../src/features/misc/status-helpers.ts');
  httpMod = await import('../src/lib/http.ts');
});

after(() => {
  try {
    dbMod?.db.close();
  } catch {
    // ignore
  }
  fs.rmSync(tempDir, {recursive: true, force: true});
});

describe('Phase 1 Roadmap: Media Send Routing & Deep-Link JID Helpers', () => {
  it('routes image, video, audio, and document MIME types to matching GOWA endpoints', () => {
    const img = chatSyncMod.resolveGowaMediaTarget('image/jpeg; charset=utf-8', 'photo.jpg');
    assert.equal(img.endpoint, '/send/image');
    assert.equal(img.fieldName, 'image');
    assert.equal(img.mediaType, 'image');
    assert.equal(img.supportsCaption, true);
    assert.equal(img.filename, 'photo.jpg');

    const vid = chatSyncMod.resolveGowaMediaTarget('video/mp4', 'clip.mp4');
    assert.equal(vid.endpoint, '/send/video');
    assert.equal(vid.fieldName, 'video');
    assert.equal(vid.mediaType, 'video');
    assert.equal(vid.supportsCaption, true);

    const aud = chatSyncMod.resolveGowaMediaTarget('audio/ogg', 'voice.ogg');
    assert.equal(aud.endpoint, '/send/audio');
    assert.equal(aud.fieldName, 'audio');
    assert.equal(aud.mediaType, 'audio');
    assert.equal(aud.supportsCaption, false);

    const doc = chatSyncMod.resolveGowaMediaTarget('application/pdf', 'contract.pdf');
    assert.equal(doc.endpoint, '/send/file');
    assert.equal(doc.fieldName, 'file');
    assert.equal(doc.mediaType, 'document');
    assert.equal(doc.supportsCaption, true);

    const svg = chatSyncMod.resolveGowaMediaTarget('image/svg+xml', 'diagram.svg');
    assert.equal(svg.endpoint, '/send/file');
    assert.equal(svg.fieldName, 'file');
    assert.equal(svg.mediaType, 'document');
  });

  it('sanitizes traversal paths and preserves Arabic/Unicode filenames', () => {
    const arabic = chatSyncMod.resolveGowaMediaTarget('application/pdf', '../../فواتير/فاتورة يناير.pdf');
    assert.equal(arabic.filename, 'فاتورة يناير.pdf');

    const hidden = chatSyncMod.resolveGowaMediaTarget('text/plain', '..\\..\\secret.txt');
    assert.equal(hidden.filename, 'secret.txt');

    const empty = chatSyncMod.resolveGowaMediaTarget('image/png', '   ');
    assert.equal(empty.filename, 'image.png');
  });

  it('blocks dangerous executable extensions with GowaError 400 BLOCKED_FILE_TYPE', () => {
    for (const bad of ['payload.exe', 'script.BAT', 'run.ps1', 'install.msi', 'drop.sh', 'lib.dll']) {
      assert.throws(
        () => chatSyncMod.resolveGowaMediaTarget('application/octet-stream', bad),
        (err: unknown) =>
          err instanceof gowaMod.GowaError &&
          err.status === 400 &&
          err.code === 'BLOCKED_FILE_TYPE',
      );
    }
  });

  it('normalizes phone numbers, Arabic numerals, and JIDs consistently on client and server', () => {
    const cases: Array<[string, string]> = [
      ['+966 50 123 4567', '966501234567@s.whatsapp.net'],
      ['+٩٦٦ ٥٠ ١٢٣ ٤٥٦٧', '966501234567@s.whatsapp.net'],
      ['120363123456@G.US', '120363123456@g.us'],
      ['966500000000@S.WHATSAPP.NET', '966500000000@s.whatsapp.net'],
      ['abc', ''],
      ['123', ''],
      ['   ', ''],
    ];

    for (const [input, expected] of cases) {
      assert.equal(phoneMod.toWhatsAppJid(input), expected, `client toWhatsAppJid(${input})`);
      assert.equal(
        chatSyncMod.normalizeWhatsAppJid(input),
        expected,
        `server normalizeWhatsAppJid(${input})`,
      );
    }
  });
});

describe('Phase 2 Roadmap: DB Maintenance, MESSAGE_EDITED Preservation & WS Target Scoping', () => {
  it('cleans up expired sessions and stale avatars without touching active rows (DB-MAINT-01)', () => {
    const user = dbMod.createUser({
      username: 'maint-user',
      display_name: 'Maint User',
      role: 'agent',
      password: 'Password123!',
    });

    const now = 2_000_000_000_000;
    dbMod.db
      .prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run('expired-hash', user.id, now - 1000, now - 50_000);
    dbMod.db
      .prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .run('active-hash', user.id, now + 60_000, now - 1000);

    dbMod.db
      .prepare(
        `INSERT INTO contact_avatars (device_id, jid, avatar_url, image_blob, content_type, status, updated_at)
         VALUES (?, ?, '', NULL, '', 'none', ?)`,
      )
      .run('dev-1', 'old@s.whatsapp.net', now - 1000 * 60 * 60 * 24 * 45);
    dbMod.db
      .prepare(
        `INSERT INTO contact_avatars (device_id, jid, avatar_url, image_blob, content_type, status, updated_at)
         VALUES (?, ?, '', NULL, '', 'none', ?)`,
      )
      .run('dev-1', 'fresh@s.whatsapp.net', now - 1000 * 60 * 60);

    const result = dbMod.cleanupExpiredRecords({nowMs: now});
    assert.equal(result.deletedSessions, 1);
    assert.equal(result.deletedAvatars, 1);

    const remainingSession = dbMod.db
      .prepare('SELECT token_hash FROM sessions WHERE user_id = ?')
      .all(user.id) as Array<{token_hash: string}>;
    assert.deepEqual(
      remainingSession.map((r) => r.token_hash),
      ['active-hash'],
    );

    const remainingAvatars = dbMod.db
      .prepare('SELECT jid FROM contact_avatars WHERE device_id = ?')
      .all('dev-1') as Array<{jid: string}>;
    assert.deepEqual(
      remainingAvatars.map((r) => r.jid),
      ['fresh@s.whatsapp.net'],
    );
  });

  it('preserves original media, reply context, and timestamp when handling MESSAGE_EDITED (SYNC-FIX-01)', () => {
    const deviceId = 'dev-sync';
    const chatJid = '966500000111@s.whatsapp.net';
    const originalTs = '2026-11-20T10:15:00.000Z';

    dbMod.upsertCachedMessages(deviceId, chatJid, [
      {
        id: 'msg-edit-1',
        chat_jid: chatJid,
        sender_jid: '966500000111@s.whatsapp.net',
        sender_display_name: 'عميل مهم',
        content: 'فاتورة مبدئية',
        timestamp: originalTs,
        is_from_me: false,
        media_type: 'image',
        context_metadata: JSON.stringify({replied_to_id: 'msg-quoted-0'}),
        filename: 'invoice.jpg',
        url: '/media/invoice.jpg',
        file_length: 42_000,
      },
    ]);

    chatSyncMod.handleUpstreamGowaEvent(deviceId, {
      code: 'MESSAGE_EDITED',
      message: 'edited',
      result: {
        original_message_id: 'msg-edit-1',
        chat_jid: chatJid,
        body: 'فاتورة معدلة نهائية',
      },
    });

    const row = dbMod.db
      .prepare('SELECT * FROM cached_messages WHERE device_id = ? AND chat_jid = ? AND id = ?')
      .get(deviceId, chatJid, 'msg-edit-1') as {
      content: string;
      timestamp: string;
      media_type: string;
      filename: string;
      url: string;
      file_length: number;
      context_metadata: string;
      sender_display_name: string;
    };

    assert.equal(row.content, 'فاتورة معدلة نهائية');
    assert.equal(row.timestamp, originalTs);
    assert.equal(row.media_type, 'image');
    assert.equal(row.filename, 'invoice.jpg');
    assert.equal(row.url, '/media/invoice.jpg');
    assert.equal(row.file_length, 42_000);
    assert.equal(row.context_metadata, JSON.stringify({replied_to_id: 'msg-quoted-0'}));
    assert.equal(row.sender_display_name, 'عميل مهم');
  });

  it('extracts deviceId and normalized chatJid from WS event payloads for targeted invalidation (SYNC-FIX-01)', () => {
    assert.deepEqual(
      eventsMod.extractWsEventTarget({
        code: 'MESSAGE_RECEIVED',
        message: 'ok',
        device_id: 'sales-1',
        result: {payload: {from: '+966 50 111 2222', id: 'm1'}},
      }),
      {deviceId: 'sales-1', chatJid: '966501112222@s.whatsapp.net'},
    );

    assert.deepEqual(
      eventsMod.extractWsEventTarget({
        code: 'CONVERSATION_NOTE_UPDATED',
        message: 'created',
        device_id: 'sales-2',
        result: {chat_jid: '120363999@G.US', note_id: 4},
      }),
      {deviceId: 'sales-2', chatJid: '120363999@g.us'},
    );

    assert.deepEqual(
      eventsMod.extractWsEventTarget({
        code: 'LIST_DEVICES',
        message: 'ok',
        result: [{id: 'sales-1'}],
      }),
      {deviceId: undefined, chatJid: undefined},
    );
  });
});

describe('Phase 3 Roadmap: Pagination Merging, Message Actions & Unread Notifications', () => {
  it('merges paginated chats with page-0 precedence, deduplication, and newest-first sorting (CHATS-PAGINATION-01)', () => {
    const mkChat = (deviceId: string, jid: string, name: string, time: string, unread = 0) => ({
      device_id: deviceId,
      device_display_name: deviceId,
      device_state: 'logged_in' as const,
      jid,
      name,
      last_message_time: time,
      ephemeral_expiration: 0,
      created_at: time,
      updated_at: time,
      unread_count: unread,
      archived: false,
    });

    const pageZero = [
      mkChat('dev-a', '111@s.whatsapp.net', 'Latest', '2026-11-24T12:00:00Z', 2),
      mkChat('dev-a', '222@s.whatsapp.net', 'Updated Second', '2026-11-24T11:30:00Z', 0),
    ];
    const extraPages = [
      mkChat('dev-a', '222@s.whatsapp.net', 'Stale Second', '2026-11-24T09:00:00Z', 5),
      mkChat('dev-b', '333@s.whatsapp.net', 'Older Chat', '2026-11-24T10:00:00Z', 1),
    ];

    const merged = paginatedChatsMod.mergePaginatedChats(pageZero, extraPages);
    assert.equal(merged.length, 3);
    assert.deepEqual(
      merged.map((c) => `${c.device_id}:${c.jid}:${c.name}:${c.unread_count}`),
      [
        'dev-a:111@s.whatsapp.net:Latest:2',
        'dev-a:222@s.whatsapp.net:Updated Second:0',
        'dev-b:333@s.whatsapp.net:Older Chat:1',
      ],
    );
  });

  it('retrieves cached messages and marks them revoked with metadata preserved (MSG-ACTIONS-01)', () => {
    const deviceId = 'dev-actions';
    const chatJid = '966500000999@s.whatsapp.net';
    dbMod.upsertCachedMessages(deviceId, chatJid, [
      {
        id: 'msg-act-1',
        chat_jid: chatJid,
        sender_jid: 'me@s.whatsapp.net',
        content: 'عرض السعر المرفق',
        timestamp: '2026-11-24T08:00:00.000Z',
        is_from_me: true,
        media_type: 'document',
        filename: 'quote.pdf',
        url: '/media/quote.pdf',
        file_length: 12_345,
      },
    ]);

    const beforeRevoke = dbMod.getCachedMessage(deviceId, chatJid, 'msg-act-1');
    assert.ok(beforeRevoke);
    assert.equal(beforeRevoke.content, 'عرض السعر المرفق');
    assert.equal(beforeRevoke.is_revoked, undefined);

    const otherChat = '966500000998@s.whatsapp.net';
    dbMod.markCachedMessageRevoked(deviceId, 'msg-act-1', {chatJid: otherChat});
    assert.equal(dbMod.getCachedMessage(deviceId, chatJid, 'msg-act-1')?.is_revoked, undefined);
    assert.equal(dbMod.getCachedMessage(deviceId, otherChat, 'msg-act-1')?.is_revoked, true);

    dbMod.markCachedMessageRevoked(deviceId, 'msg-act-1', {
      chatJid,
      revokedBy: 'me@s.whatsapp.net',
    });

    const afterRevoke = dbMod.getCachedMessage(deviceId, chatJid, 'msg-act-1');
    assert.ok(afterRevoke);
    assert.equal(afterRevoke.is_revoked, true);
    assert.equal(afterRevoke.revoked_by, 'me@s.whatsapp.net');
    assert.equal(dbMod.getCachedMessage(deviceId, chatJid, 'missing-id'), null);
  });

  it('infers MIME types reliably for forwarding media across accounts (MSG-ACTIONS-01)', () => {
    assert.equal(
      chatSyncMod.inferForwardMimeType('document', 'report.pdf', 'application/pdf; charset=binary'),
      'application/pdf',
    );
    assert.equal(
      chatSyncMod.inferForwardMimeType('document', 'archive.pdf', 'application/octet-stream'),
      'application/pdf',
    );
    assert.equal(chatSyncMod.inferForwardMimeType('image', 'no-ext', ''), 'image/jpeg');
    assert.equal(chatSyncMod.inferForwardMimeType('video', 'clip', ''), 'video/mp4');
    assert.equal(chatSyncMod.inferForwardMimeType('ptt', 'voice', ''), 'audio/ogg');
    assert.equal(chatSyncMod.inferForwardMimeType('document', 'unknown.bin', ''), 'application/octet-stream');
  });

  it('formats browser tab unread titles and extracts incoming alert payloads safely (UX-NOTIFY-01)', () => {
    assert.equal(notificationsMod.formatUnreadTabTitle(0, 'gowa-lite'), 'gowa-lite');
    assert.equal(notificationsMod.formatUnreadTabTitle(7, 'gowa-lite'), '(7) gowa-lite');
    assert.equal(notificationsMod.formatUnreadTabTitle(142, 'gowa-lite'), '(99+) gowa-lite');

    // Ignores outgoing, revoked, newsletter, and missing IDs
    assert.equal(
      notificationsMod.extractIncomingAlertData({
        code: 'MESSAGE_RECEIVED',
        message: 'ok',
        device_id: 'dev-1',
        result: {payload: {id: 'm1', from: '966500000111@s.whatsapp.net', is_from_me: true, body: 'hi'}},
      }),
      null,
    );
    assert.equal(
      notificationsMod.extractIncomingAlertData({
        code: 'MESSAGE_RECEIVED',
        message: 'ok',
        device_id: 'dev-1',
        result: {payload: {id: 'm2', from: '12036399@newsletter', is_from_me: false, body: 'news'}},
      }),
      null,
    );
    assert.equal(
      notificationsMod.extractIncomingAlertData({
        code: 'MESSAGE_RECEIVED',
        message: 'ok',
        device_id: 'dev-1',
        result: {payload: {id: 'm3', from: '966500000111@s.whatsapp.net', is_revoked: true}},
      }),
      null,
    );

    const validAlert = notificationsMod.extractIncomingAlertData({
      code: 'MESSAGE_RECEIVED',
      message: 'ok',
      device_id: 'sales-main',
      result: {
        payload: {
          id: 'm4',
          from: '+966 50 111 2222',
          pushname: 'أحمد العتيبي',
          image: {caption: 'وصل التحويل'},
        },
      },
    });
    assert.deepEqual(validAlert, {
      messageId: 'm4',
      deviceId: 'sales-main',
      chatJid: '966501112222@s.whatsapp.net',
      senderName: 'أحمد العتيبي',
      body: 'وصل التحويل',
      mediaType: 'image',
    });
  });

  it('rejects non-JSON HTML/empty 2xx payloads in unwrapApiResults instead of returning null (AUTH-FIX-01)', () => {
    for (const badPayload of ['<!doctype html><html></html>', '', null, undefined, ['unexpected'], {unexpected: true}]) {
      assert.throws(
        () => httpMod.unwrapApiResults(badPayload, 200),
        (err: unknown) =>
          typeof err === 'object' &&
          err !== null &&
          (err as {code?: string}).code === 'INVALID_RESPONSE' &&
          typeof (err as {message?: string}).message === 'string',
      );
    }

    assert.deepEqual(
      httpMod.unwrapApiResults<{token: string}>({code: 'SUCCESS', message: 'ok', results: {token: 'abc'}}, 200),
      {token: 'abc'},
    );
    assert.equal(httpMod.unwrapApiResults<null>({code: 'SUCCESS', message: 'ok', results: null}, 200), null);
  });

  it('detects cross-account overlapping chats while excluding self, newsletters, and status@broadcast (CHAT-OVERLAP-01)', () => {
    const map = otherAccountsMod.buildJidAccountsMap([
      {device_id: 'sales-1', device_display_name: 'مبيعات 1', jid: '966501112222@c.us'},
      {device_id: 'support-2', device_display_name: 'دعم 2', jid: '966501112222@s.whatsapp.net'},
      {device_id: 'vip-3', device_display_name: 'VIP 3', jid: '966501112222@S.WHATSAPP.NET'},
      {device_id: 'sales-1', device_display_name: 'مبيعات 1', jid: '966509998888@s.whatsapp.net'},
      {device_id: 'sales-1', device_display_name: 'مبيعات 1', jid: 'status@broadcast'},
      {device_id: 'support-2', device_display_name: 'دعم 2', jid: 'status@broadcast'},
      {device_id: 'sales-1', device_display_name: 'مبيعات 1', jid: '120363000@newsletter'},
      {device_id: 'support-2', device_display_name: 'دعم 2', jid: '120363000@newsletter'},
    ]);

    assert.deepEqual(
      otherAccountsMod.getOtherAccountsForChat(map, 'sales-1', '966501112222@s.whatsapp.net'),
      [
        {device_id: 'vip-3', device_display_name: 'VIP 3'},
        {device_id: 'support-2', device_display_name: 'دعم 2'},
      ],
    );
    assert.deepEqual(
      otherAccountsMod.getOtherAccountsForChat(map, 'sales-1', '966509998888@s.whatsapp.net'),
      [],
    );
    assert.deepEqual(otherAccountsMod.getOtherAccountsForChat(map, 'sales-1', 'status@broadcast'), []);
    assert.deepEqual(
      otherAccountsMod.getOtherAccountsForChat(map, 'sales-1', '120363000@newsletter'),
      [],
    );
  });

  it('filters status@broadcast out of inbox & incoming chat alerts and groups multi-account Status items (MISC-STATUS-01)', () => {
    assert.equal(chatSyncMod.isStatusBroadcastJid('status@broadcast'), true);
    assert.equal(chatSyncMod.isStatusBroadcastJid(' STATUS@BROADCAST '), true);
    assert.equal(chatSyncMod.isStatusBroadcastJid('966501112222@s.whatsapp.net'), false);

    assert.equal(
      notificationsMod.extractIncomingAlertData({
        code: 'MESSAGE_RECEIVED',
        message: 'ok',
        device_id: 'sales-1',
        result: {
          payload: {
            id: 'status-msg-1',
            chat_jid: 'status@broadcast',
            from: '966501112222@s.whatsapp.net',
            body: 'عرض اليوم',
          },
        },
      }),
      null,
    );

    const groups = statusHelpersMod.groupStatusesByContact([
      {
        id: 'st-1',
        chat_jid: 'status@broadcast',
        sender_jid: '966501112222@s.whatsapp.net',
        sender_display_name: 'عميل أ',
        content: 'الحالة الأقدم',
        timestamp: '2026-11-24T08:00:00.000Z',
        is_from_me: false,
        media_type: 'text',
        filename: '',
        url: '',
        file_length: 0,
        device_id: 'sales-1',
        device_display_name: 'مبيعات 1',
        device_state: 'logged_in',
      },
      {
        id: 'st-2',
        chat_jid: 'status@broadcast',
        sender_jid: '966501112222@s.whatsapp.net',
        sender_display_name: 'عميل أ',
        content: 'الحالة الأحدث',
        timestamp: '2026-11-24T10:30:00.000Z',
        is_from_me: false,
        media_type: 'image',
        filename: 'promo.jpg',
        url: '/media/promo.jpg',
        file_length: 1024,
        device_id: 'sales-1',
        device_display_name: 'مبيعات 1',
        device_state: 'logged_in',
      },
      {
        id: 'st-3',
        chat_jid: 'status@broadcast',
        sender_jid: '966501112222@s.whatsapp.net',
        sender_display_name: 'عميل أ',
        content: 'على الحساب الثاني',
        timestamp: '2026-11-24T09:15:00.000Z',
        is_from_me: false,
        media_type: 'video',
        filename: 'clip.mp4',
        url: '/media/clip.mp4',
        file_length: 2048,
        device_id: 'support-2',
        device_display_name: 'دعم 2',
        device_state: 'logged_in',
      },
    ]);

    assert.equal(groups.length, 2);
    assert.equal(groups[0].device_id, 'sales-1');
    assert.deepEqual(
      groups[0].items.map((item) => item.id),
      ['st-2', 'st-1'],
    );
    assert.equal(groups[1].device_id, 'support-2');

    assert.equal(statusHelpersMod.filterStatusGroups(groups, 'support-2', '').length, 1);
    assert.equal(statusHelpersMod.filterStatusGroups(groups, 'all', '٠٥٠١١١').length, 2);
    assert.equal(statusHelpersMod.filterStatusGroups(groups, 'all', 'الحساب الثاني').length, 1);
  });
});
