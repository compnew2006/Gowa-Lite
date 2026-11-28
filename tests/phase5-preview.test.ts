import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, it} from 'node:test';
import type {GowaDevice} from '../server/gowa-client.ts';
import type {PublicUser} from '../server/db/auth-repo.ts';
import {resolveChatPreview} from '../src/lib/chat-preview.ts';

// Phase 5 path B — P2-2: last-message preview in the chat list.
//
// Server: one batched query over cached_messages adds last_message_text (+
// last_message_type) to every chat in the list response — no N+1.
// Frontend: a preview line under the name in ChatListRow; media messages
// with no text show a media-type icon + short label, never a blank line.
//
// TDD: these tests fail on the base commit (no getLastMessagePreviews, no
// preview fields on the enriched chats, no resolveChatPreview helper).
describe('Chat list last-message preview (P2-2)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gowa-lite-phase5-preview-'));
  const dbPath = path.join(tmpDir, 'test.db');

  let dbMod: typeof import('../server/db.ts');
  let messagesMod: typeof import('../server/db/messages-repo.ts');
  let unifiedMod: typeof import('../server/services/unified-chats-service.ts');

  let agent: PublicUser;
  const deviceId = 'dev-1';
  const jidText = '966500000001@s.whatsapp.net';
  const jidMedia = '966500000002@s.whatsapp.net';
  const jidRevoked = '966500000003@s.whatsapp.net';
  const jidEmpty = '966500000004@s.whatsapp.net';

  type RemoteChat = Parameters<
    typeof unifiedMod.enrichUnifiedChatsWithUnreadAndLifecycle
  >[0]['pagedChats'][number];

  function makeRemoteChat(jid: string, name: string, minutesAgo: number): RemoteChat {
    const ts = new Date(Date.now() - minutesAgo * 60_000).toISOString();
    return {
      jid,
      name,
      last_message_time: ts,
      ephemeral_expiration: 0,
      created_at: ts,
      updated_at: ts,
      archived: false,
      device_id: deviceId,
      device_display_name: 'Dev 1',
      device_state: 'logged_in' as GowaDevice['state'],
    };
  }

  function seedMessage(
    jid: string,
    id: string,
    content: string,
    mediaType: string,
    minutesAgo: number,
    extra: {is_revoked?: boolean} = {},
  ) {
    messagesMod.upsertCachedMessages(deviceId, jid, [
      {
        id,
        chat_jid: jid,
        sender_jid: jid,
        content,
        timestamp: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
        is_from_me: false,
        media_type: mediaType,
        filename: '',
        url: '',
        file_length: 0,
        ...(extra.is_revoked ? {is_revoked: true} : {}),
      },
    ]);
  }

  before(async () => {
    process.env.GOWA_LITE_DB_PATH = dbPath;
    dbMod = await import('../server/db.ts');
    messagesMod = await import('../server/db/messages-repo.ts');
    unifiedMod = await import('../server/services/unified-chats-service.ts');

    const roles = dbMod.listRoles();
    const agentRole = roles.find((r) => r.slug === 'agent')!;
    agent = dbMod.createUser({
      username: 'preview_agent',
      display_name: 'Preview Agent',
      role: 'agent',
      role_id: agentRole.id,
      allowed_device_ids: [deviceId],
      password: 'preview-pass-123',
    });

    // Text chat: older + latest text message (latest must win).
    seedMessage(jidText, 't-old', 'رسالة قديمة', '', 30);
    seedMessage(jidText, 't-new', 'أهلاً، وصل الطلب؟', '', 5);
    // Media-only chat: latest message is an image with no caption.
    seedMessage(jidMedia, 'm-old', 'نص سابق', '', 40);
    seedMessage(jidMedia, 'm-new', '', 'image', 3);
    // Revoked chat: latest message was revoked — its text must NOT leak.
    seedMessage(jidRevoked, 'r-old', 'نص قبل السحب', '', 20);
    seedMessage(jidRevoked, 'r-new', 'نص مسحوب لا يظهر', '', 2, {is_revoked: true});
    // jidEmpty: no cached messages at all.
  });

  after(() => {
    dbMod?.closeDatabaseSafely();
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  it('repo: batched preview returns the latest message per chat', () => {
    const getPreviews = (messagesMod as unknown as Record<string, unknown>)
      .getLastMessagePreviews;
    assert.equal(typeof getPreviews, 'function', 'getLastMessagePreviews must exist');
    const previews = (
      getPreviews as (
        chats: Array<{device_id: string; chat_jid: string}>,
      ) => Map<string, {text: string; media_type: string}>
    )([
      {device_id: deviceId, chat_jid: jidText},
      {device_id: deviceId, chat_jid: jidMedia},
      {device_id: deviceId, chat_jid: jidRevoked},
      {device_id: deviceId, chat_jid: jidEmpty},
    ]);
    assert.equal(previews.get(`${deviceId}::${jidText}`)?.text, 'أهلاً، وصل الطلب؟');
    assert.equal(previews.get(`${deviceId}::${jidText}`)?.media_type, '');
    assert.equal(previews.get(`${deviceId}::${jidMedia}`)?.text, '');
    assert.equal(previews.get(`${deviceId}::${jidMedia}`)?.media_type, 'image');
    // Revoked latest is skipped: the previous visible message is the preview.
    assert.equal(previews.get(`${deviceId}::${jidRevoked}`)?.text, 'نص قبل السحب');
    assert.equal(previews.has(`${deviceId}::${jidEmpty}`), false);
  });

  it('repo: preview query is batched — one statement for 50 chats (no N+1)', () => {
    const getPreviews = (messagesMod as unknown as Record<string, unknown>)
      .getLastMessagePreviews as (
      chats: Array<{device_id: string; chat_jid: string}>,
    ) => Map<string, {text: string; media_type: string}>;
    assert.equal(typeof getPreviews, 'function', 'getLastMessagePreviews must exist');

    const chats50 = Array.from({length: 50}, (_, i) => ({
      device_id: deviceId,
      chat_jid: `96650000${String(2000 + i).padStart(4, '0')}@s.whatsapp.net`,
    }));
    for (const [i, c] of chats50.entries()) {
      seedMessage(c.chat_jid, `n-${i}`, `آخر رسالة ${i}`, '', 1);
    }

    const db = dbMod.db;
    const originalPrepare = db.prepare.bind(db);
    let previewStatements = 0;
    (db as unknown as {prepare: typeof db.prepare}).prepare = ((sql: string, ...rest: unknown[]) => {
      if (sql.includes('last-message-preview')) previewStatements += 1;
      return (originalPrepare as (...args: unknown[]) => unknown)(sql, ...rest);
    }) as typeof db.prepare;
    try {
      const previews = getPreviews(chats50);
      assert.equal(previews.size, 50);
    } finally {
      (db as unknown as {prepare: typeof db.prepare}).prepare = originalPrepare;
    }
    assert.equal(previewStatements, 1, 'exactly one batched preview statement for 50 chats');
  });

  it('service: enriched list chats carry last_message_text / last_message_type', () => {
    const {enrichedChats} = unifiedMod.enrichUnifiedChatsWithUnreadAndLifecycle({
      user: agent,
      pagedChats: [
        makeRemoteChat(jidText, 'Text Customer', 5),
        makeRemoteChat(jidMedia, 'Media Customer', 3),
        makeRemoteChat(jidRevoked, 'Revoked Customer', 2),
        makeRemoteChat(jidEmpty, 'Empty Customer', 1),
      ],
      assignmentsMap: new Map(),
    });
    const byJid = new Map(enrichedChats.map((c) => [c.jid, c]));
    assert.equal(byJid.get(jidText)?.last_message_text, 'أهلاً، وصل الطلب؟');
    assert.equal(byJid.get(jidText)?.last_message_type, '');
    assert.equal(byJid.get(jidMedia)?.last_message_text, '');
    assert.equal(byJid.get(jidMedia)?.last_message_type, 'image');
    assert.equal(byJid.get(jidRevoked)?.last_message_text, 'نص قبل السحب');
    assert.equal(byJid.get(jidEmpty)?.last_message_text, undefined);
  });

  it('service: enriching 50 chats with previews stays fast (load measurement)', () => {
    const chats50: RemoteChat[] = Array.from({length: 50}, (_, i) =>
      makeRemoteChat(
        `96650000${String(2000 + i).padStart(4, '0')}@s.whatsapp.net`,
        `Customer ${i}`,
        50 - i,
      ),
    );
    for (const [i, c] of chats50.entries()) {
      seedMessage(c.jid, `p-${i}`, `آخر رسالة ${i}`, '', 1);
    }
    const times: number[] = [];
    for (let run = 0; run < 7; run++) {
      const t0 = performance.now();
      const {enrichedChats} = unifiedMod.enrichUnifiedChatsWithUnreadAndLifecycle({
        user: agent,
        pagedChats: chats50,
        assignmentsMap: new Map(),
      });
      times.push(performance.now() - t0);
      assert.equal(enrichedChats.length, 50);
      assert.equal(enrichedChats[0]?.last_message_text, 'آخر رسالة 0');
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    // Recorded in the delivery report (before: 2.10 ms median on the same
    // seed/shape without previews). The bound here only guards regressions.
    console.log(`P2-2 load: enrich 50 chats median ${median.toFixed(2)} ms (min ${times[0].toFixed(2)}, max ${times[times.length - 1].toFixed(2)})`);
    assert.ok(median < 250, `enriching 50 chats must stay fast (median ${median.toFixed(2)} ms)`);
  });

  describe('resolveChatPreview (pure helper)', () => {
    const labels: Record<string, string> = {
      image: 'صورة',
      video: 'فيديو',
      audio: 'رسالة صوتية',
      document: 'مستند',
      sticker: 'ملصق',
      file: 'ملف',
      call: 'مكالمة واردة',
    };

    it('returns trimmed single-line text for a text message', () => {
      assert.deepEqual(resolveChatPreview({last_message_text: '  أهلاً\nبالجميع  '}, labels), {
        kind: 'text',
        text: 'أهلاً بالجميع',
      });
    });

    it('returns a media preview (icon + label) when there is no text', () => {
      assert.deepEqual(
        resolveChatPreview({last_message_text: '', last_message_type: 'image'}, labels),
        {kind: 'media', mediaType: 'image', label: 'صورة'},
      );
      assert.deepEqual(
        resolveChatPreview({last_message_text: '   ', last_message_type: 'sticker'}, labels),
        {kind: 'media', mediaType: 'sticker', label: 'ملصق'},
      );
    });

    it('falls back to the raw media type when no label exists', () => {
      assert.deepEqual(
        resolveChatPreview({last_message_text: '', last_message_type: 'link'}, labels),
        {kind: 'media', mediaType: 'link', label: 'link'},
      );
    });

    it('returns null when there is neither text nor media', () => {
      assert.equal(resolveChatPreview({}, labels), null);
      assert.equal(resolveChatPreview({last_message_text: '  '}, labels), null);
    });

    it('localizes a call message (P2-2a): gateway raw text must not leak', () => {
      // The gateway stores incoming calls as media_type "call" with the raw
      // English content "Incoming call" — the preview must show the Arabic
      // label instead, with a call icon, like any other non-text message.
      assert.deepEqual(
        resolveChatPreview(
          {last_message_text: 'Incoming call', last_message_type: 'call'},
          labels,
        ),
        {kind: 'media', mediaType: 'call', label: 'مكالمة واردة'},
      );
      // Fallback: same raw text with no media type (older cached rows).
      assert.deepEqual(
        resolveChatPreview({last_message_text: 'Incoming call'}, labels),
        {kind: 'media', mediaType: 'call', label: 'مكالمة واردة'},
      );
      // A call row with no text at all still gets the label, not a blank.
      assert.deepEqual(
        resolveChatPreview({last_message_text: '', last_message_type: 'call'}, labels),
        {kind: 'media', mediaType: 'call', label: 'مكالمة واردة'},
      );
    });

    it('does not relabel ordinary text that merely mentions a call', () => {
      assert.deepEqual(
        resolveChatPreview(
          {last_message_text: 'I got an incoming call yesterday', last_message_type: ''},
          labels,
        ),
        {kind: 'text', text: 'I got an incoming call yesterday'},
      );
    });
  });
});
