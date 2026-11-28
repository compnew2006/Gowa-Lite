import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, it} from 'node:test';
import {WebSocketServer} from 'ws';

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

function makeFileBytes(size: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) {
    bytes[i] = i % 251;
  }
  return bytes;
}

async function multipartByteLength(form: FormData): Promise<number> {
  return (await new Response(form).arrayBuffer()).byteLength;
}

describe('P4 Multipart upload for /send-media', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gowa-lite-multipart-'));
  const dbPath = path.join(tmpDir, 'test.db');

  let mockGowaServer: http.Server;
  let mockGowaWss: WebSocketServer;
  let mockGowaPort = 0;
  let appPort = 0;
  let baseUrl = '';
  let serverProc: ChildProcess;
  let token = '';

  let lastGatewayUpload: {
    endpoint: string;
    contentType: string;
    rawBody: Buffer;
  } | null = null;
  let gatewayUploadCount = 0;

  async function api(
    urlPath: string,
    opts: {method?: string; body?: BodyInit; headers?: Record<string, string>} = {},
  ): Promise<{status: number; body: Record<string, unknown> | null; rawBuffer: Buffer}> {
    const res = await fetch(`${baseUrl}${urlPath}`, {
      method: opts.method ?? 'GET',
      headers: {
        ...(opts.headers ?? {}),
        ...(token ? {Authorization: `Bearer ${token}`} : {}),
      },
      body: opts.body,
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
    return {status: res.status, body, rawBuffer};
  }

  before(async () => {
    mockGowaServer = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks);
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
        if (
          (url.pathname === '/send/image' ||
            url.pathname === '/send/video' ||
            url.pathname === '/send/audio' ||
            url.pathname === '/send/file') &&
          req.method === 'POST'
        ) {
          gatewayUploadCount += 1;
          lastGatewayUpload = {
            endpoint: url.pathname,
            contentType: req.headers['content-type'] || '',
            rawBody,
          };
          res.end(
            JSON.stringify({
              code: 'SUCCESS',
              message: 'ok',
              results: {message_id: 'gw-msg-1', status: 'sent'},
            }),
          );
          return;
        }
        res.end(JSON.stringify({code: 'SUCCESS', message: 'ok', results: []}));
      });
    });

    mockGowaWss = new WebSocketServer({server: mockGowaServer, path: '/ws'});

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
    for (let i = 0; i < 80; i += 1) {
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

    const setupRes = await api('/api/auth/setup', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        display_name: 'Admin User',
        username: 'admin',
        password: 'Password123',
        gowa_url: `http://127.0.0.1:${mockGowaPort}`,
        gowa_username: 'gowa',
        gowa_password: 'secret',
      }),
    });
    assert.equal(setupRes.status, 201);
    token = (setupRes.body?.results as {token: string}).token;
  });

  after(async () => {
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

  it('uploads a 1 MB image as multipart/form-data with the identical envelope', async () => {
    const fileBytes = makeFileBytes(1024 * 1024);
    const form = new FormData();
    form.append('file', new File([fileBytes], 'photo.jpg', {type: 'image/jpeg'}));
    form.append('caption', 'hello caption');

    // Measurement: exact client -> server request bytes for this file.
    const requestBytes = await multipartByteLength(
      (() => {
        const f = new FormData();
        f.append('file', new File([fileBytes], 'photo.jpg', {type: 'image/jpeg'}));
        f.append('caption', 'hello caption');
        return f;
      })(),
    );
    console.log(
      `[multipart-measure] 1MB image: fileBytes=${fileBytes.byteLength} multipartRequestBytes=${requestBytes} overheadBytes=${requestBytes - fileBytes.byteLength}`,
    );

    const startedAt = performance.now();
    const res = await api(
      '/api/unified/chats/dev-1/966501000001@s.whatsapp.net/send-media',
      {method: 'POST', body: form},
    );
    const elapsedMs = performance.now() - startedAt;
    console.log(`[multipart-measure] 1MB image: routeWallMs=${elapsedMs.toFixed(1)}`);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      code: 'SUCCESS',
      message: 'تم إرسال المرفق',
      results: {message_id: 'gw-msg-1', status: 'sent'},
    });
    assert.equal(gatewayUploadCount, 1);
    assert.equal(lastGatewayUpload?.endpoint, '/send/image');
    assert.match(lastGatewayUpload?.contentType ?? '', /^multipart\/form-data; boundary=/);
    // The gateway must receive the raw file bytes, never a base64 encoding of them.
    assert.ok(
      lastGatewayUpload!.rawBody.indexOf(fileBytes) >= 0,
      'gateway should receive the raw file bytes',
    );
    assert.equal(
      lastGatewayUpload!.rawBody.indexOf(Buffer.from(fileBytes).toString('base64')),
      -1,
      'gateway request body must not contain base64 of the file',
    );
    assert.ok(
      lastGatewayUpload!.rawBody.includes(Buffer.from('hello caption')),
      'caption must reach the gateway',
    );
    assert.ok(
      lastGatewayUpload!.rawBody.includes(Buffer.from('photo.jpg')),
      'filename must reach the gateway',
    );
  });

  it('uploads a 5 MB document as multipart/form-data', async () => {
    const fileBytes = makeFileBytes(5 * 1024 * 1024);
    const form = new FormData();
    form.append('file', new File([fileBytes], 'report.pdf', {type: 'application/pdf'}));

    const requestBytes = await multipartByteLength(
      (() => {
        const f = new FormData();
        f.append('file', new File([fileBytes], 'report.pdf', {type: 'application/pdf'}));
        return f;
      })(),
    );
    console.log(
      `[multipart-measure] 5MB document: fileBytes=${fileBytes.byteLength} multipartRequestBytes=${requestBytes} overheadBytes=${requestBytes - fileBytes.byteLength}`,
    );

    const startedAt = performance.now();
    const res = await api(
      '/api/unified/chats/dev-1/966501000001@s.whatsapp.net/send-media',
      {method: 'POST', body: form},
    );
    const elapsedMs = performance.now() - startedAt;
    console.log(`[multipart-measure] 5MB document: routeWallMs=${elapsedMs.toFixed(1)}`);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      code: 'SUCCESS',
      message: 'تم إرسال المرفق',
      results: {message_id: 'gw-msg-1', status: 'sent'},
    });
    assert.equal(lastGatewayUpload?.endpoint, '/send/file');
    assert.ok(lastGatewayUpload!.rawBody.indexOf(fileBytes) >= 0);
    assert.equal(lastGatewayUpload!.rawBody.indexOf(Buffer.from(fileBytes).toString('base64')), -1);
  });

  it('still accepts the legacy raw octet-stream body (pre-multipart clients)', async () => {
    const fileBytes = makeFileBytes(1024);
    const before = gatewayUploadCount;
    const res = await api(
      '/api/unified/chats/dev-1/966501000001@s.whatsapp.net/send-media?filename=legacy.jpg&mimeType=image/jpeg&caption=legacy',
      {
        method: 'POST',
        headers: {'Content-Type': 'application/octet-stream'},
        body: fileBytes as unknown as BodyInit,
      },
    );

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      code: 'SUCCESS',
      message: 'تم إرسال المرفق',
      results: {message_id: 'gw-msg-1', status: 'sent'},
    });
    assert.equal(gatewayUploadCount, before + 1);
    assert.equal(lastGatewayUpload?.endpoint, '/send/image');
    assert.ok(lastGatewayUpload!.rawBody.indexOf(fileBytes) >= 0);
  });

  it('rejects a file over 20 MB with the same 413 envelope as today', async () => {
    const fileBytes = makeFileBytes(20 * 1024 * 1024 + 1);
    const form = new FormData();
    form.append('file', new File([fileBytes], 'huge.bin', {type: 'application/octet-stream'}));

    const res = await api(
      '/api/unified/chats/dev-1/966501000001@s.whatsapp.net/send-media',
      {method: 'POST', body: form},
    );

    assert.equal(res.status, 413);
    assert.deepEqual(res.body, {
      code: 'PAYLOAD_TOO_LARGE',
      message: 'حجم الملف يتجاوز الحد الأقصى المسموح به (20 ميجابايت)',
    });
    assert.equal(gatewayUploadCount, 3, 'oversized file must never reach the gateway');
  });

  it('rejects a multipart request without a file with the same 400 envelope as today', async () => {
    const form = new FormData();
    form.append('caption', 'no file here');

    const res = await api(
      '/api/unified/chats/dev-1/966501000001@s.whatsapp.net/send-media',
      {method: 'POST', body: form},
    );

    assert.equal(res.status, 400);
    assert.deepEqual(res.body, {
      code: 'VALIDATION_ERROR',
      message: 'محتوى الملف مطلوب',
    });
  });

  it('frontend sends FormData with field "file" and no longer copies the file into an ArrayBuffer', () => {
    const chatsSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'src/api/requests/chats.ts'),
      'utf8',
    );
    const sendMediaFn = chatsSrc.slice(
      chatsSrc.indexOf('export async function sendUnifiedMediaMessage'),
    );
    assert.match(sendMediaFn, /new FormData\(\)/);
    assert.match(sendMediaFn, /form\.append\('file', payload\.file/);
    assert.equal(
      sendMediaFn.includes('arrayBuffer'),
      false,
      'sendUnifiedMediaMessage must not copy the file into an ArrayBuffer anymore',
    );
    assert.equal(
      sendMediaFn.includes('application/octet-stream'),
      false,
      'sendUnifiedMediaMessage must not post a raw octet-stream body anymore',
    );

    const routeSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'server/routes/inbox-messages.ts'),
      'utf8',
    );
    assert.match(routeSrc, /multer/);
    assert.match(routeSrc, /\.single\('file'\)/);
    assert.match(routeSrc, /limits:\s*\{\s*fileSize:\s*MAX_MEDIA_UPLOAD_BYTES\s*\}/);
  });
});
