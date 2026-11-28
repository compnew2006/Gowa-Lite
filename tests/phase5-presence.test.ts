import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, it} from 'node:test';
import {WebSocket} from 'ws';
import {
  VIEWER_TTL_MS,
  buildChatViewersPayload,
  createPresenceRegistry,
  getChatViewers,
  pruneExpiredViewers,
  registerChatViewing,
  removeChatViewing,
  removeViewersForConnection,
} from '../shared/presence.ts';
import {extractChatViewers} from '../src/lib/events.ts';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gowa-lite-phase5-presence-'));
const tempDbPath = path.join(tempDir, 'presence.db');
process.env.GOWA_LITE_DB_PATH = tempDbPath;
delete process.env.GOWA_SETTINGS_SECRET;

type DbModule = typeof import('../server/db.ts');
type WsBridgeModule = typeof import('../server/ws-bridge.ts');
type LifecycleModule = typeof import('../server/services/chat-lifecycle.ts');

let dbMod: DbModule;
let wsBridgeMod: WsBridgeModule;
let lifecycleMod: LifecycleModule;

const jid = '201000000001@s.whatsapp.net';
const otherJid = '201000000002@s.whatsapp.net';

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

function makeAgent(username: string, displayName: string, allowedDevices: string[] = ['dev-1']) {
  // No explicit permissions: the default agent role already carries
  // chats:read/write/assign/close, which the claim/send tests below rely on.
  return dbMod.createUser({
    username,
    display_name: displayName,
    role: 'agent',
    password: 'x'.repeat(12),
    allowed_device_ids: allowedDevices,
  });
}

interface TestClient {
  ws: WebSocket;
  frames: Array<Record<string, any>>;
  viewersFrames: () => Array<{device_id: string; chat_jid: string; viewers: Array<{user_id: number; display_name: string}>}>;
}

async function connectClient(port: number, user: {id: number}): Promise<TestClient> {
  const ticket = wsBridgeMod.issueWsTicket(user as never, dbMod.createSession(user.id));
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${ticket}`);
  const frames: Array<Record<string, any>> = [];
  ws.on('message', (data) => {
    frames.push(JSON.parse(data.toString()) as Record<string, any>);
  });
  await new Promise<void>((resolve) => ws.once('open', resolve));
  await sleep(50);
  return {
    ws,
    frames,
    viewersFrames: () =>
      frames
        .filter((f) => f.code === 'CHAT_VIEWERS')
        .map((f) => f.result as {device_id: string; chat_jid: string; viewers: Array<{user_id: number; display_name: string}>}),
  };
}

before(async () => {
  dbMod = await import('../server/db.ts');
  wsBridgeMod = await import('../server/ws-bridge.ts');
  lifecycleMod = await import('../server/services/chat-lifecycle.ts');
});

after(() => {
  try {
    dbMod?.closeDatabaseSafely();
  } catch {
    // ignore
  }
  fs.rmSync(tempDir, {recursive: true, force: true});
});

describe('presence registry (shared/presence.ts)', () => {
  it('registers a viewer and lists them for the same chat only', () => {
    const registry = createPresenceRegistry();
    registerChatViewing(registry, {
      userId: 1, displayName: 'أحمد', deviceId: 'dev-1', chatJid: jid, connectionId: 'c-1',
    }, 1_000);
    registerChatViewing(registry, {
      userId: 2, displayName: 'سارة', deviceId: 'dev-1', chatJid: otherJid, connectionId: 'c-2',
    }, 1_000);
    const viewers = getChatViewers(registry, 'dev-1', jid);
    assert.equal(viewers.length, 1);
    assert.equal(viewers[0].display_name, 'أحمد');
    assert.equal(getChatViewers(registry, 'dev-1', otherJid).length, 1);
    assert.equal(getChatViewers(registry, 'dev-2', jid).length, 0);
  });

  it('dedupes the same user across two tabs into one viewer entry', () => {
    const registry = createPresenceRegistry();
    registerChatViewing(registry, {
      userId: 1, displayName: 'أحمد', deviceId: 'dev-1', chatJid: jid, connectionId: 'c-1',
    }, 1_000);
    registerChatViewing(registry, {
      userId: 1, displayName: 'أحمد', deviceId: 'dev-1', chatJid: jid, connectionId: 'c-2',
    }, 1_000);
    assert.equal(getChatViewers(registry, 'dev-1', jid).length, 1);
  });

  it('a heartbeat refreshes expiry; without one the viewer expires after the TTL', () => {
    const registry = createPresenceRegistry();
    registerChatViewing(registry, {
      userId: 1, displayName: 'أحمد', deviceId: 'dev-1', chatJid: jid, connectionId: 'c-1',
    }, 1_000);
    // Heartbeat at t=30s keeps the viewer alive past the original deadline.
    registerChatViewing(registry, {
      userId: 1, displayName: 'أحمد', deviceId: 'dev-1', chatJid: jid, connectionId: 'c-1',
    }, 31_000);
    const stillThere = pruneExpiredViewers(registry, 1_000 + VIEWER_TTL_MS + 1_000);
    assert.equal(stillThere.length, 0, 'heartbeat must keep the viewer alive');
    assert.equal(getChatViewers(registry, 'dev-1', jid).length, 1);
    // No further heartbeat: expiry is now 31s + TTL.
    const expired = pruneExpiredViewers(registry, 31_000 + VIEWER_TTL_MS + 1);
    assert.equal(expired.length, 1);
    assert.equal(expired[0].chatJid, jid);
    assert.equal(getChatViewers(registry, 'dev-1', jid).length, 0);
  });

  it('leaving removes the viewer; closing one tab keeps the other tab viewing', () => {
    const registry = createPresenceRegistry();
    registerChatViewing(registry, {
      userId: 1, displayName: 'أحمد', deviceId: 'dev-1', chatJid: jid, connectionId: 'c-1',
    }, 1_000);
    registerChatViewing(registry, {
      userId: 1, displayName: 'أحمد', deviceId: 'dev-1', chatJid: jid, connectionId: 'c-2',
    }, 1_000);
    removeViewersForConnection(registry, 'c-1');
    assert.equal(getChatViewers(registry, 'dev-1', jid).length, 1, 'second tab still viewing');
    removeChatViewing(registry, {deviceId: 'dev-1', chatJid: jid, userId: 1, connectionId: 'c-2'});
    assert.equal(getChatViewers(registry, 'dev-1', jid).length, 0);
  });

  it('builds a CHAT_VIEWERS payload carrying device, chat and viewers', () => {
    const payload = buildChatViewersPayload('dev-1', jid, [
      {user_id: 1, display_name: 'أحمد'},
    ]);
    assert.equal(payload.code, 'CHAT_VIEWERS');
    assert.equal(payload.device_id, 'dev-1');
    assert.equal((payload.result as {chat_jid: string}).chat_jid, jid);
  });
});

describe('extractChatViewers (src/lib/events.ts)', () => {
  it('parses a well-formed CHAT_VIEWERS frame', () => {
    const parsed = extractChatViewers({
      code: 'CHAT_VIEWERS',
      message: '',
      device_id: 'dev-1',
      result: {
        device_id: 'dev-1',
        chat_jid: jid,
        viewers: [{user_id: 7, display_name: 'سارة'}],
      },
    });
    assert.ok(parsed);
    assert.equal(parsed.deviceId, 'dev-1');
    assert.equal(parsed.chatJid, jid);
    assert.equal(parsed.viewers.length, 1);
    assert.equal(parsed.viewers[0].displayName, 'سارة');
  });

  it('returns null for other codes and malformed viewer lists', () => {
    assert.equal(extractChatViewers({code: 'MESSAGE', message: '', result: {}}), null);
    assert.equal(
      extractChatViewers({
        code: 'CHAT_VIEWERS', message: '', device_id: 'dev-1',
        result: {device_id: 'dev-1', chat_jid: jid, viewers: 'nope'},
      }),
      null,
    );
    assert.equal(
      extractChatViewers({
        code: 'CHAT_VIEWERS', message: '', device_id: 'dev-1',
        result: {device_id: 'dev-1', chat_jid: jid, viewers: [{user_id: 'x', display_name: 'سارة'}]},
      }),
      null,
    );
  });
});

describe('presence over the WS bridge (first bidirectional channel)', () => {
  it('broadcasts CHAT_VIEWERS to the other viewer when a second agent opens the chat', async () => {
    const agentA = makeAgent('presence_a', 'أحمد الحضور');
    const agentB = makeAgent('presence_b', 'سارة الحضور');
    const port = await getFreePort();
    const server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    const bridge = new wsBridgeMod.GowaWsBridge(server, {viewerTtlMs: 5_000, presenceSweepMs: 100});
    const sockets: WebSocket[] = [];
    try {
      const clientB = await connectClient(port, agentB);
      sockets.push(clientB.ws);
      const clientA = await connectClient(port, agentA);
      sockets.push(clientA.ws);
      clientB.ws.send(JSON.stringify({code: 'CHAT_VIEWING', device_id: 'dev-1', chat_jid: jid}));
      await sleep(150);
      assert.equal(clientB.viewersFrames().length, 1);
      assert.deepEqual(
        clientB.viewersFrames()[0].viewers.map((v) => v.display_name),
        ['سارة الحضور'],
      );

      clientA.ws.send(JSON.stringify({code: 'CHAT_VIEWING', device_id: 'dev-1', chat_jid: jid}));
      await sleep(150);
      const latestB = clientB.viewersFrames().at(-1)!;
      assert.deepEqual(
        latestB.viewers.map((v) => v.display_name).sort(),
        ['أحمد الحضور', 'سارة الحضور'],
      );
      // The actor also receives the full list (including themself); the
      // client filters itself out of the badge, the server does not.
      const latestA = clientA.viewersFrames().at(-1)!;
      assert.ok(latestA.viewers.some((v) => v.user_id === agentA.id));
      assert.ok(latestA.viewers.some((v) => v.user_id === agentB.id));
      clientA.ws.close();
      clientB.ws.close();
    } finally {
      for (const socket of sockets) {
        try {
          socket.close();
        } catch {
          // ignore close errors in teardown
        }
      }
      bridge.shutdown();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('removes the viewer immediately when the connection closes (no ghost viewers)', async () => {
    const agentA = makeAgent('presence_c', 'أحمد الإغلاق');
    const agentB = makeAgent('presence_d', 'سارة الإغلاق');
    const port = await getFreePort();
    const server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    const bridge = new wsBridgeMod.GowaWsBridge(server, {viewerTtlMs: 5_000, presenceSweepMs: 100});
    const sockets: WebSocket[] = [];
    try {
      const clientB = await connectClient(port, agentB);
      sockets.push(clientB.ws);
      const clientA = await connectClient(port, agentA);
      sockets.push(clientA.ws);
      clientB.ws.send(JSON.stringify({code: 'CHAT_VIEWING', device_id: 'dev-1', chat_jid: jid}));
      clientA.ws.send(JSON.stringify({code: 'CHAT_VIEWING', device_id: 'dev-1', chat_jid: jid}));
      await sleep(150);
      assert.equal(clientB.viewersFrames().at(-1)!.viewers.length, 2);

      clientA.ws.close();
      await sleep(300);
      const latestB = clientB.viewersFrames().at(-1)!;
      assert.deepEqual(
        latestB.viewers.map((v) => v.display_name),
        ['سارة الإغلاق'],
      );
      clientB.ws.close();
    } finally {
      for (const socket of sockets) {
        try {
          socket.close();
        } catch {
          // ignore close errors in teardown
        }
      }
      bridge.shutdown();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('removes the viewer after the TTL when heartbeats stop, and keeps them while heartbeats flow', async () => {
    const agentA = makeAgent('presence_e', 'أحمد النبض');
    const agentB = makeAgent('presence_f', 'سارة النبض');
    const port = await getFreePort();
    const server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    const bridge = new wsBridgeMod.GowaWsBridge(server, {viewerTtlMs: 400, presenceSweepMs: 100});
    const sockets: WebSocket[] = [];
    let heartbeatA: ReturnType<typeof setInterval> | null = null;
    let heartbeatB: ReturnType<typeof setInterval> | null = null;
    const sendHeartbeat = (client: TestClient) => {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify({code: 'CHAT_VIEWING_HEARTBEAT', device_id: 'dev-1', chat_jid: jid}));
      }
    };
    try {
      const clientB = await connectClient(port, agentB);
      const clientA = await connectClient(port, agentA);
      sockets.push(clientB.ws, clientA.ws);
      clientB.ws.send(JSON.stringify({code: 'CHAT_VIEWING', device_id: 'dev-1', chat_jid: jid}));
      clientA.ws.send(JSON.stringify({code: 'CHAT_VIEWING', device_id: 'dev-1', chat_jid: jid}));
      await sleep(150);
      assert.equal(clientB.viewersFrames().at(-1)!.viewers.length, 2);

      // Both viewers heartbeat: both stay listed past the TTL.
      // (A real client heartbeats every open chat; a viewer that stops
      // heartbeating expires — B must keep heartbeating to observe A.)
      heartbeatA = setInterval(() => sendHeartbeat(clientA), 150);
      heartbeatB = setInterval(() => sendHeartbeat(clientB), 150);
      await sleep(700);
      const duringHeartbeat = clientB.viewersFrames().at(-1)!;
      assert.ok(
        duringHeartbeat.viewers.some((v) => v.user_id === agentA.id),
        'heartbeat must keep the viewer listed',
      );
      assert.ok(
        duringHeartbeat.viewers.some((v) => v.user_id === agentB.id),
        'the observing viewer must stay listed too',
      );

      // Only A's heartbeats stop: A disappears after the TTL, B stays.
      if (heartbeatA) clearInterval(heartbeatA);
      heartbeatA = null;
      await sleep(800);
      const latestB = clientB.viewersFrames().at(-1)!;
      assert.deepEqual(
        latestB.viewers.map((v) => v.display_name),
        ['سارة النبض'],
      );
    } finally {
      if (heartbeatA) clearInterval(heartbeatA);
      if (heartbeatB) clearInterval(heartbeatB);
      for (const socket of sockets) {
        try {
          socket.close();
        } catch {
          // ignore close errors in teardown
        }
      }
      bridge.shutdown();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('ignores viewing messages from users without access to the device', async () => {
    const agentA = makeAgent('presence_g', 'أحمد الممنوع', ['dev-2']);
    const agentB = makeAgent('presence_h', 'سارة المسموح');
    const port = await getFreePort();
    const server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    const bridge = new wsBridgeMod.GowaWsBridge(server, {viewerTtlMs: 5_000, presenceSweepMs: 100});
    const sockets: WebSocket[] = [];
    try {
      const clientB = await connectClient(port, agentB);
      sockets.push(clientB.ws);
      const clientA = await connectClient(port, agentA);
      sockets.push(clientA.ws);
      clientB.ws.send(JSON.stringify({code: 'CHAT_VIEWING', device_id: 'dev-1', chat_jid: jid}));
      await sleep(150);
      clientA.ws.send(JSON.stringify({code: 'CHAT_VIEWING', device_id: 'dev-1', chat_jid: jid}));
      await sleep(200);
      // B still sees only themself; A never appears. A also receives nothing.
      assert.deepEqual(
        clientB.viewersFrames().at(-1)!.viewers.map((v) => v.display_name),
        ['سارة المسموح'],
      );
      assert.equal(clientA.viewersFrames().length, 0);
      clientA.ws.close();
      clientB.ws.close();
    } finally {
      for (const socket of sockets) {
        try {
          socket.close();
        } catch {
          // ignore close errors in teardown
        }
      }
      bridge.shutdown();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('does not block the live channel while a viewer is present', async () => {
    const agentA = makeAgent('presence_i', 'أحمد القناة');
    const agentB = makeAgent('presence_j', 'سارة القناة');
    const port = await getFreePort();
    const server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
    const bridge = new wsBridgeMod.GowaWsBridge(server, {viewerTtlMs: 5_000, presenceSweepMs: 100});
    const sockets: WebSocket[] = [];
    try {
      const clientB = await connectClient(port, agentB);
      sockets.push(clientB.ws);
      const clientA = await connectClient(port, agentA);
      sockets.push(clientA.ws);
      clientA.ws.send(JSON.stringify({code: 'CHAT_VIEWING', device_id: 'dev-1', chat_jid: jid}));
      await sleep(150);
      bridge.relayScopedEvent('dev-1', {
        code: 'MESSAGE_RECEIVED',
        message: '',
        result: {
          id: 'm-presence-1',
          chat_jid: jid,
          sender_jid: jid,
          content: 'مرحبا',
          timestamp: '2026-11-28T00:00:00Z',
          is_from_me: false,
          media_type: '',
          filename: '',
          url: '',
          file_length: 0,
        },
      } as never);
      await sleep(300);
      const messageFrames = clientB.frames.filter((f) => f.code === 'MESSAGE_RECEIVED');
      assert.equal(messageFrames.length, 1, 'live messages still flow while a viewer is present');
      clientA.ws.close();
      clientB.ws.close();
    } finally {
      for (const socket of sockets) {
        try {
          socket.close();
        } catch {
          // ignore close errors in teardown
        }
      }
      bridge.shutdown();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('warning only (decision 7): presence never blocks claim or send', () => {
  it('another agent can still claim a pending chat while a viewer is present', () => {
    const viewer = makeAgent('presence_k', 'أحمد المشاهد');
    const claimer = makeAgent('presence_l', 'سارة المستلمة');
    const registry = createPresenceRegistry();
    registerChatViewing(registry, {
      userId: viewer.id, displayName: 'أحمد المشاهد', deviceId: 'dev-1', chatJid: jid, connectionId: 'c-k',
    });
    assert.equal(getChatViewers(registry, 'dev-1', jid).length, 1);
    const {assignment} = lifecycleMod.claimChat(claimer as never, 'dev-1', jid, {cachedTitle: 'عميل الحضور'});
    assert.equal(assignment.status, 'open');
    assert.equal(assignment.assigned_user_id, claimer.id);
  });

  it('the send policy still allows a reply while another viewer is present', () => {
    const viewer = makeAgent('presence_m', 'أحمد المشاهد 2');
    const sender = makeAgent('presence_n', 'سارة المرسلة');
    const registry = createPresenceRegistry();
    registerChatViewing(registry, {
      userId: viewer.id, displayName: 'أحمد المشاهد 2', deviceId: 'dev-1', chatJid: otherJid, connectionId: 'c-m',
    });
    assert.equal(getChatViewers(registry, 'dev-1', otherJid).length, 1);
    const {assignment} = lifecycleMod.enforceInboxPolicyBeforeSend(sender as never, 'dev-1', otherJid);
    assert.ok(assignment, 'send policy must not throw while a viewer is present');
  });
});
