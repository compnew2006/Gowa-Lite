import crypto from 'node:crypto';
import type {Server as HttpServer} from 'node:http';
import {WebSocket, WebSocketServer} from 'ws';
import {normalizeWhatsAppJid, resolveDeviceOwnJid, resolveIsFromMe} from '../shared/whatsapp-identity.ts';
import {asRecord, unwrapGowaPayload} from '../shared/gowa-payload.ts';
import {getGowaConfig, getUserById, getUserCacheVersion, hasActiveSession, hashSessionToken, type PublicUser} from './db.ts';
import {gowaFetch, type GowaDevice} from './gowa-client.ts';
import {hasAnyPermission, hasChatReadPermission, hasDeviceAccess, hasPermission} from './rbac.ts';
import {
  getChatContentAccessState,
  isLifecycleApplicableJid,
  type ChatRedactionReason,
} from './services/chat-lifecycle.ts';
import {isCallOfferEventCode} from './services/call-auto-reject.ts';
import {
  VIEWER_TTL_MS,
  buildChatViewersPayload,
  createPresenceRegistry,
  getChatViewers,
  pruneExpiredViewers,
  registerChatViewing,
  removeChatViewing,
  removeViewersForConnection,
  type PresenceRegistry,
} from '../shared/presence.ts';
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
// client and flushed together instead of one frame per event. Exception:
// MESSAGE_REACTION bypasses the queue and is sent synchronously (see
// broadcast/sendImmediate) — reactions are order- and latency-sensitive, and
// a queued stale reaction must never overtake the fresh one a client is
// already waiting for.
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
  connectionId: string;
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
  // Test-only guard: when true, reconcileUpstreams() is a no-op (see below).
  // Production bridges never set this — they always reconcile /devices.
  private readonly reconcileDisabled: boolean;
  // P2-1 presence (first bidirectional channel): in-memory viewers registry.
  // TTL defaults to VIEWER_TTL_MS (45s, heartbeat every 15s); both are
  // overridable for tests so TTL expiry is observable without waiting 45s.
  private presence: PresenceRegistry = createPresenceRegistry();
  private viewerTtlMs: number;
  private presenceSweepTimer: ReturnType<typeof setInterval> | null = null;
  private onUpstreamEvent?: (deviceId: string, event: GowaUpstreamEvent) => boolean | void;
  private userCache = new Map<number, {user: PublicUser | null; version: number; fetchedAt: number}>();

  constructor(
    httpServer: HttpServer,
    options?: {
      onUpstreamEvent?: (deviceId: string, event: GowaUpstreamEvent) => boolean | void;
      viewerTtlMs?: number;
      presenceSweepMs?: number;
      // Test-only: skip the /devices reconcile entirely (no fetch, no
      // upstream sockets from it). The relay test seeds upstreamDevices
      // directly; a live /devices fetch would replace the seed and the
      // derived is_from_me flag with it (VPS failure #63, P1-18).
      // Defaults to false — production behavior is unchanged.
      disableReconcile?: boolean;
    },
  ) {
    this.onUpstreamEvent = options?.onUpstreamEvent;
    this.reconcileDisabled = options?.disableReconcile ?? false;
    this.viewerTtlMs = options?.viewerTtlMs ?? VIEWER_TTL_MS;
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

      const client: BridgeClient = {
        socket: ws,
        userId: liveUser.id,
        sessionHash: session.sessionHash,
        connectionId: crypto.randomUUID(),
        pending: [],
      };
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

      // P2-1: first client→server channel. Only presence messages are
      // accepted here; anything else is ignored (never trusted, never
      // routed to the gateway or to lifecycle logic).
      ws.on('message', (data) => {
        this.handleClientMessage(client, data.toString());
      });
      ws.on('close', () => {
        this.removeClientPresence(client);
        this.clients.delete(client);
      });
      ws.on('error', () => {
        this.removeClientPresence(client);
        this.clients.delete(client);
      });
    });

    this.syncTimer = setInterval(() => {
      for (const client of this.clients) this.getAuthenticatedClientUser(client);
      void this.reconcileUpstreams();
    }, 15_000);
    // Presence sweep: drop viewers whose heartbeat stopped and tell the
    // remaining viewers of each affected chat. Runs on its own cadence so a
    // test can observe TTL expiry quickly (presenceSweepMs option).
    this.presenceSweepTimer = setInterval(() => {
      for (const affected of pruneExpiredViewers(this.presence, Date.now(), this.viewerTtlMs)) {
        this.broadcastChatViewers(affected.deviceId, affected.chatJid);
      }
    }, options?.presenceSweepMs ?? 15_000);
    void this.reconcileUpstreams();
  }

  /**
   * P2-1 presence, client→server. Accepted frames:
   *   {code: 'CHAT_VIEWING' | 'CHAT_VIEWING_HEARTBEAT', device_id, chat_jid}
   *   {code: 'CHAT_LEAVING', device_id, chat_jid}
   * The sender must be signed in, allowed on the device, and allowed to read
   * the chat; anything else (bad JSON, unknown code, missing fields, no
   * access) is silently ignored. A successful view/heartbeat/leaving
   * broadcasts the updated CHAT_VIEWERS list to the viewers of that chat.
   */
  private handleClientMessage(client: BridgeClient, raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    const frame = parsed as Record<string, unknown>;
    const code = typeof frame.code === 'string' ? frame.code : '';
    if (code !== 'CHAT_VIEWING' && code !== 'CHAT_VIEWING_HEARTBEAT' && code !== 'CHAT_LEAVING') {
      return;
    }
    const deviceId = typeof frame.device_id === 'string' ? frame.device_id.trim() : '';
    const chatJid = typeof frame.chat_jid === 'string' ? frame.chat_jid.trim() : '';
    if (!deviceId || !chatJid) return;
    const liveUser = this.getAuthenticatedClientUser(client);
    if (!liveUser) return;
    if (!hasDeviceAccess(liveUser, deviceId)) return;
    if (!hasChatReadPermission(liveUser, chatJid)) return;
    const displayName = liveUser.display_name?.trim() || liveUser.username;

    if (code === 'CHAT_LEAVING') {
      removeChatViewing(this.presence, {
        deviceId,
        chatJid,
        userId: liveUser.id,
        connectionId: client.connectionId,
      });
    } else {
      registerChatViewing(this.presence, {
        userId: liveUser.id,
        displayName,
        deviceId,
        chatJid,
        connectionId: client.connectionId,
      });
    }
    this.broadcastChatViewers(deviceId, chatJid);
  }

  /**
   * Send the current viewer list of one chat to every connected client that
   * is viewing that chat. Delivered immediately (not through the batch
   * queue) and never through shouldDeliverWsEventToUser: the payload carries
   * only viewer names, no message content, so lifecycle redaction does not
   * apply — but the recipients are exactly the chat's viewers, each of whom
   * already passed the device + chats:read check when they announced.
   */
  private broadcastChatViewers(deviceId: string, chatJid: string): void {
    const viewers = getChatViewers(this.presence, deviceId, chatJid);
    const payload = buildChatViewersPayload(deviceId, chatJid, viewers);
    const serialized = JSON.stringify(payload);
    // Recipients: exactly the clients currently viewing this chat (each
    // connection id is registered in the presence map for the chat).
    const viewerConnections = new Set<string>();
    for (const viewer of this.presence.values()) {
      if (
        viewer.deviceId === deviceId.trim() &&
        viewer.chatJid === chatJid.trim().toLowerCase()
      ) {
        viewerConnections.add(viewer.connectionId);
      }
    }
    for (const client of this.clients) {
      if (!viewerConnections.has(client.connectionId)) continue;
      if (client.socket.readyState !== WebSocket.OPEN) continue;
      if (!this.getAuthenticatedClientUser(client)) continue;
      client.socket.send(serialized);
    }
  }

  private removeClientPresence(client: BridgeClient): void {
    for (const affected of removeViewersForConnection(this.presence, client.connectionId)) {
      this.broadcastChatViewers(affected.deviceId, affected.chatJid);
    }
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
    this.removeClientPresence(client);
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
    // MESSAGE_REACTION bypasses the batch queue (see sendImmediate): a
    // reaction is order- and latency-sensitive — its sender already gated it
    // by timestamp, and a client waiting for the next reaction must never
    // observe an older queued reaction first. Every other event is buffered
    // below and flushed together.
    const code =
      typeof (payload as {code?: unknown} | null)?.code === 'string'
        ? ((payload as {code: string}).code as string)
        : '';
    if (isGowaReactionEvent(code)) {
      for (const client of this.clients) {
        if (client.socket.readyState !== WebSocket.OPEN) continue;
        const liveUser = this.getAuthenticatedClientUser(client);
        if (!liveUser) continue;
        const decision = shouldDeliverWsEventToUser(liveUser, payload);
        if (!decision.allowed) continue;
        this.sendImmediate(
          client,
          decision.filteredPayload !== undefined ? decision.filteredPayload : payload,
        );
      }
      return;
    }
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

  // Deliver one event synchronously, exactly as broadcast() did before
  // batching: flush anything already queued for this client first so the
  // immediate event never overtakes an earlier one, then send it without
  // waiting for the flush window. Used for MESSAGE_REACTION, where the
  // 100ms queue delay let a stale reaction from an earlier action be
  // delivered after the next action had already started waiting for its own
  // reaction (tests/message-reactions.test.ts: first-match waiters resolved
  // on the stale event).
  private sendImmediate(client: BridgeClient, payload: unknown): void {
    this.flushClient(client);
    if (client.socket.readyState !== WebSocket.OPEN) return;
    if (!this.getAuthenticatedClientUser(client)) return;
    client.socket.send(JSON.stringify(payload));
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

  /**
   * The device's own WhatsApp JID, resolved from the last `/devices` list
   * (reconciled every 15s). '' when the device is unknown or carries no
   * usable JID/phone — callers then fall back to the gateway flag alone.
   */
  getDeviceOwnJid(deviceId: string): string {
    const device = this.upstreamDevices.find((dev) => dev.id === deviceId);
    if (device) {
      const resolved = resolveDeviceOwnJid(device);
      if (resolved) return resolved;
    }
    return resolveDeviceOwnJid({id: deviceId});
  }

  /**
   * P1-18 (decision 19): stamp the derived `is_from_me` flag on broadcast
   * MESSAGE / MESSAGE_RECEIVED frames. The persisted row is already derived
   * in handleUpstreamGowaEvent, but the raw broadcast is what browsers patch
   * the message list from — a wrong gateway flag rendered the wrong "أنت"
   * label live until the next refetch. The flag is always stamped when the
   * device JID is known (explicit false included, so frames are
   * self-describing); unknown device → fall back to the gateway flag
   * (no rewrite). Never mutates the upstream event — clones the result.
   */
  private withDerivedIsFromMe(deviceId: string, event: GowaUpstreamEvent): GowaUpstreamEvent {
    const code = (event.code || '').toUpperCase();
    if (code !== 'MESSAGE' && code !== 'MESSAGE_RECEIVED') return event;
    const ownJid = this.getDeviceOwnJid(deviceId);
    if (!ownJid) return event;
    const outer = asRecord(event.result);
    if (!outer) return event;
    const payload = unwrapGowaPayload(event.result);
    const source = payload ?? outer;
    const gatewayFlag = source.is_from_me ?? source.from_me;
    const derived = resolveIsFromMe(
      String(source.sender_jid || source.from || ''),
      ownJid,
      typeof gatewayFlag === 'boolean' ? gatewayFlag : undefined,
    );
    const nextResult: Record<string, unknown> = {...outer, is_from_me: derived};
    if (payload && payload !== outer) {
      if (asRecord(outer.payload) === payload) {
        nextResult.payload = {...payload, is_from_me: derived};
      } else if (asRecord(outer.message) === payload) {
        nextResult.message = {...payload, is_from_me: derived};
      }
    }
    return {...event, result: nextResult};
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
    if (!consumed) this.broadcast(this.withDerivedIsFromMe(deviceId, scoped));
  }

  async reconcileUpstreams(): Promise<void> {
    // Test-only guard (disableReconcile): the bridge under test owns its
    // upstreamDevices list (seeded by the test). Fetching /devices here
    // would let an outside gateway replace that list — on the VPS the live
    // .env's GOWA_URL did exactly that and wiped the relay test's fake
    // device (P1-18 failure #63). Skipping the fetch changes nothing in
    // production: the flag defaults to false and every production bridge
    // reconciles as before.
    if (this.reconcileDisabled) return;
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
    if (this.presenceSweepTimer) {
      clearInterval(this.presenceSweepTimer);
      this.presenceSweepTimer = null;
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
