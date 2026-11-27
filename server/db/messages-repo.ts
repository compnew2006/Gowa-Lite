import type {SQLInputValue} from 'node:sqlite';
import type {PublicUser} from './auth-repo.ts';
import {getChatDeviceState} from './chat-states-repo.ts';
import {db, parseTimestampMs, queryAll, queryOne} from './connection.ts';

// =========================================================================
// Cached Messages, Revocation Preservation & Per-User Isolated Unread Counts
// =========================================================================
export interface CachedReactionLike {
  emoji: string;
  sender_jid: string;
  sender_display_name?: string;
  is_from_me: boolean;
  timestamp: string;
}

export const REMOTE_REACTION_GRACE_MS = 30_000;

interface StoredReactionChange {
  message_id: string;
  emoji: string;
  sender_jid: string;
  sender_display_name: string | null;
  is_from_me: number;
  timestamp_ms: number;
}

function reactionActor(reaction: {sender_jid: string; is_from_me: boolean | number}): string {
  if (reaction.is_from_me) return 'me';
  return reaction.sender_jid.toLowerCase().replace(/:\d+(?=@)/, '').replace(/@c\.us$/, '@s.whatsapp.net');
}

export function storeMessageReaction(
  deviceId: string,
  chatJid: string,
  messageId: string,
  reaction: CachedReactionLike,
): boolean {
  const actor = reactionActor(reaction);
  const timestampMs = parseTimestampMs(reaction.timestamp);
  const cachedReactions = getCachedMessage(deviceId, chatJid, messageId)?.reactions;
  if (cachedReactions?.some((cached) =>
    reactionActor(cached) === actor && parseTimestampMs(cached.timestamp) > timestampMs,
  )) return false;

  const update = db.prepare(
    `INSERT INTO message_reaction_changes
       (device_id, chat_jid, message_id, actor, emoji, sender_jid,
        sender_display_name, is_from_me, timestamp_ms, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (device_id, chat_jid, message_id, actor) DO UPDATE SET
       emoji = excluded.emoji, sender_jid = excluded.sender_jid,
       sender_display_name = excluded.sender_display_name, is_from_me = excluded.is_from_me,
       timestamp_ms = excluded.timestamp_ms, received_at = excluded.received_at
     WHERE excluded.timestamp_ms > message_reaction_changes.timestamp_ms
        OR (excluded.timestamp_ms = message_reaction_changes.timestamp_ms
            AND excluded.emoji <> message_reaction_changes.emoji)`,
  ).run(
    deviceId, chatJid, messageId, actor, reaction.emoji, reaction.sender_jid,
    reaction.sender_display_name ?? null, Number(reaction.is_from_me),
    timestampMs, Date.now(),
  );
  return Number(update.changes) > 0;
}

function mergeMessageReactions(
  snapshot: CachedReactionLike[] | undefined,
  changes: StoredReactionChange[],
): CachedReactionLike[] {
  const reactions = new Map((snapshot ?? []).filter((reaction) => reaction.emoji)
    .map((reaction) => [reactionActor(reaction), reaction]));
  for (const change of changes) {
    const actor = reactionActor(change);
    const upstream = reactions.get(actor);
    if (upstream && parseTimestampMs(upstream.timestamp) > change.timestamp_ms) continue;
    if (!change.emoji) {
      reactions.delete(actor);
      continue;
    }
    reactions.set(actor, {
      emoji: change.emoji,
      sender_jid: change.sender_jid,
      sender_display_name: change.sender_display_name ?? upstream?.sender_display_name,
      is_from_me: Boolean(change.is_from_me),
      timestamp: new Date(change.timestamp_ms).toISOString(),
    });
  }
  return [...reactions.values()];
}

export interface CachedMessagePayload {
  id: string;
  chat_jid: string;
  sender_jid: string;
  sender_display_name?: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  media_type: string;
  reactions?: CachedReactionLike[];
  context_metadata?: string;
  filename: string;
  url: string;
  file_length: number;
  is_revoked?: boolean;
  revoked_at?: string;
  revoked_by?: string;
}

interface CachedMessageRow {
  device_id: string;
  chat_jid: string;
  id: string;
  seq: number;
  sender_jid: string;
  sender_display_name: string;
  content: string;
  timestamp: string;
  timestamp_ms: number;
  is_from_me: number;
  media_type: string;
  reactions_json: string;
  context_metadata: string;
  filename: string;
  url: string;
  file_length: number;
  is_revoked: number;
  revoked_at: string | null;
  revoked_by: string | null;
  is_unread_candidate: number;
  cached_at: number;
  updated_at: number;
}

function nextMessageSeq(): number {
  const row = queryOne<{max_seq: number | null}>('SELECT MAX(seq) AS max_seq FROM cached_messages');
  return (row?.max_seq ?? 0) + 1;
}

function rowToMessagePayload(row: CachedMessageRow): CachedMessagePayload {
  let reactions: CachedReactionLike[] | undefined;
  try {
    const parsed = JSON.parse(row.reactions_json) as CachedReactionLike[];
    if (Array.isArray(parsed) && parsed.length > 0) {
      reactions = parsed;
    }
  } catch {
    reactions = undefined;
  }
  return {
    id: row.id,
    chat_jid: row.chat_jid,
    sender_jid: row.sender_jid,
    sender_display_name: row.sender_display_name || undefined,
    content: row.content,
    timestamp: row.timestamp,
    is_from_me: row.is_from_me === 1,
    media_type: row.media_type,
    reactions,
    context_metadata: row.context_metadata || undefined,
    filename: row.filename,
    url: row.url,
    file_length: row.file_length,
    is_revoked: row.is_revoked === 1 ? true : undefined,
    revoked_at: row.revoked_at || undefined,
    revoked_by: row.revoked_by || undefined,
  };
}

const CACHED_MESSAGE_COLUMNS = `
  device_id, chat_jid, id, seq,
  sender_jid, sender_display_name, content, timestamp, timestamp_ms,
  is_from_me, media_type, reactions_json, context_metadata,
  filename, url, file_length,
  is_revoked, revoked_at, revoked_by,
  is_unread_candidate, cached_at, updated_at
`;

export function getCachedMessage(
  deviceId: string,
  chatJid: string,
  messageId: string,
): CachedMessagePayload | null {
  if (!deviceId || !chatJid || !messageId) return null;
  const row = queryOne<CachedMessageRow>(
    `SELECT ${CACHED_MESSAGE_COLUMNS} FROM cached_messages WHERE device_id = ? AND chat_jid = ? AND id = ?`,
    deviceId,
    chatJid,
    messageId,
  );
  return row ? rowToMessagePayload(row) : null;
}

export function upsertCachedMessages(
  deviceId: string,
  chatJid: string,
  messages: CachedMessagePayload[],
  options?: {
    markUnreadCandidate?: boolean;
    minUnreadTimestampMs?: number;
  },
): void {
  if (!deviceId || !chatJid || messages.length === 0) return;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  let seqCursor = nextMessageSeq();

  const selectStmt = db.prepare(
    `SELECT ${CACHED_MESSAGE_COLUMNS} FROM cached_messages WHERE device_id = ? AND chat_jid = ? AND id = ?`,
  );
  const upsertStmt = db.prepare(`
    INSERT INTO cached_messages (
      device_id, chat_jid, id, seq,
      sender_jid, sender_display_name, content, timestamp, timestamp_ms,
      is_from_me, media_type, reactions_json, context_metadata,
      filename, url, file_length,
      is_revoked, revoked_at, revoked_by,
      is_unread_candidate, cached_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(device_id, chat_jid, id) DO UPDATE SET
      sender_jid = excluded.sender_jid,
      sender_display_name = excluded.sender_display_name,
      content = excluded.content,
      timestamp = excluded.timestamp,
      timestamp_ms = excluded.timestamp_ms,
      is_from_me = excluded.is_from_me,
      media_type = excluded.media_type,
      reactions_json = excluded.reactions_json,
      context_metadata = excluded.context_metadata,
      filename = excluded.filename,
      url = excluded.url,
      file_length = excluded.file_length,
      is_revoked = excluded.is_revoked,
      revoked_at = excluded.revoked_at,
      revoked_by = excluded.revoked_by,
      is_unread_candidate = excluded.is_unread_candidate,
      updated_at = excluded.updated_at
  `);

  let persistedAny = false;
  db.exec('BEGIN');
  try {
    for (const msg of messages) {
      if (!msg.id) continue;
      persistedAny = true;
      const existing = selectStmt.get(deviceId, chatJid, msg.id) as CachedMessageRow | undefined;

      const ts = msg.timestamp || existing?.timestamp || nowIso;
      const tsMs = parseTimestampMs(ts) || existing?.timestamp_ms || nowMs;
      const incomingMediaType = msg.media_type === 'revoked' ? '' : msg.media_type || '';
      const incomingRevoked =
        Boolean(msg.is_revoked) || msg.media_type === 'revoked';

      const existingHasPayload = Boolean(
        existing &&
          (existing.content.trim() ||
            existing.media_type.trim() ||
            existing.url.trim() ||
            existing.filename.trim()),
      );
      const incomingHasPayload = Boolean(
        msg.content?.trim() || incomingMediaType.trim() || msg.url?.trim() || msg.filename?.trim(),
      );

      // If a previously populated message suddenly returns completely empty from GOWA,
      // treat it as revoked while preserving original content/media.
      const disappearedContentRevoked = Boolean(existing && existingHasPayload && !incomingHasPayload);
      const finalIsRevoked =
        existing?.is_revoked === 1 || incomingRevoked || disappearedContentRevoked ? 1 : 0;

      const finalContent =
        msg.content?.trim() ? msg.content : existing?.content ?? msg.content ?? '';
      const finalMediaType =
        incomingMediaType.trim() ? incomingMediaType : existing?.media_type ?? '';
      const finalFilename = msg.filename?.trim() ? msg.filename : existing?.filename ?? '';
      const finalUrl = msg.url?.trim() ? msg.url : existing?.url ?? '';
      const finalFileLength =
        typeof msg.file_length === 'number' && msg.file_length > 0
          ? msg.file_length
          : existing?.file_length ?? 0;
      const finalContextMeta =
        msg.context_metadata?.trim() ? msg.context_metadata : existing?.context_metadata ?? '';
      const finalSenderDisplay =
        msg.sender_display_name?.trim()
          ? msg.sender_display_name
          : existing?.sender_display_name ?? '';
      const finalSenderJid = msg.sender_jid?.trim() ? msg.sender_jid : existing?.sender_jid ?? '';
      const finalReactionsJson =
        msg.reactions !== undefined
          ? JSON.stringify(msg.reactions)
          : existing?.reactions_json ?? '[]';
      const finalRevokedAt = finalIsRevoked
        ? existing?.revoked_at || msg.revoked_at || nowIso
        : null;
      const finalRevokedBy = finalIsRevoked
        ? existing?.revoked_by || msg.revoked_by || null
        : null;

      const isFromMe = msg.is_from_me ? 1 : existing?.is_from_me ?? 0;
      const qualifiesUnreadByTs =
        options?.minUnreadTimestampMs === undefined || tsMs > options.minUnreadTimestampMs;
      const shouldMarkUnread =
        !isFromMe &&
        !finalIsRevoked &&
        Boolean(options?.markUnreadCandidate) &&
        qualifiesUnreadByTs;
      const finalUnreadCandidate = existing?.is_unread_candidate === 1 || shouldMarkUnread ? 1 : 0;

      const seq = existing?.seq ?? seqCursor++;
      const cachedAt = existing?.cached_at ?? nowMs;

      upsertStmt.run(
        deviceId,
        chatJid,
        msg.id,
        seq,
        finalSenderJid,
        finalSenderDisplay,
        finalContent,
        ts,
        tsMs,
        isFromMe,
        finalMediaType,
        finalReactionsJson,
        finalContextMeta,
        finalFilename,
        finalUrl,
        finalFileLength,
        finalIsRevoked,
        finalRevokedAt,
        finalRevokedBy,
        finalUnreadCandidate,
        cachedAt,
        nowMs,
      );
    }
    if (persistedAny) {
      db.prepare(`
        INSERT INTO chat_sync_state (
          device_id, chat_jid, last_message_time, last_message_ms, needs_catchup, catchup_prev_ms, has_messages, updated_at
        )
        VALUES (?, ?, '', 0, 0, 0, 1, ?)
        ON CONFLICT(device_id, chat_jid) DO UPDATE SET
          has_messages = 1,
          updated_at = excluded.updated_at
      `).run(deviceId, chatJid, nowMs);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function markCachedMessageRevoked(
  deviceId: string,
  messageId: string,
  {chatJid, revokedBy, revokedAt = new Date().toISOString()}: {chatJid: string; revokedBy?: string; revokedAt?: string},
): void {
  if (!deviceId || !chatJid || !messageId) return;
  const updated = db.prepare(
    `UPDATE cached_messages SET is_revoked = 1,
       revoked_at = COALESCE(revoked_at, ?), revoked_by = COALESCE(revoked_by, ?), updated_at = ?
     WHERE device_id = ? AND chat_jid = ? AND id = ?`,
  ).run(revokedAt, revokedBy || null, Date.now(), deviceId, chatJid, messageId);
  if (updated.changes) return;

  upsertCachedMessages(deviceId, chatJid, [{
    id: messageId,
    chat_jid: chatJid,
    sender_jid: revokedBy || '',
    content: '',
    timestamp: revokedAt,
    is_from_me: false,
    media_type: '',
    filename: '',
    url: '',
    file_length: 0,
    is_revoked: true,
    revoked_at: revokedAt,
    revoked_by: revokedBy,
  }]);
}

export function syncAndMergeChatMessages(
  deviceId: string,
  chatJid: string,
  liveMessages: CachedMessagePayload[],
  opts: {offset: number; limit?: number; search?: string; mediaOnly?: boolean},
): {messages: CachedMessagePayload[]; injectedCount: number; rawCount: number} {
  const deviceState = getChatDeviceState(deviceId, chatJid);
  const clearedBeforeMs = deviceState?.cleared_before_ms ?? 0;
  const effectiveLiveMessages =
    clearedBeforeMs > 0
      ? liveMessages.filter((m) => parseTimestampMs(m.timestamp) > clearedBeforeMs)
      : liveMessages;

  upsertCachedMessages(deviceId, chatJid, effectiveLiveMessages);

  const pageLimit = opts.limit ?? 40;
  const hasMoreOlderLivePages = liveMessages.length >= pageLimit;
  const liveIds = new Set(effectiveLiveMessages.map((m) => m.id));
  const timestamps = effectiveLiveMessages
    .map((m) => parseTimestampMs(m.timestamp))
    .filter((t) => t > 0);
  const minLiveTs = timestamps.length > 0 ? Math.min(...timestamps) : 0;
  const maxLiveTs = timestamps.length > 0 ? Math.max(...timestamps) : 0;

  // On the top page (offset === 0, unfiltered), any previously cached message that should
  // have appeared in this window (or anywhere when all live messages fit on page 0)
  // that disappeared from GOWA's response was deleted/revoked on WhatsApp.
  if (
    opts.offset === 0 &&
    !opts.search &&
    !opts.mediaOnly &&
    (minLiveTs > 0 || !hasMoreOlderLivePages)
  ) {
    const recentCached =
      hasMoreOlderLivePages && minLiveTs > 0
        ? queryAll<{id: string; is_revoked: number}>(
            `SELECT id, is_revoked FROM cached_messages
             WHERE device_id = ? AND chat_jid = ? AND timestamp_ms >= ? AND timestamp_ms > ?`,
            deviceId,
            chatJid,
            minLiveTs,
            clearedBeforeMs,
          )
        : queryAll<{id: string; is_revoked: number}>(
            `SELECT id, is_revoked FROM cached_messages
             WHERE device_id = ? AND chat_jid = ? AND timestamp_ms > ?`,
            deviceId,
            chatJid,
            clearedBeforeMs,
          );

    const nowIso = new Date().toISOString();
    const nowMs = Date.now();
    const markMissingStmt = db.prepare(
      `UPDATE cached_messages
       SET is_revoked = 1,
           revoked_at = COALESCE(revoked_at, ?),
           updated_at = ?
       WHERE device_id = ? AND chat_jid = ? AND id = ? AND is_revoked = 0`,
    );
    for (const row of recentCached) {
      if (!liveIds.has(row.id) && row.is_revoked === 0) {
        markMissingStmt.run(nowIso, nowMs, deviceId, chatJid, row.id);
      }
    }
  }

  // Enrich live messages with preserved cached data & is_revoked flag
  const cachedById = new Map<string, CachedMessageRow>();
  const reactionChangesById = new Map<string, StoredReactionChange[]>();
  if (effectiveLiveMessages.length > 0) {
    const ids = JSON.stringify([...liveIds]);
    const cachedPage = queryAll<CachedMessageRow>(
      `SELECT ${CACHED_MESSAGE_COLUMNS} FROM cached_messages
       WHERE device_id = ? AND chat_jid = ? AND timestamp_ms > ?
         AND id IN (SELECT value FROM json_each(?))`,
      deviceId,
      chatJid,
      clearedBeforeMs,
      ids,
    );
    for (const row of cachedPage) cachedById.set(row.id, row);
    const changes = queryAll<StoredReactionChange>(
      `SELECT message_id, emoji, sender_jid, sender_display_name, is_from_me, timestamp_ms
       FROM message_reaction_changes
       WHERE device_id = ? AND chat_jid = ?
         AND message_id IN (SELECT value FROM json_each(?))
         AND (is_from_me = 1 OR received_at >= ?)`,
      deviceId, chatJid, ids, Date.now() - REMOTE_REACTION_GRACE_MS,
    );
    for (const change of changes) {
      const existing = reactionChangesById.get(change.message_id);
      if (existing) existing.push(change);
      else reactionChangesById.set(change.message_id, [change]);
    }
  }

  const merged: CachedMessagePayload[] = effectiveLiveMessages.map((msg) => {
    const cached = cachedById.get(msg.id);
    if (!cached) return msg;
    const payload = rowToMessagePayload(cached);
    const reactionChanges = reactionChangesById.get(msg.id);
    return {
      ...msg,
      content: payload.content || msg.content,
      media_type: payload.media_type || msg.media_type,
      filename: payload.filename || msg.filename,
      url: payload.url || msg.url,
      file_length: payload.file_length || msg.file_length,
      context_metadata: payload.context_metadata || msg.context_metadata,
      sender_display_name: msg.sender_display_name || payload.sender_display_name,
      reactions: reactionChanges
        ? mergeMessageReactions(msg.reactions ?? payload.reactions, reactionChanges)
        : msg.reactions ?? payload.reactions,
      is_revoked: payload.is_revoked,
      revoked_at: payload.revoked_at,
      revoked_by: payload.revoked_by,
    };
  });

  // Inject locally preserved revoked messages that GOWA omitted from its list
  let injectedCount = 0;
  let missingRevokedRows: CachedMessageRow[] = [];
  if (opts.offset === 0 && !opts.search && !opts.mediaOnly) {
    missingRevokedRows =
      hasMoreOlderLivePages && minLiveTs > 0
        ? queryAll<CachedMessageRow>(
            `SELECT ${CACHED_MESSAGE_COLUMNS} FROM cached_messages
             WHERE device_id = ? AND chat_jid = ? AND is_revoked = 1 AND timestamp_ms >= ? AND timestamp_ms > ?`,
            deviceId,
            chatJid,
            minLiveTs,
            clearedBeforeMs,
          )
        : queryAll<CachedMessageRow>(
            `SELECT ${CACHED_MESSAGE_COLUMNS} FROM cached_messages
             WHERE device_id = ? AND chat_jid = ? AND is_revoked = 1 AND timestamp_ms > ?
             ORDER BY timestamp_ms DESC LIMIT 50`,
            deviceId,
            chatJid,
            clearedBeforeMs,
          );
  } else if (minLiveTs > 0 && maxLiveTs > 0) {
    missingRevokedRows = queryAll<CachedMessageRow>(
      `SELECT ${CACHED_MESSAGE_COLUMNS} FROM cached_messages
       WHERE device_id = ? AND chat_jid = ? AND is_revoked = 1
         AND timestamp_ms >= ? AND timestamp_ms <= ? AND timestamp_ms > ?`,
      deviceId,
      chatJid,
      minLiveTs,
      maxLiveTs,
      clearedBeforeMs,
    );
  }

  const normalizedSearch = opts.search?.trim().toLowerCase() || '';
  for (const row of missingRevokedRows) {
    if (liveIds.has(row.id)) continue;
    if (opts.mediaOnly && !row.media_type.trim()) continue;
    if (
      normalizedSearch &&
      !row.content.toLowerCase().includes(normalizedSearch) &&
      !row.filename.toLowerCase().includes(normalizedSearch)
    ) {
      continue;
    }
    merged.push(rowToMessagePayload(row));
    injectedCount += 1;
  }

  merged.sort((a, b) => parseTimestampMs(b.timestamp) - parseTimestampMs(a.timestamp));
  return {messages: merged, injectedCount, rawCount: liveMessages.length};
}

export interface PendingCatchupChat {
  device_id: string;
  chat_jid: string;
  prev_last_message_ms: number;
  new_last_message_ms: number;
}

export function syncChatWatermarks(
  chats: Array<{device_id: string; chat_jid: string; last_message_time: string}>,
  options?: {newChatCatchupWindowMs?: number},
): PendingCatchupChat[] {
  if (chats.length === 0) return [];
  const nowMs = Date.now();
  const newChatWindowMs = options?.newChatCatchupWindowMs ?? 10 * 60_000;
  const baselineRow = queryOne<{has_rows: number}>(
    'SELECT EXISTS (SELECT 1 FROM chat_sync_state LIMIT 1) AS has_rows',
  );
  const hasBaselineSync = (baselineRow?.has_rows ?? 0) > 0;

  const selectSync = db.prepare(
    'SELECT last_message_ms, needs_catchup, catchup_prev_ms, has_messages FROM chat_sync_state WHERE device_id = ? AND chat_jid = ?',
  );
  const selectLatestCached = db.prepare(
    'SELECT COALESCE(MAX(timestamp_ms), 0) AS max_ts FROM cached_messages WHERE device_id = ? AND chat_jid = ?',
  );
  const upsertSync = db.prepare(`
    INSERT INTO chat_sync_state (
      device_id, chat_jid, last_message_time, last_message_ms, needs_catchup, catchup_prev_ms, has_messages, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(device_id, chat_jid) DO UPDATE SET
      last_message_time = excluded.last_message_time,
      last_message_ms = excluded.last_message_ms,
      needs_catchup = excluded.needs_catchup,
      catchup_prev_ms = excluded.catchup_prev_ms,
      has_messages = excluded.has_messages,
      updated_at = excluded.updated_at
  `);

  db.exec('BEGIN');
  try {
    for (const chat of chats) {
      const nextMs = parseTimestampMs(chat.last_message_time);
      if (nextMs <= 0) continue;
      const existing = selectSync.get(chat.device_id, chat.chat_jid) as
        | {last_message_ms: number; needs_catchup: number; catchup_prev_ms: number; has_messages: number | null}
        | undefined;

      if (!existing) {
        const isRecentNewChat = hasBaselineSync && nextMs >= nowMs - newChatWindowMs;
        const latestCached = isRecentNewChat
          ? (selectLatestCached.get(chat.device_id, chat.chat_jid) as {max_ts: number})
          : null;
        const shouldCatchupNew =
          isRecentNewChat && (latestCached?.max_ts ?? 0) < nextMs - 1000;
        const initialHasMessages = (latestCached?.max_ts ?? 0) > 0 ? 1 : null;
        upsertSync.run(
          chat.device_id,
          chat.chat_jid,
          chat.last_message_time,
          nextMs,
          shouldCatchupNew ? 1 : 0,
          shouldCatchupNew ? Math.max(0, nextMs - 1) : 0,
          initialHasMessages,
          nowMs,
        );
        continue;
      }

      if (nextMs > existing.last_message_ms + 500) {
        const latestCached = selectLatestCached.get(chat.device_id, chat.chat_jid) as {
          max_ts: number;
        };
        const missingLatest = (latestCached?.max_ts ?? 0) < nextMs - 1000;
        const nextNeedsCatchup = missingLatest || existing.needs_catchup === 1 ? 1 : 0;
        const nextPrevMs =
          existing.needs_catchup === 1 && existing.catchup_prev_ms > 0
            ? existing.catchup_prev_ms
            : missingLatest
              ? existing.last_message_ms
              : 0;
        const nextHasMessages =
          (latestCached?.max_ts ?? 0) > 0
            ? 1
            : existing.has_messages === 1
              ? 1
              : null;

        upsertSync.run(
          chat.device_id,
          chat.chat_jid,
          chat.last_message_time,
          nextMs,
          nextNeedsCatchup,
          nextPrevMs,
          nextHasMessages,
          nowMs,
        );
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return listPendingCatchupChats();
}

export function listPendingCatchupChats(limit = 10): PendingCatchupChat[] {
  const safeLimit = Math.max(1, Math.min(limit, 50));
  return queryAll<PendingCatchupChat>(
    `SELECT device_id,
            chat_jid,
            catchup_prev_ms AS prev_last_message_ms,
            last_message_ms AS new_last_message_ms
     FROM chat_sync_state
     WHERE needs_catchup = 1
     ORDER BY last_message_ms DESC
     LIMIT ?`,
    safeLimit,
  );
}

export function clearChatCatchup(deviceId: string, chatJid: string): void {
  db.prepare(
    `UPDATE chat_sync_state
     SET needs_catchup = 0, catchup_prev_ms = 0, updated_at = ?
     WHERE device_id = ? AND chat_jid = ?`,
  ).run(Date.now(), deviceId, chatJid);
}

export function setChatMessagePresence(
  deviceId: string,
  chatJid: string,
  hasMessages: boolean,
  lastMessageTime?: string,
): void {
  if (!deviceId || !chatJid) return;
  const nowMs = Date.now();
  const nextTime = lastMessageTime?.trim() || '';
  const nextMs = nextTime ? parseTimestampMs(nextTime) : 0;
  db.prepare(`
    INSERT INTO chat_sync_state (
      device_id, chat_jid, last_message_time, last_message_ms, needs_catchup, catchup_prev_ms, has_messages, updated_at
    )
    VALUES (?, ?, ?, ?, 0, 0, ?, ?)
    ON CONFLICT(device_id, chat_jid) DO UPDATE SET
      last_message_time = CASE
        WHEN excluded.last_message_ms > chat_sync_state.last_message_ms THEN excluded.last_message_time
        ELSE chat_sync_state.last_message_time
      END,
      last_message_ms = MAX(chat_sync_state.last_message_ms, excluded.last_message_ms),
      has_messages = excluded.has_messages,
      updated_at = excluded.updated_at
  `).run(deviceId, chatJid, nextTime, nextMs, hasMessages ? 1 : 0, nowMs);
}

export function getChatsMessagePresenceMap(
  chats: Array<{device_id: string; chat_jid: string}>,
): Map<string, boolean | null> {
  const result = new Map<string, boolean | null>();
  if (chats.length === 0) return result;

  const uniqueDeviceIds = Array.from(new Set(chats.map((c) => c.device_id).filter(Boolean)));
  const uniqueChatJids = Array.from(new Set(chats.map((c) => c.chat_jid).filter(Boolean)));
  if (uniqueDeviceIds.length === 0 || uniqueChatJids.length === 0) return result;

  const devicePlaceholders = uniqueDeviceIds.map(() => '?').join(', ');
  const useJidFilter = uniqueChatJids.length <= 500;
  const jidClause = useJidFilter
    ? `AND chat_jid IN (${uniqueChatJids.map(() => '?').join(', ')})`
    : '';
  const params: SQLInputValue[] = [
    ...uniqueDeviceIds,
    ...(useJidFilter ? uniqueChatJids : []),
  ];

  const cachedRows = queryAll<{device_id: string; chat_jid: string}>(
    `SELECT DISTINCT device_id, chat_jid
     FROM cached_messages
     WHERE device_id IN (${devicePlaceholders}) ${jidClause}`,
    ...params,
  );
  for (const row of cachedRows) {
    result.set(`${row.device_id}::${row.chat_jid}`, true);
  }

  const syncRows = queryAll<{device_id: string; chat_jid: string; has_messages: number | null}>(
    `SELECT device_id, chat_jid, has_messages
     FROM chat_sync_state
     WHERE device_id IN (${devicePlaceholders}) ${jidClause}`,
    ...params,
  );
  for (const row of syncRows) {
    const key = `${row.device_id}::${row.chat_jid}`;
    if (result.get(key) === true) continue;
    if (row.has_messages === 1) result.set(key, true);
    else if (row.has_messages === 0) result.set(key, false);
    else result.set(key, null);
  }

  return result;
}

export function getUnreadCountsForUser(
  user: Pick<PublicUser, 'id' | 'created_at'>,
  chats: Array<{device_id: string; chat_jid: string}>,
): Map<string, number> {
  const result = new Map<string, number>();
  if (chats.length === 0) return result;

  const uniqueDeviceIds = Array.from(new Set(chats.map((c) => c.device_id).filter(Boolean)));
  const uniqueChatJids = Array.from(new Set(chats.map((c) => c.chat_jid).filter(Boolean)));
  if (uniqueDeviceIds.length === 0 || uniqueChatJids.length === 0) return result;

  const userCreatedAtMs = parseTimestampMs(user.created_at);
  const devicePlaceholders = uniqueDeviceIds.map(() => '?').join(', ');
  const useJidFilter = uniqueChatJids.length <= 500;
  const jidClause = useJidFilter
    ? `AND m.chat_jid IN (${uniqueChatJids.map(() => '?').join(', ')})`
    : '';
  const queryParams: SQLInputValue[] = [
    user.id,
    ...uniqueDeviceIds,
    ...(useJidFilter ? uniqueChatJids : []),
    userCreatedAtMs,
    userCreatedAtMs,
  ];

  const rows = queryAll<{
    device_id: string;
    chat_jid: string;
    unread_count: number;
  }>(
    `SELECT m.device_id,
            m.chat_jid,
            COUNT(*) AS unread_count
     FROM cached_messages m
     LEFT JOIN user_chat_read_states r
       ON r.user_id = ?
      AND r.device_id = m.device_id
      AND r.chat_jid = m.chat_jid
     WHERE m.is_from_me = 0
       AND m.is_revoked = 0
       AND m.is_unread_candidate = 1
       AND m.device_id IN (${devicePlaceholders})
       ${jidClause}
       AND m.seq > COALESCE(r.last_read_seq, 0)
       AND (
         r.last_read_seq IS NOT NULL
         OR ? <= 0
         OR m.cached_at >= ?
       )
     GROUP BY m.device_id, m.chat_jid`,
    ...queryParams,
  );

  const requestedKeys = new Set(chats.map((c) => `${c.device_id}::${c.chat_jid}`));
  for (const row of rows) {
    const key = `${row.device_id}::${row.chat_jid}`;
    if (requestedKeys.has(key) && row.unread_count > 0) {
      result.set(key, Number(row.unread_count));
    }
  }

  const manualUnreadRows = queryAll<{device_id: string; chat_jid: string}>(
    `SELECT device_id, chat_jid
     FROM user_chat_read_states
     WHERE user_id = ?
       AND manual_unread = 1
       AND device_id IN (${devicePlaceholders})`,
    user.id,
    ...uniqueDeviceIds,
  );
  for (const row of manualUnreadRows) {
    const key = `${row.device_id}::${row.chat_jid}`;
    if (requestedKeys.has(key)) {
      result.set(key, Math.max(1, result.get(key) ?? 0));
    }
  }

  return result;
}

export function getGroupUnreadSummaryForUser(
  user: Pick<PublicUser, 'id' | 'created_at'>,
  deviceIds?: string[],
): {totalUnread: number; byKey: Map<string, number>} {
  const byKey = new Map<string, number>();
  const cleanDeviceIds = deviceIds
    ? Array.from(new Set(deviceIds.map((id) => id.trim()).filter(Boolean)))
    : null;
  if (cleanDeviceIds !== null && cleanDeviceIds.length === 0) {
    return {totalUnread: 0, byKey};
  }

  const userCreatedAtMs = parseTimestampMs(user.created_at);
  const deviceClause =
    cleanDeviceIds !== null
      ? `AND m.device_id IN (${cleanDeviceIds.map(() => '?').join(', ')})`
      : '';
  const queryParams: SQLInputValue[] = [
    user.id,
    ...(cleanDeviceIds ?? []),
    userCreatedAtMs,
    userCreatedAtMs,
  ];

  const rows = queryAll<{
    device_id: string;
    chat_jid: string;
    unread_count: number;
  }>(
    `SELECT m.device_id,
            m.chat_jid,
            COUNT(*) AS unread_count
     FROM cached_messages m
     LEFT JOIN user_chat_read_states r
       ON r.user_id = ?
      AND r.device_id = m.device_id
      AND r.chat_jid = m.chat_jid
     WHERE m.is_from_me = 0
       AND m.is_revoked = 0
       AND m.is_unread_candidate = 1
       AND LOWER(m.chat_jid) LIKE '%@g.us'
       ${deviceClause}
       AND m.seq > COALESCE(r.last_read_seq, 0)
       AND (
         r.last_read_seq IS NOT NULL
         OR ? <= 0
         OR m.cached_at >= ?
       )
     GROUP BY m.device_id, m.chat_jid`,
    ...queryParams,
  );

  let totalUnread = 0;
  for (const row of rows) {
    const count = Number(row.unread_count) || 0;
    if (count > 0) {
      byKey.set(`${row.device_id}::${row.chat_jid}`, count);
      totalUnread += count;
    }
  }

  return {totalUnread, byKey};
}

export function markChatReadForUser(userId: number, deviceId: string, chatJid: string): number {
  const globalMaxRow = queryOne<{max_seq: number | null}>(
    'SELECT MAX(seq) AS max_seq FROM cached_messages',
  );
  const targetSeq = Math.max(0, globalMaxRow?.max_seq ?? 0);
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  db.prepare(`
    INSERT INTO user_chat_read_states (user_id, device_id, chat_jid, last_read_seq, last_read_at, manual_unread, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, ?)
    ON CONFLICT(user_id, device_id, chat_jid) DO UPDATE SET
      last_read_seq = MAX(user_chat_read_states.last_read_seq, excluded.last_read_seq),
      last_read_at = excluded.last_read_at,
      manual_unread = 0,
      updated_at = excluded.updated_at
  `).run(userId, deviceId, chatJid, targetSeq, nowIso, nowMs);

  return targetSeq;
}

export function markChatUnreadForUser(userId: number, deviceId: string, chatJid: string): void {
  const nowMs = Date.now();
  db.prepare(`
    INSERT INTO user_chat_read_states (user_id, device_id, chat_jid, last_read_seq, last_read_at, manual_unread, updated_at)
    VALUES (?, ?, ?, 0, '', 1, ?)
    ON CONFLICT(user_id, device_id, chat_jid) DO UPDATE SET
      manual_unread = 1,
      updated_at = excluded.updated_at
  `).run(userId, deviceId, chatJid, nowMs);
}
