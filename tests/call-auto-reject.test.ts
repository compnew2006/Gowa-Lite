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

const deviceId = 'call-line';
const deviceJid = '201000000021@s.whatsapp.net';
const otherDeviceId = 'other-call-line';
const otherDeviceJid = '201000000022@s.whatsapp.net';
const secret = 'call-auto-reject-fixture-secret';
const folder = mkdtempSync(join(tmpdir(), 'gowa-lite-call-reject-'));

const rejections: Array<{device: string | undefined; caller_jid: string; call_id: string}> = [];
const sends: Array<{device: string | undefined; phone: string; message: string}> = [];
let rejectShouldFail = false;
let sendShouldFail = false;

let gateway: Server;
let gatewayWss: WebSocketServer;
const upstreamSockets = new Set<WebSocket>();
let app: ChildProcess;
let base: string;
let wsBase: string;
let adminToken: string;

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function api(path: string, method = 'GET', body?: unknown, auth = adminToken) {
  return fetch(base + '/api' + path, {
    method,
    headers: {Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function results(response: Response) {
  assert.ok(response.ok, await response.clone().text());
  return (await response.json()).results;
}

function sendCallWebhook(
  callId: string,
  from: string,
  options: {
    event?: string;
    device?: string;
    signed?: boolean;
    autoRejected?: boolean;
    senderDisplayName?: string;
  } = {},
) {
  const payload = JSON.stringify({
    event: options.event ?? 'call.offer',
    device_id: options.device ?? deviceJid,
    payload: {
      call_id: callId,
      from,
      sender_display_name: options.senderDisplayName ?? 'عميل متصل',
      auto_rejected: options.autoRejected ?? false,
    },
  });
  const digest = createHmac('sha256', options.signed === false ? 'wrong-secret' : secret)
    .update(payload)
    .digest('hex');
  return fetch(base + '/api/webhooks/gowa', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=' + digest},
    body: payload,
  });
}

before(async () => {
  gateway = createServer(async (req, res) => {
    const pathname = new URL(req.url!, 'http://localhost').pathname;
    if (pathname === '/devices') {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          code: 'SUCCESS',
          results: [
            {id: deviceId, jid: deviceJid, state: 'logged_in'},
            {id: otherDeviceId, jid: otherDeviceJid, state: 'logged_in'},
          ],
        }),
      );
      return;
    }
    if (pathname === '/call/reject' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw) as {caller_jid: string; call_id: string};
      rejections.push({device: req.headers['x-device-id']?.toString(), ...body});
      res.writeHead(rejectShouldFail ? 503 : 200, {'Content-Type': 'application/json'});
      res.end(
        JSON.stringify(
          rejectShouldFail
            ? {code: 'UNAVAILABLE', message: 'call reject failed'}
            : {code: 'SUCCESS', results: {status: 'rejected'}},
        ),
      );
      return;
    }
    if (pathname === '/send/message' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw) as {phone: string; message: string};
      sends.push({device: req.headers['x-device-id']?.toString(), ...body});
      res.writeHead(sendShouldFail ? 503 : 200, {'Content-Type': 'application/json'});
      res.end(
        JSON.stringify(
          sendShouldFail
            ? {code: 'UNAVAILABLE', message: 'send failed'}
            : {code: 'SUCCESS', results: {message_id: 'call-reply-msg-' + sends.length}},
        ),
      );
      return;
    }
    if (/^\/chat\/[^/]+\/messages$/.test(pathname)) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({code: 'SUCCESS', results: {data: [], pagination: {total: 0}}}));
      return;
    }
    res.writeHead(404).end();
  });

  gatewayWss = new WebSocketServer({server: gateway});
  gatewayWss.on('connection', (socket) => {
    upstreamSockets.add(socket);
    socket.on('close', () => upstreamSockets.delete(socket));
  });

  const gatewayPort = await listen(gateway);
  const probe = createServer();
  const appPort = await listen(probe);
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  base = `http://127.0.0.1:${appPort}`;
  wsBase = `ws://127.0.0.1:${appPort}`;

  app = spawn(process.execPath, ['server.ts'], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(appPort),
      ADMIN_PASSCODE: 'CallRejectFixture123',
      GOWA_LITE_DB_PATH: join(folder, 'fixture.db'),
      GOWA_URL: `http://127.0.0.1:${gatewayPort}`,
      GOWA_WEBHOOK_SECRET: secret,
      BLOCK_PRIVATE_GOWA_URL: 'false',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  let stderr = '';
  app.stderr?.on('data', (chunk) => {
    stderr += chunk;
  });
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await fetch(base + '/api/auth/status').then((r) => r.ok).catch(() => false)) break;
    if (attempt === 119) assert.fail(stderr || 'Server did not start');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  adminToken = (
    await results(
      await api('/auth/login', 'POST', {username: 'admin', password: 'CallRejectFixture123'}),
    )
  ).token;
});

after(async () => {
  for (const sock of upstreamSockets) sock.close();
  gatewayWss?.close();
  if (app && app.exitCode === null) {
    await new Promise<void>((resolve) => {
      app.once('exit', () => resolve());
      app.kill('SIGTERM');
    });
  }
  gateway?.closeAllConnections();
  if (gateway) await new Promise<void>((resolve) => gateway.close(() => resolve()));
  rmSync(folder, {recursive: true, force: true});
});

it('isolates per-account auto-reject settings, validates inputs, and enforces permissions', async () => {
  const endpoint = `/devices/${deviceId}/call/auto-reject`;
  const initial = await results(await api(endpoint));
  assert.equal(initial.enabled, false);
  assert.equal(initial.is_custom_message, false);
  assert.equal(initial.webhook_configured, true);
  assert.ok(initial.default_message.length > 10);

  assert.equal((await api(endpoint, 'PUT', {})).status, 400);
  assert.equal((await api(endpoint, 'PUT', {enabled: 'true'})).status, 400);

  const customMsg = 'عذرًا، لا يمكن استقبال المكالمات على هذا الرقم. راسلنا نصيًا وسنخدمك فورًا.';
  const updated = await results(
    await api(endpoint, 'PUT', {enabled: true, reply_message: customMsg}),
  );
  assert.equal(updated.enabled, true);
  assert.equal(updated.is_custom_message, true);
  assert.equal(updated.reply_message, customMsg);

  // Other account remains disabled by default
  const other = await results(await api(`/devices/${otherDeviceId}/call/auto-reject`));
  assert.equal(other.enabled, false);
  assert.equal(other.is_custom_message, false);

  // Agent without misc:calls.reject or accounts:read cannot access or modify auto-reject settings
  await results(
    await api('/users', 'POST', {
      display_name: 'وكيل عادي',
      username: 'agent.calls',
      password: 'AgentPassword123',
      role: 'agent',
      allowed_device_ids: [deviceId],
    }),
  );
  const agentToken = (
    await results(
      await api('/auth/login', 'POST', {
        username: 'agent.calls',
        password: 'AgentPassword123',
      }),
    )
  ).token;

  assert.equal((await api(endpoint, 'GET', undefined, agentToken)).status, 403);
  assert.equal((await api(endpoint, 'PUT', {enabled: false}, agentToken)).status, 403);
});

it('rejects incoming call webhook on enabled account, sends custom reply, caches message, and deduplicates retries', async () => {
  const callerJid = '201000000501@s.whatsapp.net';

  // Invalid signature rejected
  assert.equal((await sendCallWebhook('call-bad-sig', callerJid, {signed: false})).status, 401);

  // Disabled account ignores incoming call
  const beforeRejections = rejections.length;
  const beforeSends = sends.length;
  assert.equal(
    (await sendCallWebhook('call-other-acc', callerJid, {device: otherDeviceJid})).status,
    204,
  );
  assert.equal(rejections.length, beforeRejections);
  assert.equal(sends.length, beforeSends);

  // Enabled account rejects call + sends custom message
  assert.equal((await sendCallWebhook('call-101', callerJid)).status, 204);
  assert.equal(rejections.length, beforeRejections + 1);
  assert.deepEqual(rejections[rejections.length - 1], {
    device: deviceId,
    caller_jid: callerJid,
    call_id: 'call-101',
  });
  assert.equal(sends.length, beforeSends + 1);
  assert.deepEqual(sends[sends.length - 1], {
    device: deviceId,
    phone: callerJid,
    message: 'عذرًا، لا يمكن استقبال المكالمات على هذا الرقم. راسلنا نصيًا وسنخدمك فورًا.',
  });

  // Duplicate webhook for the same call_id is ignored atomically
  assert.equal((await sendCallWebhook('call-101', callerJid)).status, 204);
  assert.equal(rejections.length, beforeRejections + 1);
  assert.equal(sends.length, beforeSends + 1);

  // Outbound reply is cached in unified chat messages
  const msgs = await results(
    await api(`/unified/chats/${deviceId}/${encodeURIComponent(callerJid)}/messages`),
  );
  assert.ok(
    msgs.data.some(
      (m: {is_from_me: boolean; content: string}) =>
        m.is_from_me && m.content.includes('لا يمكن استقبال المكالمات'),
    ),
  );

  // Log entry appears in settings recent list
  const settings = await results(await api(`/devices/${deviceId}/call/auto-reject`));
  assert.equal(settings.recent[0].call_id, 'call-101');
  assert.equal(settings.recent[0].reject_status, 'rejected');
  assert.equal(settings.recent[0].reply_status, 'sent');
});

it('handles upstream WebSocket CALL_OFFER and broadcasts CALL_AUTO_REJECTED to authorized clients', async () => {
  const {ticket} = await results(await api('/auth/ws-ticket', 'POST', {}));
  const clientWs = new WebSocket(`${wsBase}/ws?ticket=${ticket}`);
  const receivedEvents: Array<{code: string; device_id?: string; result?: {call_id?: string}}> = [];

  await new Promise<void>((resolve, reject) => {
    clientWs.once('open', () => resolve());
    clientWs.once('error', reject);
  });
  clientWs.on('message', (data) => {
    try {
      for (const event of expandWsFrame(JSON.parse(data.toString()))) {
        receivedEvents.push(event as {code: string; device_id?: string; result?: {call_id?: string}});
      }
    } catch {
      // ignore non-json
    }
  });

  // Wait until upstream WS connection is established by bridge
  for (let i = 0; i < 40; i++) {
    if (upstreamSockets.size > 0) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(upstreamSockets.size > 0, 'Expected upstream WS socket connection');

  const callerJid = '201000000502@s.whatsapp.net';
  const beforeRejections = rejections.length;
  const beforeSends = sends.length;

  for (const sock of upstreamSockets) {
    sock.send(
      JSON.stringify({
        code: 'CALL_OFFER',
        device_id: deviceId,
        result: {
          call_id: 'call-ws-202',
          from: callerJid,
          sender_display_name: 'متصل عبر البث',
          auto_rejected: false,
        },
      }),
    );
  }

  // Wait for async WS broadcast CALL_AUTO_REJECTED
  for (let i = 0; i < 40; i++) {
    if (
      receivedEvents.some(
        (ev) => ev.code === 'CALL_AUTO_REJECTED' && ev.result?.call_id === 'call-ws-202',
      )
    ) {
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  clientWs.close();

  const autoEvent = receivedEvents.find(
    (ev) => ev.code === 'CALL_AUTO_REJECTED' && ev.result?.call_id === 'call-ws-202',
  );
  assert.ok(autoEvent, 'Expected CALL_AUTO_REJECTED WebSocket event');
  assert.equal(autoEvent.device_id, deviceId);
  assert.equal(rejections.length, beforeRejections + 1);
  assert.equal(sends.length, beforeSends + 1);

  // Webhook arrival for same call_id after WS is deduplicated
  assert.equal((await sendCallWebhook('call-ws-202', callerJid)).status, 204);
  assert.equal(rejections.length, beforeRejections + 1);
  assert.equal(sends.length, beforeSends + 1);
});

it('handles already-rejected calls, silent mode (empty reply), blocked callers, and reset_message', async () => {
  const endpoint = `/devices/${deviceId}/call/auto-reject`;
  const callerAlready = '201000000503@s.whatsapp.net';

  // auto_rejected: true skips /call/reject but still sends reply message
  const rejBefore = rejections.length;
  const sendBefore = sends.length;
  assert.equal(
    (await sendCallWebhook('call-already-303', callerAlready, {autoRejected: true})).status,
    204,
  );
  assert.equal(rejections.length, rejBefore);
  assert.equal(sends.length, sendBefore + 1);

  let settings = await results(await api(endpoint));
  assert.equal(settings.recent[0].call_id, 'call-already-303');
  assert.equal(settings.recent[0].reject_status, 'already_rejected');
  assert.equal(settings.recent[0].reply_status, 'sent');

  // Empty reply_message enables silent auto-reject
  const silentUpdated = await results(await api(endpoint, 'PUT', {reply_message: ''}));
  assert.equal(silentUpdated.reply_message, '');
  assert.equal(silentUpdated.is_custom_message, true);

  const callerSilent = '201000000504@s.whatsapp.net';
  assert.equal((await sendCallWebhook('call-silent-404', callerSilent)).status, 204);
  assert.equal(rejections.length, rejBefore + 1);
  assert.equal(sends.length, sendBefore + 1); // no message sent

  settings = await results(await api(endpoint));
  assert.equal(settings.recent[0].call_id, 'call-silent-404');
  assert.equal(settings.recent[0].reject_status, 'rejected');
  assert.equal(settings.recent[0].reply_status, 'no_message');

  // Reset restores default message; blocked caller gets skipped reply
  const reset = await results(await api(endpoint, 'PUT', {reset_message: true}));
  assert.equal(reset.is_custom_message, false);
  assert.equal(reset.reply_message, reset.default_message);

  const blockedCaller = '201000000505@s.whatsapp.net';
  await results(
    await api(`/unified/chats/${deviceId}/${encodeURIComponent(blockedCaller)}/block`, 'POST', {
      blocked: true,
    }),
  );
  assert.equal((await sendCallWebhook('call-blocked-505', blockedCaller)).status, 204);
  assert.equal(rejections.length, rejBefore + 2);
  assert.equal(sends.length, sendBefore + 1); // skipped for blocked chat

  settings = await results(await api(endpoint));
  assert.equal(settings.recent[0].call_id, 'call-blocked-505');
  assert.equal(settings.recent[0].reject_status, 'rejected');
  assert.equal(settings.recent[0].reply_status, 'skipped');
});
