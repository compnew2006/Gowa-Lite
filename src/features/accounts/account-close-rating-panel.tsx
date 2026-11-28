import {useEffect, useState, type FormEvent} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {Loader2, RotateCcw, Star} from 'lucide-react';
import {toast} from 'sonner';
import {useNavigate} from 'react-router-dom';
import {getAccountCloseRatings, saveAccountCloseRatings} from '@/api/client';
import {Button} from '@/components/ui/button';
import {Label} from '@/components/ui/label';
import {Skeleton} from '@/components/ui/skeleton';
import {Switch} from '@/components/ui/switch';
import {formatDate, formatNumber} from '@/lib/format';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';
import {toastWithView} from '@/lib/toast-with-view';

const MAX_PROMPT_LENGTH = 1000;

export function AccountCloseRatingPanel({deviceId, canWrite}: {deviceId: string; canWrite: boolean}) {
  const {lang, t} = useI18n();
  const navigate = useNavigate();
  const copy = t.accounts.closeRatings;
  const queryClient = useQueryClient();
  const queryKey = ['account-close-ratings', deviceId] as const;
  const query = useQuery({
    queryKey,
    queryFn: () => getAccountCloseRatings(deviceId),
    staleTime: 0,
  });

  const [promptDraft, setPromptDraft] = useState('');
  const [promptSyncedFrom, setPromptSyncedFrom] = useState<string | null>(null);

  useEffect(() => {
    setPromptSyncedFrom(null);
    setPromptDraft('');
  }, [deviceId]);

  useEffect(() => {
    if (query.data && promptSyncedFrom === null) {
      setPromptDraft(query.data.prompt_message);
      setPromptSyncedFrom(query.data.prompt_message);
    }
  }, [query.data, promptSyncedFrom]);

  const toggleSave = useMutation({
    mutationFn: (enabled: boolean) => saveAccountCloseRatings(deviceId, {enabled}),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKey, data);
      toastWithView(copy.saved, {
        label: t.scheduled.viewAction,
        to: '/account',
        navigate,
      });
    },
    onError: (error) => toast.error(toApiError(error).message),
  });

  const promptSave = useMutation({
    mutationFn: (payload: {prompt_message: string; isReset?: boolean}) =>
      saveAccountCloseRatings(deviceId, {prompt_message: payload.prompt_message}),
    onSuccess: (data, variables) => {
      queryClient.setQueryData(queryKey, data);
      setPromptDraft(data.prompt_message);
      setPromptSyncedFrom(data.prompt_message);
      toastWithView(variables.isReset ? copy.promptReset : copy.promptSaved, {
        label: t.scheduled.viewAction,
        to: '/account',
        navigate,
      });
    },
    onError: (error) => toast.error(toApiError(error).message),
  });

  const data = query.data;
  const trimmedDraft = promptDraft.trim();
  const promptDirty = data !== undefined && trimmedDraft !== data.prompt_message.trim();
  const canReset = data !== undefined && (data.is_custom_prompt || trimmedDraft !== data.default_prompt);

  const handleSavePrompt = (event: FormEvent) => {
    event.preventDefault();
    if (!canWrite || !trimmedDraft || !promptDirty) return;
    promptSave.mutate({prompt_message: trimmedDraft});
  };

  const handleResetPrompt = () => {
    if (!canWrite || !data) return;
    promptSave.mutate({prompt_message: '', isReset: true});
  };

  return (
    <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <h3 className="text-sm font-semibold text-foreground">{copy.title}</h3>
      {query.isPending ? (
        <Skeleton className="mt-4 h-24 w-full" />
      ) : !data ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <p role="alert" className="text-sm text-destructive">{copy.loadError}</p>
          <Button variant="outline" size="sm" onClick={() => void query.refetch()}>{t.refresh}</Button>
        </div>
      ) : (
        <>
          <div className="my-4 flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">{copy.enable}</p>
              <p className="mt-1 text-xs text-muted-foreground">{copy.description}</p>
            </div>
            <Switch
              checked={data.enabled}
              disabled={!canWrite || toggleSave.isPending}
              onCheckedChange={(enabled) => toggleSave.mutate(enabled)}
              ariaLabel={copy.enable}
            />
          </div>
          {data.enabled && !data.webhook_configured && (
            <p className="mb-4 text-xs text-muted-foreground">{copy.webhookHint}</p>
          )}

          <form onSubmit={handleSavePrompt} className="mb-5 space-y-2 border-t border-border pt-4">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor={`close-rating-prompt-${deviceId}`}>{copy.promptLabel}</Label>
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {promptDraft.length} / {MAX_PROMPT_LENGTH}
              </span>
            </div>
            <textarea
              id={`close-rating-prompt-${deviceId}`}
              rows={3}
              maxLength={MAX_PROMPT_LENGTH}
              disabled={!canWrite || promptSave.isPending}
              value={promptDraft}
              onChange={(event) => setPromptDraft(event.target.value)}
              placeholder={copy.promptPlaceholder}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60"
            />
            <p className="text-xs leading-relaxed text-muted-foreground">{copy.promptHint}</p>
            {canWrite && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button
                  type="submit"
                  size="sm"
                  disabled={!trimmedDraft || !promptDirty || promptSave.isPending}
                >
                  {promptSave.isPending && <Loader2 className="size-3.5 animate-spin" />}
                  <span>{copy.savePrompt}</span>
                </Button>
                {canReset && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={promptSave.isPending}
                    onClick={handleResetPrompt}
                  >
                    <RotateCcw className="size-3.5" />
                    <span>{copy.resetPrompt}</span>
                  </Button>
                )}
              </div>
            )}
          </form>

          <dl className="grid grid-cols-2 gap-4 border-y border-border py-3">
            <div>
              <dt className="text-xs text-muted-foreground">{copy.average}</dt>
              <dd className="mt-1 text-lg font-semibold tabular-nums">
                {data.average === null ? '—' : formatNumber(data.average, lang, {maximumFractionDigits: 1})}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{copy.count}</dt>
              <dd className="mt-1 text-lg font-semibold tabular-nums">{formatNumber(data.count, lang, {maximumFractionDigits: 1})}</dd>
            </div>
          </dl>

          {data.by_user.length > 0 && (
            <div className="mt-4">
              <h4 className="mb-1.5 text-sm font-medium text-foreground">{copy.byUserTitle}</h4>
              <ul className="divide-y divide-border rounded-lg border border-border px-3">
                {data.by_user.map((entry) => (
                  <li
                    key={`${entry.user_id ?? 'none'}:${entry.user_name}`}
                    className="flex items-center justify-between gap-3 py-2 text-sm"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium text-foreground">
                        {entry.user_name || copy.unknownUser}
                      </p>
                      <p className="text-xs text-muted-foreground tabular-nums">
                        {copy.ratingsCountSuffix(entry.count)}
                      </p>
                    </div>
                    <span className="inline-flex shrink-0 items-center gap-1 font-medium tabular-nums">
                      <Star className="size-3.5 text-primary" aria-hidden />
                      <bdi>{formatNumber(entry.average, lang, {maximumFractionDigits: 1})} / {formatNumber(5, lang, {maximumFractionDigits: 1})}</bdi>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <h4 className="mb-1 mt-4 text-sm font-medium text-foreground">{copy.recent}</h4>
          {data.recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">{copy.empty}</p>
          ) : (
            <ul className="divide-y divide-border">
              {data.recent.map((rating) => (
                <li key={rating.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-foreground">
                      {rating.user_name || copy.unknownUser}
                    </p>
                    <time dateTime={rating.rated_at} className="text-xs text-muted-foreground">
                      {formatDate(rating.rated_at, lang)}
                    </time>
                  </div>
                  <span className="inline-flex shrink-0 items-center gap-1 font-medium tabular-nums">
                    <Star className="size-3.5 text-primary" aria-hidden />
                    <bdi>{formatNumber(rating.score, lang, {maximumFractionDigits: 1})} / {formatNumber(5, lang, {maximumFractionDigits: 1})}</bdi>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
