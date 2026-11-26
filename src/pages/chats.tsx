import {Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useQuery, useQueryClient} from '@tanstack/react-query';
import {
  Columns2,
  MessagesSquare,
  PanelLeft,
  Plus,
  X,
} from 'lucide-react';
import {useNavigate, useSearchParams} from 'react-router-dom';
import {toast} from 'sonner';
import {bulkUnifiedChatsLifecycle, DEFAULT_UNIFIED_CHATS_QUERY_KEY, listUnifiedChats} from '@/api/client';
import type {
  UnifiedChat,
  UnifiedChatsResponse,
  UnifiedChatTab,
} from '@/api/types';
import {
  GowaSetupNotice,
  isGowaConnectionError,
  SplitWorkspace,
  WorkspaceEmptyState,
} from '@/components/layout/split-workspace';
import {Button} from '@/components/ui/button';
import {ChatList, chatUniqueKey} from '@/features/chat/chat-list';
import {chatDisplayName} from '@/features/chat/display-name';
import {patchRevokedMessage} from '@/features/chat/message-reactions';
import {MessageView} from '@/features/chat/message-view';
import {resolveSelectedUnifiedChat} from '@/features/chat/selected-chat';

const NewChatDialog = lazy(() =>
  import('@/features/chat/new-chat-dialog').then((m) => ({default: m.NewChatDialog})),
);
import {
  buildJidAccountsMap,
  getOtherAccountsForChat,
  type OtherAccountRef,
} from '@/features/chat/other-accounts';
import {usePaginatedChats} from '@/features/chat/use-paginated-chats';
import {extractWsEventTarget, extractWsRevokeTarget, onWsEvent} from '@/lib/events';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';
import {toWhatsAppJid} from '@/lib/phone';
import {invalidateChatQueries} from '@/lib/query-client';
import {cn} from '@/lib/utils';
import {hasUserAnyPermission, hasUserPermission, useAuthStore} from '@/stores/auth';

function isChatRedactedForUser(
  chat: UnifiedChat,
  userId: number | undefined,
  canViewAll: boolean,
): boolean {
  if (canViewAll) return false;
  if (chat.jid.endsWith('@newsletter') || chat.jid === 'status@broadcast') return false;
  const st = chat.lifecycle?.status ?? 'pending';
  if (st === 'pending' || st === 'closed') return true;
  return st === 'open' && chat.lifecycle?.assigned_user_id !== userId;
}

type WorkspaceMode = 'unified' | 'split';

interface SplitPaneConfig {
  id: string;
  deviceIds: string[];
}

const SIDEBAR_STORAGE_KEY = 'gowa-lite:chat-sidebar-width';

function SplitWorkspacePane({
  index,
  pane,
  globalJidAccountsMap,
  canRemove,
  canViewAll,
  canAssign,
  canClose,
  onDeviceIdsChange,
  onRemove,
}: {
  index: number;
  pane: SplitPaneConfig;
  globalJidAccountsMap: Map<string, OtherAccountRef[]>;
  canRemove: boolean;
  canViewAll: boolean;
  canAssign: boolean;
  canClose: boolean;
  onDeviceIdsChange: (deviceIds: string[]) => void;
  onRemove: () => void;
}) {
  const queryClient = useQueryClient();
  const {t} = useI18n();
  const user = useAuthStore((s) => s.user);
  const canWriteChats = hasUserPermission(user, 'chats:write');
  const [search, setSearch] = useState('');
  const [hasMedia, setHasMedia] = useState(false);
  const [activeTab, setActiveTab] = useState<UnifiedChatTab>(() =>
    canViewAll ? 'all' : 'pending',
  );
  const [assignedToFilter, setAssignedToFilter] = useState<'all' | 'me'>('all');
  const [isBulkPending, setIsBulkPending] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [retainedChat, setRetainedChat] = useState<UnifiedChat | null>(null);
  const [adHocChat, setAdHocChat] = useState<{deviceId: string; jid: string} | null>(null);
  const [newChatOpen, setNewChatOpen] = useState(false);

  useEffect(() => {
    if (!canViewAll && activeTab === 'all') {
      setActiveTab('pending');
    }
  }, [activeTab, canViewAll]);

  const effectiveAssignedTo =
    activeTab === 'me'
      ? 'me'
      : activeTab === 'open' && canViewAll
        ? assignedToFilter
        : undefined;

  const paginated = usePaginatedChats({
    deviceIds: pane.deviceIds,
    search,
    hasMedia,
    tab: activeTab,
    assignedTo: effectiveAssignedTo,
  });
  const {query, chats, accounts: resolvedAccounts, deviceErrors} = paginated;
  const apiErr = query.isError ? toApiError(query.error) : null;

  const handleBulkLifecycle = useCallback(
    async (action: 'close' | 'release' | 'reopen', selectedChats: UnifiedChat[]) => {
      setIsBulkPending(true);
      try {
        const res = await bulkUnifiedChatsLifecycle({
          action,
          items: selectedChats.map((c) => ({
            device_id: c.device_id,
            chat_jid: c.jid,
            cached_title: chatDisplayName(c),
          })),
        });
        const okCount = res.succeeded.length;
        const failCount = res.failed.length;
        if (failCount === 0) {
          toast.success(t.chats.bulkResultToast(okCount));
        } else if (okCount > 0) {
          toast.warning(t.chats.bulkPartialToast(okCount, okCount + failCount));
        } else {
          toast.error(res.failed[0]?.message || t.chats.bulkPartialToast(0, failCount));
        }
        await queryClient.invalidateQueries({queryKey: ['unified-chats']});
        void queryClient.invalidateQueries({queryKey: ['chat-lifecycle']});
      } catch (err) {
        toast.error(toApiError(err).message);
      } finally {
        setIsBulkPending(false);
      }
    },
    [queryClient, t.chats],
  );

  useEffect(() => {
    if (!selectedKey) {
      setRetainedChat(null);
      return;
    }
    const match = chats.find((c) => chatUniqueKey(c) === selectedKey);
    if (match) {
      setRetainedChat(match);
    }
  }, [chats, selectedKey]);

  const selectedChat = useMemo<UnifiedChat | null>(
    () =>
      resolveSelectedUnifiedChat({
        selectedKey,
        chats,
        retainedChat,
        adHocChat,
        accounts: resolvedAccounts,
      }),
    [adHocChat, chats, resolvedAccounts, retainedChat, selectedKey],
  );

  const paneLabel = useMemo(() => {
    if (pane.deviceIds.length === 0) return t.chats.columnTitle(index + 1);
    if (pane.deviceIds.length === 1) {
      const acc = resolvedAccounts.find((a) => a.id === pane.deviceIds[0]);
      return acc?.display_name ?? pane.deviceIds[0];
    }
    return t.chats.selectedAccountsCount(pane.deviceIds.length);
  }, [index, pane.deviceIds, resolvedAccounts, t.chats]);

  return (
    <section className="flex min-h-0 flex-col bg-card">
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-xs font-semibold text-foreground">{paneLabel}</span>
          {selectedChat && (
            <>
              <span className="text-xs text-muted-foreground">·</span>
              <span className="truncate text-xs text-muted-foreground">
                {chatDisplayName(selectedChat)}
              </span>
            </>
          )}
        </div>
        {canRemove && (
          <button
            type="button"
            className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            onClick={onRemove}
            title={t.chats.removeColumn}
            aria-label={t.chats.removeColumn}
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1">
        {selectedChat ? (
          <MessageView
            key={chatUniqueKey(selectedChat)}
            chat={selectedChat}
            alwaysShowBack
            otherAccounts={getOtherAccountsForChat(
              globalJidAccountsMap,
              selectedChat.device_id,
              selectedChat.jid,
            )}
            onSwitchAccount={(targetDeviceId, jid) => {
              setAdHocChat({deviceId: targetDeviceId, jid});
              setSelectedKey(`${targetDeviceId}::${jid}`);
            }}
            onBack={() => setSelectedKey(null)}
          />
        ) : (
          <ChatList
            chats={chats}
            chatLists={paginated.chatLists}
            accounts={resolvedAccounts}
            jidAccountsMap={globalJidAccountsMap}
            deviceErrors={deviceErrors}
            selectedKey={selectedKey}
            selectedDeviceIds={pane.deviceIds}
            search={search}
            hasMedia={hasMedia}
            activeTab={activeTab}
            tabCounts={paginated.tabCounts}
            canViewAll={canViewAll}
            canAssign={canAssign}
            canClose={canClose}
            assignedToFilter={assignedToFilter}
            isBulkPending={isBulkPending}
            totalChatsCount={paginated.totalCount}
            hasMore={paginated.hasMore}
            isLoadingMore={paginated.isLoadingMore}
            isLoading={query.isLoading}
            isFetching={query.isFetching}
            errorMessage={apiErr ? apiErr.message : null}
            onTabChange={setActiveTab}
            onAssignedToFilterChange={setAssignedToFilter}
            onBulkLifecycle={handleBulkLifecycle}
            onSelectedDeviceIdsChange={(ids) => {
              onDeviceIdsChange(ids);
              setSelectedKey(null);
            }}
            onSearchChange={setSearch}
            onHasMediaChange={setHasMedia}
            onRefresh={() => void paginated.refresh()}
            onLoadMore={() => void paginated.loadMore()}
            onOpenNewChat={canWriteChats ? () => setNewChatOpen(true) : undefined}
            onChatDeleted={(deleted) => {
              if (selectedKey === chatUniqueKey(deleted)) {
                setSelectedKey(null);
                setRetainedChat(null);
                setAdHocChat(null);
              }
            }}
            onSelect={(chat) => {
              const redacted = isChatRedactedForUser(chat, user?.id, canViewAll);
              if (!redacted) {
                paginated.markExtraChatRead(chat.device_id, chat.jid);
                queryClient.setQueriesData<UnifiedChatsResponse>(
                  {queryKey: ['unified-chats']},
                  (old) => {
                    if (!old) return old;
                    let removed = 0;
                    const nextData = old.data.map((item) => {
                      if (
                        item.device_id === chat.device_id &&
                        item.jid === chat.jid &&
                        (item.unread_count ?? 0) > 0
                      ) {
                        removed = item.unread_count ?? 0;
                        return {...item, unread_count: 0};
                      }
                      return item;
                    });
                    if (removed === 0) return old;
                    const totalUnread =
                      typeof old.total_unread === 'number'
                        ? Math.max(0, old.total_unread - removed)
                        : nextData.reduce((sum, item) => sum + (item.unread_count ?? 0), 0);
                    return {...old, data: nextData, total_unread: totalUnread};
                  },
                );
              }
              setAdHocChat(null);
              setRetainedChat(redacted ? chat : {...chat, unread_count: 0});
              setSelectedKey(chatUniqueKey(chat));
            }}
          />
        )}
      </div>

      {newChatOpen && (
        <Suspense fallback={null}>
          <NewChatDialog
            open={newChatOpen}
            onOpenChange={setNewChatOpen}
            accounts={resolvedAccounts}
            defaultDeviceId={pane.deviceIds[0]}
            onStartChat={(deviceId, jid) => {
              setAdHocChat({deviceId, jid});
              setSelectedKey(`${deviceId}::${jid}`);
            }}
          />
        </Suspense>
      )}
    </section>
  );
}

export default function ChatsPage() {
  const queryClient = useQueryClient();
  const {t} = useI18n();
  const user = useAuthStore((s) => s.user);
  const canWriteChats = hasUserPermission(user, 'chats:write');
  const canViewAll = hasUserPermission(user, 'chats:view_all');
  const canAssign = hasUserPermission(user, 'chats:assign');
  const canClose = hasUserPermission(user, 'chats:close');
  const canViewSettings = hasUserAnyPermission(user, ['settings:read', 'settings:write']);
  const [searchParams] = useSearchParams();
  const searchParamsKey = searchParams.toString();
  const lastAppliedParamsRef = useRef<string | null>(null);

  const [mode, setMode] = useState<WorkspaceMode>('unified');
  const [selectedDeviceIds, setSelectedDeviceIds] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [hasMedia, setHasMedia] = useState(false);
  const [activeTab, setActiveTab] = useState<UnifiedChatTab>(() =>
    canViewAll ? 'all' : 'pending',
  );
  const [assignedToFilter, setAssignedToFilter] = useState<'all' | 'me'>('all');
  const [isBulkPending, setIsBulkPending] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [retainedChat, setRetainedChat] = useState<UnifiedChat | null>(null);
  const [adHocChat, setAdHocChat] = useState<{deviceId: string; jid: string} | null>(null);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [mobileShowMessages, setMobileShowMessages] = useState(false);
  const [splitPanes, setSplitPanes] = useState<SplitPaneConfig[]>([]);

  const navigate = useNavigate();

  useEffect(() => {
    if (!canViewAll && activeTab === 'all') {
      setActiveTab('pending');
    }
  }, [activeTab, canViewAll]);

  useEffect(() => {
    if (lastAppliedParamsRef.current === searchParamsKey) return;
    lastAppliedParamsRef.current = searchParamsKey;

    const paramDevice = searchParams.get('device')?.trim() || '';
    const rawTarget = searchParams.get('jid')?.trim() || searchParams.get('phone')?.trim() || '';
    const resolvedJid = rawTarget ? toWhatsAppJid(rawTarget) : '';
    const lowerResolved = resolvedJid.toLowerCase();

    if (paramDevice && resolvedJid && lowerResolved.endsWith('@g.us')) {
      navigate(
        `/groups?device=${encodeURIComponent(paramDevice)}&jid=${encodeURIComponent(resolvedJid)}`,
        {replace: true},
      );
      return;
    }

    if (
      paramDevice &&
      resolvedJid &&
      !lowerResolved.endsWith('@newsletter') &&
      lowerResolved !== 'status@broadcast'
    ) {
      setMode('unified');
      setAdHocChat({deviceId: paramDevice, jid: resolvedJid});
      setSelectedKey(`${paramDevice}::${resolvedJid}`);
      setMobileShowMessages(true);
    } else if (paramDevice) {
      setMode('unified');
      setSelectedDeviceIds([paramDevice]);
      setSelectedKey(null);
      setAdHocChat(null);
      setMobileShowMessages(false);
    }
  }, [navigate, searchParams, searchParamsKey]);

  const effectiveAssignedTo =
    activeTab === 'me'
      ? 'me'
      : activeTab === 'open' && canViewAll
        ? assignedToFilter
        : undefined;

  const paginated = usePaginatedChats({
    deviceIds: selectedDeviceIds,
    search,
    hasMedia,
    tab: activeTab,
    assignedTo: effectiveAssignedTo,
  });
  const {query, chats, accounts, deviceErrors} = paginated;

  const apiErr = query.isError ? toApiError(query.error) : null;
  const hasActiveFilter =
    selectedDeviceIds.length > 0 || Boolean(search.trim()) || hasMedia;

  const globalChatsQuery = useQuery({
    queryKey: DEFAULT_UNIFIED_CHATS_QUERY_KEY,
    queryFn: () => listUnifiedChats({}),
    enabled: hasActiveFilter && !(apiErr && isGowaConnectionError(apiErr)),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const jidAccountsMap = useMemo(
    () => buildJidAccountsMap([...(globalChatsQuery.data?.data ?? []), ...chats]),
    [chats, globalChatsQuery.data?.data],
  );

  const handleBulkLifecycle = useCallback(
    async (action: 'close' | 'release' | 'reopen', selectedChats: UnifiedChat[]) => {
      setIsBulkPending(true);
      try {
        const res = await bulkUnifiedChatsLifecycle({
          action,
          items: selectedChats.map((c) => ({
            device_id: c.device_id,
            chat_jid: c.jid,
            cached_title: chatDisplayName(c),
          })),
        });
        const okCount = res.succeeded.length;
        const failCount = res.failed.length;
        if (failCount === 0) {
          toast.success(t.chats.bulkResultToast(okCount));
        } else if (okCount > 0) {
          toast.warning(t.chats.bulkPartialToast(okCount, okCount + failCount));
        } else {
          toast.error(res.failed[0]?.message || t.chats.bulkPartialToast(0, failCount));
        }
        await queryClient.invalidateQueries({queryKey: ['unified-chats']});
        void queryClient.invalidateQueries({queryKey: ['chat-lifecycle']});
      } catch (err) {
        toast.error(toApiError(err).message);
      } finally {
        setIsBulkPending(false);
      }
    },
    [queryClient, t.chats],
  );

  useEffect(() => {
    return onWsEvent((event) => {
      const code = (event.code || '').toUpperCase();
      const target = extractWsEventTarget(event);

      const invalidateChats = () => {
        if (!target.deviceId) {
          void queryClient.invalidateQueries({queryKey: ['unified-chats']});
          return;
        }
        const targetDeviceId = target.deviceId;
        void queryClient.invalidateQueries({
          predicate: (q) => {
            if (q.queryKey[0] !== 'unified-chats') return false;
            const filterIds = q.queryKey[1];
            return (
              !Array.isArray(filterIds) ||
              filterIds.length === 0 ||
              filterIds.includes(targetDeviceId)
            );
          },
        });
      };

      const invalidateScoped = (rootKey: string) => invalidateChatQueries(queryClient, rootKey, target);

      const revoke = extractWsRevokeTarget(event);
      if (revoke) {
        patchRevokedMessage(queryClient, revoke);
        invalidateChats();
        invalidateScoped('unified-messages');
        return;
      }

      if (
        code === 'MESSAGE_RECEIVED' ||
        code === 'MESSAGE' ||
        code === 'MESSAGE_UPDATED' ||
        code === 'MESSAGE_EDITED' ||
        code === 'MESSAGE.EDITED' ||
        code === 'MESSAGE_REVOKED' ||
        code === 'MESSAGE.REVOKED' ||
        code === 'MESSAGE_DELETED' ||
        code === 'MESSAGE.DELETED' ||
        code === 'MESSAGE_REVOKE' ||
        code === 'MESSAGE.REVOKE' ||
        code === 'CHAT_UPDATED'
      ) {
        const isGroupEvent = Boolean(target.chatJid?.toLowerCase().endsWith('@g.us'));
        if (!isGroupEvent) {
          invalidateChats();
          invalidateScoped('unified-messages');
        }
      } else if (
        code === 'LOGIN_SUCCESS' ||
        code === 'DEVICE_LOGGED_OUT' ||
        code === 'DEVICE_REMOVED' ||
        code === 'LIST_DEVICES'
      ) {
        invalidateChats();
        if (target.deviceId) {
          void queryClient.invalidateQueries({queryKey: ['unified-messages', target.deviceId]});
        } else {
          void queryClient.invalidateQueries({queryKey: ['unified-messages']});
        }
      } else if (code === 'CONVERSATION_NOTE_UPDATED') {
        invalidateScoped('unified-chat-notes');
      } else if (code === 'SCHEDULE_UPDATED') {
        invalidateScoped('unified-chat-schedules');
        void queryClient.invalidateQueries({queryKey: ['schedules']});
      } else if (code === 'CHAT_LIFECYCLE_UPDATED') {
        invalidateChats();
        invalidateScoped('chat-lifecycle');
        invalidateScoped('unified-messages');
        invalidateScoped('unified-chat-notes');
        invalidateScoped('unified-chat-schedules');
        void queryClient.invalidateQueries({queryKey: ['assignable-agents']});
      } else if (code === 'CHAT_DAILY_RESET') {
        invalidateChats();
        if (target.deviceId) {
          void queryClient.invalidateQueries({queryKey: ['chat-lifecycle', target.deviceId]});
          void queryClient.invalidateQueries({queryKey: ['unified-messages', target.deviceId]});
          void queryClient.invalidateQueries({queryKey: ['unified-chat-notes', target.deviceId]});
          void queryClient.invalidateQueries({queryKey: ['unified-chat-schedules', target.deviceId]});
        } else {
          void queryClient.invalidateQueries({queryKey: ['chat-lifecycle']});
          void queryClient.invalidateQueries({queryKey: ['unified-messages']});
        }
        void queryClient.invalidateQueries({queryKey: ['assignable-agents']});
      } else if (code === 'INBOX_POLICY_UPDATED') {
        void queryClient.invalidateQueries({queryKey: ['inbox-policy']});
      }
    });
  }, [queryClient]);

  useEffect(() => {
    if (!selectedKey) {
      setRetainedChat(null);
      return;
    }
    const match = chats.find((c) => chatUniqueKey(c) === selectedKey);
    if (match) {
      setRetainedChat(match);
    }
  }, [chats, selectedKey]);

  const selectedChat = useMemo<UnifiedChat | null>(
    () =>
      resolveSelectedUnifiedChat({
        selectedKey,
        chats,
        retainedChat,
        adHocChat,
        accounts,
      }),
    [accounts, adHocChat, chats, retainedChat, selectedKey],
  );

  const handleSwitchMode = (nextMode: WorkspaceMode) => {
    setMode(nextMode);
    if (nextMode === 'split' && splitPanes.length === 0) {
      setSplitPanes([
        {id: 'pane-1', deviceIds: accounts[0] ? [accounts[0].id] : []},
        {id: 'pane-2', deviceIds: accounts[1] ? [accounts[1].id] : []},
      ]);
    }
  };

  const handleAddPane = () => {
    if (splitPanes.length >= 3) return;
    const usedIds = new Set(splitPanes.flatMap((p) => p.deviceIds));
    const unusedAccount = accounts.find((a) => !usedIds.has(a.id));
    setSplitPanes((prev) => [
      ...prev,
      {
        id: `pane-${Date.now()}`,
        deviceIds: unusedAccount ? [unusedAccount.id] : [],
      },
    ]);
  };

  if (apiErr && isGowaConnectionError(apiErr)) {
    return (
      <GowaSetupNotice
        apiErr={apiErr}
        isAdmin={canViewSettings}
        onRetry={() => void query.refetch()}
      />
    );
  }

  const modeSwitcher = (
    <button
      type="button"
      onClick={() => handleSwitchMode(mode === 'unified' ? 'split' : 'unified')}
      title={mode === 'unified' ? t.chats.splitView : t.chats.unifiedView}
      aria-label={mode === 'unified' ? t.chats.splitView : t.chats.unifiedView}
      className={cn(
        'flex size-9 cursor-pointer items-center justify-center rounded-lg transition-colors focus-visible:outline-2 focus-visible:outline-ring',
        mode === 'split'
          ? 'bg-accent text-accent-foreground'
          : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
      )}
    >
      {mode === 'unified' ? <Columns2 className="size-4" /> : <PanelLeft className="size-4" />}
    </button>
  );

  if (mode === 'split') {
    return (
      <div className="flex h-full flex-col bg-background">
        <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border bg-card px-4">
          <div className="flex items-center gap-2">
            <h1 className="text-sm font-bold text-foreground">{t.chats.splitView}</h1>
          </div>
          <div className="flex items-center gap-2">
            {splitPanes.length < 3 && (
              <Button type="button" variant="outline" size="sm" onClick={handleAddPane}>
                <Plus className="size-3.5" />
                <span>{t.chats.addColumn}</span>
              </Button>
            )}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => handleSwitchMode('unified')}
            >
              <PanelLeft className="size-3.5" />
              <span>{t.chats.unifiedView}</span>
            </Button>
          </div>
        </div>

        <div
          className={cn(
            'grid min-h-0 flex-1 gap-px bg-border',
            splitPanes.length >= 3
              ? 'grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3'
              : 'grid-cols-1 lg:grid-cols-2',
          )}
        >
          {splitPanes.map((pane, idx) => (
            <SplitWorkspacePane
              key={pane.id}
              index={idx}
              pane={pane}
              globalJidAccountsMap={jidAccountsMap}
              canRemove={splitPanes.length > 2}
              canViewAll={canViewAll}
              canAssign={canAssign}
              canClose={canClose}
              onDeviceIdsChange={(deviceIds) => {
                setSplitPanes((prev) =>
                  prev.map((p) => (p.id === pane.id ? {...p, deviceIds} : p)),
                );
              }}
              onRemove={() => {
                setSplitPanes((prev) => prev.filter((p) => p.id !== pane.id));
              }}
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <>
      <SplitWorkspace
        storageKey={SIDEBAR_STORAGE_KEY}
        showDetailOnMobile={mobileShowMessages}
        sidebar={
          <ChatList
            headerTitle={t.chats.pageTitle}
            headerActions={modeSwitcher}
            chats={chats}
            chatLists={paginated.chatLists}
            accounts={accounts}
            jidAccountsMap={jidAccountsMap}
            deviceErrors={deviceErrors}
            selectedKey={selectedKey}
            selectedDeviceIds={selectedDeviceIds}
            search={search}
            hasMedia={hasMedia}
            activeTab={activeTab}
            tabCounts={paginated.tabCounts}
            canViewAll={canViewAll}
            canAssign={canAssign}
            canClose={canClose}
            assignedToFilter={assignedToFilter}
            isBulkPending={isBulkPending}
            totalChatsCount={paginated.totalCount}
            hasMore={paginated.hasMore}
            isLoadingMore={paginated.isLoadingMore}
            isLoading={query.isLoading}
            isFetching={query.isFetching}
            errorMessage={apiErr ? apiErr.message : null}
            onTabChange={setActiveTab}
            onAssignedToFilterChange={setAssignedToFilter}
            onBulkLifecycle={handleBulkLifecycle}
            onSelectedDeviceIdsChange={setSelectedDeviceIds}
            onSearchChange={setSearch}
            onHasMediaChange={setHasMedia}
            onRefresh={() => void paginated.refresh()}
            onLoadMore={() => void paginated.loadMore()}
            onOpenNewChat={canWriteChats ? () => setNewChatOpen(true) : undefined}
            onChatDeleted={(deleted) => {
              if (selectedKey === chatUniqueKey(deleted)) {
                setSelectedKey(null);
                setRetainedChat(null);
                setAdHocChat(null);
                setMobileShowMessages(false);
              }
            }}
            onSelect={(chat) => {
              const redacted = isChatRedactedForUser(chat, user?.id, canViewAll);
              if (!redacted) {
                paginated.markExtraChatRead(chat.device_id, chat.jid);
                queryClient.setQueriesData<UnifiedChatsResponse>(
                  {queryKey: ['unified-chats']},
                  (old) => {
                    if (!old) return old;
                    let removed = 0;
                    const nextData = old.data.map((item) => {
                      if (
                        item.device_id === chat.device_id &&
                        item.jid === chat.jid &&
                        (item.unread_count ?? 0) > 0
                      ) {
                        removed = item.unread_count ?? 0;
                        return {...item, unread_count: 0};
                      }
                      return item;
                    });
                    if (removed === 0) return old;
                    const totalUnread =
                      typeof old.total_unread === 'number'
                        ? Math.max(0, old.total_unread - removed)
                        : nextData.reduce((sum, item) => sum + (item.unread_count ?? 0), 0);
                    return {...old, data: nextData, total_unread: totalUnread};
                  },
                );
              }
              setAdHocChat(null);
              setRetainedChat(redacted ? chat : {...chat, unread_count: 0});
              setSelectedKey(chatUniqueKey(chat));
              setMobileShowMessages(true);
            }}
          />
        }
        detail={
          selectedChat ? (
            <MessageView
              key={chatUniqueKey(selectedChat)}
              chat={selectedChat}
              otherAccounts={getOtherAccountsForChat(
                jidAccountsMap,
                selectedChat.device_id,
                selectedChat.jid,
              )}
              onSwitchAccount={(targetDeviceId, jid) => {
                setAdHocChat({deviceId: targetDeviceId, jid});
                setSelectedKey(`${targetDeviceId}::${jid}`);
                setMobileShowMessages(true);
              }}
              onBack={() => setMobileShowMessages(false)}
            />
          ) : null
        }
        emptyState={
          <WorkspaceEmptyState
            icon={MessagesSquare}
            title={t.chats.selectChatPrompt}
            hint={t.chats.selectChatHint}
          />
        }
      />
      {newChatOpen && (
        <Suspense fallback={null}>
          <NewChatDialog
            open={newChatOpen}
            onOpenChange={setNewChatOpen}
            accounts={accounts}
            defaultDeviceId={selectedDeviceIds[0]}
            onStartChat={(deviceId, jid) => {
              setAdHocChat({deviceId, jid});
              setSelectedKey(`${deviceId}::${jid}`);
              setMobileShowMessages(true);
            }}
          />
        </Suspense>
      )}
    </>
  );
}
