import type {ScheduleRecurrence} from '@/api/types';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {
  applySchedulePreset,
  formatPresetDateTimeLocal,
  minScheduleDateTimeLocal,
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
}) {
  const {t} = useI18n();
  const minLocal = minScheduleDateTimeLocal();

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
