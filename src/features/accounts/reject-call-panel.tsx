import {useEffect, useState, type FormEvent} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {Loader2, PhoneOff, RotateCcw} from 'lucide-react';
import {toast} from 'sonner';
import {
  getCallAutoRejectSettings,
  rejectCall,
  saveCallAutoRejectSettings,
} from '@/api/client';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {Skeleton} from '@/components/ui/skeleton';
import {Switch} from '@/components/ui/switch';
import {formatDate} from '@/lib/format';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';

const MAX_REPLY_LENGTH = 1000;

function formatCallerLabel(callerName: string, callerJid: string): string {
  const cleanName = callerName.trim();
  const cleanJid = callerJid.replace(/@(s\.whatsapp\.net|lid)$/i, '');
  if (cleanName) return `${cleanName} (${cleanJid})`;
  return cleanJid || callerJid;
}

export function RejectCallPanel({deviceId}: {deviceId: string}) {
  const {lang, t} = useI18n();
  const copy = t.misc.callAutoReject;
  const queryClient = useQueryClient();
  const queryKey = ['call-auto-reject', deviceId] as const;

  const settingsQuery = useQuery({
    queryKey,
    queryFn: () => getCallAutoRejectSettings(deviceId),
    enabled: Boolean(deviceId),
    staleTime: 0,
  });

  const [replyDraft, setReplyDraft] = useState('');
  const [syncedFrom, setSyncedFrom] = useState<string | null>(null);
  const [callerJid, setCallerJid] = useState('');
  const [callId, setCallId] = useState('');

  useEffect(() => {
    setSyncedFrom(null);
    setReplyDraft('');
  }, [deviceId]);

  useEffect(() => {
    if (settingsQuery.data && syncedFrom === null) {
      setReplyDraft(settingsQuery.data.reply_message);
      setSyncedFrom(settingsQuery.data.reply_message);
    }
  }, [settingsQuery.data, syncedFrom]);

  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) => saveCallAutoRejectSettings(deviceId, {enabled}),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKey, data);
      toast.success(copy.saved);
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const replyMutation = useMutation({
    mutationFn: (payload: {reply_message?: string; reset_message?: boolean}) =>
      saveCallAutoRejectSettings(deviceId, payload),
    onSuccess: (data, variables) => {
      queryClient.setQueryData(queryKey, data);
      setReplyDraft(data.reply_message);
      setSyncedFrom(data.reply_message);
      toast.success(variables.reset_message ? copy.replyReset : copy.replySaved);
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const rejectCallMutation = useMutation({
    mutationFn: () =>
      rejectCall(deviceId, {
        caller_jid: callerJid.trim(),
        call_id: callId.trim(),
      }),
    onSuccess: () => {
      toast.success(t.misc.callRejectedToast);
      setCallerJid('');
      setCallId('');
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const data = settingsQuery.data;
  const trimmedDraft = replyDraft.trim();
  const replyDirty = data !== undefined && trimmedDraft !== data.reply_message.trim();
  const canReset = data !== undefined && (data.is_custom_message || trimmedDraft !== data.default_message);

  const handleSaveReply = (event: FormEvent) => {
    event.preventDefault();
    if (!deviceId || !replyDirty) return;
    replyMutation.mutate({reply_message: trimmedDraft});
  };

  const handleResetReply = () => {
    if (!deviceId || !data) return;
    replyMutation.mutate({reset_message: true});
  };

  return (
    <div className="max-w-2xl space-y-5">
      <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
        <h3 className="text-sm font-semibold text-foreground">{copy.title}</h3>
        {settingsQuery.isPending ? (
          <Skeleton className="mt-4 h-28 w-full" />
        ) : !data ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <p role="alert" className="text-sm text-destructive">
              {copy.loadError}
            </p>
            <Button variant="outline" size="sm" onClick={() => void settingsQuery.refetch()}>
              {t.refresh}
            </Button>
          </div>
        ) : (
          <>
            <div className="my-4 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{copy.enable}</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {copy.description}
                </p>
              </div>
              <Switch
                checked={data.enabled}
                disabled={toggleMutation.isPending}
                onCheckedChange={(enabled) => toggleMutation.mutate(enabled)}
                ariaLabel={copy.enable}
              />
            </div>

            {data.enabled && !data.webhook_configured && (
              <p className="mb-4 text-xs text-muted-foreground">{copy.webhookHint}</p>
            )}

            <form onSubmit={handleSaveReply} className="space-y-2 border-t border-border pt-4">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor={`call-auto-reply-${deviceId}`}>{copy.replyLabel}</Label>
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  {replyDraft.length} / {MAX_REPLY_LENGTH}
                </span>
              </div>
              <textarea
                id={`call-auto-reply-${deviceId}`}
                dir="auto"
                rows={3}
                maxLength={MAX_REPLY_LENGTH}
                disabled={replyMutation.isPending}
                value={replyDraft}
                onChange={(event) => setReplyDraft(event.target.value)}
                placeholder={copy.replyPlaceholder}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60"
              />
              <p className="text-xs leading-relaxed text-muted-foreground">{copy.replyHint}</p>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button
                  type="submit"
                  size="sm"
                  disabled={!replyDirty || replyMutation.isPending}
                >
                  {replyMutation.isPending && <Loader2 className="size-3.5 animate-spin" />}
                  <span>{copy.saveReply}</span>
                </Button>
                {canReset && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={replyMutation.isPending}
                    onClick={handleResetReply}
                  >
                    <RotateCcw className="size-3.5" />
                    <span>{copy.resetReply}</span>
                  </Button>
                )}
              </div>
            </form>

            <div className="mt-5 border-t border-border pt-4">
              <h4 className="mb-2 text-sm font-medium text-foreground">{copy.recentTitle}</h4>
              {data.recent.length === 0 ? (
                <p className="text-sm text-muted-foreground">{copy.recentEmpty}</p>
              ) : (
                <ul className="divide-y divide-border">
                  {data.recent.map((entry) => (
                    <li
                      key={`${entry.device_id}:${entry.call_id}`}
                      className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-medium text-foreground">
                          <bdi>{formatCallerLabel(entry.caller_name, entry.caller_jid)}</bdi>
                        </p>
                        <time
                          dateTime={entry.created_at}
                          className="text-xs text-muted-foreground"
                        >
                          {formatDate(entry.created_at, lang)}
                        </time>
                      </div>
                      <div className="flex shrink-0 items-center gap-3 text-xs">
                        <span
                          className={
                            entry.reject_status === 'failed'
                              ? 'font-medium text-destructive'
                              : 'font-medium text-foreground'
                          }
                        >
                          {copy.rejectStatus[entry.reject_status]}
                        </span>
                        <span className="text-border" aria-hidden>
                          ·
                        </span>
                        <span
                          className={
                            entry.reply_status === 'failed'
                              ? 'text-destructive'
                              : 'text-muted-foreground'
                          }
                        >
                          {copy.replyStatus[entry.reply_status]}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </section>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!deviceId || !callerJid.trim() || !callId.trim()) return;
          rejectCallMutation.mutate();
        }}
        className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-5"
      >
        <div>
          <h3 className="text-sm font-semibold text-foreground">{t.misc.callRejectTitle}</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {t.misc.callRejectDesc}
          </p>
        </div>

        <div>
          <Label htmlFor="call-caller-jid">{t.misc.callerJidLabel}</Label>
          <Input
            id="call-caller-jid"
            dir="ltr"
            className="mt-1.5"
            value={callerJid}
            onChange={(e) => setCallerJid(e.target.value)}
            placeholder={t.misc.callerJidPlaceholder}
            required
          />
        </div>

        <div>
          <Label htmlFor="call-id-input">{t.misc.callIdLabel}</Label>
          <Input
            id="call-id-input"
            dir="ltr"
            className="mt-1.5"
            value={callId}
            onChange={(e) => setCallId(e.target.value)}
            placeholder={t.misc.callIdPlaceholder}
            required
          />
        </div>

        <Button
          type="submit"
          variant="destructive"
          disabled={!deviceId || rejectCallMutation.isPending || !callerJid.trim() || !callId.trim()}
        >
          <PhoneOff className="size-4" />
          <span>{t.misc.rejectCallBtn}</span>
        </Button>
      </form>
    </div>
  );
}
