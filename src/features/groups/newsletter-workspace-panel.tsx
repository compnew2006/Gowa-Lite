import {useState} from 'react';
import {useMutation} from '@tanstack/react-query';
import {ArrowLeft, ArrowRight, Radio, UserMinus, UserPlus} from 'lucide-react';
import {toast} from 'sonner';
import {followNewsletter, unfollowNewsletter} from '@/api/client';
import type {UnifiedNewsletterItem} from '@/api/types';
import {Button} from '@/components/ui/button';
import {accountDotTone, shortAccountWidgetLabel} from '@/features/chat/chat-list';
import {NewsletterMessagesPanel} from '@/features/groups/newsletter-messages-panel';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';
import {cn} from '@/lib/utils';

export function NewsletterAvatar({
  name,
  pictureUrl,
  sizeClass = 'size-11',
}: {
  name: string;
  pictureUrl?: string;
  sizeClass?: string;
}) {
  const [failed, setFailed] = useState(false);

  if (pictureUrl && !failed) {
    return (
      <img
        src={pictureUrl}
        alt={name}
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className={cn('shrink-0 rounded-full border border-border object-cover', sizeClass)}
      />
    );
  }

  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full bg-secondary text-primary select-none',
        sizeClass,
      )}
    >
      <Radio className="size-5" />
    </span>
  );
}

export function NewsletterWorkspacePanel({
  item,
  isFollowed = true,
  onBack,
  onChanged,
}: {
  item: UnifiedNewsletterItem;
  isFollowed?: boolean;
  onBack: () => void;
  onChanged: () => void;
}) {
  const {lang, t} = useI18n();
  const isRtl = lang === 'ar';
  const BackIcon = isRtl ? ArrowRight : ArrowLeft;
  const nl = item.newsletter;
  const title = nl.thread_metadata?.name?.text?.trim() || item.name || item.jid;
  const description = nl.thread_metadata?.description?.text?.trim();
  const pictureUrl = nl.thread_metadata?.picture?.url || nl.thread_metadata?.preview?.url;
  const subscribers = nl.thread_metadata?.subscribers_count ?? item.subscribers_count ?? 0;

  const followMutation = useMutation({
    mutationFn: () => followNewsletter(item.device_id, item.jid),
    onSuccess: () => {
      toast.success(t.misc.followedToast);
      onChanged();
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const unfollowMutation = useMutation({
    mutationFn: () => unfollowNewsletter(item.device_id, item.jid),
    onSuccess: () => {
      toast.success(t.misc.unfollowedToast);
      onChanged();
      onBack();
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* Sticky Workspace Header matching MessageView */}
      <header className="flex h-[58px] shrink-0 items-center justify-between gap-3 border-b border-border bg-card px-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <button
            type="button"
            onClick={onBack}
            title={t.groups.backToDirectory}
            aria-label={t.groups.backToDirectory}
            className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground lg:hidden"
          >
            <BackIcon className="size-4" />
          </button>

          <NewsletterAvatar name={title} pictureUrl={pictureUrl} sizeClass="size-10" />

          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-foreground">{title}</h2>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1 font-medium text-foreground/90">
                <span
                  aria-hidden="true"
                  className={cn('size-1.5 shrink-0 rounded-full', accountDotTone(item.device_id))}
                />
                <span className="truncate">{shortAccountWidgetLabel(item.device_display_name)}</span>
              </span>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">{t.misc.subscribersCount(subscribers)}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono" dir="ltr">
                {item.jid}
              </span>
            </div>
          </div>
        </div>

        {isFollowed ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0 whitespace-nowrap"
            disabled={unfollowMutation.isPending}
            onClick={() => unfollowMutation.mutate()}
          >
            <UserMinus className="size-3.5" />
            <span>{t.misc.unfollow}</span>
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            className="shrink-0 whitespace-nowrap"
            disabled={followMutation.isPending}
            onClick={() => followMutation.mutate()}
          >
            <UserPlus className="size-3.5" />
            <span>{t.misc.follow}</span>
          </Button>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        <div className="mx-auto max-w-3xl space-y-5">
          {description && (
            <div className="rounded-xl border border-border bg-card p-4 text-xs text-muted-foreground">
              <p className="whitespace-pre-wrap leading-relaxed text-foreground">{description}</p>
            </div>
          )}

          <NewsletterMessagesPanel
            key={`${item.device_id}::${item.jid}`}
            deviceId={item.device_id}
            newsletter={nl}
            isLiveActive={item.live_active}
            onLiveChanged={onChanged}
            switchId={`inline-channel-live-${item.device_id}-${item.jid}`}
          />
        </div>
      </div>
    </div>
  );
}
