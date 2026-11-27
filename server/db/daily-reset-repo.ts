import {GowaError} from '../errors.ts';
import {isValidIanaTimezone, resolveLocalDateAndHour} from '../../shared/daily-reset-time.ts';
import {db, queryAll, queryOne, withImmediateTransaction} from './connection.ts';

const DEFAULT_RESET_HOUR = 2;

export interface DailyResetSettings {
  device_id: string;
  enabled: boolean;
  reset_hour: number;
  timezone: string;
  last_run_date: string;
  last_run_at: string | null;
  last_reset_count: number;
  updated_at: string | null;
}

export interface DailyResetResult {
  device_id: string;
  reset_count: number;
  chat_jids: string[];
  run_at: string;
  run_date: string;
  trigger: 'schedule' | 'manual';
}

interface DailyResetRow {
  device_id: string;
  enabled: number;
  reset_hour: number;
  timezone: string;
  last_run_date: string;
  last_run_at: string | null;
  last_reset_count: number;
  updated_at: string | null;
}

interface TargetAssignedChatRow {
  chat_jid: string;
  assigned_user_id: number;
  assigned_user_name: string | null;
}

const DAILY_RESET_COLUMNS = `device_id, enabled, reset_hour, timezone, last_run_date,
  last_run_at, last_reset_count, updated_at`;

function getDailyResetRow(deviceId: string): DailyResetRow | undefined {
  return queryOne<DailyResetRow>(
    `SELECT ${DAILY_RESET_COLUMNS} FROM device_daily_reset_settings WHERE device_id = ?`,
    deviceId,
  );
}

export function listEnabledDailyResets(): DailyResetSettings[] {
  return queryAll<DailyResetRow>(
    `SELECT ${DAILY_RESET_COLUMNS} FROM device_daily_reset_settings WHERE enabled = 1`,
  ).map(hydrateDailyResetRow);
}

function hydrateDailyResetRow(row: DailyResetRow): DailyResetSettings {
  return {
    device_id: row.device_id,
    enabled: Boolean(row.enabled),
    reset_hour: Number(row.reset_hour),
    timezone: row.timezone || '',
    last_run_date: row.last_run_date || '',
    last_run_at: row.last_run_at ?? null,
    last_reset_count: Number(row.last_reset_count) || 0,
    updated_at: row.updated_at ?? null,
  };
}

export function getDailyResetSettings(rawDeviceId: string): DailyResetSettings {
  const deviceId = rawDeviceId.trim();
  if (!deviceId) {
    throw new GowaError(400, 'VALIDATION_ERROR', 'معرّف الحساب مطلوب');
  }
  const row = getDailyResetRow(deviceId);

  if (!row) {
    return {
      device_id: deviceId,
      enabled: false,
      reset_hour: DEFAULT_RESET_HOUR,
      timezone: '',
      last_run_date: '',
      last_run_at: null,
      last_reset_count: 0,
      updated_at: null,
    };
  }
  return hydrateDailyResetRow(row);
}

export function updateDailyResetSettings(
  rawDeviceId: string,
  input: {enabled: boolean; reset_hour: number; timezone?: string},
  now = new Date(),
): DailyResetSettings {
  const deviceId = rawDeviceId.trim();
  if (!deviceId) {
    throw new GowaError(400, 'VALIDATION_ERROR', 'معرّف الحساب مطلوب');
  }
  if (!Number.isInteger(input.reset_hour) || input.reset_hour < 0 || input.reset_hour > 23) {
    throw new GowaError(400, 'VALIDATION_ERROR', 'ساعة إعادة التعيين يجب أن تكون بين 0 و 23');
  }
  const cleanTimezone = (input.timezone ?? '').trim();
  if (!isValidIanaTimezone(cleanTimezone)) {
    throw new GowaError(400, 'VALIDATION_ERROR', 'المنطقة الزمنية غير صالحة');
  }

  return withImmediateTransaction(() => {
    const existing = getDailyResetRow(deviceId);

    let nextLastRunDate = existing?.last_run_date ?? '';
    const scheduleChanged =
      !existing ||
      Boolean(existing.enabled) !== input.enabled ||
      Number(existing.reset_hour) !== input.reset_hour ||
      (existing.timezone || '') !== cleanTimezone;

    if (input.enabled && scheduleChanged) {
      const localNow = resolveLocalDateAndHour(now, cleanTimezone);
      if (localNow.hour > input.reset_hour) {
        // Configured hour already passed today; start cleanly tomorrow instead of unassigning active chats mid-day.
        nextLastRunDate = localNow.dateKey;
      } else if (localNow.hour < input.reset_hour && nextLastRunDate === localNow.dateKey) {
        // Admin moved the scheduled hour later in the same day; allow the upcoming hour to run.
        nextLastRunDate = '';
      }
    }

    const updatedAt = now.toISOString();
    db.prepare(
      `INSERT INTO device_daily_reset_settings (
         device_id, enabled, reset_hour, timezone,
         last_run_date, last_run_at, last_reset_count, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(device_id) DO UPDATE SET
         enabled = excluded.enabled,
         reset_hour = excluded.reset_hour,
         timezone = excluded.timezone,
         last_run_date = excluded.last_run_date,
         updated_at = excluded.updated_at`,
    ).run(
      deviceId,
      input.enabled ? 1 : 0,
      input.reset_hour,
      cleanTimezone,
      nextLastRunDate,
      existing?.last_run_at ?? null,
      existing?.last_reset_count ?? 0,
      updatedAt,
    );

    return getDailyResetSettings(deviceId);
  });
}

export function resetAssignedChatsForDevice(
  rawDeviceId: string,
  options?: {
    actorUserId?: number | null;
    actorName?: string;
    trigger?: 'schedule' | 'manual';
    now?: Date;
    requiredDateKey?: string;
  },
): DailyResetResult | null {
  const deviceId = rawDeviceId.trim();
  if (!deviceId) {
    throw new GowaError(400, 'VALIDATION_ERROR', 'معرّف الحساب مطلوب');
  }

  const now = options?.now ?? new Date();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const trigger = options?.trigger ?? 'manual';
  const actorUserId = options?.actorUserId ?? null;
  const actorName = (options?.actorName ?? '').trim() || 'System';

  return withImmediateTransaction(() => {
    const settingsRow = getDailyResetRow(deviceId);

    if (options?.requiredDateKey) {
      if (!settingsRow || !settingsRow.enabled || settingsRow.last_run_date === options.requiredDateKey) {
        return null;
      }
    }

    const targets = db
      .prepare(
        `SELECT ca.chat_jid, ca.assigned_user_id, u.display_name AS assigned_user_name
         FROM chat_assignments ca
         LEFT JOIN users u ON u.id = ca.assigned_user_id
         WHERE ca.device_id = ?
           AND ca.status = 'open'
           AND ca.assigned_user_id IS NOT NULL
           AND LOWER(ca.chat_jid) <> 'status@broadcast'
           AND LOWER(ca.chat_jid) NOT LIKE '%@newsletter'
           AND LOWER(ca.chat_jid) NOT LIKE '%@g.us'`,
      )
      .all(deviceId) as unknown as TargetAssignedChatRow[];

    const chatJids = targets.map((t) => t.chat_jid);
    if (targets.length > 0) {
      db.prepare(
        `UPDATE chat_assignments
         SET status = 'pending',
             assigned_user_id = NULL,
             assigned_at = NULL,
             claimed_at = NULL,
             closed_by_id = NULL,
             closed_at = NULL,
             close_reason = '',
             updated_at = ?
         WHERE device_id = ?
           AND status = 'open'
           AND assigned_user_id IS NOT NULL
           AND LOWER(chat_jid) <> 'status@broadcast'
           AND LOWER(chat_jid) NOT LIKE '%@newsletter'
           AND LOWER(chat_jid) NOT LIKE '%@g.us'`,
      ).run(nowMs, deviceId);

      const note =
        trigger === 'manual'
          ? 'إعادة تعيين جماعية للمحادثات المسندة'
          : 'إعادة تعيين يومية تلقائية حسب الجدول';

      const insertEvent = db.prepare(
        `INSERT INTO chat_lifecycle_events (
           device_id, chat_jid, event_type,
           actor_user_id, actor_name,
           target_user_id, target_name,
           note, created_at, created_at_ms
         ) VALUES (?, ?, 'released', ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const target of targets) {
        insertEvent.run(
          deviceId,
          target.chat_jid,
          actorUserId,
          actorName,
          target.assigned_user_id,
          target.assigned_user_name ?? '',
          note,
          nowIso,
          nowMs,
        );
      }
    }

    const runDate =
      options?.requiredDateKey ??
      resolveLocalDateAndHour(now, settingsRow?.timezone || '').dateKey;

    if (trigger === 'schedule') {
      db.prepare(
        `UPDATE device_daily_reset_settings
         SET last_run_date = ?,
             last_run_at = ?,
             last_reset_count = ?,
             updated_at = ?
         WHERE device_id = ?`,
      ).run(runDate, nowIso, targets.length, nowIso, deviceId);
    } else {
      db.prepare(
        `INSERT INTO device_daily_reset_settings (
           device_id, enabled, reset_hour, timezone,
           last_run_date, last_run_at, last_reset_count, updated_at
         ) VALUES (?, 0, ?, '', '', ?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET
           last_run_at = excluded.last_run_at,
           last_reset_count = excluded.last_reset_count,
           updated_at = excluded.updated_at`,
      ).run(deviceId, DEFAULT_RESET_HOUR, nowIso, targets.length, nowIso);
    }

    return {
      device_id: deviceId,
      reset_count: targets.length,
      chat_jids: chatJids,
      run_at: nowIso,
      run_date: runDate,
      trigger,
    };
  });
}
