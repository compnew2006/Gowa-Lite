import type {SQLInputValue} from 'node:sqlite';
import {
  db,
  getSetting,
  getUserById,
  listUsers,
  parseTimestampMs,
  setSetting,
  type PublicUser,
} from '../db.ts';
import {GowaError} from '../errors.ts';
import {hasAnyPermission, hasDeviceAccess, hasPermission, isAdminSubject} from '../rbac.ts';
import {expireChatCloseRatings, queueChatCloseRating} from './chat-close-rating.ts';
import {
  isGroupJid,
  isNewsletterJid,
  isStatusBroadcastJid,
  normalizeWhatsAppJid,
} from '../../shared/whatsapp-identity.ts';

export type ChatLifecycleStatus = 'pending' | 'open' | 'closed';

export type UnassignedReplyPolicy = 'auto_claim' | 'allow_without_claim' | 'require_claim';
export type ClosedReplyPolicy = 'block' | 'reopen_and_claim';

export interface InboxPolicy {
  unassigned_reply_policy: UnassignedReplyPolicy;
  closed_reply_policy: ClosedReplyPolicy;
}

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

export interface AssignableAgent {
  id: number;
  username: string;
  display_name: string;
  role_slug: string;
  role_name: string;
  open_chat_count: number;
}

export interface ChatLifecycleWsPayload {
  code: 'CHAT_LIFECYCLE_UPDATED';
  message: string;
  device_id: string;
  result: {
    device_id: string;
    chat_jid: string;
    assignment: ChatAssignmentInfo;
    event?: ChatLifecycleEvent;
  };
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

const DEFAULT_INBOX_POLICY: InboxPolicy = {
  unassigned_reply_policy: 'auto_claim',
  closed_reply_policy: 'block',
};

const VALID_UNASSIGNED_POLICIES = new Set<UnassignedReplyPolicy>([
  'auto_claim',
  'allow_without_claim',
  'require_claim',
]);
const VALID_CLOSED_POLICIES = new Set<ClosedReplyPolicy>(['block', 'reopen_and_claim']);

function queryAll<T extends object>(sql: string, ...params: SQLInputValue[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

function queryOne<T extends object>(sql: string, ...params: SQLInputValue[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
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

function withImmediateTransaction<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    throw err;
  }
}

export function normalizeLifecycleTarget(
  rawDeviceId: string,
  rawChatJid: string,
): {deviceId: string; chatJid: string} {
  const deviceId = rawDeviceId.trim();
  const trimmedJid = rawChatJid.trim();
  const chatJid = normalizeWhatsAppJid(trimmedJid) || trimmedJid;

  if (!deviceId || !chatJid) {
    throw new GowaError(400, 'VALIDATION_ERROR', 'معرّف الحساب والمحادثة مطلوبان');
  }
  if (isStatusBroadcastJid(chatJid) || isNewsletterJid(chatJid) || isGroupJid(chatJid)) {
    throw new GowaError(
      400,
      'UNSUPPORTED_CHAT_TYPE',
      'لا تدعم المجموعات أو القنوات أو حالات واتساب دورة حياة المحادثات',
    );
  }
  return {deviceId, chatJid};
}

function defaultAssignment(deviceId: string, chatJid: string): ChatAssignmentInfo {
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

function readAssignmentInternal(deviceId: string, chatJid: string): ChatAssignmentInfo | null {
  const row = db
    .prepare(`${ASSIGNMENT_SELECT_SQL} WHERE ca.device_id = ? AND ca.chat_jid = ?`)
    .get(deviceId, chatJid) as AssignmentJoinRow | undefined;
  return row ? hydrateAssignmentRow(row) : null;
}

function resolveKnownActivityMs(deviceId: string, chatJid: string, fallbackMs: number): number {
  const cachedRow = db
    .prepare(
      'SELECT COALESCE(MAX(timestamp_ms), 0) AS max_ms FROM cached_messages WHERE device_id = ? AND chat_jid = ?',
    )
    .get(deviceId, chatJid) as {max_ms: number} | undefined;
  const syncRow = db
    .prepare('SELECT last_message_ms FROM chat_sync_state WHERE device_id = ? AND chat_jid = ?')
    .get(deviceId, chatJid) as {last_message_ms: number} | undefined;
  return Math.max(
    fallbackMs,
    Number(cachedRow?.max_ms) || 0,
    Number(syncRow?.last_message_ms) || 0,
  );
}

function upsertAssignmentRow(params: {
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
  return readAssignmentInternal(params.deviceId, params.chatJid) ??
    defaultAssignment(params.deviceId, params.chatJid);
}

function insertLifecycleEvent(params: {
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

function hasSupervisorView(user: PublicUser): boolean {
  return isAdminSubject(user) || hasPermission(user, 'chats', 'view_all');
}

export function buildLifecycleWsPayload(
  assignment: ChatAssignmentInfo,
  event?: ChatLifecycleEvent,
): ChatLifecycleWsPayload {
  return {
    code: 'CHAT_LIFECYCLE_UPDATED',
    message: event?.event_type || assignment.status,
    device_id: assignment.device_id,
    result: {
      device_id: assignment.device_id,
      chat_jid: assignment.chat_jid,
      assignment,
      ...(event ? {event} : {}),
    },
  };
}

export function getInboxPolicy(): InboxPolicy {
  const raw = getSetting('inbox_policy');
  if (!raw) return {...DEFAULT_INBOX_POLICY};
  try {
    const parsed = JSON.parse(raw) as Partial<InboxPolicy>;
    const unassigned = VALID_UNASSIGNED_POLICIES.has(
      parsed.unassigned_reply_policy as UnassignedReplyPolicy,
    )
      ? (parsed.unassigned_reply_policy as UnassignedReplyPolicy)
      : DEFAULT_INBOX_POLICY.unassigned_reply_policy;
    const closed = VALID_CLOSED_POLICIES.has(parsed.closed_reply_policy as ClosedReplyPolicy)
      ? (parsed.closed_reply_policy as ClosedReplyPolicy)
      : DEFAULT_INBOX_POLICY.closed_reply_policy;
    return {
      unassigned_reply_policy: unassigned,
      closed_reply_policy: closed,
    };
  } catch {
    return {...DEFAULT_INBOX_POLICY};
  }
}

export function updateInboxPolicy(input: {
  unassigned_reply_policy?: unknown;
  closed_reply_policy?: unknown;
}): InboxPolicy {
  const current = getInboxPolicy();
  let nextUnassigned = current.unassigned_reply_policy;
  let nextClosed = current.closed_reply_policy;

  if (input.unassigned_reply_policy !== undefined) {
    if (
      typeof input.unassigned_reply_policy !== 'string' ||
      !VALID_UNASSIGNED_POLICIES.has(input.unassigned_reply_policy as UnassignedReplyPolicy)
    ) {
      throw new GowaError(400, 'VALIDATION_ERROR', 'سياسة الرد على المحادثات غير المستلمة غير صالحة');
    }
    nextUnassigned = input.unassigned_reply_policy as UnassignedReplyPolicy;
  }

  if (input.closed_reply_policy !== undefined) {
    if (
      typeof input.closed_reply_policy !== 'string' ||
      !VALID_CLOSED_POLICIES.has(input.closed_reply_policy as ClosedReplyPolicy)
    ) {
      throw new GowaError(400, 'VALIDATION_ERROR', 'سياسة الرد على المحادثات المغلقة غير صالحة');
    }
    nextClosed = input.closed_reply_policy as ClosedReplyPolicy;
  }

  const nextPolicy: InboxPolicy = {
    unassigned_reply_policy: nextUnassigned,
    closed_reply_policy: nextClosed,
  };
  setSetting('inbox_policy', JSON.stringify(nextPolicy));
  return nextPolicy;
}

export function isLifecycleApplicableJid(chatJid: string): boolean {
  const trimmed = chatJid.trim();
  if (!trimmed) return false;
  return !isStatusBroadcastJid(trimmed) && !isNewsletterJid(trimmed) && !isGroupJid(trimmed);
}

export type ChatRedactionReason = 'pending' | 'closed' | 'assigned_other';

export interface ChatContentAccessState {
  allowed: boolean;
  reason?: ChatRedactionReason;
  assignment: ChatAssignmentInfo;
}

export function getChatLifecycleState(deviceIdRaw: string, chatJidRaw: string): ChatAssignmentInfo {
  const {deviceId, chatJid} = normalizeLifecycleTarget(deviceIdRaw, chatJidRaw);
  return readAssignmentInternal(deviceId, chatJid) ?? defaultAssignment(deviceId, chatJid);
}

export function getChatContentAccessState(
  user: PublicUser,
  deviceIdRaw: string,
  chatJidRaw: string,
): ChatContentAccessState {
  const deviceId = deviceIdRaw.trim();
  const trimmedJid = chatJidRaw.trim();
  const chatJid = normalizeWhatsAppJid(trimmedJid) || trimmedJid;

  if (!deviceId || !chatJid || !isLifecycleApplicableJid(chatJid)) {
    return {
      allowed: true,
      assignment: defaultAssignment(deviceId, chatJid),
    };
  }

  const assignment =
    readAssignmentInternal(deviceId, chatJid) ?? defaultAssignment(deviceId, chatJid);
  if (hasSupervisorView(user)) {
    return {allowed: true, assignment};
  }
  if (assignment.status === 'open' && assignment.assigned_user_id === user.id) {
    return {allowed: true, assignment};
  }

  const reason: ChatRedactionReason =
    assignment.status === 'closed'
      ? 'closed'
      : assignment.status === 'open'
        ? 'assigned_other'
        : 'pending';

  return {allowed: false, reason, assignment};
}

export function assertChatContentAccess(
  user: PublicUser,
  deviceIdRaw: string,
  chatJidRaw: string,
): ChatAssignmentInfo {
  const state = getChatContentAccessState(user, deviceIdRaw, chatJidRaw);
  if (!state.allowed) {
    throw new GowaError(
      403,
      'CHAT_CONTENT_REDACTED',
      'محتوى هذه المحادثة محجوب حاليًا حتى يتم استلامها أو فتحها',
      {redaction_reason: state.reason, assignment: state.assignment},
    );
  }
  return state.assignment;
}

export type UnifiedChatTab = 'all' | 'me' | 'pending' | 'closed';

export interface UnifiedTabCounts {
  all: number;
  me: number;
  pending: number;
  closed: number;
}

export interface DbLifecycleChatEntry {
  jid: string;
  name: string;
  last_message_time: string;
  last_activity_ms: number;
  device_id: string;
  assignment: ChatAssignmentInfo;
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
): {allOpen: number; closed: number; meOpen: number} {
  const cleanIds = Array.from(new Set(deviceIds.map((d) => d.trim()).filter(Boolean)));
  if (cleanIds.length === 0) return {allOpen: 0, closed: 0, meOpen: 0};

  const placeholders = cleanIds.map(() => '?').join(', ');
  const rows = queryAll<{
    status: ChatLifecycleStatus;
    assigned_user_id: number | null;
    total: number;
  }>(
    `SELECT status, assigned_user_id, COUNT(*) AS total
     FROM chat_assignments
     WHERE device_id IN (${placeholders})
       AND LOWER(chat_jid) <> 'status@broadcast'
       AND LOWER(chat_jid) NOT LIKE '%@newsletter'
       AND LOWER(chat_jid) NOT LIKE '%@g.us'
     GROUP BY status, assigned_user_id`,
    ...cleanIds,
  );

  let allOpen = 0;
  let closed = 0;
  let meOpen = 0;
  for (const row of rows) {
    const count = Number(row.total) || 0;
    if (row.status === 'closed') {
      closed += count;
    } else if (row.status === 'open' && row.assigned_user_id !== null) {
      allOpen += count;
      if (meOwnerUserId === null || row.assigned_user_id === meOwnerUserId) {
        meOpen += count;
      }
    }
  }
  return {allOpen, closed, meOpen};
}

export function syncAssignmentMetadataFromChats(
  chats: Array<{device_id: string; chat_jid: string; name?: string; last_message_time?: string}>,
  existingMap?: Map<string, ChatAssignmentInfo>,
): boolean {
  if (chats.length === 0) return false;
  const map = existingMap ?? getChatLifecycleMap(chats);
  const toUpdate: Array<{device_id: string; chat_jid: string; title: string; activityMs: number}> = [];

  for (const item of chats) {
    const existing = map.get(`${item.device_id}::${item.chat_jid}`);
    if (!existing) continue;
    const incomingTitle = (item.name ?? '').trim();
    const incomingMs = item.last_message_time ? parseTimestampMs(item.last_message_time) : 0;
    const needsTitle = !existing.cached_title && Boolean(incomingTitle);
    const needsTime = incomingMs > existing.last_activity_ms;
    if (needsTitle || needsTime) {
      toUpdate.push({
        device_id: item.device_id,
        chat_jid: item.chat_jid,
        title: incomingTitle,
        activityMs: incomingMs,
      });
    }
  }

  if (toUpdate.length === 0) return false;

  withImmediateTransaction(() => {
    const stmt = db.prepare(`
      UPDATE chat_assignments
      SET cached_title = CASE WHEN cached_title = '' AND ? <> '' THEN ? ELSE cached_title END,
          last_activity_ms = MAX(last_activity_ms, ?)
      WHERE device_id = ? AND chat_jid = ?
    `);
    for (const row of toUpdate) {
      stmt.run(row.title, row.title, row.activityMs, row.device_id, row.chat_jid);
    }
  });
  return true;
}

export function listDbChatsByLifecycleStatus(params: {
  deviceIds: string[];
  status: 'closed' | 'open';
  assignedUserId?: number | null;
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
    if (typeof params.assignedUserId === 'number' && params.assignedUserId > 0) {
      ownerClause += ' AND ca.assigned_user_id = ?';
      args.push(params.assignedUserId);
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

export function listChatLifecycleEvents(
  deviceIdRaw: string,
  chatJidRaw: string,
  limit = 100,
): ChatLifecycleEvent[] {
  const {deviceId, chatJid} = normalizeLifecycleTarget(deviceIdRaw, chatJidRaw);
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

export function listAssignableAgents(deviceIdRaw: string): AssignableAgent[] {
  const deviceId = deviceIdRaw.trim();
  if (!deviceId) {
    throw new GowaError(400, 'VALIDATION_ERROR', 'معرّف الحساب مطلوب');
  }

  const countRows = db
    .prepare(
      `SELECT assigned_user_id, COUNT(*) AS open_count
       FROM chat_assignments
       WHERE status = 'open' AND assigned_user_id IS NOT NULL
       GROUP BY assigned_user_id`,
    )
    .all() as Array<{assigned_user_id: number; open_count: number}>;

  const countsByUser = new Map<number, number>();
  for (const row of countRows) {
    countsByUser.set(row.assigned_user_id, Number(row.open_count) || 0);
  }

  const eligible = listUsers()
    .filter(
      (u) =>
        u.is_active &&
        hasDeviceAccess(u, deviceId) &&
        hasAnyPermission(u, ['chats:read', 'chats:write']),
    )
    .map<AssignableAgent>((u) => ({
      id: u.id,
      username: u.username,
      display_name: u.display_name,
      role_slug: u.role_slug,
      role_name: u.role_name,
      open_chat_count: countsByUser.get(u.id) ?? 0,
    }));

  eligible.sort((a, b) => {
    if (a.open_chat_count !== b.open_chat_count) {
      return a.open_chat_count - b.open_chat_count;
    }
    return a.display_name.localeCompare(b.display_name);
  });

  return eligible;
}

export function claimChat(
  actor: PublicUser,
  deviceIdRaw: string,
  chatJidRaw: string,
  options?: {cachedTitle?: string},
): {assignment: ChatAssignmentInfo; event: ChatLifecycleEvent} {
  if (!hasPermission(actor, 'chats', 'assign')) {
    throw new GowaError(403, 'FORBIDDEN', 'ليس لديك صلاحية استلام المحادثات');
  }
  const {deviceId, chatJid} = normalizeLifecycleTarget(deviceIdRaw, chatJidRaw);
  if (!hasDeviceAccess(actor, deviceId)) {
    throw new GowaError(403, 'DEVICE_FORBIDDEN', 'غير مصرح لك بالوصول إلى حساب واتساب هذا');
  }

  return withImmediateTransaction(() => {
    const existing = readAssignmentInternal(deviceId, chatJid);
    if (existing?.status === 'closed') {
      throw new GowaError(
        409,
        'CHAT_CLOSED',
        'هذه المحادثة مغلقة حاليًا؛ يرجى إعادة فتحها قبل الاستلام',
        {assignment: existing},
      );
    }
    if (existing?.status === 'open' && existing.assigned_user_id !== null) {
      const ownerName = existing.assigned_user_name || 'وكيل آخر';
      throw new GowaError(
        409,
        'ALREADY_CLAIMED',
        `تم استلام هذه المحادثة بالفعل بواسطة ${ownerName}`,
        {assignment: existing},
      );
    }

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const activityMs = resolveKnownActivityMs(
      deviceId,
      chatJid,
      existing?.last_activity_ms ?? 0,
    );
    const cachedTitle = (options?.cachedTitle ?? '').trim() || existing?.cached_title || '';

    const assignment = upsertAssignmentRow({
      deviceId,
      chatJid,
      status: 'open',
      assignedUserId: actor.id,
      assignedAt: nowIso,
      claimedAt: nowIso,
      closedById: null,
      closedAt: null,
      closeReason: '',
      cachedTitle,
      lastActivityMs: activityMs,
      updatedAt: nowMs,
    });

    const event = insertLifecycleEvent({
      deviceId,
      chatJid,
      eventType: 'claimed',
      actorUserId: actor.id,
      actorName: actor.display_name,
      targetUserId: actor.id,
      targetName: actor.display_name,
      createdAt: nowIso,
      createdAtMs: nowMs,
    });

    return {assignment, event};
  });
}

export function assignChat(
  actor: PublicUser,
  deviceIdRaw: string,
  chatJidRaw: string,
  targetUserId: number | null,
  options?: {note?: string; cachedTitle?: string},
): {assignment: ChatAssignmentInfo; event?: ChatLifecycleEvent} {
  if (targetUserId === null) {
    return releaseChat(actor, deviceIdRaw, chatJidRaw, options);
  }

  if (!hasPermission(actor, 'chats', 'assign')) {
    throw new GowaError(403, 'FORBIDDEN', 'ليس لديك صلاحية تعيين المحادثات');
  }
  const {deviceId, chatJid} = normalizeLifecycleTarget(deviceIdRaw, chatJidRaw);
  if (!hasDeviceAccess(actor, deviceId)) {
    throw new GowaError(403, 'DEVICE_FORBIDDEN', 'غير مصرح لك بالوصول إلى حساب واتساب هذا');
  }

  const targetUser = getUserById(targetUserId);
  if (!targetUser) {
    throw new GowaError(404, 'USER_NOT_FOUND', 'المستخدم المحدد غير موجود');
  }
  if (!targetUser.is_active) {
    throw new GowaError(400, 'USER_INACTIVE', 'لا يمكن تعيين محادثة إلى مستخدم معطّل');
  }
  if (!hasDeviceAccess(targetUser, deviceId)) {
    throw new GowaError(
      403,
      'TARGET_DEVICE_FORBIDDEN',
      'المستخدم المحدد غير مخوّل للوصول إلى حساب واتساب هذا',
    );
  }
  if (!hasAnyPermission(targetUser, ['chats:read', 'chats:write'])) {
    throw new GowaError(
      400,
      'TARGET_LACKS_CHAT_PERMISSION',
      'الدور الوظيفي للمستخدم المحدد لا يشمل الوصول إلى المحادثات',
    );
  }

  return withImmediateTransaction(() => {
    const existing = readAssignmentInternal(deviceId, chatJid);
    const supervisor = hasSupervisorView(actor);

    if (!supervisor) {
      if (existing?.status === 'closed') {
        throw new GowaError(
          403,
          'FORBIDDEN',
          'لا يمكنك تعيين محادثة مغلقة؛ يرجى إعادة فتحها أولًا',
        );
      }
      if (
        existing?.status === 'open' &&
        existing.assigned_user_id !== null &&
        existing.assigned_user_id !== actor.id
      ) {
        throw new GowaError(
          403,
          'FORBIDDEN',
          'لا يمكنك إعادة تعيين محادثة مسندة لوكيل آخر',
        );
      }
    }

    if (existing?.status === 'open' && existing.assigned_user_id === targetUser.id) {
      return {assignment: existing};
    }

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const isTransfer =
      existing?.status === 'open' &&
      existing.assigned_user_id !== null &&
      existing.assigned_user_id !== targetUser.id;
    const isSelfClaim = targetUser.id === actor.id && existing?.status !== 'open';
    const eventType: ChatLifecycleEventType = isTransfer
      ? 'transferred'
      : isSelfClaim
        ? 'claimed'
        : 'assigned';

    const activityMs = resolveKnownActivityMs(
      deviceId,
      chatJid,
      existing?.last_activity_ms ?? 0,
    );
    const cachedTitle = (options?.cachedTitle ?? '').trim() || existing?.cached_title || '';

    const assignment = upsertAssignmentRow({
      deviceId,
      chatJid,
      status: 'open',
      assignedUserId: targetUser.id,
      assignedAt: nowIso,
      claimedAt: targetUser.id === actor.id ? nowIso : existing?.claimed_at ?? null,
      closedById: null,
      closedAt: null,
      closeReason: '',
      cachedTitle,
      lastActivityMs: activityMs,
      updatedAt: nowMs,
    });

    const event = insertLifecycleEvent({
      deviceId,
      chatJid,
      eventType,
      actorUserId: actor.id,
      actorName: actor.display_name,
      targetUserId: targetUser.id,
      targetName: targetUser.display_name,
      note: options?.note,
      createdAt: nowIso,
      createdAtMs: nowMs,
    });

    return {assignment, event};
  });
}

export function releaseChat(
  actor: PublicUser,
  deviceIdRaw: string,
  chatJidRaw: string,
  options?: {note?: string; cachedTitle?: string},
): {assignment: ChatAssignmentInfo; event?: ChatLifecycleEvent} {
  if (!hasPermission(actor, 'chats', 'assign')) {
    throw new GowaError(403, 'FORBIDDEN', 'ليس لديك صلاحية تحرير المحادثات');
  }
  const {deviceId, chatJid} = normalizeLifecycleTarget(deviceIdRaw, chatJidRaw);
  if (!hasDeviceAccess(actor, deviceId)) {
    throw new GowaError(403, 'DEVICE_FORBIDDEN', 'غير مصرح لك بالوصول إلى حساب واتساب هذا');
  }

  return withImmediateTransaction(() => {
    const existing = readAssignmentInternal(deviceId, chatJid);
    const supervisor = hasSupervisorView(actor);

    if (!existing || existing.status === 'pending') {
      return {assignment: existing ?? defaultAssignment(deviceId, chatJid)};
    }

    if (existing.status === 'closed' && !supervisor) {
      throw new GowaError(
        403,
        'FORBIDDEN',
        'لا يمكن تحرير محادثة مغلقة مباشرة؛ يجب إعادة فتحها أولًا',
      );
    }

    if (
      existing.status === 'open' &&
      existing.assigned_user_id !== null &&
      existing.assigned_user_id !== actor.id &&
      !supervisor
    ) {
      throw new GowaError(403, 'FORBIDDEN', 'يمكنك تحرير المحادثات المسندة إليك فقط');
    }

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const activityMs = resolveKnownActivityMs(deviceId, chatJid, existing.last_activity_ms);
    const cachedTitle = (options?.cachedTitle ?? '').trim() || existing.cached_title || '';

    const assignment = upsertAssignmentRow({
      deviceId,
      chatJid,
      status: 'pending',
      assignedUserId: null,
      assignedAt: null,
      claimedAt: null,
      closedById: null,
      closedAt: null,
      closeReason: '',
      cachedTitle,
      lastActivityMs: activityMs,
      updatedAt: nowMs,
    });

    const event = insertLifecycleEvent({
      deviceId,
      chatJid,
      eventType: 'released',
      actorUserId: actor.id,
      actorName: actor.display_name,
      targetUserId: existing.assigned_user_id,
      targetName: existing.assigned_user_name ?? '',
      note: options?.note,
      createdAt: nowIso,
      createdAtMs: nowMs,
    });

    return {assignment, event};
  });
}

export function closeChat(
  actor: PublicUser,
  deviceIdRaw: string,
  chatJidRaw: string,
  options?: {reason?: string; cachedTitle?: string},
): {assignment: ChatAssignmentInfo; event?: ChatLifecycleEvent} {
  if (!hasPermission(actor, 'chats', 'close')) {
    throw new GowaError(403, 'FORBIDDEN', 'ليس لديك صلاحية إغلاق المحادثات');
  }
  const {deviceId, chatJid} = normalizeLifecycleTarget(deviceIdRaw, chatJidRaw);
  if (!hasDeviceAccess(actor, deviceId)) {
    throw new GowaError(403, 'DEVICE_FORBIDDEN', 'غير مصرح لك بالوصول إلى حساب واتساب هذا');
  }

  return withImmediateTransaction(() => {
    const existing = readAssignmentInternal(deviceId, chatJid);
    const supervisor = hasSupervisorView(actor);

    if (existing?.status === 'closed') {
      return {assignment: existing};
    }

    if (
      existing?.status === 'open' &&
      existing.assigned_user_id !== null &&
      existing.assigned_user_id !== actor.id &&
      !supervisor
    ) {
      throw new GowaError(
        403,
        'FORBIDDEN',
        'لا يمكنك إغلاق محادثة مسندة لوكيل آخر',
      );
    }

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const cleanReason = (options?.reason ?? '').trim().slice(0, 500);
    const activityMs = resolveKnownActivityMs(
      deviceId,
      chatJid,
      existing?.last_activity_ms ?? 0,
    );
    const cachedTitle = (options?.cachedTitle ?? '').trim() || existing?.cached_title || '';

    const assignment = upsertAssignmentRow({
      deviceId,
      chatJid,
      status: 'closed',
      assignedUserId: null,
      assignedAt: null,
      claimedAt: null,
      closedById: actor.id,
      closedAt: nowIso,
      closeReason: cleanReason,
      cachedTitle,
      lastActivityMs: activityMs,
      updatedAt: nowMs,
    });

    const event = insertLifecycleEvent({
      deviceId,
      chatJid,
      eventType: 'closed',
      actorUserId: actor.id,
      actorName: actor.display_name,
      note: cleanReason,
      createdAt: nowIso,
      createdAtMs: nowMs,
    });

    queueChatCloseRating(deviceId, chatJid, event.id, nowMs);
    return {assignment, event};
  });
}

export function reopenChat(
  actor: PublicUser,
  deviceIdRaw: string,
  chatJidRaw: string,
  options?: {assignToSelf?: boolean; note?: string; cachedTitle?: string},
): {assignment: ChatAssignmentInfo; event?: ChatLifecycleEvent} {
  if (!hasPermission(actor, 'chats', 'close')) {
    throw new GowaError(403, 'FORBIDDEN', 'ليس لديك صلاحية إعادة فتح المحادثات');
  }
  const {deviceId, chatJid} = normalizeLifecycleTarget(deviceIdRaw, chatJidRaw);
  if (!hasDeviceAccess(actor, deviceId)) {
    throw new GowaError(403, 'DEVICE_FORBIDDEN', 'غير مصرح لك بالوصول إلى حساب واتساب هذا');
  }

  return withImmediateTransaction(() => {
    const existing = readAssignmentInternal(deviceId, chatJid);
    if (!existing || existing.status !== 'closed') {
      return {assignment: existing ?? defaultAssignment(deviceId, chatJid)};
    }

    expireChatCloseRatings(deviceId, chatJid);
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const shouldClaim = Boolean(options?.assignToSelf) && hasPermission(actor, 'chats', 'assign');
    const activityMs = resolveKnownActivityMs(deviceId, chatJid, existing.last_activity_ms);
    const cachedTitle = (options?.cachedTitle ?? '').trim() || existing.cached_title || '';

    const assignment = upsertAssignmentRow({
      deviceId,
      chatJid,
      status: shouldClaim ? 'open' : 'pending',
      assignedUserId: shouldClaim ? actor.id : null,
      assignedAt: shouldClaim ? nowIso : null,
      claimedAt: shouldClaim ? nowIso : null,
      closedById: null,
      closedAt: null,
      closeReason: '',
      cachedTitle,
      lastActivityMs: activityMs,
      updatedAt: nowMs,
    });

    const event = insertLifecycleEvent({
      deviceId,
      chatJid,
      eventType: 'reopened',
      actorUserId: actor.id,
      actorName: actor.display_name,
      targetUserId: shouldClaim ? actor.id : null,
      targetName: shouldClaim ? actor.display_name : '',
      note: options?.note,
      createdAt: nowIso,
      createdAtMs: nowMs,
    });

    return {assignment, event};
  });
}

export function handleIncomingCustomerMessageLifecycle(
  deviceIdRaw: string,
  chatJidRaw: string,
  messageTimestampMs?: number,
  cachedTitle?: string,
): ChatLifecycleWsPayload | null {
  const deviceId = deviceIdRaw.trim();
  const trimmedJid = chatJidRaw.trim();
  const chatJid = normalizeWhatsAppJid(trimmedJid) || trimmedJid;
  if (
    !deviceId ||
    !chatJid ||
    isStatusBroadcastJid(chatJid) ||
    isNewsletterJid(chatJid) ||
    isGroupJid(chatJid)
  ) {
    return null;
  }

  return withImmediateTransaction(() => {
    const existing = readAssignmentInternal(deviceId, chatJid);
    const activityMs = Math.max(
      existing?.last_activity_ms ?? 0,
      Number.isFinite(messageTimestampMs) && (messageTimestampMs ?? 0) > 0
        ? (messageTimestampMs as number)
        : 0,
      Date.now(),
    );

    if (!existing) {
      return null;
    }

    if (existing.status !== 'closed') {
      if (activityMs > existing.last_activity_ms || (cachedTitle && cachedTitle.trim() && !existing.cached_title)) {
        db.prepare(
          `UPDATE chat_assignments
           SET last_activity_ms = MAX(last_activity_ms, ?),
               cached_title = CASE WHEN cached_title = '' THEN ? ELSE cached_title END
           WHERE device_id = ? AND chat_jid = ?`,
        ).run(activityMs, (cachedTitle ?? '').trim(), deviceId, chatJid);
      }
      return null;
    }

    // GOWA may round timestamps to seconds. Ignore history older than this close.
    const closedAt = parseTimestampMs(existing.closed_at || '');
    if (messageTimestampMs && messageTimestampMs < Math.floor(closedAt / 1000) * 1000) return null;

    expireChatCloseRatings(deviceId, chatJid);
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const assignment = upsertAssignmentRow({
      deviceId,
      chatJid,
      status: 'pending',
      assignedUserId: null,
      assignedAt: null,
      claimedAt: null,
      closedById: null,
      closedAt: null,
      closeReason: '',
      cachedTitle: (cachedTitle ?? '').trim() || existing.cached_title,
      lastActivityMs: activityMs,
      updatedAt: nowMs,
    });

    const event = insertLifecycleEvent({
      deviceId,
      chatJid,
      eventType: 'reopened_by_customer',
      actorUserId: null,
      actorName: '',
      createdAt: nowIso,
      createdAtMs: nowMs,
    });

    return buildLifecycleWsPayload(assignment, event);
  });
}

export function enforceInboxPolicyBeforeSend(
  actor: PublicUser,
  deviceIdRaw: string,
  chatJidRaw: string,
  cachedTitle?: string,
): {assignment: ChatAssignmentInfo; lifecycleEvent: ChatLifecycleWsPayload | null} {
  const trimmedDevice = deviceIdRaw.trim();
  const trimmedJid = chatJidRaw.trim();
  const normalizedJid = normalizeWhatsAppJid(trimmedJid) || trimmedJid;
  if (trimmedDevice && normalizedJid && isGroupJid(normalizedJid)) {
    return {
      assignment: defaultAssignment(trimmedDevice, normalizedJid),
      lifecycleEvent: null,
    };
  }
  const {deviceId, chatJid} = normalizeLifecycleTarget(deviceIdRaw, chatJidRaw);
  const policy = getInboxPolicy();
  const supervisor = hasSupervisorView(actor);
  const canAssign = hasPermission(actor, 'chats', 'assign');
  const canClose = hasPermission(actor, 'chats', 'close');

  return withImmediateTransaction(() => {
    const existing = readAssignmentInternal(deviceId, chatJid) ?? defaultAssignment(deviceId, chatJid);

    if (existing.status === 'closed') {
      if (policy.closed_reply_policy === 'block') {
        throw new GowaError(
          409,
          'CHAT_CLOSED',
          'هذه المحادثة مغلقة حاليًا؛ يرجى إعادة فتحها قبل إرسال الرد',
          {assignment: existing},
        );
      }
      if (!canClose && !supervisor) {
        throw new GowaError(
          403,
          'FORBIDDEN',
          'ليس لديك صلاحية إعادة فتح المحادثات المغلقة',
        );
      }
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      const activityMs = resolveKnownActivityMs(deviceId, chatJid, Math.max(existing.last_activity_ms, nowMs));
      const assignment = upsertAssignmentRow({
        deviceId,
        chatJid,
        status: canAssign ? 'open' : 'pending',
        assignedUserId: canAssign ? actor.id : null,
        assignedAt: canAssign ? nowIso : null,
        claimedAt: canAssign ? nowIso : null,
        closedById: null,
        closedAt: null,
        closeReason: '',
        cachedTitle: (cachedTitle ?? '').trim() || existing.cached_title,
        lastActivityMs: activityMs,
        updatedAt: nowMs,
      });
      const event = insertLifecycleEvent({
        deviceId,
        chatJid,
        eventType: 'reopened',
        actorUserId: actor.id,
        actorName: actor.display_name,
        targetUserId: canAssign ? actor.id : null,
        targetName: canAssign ? actor.display_name : '',
        createdAt: nowIso,
        createdAtMs: nowMs,
      });
      return {assignment, lifecycleEvent: buildLifecycleWsPayload(assignment, event)};
    }

    if (existing.status === 'open') {
      if (
        existing.assigned_user_id !== null &&
        existing.assigned_user_id !== actor.id &&
        !supervisor
      ) {
        const ownerName = existing.assigned_user_name || 'وكيل آخر';
        throw new GowaError(
          403,
          'CHAT_ASSIGNED_TO_OTHER',
          `هذه المحادثة مسندة حاليًا إلى ${ownerName}`,
          {assignment: existing},
        );
      }
      return {assignment: existing, lifecycleEvent: null};
    }

    // Status is 'pending'
    if (policy.unassigned_reply_policy === 'require_claim') {
      throw new GowaError(
        409,
        'CLAIM_REQUIRED',
        'سياسة العمل تتطلب استلام المحادثة أولًا قبل الرد عليها',
        {assignment: existing},
      );
    }

    if (policy.unassigned_reply_policy === 'auto_claim' && canAssign) {
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      const activityMs = resolveKnownActivityMs(deviceId, chatJid, Math.max(existing.last_activity_ms, nowMs));
      const assignment = upsertAssignmentRow({
        deviceId,
        chatJid,
        status: 'open',
        assignedUserId: actor.id,
        assignedAt: nowIso,
        claimedAt: nowIso,
        closedById: null,
        closedAt: null,
        closeReason: '',
        cachedTitle: (cachedTitle ?? '').trim() || existing.cached_title,
        lastActivityMs: activityMs,
        updatedAt: nowMs,
      });
      const event = insertLifecycleEvent({
        deviceId,
        chatJid,
        eventType: 'auto_claimed',
        actorUserId: actor.id,
        actorName: actor.display_name,
        targetUserId: actor.id,
        targetName: actor.display_name,
        createdAt: nowIso,
        createdAtMs: nowMs,
      });
      return {assignment, lifecycleEvent: buildLifecycleWsPayload(assignment, event)};
    }

    return {assignment: existing, lifecycleEvent: null};
  });
}

export interface BulkLifecycleItem {
  device_id: string;
  chat_jid: string;
  cached_title?: string;
}

export function bulkChatLifecycle(
  actor: PublicUser,
  itemsRaw: unknown,
  actionRaw: unknown,
  options?: {assignedUserId?: number | null; note?: string; reason?: string},
): {
  succeeded: Array<{assignment: ChatAssignmentInfo; wsPayload?: ChatLifecycleWsPayload}>;
  failed: Array<{device_id: string; chat_jid: string; code: string; message: string}>;
} {
  const action = typeof actionRaw === 'string' ? actionRaw.trim() : '';
  if (action !== 'close' && action !== 'release' && action !== 'assign' && action !== 'reopen') {
    throw new GowaError(400, 'VALIDATION_ERROR', 'الإجراء الجماعي المطلوب غير صالح');
  }

  if (action === 'close' || action === 'reopen') {
    if (!hasPermission(actor, 'chats', 'close')) {
      throw new GowaError(403, 'FORBIDDEN', 'ليس لديك صلاحية إغلاق أو إعادة فتح المحادثات');
    }
  } else if (!hasPermission(actor, 'chats', 'assign')) {
    throw new GowaError(403, 'FORBIDDEN', 'ليس لديك صلاحية تعيين أو تحرير المحادثات');
  }

  if (!Array.isArray(itemsRaw) || itemsRaw.length === 0) {
    throw new GowaError(400, 'VALIDATION_ERROR', 'يرجى تحديد محادثة واحدة على الأقل');
  }
  if (itemsRaw.length > 100) {
    throw new GowaError(400, 'VALIDATION_ERROR', 'الحد الأقصى للإجراء الجماعي هو 100 محادثة في المرة الواحدة');
  }

  const deduped: BulkLifecycleItem[] = [];
  const seen = new Set<string>();
  for (const rawItem of itemsRaw) {
    if (typeof rawItem !== 'object' || rawItem === null) continue;
    const itemObj = rawItem as {device_id?: unknown; chat_jid?: unknown; cached_title?: unknown};
    const dev = typeof itemObj.device_id === 'string' ? itemObj.device_id.trim() : '';
    const jid = typeof itemObj.chat_jid === 'string' ? itemObj.chat_jid.trim() : '';
    if (!dev || !jid) continue;
    const key = `${dev}::${jid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({
      device_id: dev,
      chat_jid: jid,
      cached_title: typeof itemObj.cached_title === 'string' ? itemObj.cached_title : undefined,
    });
  }

  if (deduped.length === 0) {
    throw new GowaError(400, 'VALIDATION_ERROR', 'لم يتم العثور على محادثات صالحة للتنفيذ');
  }

  const succeeded: Array<{assignment: ChatAssignmentInfo; wsPayload?: ChatLifecycleWsPayload}> = [];
  const failed: Array<{device_id: string; chat_jid: string; code: string; message: string}> = [];

  for (const item of deduped) {
    try {
      let res: {assignment: ChatAssignmentInfo; event?: ChatLifecycleEvent};
      if (action === 'close') {
        res = closeChat(actor, item.device_id, item.chat_jid, {
          reason: options?.reason,
          cachedTitle: item.cached_title,
        });
      } else if (action === 'release') {
        res = releaseChat(actor, item.device_id, item.chat_jid, {
          note: options?.note,
          cachedTitle: item.cached_title,
        });
      } else if (action === 'reopen') {
        res = reopenChat(actor, item.device_id, item.chat_jid, {
          note: options?.note,
          cachedTitle: item.cached_title,
        });
      } else {
        const targetId = options?.assignedUserId === undefined ? null : options.assignedUserId;
        res = assignChat(actor, item.device_id, item.chat_jid, targetId, {
          note: options?.note,
          cachedTitle: item.cached_title,
        });
      }
      succeeded.push({
        assignment: res.assignment,
        wsPayload: res.event ? buildLifecycleWsPayload(res.assignment, res.event) : undefined,
      });
    } catch (err) {
      if (err instanceof GowaError) {
        failed.push({
          device_id: item.device_id,
          chat_jid: item.chat_jid,
          code: err.code,
          message: err.message,
        });
      } else {
        failed.push({
          device_id: item.device_id,
          chat_jid: item.chat_jid,
          code: 'INTERNAL_ERROR',
          message: 'تعذر تنفيذ الإجراء لهذه المحادثة',
        });
      }
    }
  }

  return {succeeded, failed};
}
