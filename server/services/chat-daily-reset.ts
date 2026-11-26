import {db} from '../db.ts';
import {GowaError} from '../errors.ts';
import type {GowaWsBridge} from '../ws-bridge.ts';

const DEFAULT_RESET_HOUR = 2;
const RESET_POLL_INTERVAL_MS = 60_000;
const STARTUP_CATCHUP_DELAY_MS = 5_000;

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

export interface DailyResetWsPayload {
  code: 'CHAT_DAILY_RESET';
  message: string;
  device_id: string;
  result: DailyResetResult;
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

export function isValidIanaTimezone(timezone: string): boolean {
  const clean = timezone.trim();
  if (!clean) return true;
  try {
    new Intl.DateTimeFormat('en-US', {timeZone: clean});
    return true;
  } catch {
    return false;
  }
}

export function resolveLocalDateAndHour(
  now: Date,
  timezone?: string,
): {dateKey: string; hour: number} {
  const tz = timezone?.trim() || undefined;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    formatter = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
    });
  }

  const parts = formatter.formatToParts(now);
  let year = '';
  let month = '';
  let day = '';
  let hourStr = '';
  for (const part of parts) {
    if (part.type === 'year') year = part.value;
    else if (part.type === 'month') month = part.value;
    else if (part.type === 'day') day = part.value;
    else if (part.type === 'hour') hourStr = part.value;
  }
  const parsedHour = Number.parseInt(hourStr, 10);
  const hour = Number.isFinite(parsedHour) ? Math.min(23, Math.max(0, parsedHour % 24)) : now.getHours();
  const dateKey =
    year && month && day
      ? `${year}-${month}-${day}`
      : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  return {dateKey, hour};
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
  const row = db
    .prepare('SELECT * FROM device_daily_reset_settings WHERE device_id = ?')
    .get(deviceId) as DailyResetRow | undefined;

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
    const existing = db
      .prepare('SELECT * FROM device_daily_reset_settings WHERE device_id = ?')
      .get(deviceId) as DailyResetRow | undefined;

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

    const saved = db
      .prepare('SELECT * FROM device_daily_reset_settings WHERE device_id = ?')
      .get(deviceId) as unknown as DailyResetRow;
    return hydrateDailyResetRow(saved);
  });
}

export function buildDailyResetWsPayload(result: DailyResetResult): DailyResetWsPayload {
  return {
    code: 'CHAT_DAILY_RESET',
    message: result.trigger === 'manual' ? 'manual_reset' : 'daily_reset',
    device_id: result.device_id,
    result,
  };
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
    const settingsRow = db
      .prepare('SELECT * FROM device_daily_reset_settings WHERE device_id = ?')
      .get(deviceId) as DailyResetRow | undefined;

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

export function runDailyChatResetTick(
  wsBridge?: GowaWsBridge,
  now = new Date(),
): DailyResetResult[] {
  const rows = db
    .prepare('SELECT * FROM device_daily_reset_settings WHERE enabled = 1')
    .all() as unknown as DailyResetRow[];

  const executed: DailyResetResult[] = [];
  for (const row of rows) {
    const localNow = resolveLocalDateAndHour(now, row.timezone);
    if (localNow.hour < Number(row.reset_hour)) {
      continue;
    }
    if (row.last_run_date === localNow.dateKey) {
      continue;
    }

    const result = resetAssignedChatsForDevice(row.device_id, {
      actorUserId: null,
      actorName: 'System',
      trigger: 'schedule',
      now,
      requiredDateKey: localNow.dateKey,
    });
    if (!result) continue;

    executed.push(result);
    if (result.reset_count > 0) {
      wsBridge?.broadcast(buildDailyResetWsPayload(result));
    }
  }
  return executed;
}

export function startDailyChatResetProcessor(
  wsBridge: GowaWsBridge,
  intervalMs = RESET_POLL_INTERVAL_MS,
): () => void {
  const safeTick = () => {
    try {
      runDailyChatResetTick(wsBridge, new Date());
    } catch (err) {
      console.error('[daily-reset] tick failed', err);
    }
  };

  const startupTimer = setTimeout(safeTick, STARTUP_CATCHUP_DELAY_MS);
  startupTimer.unref?.();

  const pollTimer = setInterval(safeTick, intervalMs);
  pollTimer.unref?.();

  return () => {
    clearTimeout(startupTimer);
    clearInterval(pollTimer);
  };
}
