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

  it('deduplicates repeated groups and channels across accounts while preserving accounts and best metadata', () => {
    const deduped = groupsMod.deduplicateUnifiedDirectoryItems([
      {
        kind: 'group',
        device_id: 'dev-b',
        device_display_name: 'حساب ب',
        device_state: 'logged_in',
        jid: '120363424172141336@G.US',
        name: '120363424172141336@g.us',
        participant_count: 0,
        unread_count: 2,
        group: {JID: '120363424172141336@G.US', ParticipantCount: 0},
      },
      {
        kind: 'group',
        device_id: 'dev-a',
        device_display_name: 'حساب أ',
        device_state: 'logged_in',
        jid: '120363424172141336@g.us',
        name: 'تحويلات العملاء',
        participant_count: 15,
        unread_count: 1,
        group: {JID: '120363424172141336@g.us', Name: 'تحويلات العملاء', ParticipantCount: 15},
      },
      {
        kind: 'newsletter',
        device_id: 'dev-a',
        device_display_name: 'حساب أ',
        device_state: 'logged_in',
        jid: '120363159556222650@newsletter',
        name: 'قناة الأركان',
        subscribers_count: 120,
        live_active: false,
        newsletter: {id: '120363159556222650@newsletter'},
      },
      {
        kind: 'newsletter',
        device_id: 'dev-b',
        device_display_name: 'حساب ب',
        device_state: 'logged_in',
        jid: '120363159556222650@NEWSLETTER',
        name: 'قناة الأركان',
        subscribers_count: 135,
        live_active: true,
        newsletter: {id: '120363159556222650@newsletter'},
      },
    ]);

    assert.equal(deduped.length, 2);

    const groupItem = deduped.find((item) => item.kind === 'group');
    assert.ok(groupItem && groupItem.kind === 'group');
    assert.equal(groupItem.jid, '120363424172141336@g.us');
    assert.equal(groupItem.name, 'تحويلات العملاء');
    assert.equal(groupItem.participant_count, 15);
    assert.equal(groupItem.unread_count, 3);
    assert.deepEqual(
      (groupItem.accounts ?? []).map((a) => a.device_id).sort(),
      ['dev-a', 'dev-b'],
    );

    const channelItem = deduped.find((item) => item.kind === 'newsletter');
    assert.ok(channelItem && channelItem.kind === 'newsletter');
    assert.equal(channelItem.jid, '120363159556222650@newsletter');
    assert.equal(channelItem.subscribers_count, 135);
    assert.equal(channelItem.live_active, true);
    assert.deepEqual(
      (channelItem.accounts ?? []).map((a) => a.device_id).sort(),
      ['dev-a', 'dev-b'],
    );
  });

  it('returns unique groups, unique channels, and multi-account badges from GET /api/unified/groups', async () => {
    const http = await import('node:http');
    const net = await import('node:net');
    const {spawn} = await import('node:child_process');

    const getFreePort = () =>
      new Promise<number>((resolve, reject) => {
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

    const mockPort = await getFreePort();
    const appPort = await getFreePort();
    const httpTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gowa-lite-groups-http-'));

    const mockGowa = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://127.0.0.1:${mockPort}`);
      const deviceId = String(req.headers['x-device-id'] || '');
      res.setHeader('Content-Type', 'application/json');

      if (url.pathname === '/devices') {
        res.end(
          JSON.stringify({
            code: 'SUCCESS',
            results: [
              {id: 'dev-1', phone_number: '966500000001', display_name: 'فرع الرياض', state: 'logged_in'},
              {id: 'dev-2', phone_number: '966500000002', display_name: 'فرع جدة', state: 'logged_in'},
            ],
          }),
        );
        return;
      }

      if (url.pathname === '/user/my/groups') {
        const shared = {
          JID: '120363424172141336@g.us',
          Name: 'تحويلات العملاء',
          ParticipantCount: 15,
        };
        const list =
          deviceId === 'dev-1'
            ? [shared, {JID: '120363000000000001@g.us', Name: 'مجموعة الرياض', ParticipantCount: 8}]
            : [shared];
        res.end(JSON.stringify({code: 'SUCCESS', results: {data: list}}));
        return;
      }

      if (url.pathname === '/user/my/newsletters') {
        res.end(
          JSON.stringify({
            code: 'SUCCESS',
            results: {
              data: [
                {
                  id: '120363159556222650@newsletter',
                  thread_metadata: {name: {text: 'قناة الأركان'}, subscribers_count: 50},
                },
              ],
            },
          }),
        );
        return;
      }

      if (url.pathname === '/newsletter/live-updates') {
        res.end(JSON.stringify({code: 'SUCCESS', results: []}));
        return;
      }

      res.end(JSON.stringify({code: 'SUCCESS', results: []}));
    });

    await new Promise<void>((resolve) => mockGowa.listen(mockPort, '127.0.0.1', resolve));

    const serverProc = spawn('node', ['--import', 'tsx', 'server.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(appPort),
        HOST: '127.0.0.1',
        GOWA_LITE_DB_PATH: path.join(httpTmpDir, 'http.db'),
        BLOCK_PRIVATE_GOWA_URL: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      const baseUrl = `http://127.0.0.1:${appPort}`;
      const start = Date.now();
      let ready = false;
      while (Date.now() - start < 15_000) {
        try {
          const r = await fetch(`${baseUrl}/api/auth/status`);
          if (r.ok) {
            ready = true;
            break;
          }
        } catch {
          // retry
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      assert.equal(ready, true);

      const setupRes = await fetch(`${baseUrl}/api/auth/setup`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          display_name: 'Admin',
          username: 'admin',
          password: 'Password123',
          gowa_url: `http://127.0.0.1:${mockPort}`,
        }),
      });
      assert.equal(setupRes.status, 201);
      const token = ((await setupRes.json()) as {results: {token: string}}).results.token;

      const groupsRes = await fetch(`${baseUrl}/api/unified/groups`, {
        headers: {Authorization: `Bearer ${token}`},
      });
      assert.equal(groupsRes.status, 200);
      const body = (await groupsRes.json()) as {
        results: {
          items: Array<{
            kind: 'group' | 'newsletter';
            jid: string;
            name: string;
            accounts?: Array<{device_id: string; device_display_name: string}>;
          }>;
          groups_count: number;
          newsletters_count: number;
        };
      };

      assert.equal(body.results.groups_count, 2);
      assert.equal(body.results.newsletters_count, 1);
      assert.equal(body.results.items.length, 3);

      const transfersGroup = body.results.items.find(
        (i) => i.kind === 'group' && i.jid === '120363424172141336@g.us',
      );
      assert.ok(transfersGroup);
      assert.equal(transfersGroup.name, 'تحويلات العملاء');
      assert.deepEqual(
        (transfersGroup.accounts ?? []).map((a) => a.device_id).sort(),
        ['dev-1', 'dev-2'],
      );

      const sharedChannel = body.results.items.find((i) => i.kind === 'newsletter');
      assert.ok(sharedChannel);
      assert.deepEqual(
        (sharedChannel.accounts ?? []).map((a) => a.device_id).sort(),
        ['dev-1', 'dev-2'],
      );
    } finally {
      if (serverProc.exitCode === null) {
        serverProc.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (serverProc.exitCode === null) serverProc.kill('SIGKILL');
            resolve();
          }, 1000);
          serverProc.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      mockGowa.closeAllConnections?.();
      await new Promise<void>((resolve) => mockGowa.close(() => resolve()));
      fs.rmSync(httpTmpDir, {recursive: true, force: true});
    }
  });
});
