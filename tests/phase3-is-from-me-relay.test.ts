import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, it} from 'node:test';
import {WebSocket} from 'ws';
import {expandWsBatchFrame} from '../src/lib/events.ts';

/**
 * P1-18 follow-up (decision 19): the WS relay must broadcast the DERIVED
 * is_from_me flag, not the raw gateway flag. handleUpstreamGowaEvent already
 * persists the derived flag (phase3/is-from-me-server), but relayScopedEvent
 * broadcasts the raw upstream event to browsers, and live-query-sync patches
 * the message list straight from that frame (extractWsIncomingMessage) —
 * so a wrong gateway flag still rendered the wrong "أنت" / sender label
 * live until the next refetch. These tests pin the relay rewrite.
 */
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gowa-lite-is-from-me-relay-'));
const tempDbPath = path.join(tempDir, 'is-from-me-relay.db');
process.env.GOWA_LITE_DB_PATH = tempDbPath;
delete process.env.GOWA_SETTINGS_SECRET;

type DbModule = typeof import('../server/db.ts');
type WsBridgeModule = typeof import('../server/ws-bridge.ts');

let dbMod: DbModule;
let wsBridgeMod: WsBridgeModule;

const OWN_JID = '966500000001@s.whatsapp.net';
const CHAT_JID = '966500000002@s.whatsapp.net';
const FOREIGN_JID = '966500000003@s.whatsapp.net';

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

function messageEvent(
  deviceId: string,
  id: string,
  senderJid: string,
  isFromMe: boolean | undefined,
  nested = false,
) {
  const inner = {
    id,
    chat_jid: CHAT_JID,
    sender_jid: senderJid,
    content: 'hello',
    timestamp: '2026-11-28T00:00:00Z',
    ...(isFromMe === undefined ? {} : {is_from_me: isFromMe}),
    media_type: '',
    filename: '',
    url: '',
    file_length: 0,
  };
  return {
    code: 'MESSAGE_RECEIVED',
    message: '',
    result: nested ? {id, chat_jid: CHAT_JID, payload: inner} : inner,
    device_id: deviceId,
  };
}

let userCounter = 0;

async function setupBridge() {
  const port = await getFreePort();
  const server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const bridge = new wsBridgeMod.GowaWsBridge(server);
  // Seed the reconciled /devices list so getDeviceOwnJid('dev-1') resolves.
  // (private field — test-only seam; production fills it from /devices.)
  (bridge as unknown as {upstreamDevices: unknown[]}).upstreamDevices = [
    {id: 'dev-1', jid: OWN_JID, state: 'logged_in', created_at: '2026-11-28T00:00:00Z'},
  ];
  userCounter += 1;
  const agent = dbMod.createUser({
    username: `relay_agent_${userCounter}`,
    display_name: 'Relay Agent',
    role: 'admin',
    password: 'RelayTestPass123!',
    allowed_device_ids: ['dev-1', 'dev-unknown'],
  });
  const ticket = wsBridgeMod.issueWsTicket(agent, dbMod.createSession(agent.id));
  const clientWs = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${ticket}`);
  const frames: Array<{code: string; result?: {events?: Array<{result?: Record<string, unknown>}>}}> = [];
  clientWs.on('message', (data) => {
    frames.push(JSON.parse(data.toString()) as never);
  });
  await new Promise<void>((resolve) => clientWs.once('open', resolve));
  await sleep(50);
  assert.equal(frames.length, 1, 'only BRIDGE_STATUS before the relay');
  assert.equal(frames[0].code, 'BRIDGE_STATUS');
  return {
    bridge,
    server,
    clientWs,
    frames,
    async teardown() {
      clientWs.close();
      bridge.shutdown();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function relayAndReadEvents(
  ctx: Awaited<ReturnType<typeof setupBridge>>,
  event: ReturnType<typeof messageEvent> | Record<string, unknown>,
  deviceId = 'dev-1',
) {
  ctx.bridge.relayScopedEvent(deviceId, event as never);
  await sleep(500);
  // A lone event arrives as a plain frame; a burst arrives as WS_BATCH.
  const events = ctx.frames.slice(1).flatMap((f) => expandWsBatchFrame(f as never));
  assert.equal(events.length, 1, `expected exactly one relayed event, got ${JSON.stringify(ctx.frames.map((f) => f.code))}`);
  return events[0];
}

async function relayAndReadResult(
  ctx: Awaited<ReturnType<typeof setupBridge>>,
  event: ReturnType<typeof messageEvent>,
) {
  const relayed = await relayAndReadEvents(ctx, event);
  return relayed.result as Record<string, unknown>;
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

describe('P1-18: WS relay broadcasts the derived is_from_me flag', () => {
  it('own sender with no gateway flag broadcasts is_from_me true', async () => {
    const ctx = await setupBridge();
    try {
      const result = await relayAndReadResult(ctx, messageEvent('dev-1', 'm-relay-own-noflag', OWN_JID, undefined));
      assert.equal(result.is_from_me, true);
    } finally {
      await ctx.teardown();
    }
  });

  it('own sender with an explicit false flag broadcasts true and does not mutate the source event', async () => {
    const ctx = await setupBridge();
    try {
      const event = messageEvent('dev-1', 'm-relay-own-false', OWN_JID, false);
      const result = await relayAndReadResult(ctx, event);
      assert.equal(result.is_from_me, true);
      assert.equal(
        (event.result as {is_from_me?: boolean}).is_from_me,
        false,
        'the relay must clone, never mutate the upstream event',
      );
    } finally {
      await ctx.teardown();
    }
  });

  it('foreign sender with no flag broadcasts is_from_me false', async () => {
    const ctx = await setupBridge();
    try {
      const result = await relayAndReadResult(ctx, messageEvent('dev-1', 'm-relay-foreign-noflag', FOREIGN_JID, undefined));
      assert.equal(result.is_from_me, false);
    } finally {
      await ctx.teardown();
    }
  });

  it('foreign sender with an explicit true flag is never flipped to false', async () => {
    const ctx = await setupBridge();
    try {
      const result = await relayAndReadResult(ctx, messageEvent('dev-1', 'm-relay-foreign-true', FOREIGN_JID, true));
      assert.equal(result.is_from_me, true);
    } finally {
      await ctx.teardown();
    }
  });

  it('nested payload shape gets the flag rewritten inside the payload', async () => {
    const ctx = await setupBridge();
    try {
      const result = await relayAndReadResult(
        ctx,
        messageEvent('dev-1', 'm-relay-nested', OWN_JID, false, true),
      );
      const payload = result.payload as Record<string, unknown>;
      assert.equal(payload.is_from_me, true);
      assert.equal(result.is_from_me, true, 'outer record carries the derived flag too');
    } finally {
      await ctx.teardown();
    }
  });

  it('non-message codes pass through untouched', async () => {
    const ctx = await setupBridge();
    try {
      const event = {
        code: 'CHAT_LIFECYCLE_UPDATED',
        message: '',
        result: {chat_jid: CHAT_JID, is_from_me: false},
        device_id: 'dev-1',
      };
      const relayed = await relayAndReadEvents(ctx, event);
      assert.equal(relayed.code, 'CHAT_LIFECYCLE_UPDATED');
      assert.equal((relayed.result as Record<string, unknown>).is_from_me, false);
    } finally {
      await ctx.teardown();
    }
  });

  it('unknown device falls back to the gateway flag (no crash, no rewrite)', async () => {
    const ctx = await setupBridge();
    try {
      // 'dev-unknown' has no /devices entry, so getDeviceOwnJid is ''.
      const relayed = await relayAndReadEvents(
        ctx,
        messageEvent('dev-unknown', 'm-relay-unknown', OWN_JID, false),
        'dev-unknown',
      );
      assert.equal((relayed.result as Record<string, unknown>).is_from_me, false);
    } finally {
      await ctx.teardown();
    }
  });
});
