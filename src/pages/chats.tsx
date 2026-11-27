import {Suspense, lazy, useEffect, useMemo, useRef, useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {
  Columns2,
  MessagesSquare,
  PanelLeft,
  Plus,
  X,
} from 'lucide-react';
import {useNavigate, useSearchParams} from 'react-router-dom';
import {
  GowaSetupNotice,
  isGowaConnectionError,
  SplitWorkspace,
  WorkspaceEmptyState,
} from '@/components/layout/split-workspace';
import {Button} from '@/components/ui/button';
import {ChatList} from '@/features/chat/chat-list';
import {DeferredMessageView} from '@/features/chat/deferred-message-view';
import {chatDisplayName} from '@/features/chat/display-name';
import {createUnifiedChatsQueryOptions} from '@/features/chat/inbox-queries';
import {chatUniqueKey} from '@/features/chat/selected-chat';

import {
  buildJidAccountsMap,
  getOtherAccountsForChat,
  type OtherAccountRef,
} from '@/features/chat/other-accounts';
import {useInboxController} from '@/features/chat/use-inbox-controller';
import {useI18n} from '@/lib/i18n';
import {toWhatsAppJid} from '@/lib/phone';
import {cn} from '@/lib/utils';
import {hasUserAnyPermission, hasUserPermission, useAuthStore} from '@/stores/auth';

const NewChatDialog = lazy(() =>
  import('@/features/chat/new-chat-dialog').then((m) => ({default: m.NewChatDialog})),
);
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
  const {t} = useI18n();
  const user = useAuthStore((s) => s.user);
  const canWriteChats = hasUserPermission(user, 'chats:write');
  const {
    search, setSearch, hasMedia, setHasMedia, activeTab, setActiveTab,
    assignedToFilter, setAssignedToFilter, isBulkPending, selectedKey, chatOpenNonce,
    paginated, query, chats, accounts, deviceErrors, apiErr, selectedChat,
    handleBulkLifecycle, selectChat, openChat, clearSelection, forgetChat,
  } = useInboxController(pane.deviceIds, canViewAll);
  const [newChatOpen, setNewChatOpen] = useState(false);

  const paneLabel = useMemo(() => {
    if (pane.deviceIds.length === 0) return t.chats.columnTitle(index + 1);
    if (pane.deviceIds.length === 1) {
      const acc = accounts.find((a) => a.id === pane.deviceIds[0]);
      return acc?.display_name ?? pane.deviceIds[0];
    }
    return t.chats.selectedAccountsCount(pane.deviceIds.length);
  }, [index, pane.deviceIds, accounts, t.chats]);

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
          <DeferredMessageView
            key={chatUniqueKey(selectedChat)}
            chat={selectedChat}
            openNonce={chatOpenNonce}
            alwaysShowBack
            otherAccounts={getOtherAccountsForChat(
              globalJidAccountsMap,
              selectedChat.device_id,
              selectedChat.jid,
            )}
            onSwitchAccount={openChat}
            onBack={clearSelection}
          />
        ) : (
          <ChatList
            chats={chats}
            chatLists={paginated.chatLists}
            accounts={accounts}
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
              clearSelection();
            }}
            onSearchChange={setSearch}
            onHasMediaChange={setHasMedia}
            onRefresh={() => void paginated.refresh()}
            onLoadMore={() => void paginated.loadMore()}
            onOpenNewChat={canWriteChats ? () => setNewChatOpen(true) : undefined}
            onChatDeleted={forgetChat}
            onSelect={selectChat}
          />
        )}
      </div>

      {newChatOpen && (
        <Suspense fallback={null}>
          <NewChatDialog
            open={newChatOpen}
            onOpenChange={setNewChatOpen}
            accounts={accounts}
            defaultDeviceId={pane.deviceIds[0]}
            onStartChat={openChat}
          />
        </Suspense>
      )}
    </section>
  );
}

export default function ChatsPage() {
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
  const {
    search, setSearch, hasMedia, setHasMedia, activeTab, setActiveTab,
    assignedToFilter, setAssignedToFilter, isBulkPending, selectedKey, chatOpenNonce,
    paginated, query, chats, accounts, deviceErrors, apiErr, selectedChat,
    handleBulkLifecycle, selectChat, openChat, clearSelection, forgetChat,
  } = useInboxController(selectedDeviceIds, canViewAll);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [mobileShowMessages, setMobileShowMessages] = useState(false);
  const [splitPanes, setSplitPanes] = useState<SplitPaneConfig[]>([]);

  const navigate = useNavigate();

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
      if (openChat(paramDevice, resolvedJid)) setMobileShowMessages(true);
    } else if (paramDevice) {
      setMode('unified');
      setSelectedDeviceIds([paramDevice]);
      clearSelection();
      setMobileShowMessages(false);
    }
  }, [clearSelection, navigate, openChat, searchParams, searchParamsKey]);

  const hasActiveFilter =
    selectedDeviceIds.length > 0 || Boolean(search.trim()) || hasMedia;

  const globalChatsQuery = useQuery(createUnifiedChatsQueryOptions({
    options: {
      enabled: hasActiveFilter && !(apiErr && isGowaConnectionError(apiErr)),
      staleTime: 60_000,
      refetchOnWindowFocus: false,
    },
  }));

  const jidAccountsMap = useMemo(
    () => buildJidAccountsMap([...(globalChatsQuery.data?.data ?? []), ...chats]),
    [chats, globalChatsQuery.data?.data],
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
              if (forgetChat(deleted)) setMobileShowMessages(false);
            }}
            onSelect={(chat) => {
              selectChat(chat);
              setMobileShowMessages(true);
            }}
          />
        }
        detail={
          selectedChat ? (
            <DeferredMessageView
              key={chatUniqueKey(selectedChat)}
              chat={selectedChat}
              openNonce={chatOpenNonce}
              otherAccounts={getOtherAccountsForChat(
                jidAccountsMap,
                selectedChat.device_id,
                selectedChat.jid,
              )}
              onSwitchAccount={(targetDeviceId, jid) => {
                if (openChat(targetDeviceId, jid)) setMobileShowMessages(true);
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
              if (openChat(deviceId, jid)) setMobileShowMessages(true);
            }}
          />
        </Suspense>
      )}
    </>
  );
}
