import {useEffect, useMemo, useState, type FormEvent} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {Clock, Loader2, RotateCcw, Save} from 'lucide-react';
import {toast} from 'sonner';
import {
  getAccountDailyReset,
  runAccountDailyResetNow,
  saveAccountDailyReset,
} from '@/api/client';
import {Button} from '@/components/ui/button';
import {Label} from '@/components/ui/label';
import {Skeleton} from '@/components/ui/skeleton';
import {Switch} from '@/components/ui/switch';
import {formatDate} from '@/lib/format';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';

const COMMON_TIMEZONES = [
  'Asia/Riyadh',
  'Asia/Dubai',
  'Africa/Cairo',
  'Asia/Kuwait',
  'Asia/Qatar',
  'Asia/Bahrain',
  'Asia/Muscat',
  'Asia/Amman',
  'Asia/Baghdad',
  'Asia/Beirut',
  'Africa/Casablanca',
  'Europe/Istanbul',
  'Europe/London',
  'America/New_York',
  'UTC',
];

function formatHourOption(hour: number, lang: 'ar' | 'en'): string {
  const padded = String(hour).padStart(2, '0');
  const sampleDate = new Date(Date.UTC(2026, 0, 1, hour, 0, 0));
  const localized12 = new Intl.DateTimeFormat(lang === 'ar' ? 'ar-SA' : 'en-US', {
    timeZone: 'UTC',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(sampleDate);
  return `${padded}:00 — ${localized12}`;
}

export function AccountDailyResetPanel({
  deviceId,
  canWrite,
}: {
  deviceId: string;
  canWrite: boolean;
}) {
  const {lang, t} = useI18n();
  const copy = t.accounts.dailyReset;
  const queryClient = useQueryClient();
  const queryKey = ['account-daily-reset', deviceId] as const;

  const query = useQuery({
    queryKey,
    queryFn: () => getAccountDailyReset(deviceId),
    staleTime: 0,
  });

  const [enabled, setEnabled] = useState(false);
  const [resetHour, setResetHour] = useState(2);
  const [timezone, setTimezone] = useState('');
  const [confirmRunNow, setConfirmRunNow] = useState(false);

  useEffect(() => {
    if (!query.data) return;
    setEnabled(query.data.enabled);
    setResetHour(query.data.reset_hour);
    setTimezone(query.data.timezone);
  }, [query.data]);

  useEffect(() => {
    setConfirmRunNow(false);
  }, [deviceId]);

  const browserTimezone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    } catch {
      return '';
    }
  }, []);

  const timezoneOptions = useMemo(() => {
    const extra = new Set<string>(COMMON_TIMEZONES);
    if (browserTimezone) extra.add(browserTimezone);
    if (timezone) extra.add(timezone);
    return Array.from(extra);
  }, [browserTimezone, timezone]);

  const saveMutation = useMutation({
    mutationFn: () =>
      saveAccountDailyReset(deviceId, {
        enabled,
        reset_hour: resetHour,
        timezone,
      }),
    onSuccess: (saved) => {
      queryClient.setQueryData(queryKey, saved);
      toast.success(copy.savedToast);
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const runNowMutation = useMutation({
    mutationFn: () => runAccountDailyResetNow(deviceId),
    onSuccess: (res) => {
      setConfirmRunNow(false);
      toast.success(copy.runNowSuccess(res.reset_count));
      void queryClient.invalidateQueries({queryKey});
      void queryClient.invalidateQueries({queryKey: ['unified-chats']});
      void queryClient.invalidateQueries({queryKey: ['chat-lifecycle']});
      void queryClient.invalidateQueries({queryKey: ['assignable-agents']});
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const data = query.data;
  const isDirty = Boolean(
    data &&
      (data.enabled !== enabled ||
        data.reset_hour !== resetHour ||
        data.timezone !== timezone),
  );
  const numberFormatter = useMemo(() => new Intl.NumberFormat(lang), [lang]);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!canWrite || saveMutation.isPending) return;
    saveMutation.mutate();
  };

  return (
    <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Clock className="size-4" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">{copy.title}</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{copy.description}</p>
        </div>
      </div>

      {query.isPending ? (
        <Skeleton className="mt-4 h-40 w-full" />
      ) : !data ? (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <p role="alert" className="text-sm text-destructive">
            {copy.loadError}
          </p>
          <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
            {t.refresh}
          </Button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="mt-5 space-y-5">
          <div className="flex items-center justify-between gap-4 rounded-lg border border-border bg-background/60 px-4 py-3">
            <div className="min-w-0">
              <Label htmlFor="daily-reset-enabled" className="text-sm font-medium text-foreground">
                {copy.enable}
              </Label>
              <p className="mt-0.5 text-xs text-muted-foreground">{copy.enableDesc}</p>
            </div>
            <Switch
              id="daily-reset-enabled"
              checked={enabled}
              disabled={!canWrite || saveMutation.isPending}
              onCheckedChange={setEnabled}
              ariaLabel={copy.enable}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="daily-reset-hour">{copy.hourLabel}</Label>
              <select
                id="daily-reset-hour"
                value={resetHour}
                disabled={!canWrite || saveMutation.isPending}
                onChange={(e) => setResetHour(Number(e.target.value))}
                className="flex h-10 w-full rounded-lg border border-input bg-card px-3 py-2 text-sm text-foreground tabular-nums transition-colors focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50"
              >
                {Array.from({length: 24}, (_, hour) => (
                  <option key={hour} value={hour}>
                    {formatHourOption(hour, lang)}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-muted-foreground">{copy.hourHint}</p>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="daily-reset-timezone">{copy.timezoneLabel}</Label>
              <select
                id="daily-reset-timezone"
                dir="ltr"
                value={timezone}
                disabled={!canWrite || saveMutation.isPending}
                onChange={(e) => setTimezone(e.target.value)}
                className="flex h-10 w-full rounded-lg border border-input bg-card px-3 py-2 text-sm text-foreground transition-colors focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50"
              >
                <option value="">{copy.timezoneServerDefault}</option>
                {timezoneOptions.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz === browserTimezone ? copy.timezoneBrowserDetected(tz) : tz}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-muted-foreground">{copy.timezoneHint}</p>
            </div>
          </div>

          <dl className="grid grid-cols-2 gap-4 border-y border-border py-3">
            <div>
              <dt className="text-xs text-muted-foreground">{copy.lastRunLabel}</dt>
              <dd className="mt-1 text-sm font-medium text-foreground tabular-nums">
                {data.last_run_at ? formatDate(data.last_run_at, lang) : copy.neverRun}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{copy.lastResetCountLabel}</dt>
              <dd className="mt-1 text-sm font-semibold text-foreground tabular-nums">
                {data.last_run_at ? numberFormatter.format(data.last_reset_count) : '—'}
              </dd>
            </div>
          </dl>

          {canWrite && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={runNowMutation.isPending || confirmRunNow}
                  onClick={() => setConfirmRunNow(true)}
                >
                  <RotateCcw className="size-3.5" aria-hidden="true" />
                  <span>{copy.runNowButton}</span>
                </Button>

                <Button type="submit" size="sm" disabled={!isDirty || saveMutation.isPending}>
                  {saveMutation.isPending ? (
                    <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <Save className="size-3.5" aria-hidden="true" />
                  )}
                  <span>{copy.saveButton}</span>
                </Button>
              </div>

              {confirmRunNow && (
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3.5 py-2.5 text-xs">
                  <p className="min-w-0 flex-1 text-foreground">{copy.runNowConfirmPrompt}</p>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={runNowMutation.isPending}
                      onClick={() => setConfirmRunNow(false)}
                    >
                      {t.cancel}
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      disabled={runNowMutation.isPending}
                      onClick={() => runNowMutation.mutate()}
                    >
                      {runNowMutation.isPending && (
                        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                      )}
                      <span>{copy.runNowConfirmAction}</span>
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </form>
      )}
    </section>
  );
}
