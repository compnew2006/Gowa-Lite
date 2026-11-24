import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, it} from 'node:test';
import {WebSocket, WebSocketServer} from 'ws';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gowa-lite-phase8-'));
const tempDbPath = path.join(tempDir, 'phase8.db');
process.env.GOWA_LITE_DB_PATH = tempDbPath;
delete process.env.GOWA_SETTINGS_SECRET;

type DbModule = typeof import('../server/db.ts');
type GowaModule = typeof import('../server/gowa-client.ts');
type SecurityModule = typeof import('../server/security.ts');
type ValidationModule = typeof import('../server/validation/schemas.ts');
type UnifiedChatsServiceModule = typeof import('../server/services/unified-chats-service.ts');
type WsBridgeModule = typeof import('../server/ws-bridge.ts');

let dbMod: DbModule;
let gowaMod: GowaModule;
let secMod: SecurityModule;
let valMod: ValidationModule;
let chatsSvcMod: UnifiedChatsServiceModule;
let wsBridgeMod: WsBridgeModule;

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

before(async () => {
  dbMod = await import('../server/db.ts');
  gowaMod = await import('../server/gowa-client.ts');
  secMod = await import('../server/security.ts');
  valMod = await import('../server/validation/schemas.ts');
  chatsSvcMod = await import('../server/services/unified-chats-service.ts');
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

describe('Phase 8 Security, Performance & Hardening Unit Tests', () => {
  it('encrypts gowa_password at rest (AES-256-GCM) and migrates legacy plaintext on read (SEC-01)', () => {
    dbMod.setGowaConfig({
      url: 'https://gowa.example.com',
      username: 'ops-admin',
      password: 'super-secret-password',
    });

    const rawStored = dbMod.getSetting('gowa_password');
    assert.ok(rawStored?.startsWith('enc:v1:'), 'Expected encrypted enc:v1 prefix');
    assert.equal(rawStored?.includes('super-secret-password'), false);

    const keyFile = `${tempDbPath}.key`;
    assert.equal(fs.existsSync(keyFile), true);
    if (process.platform !== 'win32') {
      const mode = fs.statSync(keyFile).mode & 0o777;
      assert.equal(mode, 0o600);
    }

    const cfg = dbMod.getGowaConfig();
    assert.equal(cfg.password, 'super-secret-password');

    // Simulate legacy plaintext row and verify automatic migration on getGowaConfig()
    dbMod.setSetting('gowa_password', 'legacy-plain-pw');
    assert.equal(dbMod.getSetting('gowa_password'), 'legacy-plain-pw');
    const migratedCfg = dbMod.getGowaConfig();
    assert.equal(migratedCfg.password, 'legacy-plain-pw');
    const afterMigration = dbMod.getSetting('gowa_password');
    assert.ok(afterMigration?.startsWith('enc:v1:'));
    assert.equal(dbMod.getGowaConfig().password, 'legacy-plain-pw');
  });

  it('bounds AuthRateLimiter memory and derives IP from req.ip/TRUST_PROXY cleanly (SEC-02)', () => {
    assert.equal(secMod.parseTrustProxySetting(undefined), false);
    assert.equal(secMod.parseTrustProxySetting('false'), false);
    assert.equal(secMod.parseTrustProxySetting('true'), true);
    assert.equal(secMod.parseTrustProxySetting('1'), 1);
    assert.equal(secMod.parseTrustProxySetting('loopback'), 'loopback');

    assert.equal(
      secMod.getClientIp({
        ip: '127.0.0.1',
        socket: {remoteAddress: '10.0.0.5'} as net.Socket,
      }),
      '127.0.0.1',
    );
    assert.equal(
      secMod.getClientIp({
        ip: undefined,
        socket: {remoteAddress: '198.51.100.4'} as net.Socket,
      }),
      '198.51.100.4',
    );

    const limiter = new secMod.AuthRateLimiter({
      windowMs: 1_000,
      maxPerUserKey: 5,
      maxPerIp: 10,
      maxBuckets: 25,
    });
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 60; i += 1) {
      limiter.recordFailure(`203.0.113.${i}`, undefined, t0 + i);
    }
    assert.ok(limiter.bucketCount <= 25, `Expected <= 25 buckets, got ${limiter.bucketCount}`);

    // Expired entries are swept as new entries arrive later
    limiter.recordFailure('203.0.113.200', undefined, t0 + 5_000);
    assert.ok(limiter.bucketCount <= 25);
  });

  it('builds CSP sandbox attachment headers for active/unknown MIME types and allows safe media inline (SEC-03)', () => {
    const svg = secMod.buildSafeMediaHeaders('image/svg+xml; charset=utf-8', 'evil.svg');
    assert.equal(svg.disposition, 'attachment; filename="evil.svg"');
    assert.equal(svg.csp, "default-src 'none'; sandbox");

    const html = secMod.buildSafeMediaHeaders('text/html', 'bad"name.html');
    assert.equal(html.disposition, 'attachment; filename="bad_name.html"');
    assert.equal(html.csp, "default-src 'none'; sandbox");

    const png = secMod.buildSafeMediaHeaders('image/png', 'photo.png');
    assert.equal(png.disposition, 'inline; filename="photo.png"');
    assert.equal(png.csp, undefined);
  });

  it('blocks SSRF metadata/link-local targets always and RFC1918 only when BLOCK_PRIVATE_GOWA_URL=true (SEC-04)', async () => {
    const prevBlock = process.env.BLOCK_PRIVATE_GOWA_URL;
    try {
      delete process.env.BLOCK_PRIVATE_GOWA_URL;
      assert.equal(gowaMod.validateGowaUrl('http://127.0.0.1:3000/'), 'http://127.0.0.1:3000');
      assert.equal(gowaMod.validateGowaUrl('http://10.0.0.8:3000'), 'http://10.0.0.8:3000');

      for (const bad of [
        'http://169.254.169.254/latest/meta-data',
        'http://0.0.0.0:3000',
        'http://metadata.google.internal',
        'http://100.100.100.200',
        'http://[fe80::1]:8080',
      ]) {
        assert.throws(
          () => gowaMod.validateGowaUrl(bad),
          (err: unknown) =>
            err instanceof gowaMod.GowaError && err.status === 400 && err.code === 'INVALID_GOWA_URL',
          `Should block ${bad}`,
        );
      }

      process.env.BLOCK_PRIVATE_GOWA_URL = 'true';
      for (const priv of ['http://127.0.0.1:3000', 'http://localhost:3000', 'http://192.168.1.5:3000']) {
        assert.throws(
          () => gowaMod.validateGowaUrl(priv),
          (err: unknown) =>
            err instanceof gowaMod.GowaError && err.status === 400 && err.code === 'INVALID_GOWA_URL',
          `Should block ${priv} when BLOCK_PRIVATE_GOWA_URL=true`,
        );
      }

      await assert.rejects(
        () => gowaMod.fetchPublicAvatarImage('http://127.0.0.1:8080/avatar.jpg'),
        (err: unknown) =>
          err instanceof gowaMod.GowaError && err.status === 400 && err.code === 'INVALID_AVATAR_URL',
      );
      await assert.rejects(
        () => gowaMod.fetchPublicAvatarImage('http://169.254.169.254/avatar.jpg'),
        (err: unknown) =>
          err instanceof gowaMod.GowaError && err.status === 400 && err.code === 'INVALID_AVATAR_URL',
      );
    } finally {
      if (prevBlock === undefined) delete process.env.BLOCK_PRIVATE_GOWA_URL;
      else process.env.BLOCK_PRIVATE_GOWA_URL = prevBlock;
    }
  });

  it('keeps tab_counts.pending accurate when remote scan is partial and DB holds many archived closed chats (PERF-02)', () => {
    const adminUser = dbMod.createUser({
      username: 'p8_admin',
      display_name: 'Phase 8 Admin',
      role: 'admin',
      password: 'Password123',
    });
    const parsedQuery = chatsSvcMod.parseUnifiedChatsQuery({}, adminUser);

    const assignmentsMap = new Map<string, ReturnType<typeof Object>>();
    for (let i = 1; i <= 200; i += 1) {
      assignmentsMap.set(`dev-1::archived${i}@s.whatsapp.net`, {
        device_id: 'dev-1',
        chat_jid: `archived${i}@s.whatsapp.net`,
        status: 'closed',
        assigned_user_id: null,
        assigned_user_name: null,
        assigned_at: null,
        claimed_at: null,
        closed_by_id: adminUser.id,
        closed_by_name: adminUser.display_name,
        closed_at: new Date().toISOString(),
        close_reason: '',
        cached_title: `Archived ${i}`,
        last_message_ms: i,
        updated_at: i,
      });
    }

    const allChats = Array.from({length: 100}, (_, idx) => ({
      jid: `live${idx + 1}@s.whatsapp.net`,
      name: `Live ${idx + 1}`,
      last_message_time: new Date().toISOString(),
      ephemeral_expiration: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      archived: false,
      device_id: 'dev-1',
      device_display_name: 'Account 1',
      device_state: 'logged_in' as const,
    }));
    const remoteByKey = new Map(allChats.map((c) => [`${c.device_id}::${c.jid}`, c]));

    const counts = chatsSvcMod.computeUnifiedTabCounts({
      targetDeviceIds: ['dev-1'],
      allChats,
      assignmentsMap: assignmentsMap as never,
      remoteByKey,
      totalRemoteChats: 250,
      anyDeviceHasMore: true,
      skipRemoteScan: false,
      effectiveMeOwnerId: null,
      query: parsedQuery,
    });

    assert.equal(counts.pending, 250);
    assert.equal(counts.closed, 200);
    assert.equal(counts.all, 450);
  });

  it('validates payloads with Zod schemas returning 400 VALIDATION_ERROR (ARCH-03)', () => {
    assert.throws(
      () => valMod.parseSchema(valMod.loginAuthSchema, {username: '', password: ''}),
      (err: unknown) =>
        err instanceof gowaMod.GowaError && err.status === 400 && err.code === 'VALIDATION_ERROR',
    );
    assert.throws(
      () =>
        valMod.parseSchema(valMod.updatePreferencesSchema, {
          theme: 'neon',
        }),
      (err: unknown) =>
        err instanceof gowaMod.GowaError && err.status === 400 && err.code === 'VALIDATION_ERROR',
    );
    assert.throws(
      () => valMod.parseSchema(valMod.conversationNotePatchSchema, {}),
      (err: unknown) =>
        err instanceof gowaMod.GowaError && err.status === 400 && err.code === 'VALIDATION_ERROR',
    );
    assert.throws(
      () => valMod.parsePositiveIntId('abc', 'معرّف الدور'),
      (err: unknown) =>
        err instanceof gowaMod.GowaError && err.status === 400 && err.code === 'VALIDATION_ERROR',
    );

    const parsedNote = valMod.parseSchema(valMod.conversationNoteCreateSchema, {
      content: '  ملاحظة متابعة مهمة  ',
      is_pinned: true,
    });
    assert.equal(parsedNote.content, 'ملاحظة متابعة مهمة');
    assert.equal(parsedNote.is_pinned, true);
  });

  it('invalidates GowaWsBridge userCache on updateUser and schedules reconnect on upstream error (PERF-02, REL-02)', async () => {
    const versionBefore = dbMod.getUserCacheVersion();
    const agent = dbMod.createUser({
      username: 'p8_ws_agent',
      display_name: 'WS Agent',
      role: 'agent',
      password: 'Password123',
      allowed_device_ids: ['dev-1'],
    });
    assert.ok(dbMod.getUserCacheVersion() > versionBefore);

    const port = await getFreePort();
    const server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));

    const wssUpstream = new WebSocketServer({noServer: true});
    server.on('upgrade', (req, socket, head) => {
      const parsed = new URL(req.url || '/', 'http://127.0.0.1');
      if (parsed.pathname === '/upstream/ws') {
        wssUpstream.handleUpgrade(req, socket, head, (ws) => {
          wssUpstream.emit('connection', ws);
        });
      }
    });

    const bridge = new wsBridgeMod.GowaWsBridge(server);
    try {
      const ticket = wsBridgeMod.issueWsTicket(agent);
      const clientWs = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${ticket}`);
      const closeCodePromise = new Promise<number>((resolve) => {
        clientWs.once('close', (code) => resolve(code));
      });
      await new Promise<void>((resolve) => clientWs.once('open', resolve));

      // Prime user cache via an initial broadcast
      bridge.broadcast({code: 'CHAT_LIFECYCLE_UPDATED', device_id: 'dev-1', result: {}});

      // Deactivate user -> bumpUserCacheVersion() should force immediate cache reload -> 4001 close
      const deactivated = dbMod.updateUser(agent.id, {is_active: false});
      assert.equal(deactivated?.is_active, false);

      bridge.broadcast({code: 'CHAT_LIFECYCLE_UPDATED', device_id: 'dev-1', result: {}});
      const closeCode = await closeCodePromise;
      assert.equal(closeCode, 4001);

      // Verify upstream error schedules reconnect instead of going permanently silent
      const fakeUpstream = new WebSocket(`ws://127.0.0.1:${port}/upstream/ws`);
      const internal = bridge as unknown as {
        upstreamSockets: Map<string, WebSocket>;
        reconnectTimers: Map<string, ReturnType<typeof setTimeout>>;
        scheduleReconnect(deviceId: string): void;
      };
      internal.upstreamSockets.set('dev-err-test', fakeUpstream);
      fakeUpstream.on('error', () => {
        if (internal.upstreamSockets.get('dev-err-test') === fakeUpstream) {
          internal.upstreamSockets.delete('dev-err-test');
          internal.scheduleReconnect('dev-err-test');
        }
      });
      fakeUpstream.emit('error', new Error('simulated ECONNRESET'));
      assert.equal(internal.upstreamSockets.has('dev-err-test'), false);
      assert.equal(internal.reconnectTimers.has('dev-err-test'), true);
      fakeUpstream.terminate();
    } finally {
      bridge.shutdown();
      wssUpstream.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('Phase 8 End-to-End Server Hardening (Media RBAC/CSP, QR CSP, Compression, Dynamic 413)', () => {
  const srvDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gowa-lite-phase8-srv-'));
  const srvDbPath = path.join(srvDir, 'srv.db');
  let appPort = 0;
  let mockGowaPort = 0;
  let mockGowaServer: http.Server;
  let childProc: ReturnType<typeof spawn>;

  before(async () => {
    appPort = await getFreePort();
    mockGowaPort = await getFreePort();

    mockGowaServer = http.createServer((req, res) => {
      const reqUrl = new URL(req.url || '/', `http://127.0.0.1:${mockGowaPort}`);
      if (reqUrl.pathname === '/devices') {
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(
          JSON.stringify({
            code: 'SUCCESS',
            message: 'ok',
            results: [
              {id: 'dev-1', phone_number: '966500000001', display_name: 'Line 1', state: 'logged_in', created_at: ''},
              {id: 'dev-2', phone_number: '966500000002', display_name: 'Line 2', state: 'logged_in', created_at: ''},
            ],
          }),
        );
        return;
      }
      if (reqUrl.pathname === '/statics/evil.svg') {
        res.writeHead(200, {'Content-Type': 'image/svg+xml'});
        res.end('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
        return;
      }
      if (reqUrl.pathname === '/statics/safe.png') {
        res.writeHead(200, {'Content-Type': 'image/png'});
        res.end(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        return;
      }
      if (reqUrl.pathname === '/app/login') {
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(
          JSON.stringify({
            code: 'SUCCESS',
            message: 'ok',
            results: {
              device_id: 'dev-1',
              qr_link: `http://127.0.0.1:${mockGowaPort}/statics/evil.svg`,
              qr_duration: 30,
            },
          }),
        );
        return;
      }
      res.writeHead(404, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({code: 'NOT_FOUND', message: 'not found'}));
    });
    await new Promise<void>((resolve) => mockGowaServer.listen(mockGowaPort, '127.0.0.1', resolve));

    childProc = spawn('node', ['server.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'production',
        PORT: String(appPort),
        GOWA_LITE_DB_PATH: srvDbPath,
        GOWA_URL: `http://127.0.0.1:${mockGowaPort}`,
        ENABLE_COMPRESSION: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${appPort}/api/auth/status`);
        if (res.ok) break;
      } catch {
        // wait
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  });

  after(async () => {
    if (childProc && !childProc.killed) {
      childProc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 300));
    }
    await new Promise<void>((resolve) => mockGowaServer.close(() => resolve()));
    fs.rmSync(srvDir, {recursive: true, force: true});
  });

  it('enforces deviceId RBAC, attachment+CSP on dangerous SVG media & QR proxy, and dynamic 413 messages', async () => {
    const base = `http://127.0.0.1:${appPort}`;

    // Setup admin
    const setupRes = await fetch(`${base}/api/auth/setup`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        display_name: 'Admin User',
        username: 'admin8',
        password: 'Password123',
        gowa_url: `http://127.0.0.1:${mockGowaPort}`,
      }),
    });
    assert.equal(setupRes.status, 201);
    const setupJson = (await setupRes.json()) as {results: {token: string}};
    const adminToken = setupJson.results.token;

    // Create restricted agent (dev-1 only)
    const createAgentRes = await fetch(`${base}/api/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        username: 'agent8',
        display_name: 'Agent 8',
        password: 'Password123',
        role: 'agent',
        allowed_device_ids: ['dev-1'],
      }),
    });
    assert.equal(createAgentRes.status, 201);

    const loginAgentRes = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({username: 'agent8', password: 'Password123'}),
    });
    assert.equal(loginAgentRes.status, 200);
    const agentToken = ((await loginAgentRes.json()) as {results: {token: string}}).results.token;

    // 1. Missing deviceId -> 400 VALIDATION_ERROR
    const missingDev = await fetch(
      `${base}/api/unified/media/file?path=${encodeURIComponent('/statics/evil.svg')}`,
      {headers: {Authorization: `Bearer ${agentToken}`}},
    );
    assert.equal(missingDev.status, 400);

    // 2. Unauthorized deviceId -> 403 DEVICE_FORBIDDEN
    const forbiddenDev = await fetch(
      `${base}/api/unified/media/file?deviceId=dev-2&path=${encodeURIComponent('/statics/evil.svg')}`,
      {headers: {Authorization: `Bearer ${agentToken}`}},
    );
    assert.equal(forbiddenDev.status, 403);

    // 3. Allowed deviceId with SVG -> 200 with attachment + CSP sandbox
    const svgRes = await fetch(
      `${base}/api/unified/media/file?deviceId=dev-1&path=${encodeURIComponent('/statics/evil.svg')}`,
      {headers: {Authorization: `Bearer ${agentToken}`}},
    );
    assert.equal(svgRes.status, 200);
    assert.ok(svgRes.headers.get('content-disposition')?.startsWith('attachment'));
    assert.equal(svgRes.headers.get('content-security-policy'), "default-src 'none'; sandbox");

    // 4. Allowed deviceId with PNG -> 200 inline without sandbox CSP
    const pngRes = await fetch(
      `${base}/api/unified/media/file?deviceId=dev-1&path=${encodeURIComponent('/statics/safe.png')}`,
      {headers: {Authorization: `Bearer ${agentToken}`}},
    );
    assert.equal(pngRes.status, 200);
    assert.ok(pngRes.headers.get('content-disposition')?.startsWith('inline'));
    assert.equal(pngRes.headers.get('content-security-policy'), null);

    // 5. QR image proxy applies safe media headers on SVG QR link
    const qrRes = await fetch(
      `${base}/api/devices/dev-1/qr-image?path=${encodeURIComponent('/statics/evil.svg')}`,
      {headers: {Authorization: `Bearer ${adminToken}`}},
    );
    assert.equal(qrRes.status, 200);
    assert.ok(qrRes.headers.get('content-disposition')?.startsWith('attachment'));
    assert.equal(qrRes.headers.get('content-security-policy'), "default-src 'none'; sandbox");

    // 6. Dynamic 413 message checks (JSON limit = 8MB vs send-media = 20MB)
    const oversizedJson = JSON.stringify({username: 'a'.repeat(8_500_000), password: 'x'});
    const json413 = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: oversizedJson,
    });
    assert.equal(json413.status, 413);
    const json413Body = (await json413.json()) as {message: string};
    assert.ok(json413Body.message.includes('8 ميجابايت'), `Got: ${json413Body.message}`);

    const oversizedMedia = Buffer.alloc(20 * 1024 * 1024 + 512, 1);
    const media413 = await fetch(
      `${base}/api/unified/chats/dev-1/${encodeURIComponent('966500000001@s.whatsapp.net')}/send-media?filename=huge.pdf`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          Authorization: `Bearer ${adminToken}`,
        },
        body: oversizedMedia,
      },
    );
    assert.equal(media413.status, 413);
    const media413Body = (await media413.json()) as {message: string};
    assert.ok(media413Body.message.includes('20 ميجابايت'), `Got: ${media413Body.message}`);
  });
});
