import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, before, describe, it} from 'node:test';
import {WebSocket} from 'ws';

describe('Phase 3 Production Server Smoke Check (PROD-01)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gowa-lite-prod-'));
  const dbPath = path.join(tmpDir, 'prod.db');
  const port = 3299;
  const baseUrl = `http://127.0.0.1:${port}`;
  let serverProc: ReturnType<typeof spawn> | null = null;
  let serverLogs = '';

  before(async () => {
    const distIndex = path.resolve(process.cwd(), 'dist', 'index.html');
    assert.equal(
      fs.existsSync(distIndex),
      true,
      'dist/index.html is missing — run "npm run build" before Phase 3 production verification',
    );

    serverProc = spawn('node', ['server.ts'], {
      env: {
        ...process.env,
        NODE_ENV: 'production',
        PORT: String(port),
        GOWA_LITE_DB_PATH: dbPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    serverProc.stdout?.on('data', (chunk: Buffer) => {
      serverLogs += chunk.toString();
    });
    serverProc.stderr?.on('data', (chunk: Buffer) => {
      serverLogs += chunk.toString();
    });

    for (let i = 0; i < 40; i++) {
      try {
        const res = await fetch(`${baseUrl}/api/auth/status`);
        if (res.ok) return;
      } catch {
        // retry while booting
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`Production server failed to start:\n${serverLogs}`);
  });

  after(async () => {
    if (serverProc && !serverProc.killed) {
      serverProc.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  it('serves built SPA, enforces auth, returns JSON across /api/* and 404s, and authenticates /ws', async () => {
    const rootRes = await fetch(`${baseUrl}/`);
    assert.equal(rootRes.status, 200);
    assert.match(rootRes.headers.get('content-type') || '', /text\/html/);
    const rootHtml = await rootRes.text();
    assert.match(rootHtml, /<div id="root"><\/div>/);

    const spaFallbackRes = await fetch(`${baseUrl}/chats`);
    assert.equal(spaFallbackRes.status, 200);
    assert.match(spaFallbackRes.headers.get('content-type') || '', /text\/html/);

    const unknownApiRes = await fetch(`${baseUrl}/api/nonexistent-endpoint`);
    assert.equal(unknownApiRes.status, 404);
    assert.match(unknownApiRes.headers.get('content-type') || '', /application\/json/);

    const setupRes = await fetch(`${baseUrl}/api/auth/setup`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        display_name: 'Production Admin',
        username: 'prodadmin',
        password: 'StrongPassword123',
      }),
    });
    assert.equal(setupRes.status, 201);
    const setupBody = (await setupRes.json()) as {results: {token: string}};
    const authHeaders = {Authorization: `Bearer ${setupBody.results.token}`};

    const apiChecks: Array<[string, number]> = [
      ['/api/auth/me', 200],
      ['/api/users', 200],
      ['/api/settings/gowa', 200],
      ['/api/unified/chats/dev1/123@s.whatsapp.net/notes', 200],
      ['/api/unified/accounts', 503],
      ['/api/unified/chats', 503],
      ['/api/unified/groups', 503],
      ['/api/devices', 503],
      ['/api/devices/dev1/schedules', 503],
      ['/api/devices/dev1/groups', 503],
      ['/api/devices/dev1/user/info?phone=123', 503],
      ['/api/devices/dev1/newsletters', 503],
    ];

    for (const [routePath, expectedStatus] of apiChecks) {
      const res = await fetch(`${baseUrl}${routePath}`, {headers: authHeaders});
      assert.match(
        res.headers.get('content-type') || '',
        /application\/json/,
        `${routePath} should return JSON`,
      );
      assert.equal(res.status, expectedStatus, `${routePath} status mismatch`);
    }

    await new Promise<void>((resolve, reject) => {
      const badWs = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=invalid-ticket`);
      badWs.on('unexpected-response', (_req, res) => {
        assert.equal(res.statusCode, 401);
        resolve();
      });
      badWs.on('open', () => reject(new Error('Invalid WS ticket should not connect')));
      badWs.on('error', () => {});
    });

    const ticketRes = await fetch(`${baseUrl}/api/auth/ws-ticket`, {
      method: 'POST',
      headers: authHeaders,
    });
    assert.equal(ticketRes.status, 200);
    const ticketBody = (await ticketRes.json()) as {results: {ticket: string}};

    const wsPayload = await new Promise<{code: string}>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${ticketBody.results.ticket}`);
      ws.on('message', (buf) => {
        const parsed = JSON.parse(buf.toString()) as {code: string};
        ws.close();
        resolve(parsed);
      });
      ws.on('error', reject);
    });

    assert.equal(wsPayload.code, 'BRIDGE_STATUS');

    async function issueTicket() {
      const response = await fetch(`${baseUrl}/api/auth/ws-ticket`, {method: 'POST', headers: authHeaders});
      assert.equal(response.status, 200);
      return ((await response.json()) as {results: {ticket: string}}).results.ticket;
    }
    const pendingTicket = await issueTicket();
    const activeTicket = await issueTicket();
    const connected = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${activeTicket}`);
    const closed = new Promise<number>((resolve) => connected.once('close', resolve));
    try {
      await new Promise<void>((resolve, reject) => {
        connected.once('open', resolve);
        connected.once('error', reject);
      });
      const logout = await fetch(`${baseUrl}/api/auth/logout`, {method: 'POST', headers: authHeaders});
      assert.equal(logout.status, 200);
      await new Promise<void>((resolve, reject) => {
        const pending = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${pendingTicket}`);
        pending.once('unexpected-response', (_request, response) => {
          response.resume();
          assert.equal(response.statusCode, 401);
          resolve();
        });
        pending.once('open', () => {
          pending.close();
          reject(new Error('Ticket from a logged-out session was accepted'));
        });
        pending.once('error', reject);
      });
      assert.equal(await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 500))]), 4001);
    } finally {
      connected.terminate();
    }
  });
});
