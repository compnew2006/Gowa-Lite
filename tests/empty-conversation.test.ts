import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, it} from 'node:test';
import {WebSocketServer, type WebSocket} from 'ws';
import {shouldShowChatRowTimestamp} from '../src/features/chat/chat-ui-helpers.ts';
import {
  isNoHistoryOnPhoneError,
  shouldTriggerAutoHistoryFetch,
} from '../src/features/chat/empty-history.ts';

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

describe('Empty-Conversation Behaviour & 0-Message Row Display', () => {
  it('hides list timestamps for 0-message chats even when last_message_time is non-zero', () => {
    assert.equal(
      shouldShowChatRowTimestamp({
        last_message_time: '2026-11-26T23:10:21Z',
        has_messages: false,
      }),
      false,
    );
    assert.equal(
      shouldShowChatRowTimestamp({
        last_message_time: '0001-01-01T00:00:00Z',
        has_messages: true,
      }),
      false,
    );
    assert.equal(
      shouldShowChatRowTimestamp({
        last_message_time: '',
        has_messages: undefined,
      }),
      false,
    );
    assert.equal(
      shouldShowChatRowTimestamp({
        last_message_time: '2026-11-26T23:10:21Z',
        has_messages: true,
      }),
      true,
    );
    assert.equal(
      shouldShowChatRowTimestamp({
        last_message_time: '2026-11-26T23:10:21Z',
      }),
      true,
    );
  });

  it('re-triggers auto-history fetch on every chat open via openNonce without duplicating StrictMode remount', () => {
    const base = {
      isSuccess: true,
      isFetching: false,
      isContentRedacted: false,
      hasSearchOrMediaFilter: false,
      isDeviceReady: true,
      messageCount: 0,
    };

    // First open triggers
    assert.equal(
      shouldTriggerAutoHistoryFetch({
        ...base,
        currentTriggerKey: 'dev-1::966543052651@s.whatsapp.net::1',
        lastTriggeredKey: null,
      }),
      true,
    );

    // React StrictMode remount with same openNonce does not double-fire
    assert.equal(
      shouldTriggerAutoHistoryFetch({
        ...base,
        currentTriggerKey: 'dev-1::966543052651@s.whatsapp.net::1',
        lastTriggeredKey: 'dev-1::966543052651@s.whatsapp.net::1',
      }),
      false,
    );

    // Re-opening the same conversation increments openNonce -> triggers again
    assert.equal(
      shouldTriggerAutoHistoryFetch({
        ...base,
        currentTriggerKey: 'dev-1::966543052651@s.whatsapp.net::2',
        lastTriggeredKey: 'dev-1::966543052651@s.whatsapp.net::1',
      }),
      true,
    );

    // Never auto-fetches when chat has messages, device is offline, or content is redacted
    assert.equal(
      shouldTriggerAutoHistoryFetch({
        ...base,
        messageCount: 1,
        currentTriggerKey: 'dev-1::966543052651@s.whatsapp.net::3',
        lastTriggeredKey: null,
      }),
      false,
    );
    assert.equal(
      shouldTriggerAutoHistoryFetch({
        ...base,
        isDeviceReady: false,
        currentTriggerKey: 'dev-1::966543052651@s.whatsapp.net::3',
        lastTriggeredKey: null,
      }),
      false,
    );
    assert.equal(
      shouldTriggerAutoHistoryFetch({
        ...base,
        isContentRedacted: true,
        currentTriggerKey: 'dev-1::966543052651@s.whatsapp.net::3',
        lastTriggeredKey: null,
      }),
      false,
    );
  });

  it('recognizes upstream GOWA no-history / no-anchor rejections cleanly', () => {
    assert.equal(
      isNoHistoryOnPhoneError(
        400,
        'chat has no stored messages yet; nothing to anchor the history sync request on',
      ),
      true,
    );
    assert.equal(isNoHistoryOnPhoneError(404, 'History not found'), true);
    assert.equal(isNoHistoryOnPhoneError(500, 'chat has no stored messages yet'), false);
    assert.equal(isNoHistoryOnPhoneError(400, 'device is disconnected'), false);
  });

  describe('Integration: has_messages probing cache, no-history propagation & live updates', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gowa-lite-empty-conv-'));
    const dbPath = path.join(tmpDir, 'test.db');

    let mockGowaServer: http.Server;
    let mockGowaWss: WebSocketServer;
    const mockWsClients = new Map<string, WebSocket>();
    let mockGowaPort = 0;
    let appPort = 0;
    let baseUrl = '';
    let serverProc: ChildProcess;

    const probeCounts = new Map<string, number>();
    let historyPostCount = 0;
    const emptyChatJid = '966543052651@s.whatsapp.net';
    const populatedChatJid = '966500000111@s.whatsapp.net';

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

    before(async () => {
      mockGowaServer = http.createServer((req, res) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
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
          const data = [
            {
              jid: emptyChatJid,
              name: 'M7',
              last_message_time: '2026-11-26T23:10:21Z',
              unread_count: 0,
            },
            {
              jid: populatedChatJid,
              name: 'Active Customer',
              last_message_time: '2026-11-26T23:05:00Z',
              unread_count: 0,
            },
          ];
          res.end(
            JSON.stringify({
              code: 'SUCCESS',
              message: 'ok',
              results: {data, pagination: {limit: 100, offset: 0, total: data.length}},
            }),
          );
          return;
        }
        if (url.pathname === `/chat/${encodeURIComponent(emptyChatJid)}/messages` && req.method === 'GET') {
          probeCounts.set(emptyChatJid, (probeCounts.get(emptyChatJid) ?? 0) + 1);
          res.end(
            JSON.stringify({
              code: 'SUCCESS',
              message: 'ok',
              results: {
                data: [],
                pagination: {limit: 40, offset: 0, total: 0},
                chat_info: {jid: emptyChatJid, name: 'M7', last_message_time: '2026-11-26T23:10:21Z'},
              },
            }),
          );
          return;
        }
        if (url.pathname === `/chat/${encodeURIComponent(populatedChatJid)}/messages` && req.method === 'GET') {
          probeCounts.set(populatedChatJid, (probeCounts.get(populatedChatJid) ?? 0) + 1);
          res.end(
            JSON.stringify({
              code: 'SUCCESS',
              message: 'ok',
              results: {
                data: [
                  {
                    id: 'msg-pop-1',
                    chat_jid: populatedChatJid,
                    sender_jid: populatedChatJid,
                    content: 'Hi there',
                    timestamp: '2026-11-26T23:05:00Z',
                    is_from_me: false,
                  },
                ],
                pagination: {limit: 40, offset: 0, total: 1},
                chat_info: {
                  jid: populatedChatJid,
                  name: 'Active Customer',
                  last_message_time: '2026-11-26T23:05:00Z',
                },
              },
            }),
          );
          return;
        }
        if (url.pathname === `/chat/${encodeURIComponent(emptyChatJid)}/history` && req.method === 'POST') {
          historyPostCount += 1;
          res.statusCode = 400;
          res.end(
            JSON.stringify({
              code: 'VALIDATION_ERROR',
              message: 'chat has no stored messages yet; nothing to anchor the history sync request on',
            }),
          );
          return;
        }
        if (url.pathname === `/chat/${encodeURIComponent(populatedChatJid)}/clear` && req.method === 'POST') {
          res.end(JSON.stringify({code: 'SUCCESS', message: 'cleared', results: {}}));
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
      for (const client of mockWsClients.values()) client.close();
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

    it('resolves and caches has_messages per chat, returns clear no-anchor history status, and updates on WS/clear', async () => {
      const setupRes = await api('/api/auth/setup', {
        method: 'POST',
        body: {
          display_name: 'Admin',
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
      assert.ok(mockWsClients.has('dev-1'));

      // First chats fetch probes both chats once and returns exact has_messages booleans
      const firstList = await api('/api/unified/chats?tab=all', {token});
      assert.equal(firstList.status, 200);
      const firstData = (firstList.body?.results as {data: Array<{jid: string; has_messages?: boolean}>}).data;
      const m7First = firstData.find((c) => c.jid === emptyChatJid);
      const popFirst = firstData.find((c) => c.jid === populatedChatJid);
      assert.equal(m7First?.has_messages, false);
      assert.equal(popFirst?.has_messages, true);
      assert.equal(probeCounts.get(emptyChatJid), 1);
      assert.equal(probeCounts.get(populatedChatJid), 1);

      // Second chats fetch uses cached SQLite presence without extra GOWA probes
      const secondList = await api('/api/unified/chats?tab=all', {token});
      assert.equal(secondList.status, 200);
      assert.equal(probeCounts.get(emptyChatJid), 1);
      assert.equal(probeCounts.get(populatedChatJid), 1);

      // History request on M7 forwards GOWA 400 validation error cleanly every time it is called
      const h1 = await api(`/api/unified/chats/dev-1/${encodeURIComponent(emptyChatJid)}/history`, {
        method: 'POST',
        token,
        body: {limit: 40},
      });
      const h2 = await api(`/api/unified/chats/dev-1/${encodeURIComponent(emptyChatJid)}/history`, {
        method: 'POST',
        token,
        body: {limit: 40},
      });
      assert.equal(h1.status, 400);
      assert.equal(h2.status, 400);
      assert.equal(historyPostCount, 2);

      // Clear populated chat -> has_messages resets to false
      const clearRes = await api(`/api/unified/chats/dev-1/${encodeURIComponent(populatedChatJid)}/clear`, {
        method: 'POST',
        token,
      });
      assert.equal(clearRes.status, 200);
      const afterClear = await api('/api/unified/chats?tab=all', {token});
      const afterClearData = (afterClear.body?.results as {data: Array<{jid: string; has_messages?: boolean}>}).data;
      assert.equal(afterClearData.find((c) => c.jid === populatedChatJid)?.has_messages, false);

      // Simulate incoming message via WS on M7 -> has_messages becomes true
      const wsClient = mockWsClients.get('dev-1')!;
      wsClient.send(
        JSON.stringify({
          code: 'MESSAGE_RECEIVED',
          device_id: 'dev-1',
          result: {
            id: 'm7-msg-1',
            chat_jid: emptyChatJid,
            sender_jid: emptyChatJid,
            content: 'Hello from M7',
            timestamp: '2026-11-26T23:15:00Z',
            is_from_me: false,
          },
        }),
      );

      let flippedTrue = false;
      for (let i = 0; i < 20; i += 1) {
        const res = await api('/api/unified/chats?tab=all', {token});
        const rows = (res.body?.results as {data: Array<{jid: string; has_messages?: boolean}>}).data;
        if (rows.find((c) => c.jid === emptyChatJid)?.has_messages === true) {
          flippedTrue = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(flippedTrue, true, 'Incoming WS message must flip has_messages to true');
    });
  });
});
