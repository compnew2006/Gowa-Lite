import crypto from 'node:crypto';
import type {Server as HttpServer} from 'node:http';
import {WebSocket, WebSocketServer} from 'ws';
import {normalizeWhatsAppJid} from '../shared/whatsapp-identity.ts';
import {getGowaConfig, getUserById, getUserCacheVersion, hasActiveSession, hashSessionToken, type PublicUser} from './db.ts';
import {gowaFetch, type GowaDevice} from './gowa-client.ts';
import {hasAnyPermission, hasChatReadPermission, hasDeviceAccess, hasPermission} from './rbac.ts';
import {
  getChatContentAccessState,
  isLifecycleApplicableJid,
  type ChatRedactionReason,
} from './services/chat-lifecycle.ts';
import {isCallOfferEventCode} from './services/call-auto-reject.ts';
import {readGowaEventChatJid, readGowaIncomingMessageId} from './services/chat-sync.ts';
import {
  asReactionRecord,
  isGowaReactionEvent,
  readGowaReaction,
  recordMessageReaction,
} from './services/message-reactions.ts';

interface TicketEntry {
  userId: number;
  sessionHash: string;
  expiresAt: number;
}

const TICKET_TTL_MS = 30_000;
const MESSAGE_REPLAY_WINDOW_MS = 30_000;
const MAX_RECENT_MESSAGES = 2_048;
// WS event batching (P2): upstream events arriving in bursts are buffered per
// client and flushed together instead of one frame per event.
// Batch frame format (server + frontend client agree; both ship in one deploy):
//   {code: 'WS_BATCH', message: '', result: {events: [<WsEvent>, ...]}}
// Events inside a batch keep arrival order. A flush holding exactly one event
// sends that event unwrapped (today's wire format) so single events — and any
// raw WS consumer — see no change; only bursts become a batch frame.
// Per-client queues preserve per-user filtering/redaction and ordering: an
// event is filtered for a client when it is enqueued, and only that client's
// allowed events ever enter its queue.
export const WS_BATCH_CODE = 'WS_BATCH';
export const WS_BATCH_FLUSH_MS = 100;
export const WS_BATCH_MAX_EVENTS = 50;
const tickets = new Map<string, TicketEntry>();

export function issueWsTicket(user: PublicUser, token: string): string {
  const now = Date.now();
  for (const [k, entry] of tickets.entries()) {
    if (entry.expiresAt <= now) tickets.delete(k);
  }
  const ticket = crypto.randomBytes(24).toString('hex');
  tickets.set(ticket, {userId: user.id, sessionHash: hashSessionToken(token), expiresAt: now + TICKET_TTL_MS});
  return ticket;
}

function consumeWsTicket(ticket: string): TicketEntry | null {
  if (!ticket) return null;
  const entry = tickets.get(ticket);
  if (!entry) return null;
  tickets.delete(ticket);
  if (entry.expiresAt <= Date.now() || !hasActiveSession(entry.sessionHash, entry.userId)) return null;
  return entry;
}

interface BridgeClient {
  socket: WebSocket;
  userId: number;
  sessionHash: string;
  pending: unknown[];
}

export interface GowaUpstreamEvent {
  code: string;
  message: string;
  result: unknown;
  device_id?: string;
}

function findEventDevice(devices: GowaDevice[], source: string, sessionId: string): string | undefined {
  if (!Array.isArray(devices)) return undefined;
  if (sessionId) return devices.find((device) => device.id === sessionId)?.id;
  const jid = normalizeWhatsAppJid(source);
  const candidates = devices.filter((device) => device.id === source ||
    Boolean(jid && [device.jid, device.phone_number].some((value) => value && normalizeWhatsAppJid(value) === jid)));
  return candidates.length === 1 ? candidates[0].id : undefined;
}

function redactWsMessageObject(
  src: Record<string, unknown>,
  reason: ChatRedactionReason,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    content: '', media_type: '', filename: '', url: '', context_metadata: '', reactions: [],
    file_length: 0, content_redacted: true, redaction_reason: reason,
  };
  for (const key of [
    'id', 'message_id', 'original_message_id', 'revoked_message_id', 'revoked_at', 'revoked_by',
    'chat_jid', 'chat_id', 'remote_jid', 'remoteJid', 'jid', 'from', 'sender_jid',
    'sender_display_name', 'from_name', 'pushname', 'timestamp', 'device_id',
  ]) {
    if (typeof src[key] === 'string') out[key] = src[key];
  }
  for (const key of ['is_from_me', 'from_me', 'is_revoked']) {
    if (typeof src[key] === 'boolean') out[key] = src[key];
  }
  for (const key of ['body', 'text', 'caption', 'replied_to_id', 'reaction', 'emoji']) {
    if (key in src) out[key] = '';
  }
  return out;
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
  if (code === 'ROLE_UPDATED') {
    return {allowed: !deviceId && hasAnyPermission(user, ['roles:read', 'users:read', 'users:write'])};
  }
  if (code === 'USERS_UPDATED') {
    return {allowed: !deviceId && hasPermission(user, 'users', 'read')};
  }
  if (code === 'CHAT_CLOSE_RATING_UPDATED') {
    return {allowed: Boolean(deviceId) && hasPermission(user, 'accounts', 'read')};
  }
  if (code === 'CALL_AUTO_REJECTED') {
    return {
      allowed: Boolean(deviceId) && hasPermission(user, 'misc', 'calls.reject'),
    };
  }
  if (isCallOfferEventCode(code)) {
    return {
      allowed: Boolean(deviceId) && hasAnyPermission(user, ['misc:calls.reject', 'chats:read']),
    };
  }
  if (code === 'CHAT_DAILY_RESET') {
    return {
      allowed: Boolean(deviceId) && hasAnyPermission(user, ['chats:read', 'accounts:read']),
    };
  }

  if (code === 'CONVERSATION_NOTE_UPDATED') {
    return {allowed: hasPermission(user, 'notes', 'read')};
  }

  if (code === 'CHAT_LIFECYCLE_UPDATED') {
    if (!hasPermission(user, 'chats', 'read')) {
      return {allowed: false};
    }
    const resultObj =
      typeof obj?.result === 'object' && obj.result !== null
        ? (obj.result as Record<string, unknown>)
        : null;
    const assignmentObj =
      typeof resultObj?.assignment === 'object' && resultObj.assignment !== null
        ? (resultObj.assignment as Record<string, unknown>)
        : null;
    const lifecycleChatJid = String(resultObj?.chat_jid || assignmentObj?.chat_jid || '').trim();
    if (deviceId && lifecycleChatJid && isLifecycleApplicableJid(lifecycleChatJid)) {
      const access = getChatContentAccessState(user, deviceId, lifecycleChatJid);
      if (
        !access.allowed &&
        obj &&
        resultObj &&
        typeof resultObj.event === 'object' &&
        resultObj.event !== null
      ) {
        const eventObj = resultObj.event as Record<string, unknown>;
        return {
          allowed: true,
          filteredPayload: {
            ...obj,
            result: {
              ...resultObj,
              event: {...eventObj, note: ''},
            },
          },
        };
      }
    }
    return {allowed: true};
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
  const chatJid = readGowaEventChatJid(obj?.result);
  if ((code === 'MESSAGE' || /^MESSAGE[_.]/i.test(code)) && (!deviceId || !chatJid)) {
    return {allowed: false};
  }

  if (!hasChatReadPermission(user, chatJid)) {
    return {allowed: false};
  }

  if (code === 'MESSAGE_REACTION') {
    return {
      allowed: getChatContentAccessState(user, deviceId, chatJid).allowed,
    };
  }

  if (obj && resultObj && deviceId && chatJid && isLifecycleApplicableJid(chatJid)) {
    const access = getChatContentAccessState(user, deviceId, chatJid);
    if (!access.allowed && access.reason) {
      const redactedResult = redactWsMessageObject(resultObj, access.reason);
      if (innerPayload) {
        const nextPayload = redactWsMessageObject(innerPayload, access.reason);
        if (
          typeof innerPayload.message === 'object' &&
          innerPayload.message !== null
        ) {
          nextPayload.message = redactWsMessageObject(
            innerPayload.message as Record<string, unknown>,
            access.reason,
          );
        }
        redactedResult.payload = nextPayload;
      }
      if (typeof resultObj.message === 'object' && resultObj.message !== null) {
        redactedResult.message = redactWsMessageObject(
          resultObj.message as Record<string, unknown>,
          access.reason,
        );
      }
      return {
        allowed: true,
        filteredPayload: {
          ...obj,
          message: '',
          result: redactedResult,
        },
      };
    }
  }

  return {allowed: true};
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
  private upstreamDevices: GowaDevice[] = [];
  private recentMessages = new Map<string, number>();
  private reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private onUpstreamEvent?: (deviceId: string, event: GowaUpstreamEvent) => boolean | void;
  private userCache = new Map<number, {user: PublicUser | null; version: number; fetchedAt: number}>();

  constructor(
    httpServer: HttpServer,
    options?: {onUpstreamEvent?: (deviceId: string, event: GowaUpstreamEvent) => boolean | void},
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
      const session = consumeWsTicket(ticket);
      if (!session) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(request, socket, head, (ws) => {
        this.wss.emit('connection', ws, session);
      });
    });

    this.wss.on('connection', (ws: WebSocket, session: TicketEntry) => {
      const liveUser = getUserById(session.userId);
      if (!liveUser || !liveUser.is_active) {
        ws.close(4001, 'Session revoked');
        return;
      }

      const client: BridgeClient = {socket: ws, userId: liveUser.id, sessionHash: session.sessionHash, pending: []};
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
      for (const client of this.clients) this.getAuthenticatedClientUser(client);
      void this.reconcileUpstreams();
    }, 15_000);
    void this.reconcileUpstreams();
  }

  disconnectSession(token: string): void {
    const sessionHash = hashSessionToken(token);
    for (const [ticket, entry] of tickets) {
      if (entry.sessionHash === sessionHash) tickets.delete(ticket);
    }
    for (const client of this.clients) {
      if (client.sessionHash === sessionHash) this.disconnectClient(client);
    }
  }

  private disconnectClient(client: BridgeClient): void {
    client.pending = [];
    client.socket.close(4001, 'Session revoked');
    this.clients.delete(client);
  }

  private getAuthenticatedClientUser(client: BridgeClient): PublicUser | null {
    const user = this.getCachedLiveUser(client.userId);
    if (user?.is_active && hasActiveSession(client.sessionHash, client.userId)) return user;
    this.disconnectClient(client);
    return null;
  }

  private getCachedLiveUser(userId: number): PublicUser | null {
    const version = getUserCacheVersion();
    const now = Date.now();
    const hit = this.userCache.get(userId);
    if (hit && hit.version === version && now - hit.fetchedAt < 10_000) {
      return hit.user;
    }
    const fresh = getUserById(userId);
    this.userCache.set(userId, {user: fresh, version, fetchedAt: now});
    return fresh;
  }

  broadcast(payload: unknown): void {
    for (const client of this.clients) {
      if (client.socket.readyState !== WebSocket.OPEN) continue;
      const liveUser = this.getAuthenticatedClientUser(client);
      if (!liveUser) continue;
      const decision = shouldDeliverWsEventToUser(liveUser, payload);
      if (!decision.allowed) continue;
      client.pending.push(decision.filteredPayload !== undefined ? decision.filteredPayload : payload);
      if (client.pending.length >= WS_BATCH_MAX_EVENTS) {
        this.flushClient(client);
      }
    }
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    if (![...this.clients].some((client) => client.pending.length > 0)) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushAll();
    }, WS_BATCH_FLUSH_MS);
  }

  private flushAll(): void {
    for (const client of [...this.clients]) this.flushClient(client);
  }

  private flushClient(client: BridgeClient): void {
    if (client.pending.length === 0) return;
    const events = client.pending;
    client.pending = [];
    if (client.socket.readyState !== WebSocket.OPEN) return;
    // Re-check the session at flush time so a revocation between enqueue and
    // flush drops the batch instead of delivering it.
    if (!this.getAuthenticatedClientUser(client)) return;
    if (events.length === 1) {
      client.socket.send(JSON.stringify(events[0]));
    } else {
      client.socket.send(JSON.stringify({code: WS_BATCH_CODE, message: '', result: {events}}));
    }
  }

  sendToUser(userId: number, payload: unknown): void {
    const serialized = JSON.stringify(payload);
    for (const client of this.clients) {
      if (client.userId !== userId || client.socket.readyState !== WebSocket.OPEN) continue;
      if (this.getAuthenticatedClientUser(client)) client.socket.send(serialized);
    }
  }

  async resolveWebhookDevice(source: string, sessionId: string): Promise<string | undefined> {
    return findEventDevice(this.upstreamDevices, source, sessionId) ??
      findEventDevice(await gowaFetch<GowaDevice[]>('/devices') ?? [], source, sessionId);
  }

  relayScopedEvent(deviceId: string, event: GowaUpstreamEvent): void {
    const scoped = {...event, device_id: deviceId};
    const code = scoped.code.toUpperCase();
    const id = code === 'MESSAGE' || code === 'MESSAGE_RECEIVED' ? readGowaIncomingMessageId(event.result) : '';
    const chatJid = id ? readGowaEventChatJid(event.result) : '';
    if (id && !chatJid) return;
    const key = id ? JSON.stringify([deviceId, chatJid, id]) : '';
    const now = Date.now();
    if (key && (this.recentMessages.get(key) ?? 0) > now) return;

    const consumed = this.onUpstreamEvent?.(deviceId, scoped);
    if (key) {
      this.recentMessages.delete(key);
      this.recentMessages.set(key, now + MESSAGE_REPLAY_WINDOW_MS);
      if (this.recentMessages.size > MAX_RECENT_MESSAGES) {
        const oldest = this.recentMessages.keys().next().value;
        if (oldest !== undefined) this.recentMessages.delete(oldest);
      }
    }
    if (!consumed) this.broadcast(scoped);
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
    if (!Array.isArray(devices)) return;
    this.upstreamDevices = devices;

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
    this.upstreamDevices = [];
    this.recentMessages.clear();
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
        const raw = data.toString();
        try {
          const parsed = JSON.parse(raw) as {
            code?: string;
            message?: string;
            result?: unknown;
            device_id?: string;
            session_id?: string;
          };
          if (parsed && typeof parsed.code === 'string') {
            if (this.upstreamSockets.get(deviceId) !== upstream) return;
            if (parsed.code === 'LIST_DEVICES') {
              if (this.upstreamSockets.keys().next().value === deviceId && Array.isArray(parsed.result)) {
                this.broadcast({code: parsed.code, result: parsed.result});
              }
              return;
            }
            const result = asReactionRecord(parsed.result);
            const source = parsed.device_id ?? result?.device_id;
            const session = parsed.session_id ?? result?.session_id;
            const resolved = findEventDevice(this.upstreamDevices,
              typeof source === 'string' ? source.trim() : '', typeof session === 'string' ? session.trim() : '');
            // GOWA can publish the same frame on every socket. The socket URL does not identify its source.
            if (!deviceId || resolved !== deviceId) return;
            if (isGowaReactionEvent(parsed.code)) {
              const change = readGowaReaction(parsed.result);
              if (change) {
                const event = recordMessageReaction(deviceId, change.chatJid, change.messageId, change.reaction);
                if (event) this.broadcast(event);
              }
              return;
            }
            this.relayScopedEvent(deviceId, {
              code: parsed.code,
              message: parsed.message ?? '',
              result: parsed.result ?? null,
            });
          }
        } catch (err) {
          if (raw.trim().startsWith('{')) {
            console.warn('[ws-bridge] malformed upstream JSON frame', deviceId || 'default', err);
          }
        }
      });

      upstream.on('close', () => {
        if (this.upstreamSockets.get(deviceId) === upstream) {
          this.upstreamSockets.delete(deviceId);
          this.scheduleReconnect(deviceId);
        }
      });

      upstream.on('error', (err) => {
        console.error('[ws-bridge] upstream socket error', deviceId || 'default', err.message);
        if (this.upstreamSockets.get(deviceId) === upstream) {
          this.upstreamSockets.delete(deviceId);
          this.scheduleReconnect(deviceId);
          try {
            upstream.terminate();
          } catch {
            // ignore terminate failure
          }
        }
      });
    } catch (err) {
      console.error('[ws-bridge] upstream connect failed', deviceId || 'default', err);
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
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushAll();
    this.closeAllUpstreams();
    this.wss.close();
  }
}
