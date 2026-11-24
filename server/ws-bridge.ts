import crypto from 'node:crypto';
import type {Server as HttpServer} from 'node:http';
import {WebSocket, WebSocketServer} from 'ws';
import {getGowaConfig, getUserById, type PublicUser} from './db.ts';
import {gowaFetch, type GowaDevice} from './gowa-client.ts';
import {hasAnyPermission, hasDeviceAccess, hasPermission} from './rbac.ts';

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
  userId: number;
}

export interface GowaUpstreamEvent {
  code: string;
  message: string;
  result: unknown;
}

export function shouldDeliverWsEventToUser(
  user: PublicUser,
  payload: unknown,
): {allowed: boolean; filteredPayload?: unknown} {
  if (!user.is_active) {
    return {allowed: false};
  }
  const obj =
    typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : null;
  const code = typeof obj?.code === 'string' ? obj.code : '';
  const deviceId = typeof obj?.device_id === 'string' ? obj.device_id : '';

  if (deviceId && !hasDeviceAccess(user, deviceId)) {
    return {allowed: false};
  }

  if (code === 'CONVERSATION_NOTE_UPDATED') {
    return {allowed: hasPermission(user, 'notes', 'read')};
  }

  if (code === 'CHAT_LIFECYCLE_UPDATED') {
    return {allowed: hasPermission(user, 'chats', 'read')};
  }

  if (code === 'INBOX_POLICY_UPDATED') {
    return {allowed: hasAnyPermission(user, ['chats:read', 'settings:read', 'settings:write'])};
  }

  if (code === 'SCHEDULE_UPDATED') {
    return {allowed: hasPermission(user, 'schedules', 'read')};
  }

  if (
    code === 'LOGIN_SUCCESS' ||
    code === 'DEVICE_LOGGED_OUT' ||
    code === 'DEVICE_REMOVED'
  ) {
    return {
      allowed: hasAnyPermission(user, [
        'accounts:read',
        'chats:read',
        'groups:read',
        'misc:status.read',
      ]),
    };
  }

  if (code === 'LIST_DEVICES') {
    if (
      !hasAnyPermission(user, ['accounts:read', 'chats:read', 'groups:read', 'misc:status.read'])
    ) {
      return {allowed: false};
    }
    if (obj && Array.isArray(obj.result)) {
      const filteredDevices = obj.result.filter((item) => {
        if (typeof item !== 'object' || item === null) return false;
        const id = (item as {id?: unknown}).id;
        return typeof id === 'string' && hasDeviceAccess(user, id);
      });
      return {allowed: true, filteredPayload: {...obj, result: filteredDevices}};
    }
    return {allowed: true};
  }

  const resultObj =
    typeof obj?.result === 'object' && obj.result !== null
      ? (obj.result as Record<string, unknown>)
      : null;
  const innerPayload =
    typeof resultObj?.payload === 'object' && resultObj.payload !== null
      ? (resultObj.payload as Record<string, unknown>)
      : null;
  const chatJid = String(
    resultObj?.chat_jid || innerPayload?.chat_jid || innerPayload?.from || '',
  )
    .trim()
    .toLowerCase();

  if (chatJid === 'status@broadcast') {
    return {allowed: hasPermission(user, 'misc', 'status.read')};
  }

  return {allowed: hasPermission(user, 'chats', 'read')};
}

export function buildUpstreamWsTarget(
  config: {url: string; username: string; password: string},
  deviceId: string,
  options?: {allowQueryAuth?: boolean},
): {url: string; headers?: Record<string, string>} | null {
  if (!config.url) return null;
  try {
    const httpUrl = new URL(config.url);
    httpUrl.protocol = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    httpUrl.pathname = `${httpUrl.pathname.replace(/\/+$/, '')}/ws`;
    if (deviceId) {
      httpUrl.searchParams.set('device_id', deviceId);
    }
    let headers: Record<string, string> | undefined;
    if (config.username && config.password) {
      const encoded = Buffer.from(`${config.username}:${config.password}`, 'utf8').toString(
        'base64',
      );
      headers = {Authorization: `Basic ${encoded}`};
      if (options?.allowQueryAuth) {
        httpUrl.searchParams.set('authorization', encoded);
      }
    }
    return {url: httpUrl.toString(), headers};
  } catch {
    return null;
  }
}

export class GowaWsBridge {
  private wss: WebSocketServer;
  private clients = new Set<BridgeClient>();
  private upstreamSockets = new Map<string, WebSocket>();
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private onUpstreamEvent?: (deviceId: string, event: GowaUpstreamEvent) => void;

  constructor(
    httpServer: HttpServer,
    options?: {onUpstreamEvent?: (deviceId: string, event: GowaUpstreamEvent) => void},
  ) {
    this.onUpstreamEvent = options?.onUpstreamEvent;
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
      const liveUser = getUserById(user.id);
      if (!liveUser || !liveUser.is_active) {
        ws.close(4001, 'Session revoked');
        return;
      }

      const client: BridgeClient = {socket: ws, userId: liveUser.id};
      this.clients.add(client);

      const allowedDevices = Array.from(this.upstreamSockets.keys()).filter((id) =>
        id ? hasDeviceAccess(liveUser, id) : true,
      );

      ws.send(
        JSON.stringify({
          code: 'BRIDGE_STATUS',
          message: allowedDevices.length > 0 ? 'connected' : 'idle',
          result: {upstream_devices: allowedDevices},
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
    let defaultSerialized: string | null = null;
    for (const client of this.clients) {
      if (client.socket.readyState !== WebSocket.OPEN) continue;
      const liveUser = getUserById(client.userId);
      if (!liveUser || !liveUser.is_active) {
        client.socket.close(4001, 'Session revoked');
        this.clients.delete(client);
        continue;
      }
      const decision = shouldDeliverWsEventToUser(liveUser, payload);
      if (!decision.allowed) continue;
      if (decision.filteredPayload !== undefined) {
        client.socket.send(JSON.stringify(decision.filteredPayload));
      } else {
        if (defaultSerialized === null) {
          defaultSerialized = JSON.stringify(payload);
        }
        client.socket.send(defaultSerialized);
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
    const target = buildUpstreamWsTarget(config, deviceId, {
      allowQueryAuth: process.env.GOWA_WS_QUERY_AUTH === 'true',
    });
    if (!target) return;

    const existing = this.upstreamSockets.get(deviceId);
    if (existing) return;

    try {
      const upstream = new WebSocket(target.url, {headers: target.headers});
      this.upstreamSockets.set(deviceId, upstream);

      upstream.on('message', (data) => {
        try {
          const parsed = JSON.parse(data.toString()) as {
            code?: string;
            message?: string;
            result?: unknown;
          };
          if (parsed && typeof parsed.code === 'string') {
            const eventPayload: GowaUpstreamEvent = {
              code: parsed.code,
              message: parsed.message ?? '',
              result: parsed.result ?? null,
            };
            try {
              this.onUpstreamEvent?.(deviceId, eventPayload);
            } catch (err) {
              console.error('[ws-bridge] onUpstreamEvent error', err);
            }
            this.broadcast({
              ...eventPayload,
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
