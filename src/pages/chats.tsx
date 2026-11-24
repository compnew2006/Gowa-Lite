import {useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent} from 'react';
import {useQuery, useQueryClient} from '@tanstack/react-query';
import {
  Columns2,
  MessagesSquare,
  PanelLeft,
  Plus,
  RefreshCw,
  Settings,
  Smartphone,
  X,
} from 'lucide-react';
import {Link} from 'react-router-dom';
import {listUnifiedChats} from '@/api/client';
import type {AccountSummary, UnifiedChat} from '@/api/types';
import {Button} from '@/components/ui/button';
import {ChatList, chatUniqueKey} from '@/features/chat/chat-list';
import {chatDisplayName} from '@/features/chat/display-name';
import {MessageView} from '@/features/chat/message-view';
import {onWsEvent} from '@/lib/events';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';
import {normalizeSearchInput} from '@/lib/phone';
import {cn} from '@/lib/utils';
import {useAuthStore} from '@/stores/auth';

type WorkspaceMode = 'unified' | 'split';

interface SplitPaneConfig {
  id: string;
  deviceIds: string[];
}

const SIDEBAR_STORAGE_KEY = 'gowa-lite:chat-sidebar-width';
const DEFAULT_SIDEBAR_WIDTH = 390;
const MIN_SIDEBAR_WIDTH = 280;
const MAX_SIDEBAR_WIDTH = 640;
const MIN_CONVERSATION_WIDTH = 320;

function clampSidebarWidth(width: number, containerWidth?: number): number {
  const dynamicMax =
    containerWidth && containerWidth > 0
      ? Math.max(
          MIN_SIDEBAR_WIDTH,
          Math.min(MAX_SIDEBAR_WIDTH, containerWidth - MIN_CONVERSATION_WIDTH),
        )
      : MAX_SIDEBAR_WIDTH;
  return Math.round(Math.min(dynamicMax, Math.max(MIN_SIDEBAR_WIDTH, width)));
}

function SplitWorkspacePane({
  index,
  pane,
  accounts,
  canRemove,
  onDeviceIdsChange,
  onRemove,
}: {
  index: number;
  pane: SplitPaneConfig;
  accounts: AccountSummary[];
  canRemove: boolean;
  onDeviceIdsChange: (deviceIds: string[]) => void;
  onRemove: () => void;
}) {
  const {t} = useI18n();
  const [search, setSearch] = useState('');
  const [hasMedia, setHasMedia] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const normalizedSearch = normalizeSearchInput(search);

  const query = useQuery({
    queryKey: ['unified-chats', pane.deviceIds, normalizedSearch, hasMedia],
    queryFn: () =>
      listUnifiedChats({
        deviceIds: pane.deviceIds.length > 0 ? pane.deviceIds : undefined,
        search: normalizedSearch || undefined,
        has_media: hasMedia || undefined,
      }),
    refetchInterval: 30_000,
  });

  const chats = query.data?.data ?? [];
  const resolvedAccounts = query.data?.accounts ?? accounts;
  const deviceErrors = query.data?.device_errors ?? [];
  const apiErr = query.isError ? toApiError(query.error) : null;

  const selectedChat = useMemo<UnifiedChat | null>(() => {
    if (!selectedKey) return null;
    return chats.find((c) => chatUniqueKey(c) === selectedKey) ?? null;
  }, [chats, selectedKey]);

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
            onBack={() => setSelectedKey(null)}
          />
        ) : (
          <ChatList
            chats={chats}
            accounts={resolvedAccounts}
            deviceErrors={deviceErrors}
            selectedKey={selectedKey}
            selectedDeviceIds={pane.deviceIds}
            search={search}
            hasMedia={hasMedia}
            totalUnread={query.data?.total_unread}
            isLoading={query.isLoading}
            isFetching={query.isFetching}
            errorMessage={apiErr ? apiErr.message : null}
            onSelectedDeviceIdsChange={(ids) => {
              onDeviceIdsChange(ids);
              setSelectedKey(null);
            }}
            onSearchChange={setSearch}
            onHasMediaChange={setHasMedia}
            onRefresh={() => void query.refetch()}
            onSelect={(chat) => setSelectedKey(chatUniqueKey(chat))}
          />
        )}
      </div>
    </section>
  );
}

export default function ChatsPage() {
  const queryClient = useQueryClient();
  const {lang, t} = useI18n();
  const user = useAuthStore((s) => s.user);
  const isRtl = lang === 'ar';

  const [mode, setMode] = useState<WorkspaceMode>('unified');
  const [selectedDeviceIds, setSelectedDeviceIds] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const [hasMedia, setHasMedia] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [mobileShowMessages, setMobileShowMessages] = useState(false);
  const [splitPanes, setSplitPanes] = useState<SplitPaneConfig[]>([]);
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    try {
      const saved = window.localStorage.getItem(SIDEBAR_STORAGE_KEY);
      if (saved) {
        const parsed = Number(saved);
        if (Number.isFinite(parsed)) {
          return clampSidebarWidth(parsed);
        }
      }
    } catch {
      // ignore storage access errors
    }
    return DEFAULT_SIDEBAR_WIDTH;
  });
  const [maxSidebarWidth, setMaxSidebarWidth] = useState(MAX_SIDEBAR_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const sidebarWidthRef = useRef(sidebarWidth);
  sidebarWidthRef.current = sidebarWidth;
  const cleanupDragRef = useRef<(() => void) | null>(null);
  const normalizedSearch = normalizeSearchInput(search);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(sidebarWidth));
    } catch {
      // ignore storage access errors
    }
  }, [sidebarWidth]);

  useEffect(() => {
    return () => {
      cleanupDragRef.current?.();
    };
  }, []);

  const handleResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    cleanupDragRef.current?.();

    const startX = event.clientX;
    const startWidth = sidebarWidthRef.current;
    const containerWidth = containerRef.current?.clientWidth;

    setIsResizing(true);
    document.body.classList.add('select-none');
    document.body.style.cursor = 'col-resize';

    const onPointerMove = (moveEvent: PointerEvent) => {
      const deltaX = moveEvent.clientX - startX;
      const rawWidth = isRtl ? startWidth - deltaX : startWidth + deltaX;
      setSidebarWidth(clampSidebarWidth(rawWidth, containerWidth));
    };

    const cleanup = () => {
      cleanupDragRef.current = null;
      setIsResizing(false);
      document.body.classList.remove('select-none');
      document.body.style.cursor = '';
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', cleanup);
      window.removeEventListener('pointercancel', cleanup);
    };

    cleanupDragRef.current = cleanup;
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', cleanup);
    window.addEventListener('pointercancel', cleanup);
  };

  const handleResetSidebarWidth = () => {
    const containerWidth = containerRef.current?.clientWidth;
    setSidebarWidth(clampSidebarWidth(DEFAULT_SIDEBAR_WIDTH, containerWidth));
  };

  const handleResizeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 32 : 16;
    const containerWidth = containerRef.current?.clientWidth;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      const delta = isRtl ? step : -step;
      setSidebarWidth((prev) => clampSidebarWidth(prev + delta, containerWidth));
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      const delta = isRtl ? -step : step;
      setSidebarWidth((prev) => clampSidebarWidth(prev + delta, containerWidth));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setSidebarWidth(MIN_SIDEBAR_WIDTH);
    } else if (event.key === 'End') {
      event.preventDefault();
      setSidebarWidth(clampSidebarWidth(MAX_SIDEBAR_WIDTH, containerWidth));
    }
  };

  const query = useQuery({
    queryKey: ['unified-chats', selectedDeviceIds, normalizedSearch, hasMedia],
    queryFn: () =>
      listUnifiedChats({
        deviceIds: selectedDeviceIds.length > 0 ? selectedDeviceIds : undefined,
        search: normalizedSearch || undefined,
        has_media: hasMedia || undefined,
      }),
    refetchInterval: 30_000,
  });

  useEffect(() => {
    return onWsEvent((event) => {
      if (
        event.code === 'MESSAGE_RECEIVED' ||
        event.code === 'MESSAGE_REACTION' ||
        event.code === 'MESSAGE_UPDATED' ||
        event.code === 'MESSAGE_REVOKED' ||
        event.code === 'MESSAGE_DELETED' ||
        event.code === 'CHAT_UPDATED' ||
        event.code === 'LOGIN_SUCCESS' ||
        event.code === 'DEVICE_LOGGED_OUT' ||
        event.code === 'DEVICE_REMOVED' ||
        event.code === 'LIST_DEVICES'
      ) {
        void queryClient.invalidateQueries({queryKey: ['unified-chats']});
        void queryClient.invalidateQueries({queryKey: ['unified-messages']});
      } else if (event.code === 'CONVERSATION_NOTE_UPDATED') {
        void queryClient.invalidateQueries({queryKey: ['unified-chat-notes']});
      } else if (event.code === 'SCHEDULE_UPDATED') {
        void queryClient.invalidateQueries({queryKey: ['unified-chat-schedules']});
        void queryClient.invalidateQueries({queryKey: ['schedules']});
      }
    });
  }, [queryClient]);

  const chats = query.data?.data ?? [];
  const accounts = query.data?.accounts ?? [];
  const deviceErrors = query.data?.device_errors ?? [];

  const selectedChat = useMemo<UnifiedChat | null>(() => {
    if (!selectedKey) return null;
    return chats.find((c) => chatUniqueKey(c) === selectedKey) ?? null;
  }, [chats, selectedKey]);

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
  const isGowaSetupError = Boolean(
    apiErr && (apiErr.code === 'GOWA_NOT_CONFIGURED' || apiErr.code === 'GOWA_UNREACHABLE'),
  );
  const hasUnifiedWorkspace = mode === 'unified' && !isGowaSetupError;

  useEffect(() => {
    if (!hasUnifiedWorkspace) return;
    const el = containerRef.current;
    if (!el) return;
    const updateBounds = () => {
      const width = el.clientWidth;
      if (width <= 0) return;
      const nextMax = Math.max(
        MIN_SIDEBAR_WIDTH,
        Math.min(MAX_SIDEBAR_WIDTH, width - MIN_CONVERSATION_WIDTH),
      );
      setMaxSidebarWidth(nextMax);
      setSidebarWidth((prev) => Math.min(nextMax, Math.max(MIN_SIDEBAR_WIDTH, prev)));
    };
    updateBounds();
    const observer = new ResizeObserver(updateBounds);
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasUnifiedWorkspace]);

  if (apiErr && isGowaSetupError) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-md rounded-xl border border-border bg-card p-6 text-center">
          <div className="mx-auto mb-3 flex size-11 items-center justify-center rounded-full bg-secondary text-muted-foreground">
            <Smartphone className="size-5" />
          </div>
          <h1 className="text-base font-semibold text-foreground">
            {apiErr.code === 'GOWA_NOT_CONFIGURED'
              ? t.chats.gowaNotConfiguredTitle
              : t.chats.gowaUnreachableTitle}
          </h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {apiErr.code === 'GOWA_NOT_CONFIGURED' ? t.chats.gowaNotConfiguredDesc : apiErr.message}
          </p>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            {user?.role === 'admin' && (
              <Link
                to="/settings"
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-xs font-medium text-primary-foreground hover:bg-primary/90"
              >
                <Settings className="size-3.5" />
                <span>{t.chats.goToSettings}</span>
              </Link>
            )}
            <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
              <RefreshCw className="size-3.5" />
              <span>{t.retry}</span>
            </Button>
          </div>
        </div>
      </div>
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
    <div
      ref={containerRef}
      style={{'--chat-sidebar-width': `${sidebarWidth}px`} as CSSProperties}
      className="flex h-full min-h-0 flex-col lg:flex-row"
    >
      {/* WhatsApp Chat List Sidebar */}
      <section
        className={cn(
          'relative h-full min-h-0 w-full border-e border-border bg-card lg:w-[var(--chat-sidebar-width)] lg:shrink-0',
          mobileShowMessages ? 'hidden lg:block lg:flex-none' : 'block flex-1 lg:flex-none',
        )}
      >
        <ChatList
          headerTitle={t.chats.pageTitle}
          headerActions={modeSwitcher}
          chats={chats}
          accounts={accounts}
          deviceErrors={deviceErrors}
          selectedKey={selectedKey}
          selectedDeviceIds={selectedDeviceIds}
          search={search}
          hasMedia={hasMedia}
          totalUnread={query.data?.total_unread}
          isLoading={query.isLoading}
          isFetching={query.isFetching}
          errorMessage={apiErr ? apiErr.message : null}
          onSelectedDeviceIdsChange={setSelectedDeviceIds}
          onSearchChange={setSearch}
          onHasMediaChange={setHasMedia}
          onRefresh={() => void query.refetch()}
          onSelect={(chat) => {
            setSelectedKey(chatUniqueKey(chat));
            setMobileShowMessages(true);
          }}
        />

        {/* Desktop Resizable Divider Handle */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t.chats.resizeSidebarAria}
          aria-valuemin={MIN_SIDEBAR_WIDTH}
          aria-valuemax={maxSidebarWidth}
          aria-valuenow={sidebarWidth}
          title={t.chats.resizeSidebarTitle}
          tabIndex={0}
          onPointerDown={handleResizePointerDown}
          onDoubleClick={handleResetSidebarWidth}
          onKeyDown={handleResizeKeyDown}
          className="group absolute inset-y-0 -end-[4px] z-20 hidden w-[8px] cursor-col-resize touch-none items-center justify-center focus-visible:outline-none lg:flex"
        >
          <span
            aria-hidden="true"
            className={cn(
              'h-full w-[3px] rounded-full transition-colors',
              isResizing
                ? 'bg-primary'
                : 'bg-transparent group-hover:bg-primary/60 group-focus-visible:bg-primary',
            )}
          />
        </div>
      </section>

      {/* WhatsApp Conversation Pane */}
      <section
        className={cn(
          'h-full min-h-0 min-w-0 flex-1 bg-chat-canvas',
          mobileShowMessages ? 'block' : 'hidden lg:block',
        )}
      >
        {selectedChat ? (
          <MessageView
            key={chatUniqueKey(selectedChat)}
            chat={selectedChat}
            onBack={() => setMobileShowMessages(false)}
          />
        ) : (
          <div className="wa-wallpaper flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <div className="flex size-16 items-center justify-center rounded-full bg-card/90 text-primary shadow-sm">
              <MessagesSquare className="size-7" />
            </div>
            <p className="text-base font-medium text-foreground">{t.chats.selectChatPrompt}</p>
            <p className="max-w-md text-xs text-muted-foreground">{t.chats.selectChatHint}</p>
          </div>
        )}
      </section>
    </div>
  );
}
