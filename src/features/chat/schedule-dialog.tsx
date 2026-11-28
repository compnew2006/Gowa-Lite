import {useEffect, useState, type FormEvent} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {useNavigate} from 'react-router-dom';
import {CalendarClock, Loader2, Paperclip} from 'lucide-react';
import {toast} from 'sonner';
import {
  createUnifiedChatSchedule,
  createUnifiedChatScheduleWithMedia,
  listDevices,
} from '@/api/client';
import type {ScheduleRecurrence, UnifiedChat} from '@/api/types';
import {Button} from '@/components/ui/button';
import {Dialog} from '@/components/ui/dialog';
import {ScheduleRecurrenceFields} from '@/features/schedules/schedule-recurrence-fields';
import {
  ScheduleAccountLine,
  ScheduleConfirmationSummary,
} from '@/features/schedules/schedule-account-line';
import {
  ScheduleValidationError,
  validateAndBuildScheduleFields,
} from '@/features/schedules/schedule-utils';
import {buildScheduledDeepLink} from '@/features/schedules/scheduled-link';
import {toApiError} from '@/lib/http';
import {toastWithView} from '@/lib/toast-with-view';
import {useI18n} from '@/lib/i18n';

/**
 * Schedule the message written in the composer itself (P1-23 + P1-3).
 * The dialog receives the composer draft — text plus an attached file, if
 * any — and shows it read-only: there is no separate message field here.
 * Decision 5: no time default — the field starts empty and a future time
 * is required. Media is scheduled through the gateway's media endpoints,
 * which accept the same schedule fields (verified in gateway 9.10.0).
 */
export function ScheduleMessageDialog({
  open,
  onOpenChange,
  chat,
  initialMessage,
  initialAttachment = null,
  onScheduled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  chat: UnifiedChat;
  initialMessage: string;
  initialAttachment?: File | null;
  onScheduled?: (submittedMessage: string, hadAttachment?: boolean) => void;
}) {
  const {lang, t} = useI18n();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  // The sending account is the open chat's device. Look it up by exact id in
  // the shared devices list (same query key the device selector bar uses);
  // never fall back to another device — a wrong account here would send the
  // message from an account the operator did not intend.
  const devicesQuery = useQuery({
    queryKey: ['devices'],
    queryFn: listDevices,
    retry: 1,
  });
  const accountDevice =
    (devicesQuery.data ?? []).find((d) => d.id === chat.device_id) ?? null;

  const [message, setMessage] = useState('');
  const [attachment, setAttachment] = useState<File | null>(null);
  const [scheduledAtLocal, setScheduledAtLocal] = useState('');
  const [timezone, setTimezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  );
  const [recurrence, setRecurrence] = useState<ScheduleRecurrence>('once');
  const [weekdays, setWeekdays] = useState<number[]>([]);
  const [dayOfMonth, setDayOfMonth] = useState('1');
  const [occurrenceLimit, setOccurrenceLimit] = useState('');
  const [endAtLocal, setEndAtLocal] = useState('');

  useEffect(() => {
    if (!open) return;
    setMessage(initialMessage);
    setAttachment(initialAttachment);
    setScheduledAtLocal('');
    setRecurrence('once');
    setWeekdays([]);
    setDayOfMonth('1');
    setOccurrenceLimit('');
    setEndAtLocal('');
  }, [open, initialMessage, initialAttachment]);

  const createMutation = useMutation({
    mutationFn: () => {
      const fields = validateAndBuildScheduleFields(
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
          emptyTime: t.chats.scheduleTimeRequired,
          invalidEndAt:
            lang === 'ar'
              ? 'تاريخ انتهاء التكرار يجب أن يكون بعد موعد البدء'
              : 'End date must be after scheduled send time',
          recurrenceEndRequired: t.scheduled.recurrenceEndRequired,
        },
      );
      if (attachment) {
        const form = new FormData();
        form.append('file', attachment, attachment.name || 'attachment');
        form.append('message', fields.message);
        form.append('scheduled_at', fields.scheduled_at);
        if (fields.timezone) form.append('timezone', fields.timezone);
        form.append('recurrence', fields.recurrence);
        if (fields.weekdays) form.append('weekdays', JSON.stringify(fields.weekdays));
        if (fields.day_of_month !== undefined) {
          form.append('day_of_month', String(fields.day_of_month));
        }
        if (fields.end_at) form.append('end_at', fields.end_at);
        if (fields.occurrence_limit !== undefined) {
          form.append('occurrence_limit', String(fields.occurrence_limit));
        }
        return createUnifiedChatScheduleWithMedia(chat.device_id, chat.jid, form);
      }
      return createUnifiedChatSchedule(chat.device_id, chat.jid, fields);
    },
    onSuccess: () => {
      // P1-15 (decision 20): the toast carries a «view» action that navigates
      // to /scheduled, deep-linked on this chat's phone where one exists.
      toastWithView(t.scheduled.createdToast, {
        label: t.scheduled.viewAction,
        to: buildScheduledDeepLink(chat.jid),
        navigate,
      });
      onOpenChange(false);
      onScheduled?.(message.trim(), Boolean(attachment));
      void queryClient.invalidateQueries({
        queryKey: ['unified-chat-schedules', chat.device_id, chat.jid],
      });
      void queryClient.invalidateQueries({queryKey: ['schedules', chat.device_id]});
    },
    onError: (err) => {
      if (err instanceof ScheduleValidationError) {
        toast.error(err.message);
        return;
      }
      toast.error(toApiError(err).message);
    },
  });

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if ((!message.trim() && !attachment) || !scheduledAtLocal || createMutation.isPending) {
      return;
    }
    createMutation.mutate();
  };

  const hasDraft = Boolean(message.trim() || attachment);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t.chats.scheduleMessageTitle}
      description={t.chats.scheduleMessageDesc}
      className="max-w-lg max-h-[90vh] overflow-y-auto"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <ScheduleAccountLine device={accountDevice} />

        <div
          data-testid="schedule-draft-preview"
          className="rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-sm"
        >
          <p className="font-medium text-foreground">{t.chats.scheduleDraftLabel}</p>
          {message.trim() ? (
            <p className="mt-1 whitespace-pre-wrap break-words leading-relaxed text-foreground/90">
              {message}
            </p>
          ) : null}
          {attachment ? (
            <p
              data-testid="schedule-attachment-preview"
              className="mt-1.5 flex items-center gap-1.5 text-muted-foreground"
            >
              <Paperclip className="size-3.5 shrink-0" />
              <span className="min-w-0 truncate" dir="ltr">
                {attachment.name}
              </span>
              <span className="shrink-0 text-xs">({t.chats.scheduleAttachmentLabel})</span>
            </p>
          ) : null}
          {!hasDraft ? (
            <p
              data-testid="schedule-empty-draft-hint"
              className="mt-1 text-muted-foreground"
            >
              {t.chats.scheduleEmptyDraftHint}
            </p>
          ) : null}
        </div>

        <ScheduleRecurrenceFields
          idPrefix="chat-sched"
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
          recipient={chat.name || chat.jid}
          device={accountDevice}
          scheduledAtLocal={scheduledAtLocal}
          timezone={timezone}
        />

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t.cancel}
          </Button>
          <Button
            type="submit"
            disabled={createMutation.isPending || !hasDraft || !scheduledAtLocal}
          >
            {createMutation.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <CalendarClock className="size-4" />
            )}
            <span>{t.chats.scheduleSend}</span>
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
