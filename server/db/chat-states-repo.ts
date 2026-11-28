import {GowaError} from '../errors.ts';
import {db, queryAll, queryOne, withImmediateTransaction} from './connection.ts';

// =========================================================================
// Conversation Notes
// =========================================================================
export interface ConversationNote {
  id: number;
  device_id: string;
  chat_jid: string;
  created_by_id: number;
  created_by_name: string;
  content: string;
  is_pinned: boolean;
  created_at: string;
  updated_at: string;
}

interface ConversationNoteRow {
  id: number;
  device_id: string;
  chat_jid: string;
  created_by_id: number;
  created_by_name: string;
  content: string;
  is_pinned: number;
  created_at: string;
  updated_at: string;
}

function toPublicNote(row: ConversationNoteRow): ConversationNote {
  return {
    id: row.id,
    device_id: row.device_id,
    chat_jid: row.chat_jid,
    created_by_id: row.created_by_id,
    created_by_name: row.created_by_name,
    content: row.content,
    is_pinned: row.is_pinned === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listConversationNotes(deviceId: string, chatJid: string): ConversationNote[] {
  const rows = queryAll<ConversationNoteRow>(
    `SELECT id, device_id, chat_jid, created_by_id, created_by_name, content, is_pinned, created_at, updated_at
     FROM conversation_notes
     WHERE device_id = ? AND chat_jid = ?
     ORDER BY is_pinned DESC, updated_at DESC, id DESC`,
    deviceId,
    chatJid,
  );
  return rows.map(toPublicNote);
}

// =========================================================================
// Note Edit History (P2-7)
// =========================================================================
export interface NoteEditHistoryEntry {
  id: number;
  note_id: number;
  device_id: string;
  chat_jid: string;
  edited_by_id: number;
  edited_by_name: string;
  previous_content: string;
  new_content: string;
  edited_at: string;
}

/**
 * Edit history of one note, newest first. Only genuine content edits are
 * recorded (see updateConversationNote): pin-only toggles and
 * unchanged-content edits leave no row behind.
 */
export function listNoteEditHistory(
  noteId: number,
  deviceId: string,
  chatJid: string,
): NoteEditHistoryEntry[] {
  return queryAll<NoteEditHistoryEntry>(
    `SELECT id, note_id, device_id, chat_jid, edited_by_id, edited_by_name,
            previous_content, new_content, edited_at
     FROM note_edit_history
     WHERE note_id = ? AND device_id = ? AND chat_jid = ?
     ORDER BY edited_at DESC, id DESC`,
    noteId,
    deviceId,
    chatJid,
  );
}

export function getConversationNoteById(
  noteId: number,
  deviceId: string,
  chatJid: string,
): ConversationNote | null {
  const row = queryOne<ConversationNoteRow>(
    `SELECT id, device_id, chat_jid, created_by_id, created_by_name, content, is_pinned, created_at, updated_at
     FROM conversation_notes
     WHERE id = ? AND device_id = ? AND chat_jid = ?`,
    noteId,
    deviceId,
    chatJid,
  );
  return row ? toPublicNote(row) : null;
}

export function createConversationNote(input: {
  deviceId: string;
  chatJid: string;
  createdById: number;
  createdByName: string;
  content: string;
  isPinned?: boolean;
}): ConversationNote {
  const nowIso = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO conversation_notes (
         device_id, chat_jid, created_by_id, created_by_name, content, is_pinned, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.deviceId,
      input.chatJid,
      input.createdById,
      input.createdByName,
      input.content,
      input.isPinned ? 1 : 0,
      nowIso,
      nowIso,
    );
  const created = getConversationNoteById(Number(info.lastInsertRowid), input.deviceId, input.chatJid);
  if (!created) {
    throw new Error('Failed to load newly created conversation note');
  }
  return created;
}

export function updateConversationNote(
  noteId: number,
  deviceId: string,
  chatJid: string,
  patch: {content?: string; is_pinned?: boolean},
  editor?: {id: number; name: string},
): ConversationNote | null {
  const existing = getConversationNoteById(noteId, deviceId, chatJid);
  if (!existing) return null;

  const nextContent = patch.content !== undefined ? patch.content : existing.content;
  const nextPinned = patch.is_pinned !== undefined ? (patch.is_pinned ? 1 : 0) : existing.is_pinned ? 1 : 0;
  const nextUpdatedAt = patch.content !== undefined ? new Date().toISOString() : existing.updated_at;
  // P2-7: only a real content change writes a history row (editor + time +
  // before/after), in the same transaction as the update itself. A pin-only
  // toggle or an edit to the identical text records nothing.
  const changedContent = patch.content;
  const contentChanged = changedContent !== undefined && changedContent !== existing.content;

  return withImmediateTransaction(() => {
    db.prepare(
      `UPDATE conversation_notes
       SET content = ?, is_pinned = ?, updated_at = ?
       WHERE id = ? AND device_id = ? AND chat_jid = ?`,
    ).run(nextContent, nextPinned, nextUpdatedAt, noteId, deviceId, chatJid);

    if (contentChanged) {
      db.prepare(
        `INSERT INTO note_edit_history (
           note_id, device_id, chat_jid, edited_by_id, edited_by_name,
           previous_content, new_content, edited_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        noteId,
        deviceId,
        chatJid,
        editor?.id ?? 0,
        editor?.name ?? '',
        existing.content,
        changedContent,
        nextUpdatedAt,
      );
    }

    return getConversationNoteById(noteId, deviceId, chatJid);
  });
}

export function deleteConversationNote(
  noteId: number,
  deviceId: string,
  chatJid: string,
): boolean {
  // P2-7: history rows belong to the note — they go with it.
  db.prepare('DELETE FROM note_edit_history WHERE note_id = ? AND device_id = ? AND chat_jid = ?')
    .run(noteId, deviceId, chatJid);
  const info = db
    .prepare('DELETE FROM conversation_notes WHERE id = ? AND device_id = ? AND chat_jid = ?')
    .run(noteId, deviceId, chatJid);
  return info.changes > 0;
}

// =========================================================================
// Chat Row Menu: Device States, User Preferences (Mute/Favourites) & Lists
// =========================================================================
export interface ChatDeviceState {
  device_id: string;
  chat_jid: string;
  is_pinned: boolean;
  pinned_at_ms: number;
  archived_override: boolean | null;
  is_blocked: boolean;
  blocked_at_ms: number;
  cleared_before_ms: number;
  deleted_before_ms: number;
  updated_at: number;
}

interface ChatDeviceStateRow {
  device_id: string;
  chat_jid: string;
  is_pinned: number;
  pinned_at_ms: number;
  archived_override: number | null;
  is_blocked: number;
  blocked_at_ms: number;
  cleared_before_ms: number;
  deleted_before_ms: number;
  updated_at: number;
}

function hydrateChatDeviceState(row: ChatDeviceStateRow): ChatDeviceState {
  return {
    device_id: row.device_id,
    chat_jid: row.chat_jid,
    is_pinned: row.is_pinned === 1,
    pinned_at_ms: Number(row.pinned_at_ms) || 0,
    archived_override:
      row.archived_override === null || row.archived_override === undefined
        ? null
        : row.archived_override === 1,
    is_blocked: row.is_blocked === 1,
    blocked_at_ms: Number(row.blocked_at_ms) || 0,
    cleared_before_ms: Number(row.cleared_before_ms) || 0,
    deleted_before_ms: Number(row.deleted_before_ms) || 0,
    updated_at: Number(row.updated_at) || 0,
  };
}

export function getChatDeviceState(deviceId: string, chatJid: string): ChatDeviceState | null {
  const row = queryOne<ChatDeviceStateRow>(
    `SELECT device_id, chat_jid, is_pinned, pinned_at_ms, archived_override,
            is_blocked, blocked_at_ms, cleared_before_ms, deleted_before_ms, updated_at
     FROM chat_device_states
     WHERE device_id = ? AND chat_jid = ?`,
    deviceId,
    chatJid,
  );
  return row ? hydrateChatDeviceState(row) : null;
}

export function getChatDeviceStatesMap(deviceIds: string[]): Map<string, ChatDeviceState> {
  const out = new Map<string, ChatDeviceState>();
  const cleanIds = Array.from(new Set(deviceIds.map((d) => d.trim()).filter(Boolean)));
  if (cleanIds.length === 0) return out;

  const placeholders = cleanIds.map(() => '?').join(', ');
  const rows = queryAll<ChatDeviceStateRow>(
    `SELECT device_id, chat_jid, is_pinned, pinned_at_ms, archived_override,
            is_blocked, blocked_at_ms, cleared_before_ms, deleted_before_ms, updated_at
     FROM chat_device_states
     WHERE device_id IN (${placeholders})`,
    ...cleanIds,
  );
  for (const row of rows) {
    out.set(`${row.device_id}::${row.chat_jid}`, hydrateChatDeviceState(row));
  }
  return out;
}

export function isChatBlocked(deviceId: string, chatJid: string): boolean {
  const row = queryOne<{is_blocked: number}>(
    'SELECT is_blocked FROM chat_device_states WHERE device_id = ? AND chat_jid = ?',
    deviceId,
    chatJid,
  );
  return row?.is_blocked === 1;
}

export function setChatPinState(
  deviceId: string,
  chatJid: string,
  pinned: boolean,
  nowMs = Date.now(),
): ChatDeviceState {
  db.prepare(`
    INSERT INTO chat_device_states (device_id, chat_jid, is_pinned, pinned_at_ms, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(device_id, chat_jid) DO UPDATE SET
      is_pinned = excluded.is_pinned,
      pinned_at_ms = CASE WHEN excluded.is_pinned = 1 THEN excluded.pinned_at_ms ELSE 0 END,
      updated_at = excluded.updated_at
  `).run(deviceId, chatJid, pinned ? 1 : 0, pinned ? nowMs : 0, nowMs);
  return getChatDeviceState(deviceId, chatJid)!;
}

export function setChatArchiveOverride(
  deviceId: string,
  chatJid: string,
  archived: boolean,
  nowMs = Date.now(),
): ChatDeviceState {
  db.prepare(`
    INSERT INTO chat_device_states (device_id, chat_jid, archived_override, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(device_id, chat_jid) DO UPDATE SET
      archived_override = excluded.archived_override,
      updated_at = excluded.updated_at
  `).run(deviceId, chatJid, archived ? 1 : 0, nowMs);
  return getChatDeviceState(deviceId, chatJid)!;
}

export function setChatBlockedState(
  deviceId: string,
  chatJid: string,
  blocked: boolean,
  nowMs = Date.now(),
): ChatDeviceState {
  db.prepare(`
    INSERT INTO chat_device_states (device_id, chat_jid, is_blocked, blocked_at_ms, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(device_id, chat_jid) DO UPDATE SET
      is_blocked = excluded.is_blocked,
      blocked_at_ms = CASE WHEN excluded.is_blocked = 1 THEN excluded.blocked_at_ms ELSE 0 END,
      updated_at = excluded.updated_at
  `).run(deviceId, chatJid, blocked ? 1 : 0, blocked ? nowMs : 0, nowMs);
  return getChatDeviceState(deviceId, chatJid)!;
}

export function clearChatHistoryInDb(
  deviceId: string,
  chatJid: string,
  nowMs = Date.now(),
): {clearedBeforeMs: number; deletedMessages: number} {
  return withImmediateTransaction(() => {
    db.prepare(`
      INSERT INTO chat_device_states (device_id, chat_jid, cleared_before_ms, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(device_id, chat_jid) DO UPDATE SET
        cleared_before_ms = MAX(chat_device_states.cleared_before_ms, excluded.cleared_before_ms),
        updated_at = excluded.updated_at
    `).run(deviceId, chatJid, nowMs, nowMs);

    const deleted = db
      .prepare('DELETE FROM cached_messages WHERE device_id = ? AND chat_jid = ?')
      .run(deviceId, chatJid);
    db.prepare('DELETE FROM message_reaction_changes WHERE device_id = ? AND chat_jid = ?')
      .run(deviceId, chatJid);

    db.prepare(
      `UPDATE user_chat_read_states
       SET manual_unread = 0, updated_at = ?
       WHERE device_id = ? AND chat_jid = ?`,
    ).run(nowMs, deviceId, chatJid);

    db.prepare(
      `UPDATE chat_sync_state
       SET has_messages = 0, updated_at = ?
       WHERE device_id = ? AND chat_jid = ?`,
    ).run(nowMs, deviceId, chatJid);

    return {
      clearedBeforeMs: nowMs,
      deletedMessages: Number(deleted.changes),
    };
  });
}

export function deleteChatInDb(
  deviceId: string,
  chatJid: string,
  nowMs = Date.now(),
): {deletedBeforeMs: number} {
  return withImmediateTransaction(() => {
    db.prepare(`
      INSERT INTO chat_device_states (
        device_id, chat_jid, is_pinned, pinned_at_ms, archived_override,
        cleared_before_ms, deleted_before_ms, updated_at
      )
      VALUES (?, ?, 0, 0, NULL, ?, ?, ?)
      ON CONFLICT(device_id, chat_jid) DO UPDATE SET
        is_pinned = 0,
        pinned_at_ms = 0,
        archived_override = NULL,
        cleared_before_ms = MAX(chat_device_states.cleared_before_ms, excluded.cleared_before_ms),
        deleted_before_ms = MAX(chat_device_states.deleted_before_ms, excluded.deleted_before_ms),
        updated_at = excluded.updated_at
    `).run(deviceId, chatJid, nowMs, nowMs, nowMs);

    db.prepare('DELETE FROM cached_messages WHERE device_id = ? AND chat_jid = ?').run(
      deviceId,
      chatJid,
    );
    db.prepare('DELETE FROM message_reaction_changes WHERE device_id = ? AND chat_jid = ?')
      .run(deviceId, chatJid);
    db.prepare('DELETE FROM chat_assignments WHERE device_id = ? AND chat_jid = ?').run(
      deviceId,
      chatJid,
    );
    db.prepare('DELETE FROM chat_lifecycle_events WHERE device_id = ? AND chat_jid = ?').run(
      deviceId,
      chatJid,
    );
    db.prepare('DELETE FROM chat_sync_state WHERE device_id = ? AND chat_jid = ?').run(
      deviceId,
      chatJid,
    );
    db.prepare('DELETE FROM user_chat_read_states WHERE device_id = ? AND chat_jid = ?').run(
      deviceId,
      chatJid,
    );
    db.prepare('DELETE FROM user_chat_preferences WHERE device_id = ? AND chat_jid = ?').run(
      deviceId,
      chatJid,
    );
    db.prepare('DELETE FROM chat_list_items WHERE device_id = ? AND chat_jid = ?').run(
      deviceId,
      chatJid,
    );

    return {deletedBeforeMs: nowMs};
  });
}

export interface UserChatPreference {
  is_favourite: boolean;
  muted_until_ms: number;
}

export type MuteDuration = '8h' | '1w' | 'always' | 'unmute';

export function computeMutedUntilMs(duration: MuteDuration, nowMs = Date.now()): number {
  if (duration === 'unmute') return 0;
  if (duration === 'always') return -1;
  if (duration === '8h') return nowMs + 8 * 60 * 60 * 1000;
  return nowMs + 7 * 24 * 60 * 60 * 1000;
}

export function normalizeActiveMutedUntil(rawMutedUntilMs: number, nowMs = Date.now()): number {
  if (rawMutedUntilMs === -1) return -1;
  if (rawMutedUntilMs > nowMs) return rawMutedUntilMs;
  return 0;
}

export function getUserChatPreferencesMap(
  userId: number,
  deviceIds: string[],
  nowMs = Date.now(),
): Map<string, UserChatPreference> {
  const out = new Map<string, UserChatPreference>();
  const cleanIds = Array.from(new Set(deviceIds.map((d) => d.trim()).filter(Boolean)));
  if (cleanIds.length === 0) return out;

  const placeholders = cleanIds.map(() => '?').join(', ');
  const rows = queryAll<{
    device_id: string;
    chat_jid: string;
    is_favourite: number;
    muted_until_ms: number;
  }>(
    `SELECT device_id, chat_jid, is_favourite, muted_until_ms
     FROM user_chat_preferences
     WHERE user_id = ? AND device_id IN (${placeholders})`,
    userId,
    ...cleanIds,
  );
  for (const row of rows) {
    out.set(`${row.device_id}::${row.chat_jid}`, {
      is_favourite: row.is_favourite === 1,
      muted_until_ms: normalizeActiveMutedUntil(Number(row.muted_until_ms) || 0, nowMs),
    });
  }
  return out;
}

export function getUserMutedChatKeys(userId: number, nowMs = Date.now()): string[] {
  const rows = queryAll<{device_id: string; chat_jid: string}>(
    `SELECT device_id, chat_jid
     FROM user_chat_preferences
     WHERE user_id = ? AND (muted_until_ms = -1 OR muted_until_ms > ?)`,
    userId,
    nowMs,
  );
  return rows.map((r) => `${r.device_id}::${r.chat_jid}`);
}

export function setUserChatMute(
  userId: number,
  deviceId: string,
  chatJid: string,
  duration: MuteDuration,
  nowMs = Date.now(),
): number {
  const mutedUntilMs = computeMutedUntilMs(duration, nowMs);
  db.prepare(`
    INSERT INTO user_chat_preferences (user_id, device_id, chat_jid, muted_until_ms, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, device_id, chat_jid) DO UPDATE SET
      muted_until_ms = excluded.muted_until_ms,
      updated_at = excluded.updated_at
  `).run(userId, deviceId, chatJid, mutedUntilMs, nowMs);
  return mutedUntilMs;
}

export function setUserChatFavourite(
  userId: number,
  deviceId: string,
  chatJid: string,
  favourite: boolean,
  nowMs = Date.now(),
): boolean {
  db.prepare(`
    INSERT INTO user_chat_preferences (user_id, device_id, chat_jid, is_favourite, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, device_id, chat_jid) DO UPDATE SET
      is_favourite = excluded.is_favourite,
      updated_at = excluded.updated_at
  `).run(userId, deviceId, chatJid, favourite ? 1 : 0, nowMs);
  return favourite;
}

export interface ChatListSummary {
  id: number;
  name: string;
  chat_count: number;
  created_at: string;
  updated_at: string;
}

export function listChatListsForUser(userId: number): ChatListSummary[] {
  return queryAll<ChatListSummary>(
    `SELECT l.id,
            l.name,
            COUNT(i.chat_jid) AS chat_count,
            l.created_at,
            l.updated_at
     FROM chat_lists l
     LEFT JOIN chat_list_items i ON i.list_id = l.id
     WHERE l.user_id = ?
     GROUP BY l.id
     ORDER BY l.id ASC`,
    userId,
  ).map((r) => ({
    ...r,
    chat_count: Number(r.chat_count) || 0,
  }));
}

export function createChatListForUser(userId: number, rawName: string): ChatListSummary {
  const name = rawName.trim();
  if (!name) {
    throw new GowaError(400, 'VALIDATION_ERROR', 'اسم القائمة مطلوب');
  }
  const existing = queryOne<{id: number}>(
    'SELECT id FROM chat_lists WHERE user_id = ? AND name = ? COLLATE NOCASE',
    userId,
    name,
  );
  if (existing) {
    throw new GowaError(409, 'DUPLICATE_LIST_NAME', 'توجد قائمة بهذا الاسم بالفعل');
  }
  const countRow = queryOne<{total: number}>(
    'SELECT COUNT(*) AS total FROM chat_lists WHERE user_id = ?',
    userId,
  );
  if ((countRow?.total ?? 0) >= 50) {
    throw new GowaError(400, 'LIST_LIMIT_REACHED', 'تم الوصول للحد الأقصى لعدد القوائم (50)');
  }

  const nowIso = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO chat_lists (user_id, name, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(userId, name, nowIso, nowIso);
  return {
    id: Number(info.lastInsertRowid),
    name,
    chat_count: 0,
    created_at: nowIso,
    updated_at: nowIso,
  };
}

export function deleteChatListForUser(userId: number, listId: number): boolean {
  const info = db
    .prepare('DELETE FROM chat_lists WHERE id = ? AND user_id = ?')
    .run(listId, userId);
  return info.changes > 0;
}

export function getUserChatListMemberships(
  userId: number,
  deviceIds: string[],
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const cleanIds = Array.from(new Set(deviceIds.map((d) => d.trim()).filter(Boolean)));
  if (cleanIds.length === 0) return out;

  const placeholders = cleanIds.map(() => '?').join(', ');
  const rows = queryAll<{list_id: number; device_id: string; chat_jid: string}>(
    `SELECT i.list_id, i.device_id, i.chat_jid
     FROM chat_list_items i
     INNER JOIN chat_lists l ON l.id = i.list_id
     WHERE l.user_id = ? AND i.device_id IN (${placeholders})
     ORDER BY i.list_id ASC`,
    userId,
    ...cleanIds,
  );
  for (const row of rows) {
    const key = `${row.device_id}::${row.chat_jid}`;
    const existing = out.get(key);
    if (existing) existing.push(row.list_id);
    else out.set(key, [row.list_id]);
  }
  return out;
}

export function setChatListMembership(
  userId: number,
  deviceId: string,
  chatJid: string,
  listIds: number[],
): number[] {
  const uniqueIds = Array.from(new Set(listIds.filter((id) => Number.isInteger(id) && id > 0)));
  const ownedRows = queryAll<{id: number}>('SELECT id FROM chat_lists WHERE user_id = ?', userId);
  const ownedSet = new Set(ownedRows.map((r) => r.id));

  for (const id of uniqueIds) {
    if (!ownedSet.has(id)) {
      throw new GowaError(404, 'LIST_NOT_FOUND', 'إحدى القوائم المحددة غير موجودة');
    }
  }

  const nowMs = Date.now();
  return withImmediateTransaction(() => {
    db.prepare(
      `DELETE FROM chat_list_items
       WHERE device_id = ? AND chat_jid = ?
         AND list_id IN (SELECT id FROM chat_lists WHERE user_id = ?)`,
    ).run(deviceId, chatJid, userId);

    const insertStmt = db.prepare(
      `INSERT INTO chat_list_items (list_id, device_id, chat_jid, added_at)
       VALUES (?, ?, ?, ?)`,
    );
    for (const id of uniqueIds) {
      insertStmt.run(id, deviceId, chatJid, nowMs);
    }
    return uniqueIds;
  });
}
