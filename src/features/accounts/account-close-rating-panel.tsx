import {useEffect} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {Star} from 'lucide-react';
import {toast} from 'sonner';
import {getAccountCloseRatings, saveAccountCloseRatings} from '@/api/client';
import {Button} from '@/components/ui/button';
import {Skeleton} from '@/components/ui/skeleton';
import {Switch} from '@/components/ui/switch';
import {onWsEvent} from '@/lib/events';
import {formatDate} from '@/lib/format';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';

export function AccountCloseRatingPanel({deviceId, canWrite}: {deviceId: string; canWrite: boolean}) {
  const {lang, t} = useI18n();
  const copy = t.accounts.closeRatings;
  const queryClient = useQueryClient();
  const queryKey = ['account-close-ratings', deviceId] as const;
  const query = useQuery({
    queryKey,
    queryFn: () => getAccountCloseRatings(deviceId),
    staleTime: 0,
  });

  useEffect(() => onWsEvent((event) => {
    if (event.code === 'CHAT_CLOSE_RATING_UPDATED' && event.device_id === deviceId) {
      void queryClient.invalidateQueries({queryKey: ['account-close-ratings', deviceId]});
    }
  }), [deviceId, queryClient]);

  const save = useMutation({
    mutationFn: (enabled: boolean) => saveAccountCloseRatings(deviceId, enabled),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKey, data);
      toast.success(copy.saved);
    },
    onError: (error) => toast.error(toApiError(error).message),
  });

  const data = query.data;
  const formatNumber = new Intl.NumberFormat(lang, {maximumFractionDigits: 1});
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
              disabled={!canWrite || save.isPending}
              onCheckedChange={(enabled) => save.mutate(enabled)}
              ariaLabel={copy.enable}
            />
          </div>
          {data.enabled && !data.webhook_configured && (
            <p className="mb-4 text-xs text-muted-foreground">{copy.webhookHint}</p>
          )}
          <dl className="grid grid-cols-2 gap-4 border-y border-border py-3">
            <div>
              <dt className="text-xs text-muted-foreground">{copy.average}</dt>
              <dd className="mt-1 text-lg font-semibold tabular-nums">
                {data.average === null ? '—' : formatNumber.format(data.average)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{copy.count}</dt>
              <dd className="mt-1 text-lg font-semibold tabular-nums">{formatNumber.format(data.count)}</dd>
            </div>
          </dl>
          <h4 className="mb-1 mt-4 text-sm font-medium text-foreground">{copy.recent}</h4>
          {data.recent.length === 0 ? (
            <p className="text-sm text-muted-foreground">{copy.empty}</p>
          ) : (
            <ul className="divide-y divide-border">
              {data.recent.map((rating) => (
                <li key={rating.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <time dateTime={rating.rated_at} className="text-muted-foreground">{formatDate(rating.rated_at, lang)}</time>
                  <span className="inline-flex items-center gap-1 font-medium tabular-nums">
                    <Star className="size-3.5 text-primary" aria-hidden />
                    <bdi>{formatNumber.format(rating.score)} / {formatNumber.format(5)}</bdi>
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
