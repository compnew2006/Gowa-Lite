import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, it} from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gowa-lite-groups-'));
process.env.GOWA_LITE_DB_PATH = path.join(tempDir, 'test.db');

type DbModule = typeof import('../server/db.ts');
type ChatSyncModule = typeof import('../server/services/chat-sync.ts');
type GroupsRouteModule = typeof import('../server/routes/groups.ts');

let dbMod: DbModule;
let chatSyncMod: ChatSyncModule;
let groupsMod: GroupsRouteModule;

before(async () => {
  dbMod = await import('../server/db.ts');
  chatSyncMod = await import('../server/services/chat-sync.ts');
  groupsMod = await import('../server/routes/groups.ts');
});

after(() => {
  try {
    dbMod?.db.close();
  } catch {
    // ignore
  }
  fs.rmSync(tempDir, {recursive: true, force: true});
});

describe('Newsletter Filtering & Group Member Count Resolution', () => {
  it('identifies @newsletter JIDs accurately without matching chats or groups', () => {
    assert.equal(chatSyncMod.isNewsletterJid('120363159556222650@newsletter'), true);
    assert.equal(chatSyncMod.isNewsletterJid('  120363159556222650@NEWSLETTER '), true);
    assert.equal(chatSyncMod.isNewsletterJid('966500000000@s.whatsapp.net'), false);
    assert.equal(chatSyncMod.isNewsletterJid('120363159556222650@g.us'), false);
    assert.equal(chatSyncMod.isNewsletterJid(''), false);
  });

  it('ignores incoming and edited WS events for @newsletter JIDs while storing normal chats', () => {
    const channelJid = '120363159556222650@newsletter';
    const userJid = '966500000001@s.whatsapp.net';

    chatSyncMod.handleUpstreamGowaEvent('dev-1', {
      code: 'MESSAGE_RECEIVED',
      message: 'ok',
      result: {
        id: 'nl-msg-1',
        chat_jid: channelJid,
        sender_jid: channelJid,
        content: 'Channel announcement',
        timestamp: '2026-01-01T00:00:00Z',
      },
    });

    chatSyncMod.handleUpstreamGowaEvent('dev-1', {
      code: 'MESSAGE_EDITED',
      message: 'ok',
      result: {
        original_message_id: 'nl-msg-1',
        chat_jid: channelJid,
        body: 'Edited channel announcement',
        timestamp: '2026-01-01T00:01:00Z',
      },
    });

    chatSyncMod.handleUpstreamGowaEvent('dev-1', {
      code: 'MESSAGE_RECEIVED',
      message: 'ok',
      result: {
        id: 'chat-msg-1',
        chat_jid: userJid,
        sender_jid: userJid,
        content: 'Hello from customer',
        timestamp: '2026-01-01T00:02:00Z',
      },
    });

    const channelRow = dbMod.db
      .prepare('SELECT id FROM cached_messages WHERE device_id = ? AND chat_jid = ?')
      .get('dev-1', channelJid);
    assert.equal(channelRow, undefined);

    const chatRow = dbMod.db
      .prepare('SELECT id, content FROM cached_messages WHERE device_id = ? AND chat_jid = ?')
      .get('dev-1', userJid) as {id: string; content: string} | undefined;
    assert.equal(chatRow?.id, 'chat-msg-1');
    assert.equal(chatRow?.content, 'Hello from customer');
  });

  it('resolves group member count even when ParticipantCount is 0 and Participants is populated', () => {
    assert.equal(
      groupsMod.resolveGroupMemberCount({
        ParticipantCount: 0,
        Participants: [{JID: '1@s.whatsapp.net'}, {JID: '2@s.whatsapp.net'}, {JID: '3@s.whatsapp.net'}],
      }),
      3,
    );

    assert.equal(
      groupsMod.resolveGroupMemberCount({
        participant_count: 14,
      }),
      14,
    );

    assert.equal(
      groupsMod.resolveGroupMemberCount({
        ParticipantCount: 0,
        participants: [{jid: '1@s.whatsapp.net'}, {jid: '2@s.whatsapp.net'}],
      }),
      2,
    );

    assert.equal(groupsMod.resolveGroupMemberCount({ParticipantCount: 0}), 0);
    assert.equal(groupsMod.resolveGroupMemberCount({}), 0);
  });
});
