import {useEffect, useState, type FormEvent} from 'react';
import {Loader2} from 'lucide-react';
import type {ScheduledSend} from '@/api/types';
import {Button} from '@/components/ui/button';
import {Dialog} from '@/components/ui/dialog';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {
  getScheduleRecipient,
  minScheduleDateTimeLocal,
  toLocalDateTimeInput,
  validateScheduleFutureMs,
} from '@/features/schedules/schedule-utils';
import {useI18n} from '@/lib/i18n';

/**
 * P2-9: edit a schedule from the Scheduled page.
 *
 * Time is always editable (active/paused rows the caller offers it for).
 * Text is editable only for text schedules: the server recreates the
 * schedule with the new text and cancels the old one, and that recreate
 * path only supports text (media rows are time-only here, with a note).
 * The dialog sends `message` only when the text actually changed, so an
 * untouched text keeps the PATCH-first path server-side; a changed text
 * forces the recreate path, where the new text is provably applied.
 */
export function ScheduleEditDialog({
  open,
  onOpenChange,
  item,
  isSaving,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: ScheduledSend;
  isSaving: boolean;
  onSave: (payload: {scheduled_at: string; message?: string}) => Promise<void>;
}) {
  const {t} = useI18n();
  const isText = item.message_type === 'text';
  const initialTime = toLocalDateTimeInput(
    new Date(item.next_run_at || item.scheduled_at),
  );
  const initialMessage = isText ? item.content || item.message || '' : '';
  const [timeLocal, setTimeLocal] = useState(initialTime);
  const [message, setMessage] = useState(initialMessage);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setTimeLocal(toLocalDateTimeInput(new Date(item.next_run_at || item.scheduled_at)));
    setMessage(isText ? item.content || item.message || '' : '');
    setError('');
    // Reset only when the dialog opens for (a different) row.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item.id]);

  const timeChanged = timeLocal !== initialTime;
  const messageChanged = isText && message !== initialMessage;
  const isDirty = timeChanged || messageChanged;
  const messageEmpty = isText && message.trim() === '';

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (isSaving || !isDirty || messageEmpty) return;
    let scheduledMs: number;
    try {
      scheduledMs = validateScheduleFutureMs(timeLocal);
    } catch {
      setError(t.chats.schedulePastError);
      return;
    }
    setError('');
    await onSave({
      scheduled_at: new Date(scheduledMs).toISOString(),
      ...(messageChanged ? {message: message.trim()} : {}),
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isSaving) onOpenChange(nextOpen);
      }}
      title={t.scheduled.editTitle}
      description={t.scheduled.editDesc(getScheduleRecipient(item))}
      className="max-w-lg"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <Label htmlFor="sched-edit-time">{t.scheduled.editTimeLabel}</Label>
          <Input
            id="sched-edit-time"
            type="datetime-local"
            dir="ltr"
            min={minScheduleDateTimeLocal()}
            className="mt-1.5 tabular-nums"
            value={timeLocal}
            onChange={(e) => setTimeLocal(e.target.value)}
            required
          />
        </div>

        {isText ? (
          <div>
            <Label htmlFor="sched-edit-message">{t.scheduled.editMessageLabel}</Label>
            <textarea
              id="sched-edit-message"
              rows={3}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              className="mt-1.5 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
            />
            <p className="mt-1 text-xs text-muted-foreground">{t.scheduled.editMessageHint}</p>
          </div>
        ) : (
          <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            {t.scheduled.editTimeOnlyNote}
          </p>
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}

        <div className="flex justify-end gap-2 border-t border-border pt-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isSaving}
            onClick={() => onOpenChange(false)}
          >
            {t.cancel}
          </Button>
          <Button type="submit" size="sm" disabled={isSaving || !isDirty || messageEmpty}>
            {isSaving && <Loader2 className="size-3.5 animate-spin" />}
            <span>{t.scheduled.editSubmitBtn}</span>
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
