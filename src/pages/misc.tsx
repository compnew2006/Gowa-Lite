import {useEffect, useMemo, useRef, useState} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRight,
  CircleDashed,
  Compass,
  Loader2,
  PhoneOff,
  Radio,
  RefreshCw,
  Search,
} from 'lucide-react';
import {toast} from 'sonner';
import {
  getNewsletterInfo,
  listDeviceNewsletters,
  listMiscStatuses,
  listNewsletterLiveUpdates,
  searchNewsletterDirectory,
} from '@/api/client';
import type {NewsletterMetadata, UnifiedNewsletterItem} from '@/api/types';
import {SidebarAccountSelect, useActiveDevice} from '@/components/device-selector-bar';
import {
  GowaSetupNotice,
  isGowaConnectionError,
  SplitWorkspace,
  WorkspaceEmptyState,
} from '@/components/layout/split-workspace';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {RejectCallPanel} from '@/features/accounts/reject-call-panel';
import {
  NewsletterAvatar,
  NewsletterWorkspacePanel,
} from '@/features/groups/newsletter-workspace-panel';
import {filterStatusGroups, groupStatusesByContact} from '@/features/misc/status-helpers';
import {
  StatusAccountFilterBar,
  StatusDetailPanel,
  StatusGroupList,
} from '@/features/misc/status-workspace';
import {extractWsEventTarget, onWsEvent} from '@/lib/events';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';
import {matchesNormalizedQuery} from '@/lib/phone';
import {cn} from '@/lib/utils';
import {useAuthStore} from '@/stores/auth';

type MiscSidebarMode = 'status' | 'following' | 'discover' | 'lookup' | 'calls';

const SIDEBAR_STORAGE_KEY = 'gowa-lite:misc-sidebar-width';

export default function MiscPage() {
  const {lang, t} = useI18n();
  const isRtl = lang === 'ar';
  const BackIcon = isRtl ? ArrowRight : ArrowLeft;
  const user = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();

  const deviceState = useActiveDevice();
  const deviceId = deviceState.selectedDeviceId;
  const activeDevice = deviceState.selectedDevice;
  const latestDeviceIdRef = useRef(deviceId);
  latestDeviceIdRef.current = deviceId;

  const [mode, setMode] = useState<MiscSidebarMode>('status');
  const [statusAccountFilter, setStatusAccountFilter] = useState('all');
  const [statusSearch, setStatusSearch] = useState('');
  const [selectedStatusGroupKey, setSelectedStatusGroupKey] = useState<string | null>(null);
  const [followingSearch, setFollowingSearch] = useState('');
  const [selectedChannel, setSelectedChannel] = useState<NewsletterMetadata | null>(null);
  const [mobileShowDetail, setMobileShowDetail] = useState(false);

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

  const statusesQuery = useQuery({
    queryKey: ['misc-statuses'],
    queryFn: () => listMiscStatuses(),
    enabled: mode === 'status',
    retry: 1,
    refetchInterval: 60_000,
  });

  useEffect(() => {
    return onWsEvent((event) => {
      if (
        event.code === 'LOGIN_SUCCESS' ||
        event.code === 'DEVICE_LOGGED_OUT' ||
        event.code === 'DEVICE_REMOVED'
      ) {
        void queryClient.invalidateQueries({queryKey: ['misc-statuses']});
        return;
      }
      const target = extractWsEventTarget(event);
      if (target.chatJid?.toLowerCase() === 'status@broadcast') {
        void queryClient.invalidateQueries({queryKey: ['misc-statuses']});
      }
    });
  }, [queryClient]);

  const followingQuery = useQuery({
    queryKey: ['newsletters', deviceId],
    queryFn: () => listDeviceNewsletters(deviceId),
    enabled: Boolean(deviceId) && mode !== 'status',
    retry: 1,
  });

  const liveUpdatesQuery = useQuery({
    queryKey: ['newsletter-live-updates', deviceId],
    queryFn: () => listNewsletterLiveUpdates(deviceId),
    enabled: Boolean(deviceId) && mode !== 'status',
    retry: false,
  });

  const directoryMutation = useMutation({
    mutationFn: ({cursor, append}: {cursor?: string; append: boolean}) => {
      const targetDeviceId = deviceId;
      return searchNewsletterDirectory(targetDeviceId, {
        view: dirView || undefined,
        search_text: dirSearch.trim() || undefined,
        country_codes: dirCountries.trim() || undefined,
        categories: dirCategories.trim() || undefined,
        cursor,
        limit: 20,
      }).then((res) => ({res, append, targetDeviceId}));
    },
    onSuccess: ({res, append, targetDeviceId}) => {
      if (targetDeviceId !== latestDeviceIdRef.current) return;
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
      const targetDeviceId = deviceId;
      const val = lookupInput.trim();
      const isInvite = val.includes('http') || !val.includes('@');
      return getNewsletterInfo(
        targetDeviceId,
        isInvite ? {invite: val} : {newsletter_id: val},
      ).then((res) => ({res, targetDeviceId}));
    },
    onSuccess: ({res, targetDeviceId}) => {
      if (targetDeviceId !== latestDeviceIdRef.current) return;
      setLookupResult(res);
      if (res) {
        setSelectedChannel(res);
        setMobileShowDetail(true);
      }
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const statusGroups = useMemo(
    () => groupStatusesByContact(statusesQuery.data?.data ?? []),
    [statusesQuery.data?.data],
  );

  const visibleStatusGroups = useMemo(
    () => filterStatusGroups(statusGroups, statusAccountFilter, statusSearch),
    [statusGroups, statusAccountFilter, statusSearch],
  );

  const selectedStatusGroup = useMemo(
    () => statusGroups.find((group) => group.key === selectedStatusGroupKey) ?? null,
    [statusGroups, selectedStatusGroupKey],
  );

  const followedNewsletters = useMemo(() => followingQuery.data ?? [], [followingQuery.data]);
  const followedIds = useMemo(
    () => new Set(followedNewsletters.map((n) => n.id)),
    [followedNewsletters],
  );
  const liveJidSet = useMemo(
    () => new Set((liveUpdatesQuery.data ?? []).map((s) => s.jid)),
    [liveUpdatesQuery.data],
  );

  const visibleFollowed = useMemo(() => {
    if (!followingSearch.trim()) return followedNewsletters;
    return followedNewsletters.filter((ch) =>
      matchesNormalizedQuery(
        [
          ch.thread_metadata?.name?.text,
          ch.thread_metadata?.description?.text,
          ch.id,
        ],
        followingSearch,
      ),
    );
  }, [followedNewsletters, followingSearch]);

  const workspaceItem = useMemo<UnifiedNewsletterItem | null>(() => {
    if (!selectedChannel || !deviceId) return null;
    const title = selectedChannel.thread_metadata?.name?.text?.trim() || selectedChannel.id;
    return {
      kind: 'newsletter',
      device_id: deviceId,
      device_display_name:
        activeDevice?.resolved_name || activeDevice?.alias || activeDevice?.display_name || deviceId,
      device_state: activeDevice?.state ?? 'disconnected',
      jid: selectedChannel.id,
      name: title,
      subscribers_count: selectedChannel.thread_metadata?.subscribers_count ?? 0,
      live_active: liveJidSet.has(selectedChannel.id),
      newsletter: selectedChannel,
    };
  }, [activeDevice, deviceId, liveJidSet, selectedChannel]);

  const deviceErr = deviceState.error ? toApiError(deviceState.error) : null;
  if (deviceErr && isGowaConnectionError(deviceErr)) {
    return (
      <GowaSetupNotice
        apiErr={deviceErr}
        isAdmin={user?.role === 'admin'}
        onRetry={() => void deviceState.refetch()}
      />
    );
  }

  const renderChannelRow = (channel: NewsletterMetadata) => {
    const title = channel.thread_metadata?.name?.text?.trim() || channel.id;
    const subs = channel.thread_metadata?.subscribers_count ?? 0;
    const pictureUrl = channel.thread_metadata?.picture?.url || channel.thread_metadata?.preview?.url;
    const isSelected = selectedChannel?.id === channel.id;
    const isLive = liveJidSet.has(channel.id);

    return (
      <li key={channel.id}>
        <button
          type="button"
          onClick={() => {
            setSelectedChannel(channel);
            setMobileShowDetail(true);
          }}
          className={cn(
            'flex w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-start transition-colors',
            isSelected ? 'bg-secondary' : 'hover:bg-secondary/60',
          )}
        >
          <NewsletterAvatar name={title} pictureUrl={pictureUrl} sizeClass="size-11" />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-[14.5px] font-medium text-foreground">{title}</span>
              <span className="shrink-0 text-[11px] font-medium tabular-nums text-muted-foreground">
                {t.misc.subscribersCount(subs)}
              </span>
            </div>
            <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              {isLive && (
                <>
                  <span className="inline-flex shrink-0 items-center gap-1 font-medium text-emerald-700 dark:text-emerald-400">
                    <span aria-hidden="true" className="size-1.5 rounded-full bg-live" />
                    <span>{t.misc.liveActiveBadge}</span>
                  </span>
                  <span aria-hidden="true">·</span>
                </>
              )}
              <span dir="ltr" className="truncate font-mono">
                {channel.id}
              </span>
            </div>
          </div>
        </button>
      </li>
    );
  };

  const showDetailOnMobile =
    mobileShowDetail &&
    (mode === 'calls' ||
      (mode === 'status' ? Boolean(selectedStatusGroup) : Boolean(workspaceItem)));

  const detailNode =
    mode === 'status' ? (
      selectedStatusGroup ? (
        <StatusDetailPanel
          key={selectedStatusGroup.key}
          group={selectedStatusGroup}
          onBack={() => setMobileShowDetail(false)}
        />
      ) : null
    ) : mode === 'calls' && deviceId ? (
      <div className="flex h-full min-h-0 flex-col bg-background">
        <header className="flex h-[58px] shrink-0 items-center gap-2.5 border-b border-border bg-card px-3">
          <button
            type="button"
            onClick={() => setMobileShowDetail(false)}
            title={t.misc.backToChannels}
            aria-label={t.misc.backToChannels}
            className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground lg:hidden"
          >
            <BackIcon className="size-4" />
          </button>
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
            <PhoneOff className="size-5" />
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-foreground">
              {t.misc.callRejectTitle}
            </h2>
            <p className="truncate text-[11px] text-muted-foreground">
              {activeDevice?.resolved_name || activeDevice?.display_name || deviceId}
            </p>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
          <div className="mx-auto max-w-2xl">
            <RejectCallPanel deviceId={deviceId} />
          </div>
        </div>
      </div>
    ) : workspaceItem ? (
      <NewsletterWorkspacePanel
        key={`${workspaceItem.device_id}::${workspaceItem.jid}`}
        item={workspaceItem}
        isFollowed={followedIds.has(workspaceItem.jid)}
        onBack={() => {
          setMobileShowDetail(false);
          if (mode === 'following' && !followedIds.has(workspaceItem.jid)) {
            setSelectedChannel(null);
          }
        }}
        onChanged={() => {
          void queryClient.invalidateQueries({queryKey: ['newsletters', deviceId]});
          void queryClient.invalidateQueries({queryKey: ['newsletter-live-updates', deviceId]});
          void queryClient.invalidateQueries({queryKey: ['unified-groups']});
        }}
      />
    ) : null;

  return (
    <SplitWorkspace
      storageKey={SIDEBAR_STORAGE_KEY}
      showDetailOnMobile={showDetailOnMobile}
      sidebar={
        <div className="flex h-full min-h-0 flex-col bg-card">
          {/* 58px Sidebar Header */}
          <div className="flex h-[58px] shrink-0 items-center justify-between gap-2 px-4">
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="truncate text-xl font-bold tracking-tight text-foreground">
                {t.misc.pageTitle}
              </h1>
              {mode === 'status' ? (
                (statusesQuery.data?.data.length ?? 0) > 0 && (
                  <span className="text-xs font-medium text-muted-foreground tabular-nums">
                    {statusesQuery.data?.data.length}
                  </span>
                )
              ) : (
                followedNewsletters.length > 0 && (
                  <span className="text-xs font-medium text-muted-foreground tabular-nums">
                    {followedNewsletters.length}
                  </span>
                )
              )}
            </div>

            <button
              type="button"
              onClick={() => {
                void deviceState.refetch();
                if (mode === 'status') {
                  void statusesQuery.refetch();
                } else if (deviceId) {
                  void followingQuery.refetch();
                  void liveUpdatesQuery.refetch();
                }
              }}
              disabled={
                deviceState.isFetching ||
                followingQuery.isFetching ||
                statusesQuery.isFetching
              }
              title={t.refresh}
              aria-label={t.refresh}
              className="flex size-9 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50"
            >
              <RefreshCw
                className={cn(
                  'size-4',
                  (deviceState.isFetching ||
                    followingQuery.isFetching ||
                    statusesQuery.isFetching) &&
                    'animate-spin',
                )}
              />
            </button>
          </div>

          {/* Account Switcher & Mode Pills */}
          <div className="flex flex-col gap-2.5 border-b border-border/60 px-3 pb-3">
            {mode !== 'status' && (
              <SidebarAccountSelect
                devices={deviceState.devices}
                selectedDevice={activeDevice}
                selectedDeviceId={deviceId}
                onSelectDevice={(id) => {
                  deviceState.setSelectedDeviceId(id);
                  setSelectedChannel(null);
                  setDirResults([]);
                  setLookupResult(null);
                  setMobileShowDetail(false);
                }}
              />
            )}

            <div className="flex flex-wrap items-center gap-1.5">
              {(
                [
                  {id: 'status', label: t.misc.tabStatus, icon: CircleDashed},
                  {id: 'following', label: t.misc.tabFollowing, icon: Radio},
                  {id: 'discover', label: t.misc.tabDiscover, icon: Compass},
                  {id: 'lookup', label: t.misc.tabLookup, icon: Search},
                  {id: 'calls', label: t.misc.tabCalls, icon: PhoneOff},
                ] as const
              ).map((tab) => {
                const Icon = tab.icon;
                const active = mode === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => {
                      setMode(tab.id);
                      if (tab.id === 'calls') {
                        setMobileShowDetail(true);
                      } else if (tab.id === 'status') {
                        setMobileShowDetail(Boolean(selectedStatusGroupKey));
                      } else {
                        setMobileShowDetail(Boolean(selectedChannel));
                      }
                    }}
                    className={cn(
                      'inline-flex h-7 cursor-pointer items-center gap-1 rounded-full px-2.5 text-xs font-medium whitespace-nowrap shrink-0 transition-colors',
                      active
                        ? 'bg-accent text-accent-foreground'
                        : 'bg-secondary text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <Icon className="size-3.5" />
                    <span>{tab.label}</span>
                  </button>
                );
              })}
            </div>

            {mode === 'status' && (
              <>
                <StatusAccountFilterBar
                  accounts={statusesQuery.data?.accounts ?? []}
                  selectedAccountId={statusAccountFilter}
                  onSelectAccount={setStatusAccountFilter}
                />
                <div className="relative">
                  <Search className="pointer-events-none absolute start-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    type="search"
                    value={statusSearch}
                    onChange={(e) => setStatusSearch(e.target.value)}
                    placeholder={t.misc.statusSearchPlaceholder}
                    className="h-9 w-full rounded-full bg-secondary ps-10 pe-4 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
                  />
                </div>
              </>
            )}

            {mode === 'following' && (
              <div className="relative">
                <Search className="pointer-events-none absolute start-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="search"
                  value={followingSearch}
                  onChange={(e) => setFollowingSearch(e.target.value)}
                  placeholder={t.misc.directorySearchPlaceholder}
                  className="h-9 w-full rounded-full bg-secondary ps-10 pe-4 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
                />
              </div>
            )}

            {mode === 'discover' && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!deviceId) return;
                  directoryMutation.mutate({append: false});
                }}
                className="space-y-2 pt-0.5"
              >
                <div className="grid grid-cols-2 gap-1.5">
                  <select
                    aria-label={t.misc.directoryViewLabel}
                    value={dirView}
                    onChange={(e) => setDirView(e.target.value)}
                    className="h-8 rounded-lg border border-input bg-background px-2 text-xs text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <option value="RECOMMENDED">{t.misc.viewRecommended}</option>
                    <option value="TRENDING">{t.misc.viewTrending}</option>
                    <option value="POPULAR">{t.misc.viewPopular}</option>
                    <option value="NEW">{t.misc.viewNew}</option>
                    <option value="FEATURED">{t.misc.viewFeatured}</option>
                  </select>
                  <Input
                    dir="ltr"
                    className="h-8 text-xs"
                    value={dirCountries}
                    onChange={(e) => setDirCountries(e.target.value)}
                    placeholder={t.misc.directoryCountryPlaceholder}
                  />
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  <Input
                    className="h-8 text-xs"
                    value={dirSearch}
                    onChange={(e) => setDirSearch(e.target.value)}
                    placeholder={t.misc.directorySearchPlaceholder}
                  />
                  <Input
                    dir="ltr"
                    className="h-8 text-xs"
                    value={dirCategories}
                    onChange={(e) => setDirCategories(e.target.value)}
                    placeholder={t.misc.directoryCategoryPlaceholder}
                  />
                </div>
                <Button
                  type="submit"
                  size="sm"
                  className="w-full"
                  disabled={!deviceId || directoryMutation.isPending}
                >
                  <Compass className="size-3.5" />
                  <span>
                    {directoryMutation.isPending ? t.loading : t.misc.searchDirectoryBtn}
                  </span>
                </Button>
              </form>
            )}

            {mode === 'lookup' && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!deviceId || !lookupInput.trim()) return;
                  lookupChannelMutation.mutate();
                }}
                className="flex items-center gap-1.5 pt-0.5"
              >
                <Input
                  dir="ltr"
                  className="h-8 min-w-0 flex-1 text-xs"
                  value={lookupInput}
                  onChange={(e) => setLookupInput(e.target.value)}
                  placeholder={t.misc.lookupChannelPlaceholder}
                  required
                />
                <Button
                  type="submit"
                  size="sm"
                  disabled={!deviceId || lookupChannelMutation.isPending || !lookupInput.trim()}
                >
                  <Search className="size-3.5" />
                  <span>{t.misc.lookupChannelBtn}</span>
                </Button>
              </form>
            )}
          </div>

          {/* Channel / Status / Tool List Body */}
          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
            {mode === 'status' ? (
              <StatusGroupList
                groups={visibleStatusGroups}
                totalGroupsCount={statusGroups.length}
                isLoading={statusesQuery.isLoading}
                error={statusesQuery.error}
                deviceErrors={statusesQuery.data?.device_errors ?? []}
                selectedGroupKey={selectedStatusGroupKey}
                onSelectGroup={(key) => {
                  setSelectedStatusGroupKey(key);
                  setMobileShowDetail(true);
                }}
              />
            ) : deviceState.isLoading ? (
              <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                <span>{t.loading}</span>
              </div>
            ) : !deviceId ? (
              <div className="p-6 text-center text-xs text-muted-foreground">
                <p className="font-medium text-foreground">{t.deviceSelector.noDevicesTitle}</p>
                <p className="mt-1">{t.deviceSelector.noDevicesDesc}</p>
              </div>
            ) : mode === 'following' ? (
              followingQuery.isLoading ? (
                <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  <span>{t.loading}</span>
                </div>
              ) : followingQuery.error ? (
                <div className="p-6 text-center text-xs text-destructive">
                  {toApiError(followingQuery.error).message}
                </div>
              ) : visibleFollowed.length === 0 ? (
                <div className="p-6 text-center text-xs text-muted-foreground">
                  {t.misc.followingEmpty}
                </div>
              ) : (
                <ul className="space-y-0.5">{visibleFollowed.map(renderChannelRow)}</ul>
              )
            ) : mode === 'discover' ? (
              dirResults.length === 0 ? (
                <div className="p-6 text-center text-xs text-muted-foreground">
                  {t.misc.discoverEmptyHint}
                </div>
              ) : (
                <div className="space-y-2">
                  <ul className="space-y-0.5">{dirResults.map(renderChannelRow)}</ul>
                  {dirHasNext && dirNextCursor && (
                    <div className="flex justify-center pt-1">
                      <Button
                        variant="outline"
                        size="sm"
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
              )
            ) : mode === 'lookup' ? (
              lookupResult ? (
                <ul className="space-y-0.5">{renderChannelRow(lookupResult)}</ul>
              ) : (
                <div className="p-6 text-center text-xs text-muted-foreground">
                  {t.misc.lookupEmptyHint}
                </div>
              )
            ) : (
              <ul className="space-y-0.5">
                <li>
                  <button
                    type="button"
                    onClick={() => setMobileShowDetail(true)}
                    className="flex w-full cursor-pointer items-center gap-3 rounded-xl bg-secondary px-3 py-2.5 text-start"
                  >
                    <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
                      <PhoneOff className="size-5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[14.5px] font-medium text-foreground">
                        {t.misc.callRejectTitle}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {activeDevice?.resolved_name || activeDevice?.display_name || deviceId}
                      </p>
                    </div>
                  </button>
                </li>
              </ul>
            )}
          </div>
        </div>
      }
      detail={detailNode}
      emptyState={
        mode === 'status' ? (
          <WorkspaceEmptyState
            icon={CircleDashed}
            title={t.misc.selectStatusPrompt}
            hint={t.misc.selectStatusHint}
          />
        ) : (
          <WorkspaceEmptyState
            icon={Radio}
            title={t.misc.selectChannelPrompt}
            hint={t.misc.selectChannelHint}
          />
        )
      }
    />
  );
}
