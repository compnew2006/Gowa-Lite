import {db, parseTimestampMs, queryAll, queryOne} from '../db.ts';
import {gowaFetch} from '../gowa-client.ts';
import {hasPermission, isAdminSubject, type RbacSubject} from '../rbac.ts';
import {normalizeWhatsAppJid} from '../../shared/whatsapp-identity.ts';

/**
 * Ownership of gateway schedules (P0-2).
 *
 * Gateway schedule records carry no creator, so Lite records who created each
 * schedule in `schedule_ownership` at creation time. The server is the
 * authority: `canManageSchedule` decides every manage action, and lists are
 * annotated with `can_manage` for the requesting user. Anything without a
 * mapping row (pre-existing or ambiguous schedules) is admin/supervisor-only.
 * Fail closed everywhere: on any doubt, record nothing and deny.
 */

export interface ScheduleOwner {
  created_by_user_id: number;
  created_by_name: string;
}

export interface ScheduleCreator {
  id: number;
  display_name: string;
}

const LIST_MATCH_WINDOW_MS = 60_000;

function digitsOf(value: string): string {
  return value.replace(/\D/g, '');
}

export function getScheduleOwnership(
  deviceId: string,
  scheduleId: string,
): ScheduleOwner | undefined {
  if (!scheduleId) return undefined;
  return queryOne<ScheduleOwner>(
    'SELECT created_by_user_id, created_by_name FROM schedule_ownership WHERE schedule_id = ? AND device_id = ?',
    scheduleId,
    deviceId,
  );
}

export function recordScheduleOwnership(
  deviceId: string,
  scheduleId: string,
  user: ScheduleCreator,
  chatJid?: string,
): void {
  if (!deviceId || !scheduleId) return;
  db.prepare(
    `INSERT OR REPLACE INTO schedule_ownership
       (schedule_id, device_id, created_by_user_id, created_by_name, chat_jid, created_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`,
  ).run(scheduleId, deviceId, user.id, user.display_name || '', chatJid ?? '');
}

/**
 * P2-11: the recipient chat of a gateway schedule, for system lines on
 * pause/resume/cancel from the Schedules page (no chat in that URL).
 * Returns null when the schedule has no ownership row or no known chat
 * (e.g. created before the chat_jid column existed).
 */
export function getScheduleChatJid(deviceId: string, scheduleId: string): string | null {
  if (!deviceId || !scheduleId) return null;
  const row = queryOne<{chat_jid: string}>(
    'SELECT chat_jid FROM schedule_ownership WHERE schedule_id = ? AND device_id = ?',
    scheduleId,
    deviceId,
  );
  const chatJid = (row?.chat_jid ?? '').trim();
  return chatJid || null;
}

export function deleteScheduleOwnership(scheduleId: string): void {
  if (!scheduleId) return;
  db.prepare('DELETE FROM schedule_ownership WHERE schedule_id = ?').run(scheduleId);
}

export function transferScheduleOwnership(
  deviceId: string,
  oldScheduleId: string,
  newScheduleId: string,
): void {
  if (!oldScheduleId || !newScheduleId || oldScheduleId === newScheduleId) return;
  const owner = getScheduleOwnership(deviceId, oldScheduleId);
  if (!owner) return;
  const chatJid = getScheduleChatJid(deviceId, oldScheduleId);
  deleteScheduleOwnership(oldScheduleId);
  db.prepare(
    `INSERT OR REPLACE INTO schedule_ownership
       (schedule_id, device_id, created_by_user_id, created_by_name, chat_jid, created_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`,
  ).run(newScheduleId, deviceId, owner.created_by_user_id, owner.created_by_name, chatJid ?? '');
}

export function canManageSchedule(
  user: RbacSubject,
  deviceId: string,
  scheduleId: string,
): boolean {
  // Supervisor/admin view (admin role or chats:view_all, as in chat-lifecycle).
  if (isAdminSubject(user) || hasPermission(user, 'chats', 'view_all')) return true;
  if (!scheduleId) return false;
  const owner = getScheduleOwnership(deviceId, scheduleId);
  if (!owner) return false;
  return owner.created_by_user_id === (user as {id?: number}).id;
}

/**
 * Annotate list items with `can_manage` for the requesting user. A user
 * without `schedules:manage` at all can never manage a row, even their own
 * (the route middleware enforces the permission first).
 */
export function annotateSchedulesWithCanManage<T extends {id: string}>(
  user: RbacSubject,
  deviceId: string,
  items: T[],
): Array<T & {can_manage: boolean}> {
  const hasManage = hasPermission(user, 'schedules', 'manage');
  if (!hasManage) {
    return items.map((item) => ({...item, can_manage: false}));
  }
  if (items.length === 0) return [];
  const rows = queryAll<{schedule_id: string; created_by_user_id: number}>(
    'SELECT schedule_id, created_by_user_id FROM schedule_ownership WHERE device_id = ?',
    deviceId,
  );
  const owners = new Map(rows.map((row) => [row.schedule_id, row.created_by_user_id]));
  const userId = (user as {id?: number}).id;
  const supervisor = isAdminSubject(user) || hasPermission(user, 'chats', 'view_all');
  return items.map((item) => ({
    ...item,
    can_manage: supervisor || owners.get(item.id) === userId,
  }));
}

/**
 * Extract the created schedule's id from a gateway `POST /send/message`
 * response (`results` payload, already unwrapped by gowaFetch).
 *
 * The gateway returns the schedule id as `schedule_id` (the official PHP SDK
 * exposes it as `scheduleId`; this repo's reschedule fallback already reads
 * `id` / `schedule_id`). `message_id` is deliberately NOT accepted: a
 * scheduled send has no WhatsApp message id yet, and a pre-generated
 * occurrence message id is not the schedule id.
 */
export function extractCreatedScheduleId(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const record = result as Record<string, unknown>;
  for (const key of ['schedule_id', 'scheduleId', 'id']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

export interface CreatedScheduleMatch {
  phone: string;
  message: string;
  scheduled_at: string;
}

/**
 * Find the just-created schedule by listing the device's schedules and
 * matching phone + scheduled_at + message text created within ~60s.
 * Returns the id only on exactly one unambiguous match; otherwise null.
 */
export async function findCreatedScheduleByListMatch(
  deviceId: string,
  created: CreatedScheduleMatch,
  nowMs = Date.now(),
): Promise<string | null> {
  const phoneDigits = digitsOf(created.phone);
  const scheduledMs = parseTimestampMs(created.scheduled_at);
  const message = created.message.trim();
  if (!phoneDigits || !scheduledMs || !message) return null;
  let list: {data?: Array<Record<string, unknown>>} | undefined;
  try {
    list = await gowaFetch<{data?: Array<Record<string, unknown>>}>('/send/schedules', {
      deviceId,
      query: {search: phoneDigits, limit: 100, offset: 0},
    });
  } catch {
    return null;
  }
  const candidates = (list?.data ?? []).filter((item) => {
    const recipient = String(item.recipient || '');
    if (digitsOf(recipient) !== phoneDigits && recipient !== created.phone) return false;
    const itemScheduledMs = parseTimestampMs(
      String(item.scheduled_at || item.next_run_at || ''),
    );
    if (itemScheduledMs !== scheduledMs) return false;
    if (String(item.content || '').trim() !== message) return false;
    const createdMs = parseTimestampMs(String(item.created_at || ''));
    if (!createdMs || createdMs > nowMs + 5_000) return false;
    if (nowMs - createdMs > LIST_MATCH_WINDOW_MS) return false;
    return true;
  });
  if (candidates.length !== 1) return null;
  const id = candidates[0]?.id;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

/**
 * Resolve the created schedule's id: prefer the create response, fall back to
 * unambiguous list matching. Returns null when it cannot be determined.
 */
export async function resolveCreatedScheduleId(
  deviceId: string,
  created: CreatedScheduleMatch,
  createResult: unknown,
  nowMs = Date.now(),
): Promise<string | null> {
  const fromResponse = extractCreatedScheduleId(createResult);
  if (fromResponse) return fromResponse;
  return findCreatedScheduleByListMatch(deviceId, created, nowMs);
}

/**
 * Record ownership for a just-created schedule. Never throws: if the id
 * cannot be determined reliably, nothing is recorded and the schedule stays
 * admin-only (fail closed). Creation itself must never fail because of this.
 */
export async function recordCreatedScheduleOwnership(
  deviceId: string,
  created: CreatedScheduleMatch,
  createResult: unknown,
  user: ScheduleCreator,
): Promise<string | null> {
  try {
    const scheduleId = await resolveCreatedScheduleId(deviceId, created, createResult);
    if (!scheduleId) return null;
    // P2-11: keep the recipient chat so later pause/resume/cancel can
    // record a system line in that chat's timeline.
    recordScheduleOwnership(deviceId, scheduleId, user, normalizeWhatsAppJid(created.phone));
    return scheduleId;
  } catch (err) {
    console.error('[schedule-ownership] failed to record ownership', err);
    return null;
  }
}

/**
 * Annotate a gateway schedule-list payload (`{data, pagination}` or a bare
 * array) with per-item `can_manage`, preserving the rest of the shape.
 */
export function annotateScheduleListResults(
  user: RbacSubject,
  deviceId: string,
  data: unknown,
): unknown {
  const annotateItems = (items: Array<Record<string, unknown>>) =>
    annotateSchedulesWithCanManage(
      user,
      deviceId,
      items.map((item) => ({...item, id: String(item.id || '')})),
    );
  if (Array.isArray(data)) {
    return annotateItems(data as Array<Record<string, unknown>>);
  }
  if (data && typeof data === 'object' && Array.isArray((data as {data?: unknown}).data)) {
    const record = data as {data: Array<Record<string, unknown>>};
    return {...record, data: annotateItems(record.data)};
  }
  return data;
}
