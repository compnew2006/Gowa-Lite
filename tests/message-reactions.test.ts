import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {createHmac} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {createServer, type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, it} from 'node:test';
import {WebSocket, WebSocketServer} from 'ws';
import {expandWsFrame} from './ws-frame-helpers.ts';

const deviceId = 'test-line';
const deviceJid = '61400123456@s.whatsapp.net';
const otherDeviceId = 'other-line';
const chatJid = '61400123457@s.whatsapp.net';
const messageId = 'test-document';
const secret = 'test-reaction-webhook-secret';
const message = {
  id: messageId,
  chat_jid: chatJid,
  sender_jid: deviceJid,
  timestamp: new Date().toISOString(),
  is_from_me: true,
  content: '',
  media_type: 'document',
  filename: 'test.pdf',
  url: '/statics/test.pdf',
  file_length: 100,
};
const remoteReaction = {
  emoji: '👍',
  sender_jid: chatJid,
  is_from_me: false,
  timestamp: new Date(Date.now() - 5000).toISOString(),
};
let snapshots: typeof remoteReaction[] | undefined = [remoteReaction];
let gatewayEmojis: string[] = [];
let gateway: Server;
let gatewayWs: WebSocketServer;
const upstreamClients = new Map<string, WebSocket>();
let app: ChildProcess;
let client: WebSocket;
let base: string;
let token: string;
let appLogs = '';
const temp = mkdtempSync(join(tmpdir(), 'gowa-lite-reactions-'));
const messagePath = `/api/unified/chats/${encodeURIComponent(deviceId)}/${encodeURIComponent(chatJid)}/messages`;

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

async function request(path: string, method = 'GET', body?: unknown) {
  return fetch(base + path, {
    method,
    headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function reactions() {
  const res = await request(messagePath);
  assert.equal(res.status, 200, await res.clone().text());
  const {results} = await res.json();
  assert.equal(results.data[0].filename, 'test.pdf');
  return results.data[0].reactions.map(
    ({emoji, is_from_me}: {emoji: string; is_from_me: boolean}) => [emoji, is_from_me],
  );
}

function waitForReaction(): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off('message', onMessage);
      reject(new Error('No message reaction arrived over WebSocket'));
    }, 1500);
    function onMessage(frame: Buffer) {
      for (const event of expandWsFrame(JSON.parse(frame.toString()))) {
        const result = event.result as {message_id?: string} | undefined;
        if (event.code !== 'MESSAGE_REACTION' || result?.message_id !== messageId) continue;
        clearTimeout(timer);
        client.off('message', onMessage);
        resolve(result as Record<string, unknown>);
        return;
      }
    }
    client.on('message', onMessage);
  });
}

async function webhook(emoji: string, timestamp: string, signingKey = secret) {
  const body = JSON.stringify({
    event: 'message.reaction',
    device_id: deviceJid,
    payload: {
      id: 'reaction-envelope-id',
      reacted_message_id: messageId,
      chat_id: chatJid,
      from: chatJid,
      is_from_me: false,
      reaction: emoji,
      removed_reaction: '❤️',
      timestamp,
    },
  });
  return fetch(base + '/api/webhooks/gowa', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', signingKey).update(body).digest('hex'),
    },
    body,
  });
}

before(async () => {
  gateway = createServer(async (req, res) => {
    const pathname = new URL(req.url!, 'http://localhost').pathname;
    let results: unknown;
    if (pathname === '/devices') {
      results = [
        {id: deviceId, jid: deviceJid, state: 'logged_in'},
        {id: otherDeviceId, jid: '61400120000@s.whatsapp.net', state: 'logged_in'},
      ];
    } else if (pathname.endsWith('/status')) {
      results = {is_logged_in: true};
    } else if (pathname.endsWith('/messages')) {
      results = {data: [{...message, reactions: snapshots}], pagination: {total: 1}};
    } else if (pathname === `/message/${messageId}/reaction`) {
      let body = '';
      for await (const chunk of req) body += chunk;
      gatewayEmojis.push(JSON.parse(body).emoji);
      if (JSON.parse(body).emoji === '🚫') {
        res.writeHead(409, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({code: 'UPSTREAM_REJECTED', message: 'rejected'}));
        return;
      }
      results = {message_id: 'send-ack'};
    } else {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({code: 'SUCCESS', results}));
  });
  gatewayWs = new WebSocketServer({server: gateway});
  gatewayWs.on('connection', (socket, req) => {
    const id = new URL(req.url!, 'http://localhost').searchParams.get('device_id');
    if (id) upstreamClients.set(id, socket);
  });
  const gowaPort = await listen(gateway);
  const probe = createServer();
  const appPort = await listen(probe);
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  base = `http://127.0.0.1:${appPort}`;
  app = spawn(process.execPath, ['server.ts'], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(appPort),
      ADMIN_PASSCODE: 'LocalReactionTest123',
      GOWA_LITE_DB_PATH: join(temp, 'test.db'),
      GOWA_URL: `http://127.0.0.1:${gowaPort}`,
      BLOCK_PRIVATE_GOWA_URL: 'false',
      GOWA_WEBHOOK_SECRET: secret,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.stdout?.on('data', (data) => { appLogs += data; });
  app.stderr?.on('data', (data) => { appLogs += data; });
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await fetch(base + '/api/auth/status').then((res) => res.ok).catch(() => false)) break;
    if (attempt === 59) assert.fail(appLogs || 'Server did not start');
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  const login = await request('/api/auth/login', 'POST', {
    username: 'admin', password: 'LocalReactionTest123',
  });
  assert.equal(login.status, 200, await login.clone().text());
  token = (await login.json()).results.token;
  const ticket = (await (await request('/api/auth/ws-ticket', 'POST')).json()).results.ticket;
  client = new WebSocket(`ws://127.0.0.1:${appPort}/ws?ticket=${ticket}`);
  await new Promise<void>((resolve, reject) => {
    client.once('open', resolve);
    client.once('error', reject);
  });
});

it('routes events from a shared upstream socket only to the identified account', async () => {
  for (let attempt = 0; upstreamClients.size < 2 && attempt < 40; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(upstreamClients.size, 2);
  const events: Array<{device_id: string; result: {id: string}}> = [];
  const collect = (frame: Buffer) => {
    for (const event of expandWsFrame(JSON.parse(frame.toString()))) {
      if (event.code === 'MESSAGE_RECEIVED') {
        events.push(event as {device_id: string; result: {id: string}});
      }
    }
  };
  const payload = {...message, media_type: '', content: 'Message for one account'};
  client.on('message', collect);
  try {
    for (const upstream of upstreamClients.values()) {
      upstream.send(JSON.stringify({code: 'MESSAGE_RECEIVED', result: {...payload, id: 'no-source'}}));
      upstream.send(JSON.stringify({code: 'MESSAGE_RECEIVED', device_id: deviceId, result: {...payload, id: 'known-source'}}));
    }
    for (const id of ['known-source', 'webhook-source']) {
      const body = JSON.stringify({event: 'message', device_id: deviceJid, payload: {...payload, id}});
      const signature = createHmac('sha256', secret).update(body).digest('hex');
      const response = await fetch(`${base}/api/webhooks/gowa`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json', 'X-Hub-Signature-256': `sha256=${signature}`},
        body,
      });
      assert.equal(response.status, 204);
    }
    const pairs = () => events.map(({device_id, result}) => [device_id, result.id]);
    for (let attempt = 0; !pairs().some(([, id]) => id === 'webhook-source') && attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(pairs().sort(), [[deviceId, 'known-source'], [deviceId, 'webhook-source']]);
  } finally {
    client.off('message', collect);
  }
});

after(async () => {
  client?.terminate();
  for (const socket of gatewayWs?.clients ?? []) socket.terminate();
  gatewayWs?.close();
  if (app && app.exitCode === null) {
    await new Promise<void>((resolve) => {
      app.once('exit', () => resolve());
      app.kill('SIGTERM');
    });
  }
  if (gateway) await new Promise<void>((resolve) => gateway.close(() => resolve()));
  rmSync(temp, {recursive: true, force: true});
});

it('preserves add, change, and remove after a successful send when the gateway history is stale', async () => {
  snapshots = [remoteReaction];
  const initial = await reactions();
  assert.deepEqual(initial, [['👍', false]]);
  for (const emoji of ['👍', '❤️', '']) {
    if (!emoji) {
      snapshots = [remoteReaction, {...remoteReaction, sender_jid: deviceJid, emoji: '❤️', is_from_me: true}];
    }
    const res = await request(messagePath + `/${messageId}/reaction`, 'POST', {emoji});
    assert.equal(res.status, 200, await res.clone().text());
    assert.deepEqual(await reactions(), emoji ? [['👍', false], [emoji, true]] : [['👍', false]]);
  }
  assert.deepEqual(gatewayEmojis, ['👍', '❤️', '']);
  assert.equal((await request(messagePath + `/${messageId}/reaction`, 'POST', {emoji: '🚫'})).status, 409);
  assert.deepEqual(await reactions(), [['👍', false]]);
});

it('pushes signed document reactions and removals live and ignores stale or unsigned updates', async () => {
  snapshots = [remoteReaction];
  const addedAt = new Date().toISOString();
  const added = waitForReaction();
  await Promise.all([
    added.then((event) => assert.equal(event.emoji, '❤️')),
    webhook('❤️', addedAt).then((res) => assert.equal(res.status, 204)),
  ]);
  assert.deepEqual(await reactions(), [['❤️', false]]);

  const removedAt = new Date(Date.parse(addedAt) + 1000).toISOString();
  const removed = waitForReaction();
  await Promise.all([
    removed.then((event) => assert.equal(event.emoji, '')),
    webhook('', removedAt).then((res) => assert.equal(res.status, 204)),
  ]);
  assert.equal((await webhook('❤️', addedAt)).status, 204);
  assert.equal((await webhook('❤️', removedAt, 'wrong-secret')).status, 401);
  assert.deepEqual(await reactions(), []);
});

it('treats a gateway history response with no reactions field as an empty snapshot', async () => {
  snapshots = [{...remoteReaction, sender_jid: '61400123458@s.whatsapp.net'}];
  assert.deepEqual(await reactions(), [['👍', false]]);
  snapshots = undefined;
  assert.deepEqual(await reactions(), []);
});

it('does not broadcast a late reaction over a newer gateway snapshot', async () => {
  const current = Date.now() + 5000;
  snapshots = [{...remoteReaction, emoji: '😂', timestamp: new Date(current).toISOString()}];
  assert.deepEqual(await reactions(), [['😂', false]]);

  await Promise.all([
    waitForReaction().then((event) => assert.equal(event.emoji, '🙏')),
    (async () => {
      assert.equal((await webhook('❤️', new Date(current - 1000).toISOString())).status, 204);
      assert.equal((await webhook('🙏', new Date(current + 1000).toISOString())).status, 204);
    })(),
  ]);
});
