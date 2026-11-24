import {useEffect, useMemo, useRef, useState} from 'react';
import {useQuery, useQueryClient} from '@tanstack/react-query';
import {
  Columns2,
  MessagesSquare,
  PanelLeft,
  Plus,
  X,
} from 'lucide-react';
import {useSearchParams} from 'react-router-dom';
import {listUnifiedChats} from '@/api/client';
import type {AccountSummary, UnifiedChat} from '@/api/types';
import {
  GowaSetupNotice,
  isGowaConnectionError,
  SplitWorkspace,
  WorkspaceEmptyState,
} from '@/components/layout/split-workspace';
import {Button} from '@/components/ui/button';
import {ChatList, chatUniqueKey} from '@/features/chat/chat-list';
import {chatDisplayName, formatJidPhone} from '@/features/chat/display-name';
import {MessageView} from '@/features/chat/message-view';
import {NewChatDialog} from '@/features/chat/new-chat-dialog';
import {
  buildJidAccountsMap,
  getOtherAccountsForChat,
  type OtherAccountRef,
} from '@/features/chat/other-accounts';
import {usePaginatedChats} from '@/features/chat/use-paginated-chats';
import {extractWsEventTarget, onWsEvent} from '@/lib/events';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';
import {toWhatsAppJid} from '@/lib/phone';
import {cn} from '@/lib/utils';
import {useAuthStore} from '@/stores/auth';

function buildFallbackUnifiedChat(
  deviceId: string,
  jid: string,
  accounts: AccountSummary[],
): UnifiedChat {
  const account = accounts.find((a) => a.id === deviceId);
  return {
    jid,
    name: formatJidPhone(jid) || jid,
    last_message_time: '',
    ephemeral_expiration: 0,
    created_at: '',
    updated_at: '',
    archived: false,
    device_id: deviceId,
    device_display_name: account?.display_name || deviceId,
    device_state: account?.state || 'disconnected',
    unread_count: 0,
  };
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
  accounts,
  globalJidAccountsMap,
  canRemove,
  onDeviceIdsChange,
  onRemove,
}: {
  index: number;
  pane: SplitPaneConfig;
  accounts: AccountSummary[];
  globalJidAccountsMap: Map<string, OtherAccountRef[]>;
  canRemove: boolean;
  onDeviceIdsChange: (deviceIds: string[]) => void;
  onRemove: () => void;
}) {
  const {t} = useI18n();
  const [search, setSearch] = useState('');
  const [hasMedia, setHasMedia] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [adHocChat, setAdHocChat] = useState<{deviceId: string; jid: string} | null>(null);
  const [newChatOpen, setNewChatOpen] = useState(false);

  const paginated = usePaginatedChats({
    deviceIds: pane.deviceIds,
    search,
    hasMedia,
  });
  const {query, chats, accounts: resolvedAccounts, deviceErrors} = paginated;
  const apiErr = query.isError ? toApiError(query.error) : null;

  const selectedChat = useMemo<UnifiedChat | null>(() => {
    if (!selectedKey) return null;
    const match = chats.find((c) => chatUniqueKey(c) === selectedKey);
    if (match) return match;
    if (adHocChat && `${adHocChat.deviceId}::${adHocChat.jid}` === selectedKey) {
      return buildFallbackUnifiedChat(adHocChat.deviceId, adHocChat.jid, resolvedAccounts);
    }
    return null;
  }, [adHocChat, chats, resolvedAccounts, selectedKey]);

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
            className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
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
            accounts={resolvedAccounts}
            jidAccountsMap={globalJidAccountsMap}
            deviceErrors={deviceErrors}
            selectedKey={selectedKey}
            selectedDeviceIds={pane.deviceIds}
            search={search}
            hasMedia={hasMedia}
            totalUnread={paginated.totalUnread}
            totalChatsCount={paginated.totalCount}
            hasMore={paginated.hasMore}
            isLoadingMore={paginated.isLoadingMore}
            isLoading={query.isLoading}
            isFetching={query.isFetching}
            errorMessage={apiErr ? apiErr.message : null}
            onSelectedDeviceIdsChange={(ids) => {
              onDeviceIdsChange(ids);
              setSelectedKey(null);
            }}
            onSearchChange={setSearch}
            onHasMediaChange={setHasMedia}
            onRefresh={() => void paginated.refresh()}
            onLoadMore={() => void paginated.loadMore()}
            onOpenNewChat={() => setNewChatOpen(true)}
            onSelect={(chat) => {
              paginated.markExtraChatRead(chat.device_id, chat.jid);
              setSelectedKey(chatUniqueKey(chat));
            }}
          />
        )}
      </div>

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
    </section>
  );
}

export default function ChatsPage() {
  const queryClient = useQueryClient();
  const {t} = useI18n();
  const user = useAuthStore((s) => s.user);
  const [searchParams] = useSearchParams();
  const searchParamsKey = searchParams.toString();
  const lastAppliedParamsRef = useRef<string | null>(null);

  const [mode, setMode] = useState<WorkspaceMode>('unified');
  const [selectedDeviceIds, setSelectedDeviceIds] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [hasMedia, setHasMedia] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [adHocChat, setAdHocChat] = useState<{deviceId: string; jid: string} | null>(null);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [mobileShowMessages, setMobileShowMessages] = useState(false);
  const [splitPanes, setSplitPanes] = useState<SplitPaneConfig[]>([]);

  useEffect(() => {
    if (lastAppliedParamsRef.current === searchParamsKey) return;
    lastAppliedParamsRef.current = searchParamsKey;

    const paramDevice = searchParams.get('device')?.trim() || '';
    const rawTarget = searchParams.get('jid')?.trim() || searchParams.get('phone')?.trim() || '';
    const resolvedJid = rawTarget ? toWhatsAppJid(rawTarget) : '';

    if (paramDevice && resolvedJid) {
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
  }, [searchParams, searchParamsKey]);

  const paginated = usePaginatedChats({
    deviceIds: selectedDeviceIds,
    search,
    hasMedia,
  });
  const {query, chats, accounts, deviceErrors} = paginated;

  const globalChatsQuery = useQuery({
    queryKey: ['unified-chats', [], '', false],
    queryFn: () => listUnifiedChats({}),
    staleTime: 20_000,
  });

  const jidAccountsMap = useMemo(
    () => buildJidAccountsMap([...(globalChatsQuery.data?.data ?? []), ...chats]),
    [chats, globalChatsQuery.data?.data],
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

      const invalidateScoped = (rootKey: string) => {
        if (target.deviceId && target.chatJid) {
          void queryClient.invalidateQueries({
            queryKey: [rootKey, target.deviceId, target.chatJid],
          });
        } else if (target.deviceId) {
          void queryClient.invalidateQueries({queryKey: [rootKey, target.deviceId]});
        } else {
          void queryClient.invalidateQueries({queryKey: [rootKey]});
        }
      };

      if (
        code === 'MESSAGE_RECEIVED' ||
        code === 'MESSAGE' ||
        code === 'MESSAGE_REACTION' ||
        code === 'MESSAGE_UPDATED' ||
        code === 'MESSAGE_EDITED' ||
        code === 'MESSAGE.EDITED' ||
        code === 'MESSAGE_REVOKED' ||
        code === 'MESSAGE.REVOKED' ||
        code === 'MESSAGE_DELETED' ||
        code === 'MESSAGE.DELETED' ||
        code === 'CHAT_UPDATED'
      ) {
        invalidateChats();
        invalidateScoped('unified-messages');
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
      }
    });
  }, [queryClient]);

  const selectedChat = useMemo<UnifiedChat | null>(() => {
    if (!selectedKey) return null;
    const match = chats.find((c) => chatUniqueKey(c) === selectedKey);
    if (match) return match;
    if (adHocChat && `${adHocChat.deviceId}::${adHocChat.jid}` === selectedKey) {
      return buildFallbackUnifiedChat(adHocChat.deviceId, adHocChat.jid, accounts);
    }
    return null;
  }, [accounts, adHocChat, chats, selectedKey]);

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

  const apiErr = query.isError ? toApiError(query.error) : null;

  if (apiErr && isGowaConnectionError(apiErr)) {
    return (
      <GowaSetupNotice
        apiErr={apiErr}
        isAdmin={user?.role === 'admin'}
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
        'flex size-9 cursor-pointer items-center justify-center rounded-full transition-colors',
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
              accounts={accounts}
              globalJidAccountsMap={jidAccountsMap}
              canRemove={splitPanes.length > 2}
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
          accounts={accounts}
          jidAccountsMap={jidAccountsMap}
          deviceErrors={deviceErrors}
          selectedKey={selectedKey}
          selectedDeviceIds={selectedDeviceIds}
          search={search}
          hasMedia={hasMedia}
          totalUnread={paginated.totalUnread}
          totalChatsCount={paginated.totalCount}
          hasMore={paginated.hasMore}
          isLoadingMore={paginated.isLoadingMore}
          isLoading={query.isLoading}
          isFetching={query.isFetching}
          errorMessage={apiErr ? apiErr.message : null}
          onSelectedDeviceIdsChange={setSelectedDeviceIds}
          onSearchChange={setSearch}
          onHasMediaChange={setHasMedia}
          onRefresh={() => void paginated.refresh()}
          onLoadMore={() => void paginated.loadMore()}
          onOpenNewChat={() => setNewChatOpen(true)}
          onSelect={(chat) => {
            paginated.markExtraChatRead(chat.device_id, chat.jid);
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
    </>
  );
}
