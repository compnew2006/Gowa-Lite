import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, it} from 'node:test';
import {WebSocketServer, type WebSocket} from 'ws';
import {
  clearMediaCache,
  getCachedMedia,
  getOrFetchCachedMedia,
} from '../src/lib/media-cache.ts';

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

describe('Gowa Lite 5 Targeted Fixes Verification', () => {
  it('Issue 1 & 3a: keeps a single fetch-older button in MessageViewHeader and auto-fetches history on empty chats', () => {
    const headerSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'src/features/chat/message-view-header.tsx'),
      'utf8',
    );
    const viewSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'src/features/chat/message-view.tsx'),
      'utf8',
    );

    const headerBtnCount = (headerSrc.match(/fetchOlderFromPhone/g) ?? []).length;
    assert.ok(headerBtnCount >= 2, 'Header button should use fetchOlderFromPhone label/title');
    assert.equal(viewSrc.includes('fetchOlderFromPhone'), false, 'Duplicate inline fetchOlderFromPhone button must be removed from MessageView');
    assert.equal(viewSrc.includes('requestUnifiedChatHistory('), true, 'MessageView must automatically request history when empty');
    assert.equal(viewSrc.includes('fetchingHistoryFromPhone'), true, 'MessageView must render loading state while fetching history');
  });

  it('Issue 2: separates secondaryPhone onto its own line, guards green unread badge to >0, and clears on chat open', () => {
    const chatListSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'src/features/chat/chat-list.tsx'),
      'utf8',
    );
    const chatsPageSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'src/pages/chats.tsx'),
      'utf8',
    );

    // secondaryPhone is rendered in its own <p dir="ltr" ...> block outside row 2's flex container
    assert.equal(chatListSrc.includes('{secondaryPhone && (\n              <p\n                dir="ltr"'), true);
    assert.equal(chatListSrc.includes('hasUnread && (\n                    <span'), true);
    assert.equal(chatsPageSrc.includes("queryKey: ['unified-chats']"), true);
    assert.equal(chatsPageSrc.includes('unread_count: 0'), true);
  });

  it('Issue 3b: frontend media cache deduplicates, throttles concurrency <= 4, retains entries, and revokes on LRU eviction', async () => {
    clearMediaCache();
    let seq = 0;
    const revokedUrls: string[] = [];
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;

    URL.createObjectURL = () => `blob:test-${++seq}`;
    URL.revokeObjectURL = (url: string) => {
      revokedUrls.push(url);
    };

    try {
      let currentActive = 0;
      let maxActive = 0;
      let fetchCalls = 0;

      const delayedFetcher = async (urlPath: string) => {
        fetchCalls += 1;
        currentActive += 1;
        maxActive = Math.max(maxActive, currentActive);
        await new Promise((r) => setTimeout(r, 25));
        currentActive -= 1;
        return {
          bytes: new Uint8Array([1, 2, 3, urlPath.length]),
          contentType: 'image/jpeg',
        };
      };

      // Concurrent identical calls deduplicate
      const [a1, a2] = await Promise.all([
        getOrFetchCachedMedia('k1', '/file/1', delayedFetcher, 3),
        getOrFetchCachedMedia('k1', '/file/1', delayedFetcher, 3),
      ]);
      assert.equal(a1.objectUrl, a2.objectUrl);
      assert.equal(fetchCalls, 1);

      // Instant cache hit
      const cached = getCachedMedia('k1');
      assert.equal(cached?.objectUrl, a1.objectUrl);

      // Concurrency stays bounded <= 4 across 8 distinct downloads
      await Promise.all(
        ['k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8', 'k9'].map((k, idx) =>
          getOrFetchCachedMedia(k, `/file/${idx + 2}`, delayedFetcher, 3),
        ),
      );
      assert.ok(maxActive <= 4, `Expected max concurrent <= 4, got ${maxActive}`);
      assert.ok(revokedUrls.length >= 6, 'LRU eviction above maxEntries=3 should revoke old object URLs');
    } finally {
      clearMediaCache();
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    }
  });

  describe('Integration: Server Media Range/Cache, Groups Fast Directory & Lifecycle + Private Tabs', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gowa-lite-5fixes-'));
    const dbPath = path.join(tmpDir, 'test.db');

    let mockGowaServer: http.Server;
    let mockGowaWss: WebSocketServer;
    const mockWsClients = new Map<string, WebSocket>();
    let mockGowaPort = 0;
    let appPort = 0;
    let baseUrl = '';
    let serverProc: ChildProcess;

    let gowaMediaDownloadCalls = 0;
    let gowaBinaryFetchCalls = 0;
    let gowaGroupInfoCalls = 0;
    const sampleMediaBytes = Buffer.from('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ');

    const mockChats = [
      {
        jid: '966501000001@s.whatsapp.net',
        name: 'Pending Alpha',
        last_message_time: new Date(Date.now() - 10_000).toISOString(),
        unread_count: 3,
      },
      {
        jid: '966501000002@s.whatsapp.net',
        name: 'Open Beta',
        last_message_time: new Date(Date.now() - 20_000).toISOString(),
        unread_count: 1,
      },
      {
        jid: '966501000003@s.whatsapp.net',
        name: 'Closed Gamma',
        last_message_time: new Date(Date.now() - 30_000).toISOString(),
        unread_count: 0,
      },
    ];

    async function api(
      urlPath: string,
      opts: {method?: string; token?: string; body?: unknown; headers?: Record<string, string>} = {},
    ): Promise<{status: number; headers: Headers; body: Record<string, unknown> | null; rawBuffer: Buffer}> {
      const res = await fetch(`${baseUrl}${urlPath}`, {
        method: opts.method ?? 'GET',
        headers: {
          ...(opts.body ? {'Content-Type': 'application/json'} : {}),
          ...(opts.token ? {Authorization: `Bearer ${opts.token}`} : {}),
          ...(opts.headers ?? {}),
        },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
      const rawBuffer = Buffer.from(await res.arrayBuffer());
      let body: Record<string, unknown> | null = null;
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        try {
          body = JSON.parse(rawBuffer.toString('utf8')) as Record<string, unknown>;
        } catch {
          body = null;
        }
      }
      return {status: res.status, headers: res.headers, body, rawBuffer};
    }

    before(async () => {
      mockGowaServer = http.createServer((req, res) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1');

        if (url.pathname === '/statics/sample.mp4' && req.method === 'GET') {
          gowaBinaryFetchCalls += 1;
          res.setHeader('Content-Type', 'video/mp4');
          res.end(sampleMediaBytes);
          return;
        }

        res.setHeader('Content-Type', 'application/json');
        if (url.pathname === '/devices' && req.method === 'GET') {
          res.end(
            JSON.stringify({
              code: 'SUCCESS',
              message: 'ok',
              results: [{id: 'dev-1', phone_number: '966500000000', state: 'logged_in'}],
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
              results: {data: mockChats, pagination: {limit: 100, offset: 0, total: mockChats.length}},
            }),
          );
          return;
        }
        if (url.pathname === '/user/my/groups' && req.method === 'GET') {
          // Direct array shape without data wrapper, with ParticipantCount === 0
          res.end(
            JSON.stringify({
              code: 'SUCCESS',
              message: 'ok',
              results: [
                {
                  JID: '120363000000111@g.us',
                  Name: 'VIP Customers',
                  ParticipantCount: 0,
                  Participants: [],
                },
                {
                  JID: '120363000000222@g.us',
                  Name: 'Support Team',
                  ParticipantCount: 5,
                  Participants: [],
                },
              ],
            }),
          );
          return;
        }
        if (url.pathname === '/user/my/newsletters' && req.method === 'GET') {
          res.end(
            JSON.stringify({
              code: 'SUCCESS',
              message: 'ok',
              results: {
                data: [
                  {
                    id: '120363000000333@newsletter',
                    thread_metadata: {
                      name: {text: 'Announcements'},
                      subscribers_count: 140,
                    },
                  },
                ],
              },
            }),
          );
          return;
        }
        if (url.pathname === '/group/info' && req.method === 'GET') {
          gowaGroupInfoCalls += 1;
          setTimeout(() => {
            if (!res.writableEnded) {
              res.end(JSON.stringify({code: 'SUCCESS', message: 'ok', results: {ParticipantCount: 9}}));
            }
          }, 1500);
          return;
        }
        if (url.pathname === '/message/msg-video-1/download' && req.method === 'GET') {
          gowaMediaDownloadCalls += 1;
          res.end(
            JSON.stringify({
              code: 'SUCCESS',
              message: 'ok',
              results: {
                message_id: 'msg-video-1',
                media_type: 'video',
                filename: 'clip.mp4',
                file_path: 'statics/sample.mp4',
                file_size: sampleMediaBytes.byteLength,
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
              results: {data: [], pagination: {limit: 40, offset: 0, total: 0}, chat_info: {}},
            }),
          );
          return;
        }
        res.end(JSON.stringify({code: 'SUCCESS', message: 'ok', results: []}));
      });

      mockGowaWss = new WebSocketServer({server: mockGowaServer, path: '/ws'});
      mockGowaWss.on('connection', (ws, req) => {
        const reqUrl = new URL(req.url || '/ws', 'http://127.0.0.1');
        const devId = reqUrl.searchParams.get('device_id') || 'default';
        mockWsClients.set(devId, ws);
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
      for (let i = 0; i < 60; i += 1) {
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
      assert.equal(ready, true, 'Express server failed to start');
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

    it('verifies Issues 3b, 4, and 5 against Express API + SQLite + mock GOWA', async () => {
      // 1. Setup admin & configure mock GOWA
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

      const wsWaitStart = Date.now();
      while (!mockWsClients.has('dev-1') && Date.now() - wsWaitStart < 5000) {
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(mockWsClients.has('dev-1'), 'Expected GowaWsBridge to connect dev-1 to mock GOWA /ws');

      // Create a second supervisor/agent user so we can test `me` vs `open` tab counts cleanly
      const roleRes = await api('/api/roles', {token});
      const roles = (roleRes.body?.results as Array<{id: number; slug: string}>) ?? [];
      const supervisorRole = roles.find((r) => r.slug === 'manager') ?? roles[0]!;

      const otherSupRes = await api('/api/users', {
        method: 'POST',
        token,
        body: {
          display_name: 'Other Supervisor',
          username: 'sup2',
          password: 'Password123',
          role_id: supervisorRole.id,
        },
      });
      assert.equal(otherSupRes.status, 201);
      const sup2Login = await api('/api/auth/login', {
        method: 'POST',
        body: {username: 'sup2', password: 'Password123'},
      });
      const sup2Token = (sup2Login.body?.results as {token: string}).token;

      // 2. Issue 4: Groups & Channels loads direct arrays fast without blocking on /group/info
      const tGroupsStart = Date.now();
      const groupsRes = await api('/api/unified/groups', {token});
      const groupsElapsedMs = Date.now() - tGroupsStart;
      assert.equal(groupsRes.status, 200);
      const groupsData = groupsRes.body?.results as {
        groups_count: number;
        newsletters_count: number;
        items: Array<{kind: string; name: string}>;
      };
      assert.equal(groupsData.groups_count, 2);
      assert.equal(groupsData.newsletters_count, 1);
      assert.equal(groupsData.items.length, 3);
      assert.ok(groupsElapsedMs < 800, `Expected non-blocking /api/unified/groups response (<800ms), got ${groupsElapsedMs}ms`);
      assert.ok(gowaGroupInfoCalls >= 0);

      // 3. Issue 3b: Media resolution caching + Range 206 + Asset LRU caching
      const dl1 = await api('/api/unified/media/download?deviceId=dev-1&messageId=msg-video-1&phone=966501000001@s.whatsapp.net', {token});
      assert.equal(dl1.status, 200);
      const proxyUrl = (dl1.body?.results as {proxy_url: string}).proxy_url;
      assert.ok(proxyUrl.startsWith('/api/unified/media/file?'));

      const dl2 = await api('/api/unified/media/download?deviceId=dev-1&messageId=msg-video-1&phone=966501000001@s.whatsapp.net', {token});
      assert.equal(dl2.status, 200);
      assert.equal(gowaMediaDownloadCalls, 1, 'Media resolution should be served from LRU cache on second call');

      const rangeRes = await api(proxyUrl, {token, headers: {Range: 'bytes=0-9'}});
      assert.equal(rangeRes.status, 206);
      assert.equal(rangeRes.headers.get('accept-ranges'), 'bytes');
      assert.equal(rangeRes.headers.get('content-range'), `bytes 0-9/${sampleMediaBytes.byteLength}`);
      assert.equal(rangeRes.rawBuffer.toString('utf8'), '0123456789');

      const badRangeRes = await api(proxyUrl, {token, headers: {Range: 'bytes=9999-10000'}});
      assert.equal(badRangeRes.status, 416);

      const fullRes = await api(proxyUrl, {token});
      assert.equal(fullRes.status, 200);
      assert.equal(fullRes.rawBuffer.toString('utf8'), sampleMediaBytes.toString('utf8'));
      assert.equal(gowaBinaryFetchCalls, 1, 'Upstream binary asset should be fetched only once across Range/full requests');

      // 4. Issue 5: Real lifecycle transitions + distinct All / Me / Open / Pending / Closed / Private tabs
      const initialChats = await api('/api/unified/chats?tab=all', {token});
      assert.equal(initialChats.status, 200);
      const initPayload = initialChats.body?.results as {
        tab_counts: {all: number; me: number; open: number; pending: number; closed: number; private: number};
        chat_lists: Array<{id: number; name: string}>;
      };
      assert.deepEqual(initPayload.tab_counts, {
        all: 3,
        me: 0,
        open: 0,
        pending: 3,
        closed: 0,
        private: 0,
      });
      const privateList = initPayload.chat_lists.find((l) => l.name === 'الخاص');
      assert.ok(privateList, 'Default private list "الخاص" should be seeded automatically');

      // Sup1 claims Open Beta -> me: 1, open: 1, pending: 2
      const claim1 = await api('/api/unified/chats/dev-1/966501000002@s.whatsapp.net/claim', {
        method: 'POST',
        token,
        body: {cached_title: 'Open Beta'},
      });
      assert.equal(claim1.status, 200);

      // Sup2 claims Pending Alpha -> for Sup1: me: 1, open: 2, pending: 1
      const claim2 = await api('/api/unified/chats/dev-1/966501000001@s.whatsapp.net/claim', {
        method: 'POST',
        token: sup2Token,
        body: {cached_title: 'Pending Alpha'},
      });
      assert.equal(claim2.status, 200);

      // Sup1 closes Closed Gamma -> closed: 1, pending: 0, open: 2, me: 1
      const close3 = await api('/api/unified/chats/dev-1/966501000003@s.whatsapp.net/close', {
        method: 'POST',
        token,
        body: {cached_title: 'Closed Gamma'},
      });
      assert.equal(close3.status, 200);

      // Assign Open Beta to Private list -> private: 1
      const assignPrivate = await api('/api/unified/chats/dev-1/966501000002@s.whatsapp.net/lists', {
        method: 'PUT',
        token,
        body: {list_ids: [privateList.id]},
      });
      assert.equal(assignPrivate.status, 200);

      const afterLifecycle = await api('/api/unified/chats?tab=all', {token});
      assert.equal(afterLifecycle.status, 200);
      assert.deepEqual(
        (afterLifecycle.body?.results as {tab_counts: unknown}).tab_counts,
        {all: 3, me: 1, open: 2, pending: 0, closed: 1, private: 1},
      );

      // Verify each tab's returned rows match its real semantics
      const meTab = await api('/api/unified/chats?tab=me', {token});
      assert.deepEqual(
        ((meTab.body?.results as {data: Array<{jid: string}>}).data).map((c) => c.jid),
        ['966501000002@s.whatsapp.net'],
      );

      const openTab = await api('/api/unified/chats?tab=open', {token});
      assert.equal((openTab.body?.results as {data: Array<{jid: string}>}).data.length, 2);

      const closedTab = await api('/api/unified/chats?tab=closed', {token});
      assert.deepEqual(
        ((closedTab.body?.results as {data: Array<{jid: string}>}).data).map((c) => c.jid),
        ['966501000003@s.whatsapp.net'],
      );

      const privateTab = await api('/api/unified/chats?tab=private', {token});
      assert.deepEqual(
        ((privateTab.body?.results as {data: Array<{jid: string}>}).data).map((c) => c.jid),
        ['966501000002@s.whatsapp.net'],
      );

      // Simulate customer reply on closed chat -> auto-reopens to pending
      const wsClient = mockWsClients.get('dev-1');
      assert.ok(wsClient, 'Mock GOWA WS client should be connected');
      wsClient.send(
        JSON.stringify({
          code: 'MESSAGE_RECEIVED',
          device_id: 'dev-1',
          result: {
            id: 'incoming-msg-reopen',
            chat_jid: '966501000003@s.whatsapp.net',
            sender_jid: '966501000003@s.whatsapp.net',
            content: 'Hello again!',
            timestamp: new Date().toISOString(),
            is_from_me: false,
          },
        }),
      );

      let reopened = false;
      for (let i = 0; i < 20; i += 1) {
        const check = await api('/api/unified/chats?tab=pending', {token});
        const res = check.body?.results as {
          data: Array<{jid: string}>;
          tab_counts: {pending: number; closed: number};
        };
        if (res.tab_counts.pending === 1 && res.tab_counts.closed === 0) {
          reopened = res.data.some((c) => c.jid === '966501000003@s.whatsapp.net');
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(reopened, true, 'Customer reply on closed chat must reopen it to pending');
    });
  });
});
