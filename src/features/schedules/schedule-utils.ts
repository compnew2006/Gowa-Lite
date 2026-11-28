import type {ScheduleRecurrence, ScheduleStatus} from '@/api/types';

export type SchedulePreset = '5m' | '30m' | '1h' | 'tomorrow' | 'monday';

export class ScheduleValidationError extends Error {}

export function toLocalDateTimeInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function minScheduleDateTimeLocal(nowMs = Date.now()): string {
  return toLocalDateTimeInput(new Date(nowMs + 60_000));
}

/**
 * Short display form of a `datetime-local` value ("2026-11-28T09:00" ->
 * "28/11 09:00"), used to show the computed date beside each quick-preset
 * button (P1-20). Returns '' for values that do not parse.
 */
export function formatPresetDateTimeLocal(localDateTime: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(localDateTime.trim());
  if (!match) return '';
  return `${match[3]}/${match[2]} ${match[4]}:${match[5]}`;
}

export function defaultScheduleDateTimeLocal(minutesAhead = 15, nowMs = Date.now()): string {
  return toLocalDateTimeInput(new Date(nowMs + minutesAhead * 60_000));
}

export function applySchedulePreset(preset: SchedulePreset, nowMs = Date.now()): string {
  const d = new Date(nowMs);
  if (preset === '5m') {
    d.setMinutes(d.getMinutes() + 5);
  } else if (preset === '30m') {
    d.setMinutes(d.getMinutes() + 30);
  } else if (preset === '1h') {
    d.setHours(d.getHours() + 1);
  } else if (preset === 'tomorrow') {
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
  } else {
    const daysUntilMonday = (8 - d.getDay()) % 7 || 7;
    d.setDate(d.getDate() + daysUntilMonday);
    d.setHours(9, 0, 0, 0);
  }
  return toLocalDateTimeInput(d);
}

export function validateScheduleFutureMs(localDateTime: string, nowMs = Date.now()): number {
  const ms = new Date(localDateTime).getTime();
  if (!localDateTime || !Number.isFinite(ms) || ms <= nowMs + 60_000) {
    throw new ScheduleValidationError('PAST_SCHEDULE_TIME');
  }
  return ms;
}

export interface ScheduleFormFields {
  message: string;
  scheduledAtLocal: string;
  timezone: string;
  recurrence: ScheduleRecurrence;
  weekdays: number[];
  dayOfMonth: string;
  occurrenceLimit: string;
  endAtLocal: string;
}

export interface ValidatedSchedulePayloadFields {
  message: string;
  scheduled_at: string;
  timezone?: string;
  recurrence: ScheduleRecurrence;
  weekdays?: number[];
  day_of_month?: number;
  end_at?: string;
  occurrence_limit?: number;
}

export function validateAndBuildScheduleFields(
  fields: ScheduleFormFields,
  errorMessages: {pastTime: string; invalidEndAt: string; recurrenceEndRequired: string},
  nowMs = Date.now(),
): ValidatedSchedulePayloadFields {
  let scheduledMs: number;
  try {
    scheduledMs = validateScheduleFutureMs(fields.scheduledAtLocal, nowMs);
  } catch {
    throw new ScheduleValidationError(errorMessages.pastTime);
  }

  let isoEndAt: string | undefined;
  if (fields.endAtLocal.trim()) {
    const endMs = new Date(fields.endAtLocal).getTime();
    if (!Number.isFinite(endMs) || endMs <= scheduledMs) {
      throw new ScheduleValidationError(errorMessages.invalidEndAt);
    }
    isoEndAt = new Date(endMs).toISOString();
  }

  const limitNum = fields.occurrenceLimit.trim()
    ? Number(fields.occurrenceLimit.trim())
    : undefined;
  const domNum =
    fields.recurrence === 'monthly' && fields.dayOfMonth.trim()
      ? Number(fields.dayOfMonth.trim())
      : undefined;

  // P1-21 (decision 6): a recurrence must end — either an end date or an
  // occurrence limit is required. A limit that is not a positive integer
  // does not count. Existing open-ended recurrences are untouched (this
  // only validates new/edited forms); no default limit is imposed.
  const hasValidLimit = limitNum !== undefined && Number.isInteger(limitNum) && limitNum > 0;
  if (fields.recurrence !== 'once' && !isoEndAt && !hasValidLimit) {
    throw new ScheduleValidationError(errorMessages.recurrenceEndRequired);
  }

  return {
    message: fields.message.trim(),
    scheduled_at: new Date(scheduledMs).toISOString(),
    timezone: fields.timezone.trim() || undefined,
    recurrence: fields.recurrence,
    weekdays:
      fields.recurrence === 'weekly' && fields.weekdays.length > 0 ? fields.weekdays : undefined,
    day_of_month: domNum && Number.isInteger(domNum) ? domNum : undefined,
    end_at: isoEndAt,
    occurrence_limit: limitNum && limitNum > 0 ? limitNum : undefined,
  };
}

export function statusToneClass(status: ScheduleStatus): string {
  switch (status) {
    case 'active':
      return 'text-emerald-600 dark:text-emerald-400';
    case 'running':
      return 'text-sky-600 dark:text-sky-400';
    case 'paused':
      return 'text-amber-600 dark:text-amber-400';
    case 'failed':
      return 'text-destructive';
    case 'completed':
    case 'cancelled':
      return 'text-muted-foreground';
  }
}
