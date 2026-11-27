import {listEnabledDailyResets, resetAssignedChatsForDevice, type DailyResetResult} from '../db.ts';
import type {GowaWsBridge} from '../ws-bridge.ts';
import {resolveLocalDateAndHour} from '../../shared/daily-reset-time.ts';

export {
  getDailyResetSettings,
  resetAssignedChatsForDevice,
  updateDailyResetSettings,
  type DailyResetResult,
  type DailyResetSettings,
} from '../db.ts';
export {isValidIanaTimezone, resolveLocalDateAndHour} from '../../shared/daily-reset-time.ts';

const RESET_POLL_INTERVAL_MS = 60_000;
const STARTUP_CATCHUP_DELAY_MS = 5_000;

export interface DailyResetWsPayload {
  code: 'CHAT_DAILY_RESET';
  message: string;
  device_id: string;
  result: DailyResetResult;
}

export function buildDailyResetWsPayload(result: DailyResetResult): DailyResetWsPayload {
  return {
    code: 'CHAT_DAILY_RESET',
    message: result.trigger === 'manual' ? 'manual_reset' : 'daily_reset',
    device_id: result.device_id,
    result,
  };
}

export function runDailyChatResetTick(
  wsBridge?: GowaWsBridge,
  now = new Date(),
): DailyResetResult[] {
  const executed: DailyResetResult[] = [];
  for (const row of listEnabledDailyResets()) {
    const localNow = resolveLocalDateAndHour(now, row.timezone);
    if (localNow.hour < row.reset_hour) {
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
