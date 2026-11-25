import {useEffect, useState} from 'react';
import {useMutation} from '@tanstack/react-query';
import {Download, Eye, RefreshCw} from 'lucide-react';
import {toast} from 'sonner';
import {
  downloadNewsletterMedia,
  fetchAuthorizedBlobUrl,
  getNewsletterMessages,
  getNewsletterMessageUpdates,
  subscribeNewsletterLiveUpdates,
  unsubscribeNewsletterLiveUpdates,
} from '@/api/client';
import type {NewsletterMessage, NewsletterMetadata} from '@/api/types';
import {Button} from '@/components/ui/button';
import {Label} from '@/components/ui/label';
import {Skeleton} from '@/components/ui/skeleton';
import {Switch} from '@/components/ui/switch';
import {formatDate} from '@/lib/format';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';
import {resolveMediaFilename} from '@/lib/media-download';
import {cn} from '@/lib/utils';
import {hasUserPermission, useAuthStore} from '@/stores/auth';

export function extractNewsletterBody(msg: NewsletterMessage): string {
  const payload = msg.message;
  if (!payload) return '';
  const directConversation = payload.conversation;
  if (typeof directConversation === 'string' && directConversation.trim()) {
    return directConversation;
  }
  const extended = payload.extendedTextMessage as {text?: string} | undefined;
  if (typeof extended?.text === 'string' && extended.text.trim()) {
    return extended.text;
  }
  const imageMsg = payload.imageMessage as {caption?: string} | undefined;
  if (typeof imageMsg?.caption === 'string' && imageMsg.caption.trim()) {
    return imageMsg.caption;
  }
  const videoMsg = payload.videoMessage as {caption?: string} | undefined;
  if (typeof videoMsg?.caption === 'string' && videoMsg.caption.trim()) {
    return videoMsg.caption;
  }
  return '';
}

export function NewsletterMessagesPanel({
  deviceId,
  newsletter,
  isLiveActive,
  onLiveChanged,
  switchId = 'channel-live-switch',
}: {
  deviceId: string;
  newsletter: NewsletterMetadata;
  isLiveActive: boolean;
  onLiveChanged: () => void;
  switchId?: string;
}) {
  const {lang, t} = useI18n();
  const user = useAuthStore((s) => s.user);
  const canManageChannels = hasUserPermission(user, 'misc:channels.manage');
  const newsletterId = newsletter.id;

  const [messages, setMessages] = useState<NewsletterMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [downloadingServerId, setDownloadingServerId] = useState<number | null>(null);

  useEffect(() => {
    if (!canManageChannels || !deviceId || !newsletterId) return;
    let active = true;
    setLoading(true);
    setErrorMsg(null);
    setMessages([]);
    void getNewsletterMessages(deviceId, newsletterId, 20)
      .then((res) => {
        if (!active) return;
        setMessages(Array.isArray(res) ? res : []);
      })
      .catch((err) => {
        if (!active) return;
        setErrorMsg(toApiError(err).message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [canManageChannels, deviceId, newsletterId]);

  const loadOlder = async () => {
    const safeMessages = Array.isArray(messages) ? messages : [];
    const serverIds = safeMessages.map((m) => m.message_server_id).filter(Number.isFinite);
    if (!newsletterId || serverIds.length === 0 || loadingOlder) return;
    const minServerId = Math.min(...serverIds);
    setLoadingOlder(true);
    try {
      const older = await getNewsletterMessages(deviceId, newsletterId, 20, minServerId);
      const safeOlder = Array.isArray(older) ? older : [];
      setMessages((prev) => {
        const safePrev = Array.isArray(prev) ? prev : [];
        const seen = new Set(safePrev.map((m) => m.message_server_id));
        const merged = [...safePrev];
        for (const item of safeOlder) {
          if (!seen.has(item.message_server_id)) merged.push(item);
        }
        return merged;
      });
    } catch (err) {
      toast.error(toApiError(err).message);
    } finally {
      setLoadingOlder(false);
    }
  };

  const refreshCountsMutation = useMutation({
    mutationFn: () => getNewsletterMessageUpdates(deviceId, newsletterId, 1, 100),
    onSuccess: (updates) => {
      const safeUpdates = Array.isArray(updates) ? updates : [];
      setMessages((prev) => {
        const safePrev = Array.isArray(prev) ? prev : [];
        const map = new Map(safeUpdates.map((u) => [u.message_server_id, u]));
        return safePrev.map((m) => map.get(m.message_server_id) ?? m);
      });
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const liveToggleMutation = useMutation({
    mutationFn: async (enable: boolean) => {
      if (enable) {
        await subscribeNewsletterLiveUpdates(deviceId, newsletterId);
      } else {
        await unsubscribeNewsletterLiveUpdates(deviceId, newsletterId);
      }
    },
    onSuccess: (_res, enable) => {
      toast.success(enable ? t.misc.liveStartedToast : t.misc.liveStoppedToast);
      onLiveChanged();
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const handleDownloadMedia = async (serverId: number) => {
    setDownloadingServerId(serverId);
    try {
      const media = await downloadNewsletterMedia(deviceId, newsletterId, serverId);
      if (!media.proxy_url) {
        toast.error(t.chats.mediaUnavailable);
        return;
      }
      const blobUrl = await fetchAuthorizedBlobUrl(media.proxy_url);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = resolveMediaFilename(
        {
          id: `channel-${serverId}`,
          media_type: media.media_type || 'file',
          filename: media.filename || `channel-${serverId}`,
        },
        media.mime_type,
        media.filename,
      );
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 5_000);
    } catch (err) {
      toast.error(toApiError(err).message);
    } finally {
      setDownloadingServerId(null);
    }
  };

  if (!canManageChannels) {
    return (
      <div className="rounded-xl border border-border bg-card p-4 text-xs text-muted-foreground">
        {lang === 'ar'
          ? 'يلزم توفر صلاحية إدارة القنوات لعرض منشورات القناة وتحديثاتها المباشرة.'
          : 'Channel management permission is required to view channel posts and live updates.'}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
        <div className="flex items-center gap-2">
          <Switch
            id={switchId}
            checked={isLiveActive}
            disabled={liveToggleMutation.isPending}
            onCheckedChange={(checked) => liveToggleMutation.mutate(checked)}
          />
          <Label htmlFor={switchId} className="cursor-pointer text-xs">
            {t.misc.liveToggleLabel}
          </Label>
        </div>

        <Button
          variant="outline"
          size="sm"
          disabled={refreshCountsMutation.isPending}
          onClick={() => refreshCountsMutation.mutate()}
        >
          <RefreshCw
            className={cn('size-3.5', refreshCountsMutation.isPending && 'animate-spin')}
          />
          <span>{t.misc.refreshCounts}</span>
        </Button>
      </div>

      {loading ? (
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-20 w-full rounded-xl" />
          ))}
        </div>
      ) : errorMsg ? (
        <p className="text-xs text-destructive">{errorMsg}</p>
      ) : !Array.isArray(messages) || messages.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">{t.misc.noPosts}</p>
      ) : (
        <div className="space-y-3">
          {messages.map((msg) => {
            const body = extractNewsletterBody(msg);
            const reactions =
              msg.reaction_counts && typeof msg.reaction_counts === 'object'
                ? Object.entries(msg.reaction_counts)
                : [];
            const hasDownloadableMedia =
              msg.type && msg.type !== 'text' && msg.type !== 'unknown';

            return (
              <div
                key={msg.message_server_id}
                className="rounded-xl border border-border bg-card p-3.5 text-xs"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 text-muted-foreground">
                  <span className="font-mono tabular-nums">
                    #{msg.message_server_id} · {msg.type}
                  </span>
                  <span className="tabular-nums">
                    {msg.timestamp ? formatDate(msg.timestamp, lang) : '—'}
                  </span>
                </div>

                {body && (
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                    {body}
                  </p>
                )}

                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2">
                  <div className="flex flex-wrap items-center gap-3 text-muted-foreground">
                    <span className="inline-flex items-center gap-1 tabular-nums">
                      <Eye className="size-3.5" />
                      {t.misc.viewsLabel(msg.views_count || 0)}
                    </span>
                    {reactions.length > 0 && (
                      <span className="tabular-nums">
                        {reactions.map(([emoji, count]) => `${emoji} ${count}`).join(' · ')}
                      </span>
                    )}
                  </div>

                  {hasDownloadableMedia && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={downloadingServerId === msg.message_server_id}
                      onClick={() => handleDownloadMedia(msg.message_server_id)}
                    >
                      <Download className="size-3.5" />
                      <span>{t.misc.downloadAttachment}</span>
                    </Button>
                  )}
                </div>
              </div>
            );
          })}

          <div className="flex justify-center pt-2">
            <Button variant="outline" size="sm" disabled={loadingOlder} onClick={loadOlder}>
              {loadingOlder ? t.loading : t.misc.loadOlderPosts}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
