/**
 * Chat presence registry (P2-1, phase 5 path A).
 *
 * In-memory only: who is currently looking at which chat, keyed by
 * (device, chat, user, connection). A viewer is one *connection* (tab), so
 * the same user in two tabs registers twice but is deduped to one entry when
 * listed; closing one tab must not evict the other.
 *
 * Liveness is heartbeat-driven: a viewer expires VIEWER_TTL_MS after their
 * last CHAT_VIEWING / CHAT_VIEWING_HEARTBEAT, so a dead tab, a crashed
 * browser, or a dropped connection can never leave a ghost viewer behind.
 * The bridge also removes a connection's entries the moment its socket
 * closes, so the common case (tab closed) is immediate, not TTL-bound.
 *
 * Warning only (decision 7): this registry is never consulted by claim,
 * send, or any lifecycle gate — it only feeds the CHAT_VIEWERS broadcast.
 */

export const VIEWER_TTL_MS = 45_000;
export const PRESENCE_HEARTBEAT_MS = 15_000;

export interface ChatViewer {
  userId: number;
  displayName: string;
  deviceId: string;
  chatJid: string;
  connectionId: string;
  lastSeenAt: number;
}

export interface PresenceViewer {
  user_id: number;
  display_name: string;
}

export interface PresenceChatViewers {
  deviceId: string;
  chatJid: string;
  viewers: PresenceViewer[];
}

export type PresenceRegistry = Map<string, ChatViewer>;

export function createPresenceRegistry(): PresenceRegistry {
  return new Map<string, ChatViewer>();
}

export function normalizePresenceChatJid(chatJid: string): string {
  return chatJid.trim().toLowerCase();
}

export function presenceChatKey(deviceId: string, chatJid: string): string {
  return `${deviceId.trim()}\0${normalizePresenceChatJid(chatJid)}`;
}

function viewerKey(
  deviceId: string,
  chatJid: string,
  userId: number,
  connectionId: string,
): string {
  return `${presenceChatKey(deviceId, chatJid)}\0${userId}\0${connectionId}`;
}

export function registerChatViewing(
  registry: PresenceRegistry,
  viewer: Omit<ChatViewer, 'lastSeenAt'> & {lastSeenAt?: number},
  now: number = Date.now(),
): PresenceViewer[] {
  const entry: ChatViewer = {
    ...viewer,
    deviceId: viewer.deviceId.trim(),
    chatJid: normalizePresenceChatJid(viewer.chatJid),
    lastSeenAt: viewer.lastSeenAt ?? now,
  };
  registry.set(
    viewerKey(entry.deviceId, entry.chatJid, entry.userId, entry.connectionId),
    entry,
  );
  return getChatViewers(registry, entry.deviceId, entry.chatJid);
}

/** A heartbeat is an upsert with a fresh timestamp. */
export const refreshChatViewing = registerChatViewing;

export function removeChatViewing(
  registry: PresenceRegistry,
  target: {deviceId: string; chatJid: string; userId: number; connectionId: string},
): PresenceViewer[] {
  registry.delete(
    viewerKey(target.deviceId, target.chatJid, target.userId, target.connectionId),
  );
  return getChatViewers(registry, target.deviceId, target.chatJid);
}

/**
 * Remove every viewer entry owned by one connection (socket close / session
 * revoke). Returns one entry per affected chat, each carrying that chat's
 * remaining viewers, so the caller can broadcast the updated list.
 */
export function removeViewersForConnection(
  registry: PresenceRegistry,
  connectionId: string,
): PresenceChatViewers[] {
  const affected = new Map<string, {deviceId: string; chatJid: string}>();
  for (const [key, viewer] of registry.entries()) {
    if (viewer.connectionId === connectionId) {
      registry.delete(key);
      affected.set(presenceChatKey(viewer.deviceId, viewer.chatJid), {
        deviceId: viewer.deviceId,
        chatJid: viewer.chatJid,
      });
    }
  }
  return [...affected.values()].map(({deviceId, chatJid}) => ({
    deviceId,
    chatJid,
    viewers: getChatViewers(registry, deviceId, chatJid),
  }));
}

/**
 * Drop viewers whose last heartbeat is older than `ttlMs`. Returns one entry
 * per affected chat with the remaining viewers, for broadcast.
 */
export function pruneExpiredViewers(
  registry: PresenceRegistry,
  now: number = Date.now(),
  ttlMs: number = VIEWER_TTL_MS,
): PresenceChatViewers[] {
  const affected = new Map<string, {deviceId: string; chatJid: string}>();
  for (const [key, viewer] of registry.entries()) {
    if (now - viewer.lastSeenAt > ttlMs) {
      registry.delete(key);
      affected.set(presenceChatKey(viewer.deviceId, viewer.chatJid), {
        deviceId: viewer.deviceId,
        chatJid: viewer.chatJid,
      });
    }
  }
  return [...affected.values()].map(({deviceId, chatJid}) => ({
    deviceId,
    chatJid,
    viewers: getChatViewers(registry, deviceId, chatJid),
  }));
}

/**
 * Viewers of one chat, deduped by user (a user in two tabs appears once,
 * with the freshest heartbeat). The list is the full set, including the
 * requesting user — clients filter themselves out of the badge.
 */
export function getChatViewers(
  registry: PresenceRegistry,
  deviceId: string,
  chatJid: string,
): PresenceViewer[] {
  const chatKey = presenceChatKey(deviceId, chatJid);
  const byUser = new Map<number, PresenceViewer>();
  for (const viewer of registry.values()) {
    if (presenceChatKey(viewer.deviceId, viewer.chatJid) !== chatKey) continue;
    byUser.set(viewer.userId, {user_id: viewer.userId, display_name: viewer.displayName});
  }
  return [...byUser.values()];
}

export function buildChatViewersPayload(
  deviceId: string,
  chatJid: string,
  viewers: PresenceViewer[],
): {code: 'CHAT_VIEWERS'; message: string; device_id: string; result: {device_id: string; chat_jid: string; viewers: PresenceViewer[]}} {
  return {
    code: 'CHAT_VIEWERS',
    message: '',
    device_id: deviceId,
    result: {device_id: deviceId, chat_jid: chatJid, viewers},
  };
}
