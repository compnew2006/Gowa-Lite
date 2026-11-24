import crypto from 'node:crypto';
import type {Server as HttpServer} from 'node:http';
import {WebSocket, WebSocketServer} from 'ws';
import {getGowaConfig, type PublicUser} from './db.ts';
import {gowaFetch, type GowaDevice} from './gowa-client.ts';

interface TicketEntry {
  user: PublicUser;
  expiresAt: number;
}

const TICKET_TTL_MS = 30_000;
const tickets = new Map<string, TicketEntry>();

export function issueWsTicket(user: PublicUser): string {
  const now = Date.now();
  for (const [k, entry] of tickets.entries()) {
    if (entry.expiresAt <= now) tickets.delete(k);
  }
  const ticket = crypto.randomBytes(24).toString('hex');
  tickets.set(ticket, {user, expiresAt: now + TICKET_TTL_MS});
  return ticket;
}

function consumeWsTicket(ticket: string): PublicUser | null {
  if (!ticket) return null;
  const entry = tickets.get(ticket);
  if (!entry) return null;
  tickets.delete(ticket);
  if (entry.expiresAt <= Date.now()) return null;
  return entry.user;
}

interface BridgeClient {
  socket: WebSocket;
  user: PublicUser;
}

export class GowaWsBridge {
  private wss: WebSocketServer;
  private clients = new Set<BridgeClient>();
  private upstreamSockets = new Map<string, WebSocket>();
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private syncTimer: ReturnType<typeof setInterval> | null = null;

  constructor(httpServer: HttpServer) {
    this.wss = new WebSocketServer({noServer: true});

    httpServer.on('upgrade', (request, socket, head) => {
      const rawUrl = request.url || '';
      const parsed = new URL(rawUrl, 'http://localhost');
      if (parsed.pathname !== '/ws') {
        return;
      }
      const ticket = parsed.searchParams.get('ticket') || '';
      const user = consumeWsTicket(ticket);
      if (!user) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.wss.emit('connection', ws, user);
      });
    });

    this.wss.on('connection', (ws: WebSocket, user: PublicUser) => {
      const client: BridgeClient = {socket: ws, user};
      this.clients.add(client);

      ws.send(
        JSON.stringify({
          code: 'BRIDGE_STATUS',
          message: this.upstreamSockets.size > 0 ? 'connected' : 'idle',
          result: {upstream_devices: Array.from(this.upstreamSockets.keys())},
        }),
      );

      ws.on('close', () => {
        this.clients.delete(client);
      });
      ws.on('error', () => {
        this.clients.delete(client);
      });
    });

    this.syncTimer = setInterval(() => {
      void this.reconcileUpstreams();
    }, 15_000);
    void this.reconcileUpstreams();
  }

  broadcast(payload: unknown): void {
    const serialized = JSON.stringify(payload);
    for (const client of this.clients) {
      if (client.socket.readyState === WebSocket.OPEN) {
        client.socket.send(serialized);
      }
    }
  }

  async reconcileUpstreams(): Promise<void> {
    const config = getGowaConfig();
    if (!config.url) {
      this.closeAllUpstreams();
      return;
    }

    let devices: GowaDevice[] = [];
    try {
      devices = (await gowaFetch<GowaDevice[]>('/devices', {timeoutMs: 6_000})) ?? [];
    } catch {
      return;
    }

    const desiredIds = new Set<string>();
    if (devices.length === 0) {
      desiredIds.add('');
    } else {
      for (const dev of devices) {
        desiredIds.add(dev.id);
      }
    }

    for (const [id, sock] of this.upstreamSockets.entries()) {
      if (!desiredIds.has(id)) {
        sock.close();
        this.upstreamSockets.delete(id);
      }
    }

    for (const deviceId of desiredIds) {
      if (!this.upstreamSockets.has(deviceId)) {
        this.connectUpstream(deviceId);
      }
    }
  }

  resetAndReconnect(): void {
    this.closeAllUpstreams();
    void this.reconcileUpstreams();
  }

  private closeAllUpstreams(): void {
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();
    for (const sock of this.upstreamSockets.values()) {
      sock.close();
    }
    this.upstreamSockets.clear();
  }

  private connectUpstream(deviceId: string): void {
    const config = getGowaConfig();
    if (!config.url) return;

    let wsUrl: URL;
    try {
      const httpUrl = new URL(config.url);
      httpUrl.protocol = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:';
      httpUrl.pathname = `${httpUrl.pathname.replace(/\/+$/, '')}/ws`;
      if (deviceId) {
        httpUrl.searchParams.set('device_id', deviceId);
      }
      if (config.username && config.password) {
        const encoded = Buffer.from(`${config.username}:${config.password}`, 'utf8').toString(
          'base64',
        );
        httpUrl.searchParams.set('authorization', encoded);
      }
      wsUrl = httpUrl;
    } catch {
      return;
    }

    const existing = this.upstreamSockets.get(deviceId);
    if (existing) return;

    try {
      const upstream = new WebSocket(wsUrl.toString());
      this.upstreamSockets.set(deviceId, upstream);

      upstream.on('message', (data) => {
        try {
          const parsed = JSON.parse(data.toString()) as {
            code?: string;
            message?: string;
            result?: unknown;
          };
          if (parsed && typeof parsed.code === 'string') {
            this.broadcast({
              code: parsed.code,
              message: parsed.message ?? '',
              result: parsed.result ?? null,
              device_id: deviceId || undefined,
            });
          }
        } catch {
          // ignore non-JSON frames
        }
      });

      upstream.on('close', () => {
        if (this.upstreamSockets.get(deviceId) === upstream) {
          this.upstreamSockets.delete(deviceId);
          this.scheduleReconnect(deviceId);
        }
      });

      upstream.on('error', () => {
        if (this.upstreamSockets.get(deviceId) === upstream) {
          this.upstreamSockets.delete(deviceId);
          upstream.close();
        }
      });
    } catch {
      this.scheduleReconnect(deviceId);
    }
  }

  private scheduleReconnect(deviceId: string): void {
    if (this.reconnectTimers.has(deviceId)) return;
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(deviceId);
      this.connectUpstream(deviceId);
    }, 10_000);
    this.reconnectTimers.set(deviceId, timer);
  }

  shutdown(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
    this.closeAllUpstreams();
    this.wss.close();
  }
}
