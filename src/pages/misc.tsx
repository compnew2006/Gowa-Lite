import {useEffect, useState} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {
  AlertCircle,
  Compass,
  Download,
  Eye,
  MessageSquareText,
  PhoneOff,
  Radio,
  RefreshCw,
  Search,
  UserMinus,
  UserPlus,
} from 'lucide-react';
import {toast} from 'sonner';
import {
  downloadNewsletterMedia,
  fetchAuthorizedBlobUrl,
  followNewsletter,
  getNewsletterInfo,
  getNewsletterMessageUpdates,
  getNewsletterMessages,
  listDeviceNewsletters,
  listNewsletterLiveUpdates,
  rejectCall,
  searchNewsletterDirectory,
  subscribeNewsletterLiveUpdates,
  unfollowNewsletter,
  unsubscribeNewsletterLiveUpdates,
} from '@/api/client';
import type {NewsletterMessage, NewsletterMetadata} from '@/api/types';
import {DeviceSelectorBar, useActiveDevice} from '@/components/device-selector-bar';
import {Button} from '@/components/ui/button';
import {Dialog} from '@/components/ui/dialog';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {Skeleton} from '@/components/ui/skeleton';
import {Switch} from '@/components/ui/switch';
import {useI18n} from '@/lib/i18n';
import {toApiError} from '@/lib/http';
import {cn} from '@/lib/utils';

function extractNewsletterBody(msg: NewsletterMessage): string {
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

function NewsletterMessagesDialog({
  deviceId,
  newsletter,
  isLiveActive,
  onClose,
  onLiveChanged,
}: {
  deviceId: string;
  newsletter: NewsletterMetadata | null;
  isLiveActive: boolean;
  onClose: () => void;
  onLiveChanged: () => void;
}) {
  const {t} = useI18n();
  const newsletterId = newsletter?.id ?? '';
  const name = newsletter?.thread_metadata?.name?.text || newsletterId;

  const [messages, setMessages] = useState<NewsletterMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [downloadingServerId, setDownloadingServerId] = useState<number | null>(null);

  useEffect(() => {
    if (!deviceId || !newsletterId) return;
    let active = true;
    setLoading(true);
    setErrorMsg(null);
    setMessages([]);
    void getNewsletterMessages(deviceId, newsletterId, 20)
      .then((res) => {
        if (!active) return;
        setMessages(res);
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
  }, [deviceId, newsletterId]);

  const loadOlder = async () => {
    if (!newsletterId || messages.length === 0 || loadingOlder) return;
    const minServerId = Math.min(...messages.map((m) => m.message_server_id));
    setLoadingOlder(true);
    try {
      const older = await getNewsletterMessages(deviceId, newsletterId, 20, minServerId);
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.message_server_id));
        const merged = [...prev];
        for (const item of older) {
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
      setMessages((prev) => {
        const map = new Map(updates.map((u) => [u.message_server_id, u]));
        return prev.map((m) => map.get(m.message_server_id) ?? m);
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
      const rawPath = media.file_path || media.file_url || '';
      if (!rawPath) {
        toast.error(t.chats.mediaUnavailable);
        return;
      }
      const proxyUrl = `/api/unified/media/file?path=${encodeURIComponent(rawPath)}`;
      const blobUrl = await fetchAuthorizedBlobUrl(proxyUrl);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = media.filename || `channel-${serverId}`;
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

  if (!newsletter) return null;

  return (
    <Dialog
      open={Boolean(newsletter)}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t.misc.messagesModalTitle(name)}
      description={newsletterId}
      className="max-w-2xl max-h-[88vh] overflow-y-auto"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
        <div className="flex items-center gap-2">
          <Switch
            id="channel-live-switch"
            checked={isLiveActive}
            disabled={liveToggleMutation.isPending}
            onCheckedChange={(checked) => liveToggleMutation.mutate(checked)}
          />
          <Label htmlFor="channel-live-switch" className="cursor-pointer text-xs">
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
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      ) : errorMsg ? (
        <p className="text-xs text-destructive">{errorMsg}</p>
      ) : messages.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">{t.misc.noPosts}</p>
      ) : (
        <div className="space-y-3">
          {messages.map((msg) => {
            const body = extractNewsletterBody(msg);
            const reactions = Object.entries(msg.reaction_counts ?? {});
            const hasDownloadableMedia =
              msg.type && msg.type !== 'text' && msg.type !== 'unknown';

            return (
              <div
                key={msg.message_server_id}
                className="rounded-lg border border-border bg-background p-3.5 text-xs"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 text-muted-foreground">
                  <span className="font-mono tabular-nums">
                    #{msg.message_server_id} · {msg.type}
                  </span>
                  <span className="tabular-nums">
                    {msg.timestamp ? new Date(msg.timestamp).toLocaleString() : '—'}
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
            <Button
              variant="outline"
              size="sm"
              disabled={loadingOlder}
              onClick={loadOlder}
            >
              {loadingOlder ? t.loading : t.misc.loadOlderPosts}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

export default function MiscPage() {
  const {t} = useI18n();
  const queryClient = useQueryClient();
  const deviceState = useActiveDevice();
  const deviceId = deviceState.selectedDeviceId;

  const [activeTab, setActiveTab] = useState<'following' | 'discover' | 'calls'>('following');
  const [selectedNewsletter, setSelectedNewsletter] = useState<NewsletterMetadata | null>(null);

  // Discover state
  const [dirView, setDirView] = useState('RECOMMENDED');
  const [dirSearch, setDirSearch] = useState('');
  const [dirCountries, setDirCountries] = useState('');
  const [dirCategories, setDirCategories] = useState('');
  const [dirResults, setDirResults] = useState<NewsletterMetadata[]>([]);
  const [dirNextCursor, setDirNextCursor] = useState<string | undefined>(undefined);
  const [dirHasNext, setDirHasNext] = useState(false);

  // Direct channel lookup state
  const [lookupInput, setLookupInput] = useState('');
  const [lookupResult, setLookupResult] = useState<NewsletterMetadata | null>(null);

  // Call reject state
  const [callerJid, setCallerJid] = useState('');
  const [callId, setCallId] = useState('');

  const followingQuery = useQuery({
    queryKey: ['newsletters', deviceId],
    queryFn: () => listDeviceNewsletters(deviceId),
    enabled: Boolean(deviceId),
    retry: 1,
  });

  const liveUpdatesQuery = useQuery({
    queryKey: ['newsletter-live-updates', deviceId],
    queryFn: () => listNewsletterLiveUpdates(deviceId),
    enabled: Boolean(deviceId),
    retry: false,
  });

  const followMutation = useMutation({
    mutationFn: (newsletterId: string) => followNewsletter(deviceId, newsletterId),
    onSuccess: () => {
      toast.success(t.misc.followedToast);
      void queryClient.invalidateQueries({queryKey: ['newsletters', deviceId]});
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const unfollowMutation = useMutation({
    mutationFn: (newsletterId: string) => unfollowNewsletter(deviceId, newsletterId),
    onSuccess: () => {
      toast.success(t.misc.unfollowedToast);
      void queryClient.invalidateQueries({queryKey: ['newsletters', deviceId]});
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const stopLiveMutation = useMutation({
    mutationFn: (newsletterId: string) => unsubscribeNewsletterLiveUpdates(deviceId, newsletterId),
    onSuccess: () => {
      toast.success(t.misc.liveStoppedToast);
      void queryClient.invalidateQueries({queryKey: ['newsletter-live-updates', deviceId]});
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const directoryMutation = useMutation({
    mutationFn: ({cursor, append}: {cursor?: string; append: boolean}) =>
      searchNewsletterDirectory(deviceId, {
        view: dirView || undefined,
        search_text: dirSearch.trim() || undefined,
        country_codes: dirCountries.trim() || undefined,
        categories: dirCategories.trim() || undefined,
        cursor,
        limit: 20,
      }).then((res) => ({res, append})),
    onSuccess: ({res, append}) => {
      setDirResults((prev) => {
        if (!append) return res.data;
        const seen = new Set(prev.map((n) => n.id));
        const merged = [...prev];
        for (const item of res.data) {
          if (!seen.has(item.id)) merged.push(item);
        }
        return merged;
      });
      setDirNextCursor(res.page_info?.end_cursor);
      setDirHasNext(Boolean(res.page_info?.has_next_page && res.page_info?.end_cursor));
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const lookupChannelMutation = useMutation({
    mutationFn: () => {
      const val = lookupInput.trim();
      const isInvite = val.includes('http') || !val.includes('@');
      return getNewsletterInfo(
        deviceId,
        isInvite ? {invite: val} : {newsletter_id: val},
      );
    },
    onSuccess: (res) => setLookupResult(res),
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

  const followedNewsletters = followingQuery.data ?? [];
  const followedIds = new Set(followedNewsletters.map((n) => n.id));
  const liveSubscriptions = liveUpdatesQuery.data ?? [];
  const liveJidSet = new Set(liveSubscriptions.map((s) => s.jid));

  const renderChannelCard = (channel: NewsletterMetadata) => {
    const title = channel.thread_metadata?.name?.text || channel.id;
    const desc = channel.thread_metadata?.description?.text;
    const subs = channel.thread_metadata?.subscribers_count ?? 0;
    const isFollowed = followedIds.has(channel.id);

    return (
      <div
        key={channel.id}
        className="flex flex-col justify-between rounded-xl border border-border bg-card p-4"
      >
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-foreground">{title}</h3>
          <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground" dir="ltr">
            {channel.id}
          </p>
          {desc && <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">{desc}</p>}
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
          <span className="text-xs tabular-nums text-muted-foreground">
            {t.misc.subscribersCount(subs)}
          </span>
          <div className="flex items-center gap-1.5">
            <Button variant="outline" size="sm" onClick={() => setSelectedNewsletter(channel)}>
              <MessageSquareText className="size-3.5" />
              <span>{t.misc.viewMessages}</span>
            </Button>
            {isFollowed ? (
              <Button
                variant="outline"
                size="sm"
                disabled={unfollowMutation.isPending}
                onClick={() => unfollowMutation.mutate(channel.id)}
              >
                <UserMinus className="size-3.5" />
                <span>{t.misc.unfollow}</span>
              </Button>
            ) : (
              <Button
                size="sm"
                disabled={followMutation.isPending}
                onClick={() => followMutation.mutate(channel.id)}
              >
                <UserPlus className="size-3.5" />
                <span>{t.misc.follow}</span>
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold text-foreground">{t.misc.pageTitle}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t.misc.pageSubtitle}</p>
      </div>

      <DeviceSelectorBar
        devices={deviceState.devices}
        selectedDevice={deviceState.selectedDevice}
        selectedDeviceId={deviceId}
        onSelectDevice={(id) => {
          setSelectedNewsletter(null);
          setDirResults([]);
          setLookupResult(null);
          deviceState.setSelectedDeviceId(id);
        }}
        isLoading={deviceState.isLoading}
        isFetching={followingQuery.isFetching}
        error={deviceState.error}
        onRefresh={() => {
          void deviceState.refetch();
          if (deviceId) {
            void followingQuery.refetch();
            void liveUpdatesQuery.refetch();
          }
        }}
      />

      {deviceId && (
        <>
          <div className="inline-flex flex-wrap rounded-xl border border-border bg-card p-1">
            {(
              [
                {id: 'following', label: t.misc.tabFollowing, icon: Radio},
                {id: 'discover', label: t.misc.tabDiscover, icon: Compass},
                {id: 'calls', label: t.misc.tabCalls, icon: PhoneOff},
              ] as const
            ).map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium whitespace-nowrap shrink-0 cursor-pointer transition-colors',
                    activeTab === tab.id
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Icon className="size-4" />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </div>

          {activeTab === 'following' && (
            <div className="space-y-5">
              {followingQuery.isLoading ? (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                  {[0, 1, 2].map((i) => (
                    <Skeleton key={i} className="h-36 rounded-xl" />
                  ))}
                </div>
              ) : followingQuery.error ? (
                <div className="flex items-center justify-between gap-3 rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
                  <div className="flex items-center gap-2">
                    <AlertCircle className="size-4 shrink-0" />
                    <span>{toApiError(followingQuery.error).message}</span>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => void followingQuery.refetch()}>
                    {t.retry}
                  </Button>
                </div>
              ) : followedNewsletters.length === 0 ? (
                <div className="rounded-xl border border-border bg-card p-10 text-center">
                  <Radio className="mx-auto size-8 text-muted-foreground" />
                  <p className="mt-2 text-sm text-muted-foreground">{t.misc.followingEmpty}</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                  {followedNewsletters.map(renderChannelCard)}
                </div>
              )}

              {/* Live Updates Subscriptions */}
              <div className="rounded-xl border border-border bg-card p-5">
                <h2 className="text-sm font-semibold text-foreground">{t.misc.liveUpdatesTitle}</h2>
                {liveUpdatesQuery.isLoading ? (
                  <Skeleton className="mt-3 h-12 w-full" />
                ) : liveSubscriptions.length === 0 ? (
                  <p className="mt-2 text-xs text-muted-foreground">{t.misc.liveUpdatesEmpty}</p>
                ) : (
                  <div className="mt-3 divide-y divide-border rounded-lg border border-border">
                    {liveSubscriptions.map((sub) => (
                      <div
                        key={sub.jid}
                        className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-2.5 text-xs"
                      >
                        <div className="min-w-0">
                          <p className="font-mono text-foreground" dir="ltr">
                            {sub.jid}
                          </p>
                          <p className="mt-0.5 tabular-nums text-muted-foreground">
                            {t.misc.expiresAt}:{' '}
                            {sub.expires_at ? new Date(sub.expires_at).toLocaleString() : '—'}
                          </p>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={stopLiveMutation.isPending}
                          onClick={() => stopLiveMutation.mutate(sub.jid)}
                        >
                          {t.misc.stopLiveUpdates}
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'discover' && (
            <div className="space-y-5">
              {/* Direct ID / Invite Lookup */}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!lookupInput.trim()) return;
                  lookupChannelMutation.mutate();
                }}
                className="space-y-3 rounded-xl border border-border bg-card p-4"
              >
                <Label htmlFor="channel-lookup-input">{t.misc.lookupChannelTitle}</Label>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    id="channel-lookup-input"
                    dir="ltr"
                    className="min-w-[220px] flex-1"
                    value={lookupInput}
                    onChange={(e) => setLookupInput(e.target.value)}
                    placeholder={t.misc.lookupChannelPlaceholder}
                    required
                  />
                  <Button
                    type="submit"
                    disabled={lookupChannelMutation.isPending || !lookupInput.trim()}
                  >
                    <Search className="size-4" />
                    <span>{t.misc.lookupChannelBtn}</span>
                  </Button>
                </div>
                {lookupResult && <div className="pt-2">{renderChannelCard(lookupResult)}</div>}
              </form>

              {/* Directory Search */}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  directoryMutation.mutate({append: false});
                }}
                className="space-y-3 rounded-xl border border-border bg-card p-4"
              >
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <div>
                    <Label htmlFor="dir-view">{t.misc.directoryViewLabel}</Label>
                    <select
                      id="dir-view"
                      value={dirView}
                      onChange={(e) => setDirView(e.target.value)}
                      className="mt-1.5 h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      <option value="RECOMMENDED">{t.misc.viewRecommended}</option>
                      <option value="TRENDING">{t.misc.viewTrending}</option>
                      <option value="POPULAR">{t.misc.viewPopular}</option>
                      <option value="NEW">{t.misc.viewNew}</option>
                      <option value="FEATURED">{t.misc.viewFeatured}</option>
                    </select>
                  </div>
                  <div>
                    <Label htmlFor="dir-search">{t.misc.tabDiscover}</Label>
                    <Input
                      id="dir-search"
                      className="mt-1.5"
                      value={dirSearch}
                      onChange={(e) => setDirSearch(e.target.value)}
                      placeholder={t.misc.directorySearchPlaceholder}
                    />
                  </div>
                  <div>
                    <Label htmlFor="dir-countries">ISO</Label>
                    <Input
                      id="dir-countries"
                      dir="ltr"
                      className="mt-1.5"
                      value={dirCountries}
                      onChange={(e) => setDirCountries(e.target.value)}
                      placeholder={t.misc.directoryCountryPlaceholder}
                    />
                  </div>
                  <div>
                    <Label htmlFor="dir-categories">Tags</Label>
                    <Input
                      id="dir-categories"
                      dir="ltr"
                      className="mt-1.5"
                      value={dirCategories}
                      onChange={(e) => setDirCategories(e.target.value)}
                      placeholder={t.misc.directoryCategoryPlaceholder}
                    />
                  </div>
                </div>

                <div className="flex justify-end">
                  <Button type="submit" disabled={directoryMutation.isPending}>
                    <Compass className="size-4" />
                    <span>{directoryMutation.isPending ? t.loading : t.misc.searchDirectoryBtn}</span>
                  </Button>
                </div>
              </form>

              {dirResults.length > 0 && (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                    {dirResults.map(renderChannelCard)}
                  </div>
                  {dirHasNext && dirNextCursor && (
                    <div className="flex justify-center">
                      <Button
                        variant="outline"
                        disabled={directoryMutation.isPending}
                        onClick={() =>
                          directoryMutation.mutate({cursor: dirNextCursor, append: true})
                        }
                      >
                        {t.misc.loadMoreDirectory}
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {activeTab === 'calls' && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                rejectCallMutation.mutate();
              }}
              className="max-w-lg space-y-4 rounded-xl border border-border bg-card p-5"
            >
              <div>
                <h2 className="text-sm font-semibold text-foreground">{t.misc.callRejectTitle}</h2>
                <p className="mt-1 text-xs text-muted-foreground">{t.misc.callRejectDesc}</p>
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
                disabled={rejectCallMutation.isPending || !callerJid.trim() || !callId.trim()}
              >
                <PhoneOff className="size-4" />
                <span>{t.misc.rejectCallBtn}</span>
              </Button>
            </form>
          )}
        </>
      )}

      <NewsletterMessagesDialog
        deviceId={deviceId}
        newsletter={selectedNewsletter}
        isLiveActive={Boolean(selectedNewsletter && liveJidSet.has(selectedNewsletter.id))}
        onClose={() => setSelectedNewsletter(null)}
        onLiveChanged={() =>
          void queryClient.invalidateQueries({queryKey: ['newsletter-live-updates', deviceId]})
        }
      />
    </div>
  );
}
