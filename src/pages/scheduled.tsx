import {useMemo, useState} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {
  AlertCircle,
  Ban,
  CalendarClock,
  Pause,
  Play,
  Plus,
  Search,
} from 'lucide-react';
import {toast} from 'sonner';
import {actionSchedule, createSchedule, listSchedules} from '@/api/client';
import type {
  ScheduleRecurrence,
  ScheduleStatus,
  ScheduledSend,
} from '@/api/types';
import {DeviceSelectorBar, useActiveDevice} from '@/components/device-selector-bar';
import {Button} from '@/components/ui/button';
import {Dialog} from '@/components/ui/dialog';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {Skeleton} from '@/components/ui/skeleton';
import {ScheduleRecurrenceFields} from '@/features/schedules/schedule-recurrence-fields';
import {
  ScheduleAccountLine,
  ScheduleConfirmationSummary,
} from '@/features/schedules/schedule-account-line';
import {
  ScheduleValidationError,
  defaultScheduleDateTimeLocal,
  getSchedulePreviewText,
  getScheduleRecipient,
  statusToneClass,
  validateAndBuildScheduleFields,
} from '@/features/schedules/schedule-utils';
import {formatDate} from '@/lib/format';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';
import {normalizePhoneQueryForGowa, normalizeSearchInput} from '@/lib/phone';
import {cn} from '@/lib/utils';
import {hasUserPermission, useAuthStore} from '@/stores/auth';

const PAGE_SIZE = 25;

export default function ScheduledPage() {
  const {lang, t} = useI18n();
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const canWriteSchedules = hasUserPermission(user, 'schedules:write');
  const canManageSchedules = hasUserPermission(user, 'schedules:manage');
  const deviceState = useActiveDevice();
  const deviceId = deviceState.selectedDeviceId;

  const [statusFilter, setStatusFilter] = useState<'all' | ScheduleStatus>('all');
  const [messageTypeFilter, setMessageTypeFilter] = useState<string>('all');
  const [searchInput, setSearchInput] = useState('');
  const [offset, setOffset] = useState(0);

  const [createOpen, setCreateOpen] = useState(false);
  const [confirmCancelTarget, setConfirmCancelTarget] = useState<ScheduledSend | null>(null);

  const [phone, setPhone] = useState('');
  const [message, setMessage] = useState('');
  const [scheduledAtLocal, setScheduledAtLocal] = useState(() =>
    defaultScheduleDateTimeLocal(15),
  );
  const [timezone, setTimezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  );
  const [recurrence, setRecurrence] = useState<ScheduleRecurrence>('once');
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [dayOfMonth, setDayOfMonth] = useState<string>('1');
  const [occurrenceLimit, setOccurrenceLimit] = useState<string>('');
  const [endAtLocal, setEndAtLocal] = useState<string>('');

  const normalizedSearch = normalizePhoneQueryForGowa(searchInput);

  const schedulesQuery = useQuery({
    queryKey: ['schedules', deviceId, statusFilter, messageTypeFilter, normalizedSearch, offset],
    queryFn: () =>
      listSchedules(deviceId, {
        status: statusFilter,
        message_type: messageTypeFilter,
        search: normalizedSearch,
        limit: PAGE_SIZE,
        offset,
      }),
    enabled: Boolean(deviceId),
    retry: 1,
  });

  const actionMutation = useMutation({
    mutationFn: ({id, action}: {id: string; action: 'pause' | 'resume' | 'cancel'}) =>
      actionSchedule(deviceId, id, action),
    onSuccess: (_data, vars) => {
      if (vars.action === 'pause') toast.success(t.scheduled.pausedToast);
      else if (vars.action === 'resume') toast.success(t.scheduled.resumedToast);
      else {
        toast.success(t.scheduled.cancelledToast);
        setConfirmCancelTarget(null);
      }
      void queryClient.invalidateQueries({queryKey: ['schedules', deviceId]});
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const createMutation = useMutation({
    mutationFn: () => {
      const validated = validateAndBuildScheduleFields(
        {
          message,
          scheduledAtLocal,
          timezone,
          recurrence,
          weekdays,
          dayOfMonth,
          occurrenceLimit,
          endAtLocal,
        },
        {
          pastTime: t.chats.schedulePastError,
          invalidEndAt:
            lang === 'ar'
              ? 'تاريخ انتهاء التكرار يجب أن يكون بعد موعد البدء'
              : 'End date must be after scheduled send time',
          recurrenceEndRequired: t.scheduled.recurrenceEndRequired,
        },
      );
      return createSchedule(deviceId, {
        phone: normalizeSearchInput(phone) || phone.trim(),
        ...validated,
      });
    },
    onSuccess: () => {
      toast.success(t.scheduled.createdToast);
      setCreateOpen(false);
      setPhone('');
      setMessage('');
      setScheduledAtLocal(defaultScheduleDateTimeLocal(15));
      setRecurrence('once');
      setWeekdays([]);
      setOccurrenceLimit('');
      setEndAtLocal('');
      void queryClient.invalidateQueries({queryKey: ['schedules', deviceId]});
    },
    onError: (err) => {
      if (err instanceof ScheduleValidationError) {
        toast.error(err.message);
        return;
      }
      toast.error(toApiError(err).message);
    },
  });

  const statusLabels = useMemo<Record<ScheduleStatus, string>>(
    () => ({
      active: t.scheduled.statusActive,
      running: t.scheduled.statusRunning,
      paused: t.scheduled.statusPaused,
      completed: t.scheduled.statusCompleted,
      failed: t.scheduled.statusFailed,
      cancelled: t.scheduled.statusCancelled,
    }),
    [t],
  );

  const recurrenceLabels: Record<string, string> = {
    once: t.scheduled.recurrenceOnce,
    daily: t.scheduled.recurrenceDaily,
    weekly: t.scheduled.recurrenceWeekly,
    monthly: t.scheduled.recurrenceMonthly,
  };

  const rows = schedulesQuery.data?.data ?? [];
  const pagination = schedulesQuery.data?.pagination ?? {
    limit: PAGE_SIZE,
    offset,
    total: rows.length,
  };
  const total = pagination.total;
  const fromIdx = total === 0 ? 0 : offset + 1;
  const toIdx = Math.min(offset + rows.length, total);

  // Cancel-confirm details with safe fallbacks — never "undefined".
  // P1-2: same display fallbacks as the table rows.
  const cancelRecipient = confirmCancelTarget
    ? getScheduleRecipient(confirmCancelTarget)
    : '—';
  const cancelContent = confirmCancelTarget
    ? getSchedulePreviewText(confirmCancelTarget)
    : '—';
  const cancelWhenRaw = confirmCancelTarget
    ? confirmCancelTarget.next_run_at || confirmCancelTarget.scheduled_at
    : '';

  const statusFilters: Array<{key: 'all' | ScheduleStatus; label: string}> = [
    {key: 'all', label: t.scheduled.statusAll},
    {key: 'active', label: t.scheduled.statusActive},
    {key: 'running', label: t.scheduled.statusRunning},
    {key: 'paused', label: t.scheduled.statusPaused},
    {key: 'completed', label: t.scheduled.statusCompleted},
    {key: 'failed', label: t.scheduled.statusFailed},
    {key: 'cancelled', label: t.scheduled.statusCancelled},
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-foreground">{t.scheduled.pageTitle}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t.scheduled.pageSubtitle}</p>
        </div>
        {deviceId && canWriteSchedules && (
          <Button
            onClick={() => {
              setScheduledAtLocal(defaultScheduleDateTimeLocal(15));
              setCreateOpen(true);
            }}
          >
            <Plus className="size-4" />
            <span>{t.scheduled.newSchedule}</span>
          </Button>
        )}
      </div>

      <DeviceSelectorBar
        devices={deviceState.devices}
        selectedDevice={deviceState.selectedDevice}
        selectedDeviceId={deviceId}
        onSelectDevice={(id) => {
          setOffset(0);
          deviceState.setSelectedDeviceId(id);
        }}
        isLoading={deviceState.isLoading}
        isFetching={deviceState.isFetching}
        error={deviceState.error}
        onRefresh={() => {
          void deviceState.refetch();
          if (deviceId) void schedulesQuery.refetch();
        }}
      />

      {deviceId && (
        <>
          <div
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-3"
            data-testid="schedule-status-filters"
            // P1-22: active = waiting for its time, running = sending now.
            // Confirmed against the gateway worker (ClaimNextScheduledSend
            // flips a due active job to running while it is delivered).
            title={t.scheduled.statusFilterHint}
          >
            <div className="flex flex-wrap items-center gap-1.5">
              {statusFilters.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => {
                    setStatusFilter(item.key);
                    setOffset(0);
                  }}
                  title={
                    item.key === 'active'
                      ? t.scheduled.statusActiveHint
                      : item.key === 'running'
                        ? t.scheduled.statusRunningHint
                        : undefined
                  }
                  className={cn(
                    'h-8 shrink-0 cursor-pointer whitespace-nowrap rounded-lg px-2.5 text-xs font-medium transition-colors',
                    statusFilter === item.key
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  {item.label}
                </button>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={searchInput}
                  onChange={(e) => {
                    setSearchInput(e.target.value);
                    setOffset(0);
                  }}
                  placeholder={t.scheduled.searchPlaceholder}
                  className="h-9 w-56 ps-8 text-xs"
                />
              </div>

              <select
                value={messageTypeFilter}
                onChange={(e) => {
                  setMessageTypeFilter(e.target.value);
                  setOffset(0);
                }}
                aria-label={t.scheduled.colType}
                className="h-9 rounded-lg border border-input bg-background px-2.5 text-xs text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              >
                <option value="all">{t.scheduled.typeAll}</option>
                <option value="text">{t.scheduled.typeText}</option>
                <option value="image">{t.scheduled.typeImage}</option>
                <option value="video">{t.scheduled.typeVideo}</option>
                <option value="document">{t.scheduled.typeDocument}</option>
                <option value="audio">{t.scheduled.typeAudio}</option>
              </select>
            </div>
          </div>

          {schedulesQuery.isLoading ? (
            <div className="space-y-2 rounded-xl border border-border bg-card p-4">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : schedulesQuery.error ? (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
              <div className="flex items-center gap-2">
                <AlertCircle className="size-4 shrink-0" />
                <span>{toApiError(schedulesQuery.error).message}</span>
              </div>
              <Button variant="outline" size="sm" onClick={() => void schedulesQuery.refetch()}>
                {t.retry}
              </Button>
            </div>
          ) : rows.length === 0 ? (
            <div className="rounded-xl border border-border bg-card p-10 text-center">
              <CalendarClock className="mx-auto size-8 text-muted-foreground" />
              <p className="mt-2 text-sm text-muted-foreground">{t.scheduled.empty}</p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-border bg-card">
              <div className="overflow-x-auto">
                <table className="w-full text-start text-sm">
                  <thead className="border-b border-border bg-muted/40 text-xs text-muted-foreground">
                    <tr>
                      <th className="px-4 py-3 font-medium">{t.scheduled.colRecipient}</th>
                      <th className="px-4 py-3 font-medium">{t.scheduled.colType}</th>
                      <th className="px-4 py-3 font-medium">{t.scheduled.colContent}</th>
                      <th className="px-4 py-3 font-medium">{t.scheduled.colRecurrence}</th>
                      <th className="px-4 py-3 font-medium">{t.scheduled.colNextRun}</th>
                      <th className="px-4 py-3 font-medium">{t.scheduled.colProgress}</th>
                      <th className="px-4 py-3 font-medium">{t.scheduled.colStatus}</th>
                      <th className="px-4 py-3 text-end font-medium">{t.scheduled.colActions}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {rows.map((item) => {
                      const canPause = item.status === 'active';
                      const canResume = item.status === 'paused';
                      const canCancel = item.status === 'active' || item.status === 'paused';
                      const nextRunRaw = item.next_run_at || item.scheduled_at;
                      // P1-2: content reads content/message/summary/caption/
                      // filename; recipient falls back through phone/to.
                      const previewText = getSchedulePreviewText(item);
                      // Per-row ownership gate: the server annotates each item
                      // with can_manage (owner or supervisor). Fall back to
                      // the list-wide permission only when unannotated.
                      const canManageRow = item.can_manage ?? canManageSchedules;
                      const manageDisabledTitle = !canManageSchedules
                        ? t.scheduled.manageRequiresSupervisor
                        : !canManageRow
                          ? t.scheduled.createdByAnotherAgent
                          : undefined;

                      return (
                        <tr key={item.id} className="hover:bg-muted/20">
                          <td className="px-4 py-3 font-mono text-xs text-foreground" dir="ltr">
                            {getScheduleRecipient(item)}
                          </td>
                          <td className="px-4 py-3 text-xs text-muted-foreground">
                            {item.message_type}
                          </td>
                          <td className="max-w-xs px-4 py-3">
                            <p className="truncate text-xs text-foreground" title={previewText}>
                              {previewText}
                            </p>
                            {item.last_error && (
                              <p
                                className="mt-0.5 truncate text-[11px] text-destructive"
                                title={item.last_error}
                              >
                                {item.last_error}
                              </p>
                            )}
                          </td>
                          <td className="px-4 py-3 text-xs whitespace-nowrap text-muted-foreground">
                            {recurrenceLabels[item.recurrence] || item.recurrence}
                          </td>
                          <td className="px-4 py-3 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                            {nextRunRaw ? formatDate(nextRunRaw, lang) : '—'}
                          </td>
                          <td className="px-4 py-3 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                            {item.occurrence_limit
                              ? `${item.occurrence_count}/${item.occurrence_limit}`
                              : item.occurrence_count}
                          </td>
                          <td className="px-4 py-3 text-xs font-medium whitespace-nowrap">
                            <span className={statusToneClass(item.status)}>
                              {statusLabels[item.status] || item.status}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-end">
                            <div className="inline-flex items-center justify-end gap-1.5">
                              {canPause && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={!canManageRow || actionMutation.isPending}
                                  onClick={() =>
                                    actionMutation.mutate({id: item.id, action: 'pause'})
                                  }
                                  title={manageDisabledTitle ?? t.scheduled.pause}
                                >
                                  <Pause className="size-3.5" />
                                  <span>{t.scheduled.pause}</span>
                                </Button>
                              )}
                              {canResume && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={!canManageRow || actionMutation.isPending}
                                  onClick={() =>
                                    actionMutation.mutate({id: item.id, action: 'resume'})
                                  }
                                  title={manageDisabledTitle ?? t.scheduled.resume}
                                >
                                  <Play className="size-3.5" />
                                  <span>{t.scheduled.resume}</span>
                                </Button>
                              )}
                              {canCancel && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                                  disabled={!canManageRow || actionMutation.isPending}
                                  onClick={() => setConfirmCancelTarget(item)}
                                  title={manageDisabledTitle ?? t.scheduled.cancelSchedule}
                                >
                                  <Ban className="size-3.5" />
                                  <span>{t.scheduled.cancelSchedule}</span>
                                </Button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {total > PAGE_SIZE && (
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3 text-xs text-muted-foreground">
                  <span className="tabular-nums">
                    {t.scheduled.paginationInfo(fromIdx, toIdx, total)}
                  </span>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={offset === 0}
                      onClick={() => setOffset((prev) => Math.max(prev - PAGE_SIZE, 0))}
                    >
                      {t.scheduled.prevPage}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={offset + PAGE_SIZE >= total}
                      onClick={() => setOffset((prev) => prev + PAGE_SIZE)}
                    >
                      {t.scheduled.nextPage}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Create Scheduled Message Dialog */}
      <Dialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title={t.scheduled.createTitle}
        description={t.scheduled.createDesc}
        className="max-w-lg max-h-[90vh] overflow-y-auto"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            createMutation.mutate();
          }}
          className="space-y-4"
        >
          <ScheduleAccountLine device={deviceState.selectedDevice} />

          <div>
            <Label htmlFor="sched-phone">{t.scheduled.recipientLabel}</Label>
            <Input
              id="sched-phone"
              dir="ltr"
              className="mt-1.5"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder={t.scheduled.recipientPlaceholder}
              required
            />
          </div>

          <div>
            <Label htmlFor="sched-message">{t.scheduled.messageLabel}</Label>
            <textarea
              id="sched-message"
              rows={3}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={t.scheduled.messagePlaceholder}
              required
              className="mt-1.5 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
            />
          </div>

          <ScheduleRecurrenceFields
            idPrefix="sched"
            scheduledAtLocal={scheduledAtLocal}
            onScheduledAtChange={setScheduledAtLocal}
            timezone={timezone}
            onTimezoneChange={setTimezone}
            recurrence={recurrence}
            onRecurrenceChange={setRecurrence}
            weekdays={weekdays}
            onWeekdaysChange={setWeekdays}
            dayOfMonth={dayOfMonth}
            onDayOfMonthChange={setDayOfMonth}
            occurrenceLimit={occurrenceLimit}
            onOccurrenceLimitChange={setOccurrenceLimit}
            endAtLocal={endAtLocal}
            onEndAtChange={setEndAtLocal}
          />

          <ScheduleConfirmationSummary
            recipient={phone}
            device={deviceState.selectedDevice}
            scheduledAtLocal={scheduledAtLocal}
            timezone={timezone}
          />

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
              {t.cancel}
            </Button>
            <Button type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending ? t.loading : t.scheduled.createSubmit}
            </Button>
          </div>
        </form>
      </Dialog>

      {/* Cancel Confirm Dialog */}
      <Dialog
        open={Boolean(confirmCancelTarget)}
        onOpenChange={(open) => {
          if (!open) setConfirmCancelTarget(null);
        }}
        title={t.scheduled.cancelConfirmTitle}
        description={confirmCancelTarget ? t.scheduled.cancelConfirmDesc(cancelRecipient) : ''}
      >
        {confirmCancelTarget && (
          <dl className="space-y-1.5 rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-xs">
            <div className="flex items-start gap-2">
              <dt className="shrink-0 font-medium text-muted-foreground">
                {t.scheduled.recipientLabel}
              </dt>
              <dd className="min-w-0 break-words font-mono text-foreground" dir="ltr">
                {cancelRecipient}
              </dd>
            </div>
            <div className="flex items-start gap-2">
              <dt className="shrink-0 font-medium text-muted-foreground">
                {t.scheduled.scheduledAtLabel}
              </dt>
              <dd className="min-w-0 text-foreground tabular-nums">
                {cancelWhenRaw ? formatDate(cancelWhenRaw, lang) : '—'}
              </dd>
            </div>
            <div className="flex items-start gap-2">
              <dt className="shrink-0 font-medium text-muted-foreground">
                {t.scheduled.messageLabel}
              </dt>
              <dd className="min-w-0 break-words text-foreground">{cancelContent}</dd>
            </div>
          </dl>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={() => setConfirmCancelTarget(null)}>
            {t.cancel}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={actionMutation.isPending || !confirmCancelTarget}
            onClick={() => {
              if (!confirmCancelTarget) return;
              actionMutation.mutate({id: confirmCancelTarget.id, action: 'cancel'});
            }}
          >
            {t.scheduled.confirmCancelBtn}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
