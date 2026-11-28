import {useState} from 'react';
import type {ScheduleRecurrence} from '@/api/types';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {
  applySchedulePreset,
  formatPresetDateTimeLocal,
  minScheduleDateTimeLocal,
  parseFreeTextDateTimeLocal,
  validateScheduleFutureMs,
  type SchedulePreset,
} from '@/features/schedules/schedule-utils';
import {useI18n} from '@/lib/i18n';
import {cn} from '@/lib/utils';

export function ScheduleRecurrenceFields({
  idPrefix,
  scheduledAtLocal,
  onScheduledAtChange,
  timezone,
  onTimezoneChange,
  recurrence,
  onRecurrenceChange,
  weekdays,
  onWeekdaysChange,
  dayOfMonth,
  onDayOfMonthChange,
  occurrenceLimit,
  onOccurrenceLimitChange,
  endAtLocal,
  onEndAtChange,
  onFreeTextErrorChange,
}: {
  idPrefix: string;
  scheduledAtLocal: string;
  onScheduledAtChange: (value: string) => void;
  timezone: string;
  onTimezoneChange: (value: string) => void;
  recurrence: ScheduleRecurrence;
  onRecurrenceChange: (value: ScheduleRecurrence) => void;
  weekdays: number[];
  onWeekdaysChange: (value: number[]) => void;
  dayOfMonth: string;
  onDayOfMonthChange: (value: string) => void;
  occurrenceLimit: string;
  onOccurrenceLimitChange: (value: string) => void;
  endAtLocal: string;
  onEndAtChange: (value: string) => void;
  // P2-4: reports the free-text field's validity to the parent form so a
  // pending invalid date blocks submitting (the picker alone cannot see
  // the unparsed text). Called with the error message while invalid, and
  // with null once the text is applied or cleared.
  onFreeTextErrorChange?: (error: string | null) => void;
}) {
  const {t} = useI18n();
  const minLocal = minScheduleDateTimeLocal();

  // P2-4: free-text date next to the picker — type or paste a full date
  // ("2030-01-15 14:30", "15/01/2030 14:30") and it fills the picker.
  const [freeText, setFreeText] = useState('');
  const [freeTextError, setFreeTextError] = useState<string | null>(null);

  // Resolves the current text: null when it parses to a future date (and
  // the picker was updated), otherwise the error message to show/report.
  const resolveFreeText = (raw: string): string | null => {
    const parsed = parseFreeTextDateTimeLocal(raw);
    if (!parsed) return t.scheduled.freeTextDateInvalid;
    try {
      validateScheduleFutureMs(parsed);
    } catch {
      return t.chats.schedulePastError;
    }
    onScheduledAtChange(parsed);
    return null;
  };

  const handleFreeTextChange = (value: string) => {
    setFreeText(value);
    if (!value.trim()) {
      setFreeTextError(null);
      onFreeTextErrorChange?.(null);
      return;
    }
    // Live-apply as soon as the text parses: a pasted full date fills the
    // picker immediately, so paste-then-submit works without a blur. While
    // the text does not parse yet (still typing, or invalid) no inline
    // error is shown — but the parent is told there is pending text so the
    // form cannot submit it as-is.
    const error = resolveFreeText(value);
    if (error === null) {
      setFreeTextError(null);
      onFreeTextErrorChange?.(null);
    } else if (parseFreeTextDateTimeLocal(value) !== null) {
      // Parses but is in the past: that error is final, show it now.
      setFreeTextError(error);
      onFreeTextErrorChange?.(error);
    } else {
      onFreeTextErrorChange?.(t.scheduled.freeTextDateInvalid);
    }
  };

  const commitFreeText = () => {
    if (!freeText.trim()) return;
    const error = resolveFreeText(freeText);
    if (error) {
      setFreeTextError(error);
      onFreeTextErrorChange?.(error);
      return;
    }
    // Applied: the picker now shows the date, the draft text goes away.
    setFreeText('');
    setFreeTextError(null);
    onFreeTextErrorChange?.(null);
  };

  const toggleWeekday = (dayIndex: number) => {
    onWeekdaysChange(
      weekdays.includes(dayIndex)
        ? weekdays.filter((d) => d !== dayIndex)
        : [...weekdays, dayIndex].sort(),
    );
  };

  const presets: ReadonlyArray<readonly [SchedulePreset, string]> = [
    ['5m', t.chats.schedulePreset5m],
    ['30m', t.chats.schedulePreset30m],
    ['1h', t.chats.schedulePreset1h],
    ['tomorrow', t.chats.schedulePresetTomorrow],
    ['monday', t.chats.schedulePresetMonday],
  ];

  return (
    <>
      <div className="space-y-2">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor={`${idPrefix}-at`}>{t.scheduled.scheduledAtLabel}</Label>
            <Input
              id={`${idPrefix}-at`}
              type="datetime-local"
              dir="ltr"
              min={minLocal}
              className="mt-1.5 tabular-nums"
              value={scheduledAtLocal}
              onChange={(e) => onScheduledAtChange(e.target.value)}
              required
            />
            {/* P2-4: free-text date beside the picker — type or paste a full
                date; it fills the picker above. A failed parse shows a
                validation error and blocks submitting (via
                onFreeTextErrorChange); the picker keeps its previous value. */}
            <Label htmlFor={`${idPrefix}-at-text`} className="mt-3 inline-block">
              {t.scheduled.freeTextDateLabel}
            </Label>
            <Input
              id={`${idPrefix}-at-text`}
              dir="ltr"
              className="mt-1.5 tabular-nums"
              value={freeText}
              onChange={(e) => handleFreeTextChange(e.target.value)}
              onBlur={commitFreeText}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitFreeText();
                }
              }}
              placeholder={t.scheduled.freeTextDatePlaceholder}
              aria-invalid={freeTextError !== null}
              aria-describedby={
                freeTextError ? `${idPrefix}-at-text-error` : `${idPrefix}-at-text-hint`
              }
            />
            <p id={`${idPrefix}-at-text-hint`} className="mt-1 text-xs text-muted-foreground">
              {t.scheduled.freeTextDateHint}
            </p>
            {freeTextError && (
              <p
                id={`${idPrefix}-at-text-error`}
                role="alert"
                className="mt-1 text-xs text-destructive"
              >
                {freeTextError}
              </p>
            )}
          </div>

          <div>
            <Label htmlFor={`${idPrefix}-tz`}>{t.scheduled.timezoneLabel}</Label>
            <Input
              id={`${idPrefix}-tz`}
              dir="ltr"
              className="mt-1.5"
              value={timezone}
              onChange={(e) => onTimezoneChange(e.target.value)}
            />
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {presets.map(([presetKey, label]) => {
            // P1-20: show the date the preset computes to, next to its label.
            const computed = formatPresetDateTimeLocal(applySchedulePreset(presetKey));
            return (
              <button
                key={presetKey}
                type="button"
                onClick={() => onScheduledAtChange(applySchedulePreset(presetKey))}
                className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-secondary/70 px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-secondary focus-visible:outline-2 focus-visible:outline-ring"
              >
                <span>{label}</span>
                <span className="text-muted-foreground tabular-nums">{computed}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <Label htmlFor={`${idPrefix}-rec`}>{t.scheduled.recurrenceLabel}</Label>
        <select
          id={`${idPrefix}-rec`}
          value={recurrence}
          onChange={(e) => onRecurrenceChange(e.target.value as ScheduleRecurrence)}
          className="mt-1.5 h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <option value="once">{t.scheduled.recurrenceOnce}</option>
          <option value="daily">{t.scheduled.recurrenceDaily}</option>
          <option value="weekly">{t.scheduled.recurrenceWeekly}</option>
          <option value="monthly">{t.scheduled.recurrenceMonthly}</option>
        </select>
      </div>

      {recurrence === 'weekly' && (
        <div>
          <Label>{t.scheduled.weekdaysLabel}</Label>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {t.scheduled.weekdaysShort.map((dayLabel, idx) => {
              const active = weekdays.includes(idx);
              return (
                <button
                  key={dayLabel}
                  type="button"
                  onClick={() => toggleWeekday(idx)}
                  className={cn(
                    'h-8 cursor-pointer rounded-lg border px-2.5 text-xs font-medium transition-colors',
                    active
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border bg-background text-muted-foreground hover:bg-muted',
                  )}
                >
                  {dayLabel}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {recurrence === 'monthly' && (
        <div>
          <Label htmlFor={`${idPrefix}-dom`}>{t.scheduled.dayOfMonthLabel}</Label>
          <Input
            id={`${idPrefix}-dom`}
            type="number"
            min={1}
            max={31}
            dir="ltr"
            className="mt-1.5 tabular-nums"
            value={dayOfMonth}
            onChange={(e) => onDayOfMonthChange(e.target.value)}
          />
        </div>
      )}

      {recurrence !== 'once' && (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor={`${idPrefix}-limit`}>{t.scheduled.occurrenceLimitLabel}</Label>
              <Input
                id={`${idPrefix}-limit`}
                type="number"
                min={1}
                dir="ltr"
                className="mt-1.5 tabular-nums"
                value={occurrenceLimit}
                onChange={(e) => onOccurrenceLimitChange(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor={`${idPrefix}-end`}>{t.scheduled.endAtLabel}</Label>
              <Input
                id={`${idPrefix}-end`}
                type="datetime-local"
                dir="ltr"
                min={scheduledAtLocal || minLocal}
                className="mt-1.5 tabular-nums"
                value={endAtLocal}
                onChange={(e) => onEndAtChange(e.target.value)}
              />
            </div>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">{t.scheduled.recurrenceEndHint}</p>
        </>
      )}
    </>
  );
}
