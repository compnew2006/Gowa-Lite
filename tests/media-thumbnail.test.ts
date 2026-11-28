import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, it} from 'node:test';
import sharp from 'sharp';
import {WebSocketServer, type WebSocket} from 'ws';
import {createImageThumbnail} from '../server/services/inbox-media.ts';

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

describe('Server Image Thumbnails (createImageThumbnail)', () => {
  it('downscales a large photo to at most 320px on the long side as JPEG', async () => {
    const input = await sharp({
      create: {width: 1200, height: 800, channels: 3, background: {r: 200, g: 30, b: 30}},
    })
      .jpeg({quality: 90})
      .toBuffer();

    const thumb = await createImageThumbnail(input, 'image/jpeg');

    assert.equal(thumb.contentType, 'image/jpeg');
    assert.equal(thumb.width, 320);
    assert.equal(thumb.height, 213);
    assert.ok(
      thumb.buffer.byteLength < input.byteLength,
      `Expected thumbnail (${thumb.buffer.byteLength}B) smaller than the photo (${input.byteLength}B)`,
    );
    const decoded = await sharp(thumb.buffer).metadata();
    assert.equal(decoded.format, 'jpeg');
    assert.equal(decoded.width, 320);
  });

  it('converts PNG input to JPEG without enlarging small images', async () => {
    const input = await sharp({
      create: {width: 100, height: 80, channels: 4, background: {r: 30, g: 120, b: 200, alpha: 1}},
    })
      .png()
      .toBuffer();

    const thumb = await createImageThumbnail(input, 'image/png');

    assert.equal(thumb.contentType, 'image/jpeg');
    assert.equal(thumb.width, 100);
    assert.equal(thumb.height, 80);
  });

  it('rejects non-image content instead of producing a bogus thumbnail', async () => {
    const input = Buffer.from('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    await assert.rejects(createImageThumbnail(input, 'video/mp4'), (err: unknown) => {
      assert.equal((err as {code?: string}).code, 'THUMBNAIL_UNSUPPORTED');
      assert.equal((err as {status?: number}).status, 415);
      return true;
    });
  });

  it('rejects corrupt image bytes', async () => {
    await assert.rejects(createImageThumbnail(Buffer.from('not-an-image'), 'image/jpeg'));
  });
});

describe('Integration: GET /api/unified/media/thumbnail', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gowa-lite-media-thumb-'));
  const dbPath = path.join(tmpDir, 'test.db');

  let mockGowaServer: http.Server;
  let mockGowaWss: WebSocketServer;
  const mockWsClients = new Map<string, WebSocket>();
  let mockGowaPort = 0;
  let appPort = 0;
  let baseUrl = '';
  let serverProc: ChildProcess;
  let token = '';

  let gowaBinaryFetchCalls = 0;
  let samplePhotoBytes = Buffer.alloc(0);
  const sampleVideoBytes = Buffer.from('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  const phone = '966501000001@s.whatsapp.net';

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
    samplePhotoBytes = await sharp({
      create: {width: 1200, height: 800, channels: 3, background: {r: 200, g: 30, b: 30}},
    })
      .jpeg({quality: 90})
      .toBuffer();

    mockGowaServer = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');

      if (url.pathname === '/statics/sample.jpg' && req.method === 'GET') {
        gowaBinaryFetchCalls += 1;
        res.setHeader('Content-Type', 'image/jpeg');
        res.end(samplePhotoBytes);
        return;
      }
      if (url.pathname === '/statics/sample.mp4' && req.method === 'GET') {
        gowaBinaryFetchCalls += 1;
        res.setHeader('Content-Type', 'video/mp4');
        res.end(sampleVideoBytes);
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
            results: {
              data: [
                {
                  jid: phone,
                  name: 'Pending Alpha',
                  last_message_time: new Date().toISOString(),
                  unread_count: 0,
                },
              ],
              pagination: {limit: 100, offset: 0, total: 1},
            },
          }),
        );
        return;
      }
      if (url.pathname === '/message/msg-photo-1/download' && req.method === 'GET') {
        res.end(
          JSON.stringify({
            code: 'SUCCESS',
            message: 'ok',
            results: {
              message_id: 'msg-photo-1',
              media_type: 'image',
              filename: 'photo.jpg',
              file_path: 'statics/sample.jpg',
              file_size: samplePhotoBytes.byteLength,
            },
          }),
        );
        return;
      }
      if (url.pathname === '/message/msg-video-1/download' && req.method === 'GET') {
        res.end(
          JSON.stringify({
            code: 'SUCCESS',
            message: 'ok',
            results: {
              message_id: 'msg-video-1',
              media_type: 'video',
              filename: 'clip.mp4',
              file_path: 'statics/sample.mp4',
              file_size: sampleVideoBytes.byteLength,
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
    token = (setupRes.body?.results as {token: string}).token;
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

  it('serves a small JPEG thumbnail for a large photo and caches the upstream bytes', async () => {
    const thumbPath = `/api/unified/media/thumbnail?deviceId=dev-1&messageId=msg-photo-1&phone=${encodeURIComponent(phone)}`;
    const first = await api(thumbPath, {token});
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('content-type'), 'image/jpeg');
    assert.equal(first.headers.get('x-thumbnail-width'), '320');
    assert.equal(first.headers.get('x-thumbnail-height'), '213');
    assert.ok(
      first.rawBuffer.byteLength < samplePhotoBytes.byteLength,
      `Expected thumbnail (${first.rawBuffer.byteLength}B) smaller than the photo (${samplePhotoBytes.byteLength}B)`,
    );
    const decoded = await sharp(first.rawBuffer).metadata();
    assert.equal(decoded.format, 'jpeg');
    assert.equal(decoded.width, 320);
    assert.equal(decoded.height, 213);

    const second = await api(thumbPath, {token});
    assert.equal(second.status, 200);
    assert.equal(
      gowaBinaryFetchCalls,
      1,
      'Upstream photo bytes should be fetched only once across thumbnail requests',
    );
  });

  it('rejects thumbnails for video with 415 and keeps the same auth rules as download', async () => {
    const video = await api(
      `/api/unified/media/thumbnail?deviceId=dev-1&messageId=msg-video-1&phone=${encodeURIComponent(phone)}`,
      {token},
    );
    assert.equal(video.status, 415);
    assert.equal(video.body?.code, 'THUMBNAIL_UNSUPPORTED');

    const noAuth = await api(
      `/api/unified/media/thumbnail?deviceId=dev-1&messageId=msg-photo-1&phone=${encodeURIComponent(phone)}`,
    );
    assert.equal(noAuth.status, 401);

    const missing = await api('/api/unified/media/thumbnail?deviceId=dev-1', {token});
    assert.equal(missing.status, 400);

    const unknown = await api(
      `/api/unified/media/thumbnail?deviceId=dev-1&messageId=msg-nope&phone=${encodeURIComponent(phone)}`,
      {token},
    );
    assert.equal(unknown.status, 404);
  });
});
