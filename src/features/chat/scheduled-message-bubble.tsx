import {Ban, CalendarClock, Check, Pencil} from 'lucide-react';
import type {LanguagePreference, ScheduleStatus, ScheduledSend} from '@/api/types';
import {Button} from '@/components/ui/button';
import {ScheduleTypeIcon} from '@/features/chat/drawer-schedules-panel';
import {
  scheduledBubbleText,
  scheduledTimelineTimestamp,
} from '@/features/chat/scheduled-timeline';
import {statusToneClass} from '@/features/schedules/schedule-utils';
import {formatDate} from '@/lib/format';
import {useI18n} from '@/lib/i18n';
import {cn} from '@/lib/utils';

/**
 * "Scheduled" bubble in the chat timeline: the composer draft that was
 * scheduled, shown as an outgoing bubble until the gateway fires it and the
 * sent message arrives over WS. Same edit-time / cancel behaviour as the
 * schedules drawer (same PATCH + action routes, via useChatScheduleActions).
 */
export function ScheduledMessageBubble({
  item,
  lang,
  statusLabels,
  recurrenceLabels,
  canEditTime,
  canManageStatus,
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
  lang: LanguagePreference;
  statusLabels: Record<ScheduleStatus, string>;
  recurrenceLabels: Record<string, string>;
  canEditTime: boolean;
  canManageStatus: boolean;
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
  const {t} = useI18n();
  const nextRunRaw = scheduledTimelineTimestamp(item);
  const canModify = item.status === 'active' || item.status === 'paused';
  const previewText = scheduledBubbleText(item);

  return (
    <div
      data-testid="scheduled-message-bubble"
      data-schedule-id={item.id}
      className="max-w-[85%] rounded-2xl rounded-te-xs border border-border bg-bubble-out px-3 py-2 shadow-2xs sm:max-w-[75%]"
    >
      <div className="flex items-center gap-1.5 text-[11px]">
        <CalendarClock className="size-3.5 shrink-0 text-muted-foreground" />
        <span className={cn('font-semibold', statusToneClass(item.status))}>
          {statusLabels[item.status] || item.status}
        </span>
        <span className="text-muted-foreground" aria-hidden="true">
          ·
        </span>
        <span className="tabular-nums text-muted-foreground">
          {nextRunRaw ? formatDate(nextRunRaw, lang) : '—'}
        </span>
        {item.recurrence && item.recurrence !== 'once' && (
          <>
            <span className="text-muted-foreground" aria-hidden="true">
              ·
            </span>
            <span className="text-muted-foreground">
              {recurrenceLabels[item.recurrence] || item.recurrence}
            </span>
          </>
        )}
        {canModify && !isEditing && (canEditTime || canManageStatus) && (
          <span className="ms-auto flex shrink-0 items-center gap-0.5">
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
          </span>
        )}
      </div>

      <p className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-foreground/90">
        {previewText}
      </p>

      {item.filename && item.message_type !== 'text' && (
        <p className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <ScheduleTypeIcon type={item.message_type} />
          <span className="min-w-0 truncate">{item.filename}</span>
        </p>
      )}

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
  );
}
