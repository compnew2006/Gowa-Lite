import {isGroupJid, isNewsletterJid, isStatusBroadcastJid} from '../../shared/whatsapp-identity.ts';
import {db, parseTimestampMs, queryAll, queryOne, withImmediateTransaction} from './connection.ts';

export type ChatLifecycleStatus = 'pending' | 'open' | 'closed';

export type ChatLifecycleEventType =
  | 'claimed'
  | 'auto_claimed'
  | 'assigned'
  | 'transferred'
  | 'released'
  | 'closed'
  | 'reopened'
  | 'reopened_by_customer';

export interface ChatAssignmentInfo {
  device_id: string;
  chat_jid: string;
  status: ChatLifecycleStatus;
  assigned_user_id: number | null;
  assigned_user_name: string | null;
  assigned_at: string | null;
  claimed_at: string | null;
  closed_by_id: number | null;
  closed_by_name: string | null;
  closed_at: string | null;
  close_reason: string;
  cached_title: string;
  last_activity_ms: number;
  updated_at: number;
}

export interface ChatLifecycleEvent {
  id: number;
  device_id: string;
  chat_jid: string;
  event_type: ChatLifecycleEventType;
  actor_user_id: number | null;
  actor_name: string;
  target_user_id: number | null;
  target_name: string;
  note: string;
  created_at: string;
  created_at_ms: number;
}

export interface DbLifecycleChatEntry {
  jid: string;
  name: string;
  last_message_time: string;
  last_activity_ms: number;
  device_id: string;
  assignment: ChatAssignmentInfo;
}

interface AssignmentJoinRow {
  device_id: string;
  chat_jid: string;
  status: ChatLifecycleStatus;
  assigned_user_id: number | null;
  assigned_user_name: string | null;
  assigned_at: string | null;
  claimed_at: string | null;
  closed_by_id: number | null;
  closed_by_name: string | null;
  closed_at: string | null;
  close_reason: string;
  cached_title: string;
  last_activity_ms: number;
  updated_at: number;
}

interface LifecycleEventRow {
  id: number;
  device_id: string;
  chat_jid: string;
  event_type: ChatLifecycleEventType;
  actor_user_id: number | null;
  actor_name: string;
  target_user_id: number | null;
  target_name: string;
  note: string;
  created_at: string;
  created_at_ms: number;
}

const LIFECYCLE_EVENT_COLUMNS = `
  id, device_id, chat_jid, event_type,
  actor_user_id, actor_name, target_user_id, target_name,
  note, created_at, created_at_ms
`;

const ASSIGNMENT_SELECT_SQL = `
  SELECT ca.device_id,
         ca.chat_jid,
         ca.status,
         ca.assigned_user_id,
         ua.display_name AS assigned_user_name,
         ca.assigned_at,
         ca.claimed_at,
         ca.closed_by_id,
         uc.display_name AS closed_by_name,
         ca.closed_at,
         ca.close_reason,
         ca.cached_title,
         ca.last_activity_ms,
         ca.updated_at
  FROM chat_assignments ca
  LEFT JOIN users ua ON ua.id = ca.assigned_user_id
  LEFT JOIN users uc ON uc.id = ca.closed_by_id
`;

export function defaultChatAssignment(deviceId: string, chatJid: string): ChatAssignmentInfo {
  return {
    device_id: deviceId,
    chat_jid: chatJid,
    status: 'pending',
    assigned_user_id: null,
    assigned_user_name: null,
    assigned_at: null,
    claimed_at: null,
    closed_by_id: null,
    closed_by_name: null,
    closed_at: null,
    close_reason: '',
    cached_title: '',
    last_activity_ms: 0,
    updated_at: 0,
  };
}

function hydrateAssignmentRow(row: AssignmentJoinRow): ChatAssignmentInfo {
  const effectiveStatus: ChatLifecycleStatus =
    row.status === 'open' && row.assigned_user_id === null ? 'pending' : row.status;
  return {
    device_id: row.device_id,
    chat_jid: row.chat_jid,
    status: effectiveStatus,
    assigned_user_id: effectiveStatus === 'open' ? row.assigned_user_id : null,
    assigned_user_name: effectiveStatus === 'open' ? (row.assigned_user_name ?? null) : null,
    assigned_at: effectiveStatus === 'open' ? row.assigned_at : null,
    claimed_at: effectiveStatus === 'open' ? row.claimed_at : null,
    closed_by_id: effectiveStatus === 'closed' ? row.closed_by_id : null,
    closed_by_name: effectiveStatus === 'closed' ? (row.closed_by_name ?? null) : null,
    closed_at: effectiveStatus === 'closed' ? row.closed_at : null,
    close_reason: effectiveStatus === 'closed' ? row.close_reason || '' : '',
    cached_title: row.cached_title || '',
    last_activity_ms: Number(row.last_activity_ms) || 0,
    updated_at: Number(row.updated_at) || 0,
  };
}

export function readChatAssignmentRow(deviceId: string, chatJid: string): ChatAssignmentInfo | null {
  const row = queryOne<AssignmentJoinRow>(
    `${ASSIGNMENT_SELECT_SQL} WHERE ca.device_id = ? AND ca.chat_jid = ?`,
    deviceId,
    chatJid,
  );
  return row ? hydrateAssignmentRow(row) : null;
}

export function resolveKnownChatActivityMs(
  deviceId: string,
  chatJid: string,
  fallbackMs: number,
): number {
  const cachedRow = queryOne<{max_ms: number}>(
    'SELECT COALESCE(MAX(timestamp_ms), 0) AS max_ms FROM cached_messages WHERE device_id = ? AND chat_jid = ?',
    deviceId,
    chatJid,
  );
  const syncRow = queryOne<{last_message_ms: number}>(
    'SELECT last_message_ms FROM chat_sync_state WHERE device_id = ? AND chat_jid = ?',
    deviceId,
    chatJid,
  );
  return Math.max(
    fallbackMs,
    Number(cachedRow?.max_ms) || 0,
    Number(syncRow?.last_message_ms) || 0,
  );
}

export function upsertChatAssignmentRow(params: {
  deviceId: string;
  chatJid: string;
  status: ChatLifecycleStatus;
  assignedUserId: number | null;
  assignedAt: string | null;
  claimedAt: string | null;
  closedById: number | null;
  closedAt: string | null;
  closeReason: string;
  cachedTitle: string;
  lastActivityMs: number;
  updatedAt: number;
}): ChatAssignmentInfo {
  db.prepare(`
    INSERT INTO chat_assignments (
      device_id, chat_jid, status,
      assigned_user_id, assigned_at, claimed_at,
      closed_by_id, closed_at, close_reason,
      cached_title, last_activity_ms, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(device_id, chat_jid) DO UPDATE SET
      status = excluded.status,
      assigned_user_id = excluded.assigned_user_id,
      assigned_at = excluded.assigned_at,
      claimed_at = excluded.claimed_at,
      closed_by_id = excluded.closed_by_id,
      closed_at = excluded.closed_at,
      close_reason = excluded.close_reason,
      cached_title = CASE
        WHEN excluded.cached_title <> '' THEN excluded.cached_title
        ELSE chat_assignments.cached_title
      END,
      last_activity_ms = MAX(chat_assignments.last_activity_ms, excluded.last_activity_ms),
      updated_at = excluded.updated_at
  `).run(
    params.deviceId,
    params.chatJid,
    params.status,
    params.assignedUserId,
    params.assignedAt,
    params.claimedAt,
    params.closedById,
    params.closedAt,
    params.closeReason,
    params.cachedTitle,
    params.lastActivityMs,
    params.updatedAt,
  );
  return readChatAssignmentRow(params.deviceId, params.chatJid) ??
    defaultChatAssignment(params.deviceId, params.chatJid);
}

export function updateChatAssignmentActivityAndTitle(
  deviceId: string,
  chatJid: string,
  activityMs: number,
  cachedTitle: string,
): void {
  db.prepare(
    `UPDATE chat_assignments
     SET last_activity_ms = MAX(last_activity_ms, ?),
         cached_title = CASE WHEN cached_title = '' THEN ? ELSE cached_title END
     WHERE device_id = ? AND chat_jid = ?`,
  ).run(activityMs, cachedTitle.trim(), deviceId, chatJid);
}

export function insertChatLifecycleEventRow(params: {
  deviceId: string;
  chatJid: string;
  eventType: ChatLifecycleEventType;
  actorUserId: number | null;
  actorName: string;
  targetUserId?: number | null;
  targetName?: string;
  note?: string;
  createdAt?: string;
  createdAtMs?: number;
}): ChatLifecycleEvent {
  const nowMs = params.createdAtMs ?? Date.now();
  const nowIso = params.createdAt ?? new Date(nowMs).toISOString();
  const note = (params.note ?? '').trim().slice(0, 500);
  const info = db
    .prepare(
      `INSERT INTO chat_lifecycle_events (
         device_id, chat_jid, event_type,
         actor_user_id, actor_name,
         target_user_id, target_name,
         note, created_at, created_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      params.deviceId,
      params.chatJid,
      params.eventType,
      params.actorUserId,
      params.actorName,
      params.targetUserId ?? null,
      params.targetName ?? '',
      note,
      nowIso,
      nowMs,
    );
  const row = queryOne<LifecycleEventRow>(
    `SELECT ${LIFECYCLE_EVENT_COLUMNS} FROM chat_lifecycle_events WHERE id = ?`,
    Number(info.lastInsertRowid),
  );
  if (!row) {
    throw new Error('Failed to load inserted chat lifecycle event');
  }
  return {
    id: row.id,
    device_id: row.device_id,
    chat_jid: row.chat_jid,
    event_type: row.event_type,
    actor_user_id: row.actor_user_id,
    actor_name: row.actor_name,
    target_user_id: row.target_user_id,
    target_name: row.target_name,
    note: row.note,
    created_at: row.created_at,
    created_at_ms: Number(row.created_at_ms) || nowMs,
  };
}

export function getChatLifecycleMap(
  chats: Array<{device_id: string; chat_jid: string}>,
): Map<string, ChatAssignmentInfo> {
  const out = new Map<string, ChatAssignmentInfo>();
  if (chats.length === 0) return out;

  const deviceIds = Array.from(new Set(chats.map((c) => c.device_id).filter(Boolean)));
  if (deviceIds.length === 0) return out;

  const requestedKeys = new Set(chats.map((c) => `${c.device_id}::${c.chat_jid}`));
  const placeholders = deviceIds.map(() => '?').join(', ');
  const rows = queryAll<AssignmentJoinRow>(
    `${ASSIGNMENT_SELECT_SQL} WHERE ca.device_id IN (${placeholders})`,
    ...deviceIds,
  );

  for (const row of rows) {
    const key = `${row.device_id}::${row.chat_jid}`;
    if (requestedKeys.has(key)) {
      out.set(key, hydrateAssignmentRow(row));
    }
  }
  return out;
}

export function listAssignmentsForDevices(deviceIds: string[]): Map<string, ChatAssignmentInfo> {
  const out = new Map<string, ChatAssignmentInfo>();
  const cleanIds = Array.from(new Set(deviceIds.map((d) => d.trim()).filter(Boolean)));
  if (cleanIds.length === 0) return out;

  const placeholders = cleanIds.map(() => '?').join(', ');
  const rows = queryAll<AssignmentJoinRow>(
    `${ASSIGNMENT_SELECT_SQL} WHERE ca.device_id IN (${placeholders})`,
    ...cleanIds,
  );

  for (const row of rows) {
    out.set(`${row.device_id}::${row.chat_jid}`, hydrateAssignmentRow(row));
  }
  return out;
}

export function getAssignmentStatsForDevices(
  deviceIds: string[],
  meOwnerUserId: number | null,
  closedOwnerUserId?: number | null,
): {allOpen: number; closed: number; meOpen: number} {
  const cleanIds = Array.from(new Set(deviceIds.map((d) => d.trim()).filter(Boolean)));
  if (cleanIds.length === 0) return {allOpen: 0, closed: 0, meOpen: 0};

  const placeholders = cleanIds.map(() => '?').join(', ');
  const rows = queryAll<{
    status: ChatLifecycleStatus;
    assigned_user_id: number | null;
    closed_by_id: number | null;
    total: number;
  }>(
    `SELECT status, assigned_user_id, closed_by_id, COUNT(*) AS total
     FROM chat_assignments
     WHERE device_id IN (${placeholders})
       AND LOWER(chat_jid) <> 'status@broadcast'
       AND LOWER(chat_jid) NOT LIKE '%@newsletter'
       AND LOWER(chat_jid) NOT LIKE '%@g.us'
     GROUP BY status, assigned_user_id, closed_by_id`,
    ...cleanIds,
  );

  let allOpen = 0;
  let closed = 0;
  let meOpen = 0;
  for (const row of rows) {
    const count = Number(row.total) || 0;
    if (row.status === 'closed') {
      // Closed rows always have assigned_user_id NULL — closed_by_id is the
      // only owner column. null/undefined owner counts every closed row
      // (supervisor / legacy callers); a number counts only that closer's.
      if (
        closedOwnerUserId === null ||
        closedOwnerUserId === undefined ||
        row.closed_by_id === closedOwnerUserId
      ) {
        closed += count;
      }
    } else if (row.status === 'open' && row.assigned_user_id !== null) {
      allOpen += count;
      if (meOwnerUserId === null || row.assigned_user_id === meOwnerUserId) {
        meOpen += count;
      }
    }
  }
  return {allOpen, closed, meOpen};
}

export function batchUpdateAssignmentMetadata(
  updates: Array<{device_id: string; chat_jid: string; title: string; activityMs: number}>,
): void {
  if (updates.length === 0) return;
  withImmediateTransaction(() => {
    const stmt = db.prepare(`
      UPDATE chat_assignments
      SET cached_title = CASE WHEN cached_title = '' AND ? <> '' THEN ? ELSE cached_title END,
          last_activity_ms = MAX(last_activity_ms, ?)
      WHERE device_id = ? AND chat_jid = ?
    `);
    for (const row of updates) {
      stmt.run(row.title, row.title, row.activityMs, row.device_id, row.chat_jid);
    }
  });
}

export function listDbChatsByLifecycleStatus(params: {
  deviceIds: string[];
  status: 'closed' | 'open';
  ownerUserId?: number | null;
  limit?: number;
  offset?: number;
}): DbLifecycleChatEntry[] {
  const cleanIds = Array.from(new Set(params.deviceIds.map((d) => d.trim()).filter(Boolean)));
  if (cleanIds.length === 0) return [];

  const placeholders = cleanIds.map(() => '?').join(', ');
  const args: Array<string | number> = [params.status, ...cleanIds];
  let ownerClause = '';
  if (params.status === 'open') {
    ownerClause = ' AND ca.assigned_user_id IS NOT NULL';
    if (typeof params.ownerUserId === 'number' && params.ownerUserId > 0) {
      ownerClause += ' AND ca.assigned_user_id = ?';
      args.push(params.ownerUserId);
    }
  } else if (params.status === 'closed') {
    // Closed rows always have assigned_user_id NULL (closeChat clears it) —
    // the only owner column is closed_by_id.
    if (typeof params.ownerUserId === 'number' && params.ownerUserId > 0) {
      ownerClause = ' AND ca.closed_by_id = ?';
      args.push(params.ownerUserId);
    }
  }

  let limitClause = '';
  if (typeof params.limit === 'number' && params.limit > 0) {
    limitClause = ' LIMIT ? OFFSET ?';
    args.push(Math.floor(params.limit), Math.max(0, Math.floor(params.offset ?? 0)));
  }

  const rows = queryAll<
    AssignmentJoinRow & {
      sync_last_time: string | null;
      sync_last_ms: number | null;
      cached_sender_name: string | null;
      cached_max_ms: number | null;
    }
  >(
    `SELECT ca.device_id,
            ca.chat_jid,
            ca.status,
            ca.assigned_user_id,
            ua.display_name AS assigned_user_name,
            ca.assigned_at,
            ca.claimed_at,
            ca.closed_by_id,
            uc.display_name AS closed_by_name,
            ca.closed_at,
            ca.close_reason,
            ca.cached_title,
            ca.last_activity_ms,
            ca.updated_at,
            css.last_message_time AS sync_last_time,
            css.last_message_ms AS sync_last_ms,
            CASE WHEN ca.cached_title = '' THEN (
              SELECT cm.sender_display_name
              FROM cached_messages cm
              WHERE cm.device_id = ca.device_id
                AND cm.chat_jid = ca.chat_jid
                AND cm.is_from_me = 0
                AND cm.sender_display_name <> ''
              ORDER BY cm.timestamp_ms DESC, cm.seq DESC
              LIMIT 1
            ) ELSE NULL END AS cached_sender_name,
            CASE WHEN ca.last_activity_ms <= 0 THEN (
              SELECT MAX(cm.timestamp_ms)
              FROM cached_messages cm
              WHERE cm.device_id = ca.device_id
                AND cm.chat_jid = ca.chat_jid
            ) ELSE NULL END AS cached_max_ms
     FROM chat_assignments ca
     LEFT JOIN users ua ON ua.id = ca.assigned_user_id
     LEFT JOIN users uc ON uc.id = ca.closed_by_id
     LEFT JOIN chat_sync_state css ON css.device_id = ca.device_id AND css.chat_jid = ca.chat_jid
     WHERE ca.status = ?
       AND ca.device_id IN (${placeholders})
       AND LOWER(ca.chat_jid) <> 'status@broadcast'
       AND LOWER(ca.chat_jid) NOT LIKE '%@newsletter'
       AND LOWER(ca.chat_jid) NOT LIKE '%@g.us'${ownerClause}
     ORDER BY MAX(ca.last_activity_ms, COALESCE(css.last_message_ms, 0)) DESC, ca.updated_at DESC${limitClause}`,
    ...args,
  );

  return rows
    .filter(
      (row) =>
        !isStatusBroadcastJid(row.chat_jid) &&
        !isNewsletterJid(row.chat_jid) &&
        !isGroupJid(row.chat_jid),
    )
    .map((row) => {
      const assignment = hydrateAssignmentRow(row);
      const effectiveMs = Math.max(
        assignment.last_activity_ms,
        Number(row.sync_last_ms) || 0,
        Number(row.cached_max_ms) || 0,
        assignment.closed_at ? parseTimestampMs(assignment.closed_at) : 0,
        assignment.updated_at || 0,
      );
      const lastMessageTime =
        (row.sync_last_time && row.sync_last_time.trim()) ||
        (effectiveMs > 0 ? new Date(effectiveMs).toISOString() : '') ||
        assignment.closed_at ||
        '';
      const fallbackPhone = row.chat_jid.split('@')[0]?.split(':')[0] || row.chat_jid;
      const resolvedName =
        assignment.cached_title ||
        (row.cached_sender_name && row.cached_sender_name.trim()) ||
        fallbackPhone;

      return {
        jid: row.chat_jid,
        name: resolvedName,
        last_message_time: lastMessageTime,
        last_activity_ms: effectiveMs,
        device_id: row.device_id,
        assignment,
      };
    })
    .sort((a, b) => b.last_activity_ms - a.last_activity_ms);
}

export function listChatLifecycleEventRows(
  deviceId: string,
  chatJid: string,
  limit = 100,
): ChatLifecycleEvent[] {
  const safeLimit = Math.min(Math.max(limit, 1), 300);
  const rows = queryAll<LifecycleEventRow>(
    `SELECT ${LIFECYCLE_EVENT_COLUMNS} FROM chat_lifecycle_events
     WHERE device_id = ? AND chat_jid = ?
     ORDER BY id DESC
     LIMIT ?`,
    deviceId,
    chatJid,
    safeLimit,
  );

  return rows.reverse().map((row) => ({
    id: row.id,
    device_id: row.device_id,
    chat_jid: row.chat_jid,
    event_type: row.event_type,
    actor_user_id: row.actor_user_id,
    actor_name: row.actor_name,
    target_user_id: row.target_user_id,
    target_name: row.target_name,
    note: row.note,
    created_at: row.created_at,
    created_at_ms: Number(row.created_at_ms) || parseTimestampMs(row.created_at),
  }));
}

export function getOpenChatCountsByUser(): Map<number, number> {
  const rows = queryAll<{assigned_user_id: number; open_count: number}>(
    `SELECT assigned_user_id, COUNT(*) AS open_count
     FROM chat_assignments
     WHERE status = 'open' AND assigned_user_id IS NOT NULL
     GROUP BY assigned_user_id`,
  );
  const countsByUser = new Map<number, number>();
  for (const row of rows) {
    countsByUser.set(row.assigned_user_id, Number(row.open_count) || 0);
  }
  return countsByUser;
}
