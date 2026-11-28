import {useEffect, useState, type FormEvent} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {CalendarClock, Loader2} from 'lucide-react';
import {toast} from 'sonner';
import {createUnifiedChatSchedule, listDevices} from '@/api/client';
import type {ScheduleRecurrence, UnifiedChat} from '@/api/types';
import {Button} from '@/components/ui/button';
import {Dialog} from '@/components/ui/dialog';
import {Label} from '@/components/ui/label';
import {ScheduleRecurrenceFields} from '@/features/schedules/schedule-recurrence-fields';
import {
  ScheduleAccountLine,
  ScheduleConfirmationSummary,
} from '@/features/schedules/schedule-account-line';
import {
  ScheduleValidationError,
  defaultScheduleDateTimeLocal,
  validateAndBuildScheduleFields,
} from '@/features/schedules/schedule-utils';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';

export function ScheduleMessageDialog({
  open,
  onOpenChange,
  chat,
  initialMessage,
  onScheduled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  chat: UnifiedChat;
  initialMessage: string;
  onScheduled?: (submittedMessage: string) => void;
}) {
  const {lang, t} = useI18n();
  const queryClient = useQueryClient();

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
  const [scheduledAtLocal, setScheduledAtLocal] = useState(() =>
    defaultScheduleDateTimeLocal(5),
  );
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
    setScheduledAtLocal(defaultScheduleDateTimeLocal(5));
    setRecurrence('once');
    setWeekdays([]);
    setDayOfMonth('1');
    setOccurrenceLimit('');
    setEndAtLocal('');
  }, [open, initialMessage]);

  const createMutation = useMutation({
    mutationFn: () => {
      const payload = validateAndBuildScheduleFields(
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
      return createUnifiedChatSchedule(chat.device_id, chat.jid, payload);
    },
    onSuccess: () => {
      toast.success(t.scheduled.createdToast);
      onOpenChange(false);
      onScheduled?.(message.trim());
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
    if (!message.trim() || !scheduledAtLocal || createMutation.isPending) return;
    createMutation.mutate();
  };

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

        <div>
          <Label htmlFor="chat-sched-msg">{t.scheduled.messageLabel}</Label>
          <textarea
            id="chat-sched-msg"
            rows={3}
            required
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={t.scheduled.messagePlaceholder}
            className="mt-1.5 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
          />
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
            disabled={createMutation.isPending || !message.trim() || !scheduledAtLocal}
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
