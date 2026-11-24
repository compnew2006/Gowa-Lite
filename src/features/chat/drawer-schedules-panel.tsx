import {useMemo, useState} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {
  Ban,
  CalendarClock,
  Check,
  FileText,
  Image as ImageIcon,
  Loader2,
  MessageSquare,
  Mic,
  Pause,
  Pencil,
  Play,
  Plus,
  Video,
} from 'lucide-react';
import {toast} from 'sonner';
import {
  actionUnifiedChatSchedule,
  listUnifiedChatSchedules,
  updateUnifiedChatSchedule,
} from '@/api/client';
import type {ScheduleStatus, ScheduledSend, UnifiedChat} from '@/api/types';
import {Button} from '@/components/ui/button';
import {
  minScheduleDateTimeLocal,
  statusToneClass,
  toLocalDateTimeInput,
  validateScheduleFutureMs,
} from '@/features/schedules/schedule-utils';
import {formatDate} from '@/lib/format';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';
import {cn} from '@/lib/utils';
import {hasUserPermission, useAuthStore} from '@/stores/auth';

function ScheduleTypeIcon({type}: {type: string}) {
  switch (type) {
    case 'image':
      return <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" />;
    case 'video':
      return <Video className="size-3.5 shrink-0 text-muted-foreground" />;
    case 'audio':
      return <Mic className="size-3.5 shrink-0 text-muted-foreground" />;
    case 'document':
      return <FileText className="size-3.5 shrink-0 text-muted-foreground" />;
    default:
      return <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />;
  }
}

function ScheduleItemCard({
  item,
  canEditTime,
  canManageStatus,
  statusLabels,
  recurrenceLabels,
  isBusy,
  isEditing,
  editingTime,
  minLocal,
  isConfirmingCancel,
  onStartEditing,
  onEditingTimeChange,
  onCancelEditing,
  onSaveTime,
  onAction,
  onToggleCancelConfirm,
}: {
  item: ScheduledSend;
  canEditTime: boolean;
  canManageStatus: boolean;
  statusLabels: Record<ScheduleStatus, string>;
  recurrenceLabels: Record<string, string>;
  isBusy: boolean;
  isEditing: boolean;
  editingTime: string;
  minLocal: string;
  isConfirmingCancel: boolean;
  onStartEditing: (item: ScheduledSend) => void;
  onEditingTimeChange: (value: string) => void;
  onCancelEditing: () => void;
  onSaveTime: (id: string) => void;
  onAction: (id: string, action: 'pause' | 'resume' | 'cancel') => void;
  onToggleCancelConfirm: (id: string) => void;
}) {
  const {lang, t} = useI18n();
  const nextRunRaw = item.next_run_at || item.scheduled_at;
  const canPause = item.status === 'active';
  const canResume = item.status === 'paused';
  const canModify = item.status === 'active' || item.status === 'paused';
  const previewText = item.content || item.caption || item.filename || '—';

  return (
    <article className="group px-4 py-3 transition-colors hover:bg-secondary/25">
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-secondary">
          <ScheduleTypeIcon type={item.message_type} />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
              <span className={cn('font-semibold', statusToneClass(item.status))}>
                {statusLabels[item.status] || item.status}
              </span>
              <span className="text-muted-foreground" aria-hidden="true">·</span>
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {nextRunRaw ? formatDate(nextRunRaw, lang) : '—'}
              </span>
              {item.recurrence && item.recurrence !== 'once' && (
                <>
                  <span className="text-muted-foreground" aria-hidden="true">·</span>
                  <span className="text-[11px] text-muted-foreground">
                    {recurrenceLabels[item.recurrence] || item.recurrence}
                  </span>
                </>
              )}
            </div>

            {canModify && !isEditing && (canEditTime || canManageStatus) && (
              <div
                className={cn(
                  'flex shrink-0 items-center gap-0.5 transition-opacity',
                  isConfirmingCancel
                    ? 'opacity-100'
                    : 'opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100',
                )}
              >
                {canEditTime && item.message_type === 'text' && (
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => onStartEditing(item)}
                    title={t.chats.editScheduleTime}
                    aria-label={t.chats.editScheduleTime}
                    className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40"
                  >
                    <Pencil className="size-3.5" />
                  </button>
                )}
                {canManageStatus && canPause && (
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => onAction(item.id, 'pause')}
                    title={t.scheduled.pause}
                    aria-label={t.scheduled.pause}
                    className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40"
                  >
                    <Pause className="size-3.5" />
                  </button>
                )}
                {canManageStatus && canResume && (
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => onAction(item.id, 'resume')}
                    title={t.scheduled.resume}
                    aria-label={t.scheduled.resume}
                    className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40"
                  >
                    <Play className="size-3.5" />
                  </button>
                )}
                {canManageStatus && (
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => onToggleCancelConfirm(item.id)}
                    title={t.scheduled.cancelSchedule}
                    aria-label={t.scheduled.cancelSchedule}
                    className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                  >
                    <Ban className="size-3.5" />
                  </button>
                )}
              </div>
            )}
          </div>

          <p className="mt-1 line-clamp-4 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-foreground/90">
            {previewText}
          </p>

          {item.last_error && (
            <p className="mt-1 text-[11px] text-destructive">{item.last_error}</p>
          )}

          {isEditing && (
            <div className="mt-2 space-y-2">
              <input
                type="datetime-local"
                dir="ltr"
                min={minLocal}
                value={editingTime}
                onChange={(e) => onEditingTimeChange(e.target.value)}
                className="h-8 w-full rounded-lg border border-input bg-background px-2.5 text-xs text-foreground tabular-nums focus-visible:outline-2 focus-visible:outline-ring"
              />
              <div className="flex justify-end gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={onCancelEditing}
                >
                  {t.cancel}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="h-7 px-2.5 text-xs"
                  disabled={isBusy || !editingTime}
                  onClick={() => onSaveTime(item.id)}
                >
                  <Check className="size-3.5" />
                  <span>{t.save}</span>
                </Button>
              </div>
            </div>
          )}

          {isConfirmingCancel && !isEditing && (
            <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-2.5 py-1.5">
              <span className="text-xs font-medium text-destructive">
                {t.chats.cancelScheduleInlineConfirm}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[11px]"
                  onClick={() => onToggleCancelConfirm(item.id)}
                >
                  {t.cancel}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  className="h-6 px-2 text-[11px]"
                  disabled={isBusy}
                  onClick={() => onAction(item.id, 'cancel')}
                >
                  {t.scheduled.confirmCancelBtn}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

export function ScheduledPanelBody({
  chat,
  onOpenCreateSchedule,
}: {
  chat: UnifiedChat;
  onOpenCreateSchedule: () => void;
}) {
  const {t} = useI18n();
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const canWriteSchedules = hasUserPermission(user, 'schedules:write');
  const canManageSchedules = hasUserPermission(user, 'schedules:manage');

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTime, setEditingTime] = useState('');
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null);

  const schedulesQuery = useQuery({
    queryKey: ['unified-chat-schedules', chat.device_id, chat.jid],
    queryFn: () => listUnifiedChatSchedules(chat.device_id, chat.jid),
  });

  const invalidateSchedules = () => {
    void queryClient.invalidateQueries({
      queryKey: ['unified-chat-schedules', chat.device_id, chat.jid],
    });
    void queryClient.invalidateQueries({queryKey: ['schedules', chat.device_id]});
  };

  const actionMutation = useMutation({
    mutationFn: ({id, action}: {id: string; action: 'pause' | 'resume' | 'cancel'}) =>
      actionUnifiedChatSchedule(chat.device_id, chat.jid, id, action),
    onSuccess: (_data, vars) => {
      if (vars.action === 'pause') toast.success(t.scheduled.pausedToast);
      else if (vars.action === 'resume') toast.success(t.scheduled.resumedToast);
      else {
        toast.success(t.scheduled.cancelledToast);
        setConfirmCancelId(null);
      }
      invalidateSchedules();
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const updateTimeMutation = useMutation({
    mutationFn: ({id, scheduledAt}: {id: string; scheduledAt: string}) =>
      updateUnifiedChatSchedule(chat.device_id, chat.jid, id, {scheduled_at: scheduledAt}),
    onSuccess: () => {
      toast.success(t.chats.scheduleUpdatedToast);
      setEditingId(null);
      setEditingTime('');
      invalidateSchedules();
    },
    onError: (err) => toast.error(toApiError(err).message),
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

  const items: ScheduledSend[] = schedulesQuery.data?.data ?? [];
  const minLocal = minScheduleDateTimeLocal();
  const isBusy = actionMutation.isPending || updateTimeMutation.isPending;

  const startEditing = (item: ScheduledSend) => {
    const rawDate = item.next_run_at || item.scheduled_at;
    const parsed = rawDate ? new Date(rawDate) : new Date(Date.now() + 5 * 60_000);
    setConfirmCancelId(null);
    setEditingId(item.id);
    setEditingTime(
      toLocalDateTimeInput(
        Number.isNaN(parsed.getTime()) ? new Date(Date.now() + 5 * 60_000) : parsed,
      ),
    );
  };

  const handleSaveTime = (id: string) => {
    try {
      const ms = validateScheduleFutureMs(editingTime);
      updateTimeMutation.mutate({id, scheduledAt: new Date(ms).toISOString()});
    } catch {
      toast.error(t.chats.schedulePastError);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {canWriteSchedules && (
        <div className="shrink-0 border-b border-border px-3 py-2.5">
          <Button
            type="button"
            size="sm"
            className="h-8 w-full text-xs"
            onClick={onOpenCreateSchedule}
          >
            <Plus className="size-3.5" />
            <span>{t.scheduled.newSchedule}</span>
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {schedulesQuery.isLoading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-xs text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            <span>{t.loading}</span>
          </div>
        ) : schedulesQuery.isError ? (
          <div className="p-4 text-center text-xs text-destructive">
            {toApiError(schedulesQuery.error).message}
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
            <div className="mb-3 flex size-11 items-center justify-center rounded-full bg-secondary text-muted-foreground">
              <CalendarClock className="size-5" />
            </div>
            <p className="text-sm font-medium text-foreground">{t.chats.noScheduledMessages}</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {t.chats.noScheduledMessagesHint}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border/70">
            {items.map((item) => (
              <ScheduleItemCard
                key={item.id}
                item={item}
                canEditTime={canWriteSchedules}
                canManageStatus={canManageSchedules}
                statusLabels={statusLabels}
                recurrenceLabels={recurrenceLabels}
                isBusy={isBusy}
                isEditing={editingId === item.id}
                editingTime={editingTime}
                minLocal={minLocal}
                isConfirmingCancel={confirmCancelId === item.id}
                onStartEditing={startEditing}
                onEditingTimeChange={setEditingTime}
                onCancelEditing={() => {
                  setEditingId(null);
                  setEditingTime('');
                }}
                onSaveTime={handleSaveTime}
                onAction={(id, action) => actionMutation.mutate({id, action})}
                onToggleCancelConfirm={(id) =>
                  setConfirmCancelId((prev) => (prev === id ? null : id))
                }
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
