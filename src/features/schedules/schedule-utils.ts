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
 * P2-4: parse a free-text date into a `datetime-local` value
 * ("2030-01-15T14:30"), or null when the text is not a recognisable date.
 *
 * Accepted shapes — year-first ISO shapes, and day-first shapes (the Egypt
 * convention) where the year comes last:
 * - `2030-01-15 14:30`, `2030-01-15T14:30`, `2030/01/15 09:00`
 * - `15/01/2030 14:30`, `15-01-2030 3:30 PM` (12-hour with AM/PM)
 * - date only (`2030-01-15`, `15/01/2030`) means 09:00 that day
 * - optional seconds (`14:30:45`) are dropped; Arabic-Indic digits are
 *   normalised.
 * A month/day/hour/minute that cannot exist (30 Feb, hour 25, `13:00 PM`)
 * rejects the whole text — `Date` rollover is never silently accepted.
 * The result is a local date-time, NOT checked for futureness here: callers
 * validate with `validateScheduleFutureMs`.
 */
export function parseFreeTextDateTimeLocal(input: string): string | null {
  const text = input
    .trim()
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0))
    .replace(/\s+/g, ' ');
  if (!text) return null;
  const timePart = '(?:[T ](\\d{1,2}):(\\d{2})(?::(\\d{2}))?\\s*([AP]M)?)?';
  const ymd = new RegExp(`^(\\d{4})[-/](\\d{1,2})[-/](\\d{1,2})${timePart}$`, 'i').exec(text);
  const dmy = !ymd
    ? new RegExp(`^(\\d{1,2})[-/](\\d{1,2})[-/](\\d{4})${timePart}$`, 'i').exec(text)
    : null;
  const match = ymd ?? dmy;
  if (!match) return null;
  const year = Number(ymd ? match[1] : match[3]);
  const month = Number(match[2]);
  const day = Number(ymd ? match[3] : match[1]);
  const ampm = match[7]?.toUpperCase();
  let hour = match[4] === undefined ? 9 : Number(match[4]);
  const minute = match[5] === undefined ? 0 : Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    if (ampm === 'PM' && hour !== 12) hour += 12;
    if (ampm === 'AM' && hour === 12) hour = 0;
  } else if (hour < 0 || hour > 23) {
    return null;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31 || minute > 59 || second > 59) {
    return null;
  }
  const date = new Date(year, month - 1, day, hour, minute);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute
  ) {
    return null;
  }
  return toLocalDateTimeInput(date);
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
  errorMessages: {
    pastTime: string;
    invalidEndAt: string;
    emptyTime?: string;
    recurrenceEndRequired: string;
  },
  nowMs = Date.now(),
): ValidatedSchedulePayloadFields {
  // Decision 5: no time default — an empty field is a missing time, not a
  // past time, so it gets its own message.
  if (!fields.scheduledAtLocal.trim()) {
    throw new ScheduleValidationError(errorMessages.emptyTime ?? errorMessages.pastTime);
  }

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

export type ScheduleDisplayFields = {
  content?: string;
  message?: string;
  summary?: string;
  caption?: string;
  filename?: string;
};

/**
 * P1-2: what a schedule row shows as its text. The gateway record carries
 * the text in `summary` (live shape: phone + summary — see
 * ScheduleService.scheduleView), older/mock shapes in `message`, and media
 * rows in `caption`/`filename`. Never show a blank preview when any of these
 * holds the text.
 */
export function getSchedulePreviewText(item: ScheduleDisplayFields): string {
  return item.content || item.message || item.summary || item.caption || item.filename || '—';
}

export type ScheduleRecipientFields = {
  recipient?: string;
  phone?: string;
  to?: string;
};

/** P1-2: the recipient, falling back through the gateway's `phone` field. */
export function getScheduleRecipient(item: ScheduleRecipientFields): string {
  return item.recipient || item.phone || item.to || '—';
}
