import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, it} from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gowa-lite-phase1-'));
const tempDbPath = path.join(tempDir, 'test.db');
process.env.GOWA_LITE_DB_PATH = tempDbPath;

type DbModule = typeof import('../server/db.ts');
type GowaModule = typeof import('../server/gowa-client.ts');
type SecurityModule = typeof import('../server/security.ts');

let dbMod: DbModule;
let gowaMod: GowaModule;
let secMod: SecurityModule;

before(async () => {
  dbMod = await import('../server/db.ts');
  gowaMod = await import('../server/gowa-client.ts');
  secMod = await import('../server/security.ts');
  assert.equal(fs.existsSync(tempDbPath), true);
});

after(() => {
  try {
    dbMod?.db.close();
  } catch {
    // ignore
  }
  fs.rmSync(tempDir, {recursive: true, force: true});
});

describe('Phase 1 Security Helpers (server/security.ts)', () => {
  it('blocks excessive failed attempts and resets on success (F-03)', () => {
    const limiter = new secMod.AuthRateLimiter({windowMs: 60_000, maxPerUserKey: 3, maxPerIp: 5});
    const t0 = 1_700_000_000_000;

    assert.equal(limiter.check('10.0.0.1', 'admin', t0).allowed, true);
    limiter.recordFailure('10.0.0.1', 'admin', t0 + 10);
    limiter.recordFailure('10.0.0.1', 'admin', t0 + 20);
    limiter.recordFailure('10.0.0.1', 'admin', t0 + 30);

    const blocked = limiter.check('10.0.0.1', 'admin', t0 + 40);
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterSec >= 1);

    assert.equal(limiter.check('10.0.0.1', 'agent', t0 + 40).allowed, true);

    limiter.clearSuccess('10.0.0.1', 'admin');
    assert.equal(limiter.check('10.0.0.1', 'admin', t0 + 50).allowed, true);
  });

  it('throws GowaError(400 VALIDATION_ERROR) on malformed percent-encoded route params (F-09)', () => {
    assert.equal(secMod.decodeRouteParam('sales%201'), 'sales 1');
    assert.throws(
      () => secMod.decodeRouteParam('%E0%A4%A'),
      (err: unknown) =>
        err instanceof gowaMod.GowaError && err.status === 400 && err.code === 'VALIDATION_ERROR',
    );
  });

  it('prevents reusing saved GOWA credentials across different origins (F-01)', () => {
    assert.equal(
      secMod.canReuseSavedGowaCredentials('https://gowa.example.com/api', 'https://gowa.example.com'),
      true,
    );
    assert.equal(
      secMod.canReuseSavedGowaCredentials('https://attacker.example.net', 'https://gowa.example.com'),
      false,
    );
    assert.equal(
      secMod.canReuseSavedGowaCredentials('http://127.0.0.1:3005', 'https://127.0.0.1:3005'),
      false,
    );
  });

  it('enforces CSRF protection on cookie-authenticated mutations & parses cookies safely (F-02)', () => {
    const parsed = secMod.parseCookies('foo=bar; gowa_session=abc%3D123');
    assert.equal(parsed.gowa_session, 'abc=123');

    assert.equal(secMod.isSafeCookieMutationRequest({headers: {}}), false);
    assert.equal(
      secMod.isSafeCookieMutationRequest({headers: {'x-requested-with': 'XMLHttpRequest'}}),
      true,
    );
    assert.equal(
      secMod.isSafeCookieMutationRequest({
        headers: {origin: 'https://app.example.com', host: 'app.example.com'},
      }),
      true,
    );
    assert.equal(
      secMod.isSafeCookieMutationRequest({
        headers: {origin: 'https://evil.example.com', host: 'app.example.com'},
      }),
      false,
    );
  });
});

describe('Phase 1 DB Sync, Revoked Preservation & User-Isolated Unread Engine (server/db.ts)', () => {
  it('hashes and authenticates users asynchronously with scrypt (F-03)', async () => {
    const hash = await dbMod.hashPasswordAsync('SuperSecret123!');
    assert.equal(await dbMod.verifyPasswordAsync('SuperSecret123!', hash), true);
    assert.equal(await dbMod.verifyPasswordAsync('WrongPass', hash), false);

    const alice = await dbMod.createUserAsync({
      username: 'alice_test',
      display_name: 'Alice Agent',
      role: 'agent',
      password: 'Password123!',
    });
    assert.equal(alice.username, 'alice_test');

    const authed = await dbMod.authenticateUserAsync('alice_test', 'Password123!');
    assert.ok(authed);
    assert.equal(authed.id, alice.id);

    const rejected = await dbMod.authenticateUserAsync('alice_test', 'Nope12345');
    assert.equal(rejected, null);
  });

  it('isolates unread counts per logged-in user and ignores pre-signup history (F-05)', async () => {
    const userA = await dbMod.createUserAsync({
      username: 'agent_a',
      display_name: 'Agent A',
      role: 'agent',
      password: 'Password123!',
    });
    const userB = await dbMod.createUserAsync({
      username: 'agent_b',
      display_name: 'Agent B',
      role: 'agent',
      password: 'Password123!',
    });

    const deviceId = 'dev-1';
    const chatJid = '966500000111@s.whatsapp.net';

    await new Promise((r) => setTimeout(r, 1100));
    const nowIso = new Date().toISOString();
    dbMod.upsertCachedMessages(
      deviceId,
      chatJid,
      [
        {
          id: 'm-1',
          chat_jid: chatJid,
          sender_jid: chatJid,
          content: 'Hello 1',
          timestamp: nowIso,
          is_from_me: false,
          media_type: '',
          filename: '',
          url: '',
          file_length: 0,
        },
        {
          id: 'm-2',
          chat_jid: chatJid,
          sender_jid: chatJid,
          content: 'Hello 2',
          timestamp: nowIso,
          is_from_me: false,
          media_type: '',
          filename: '',
          url: '',
          file_length: 0,
        },
        {
          id: 'm-out',
          chat_jid: chatJid,
          sender_jid: 'me',
          content: 'Reply',
          timestamp: nowIso,
          is_from_me: true,
          media_type: '',
          filename: '',
          url: '',
          file_length: 0,
        },
      ],
      {markUnreadCandidate: true},
    );

    const target = [{device_id: deviceId, chat_jid: chatJid}];
    assert.equal(dbMod.getUnreadCountsForUser(userA, target).get(`${deviceId}::${chatJid}`), 2);
    assert.equal(dbMod.getUnreadCountsForUser(userB, target).get(`${deviceId}::${chatJid}`), 2);

    dbMod.markChatReadForUser(userA.id, deviceId, chatJid);
    assert.equal(dbMod.getUnreadCountsForUser(userA, target).get(`${deviceId}::${chatJid}`) ?? 0, 0);
    assert.equal(dbMod.getUnreadCountsForUser(userB, target).get(`${deviceId}::${chatJid}`), 2);

    const futureUser = {id: 999999, created_at: new Date(Date.now() + 60_000).toISOString()};
    assert.equal(dbMod.getUnreadCountsForUser(futureUser, target).get(`${deviceId}::${chatJid}`) ?? 0, 0);
  });

  it('queues >10 updated chats with persistent needs_catchup until individually cleared (F-04)', () => {
    const devId = 'dev-catchup';
    const baseMs = 1_700_000_000_000;

    const initialChats = Array.from({length: 15}, (_, i) => ({
      device_id: devId,
      chat_jid: `9665000010${String(i).padStart(2, '0')}@s.whatsapp.net`,
      last_message_time: new Date(baseMs + i * 1000).toISOString(),
    }));
    const firstPending = dbMod.syncChatWatermarks(initialChats);
    assert.equal(firstPending.length, 0);

    const updatedChats = initialChats.map((c, i) => ({
      ...c,
      last_message_time: new Date(baseMs + 100_000 + i * 1000).toISOString(),
    }));
    dbMod.syncChatWatermarks(updatedChats);

    const batch1 = dbMod.listPendingCatchupChats(10);
    assert.equal(batch1.length, 10);
    for (const item of batch1) {
      dbMod.clearChatCatchup(item.device_id, item.chat_jid);
    }

    const batch2 = dbMod.listPendingCatchupChats(10);
    assert.equal(batch2.length, 5);
    for (const item of batch2) {
      dbMod.clearChatCatchup(item.device_id, item.chat_jid);
    }

    assert.equal(dbMod.listPendingCatchupChats(10).length, 0);
  });

  it('preserves deleted messages and separates rawCount from injectedCount (F-06)', () => {
    const devId = 'dev-revoked';
    const jid = '966500009999@s.whatsapp.net';

    const t1 = '2026-01-01T10:00:00.000Z';
    const t2 = '2026-01-01T10:05:00.000Z';
    const t3 = '2026-01-01T10:10:00.000Z';

    dbMod.upsertCachedMessages(devId, jid, [
      {
        id: 'old-1',
        chat_jid: jid,
        sender_jid: jid,
        content: 'First message',
        timestamp: t1,
        is_from_me: false,
        media_type: '',
        filename: '',
        url: '',
        file_length: 0,
      },
      {
        id: 'deleted-2',
        chat_jid: jid,
        sender_jid: jid,
        content: 'Secret deleted message',
        timestamp: t2,
        is_from_me: false,
        media_type: '',
        filename: '',
        url: '',
        file_length: 0,
      },
      {
        id: 'latest-3',
        chat_jid: jid,
        sender_jid: jid,
        content: 'Latest message',
        timestamp: t3,
        is_from_me: false,
        media_type: '',
        filename: '',
        url: '',
        file_length: 0,
      },
    ]);

    const merged = dbMod.syncAndMergeChatMessages(
      devId,
      jid,
      [
        {
          id: 'latest-3',
          chat_jid: jid,
          sender_jid: jid,
          content: 'Latest message',
          timestamp: t3,
          is_from_me: false,
          media_type: '',
          filename: '',
          url: '',
          file_length: 0,
        },
        {
          id: 'old-1',
          chat_jid: jid,
          sender_jid: jid,
          content: 'First message',
          timestamp: t1,
          is_from_me: false,
          media_type: '',
          filename: '',
          url: '',
          file_length: 0,
        },
      ],
      {offset: 0, limit: 40},
    );

    assert.equal(merged.rawCount, 2);
    assert.equal(merged.injectedCount, 1);
    assert.equal(merged.messages.length, 3);
    const resurrected = merged.messages.find((m) => m.id === 'deleted-2');
    assert.ok(resurrected);
    assert.equal(resurrected.is_revoked, true);
    assert.equal(resurrected.content, 'Secret deleted message');
  });
});
