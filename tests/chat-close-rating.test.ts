import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {createHmac} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {createServer, type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, it} from 'node:test';

const deviceId = 'rating-line';
const deviceJid = '201000000011@s.whatsapp.net';
const secret = 'rating-fixture-signing-secret';
const folder = mkdtempSync(join(tmpdir(), 'gowa-lite-rating-'));
const sends: Array<{device: string | undefined; phone: string; message: string}> = [];
let gateway: Server;
let app: ChildProcess;
let base: string;
let token: string;
let rejectSends = false;
const history = new Map<string, {lastMessageTime: string; messages: unknown[]}>();

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function api(path: string, method = 'GET', body?: unknown, auth = token) {
  return fetch(base + '/api' + path, {
    method,
    headers: {Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function chatPath(jid: string, action: string, device = deviceId) {
  return `/unified/chats/${device}/${encodeURIComponent(jid)}/${action}`;
}

async function results(response: Response) {
  assert.ok(response.ok, await response.clone().text());
  return (await response.json()).results;
}

function incoming(jid: string, id: string, body: string, options: {device?: string; signed?: boolean; timestamp?: string} = {}) {
  const payload = JSON.stringify({
    event: 'message',
    device_id: options.device ?? deviceJid,
    payload: {id, body, from: jid, chat_id: jid, is_from_me: false, timestamp: options.timestamp ?? new Date().toISOString()},
  });
  const digest = createHmac('sha256', options.signed === false ? 'wrong' : secret).update(payload).digest('hex');
  return fetch(base + '/api/webhooks/gowa', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=' + digest},
    body: payload,
  });
}

before(async () => {
  gateway = createServer(async (req, res) => {
    const path = new URL(req.url!, 'http://localhost').pathname;
    if (path === '/devices') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({code: 'SUCCESS', results: [
        {id: deviceId, jid: deviceJid, state: 'logged_in'},
        {id: 'other-line', jid: '201000000012@s.whatsapp.net', state: 'logged_in'},
      ]}));
      return;
    }
    if (path === '/send/message' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      sends.push({device: req.headers['x-device-id']?.toString(), ...body});
      res.writeHead(rejectSends ? 503 : 200, {'Content-Type': 'application/json'});
      res.end(JSON.stringify(rejectSends
        ? {code: 'UNAVAILABLE', message: 'offline'}
        : {code: 'SUCCESS', results: {message_id: 'prompt-' + sends.length}}));
      return;
    }
    if (path === '/chats') {
      const data = [...history].map(([jid, entry]) => ({
        jid, name: 'Customer', last_message_time: entry.lastMessageTime, archived: false,
      }));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({code: 'SUCCESS', results: {data, pagination: {total: data.length}}}));
      return;
    }
    const messagesPath = /^\/chat\/([^/]+)\/messages$/.exec(path);
    if (messagesPath) {
      const data = history.get(decodeURIComponent(messagesPath[1]))?.messages ?? [];
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({code: 'SUCCESS', results: {data, pagination: {total: data.length}}}));
      return;
    }
    res.writeHead(404).end();
  });
  const gatewayPort = await listen(gateway);
  const probe = createServer();
  const appPort = await listen(probe);
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  base = `http://127.0.0.1:${appPort}`;
  app = spawn(process.execPath, ['server.ts'], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(appPort),
      ADMIN_PASSCODE: 'RatingFixturePasscode123',
      GOWA_LITE_DB_PATH: join(folder, 'fixture.db'),
      GOWA_URL: `http://127.0.0.1:${gatewayPort}`,
      GOWA_WEBHOOK_SECRET: secret,
      BLOCK_PRIVATE_GOWA_URL: 'false',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let error = '';
  app.stderr?.on('data', (data) => { error += data; });
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await fetch(base + '/api/auth/status').then((res) => res.ok).catch(() => false)) break;
    if (attempt === 59) assert.fail(error || 'Server did not start');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  token = (await results(await api('/auth/login', 'POST', {username: 'admin', password: 'RatingFixturePasscode123'}))).token;
});

after(async () => {
  if (app && app.exitCode === null) {
    await new Promise<void>((resolve) => { app.once('exit', () => resolve()); app.kill('SIGTERM'); });
  }
  gateway?.closeAllConnections();
  if (gateway) await new Promise<void>((resolve) => gateway.close(() => resolve()));
  rmSync(folder, {recursive: true, force: true});
});

it('opts in per account, prompts once on close and records the customer rating without reopening', async () => {
  const settings = '/devices/rating-line/close-ratings';
  assert.equal((await results(await api(settings))).enabled, false);
  assert.equal((await api(settings, 'PUT', {enabled: 'true'})).status, 400);
  assert.equal((await results(await api(settings, 'PUT', {enabled: true}))).enabled, true);
  assert.equal((await results(await api('/devices/other-line/close-ratings'))).enabled, false);

  const jid = '201000000101@s.whatsapp.net';
  const closed = await results(await api(chatPath(jid, 'close'), 'POST'));
  assert.equal(closed.assignment.status, 'closed');
  assert.equal(closed.rating_prompt, 'sent');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].device, deviceId);
  assert.equal(sends[0].phone, jid);
  assert.match(sends[0].message, /1.*5/s);
  await results(await api(chatPath(jid, 'close'), 'POST'));
  assert.equal(sends.length, 1);

  assert.equal((await incoming(jid, 'rating-1', '٥', {signed: false})).status, 401);
  assert.equal((await incoming(jid, 'other-device', '2', {device: 'other-line'})).status, 204);
  assert.equal((await results(await api(settings))).count, 0);
  assert.equal((await incoming(jid, 'rating-1', '٥')).status, 204);
  assert.equal((await incoming(jid, 'rating-1', '٥')).status, 204);
  const report = await results(await api(settings));
  assert.equal(report.count, 1);
  assert.equal(report.average, 5);
  assert.equal(report.recent[0].score, 5);
  assert.equal((await results(await api(chatPath(jid, 'lifecycle')))).assignment.status, 'closed');
});

it('lets an ordinary reply reopen the chat, and a failed prompt does not undo closure', async () => {
  const jid = '201000000102@s.whatsapp.net';
  await results(await api(chatPath(jid, 'close'), 'POST'));
  assert.equal((await incoming(jid, 'old', '5', {timestamp: '2020-01-01T00:00:00Z'})).status, 204);
  assert.equal((await results(await api(chatPath(jid, 'lifecycle')))).assignment.status, 'closed');
  assert.equal((await incoming(jid, 'help', 'I still need help with 5 items')).status, 204);
  assert.equal((await results(await api(chatPath(jid, 'lifecycle')))).assignment.status, 'pending');

  rejectSends = true;
  const failed = await results(await api(chatPath(jid, 'close'), 'POST'));
  rejectSends = false;
  assert.equal(failed.rating_prompt, 'failed');
  assert.equal(failed.assignment.status, 'closed');
});

it('does not send rating prompts for excluded accounts or blocked conversations', async () => {
  const start = sends.length;
  const jid = '201000000103@s.whatsapp.net';
  await results(await api(chatPath(jid, 'close', 'other-line'), 'POST'));
  await results(await api(chatPath(jid, 'block'), 'POST', {blocked: true}));
  await results(await api(chatPath(jid, 'close'), 'POST'));
  assert.equal(sends.length, start);
});

it('captures ratings when scoped message history catches up before the webhook arrives', async () => {
  const jid = '201000000104@s.whatsapp.net';
  const inbox = '/unified/chats?deviceId=rating-line';
  history.set(jid, {lastMessageTime: new Date(Date.now() - 60_000).toISOString(), messages: []});
  await results(await api(inbox));
  await results(await api(chatPath(jid, 'close'), 'POST'));

  // The inbox treats timestamps within a second of the cached prompt as synchronized.
  const timestamp = new Date(Date.now() + 2000).toISOString();
  history.set(jid, {lastMessageTime: timestamp, messages: [{
    id: 'rating-from-history', chat_jid: jid, sender_jid: jid, content: '3',
    timestamp, is_from_me: false, media_type: '', filename: '', url: '', file_length: 0,
  }]});
  await results(await api(inbox));
  assert.ok((await results(await api('/devices/rating-line/close-ratings'))).recent
    .some((rating: {score: number}) => rating.score === 3));
  assert.equal((await results(await api(chatPath(jid, 'lifecycle')))).assignment.status, 'closed');
});
