import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import {useVirtualizer} from '@tanstack/react-virtual';
import {
  Archive,
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  Ban,
  BellOff,
  Check,
  CheckSquare,
  ChevronDown,
  Heart,
  ListFilter,
  Loader2,
  MessageSquarePlus,
  Pin,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react';
import {useQueryClient} from '@tanstack/react-query';
import {toast} from 'sonner';
import {
  archiveUnifiedChat,
  blockUnifiedChat,
  clearUnifiedChat,
  deleteUnifiedChat,
  favouriteUnifiedChat,
  muteUnifiedChat,
  pinUnifiedChat,
  setUnifiedChatUnread,
} from '@/api/client';
import type {
  AccountSummary,
  ChatListSummary,
  UnifiedChat,
  UnifiedChatTab,
  UnifiedTabCounts,
} from '@/api/types';
import {ContactAvatar, avatarToneClass} from '@/components/contact-avatar';
import {Button} from '@/components/ui/button';
import {Dialog} from '@/components/ui/dialog';
import {shortAccountWidgetLabel} from '@/features/accounts/account-display';
import {AccountMultiSelect} from '@/features/accounts/account-multi-select';
import {ChatListAssignDialog} from '@/features/chat/chat-list-assign-dialog';
import {ChatRowMenu, type ChatRowMenuAction} from '@/features/chat/chat-row-menu';
import {
  formatSecondaryChatPhone,
  shouldShowAccountFilter,
  shouldShowChatRowTimestamp,
  shouldShowRowAccountName,
  shouldShowRowLifecycle,
} from '@/features/chat/chat-ui-helpers';
import {shouldAutoLoadMore} from '@/features/chat/scroll-behavior';
import {BulkActionBar} from '@/features/chat/bulk-action-bar';
import {chatDisplayName, formatJidPhone} from '@/features/chat/display-name';
import type {BulkLifecycleAction} from '@/features/chat/use-inbox-controller';
import {
  buildJidAccountsMap,
  getOtherAccountsForChat,
  type OtherAccountRef,
} from '@/features/chat/other-accounts';
import {messageQueryKeys} from '@/features/chat/message-query-keys';
import {chatUniqueKey} from '@/features/chat/selected-chat';
import {UNIFIED_CHATS_QUERY_PREFIX} from '@/features/chat/inbox-query-keys';
import {formatShortTime} from '@/lib/format';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';
import {matchesNormalizedQuery} from '@/lib/phone';
import {cn} from '@/lib/utils';
import {hasUserPermission, useAuthStore} from '@/stores/auth';

export {avatarToneClass, chatUniqueKey};

export {AccountMultiSelect};
export {accountDotTone, shortAccountWidgetLabel} from '@/features/accounts/account-display';

interface ChatListRowProps {
  chat: UnifiedChat;
  isSelected: boolean;
  isMenuOpen: boolean;
  bulkMode: boolean;
  isBulkSelected: boolean;
  currentUserId?: number;
  activeTab?: UnifiedChatTab;
  showAccountName: boolean;
  otherAccounts: OtherAccountRef[];
  onToggleBulkItem: (key: string) => void;
  onSelect: (chat: UnifiedChat) => void;
  onOpenMenu: (chat: UnifiedChat, anchor: {x: number; y: number}) => void;
  // Virtualization: the row is absolutely positioned by the virtualizer.
  // rowTop is a primitive so memo() still skips unchanged rows; the style
  // object is built inside with useMemo instead of being passed in.
  rowTop?: number;
  rowIndex?: number;
  rowRef?: (node: HTMLLIElement | null) => void;
}

const EMPTY_OTHER_ACCOUNTS: OtherAccountRef[] = [];

const ChatListRow = memo(function ChatListRow({
  chat,
  isSelected,
  isMenuOpen,
  bulkMode,
  isBulkSelected,
  currentUserId,
  activeTab,
  showAccountName,
  otherAccounts,
  onToggleBulkItem,
  onSelect,
  onOpenMenu,
  rowTop,
  rowIndex,
  rowRef,
}: ChatListRowProps) {
  const {isRtl, lang, t} = useI18n();
  const rowStyle = useMemo<CSSProperties | undefined>(
    () =>
      rowTop === undefined
        ? undefined
        : {
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            transform: `translateY(${rowTop}px)`,
          },
    [rowTop],
  );
  const key = chatUniqueKey(chat);
  const name = chatDisplayName(chat);
  const secondaryPhone = formatSecondaryChatPhone(name, formatJidPhone(chat.jid));
  const unreadCount = Math.max(0, chat.unread_count ?? 0);
  const hasUnread = unreadCount > 0;
  const isPinned = Boolean(chat.is_pinned);
  const isBlocked = Boolean(chat.is_blocked);
  const isMuted = Boolean(
    chat.muted_until_ms && (chat.muted_until_ms === -1 || chat.muted_until_ms > Date.now()),
  );
  const timeLabel = shouldShowChatRowTimestamp(chat)
    ? formatShortTime(chat.last_message_time, lang)
    : '';

  const lifecycle = chat.lifecycle;
  const lcStatus = lifecycle?.status ?? 'pending';
  const showLifecycle = shouldShowRowLifecycle(activeTab, lcStatus);
  const isMine =
    lcStatus === 'open' && currentUserId !== undefined && lifecycle?.assigned_user_id === currentUserId;
  const lifecycleLabel =
    lcStatus === 'closed'
      ? t.chats.lifecycleClosed
      : lcStatus === 'open'
        ? isMine
          ? t.chats.lifecycleOpenAssignedYou
          : lifecycle?.assigned_user_name || t.chats.lifecyclePending
        : t.chats.lifecyclePending;
  const lifecycleColor =
    lcStatus === 'closed'
      ? 'text-muted-foreground'
      : lcStatus === 'open'
        ? 'text-emerald-700 dark:text-emerald-400'
        : 'text-amber-700 dark:text-amber-400';

  return (
    <li ref={rowRef} data-index={rowIndex} style={rowStyle} className="chat-list-row">
      <div
        onContextMenu={(event) => {
          if (bulkMode) return;
          event.preventDefault();
          onOpenMenu(chat, {x: event.clientX, y: event.clientY});
        }}
        className={cn(
          'group relative flex w-full items-center gap-2 rounded-xl px-2.5 py-2 transition-colors',
          isSelected || isMenuOpen ? 'bg-secondary' : 'hover:bg-secondary/60',
          bulkMode && isBulkSelected && 'bg-primary/10',
        )}
      >
        {bulkMode && (
          <button
            type="button"
            role="checkbox"
            aria-checked={isBulkSelected}
            aria-label={name}
            onClick={() => onToggleBulkItem(key)}
            className={cn(
              'flex size-5 shrink-0 cursor-pointer items-center justify-center rounded border transition-colors focus-visible:outline-2 focus-visible:outline-ring',
              isBulkSelected
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-input bg-card text-transparent hover:border-primary/60',
            )}
          >
            <Check className="size-3.5 stroke-[2.5]" />
          </button>
        )}

        <button
          type="button"
          onClick={() => (bulkMode ? onToggleBulkItem(key) : onSelect(chat))}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-lg text-start focus-visible:outline-2 focus-visible:outline-ring"
        >
          <ContactAvatar
            deviceId={chat.device_id}
            jid={chat.jid}
            name={name}
            sizeClass="size-11"
          />

          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-2">
              <span
                className={cn(
                  'truncate text-[14.5px] text-foreground',
                  hasUnread ? 'font-semibold' : 'font-medium',
                )}
              >
                {name}
              </span>
              {timeLabel && (
                <span
                  className={cn(
                    'shrink-0 text-[11px] tabular-nums',
                    hasUnread ? 'font-semibold text-live' : 'text-muted-foreground',
                  )}
                >
                  {timeLabel}
                </span>
              )}
            </div>

            {secondaryPhone && (
              <p
                dir="ltr"
                className="mt-0.5 truncate text-start font-mono text-[11px] text-muted-foreground tabular-nums"
              >
                {secondaryPhone}
              </p>
            )}

            {(showAccountName ||
              showLifecycle ||
              hasUnread ||
              isPinned ||
              isMuted ||
              isBlocked) && (
              <div className="mt-1 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                {showAccountName && (
                  <span
                    title={chat.device_display_name}
                    className="min-w-0 max-w-[50%] truncate font-medium text-foreground/80"
                  >
                    {shortAccountWidgetLabel(chat.device_display_name)}
                  </span>
                )}
                {showAccountName && showLifecycle && (
                  <span aria-hidden="true" className="text-border">·</span>
                )}
                {showLifecycle && (
                  <span className={cn('min-w-0 truncate font-medium', lifecycleColor)}>
                    {lifecycleLabel}
                  </span>
                )}

                <span className="ms-auto flex shrink-0 items-center gap-1.5">
                  {isBlocked && (
                    <span title={t.chats.blockedBadge} aria-label={t.chats.blockedBadge}>
                      <Ban className="size-3.5 text-destructive/80" />
                    </span>
                  )}
                  {isMuted && (
                    <span title={t.chats.mutedBadge} aria-label={t.chats.mutedBadge}>
                      <BellOff className="size-3.5 text-muted-foreground" />
                    </span>
                  )}
                  {isPinned && (
                    <span title={t.chats.pinnedBadge} aria-label={t.chats.pinnedBadge}>
                      <Pin className="size-3.5 text-muted-foreground" />
                    </span>
                  )}
                  {hasUnread && (
                    <span
                      aria-label={t.chats.unreadLabel(unreadCount)}
                      title={t.chats.unreadLabel(unreadCount)}
                      className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-live px-1.5 text-[11px] font-semibold text-white tabular-nums"
                    >
                      {String(unreadCount)}
                    </span>
                  )}
                </span>
              </div>
            )}

            {otherAccounts.length > 0 && (
              <p
                title={t.chats.alsoOnOtherAccount(
                  otherAccounts
                    .map((a) => shortAccountWidgetLabel(a.device_display_name))
                    .join('، '),
                )}
                className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] font-medium text-amber-700 dark:text-amber-400"
              >
                <ArrowLeftRight className="size-3 shrink-0" />
                <span className="truncate">
                  {t.chats.alsoOnOtherAccount(
                    otherAccounts
                      .map((a) => shortAccountWidgetLabel(a.device_display_name))
                      .join('، '),
                  )}
                </span>
              </p>
            )}
          </div>
        </button>

        {!bulkMode && (
          <button
            type="button"
            aria-label={t.chats.chatActionsMenu}
            title={t.chats.chatActionsMenu}
            aria-haspopup="menu"
            aria-expanded={isMenuOpen}
            onClick={(event) => {
              event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              onOpenMenu(chat, {
                x: isRtl ? rect.left : rect.right,
                y: rect.bottom + 4,
              });
            }}
            className={cn(
              'flex shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-full text-muted-foreground transition-all hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring',
              isMenuOpen
                ? 'size-6 opacity-100'
                : 'w-0 opacity-0 group-hover:w-6 group-hover:h-6 group-hover:opacity-100 group-focus-within:w-6 group-focus-within:h-6 group-focus-within:opacity-100 focus-visible:w-6 focus-visible:h-6 focus-visible:opacity-100',
            )}
          >
            <ChevronDown className="size-4 shrink-0" />
          </button>
        )}
      </div>
    </li>
  );
});

export function ChatList({
  headerTitle,
  headerActions,
  chats,
  chatLists = [],
  accounts,
  jidAccountsMap,
  selectedKey,
  selectedDeviceIds,
  search,
  hasMedia,
  activeTab,
  tabCounts,
  canViewAll = false,
  canAssign = false,
  canClose = false,
  assignedToFilter = 'all',
  isBulkPending = false,
  totalChatsCount,
  hasMore = false,
  isLoadingMore = false,
  isLoading,
  isFetching,
  errorMessage,
  onTabChange,
  onAssignedToFilterChange,
  onBulkLifecycle,
  onSelectedDeviceIdsChange,
  onSearchChange,
  onHasMediaChange,
  onRefresh,
  onLoadMore,
  onOpenNewChat,
  onChatCleared,
  onChatDeleted,
  onSelect,
}: {
  headerTitle?: string;
  headerActions?: ReactNode;
  chats: UnifiedChat[];
  chatLists?: ChatListSummary[];
  accounts: AccountSummary[];
  jidAccountsMap?: Map<string, OtherAccountRef[]>;
  deviceErrors?: Array<{device_id: string; display_name: string; message: string}>;
  selectedKey: string | null;
  selectedDeviceIds: string[];
  search: string;
  hasMedia: boolean;
  activeTab?: UnifiedChatTab;
  tabCounts?: UnifiedTabCounts;
  canViewAll?: boolean;
  canAssign?: boolean;
  canClose?: boolean;
  assignedToFilter?: 'all' | 'me';
  isBulkPending?: boolean;
  totalChatsCount?: number;
  hasMore?: boolean;
  isLoadingMore?: boolean;
  isLoading: boolean;
  isFetching: boolean;
  errorMessage: string | null;
  onTabChange?: (tab: UnifiedChatTab) => void;
  onAssignedToFilterChange?: (filter: 'all' | 'me') => void;
  onBulkLifecycle?: (
    action: BulkLifecycleAction,
    selectedChats: UnifiedChat[],
  ) => Promise<void>;
  onSelectedDeviceIdsChange: (deviceIds: string[]) => void;
  onSearchChange: (value: string) => void;
  onHasMediaChange: (value: boolean) => void;
  onRefresh: () => void;
  onLoadMore?: () => void;
  onOpenNewChat?: () => void;
  onChatCleared?: (chat: UnifiedChat) => void;
  onChatDeleted?: (chat: UnifiedChat) => void;
  onSelect: (chat: UnifiedChat) => void;
}) {
  const queryClient = useQueryClient();
  const {isRtl, t} = useI18n();
  const user = useAuthStore((s) => s.user);
  const canWriteChats = hasUserPermission(user, 'chats:write');
  const canRevokeChats = hasUserPermission(user, 'chats:revoke');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [favouritesOnly, setFavouritesOnly] = useState(false);
  const [selectedListId, setSelectedListId] = useState<number | null>(null);
  const [archivedOnly, setArchivedOnly] = useState(false);
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkSelectedKeys, setBulkSelectedKeys] = useState<Set<string>>(() => new Set());
  const [menuState, setMenuState] = useState<{
    chat: UnifiedChat;
    anchor: {x: number; y: number};
  } | null>(null);
  const [confirmAction, setConfirmAction] = useState<{
    kind: 'block' | 'unblock' | 'clear' | 'delete';
    chat: UnifiedChat;
  } | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [listAssignChat, setListAssignChat] = useState<UnifiedChat | null>(null);
  const tabRefs = useRef<Partial<Record<UnifiedChatTab, HTMLButtonElement | null>>>({});
  const listScrollRef = useRef<HTMLDivElement>(null);
  // onSelect / onLoadMore arrive as fresh inline closures from the page on
  // every render; routing them through refs keeps the row callbacks (and
  // therefore ChatListRow's memo) stable.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onLoadMoreRef = useRef(onLoadMore);
  onLoadMoreRef.current = onLoadMore;
  const handleSelectRow = useCallback((chat: UnifiedChat) => {
    onSelectRef.current(chat);
  }, []);

  const availableTabs = useMemo(() => {
    const list: Array<{id: UnifiedChatTab; label: string; count?: number}> = [];
    if (canViewAll) {
      list.push({id: 'all', label: t.chats.tabAll, count: tabCounts?.all});
    }
    list.push({id: 'me', label: t.chats.tabMe, count: tabCounts?.me});
    list.push({id: 'open', label: t.chats.tabOpen, count: tabCounts?.open});
    list.push({id: 'pending', label: t.chats.tabPending, count: tabCounts?.pending});
    list.push({id: 'closed', label: t.chats.tabClosed, count: tabCounts?.closed});
    return list;
  }, [
    canViewAll,
    t.chats.tabAll,
    t.chats.tabClosed,
    t.chats.tabMe,
    t.chats.tabOpen,
    t.chats.tabPending,
    tabCounts,
  ]);

  useEffect(() => {
    if (selectedListId !== null && !chatLists.some((l) => l.id === selectedListId)) {
      setSelectedListId(null);
    }
  }, [chatLists, selectedListId]);

  const isAllFilterReset =
    !hasMedia &&
    !unreadOnly &&
    !favouritesOnly &&
    selectedListId === null &&
    !archivedOnly &&
    selectedDeviceIds.length === 0;
  const showAccountFilter = shouldShowAccountFilter(accounts.length, selectedDeviceIds.length);
  const showRowAccountName = shouldShowRowAccountName(accounts.length);
  const resolvedJidAccountsMap = useMemo(
    () => jidAccountsMap ?? buildJidAccountsMap(chats),
    [chats, jidAccountsMap],
  );

  const archivedCount = useMemo(
    () => chats.filter((chat) => Boolean(chat.archived)).length,
    [chats],
  );

  const visibleChats = useMemo(() => {
    let filtered = chats;
    if (archivedOnly) {
      filtered = filtered.filter((chat) => Boolean(chat.archived));
    } else if (!search.trim() && !favouritesOnly && selectedListId === null && !unreadOnly) {
      filtered = filtered.filter((chat) => !chat.archived);
    }
    if (unreadOnly) {
      filtered = filtered.filter((chat) => (chat.unread_count ?? 0) > 0);
    }
    if (favouritesOnly) {
      filtered = filtered.filter((chat) => Boolean(chat.is_favourite));
    }
    if (selectedListId !== null) {
      filtered = filtered.filter((chat) => chat.list_ids?.includes(selectedListId));
    }
    if (!search.trim()) return filtered;
    return filtered.filter((chat) =>
      matchesNormalizedQuery(
        [chatDisplayName(chat), formatJidPhone(chat.jid), chat.jid, chat.device_display_name],
        search,
      ),
    );
  }, [archivedOnly, chats, favouritesOnly, search, selectedListId, unreadOnly]);

  // Stable per-chat other-account arrays: getOtherAccountsForChat returns a
  // fresh array every call, which would defeat ChatListRow's memo.
  const otherAccountsByKey = useMemo(() => {
    const map = new Map<string, OtherAccountRef[]>();
    for (const chat of visibleChats) {
      map.set(
        chatUniqueKey(chat),
        getOtherAccountsForChat(resolvedJidAccountsMap, chat.device_id, chat.jid),
      );
    }
    return map;
  }, [resolvedJidAccountsMap, visibleChats]);

  // Virtualized rows: only the visible window (+ overscan) is in the DOM.
  // Rows are variable height (name / phone / account / lifecycle lines), so
  // they are measured live; 72px matches the CSS contain-intrinsic-size.
  const rowVirtualizer = useVirtualizer<HTMLDivElement, HTMLLIElement>({
    count: visibleChats.length,
    getScrollElement: () => listScrollRef.current,
    estimateSize: () => 72,
    overscan: 8,
    gap: 2,
    getItemKey: (index) => chatUniqueKey(visibleChats[index]),
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const lastVirtualIndex =
    virtualRows.length > 0 ? virtualRows[virtualRows.length - 1].index : -1;

  // Auto-fetch the next server page when the rendered window reaches the end,
  // so the user never has to scroll through empty space to find the button.
  // The manual load-more button below stays as the fallback.
  useEffect(() => {
    if (
      shouldAutoLoadMore({
        lastRenderedIndex: lastVirtualIndex,
        totalCount: visibleChats.length,
        hasMore,
        isLoadingMore,
      })
    ) {
      onLoadMoreRef.current?.();
    }
  }, [hasMore, isLoadingMore, lastVirtualIndex, visibleChats.length]);

  const activeListAssignChat = useMemo(() => {
    if (!listAssignChat) return null;
    const key = chatUniqueKey(listAssignChat);
    return chats.find((c) => chatUniqueKey(c) === key) ?? listAssignChat;
  }, [chats, listAssignChat]);

  const invalidateChats = useCallback(() => {
    void queryClient.invalidateQueries({queryKey: UNIFIED_CHATS_QUERY_PREFIX});
  }, [queryClient]);

  const handleOpenMenu = useCallback((chat: UnifiedChat, anchor: {x: number; y: number}) => {
    setMenuState({chat, anchor});
  }, []);

  const handleMenuAction = useCallback(
    async (chat: UnifiedChat, action: ChatRowMenuAction) => {
      try {
        switch (action.type) {
          case 'archive': {
            await archiveUnifiedChat(chat.device_id, chat.jid, action.archived);
            toast.success(action.archived ? t.chats.archivedToast : t.chats.unarchivedToast);
            invalidateChats();
            break;
          }
          case 'pin': {
            await pinUnifiedChat(chat.device_id, chat.jid, action.pinned);
            toast.success(action.pinned ? t.chats.pinnedToast : t.chats.unpinnedToast);
            invalidateChats();
            break;
          }
          case 'mute': {
            await muteUnifiedChat(chat.device_id, chat.jid, action.duration);
            toast.success(
              action.duration === 'unmute' ? t.chats.unmutedToast : t.chats.mutedToast,
            );
            invalidateChats();
            break;
          }
          case 'unread': {
            await setUnifiedChatUnread(chat.device_id, chat.jid, action.unread);
            toast.success(action.unread ? t.chats.markedUnreadToast : t.chats.markedReadToast);
            invalidateChats();
            break;
          }
          case 'favourite': {
            await favouriteUnifiedChat(chat.device_id, chat.jid, action.favourite);
            toast.success(
              action.favourite ? t.chats.favouriteAddedToast : t.chats.favouriteRemovedToast,
            );
            invalidateChats();
            break;
          }
          case 'add_to_list': {
            setListAssignChat(chat);
            break;
          }
          case 'block': {
            setConfirmAction({kind: action.blocked ? 'block' : 'unblock', chat});
            break;
          }
          case 'clear': {
            setConfirmAction({kind: 'clear', chat});
            break;
          }
          case 'delete': {
            setConfirmAction({kind: 'delete', chat});
            break;
          }
        }
      } catch (err) {
        toast.error(toApiError(err).message);
      }
    },
    [invalidateChats, t.chats],
  );

  const handleRunConfirmedAction = useCallback(async () => {
    if (!confirmAction || confirmBusy) return;
    setConfirmBusy(true);
    try {
      const {kind, chat} = confirmAction;
      if (kind === 'block' || kind === 'unblock') {
        const blocked = kind === 'block';
        await blockUnifiedChat(chat.device_id, chat.jid, blocked);
        toast.success(blocked ? t.chats.blockedToast : t.chats.unblockedToast);
        invalidateChats();
      } else if (kind === 'clear') {
        await clearUnifiedChat(chat.device_id, chat.jid);
        toast.success(t.chats.clearedToast);
        void queryClient.invalidateQueries({
          queryKey: messageQueryKeys.chat(chat.device_id, chat.jid),
        });
        invalidateChats();
        onChatCleared?.(chat);
      } else if (kind === 'delete') {
        await deleteUnifiedChat(chat.device_id, chat.jid);
        toast.success(t.chats.deletedToast);
        void queryClient.removeQueries({
          queryKey: messageQueryKeys.chat(chat.device_id, chat.jid),
        });
        invalidateChats();
        onChatDeleted?.(chat);
      }
      setConfirmAction(null);
    } catch (err) {
      toast.error(toApiError(err).message);
    } finally {
      setConfirmBusy(false);
    }
  }, [confirmAction, confirmBusy, invalidateChats, onChatCleared, onChatDeleted, queryClient, t.chats]);

  useEffect(() => {
    setBulkSelectedKeys(new Set());
  }, [activeTab]);

  const canBulk = Boolean(onBulkLifecycle) && (canClose || canAssign);

  const handleToggleBulkItem = useCallback((key: string) => {
    setBulkSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const selectedBulkChats = useMemo(
    () => visibleChats.filter((c) => bulkSelectedKeys.has(chatUniqueKey(c))),
    [bulkSelectedKeys, visibleChats],
  );

  const handleRunBulk = async (action: BulkLifecycleAction) => {
    if (!onBulkLifecycle || selectedBulkChats.length === 0 || isBulkPending) return;
    await onBulkLifecycle(action, selectedBulkChats);
    setBulkSelectedKeys(new Set());
    setBulkMode(false);
  };

  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
    if (availableTabs.length <= 1 || !onTabChange) return;
    let nextIndex = -1;
    const prevKey = isRtl ? 'ArrowRight' : 'ArrowLeft';
    const nextKey = isRtl ? 'ArrowLeft' : 'ArrowRight';
    if (event.key === nextKey) {
      nextIndex = (currentIndex + 1) % availableTabs.length;
    } else if (event.key === prevKey) {
      nextIndex = (currentIndex - 1 + availableTabs.length) % availableTabs.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = availableTabs.length - 1;
    }
    if (nextIndex !== -1) {
      event.preventDefault();
      const targetTab = availableTabs[nextIndex];
      onTabChange(targetTab.id);
      tabRefs.current[targetTab.id]?.focus();
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      {/* Top Sidebar Header */}
      {headerTitle && (
        <div className="flex h-[58px] shrink-0 items-center justify-between gap-2 px-4">
          <h1 className="min-w-0 truncate text-xl font-bold tracking-tight text-foreground">
            {headerTitle}
          </h1>
          <div className="flex items-center gap-1">
            {canBulk && (
              <button
                type="button"
                onClick={() => {
                  setBulkMode((prev) => {
                    if (prev) setBulkSelectedKeys(new Set());
                    return !prev;
                  });
                }}
                aria-pressed={bulkMode}
                title={bulkMode ? t.chats.bulkCancelSelect : t.chats.bulkSelectToggle}
                aria-label={bulkMode ? t.chats.bulkCancelSelect : t.chats.bulkSelectToggle}
                className={cn(
                  'flex size-9 cursor-pointer items-center justify-center rounded-lg transition-colors focus-visible:outline-2 focus-visible:outline-ring',
                  bulkMode
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                )}
              >
                <CheckSquare className="size-4" />
              </button>
            )}
            {onOpenNewChat && (
              <button
                type="button"
                onClick={onOpenNewChat}
                title={t.chats.newChatBtn}
                aria-label={t.chats.newChatBtn}
                className="flex size-9 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              >
                <MessageSquarePlus className="size-4" />
              </button>
            )}
            {headerActions}
            <button
              type="button"
              onClick={onRefresh}
              disabled={isFetching}
              title={t.chats.refreshChatsTitle}
              aria-label={t.chats.refreshChatsTitle}
              className="flex size-9 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
            >
              <RefreshCw className={cn('size-4', isFetching && 'animate-spin')} />
            </button>
          </div>
        </div>
      )}

      {/* Tabs, Search & Filter Strip */}
      <div className={cn('flex flex-col gap-2 px-3 pb-2', !headerTitle && 'pt-3')}>

        {activeTab && onTabChange && (
          <div
            role="tablist"
            aria-label={t.chats.tabsLabel}
            className="flex flex-wrap items-center gap-1 border-b border-border/80 pb-1.5"
          >
            {availableTabs.map((tabItem, idx) => {
              const isActive = activeTab === tabItem.id;
              return (
                <button
                  key={tabItem.id}
                  ref={(el) => {
                    tabRefs.current[tabItem.id] = el;
                  }}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  tabIndex={isActive ? 0 : -1}
                  onClick={() => onTabChange(tabItem.id)}
                  onKeyDown={(e) => handleTabKeyDown(e, idx)}
                  className={cn(
                    'flex min-w-fit flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-ring',
                    isActive
                      ? 'bg-accent text-accent-foreground font-semibold'
                      : 'text-muted-foreground hover:bg-secondary/70 hover:text-foreground',
                  )}
                >
                  <span>{tabItem.label}</span>
                  {typeof tabItem.count === 'number' && (
                    <span
                      className={cn(
                        'text-[11px] font-semibold tabular-nums',
                        isActive ? 'text-accent-foreground' : 'text-muted-foreground',
                      )}
                    >
                      {tabItem.count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {activeTab === 'open' && canViewAll && onAssignedToFilterChange && (
          <div className="flex items-center gap-1 rounded-lg bg-secondary/60 p-1 text-xs">
            <button
              type="button"
              onClick={() => onAssignedToFilterChange('all')}
              className={cn(
                'flex-1 cursor-pointer rounded-md px-2 py-1 font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-ring',
                assignedToFilter === 'all'
                  ? 'bg-card text-foreground shadow-2xs'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t.chats.meFilterAllAssigned}
            </button>
            <button
              type="button"
              onClick={() => onAssignedToFilterChange('me')}
              className={cn(
                'flex-1 cursor-pointer rounded-md px-2 py-1 font-medium whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-ring',
                assignedToFilter === 'me'
                  ? 'bg-card text-foreground shadow-2xs'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t.chats.meFilterMineOnly}
            </button>
          </div>
        )}

        <div className="relative">
          <Search className="pointer-events-none absolute start-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={t.chats.searchChatsPlaceholder}
            className="h-9 w-full rounded-full bg-secondary ps-10 pe-4 text-sm text-foreground placeholder:text-muted-foreground transition-colors hover:bg-muted focus-visible:bg-card focus-visible:outline-2 focus-visible:outline-ring"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => {
              onHasMediaChange(false);
              setUnreadOnly(false);
              setFavouritesOnly(false);
              setSelectedListId(null);
              setArchivedOnly(false);
              onSelectedDeviceIdsChange([]);
            }}
            className={cn(
              'h-8 cursor-pointer rounded-full border px-3 text-xs font-medium whitespace-nowrap shrink-0 transition-colors focus-visible:outline-2 focus-visible:outline-ring',
              isAllFilterReset
                ? 'border-primary/25 bg-accent text-accent-foreground'
                : 'border-border bg-card text-muted-foreground hover:bg-secondary hover:text-foreground',
            )}
          >
            {t.scheduled.statusAll}
          </button>

          <button
            type="button"
            aria-pressed={unreadOnly}
            onClick={() => setUnreadOnly((prev) => !prev)}
            className={cn(
              'inline-flex h-8 cursor-pointer items-center rounded-full border px-3 text-xs font-medium whitespace-nowrap shrink-0 transition-colors focus-visible:outline-2 focus-visible:outline-ring',
              unreadOnly
                ? 'border-primary/25 bg-accent text-accent-foreground'
                : 'border-border bg-card text-muted-foreground hover:bg-secondary hover:text-foreground',
            )}
          >
            {t.chats.unreadOnly}
          </button>

          <button
            type="button"
            aria-pressed={favouritesOnly}
            onClick={() => setFavouritesOnly((prev) => !prev)}
            className={cn(
              'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-xs font-medium whitespace-nowrap shrink-0 transition-colors focus-visible:outline-2 focus-visible:outline-ring',
              favouritesOnly
                ? 'border-primary/25 bg-accent text-accent-foreground'
                : 'border-border bg-card text-muted-foreground hover:bg-secondary hover:text-foreground',
            )}
          >
            <Heart className={cn('size-3', favouritesOnly && 'fill-current')} />
            <span>{t.chats.filterFavourites}</span>
          </button>

          <button
            type="button"
            aria-pressed={hasMedia}
            onClick={() => onHasMediaChange(!hasMedia)}
            className={cn(
              'h-8 cursor-pointer rounded-full border px-3 text-xs font-medium whitespace-nowrap shrink-0 transition-colors focus-visible:outline-2 focus-visible:outline-ring',
              hasMedia
                ? 'border-primary/25 bg-accent text-accent-foreground'
                : 'border-border bg-card text-muted-foreground hover:bg-secondary hover:text-foreground',
            )}
          >
            {t.chats.mediaOnly}
          </button>

          {chatLists.length > 0 && (
            <div className="relative flex shrink-0 items-center">
              <ListFilter className="pointer-events-none absolute start-2.5 size-3.5 text-muted-foreground" />
              <select
                aria-label={t.chats.allListsOption}
                value={selectedListId ?? ''}
                onChange={(e) => {
                  const val = e.target.value;
                  setSelectedListId(val ? Number(val) : null);
                }}
                className={cn(
                  'h-8 cursor-pointer rounded-full border ps-7 pe-3 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring',
                  selectedListId !== null
                    ? 'border-primary/25 bg-accent text-accent-foreground'
                    : 'border-border bg-card text-muted-foreground hover:bg-secondary hover:text-foreground',
                )}
              >
                <option value="">{t.chats.allListsOption}</option>
                {chatLists.map((listItem) => (
                  <option key={listItem.id} value={listItem.id}>
                    {listItem.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {showAccountFilter && (
            <AccountMultiSelect
              accounts={accounts}
              selectedDeviceIds={selectedDeviceIds}
              onChange={onSelectedDeviceIdsChange}
              compactPill
            />
          )}

          {!headerTitle && (
            <div className="ms-auto flex items-center gap-1">
              {canBulk && (
                <button
                  type="button"
                  onClick={() => {
                    setBulkMode((prev) => {
                      if (prev) setBulkSelectedKeys(new Set());
                      return !prev;
                    });
                  }}
                  aria-pressed={bulkMode}
                  title={bulkMode ? t.chats.bulkCancelSelect : t.chats.bulkSelectToggle}
                  aria-label={bulkMode ? t.chats.bulkCancelSelect : t.chats.bulkSelectToggle}
                  className={cn(
                    'flex size-7 cursor-pointer items-center justify-center rounded-lg transition-colors focus-visible:outline-2 focus-visible:outline-ring',
                    bulkMode
                      ? 'bg-accent text-accent-foreground'
                      : 'bg-secondary text-muted-foreground hover:text-foreground',
                  )}
                >
                  <CheckSquare className="size-3.5" />
                </button>
              )}
              {onOpenNewChat && (
                <button
                  type="button"
                  onClick={onOpenNewChat}
                  title={t.chats.newChatBtn}
                  aria-label={t.chats.newChatBtn}
                  className="flex size-7 cursor-pointer items-center justify-center rounded-lg bg-secondary text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <MessageSquarePlus className="size-3.5" />
                </button>
              )}
              <button
                type="button"
                onClick={onRefresh}
                disabled={isFetching}
                title={t.chats.refreshChatsTitle}
                aria-label={t.chats.refreshChatsTitle}
                className="flex size-7 cursor-pointer items-center justify-center rounded-lg bg-secondary text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
              >
                <RefreshCw className={cn('size-3.5', isFetching && 'animate-spin')} />
              </button>
            </div>
          )}
        </div>

        {bulkMode && (
          <BulkActionBar
            selectedCount={selectedBulkChats.length}
            activeTab={activeTab}
            canAssign={canAssign}
            canClose={canClose}
            isBulkPending={isBulkPending}
            onRunBulk={(action) => void handleRunBulk(action)}
            onSelectAllVisible={() =>
              setBulkSelectedKeys(new Set(visibleChats.map((c) => chatUniqueKey(c))))
            }
            onCancel={() => {
              setBulkMode(false);
              setBulkSelectedKeys(new Set());
            }}
          />
        )}
      </div>

      {/* Chat Rows (virtualized: only the visible window is in the DOM) */}
      <div ref={listScrollRef} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {archivedOnly && (
          <button
            type="button"
            onClick={() => setArchivedOnly(false)}
            className="mb-1 flex w-full cursor-pointer items-center gap-3 rounded-xl px-2.5 py-2.5 text-start text-sm font-semibold text-foreground transition-colors hover:bg-secondary/70 focus-visible:outline-2 focus-visible:outline-ring"
          >
            <span className="flex size-8 items-center justify-center rounded-full bg-secondary text-foreground">
              {isRtl ? <ArrowRight className="size-4" /> : <ArrowLeft className="size-4" />}
            </span>
            <span className="flex-1 truncate">{t.chats.archivedFolderTitle}</span>
            <span className="text-xs font-medium text-muted-foreground tabular-nums">
              {archivedCount}
            </span>
          </button>
        )}

        {!archivedOnly &&
          !search.trim() &&
          !favouritesOnly &&
          selectedListId === null &&
          !unreadOnly &&
          archivedCount > 0 && (
            <button
              type="button"
              onClick={() => setArchivedOnly(true)}
              className="mb-0.5 flex w-full cursor-pointer items-center gap-3.5 rounded-xl px-3.5 py-2.5 text-start transition-colors hover:bg-secondary/60 focus-visible:outline-2 focus-visible:outline-ring"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full text-primary">
                <Archive className="size-[18px]" />
              </span>
              <span className="min-w-0 flex-1 truncate text-[14.5px] font-medium text-foreground">
                {t.chats.archivedFolderTitle}
              </span>
              <span className="shrink-0 text-xs font-semibold text-primary tabular-nums">
                {archivedCount}
              </span>
            </button>
          )}

        {isLoading ? (
          <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            <span>{t.chats.loadingChats}</span>
          </div>
        ) : errorMessage ? (
          <div className="p-6 text-center text-sm text-destructive">{errorMessage}</div>
        ) : visibleChats.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">
            {archivedOnly ? t.chats.archivedEmpty : t.chats.noMatchingChats}
          </div>
        ) : (
          <ul
            style={{height: `${rowVirtualizer.getTotalSize()}px`, position: 'relative'}}
            className="w-full"
          >
            {virtualRows.map((virtualRow) => {
              const chat = visibleChats[virtualRow.index];
              const key = chatUniqueKey(chat);
              const isMenuOpen =
                Boolean(menuState) && chatUniqueKey(menuState!.chat) === key;
              return (
                <ChatListRow
                  key={virtualRow.key}
                  rowRef={rowVirtualizer.measureElement}
                  rowIndex={virtualRow.index}
                  rowTop={virtualRow.start}
                  chat={chat}
                  isSelected={selectedKey === key}
                  isMenuOpen={isMenuOpen}
                  bulkMode={bulkMode}
                  isBulkSelected={bulkSelectedKeys.has(key)}
                  currentUserId={user?.id}
                  activeTab={activeTab}
                  showAccountName={showRowAccountName}
                  otherAccounts={otherAccountsByKey.get(key) ?? EMPTY_OTHER_ACCOUNTS}
                  onToggleBulkItem={handleToggleBulkItem}
                  onSelect={handleSelectRow}
                  onOpenMenu={handleOpenMenu}
                />
              );
            })}
          </ul>
        )}

        {!isLoading && !errorMessage && hasMore && onLoadMore && (
          <div className="flex flex-col items-center gap-1.5 px-2 py-3">
            {typeof totalChatsCount === 'number' && totalChatsCount > chats.length && (
              <p className="text-[11px] text-muted-foreground tabular-nums">
                {t.chats.showingChatsProgress(chats.length, totalChatsCount)}
              </p>
            )}
            <button
              type="button"
              disabled={isLoadingMore}
              onClick={onLoadMore}
              className="inline-flex h-9 w-full cursor-pointer items-center justify-center gap-2 rounded-lg border border-border bg-secondary/70 px-4 text-xs font-medium text-foreground transition-colors hover:bg-secondary focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-60 whitespace-nowrap"
            >
              {isLoadingMore && <Loader2 className="size-3.5 animate-spin" />}
              <span>
                {isLoadingMore ? t.chats.loadingMoreChats : t.chats.loadMoreChats}
              </span>
            </button>
          </div>
        )}
      </div>

      <ChatRowMenu
        open={Boolean(menuState)}
        chat={menuState?.chat ?? null}
        anchor={menuState?.anchor ?? null}
        canWrite={canWriteChats}
        canRevoke={canRevokeChats}
        onClose={() => setMenuState(null)}
        onAction={(targetChat, action) => void handleMenuAction(targetChat, action)}
      />

      <ChatListAssignDialog
        open={Boolean(activeListAssignChat)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setListAssignChat(null);
        }}
        chat={activeListAssignChat}
        lists={chatLists}
      />

      <Dialog
        open={Boolean(confirmAction)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !confirmBusy) setConfirmAction(null);
        }}
        title={
          confirmAction
            ? confirmAction.kind === 'block'
              ? t.chats.blockConfirmTitle(chatDisplayName(confirmAction.chat))
              : confirmAction.kind === 'unblock'
                ? t.chats.unblockConfirmTitle(chatDisplayName(confirmAction.chat))
                : confirmAction.kind === 'clear'
                  ? t.chats.clearConfirmTitle(chatDisplayName(confirmAction.chat))
                  : t.chats.deleteConfirmTitle(chatDisplayName(confirmAction.chat))
            : ''
        }
        description={
          confirmAction
            ? confirmAction.kind === 'block'
              ? t.chats.blockConfirmDesc
              : confirmAction.kind === 'unblock'
                ? t.chats.unblockConfirmDesc
                : confirmAction.kind === 'clear'
                  ? t.chats.clearConfirmDesc
                  : t.chats.deleteConfirmDesc
            : undefined
        }
      >
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={confirmBusy}
            onClick={() => setConfirmAction(null)}
          >
            {t.cancel}
          </Button>
          <Button
            type="button"
            variant={confirmAction?.kind === 'unblock' ? 'default' : 'destructive'}
            disabled={!confirmAction || confirmBusy}
            onClick={() => void handleRunConfirmedAction()}
          >
            {confirmBusy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : confirmAction?.kind === 'delete' ? (
              <Trash2 className="size-4" />
            ) : null}
            <span>
              {confirmAction?.kind === 'block'
                ? t.chats.blockChat
                : confirmAction?.kind === 'unblock'
                  ? t.chats.unblockChat
                  : confirmAction?.kind === 'clear'
                    ? t.chats.clearChat
                    : t.chats.deleteChat}
            </span>
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
