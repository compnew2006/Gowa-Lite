import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, it} from 'node:test';
import {QueryClient} from '@tanstack/react-query';
import {WebSocket} from 'ws';
import {messageHistoryOptions} from '../src/features/chat/message-history-query.ts';
import {expandWsBatchFrame} from '../src/lib/events.ts';
import {syncLiveQueryBatch} from '../src/lib/live-query-sync.ts';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gowa-lite-ws-batch-'));
const tempDbPath = path.join(tempDir, 'ws-batch.db');
process.env.GOWA_LITE_DB_PATH = tempDbPath;
delete process.env.GOWA_SETTINGS_SECRET;

type DbModule = typeof import('../server/db.ts');
type WsBridgeModule = typeof import('../server/ws-bridge.ts');

let dbMod: DbModule;
let wsBridgeMod: WsBridgeModule;

const jid = '201000000001@s.whatsapp.net';

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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function messageEvent(deviceId: string, id: string, content: string) {
  return {
    code: 'MESSAGE_RECEIVED',
    message: '',
    result: {
      id,
      chat_jid: jid,
      sender_jid: jid,
      content,
      timestamp: '2026-11-28T00:00:00Z',
      is_from_me: false,
      media_type: '',
      filename: '',
      url: '',
      file_length: 0,
    },
    device_id: deviceId,
  };
}

before(async () => {
  dbMod = await import('../server/db.ts');
  wsBridgeMod = await import('../server/ws-bridge.ts');
});

after(() => {
  try {
    dbMod?.closeDatabaseSafely();
  } catch {
    // ignore
  }
  fs.rmSync(tempDir, {recursive: true, force: true});
});

describe('WS event batching (P2)', () => {
  it('expands a WS_BATCH frame into its events in order and passes plain frames through', () => {
    const batch = {
      code: 'WS_BATCH',
      message: '',
      result: {events: [messageEvent('one', 'm-1', 'a'), messageEvent('one', 'm-2', 'b')]},
    };
    const expanded = expandWsBatchFrame(batch as never);
    assert.equal(expanded.length, 2);
    assert.equal((expanded[0].result as {id: string}).id, 'm-1');
    assert.equal((expanded[1].result as {id: string}).id, 'm-2');

    const plain = messageEvent('one', 'm-1', 'a');
    assert.deepEqual(expandWsBatchFrame(plain as never), [plain]);
  });

  it('flushes a burst of upstream events as a single batched frame, in order, with no loss', async () => {
    const agent = dbMod.createUser({
      username: 'ws_batch_agent',
      display_name: 'WS Batch Agent',
      role: 'agent',
      password: 'Password123',
      allowed_device_ids: ['dev-1'],
    });
    const port = await getFreePort();
    const server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    const bridge = new wsBridgeMod.GowaWsBridge(server);
    try {
      const ticket = wsBridgeMod.issueWsTicket(agent, dbMod.createSession(agent.id));
      const clientWs = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${ticket}`);
      const frames: unknown[] = [];
      clientWs.on('message', (data) => {
        frames.push(JSON.parse(data.toString()) as unknown);
      });
      await new Promise<void>((resolve) => clientWs.once('open', resolve));
      await sleep(50);
      // BRIDGE_STATUS is sent immediately on connect, outside batching.
      assert.equal(frames.length, 1);
      assert.equal((frames[0] as {code: string}).code, 'BRIDGE_STATUS');

      const burst = 10;
      for (let i = 0; i < burst; i += 1) {
        bridge.relayScopedEvent('dev-1', messageEvent('dev-1', `m-${i}`, `msg ${i}`) as never);
      }
      // No batched frame yet: events are buffered for the ~100ms flush window.
      await sleep(50);
      assert.equal(frames.length, 1, 'burst must be buffered, not sent frame-by-frame');

      await sleep(400);
      assert.equal(frames.length, 2, 'burst must arrive as exactly one batched frame');
      const batch = frames[1] as {code: string; result: {events: Array<{result: {id: string}}>} };
      assert.equal(batch.code, 'WS_BATCH');
      assert.equal(batch.result.events.length, burst);
      for (let i = 0; i < burst; i += 1) {
        assert.equal(batch.result.events[i].result.id, `m-${i}`);
      }
      clientWs.close();
    } finally {
      bridge.shutdown();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('dedup still drops replayed upstream events inside a batch', async () => {
    const agent = dbMod.createUser({
      username: 'ws_batch_agent2',
      display_name: 'WS Batch Agent 2',
      role: 'agent',
      password: 'Password123',
      allowed_device_ids: ['dev-1'],
    });
    const port = await getFreePort();
    const server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    const bridge = new wsBridgeMod.GowaWsBridge(server);
    try {
      const ticket = wsBridgeMod.issueWsTicket(agent, dbMod.createSession(agent.id));
      const clientWs = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${ticket}`);
      const frames: unknown[] = [];
      clientWs.on('message', (data) => {
        frames.push(JSON.parse(data.toString()) as unknown);
      });
      await new Promise<void>((resolve) => clientWs.once('open', resolve));
      await sleep(50);

      const event = messageEvent('dev-1', 'm-dup', 'hello');
      bridge.relayScopedEvent('dev-1', event as never);
      bridge.relayScopedEvent('dev-1', event as never);
      bridge.relayScopedEvent('dev-1', event as never);
      await sleep(400);

      // A single unique event is delivered unwrapped (today's wire format);
      // expand the frames the same way the frontend client does and count.
      const delivered = frames.flatMap((f) =>
        expandWsBatchFrame(f as never).filter((e) => e.code !== 'BRIDGE_STATUS'));
      assert.equal(delivered.length, 1, 'replays must be dropped by dedup');
      assert.equal((delivered[0].result as {id: string}).id, 'm-dup');
      clientWs.close();
    } finally {
      bridge.shutdown();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('does not leak dev-1 events to a user without dev-1 access, and keeps the 15s reconcile loop', async () => {
    const agentOne = dbMod.createUser({
      username: 'ws_batch_agent3',
      display_name: 'WS Batch Agent 3',
      role: 'agent',
      password: 'Password123',
      allowed_device_ids: ['dev-1'],
    });
    const agentTwo = dbMod.createUser({
      username: 'ws_batch_agent4',
      display_name: 'WS Batch Agent 4',
      role: 'agent',
      password: 'Password123',
      allowed_device_ids: ['dev-2'],
    });
    const port = await getFreePort();
    const server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    const bridge = new wsBridgeMod.GowaWsBridge(server);
    try {
      const internal = bridge as unknown as {syncTimer: ReturnType<typeof setInterval> | null};
      assert.notEqual(internal.syncTimer, null, '15s reconcile loop must still be scheduled');
      await bridge.reconcileUpstreams();

      const connect = async (user: {id: number}) => {
        const ticket = wsBridgeMod.issueWsTicket(user as never, dbMod.createSession(user.id));
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${ticket}`);
        const frames: unknown[] = [];
        ws.on('message', (data) => {
          frames.push(JSON.parse(data.toString()) as unknown);
        });
        await new Promise<void>((resolve) => ws.once('open', resolve));
        return {ws, frames};
      };
      const one = await connect(agentOne);
      const two = await connect(agentTwo);
      await sleep(50);

      bridge.relayScopedEvent('dev-1', messageEvent('dev-1', 'm-x', 'secret') as never);
      await sleep(400);

      const delivered = (frames: unknown[]) =>
        frames.flatMap((f) =>
          expandWsBatchFrame(f as never).filter((e) => e.code !== 'BRIDGE_STATUS'));
      assert.equal(
        delivered(one.frames).length,
        1,
        'user with dev-1 access must receive the event',
      );
      assert.equal(
        delivered(two.frames).length,
        0,
        'user without dev-1 access must receive no batched dev-1 events',
      );
      one.ws.close();
      two.ws.close();
    } finally {
      bridge.shutdown();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('applies a whole batch of incoming messages with one coalesced inbox invalidation', () => {
    const client = new QueryClient();
    const baseKey = messageHistoryOptions('one', jid).queryKey;
    const chatInfo = {
      jid,
      name: 'Test',
      last_message_time: '2026-11-28T01:00:00Z',
      ephemeral_expiration: 0,
      created_at: '2026-11-27T00:00:00Z',
      updated_at: '2026-11-28T01:00:00Z',
      archived: false,
    };
    const initial = {
      pageParams: [0],
      pages: [{
        pagination: {limit: 40, offset: 0, total: 0},
        chat_info: chatInfo,
        data: [],
      }],
    };
    client.setQueryData(baseKey, initial);
    client.setQueryData(['unified-chats', ['one']], {stored: true});

    let inboxInvalidations = 0;
    const originalInvalidate = client.invalidateQueries.bind(client);
    client.invalidateQueries = ((filters: never, options: never) => {
      const key = (filters as {queryKey?: unknown} | undefined)?.queryKey;
      if (Array.isArray(key) && key[0] === 'unified-chats') inboxInvalidations += 1;
      return originalInvalidate(filters, options);
    }) as typeof client.invalidateQueries;

    const events = Array.from({length: 5}, (_, i) => ({
      code: 'MESSAGE_RECEIVED',
      message: '',
      device_id: 'one',
      result: {
        id: `m-b${i}`,
        chat_jid: jid,
        sender_jid: jid,
        content: `batch ${i}`,
        timestamp: '2026-11-28T02:00:00Z',
        is_from_me: false,
        media_type: '',
        filename: '',
        url: '',
        file_length: 0,
      },
    }));
    syncLiveQueryBatch(client, events as never);

    const updated = client.getQueryData<typeof initial>(baseKey);
    const updatedData = updated?.pages[0].data as Array<{id: string}> | undefined;
    assert.equal(updatedData?.length, 5);
    for (let i = 0; i < 5; i += 1) {
      assert.equal(updatedData?.[i].id, `m-b${i}`, 'batch order must be preserved');
    }
    assert.equal(inboxInvalidations, 1, 'one batch must invalidate the inbox once, not per event');
    assert.equal(client.getQueryState(baseKey)?.isInvalidated, false);
  });
});
