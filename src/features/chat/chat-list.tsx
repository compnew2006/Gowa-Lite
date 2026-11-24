import {useEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import {
  ArrowLeftRight,
  Check,
  ChevronDown,
  Loader2,
  MessageSquarePlus,
  RefreshCw,
  Search,
} from 'lucide-react';
import type {AccountSummary, UnifiedChat} from '@/api/types';
import {ContactAvatar, avatarToneClass} from '@/components/contact-avatar';
import {chatDisplayName, formatJidPhone} from '@/features/chat/display-name';
import {
  buildJidAccountsMap,
  getOtherAccountsForChat,
  type OtherAccountRef,
} from '@/features/chat/other-accounts';
import {formatShortTime, isZeroTime} from '@/lib/format';
import {useI18n} from '@/lib/i18n';
import {matchesNormalizedQuery} from '@/lib/phone';
import {cn} from '@/lib/utils';
import {useAuthStore} from '@/stores/auth';

export {avatarToneClass};

export function chatUniqueKey(chat: Pick<UnifiedChat, 'device_id' | 'jid'>): string {
  return `${chat.device_id}::${chat.jid}`;
}

const ACCOUNT_DOT_TONES = [
  'bg-emerald-400',
  'bg-sky-400',
  'bg-amber-400',
  'bg-violet-400',
  'bg-teal-400',
];

export function accountDotTone(deviceId: string): string {
  let hash = 0;
  for (let i = 0; i < deviceId.length; i += 1) {
    hash = (hash * 31 + deviceId.charCodeAt(i)) | 0;
  }
  return ACCOUNT_DOT_TONES[Math.abs(hash) % ACCOUNT_DOT_TONES.length];
}

export function shortAccountWidgetLabel(displayName: string): string {
  const cleaned = displayName.replace(/@(s\.whatsapp\.net|c\.us|lid)$/i, '').trim();
  return cleaned || displayName;
}

export function AccountMultiSelect({
  accounts,
  selectedDeviceIds,
  onChange,
  compactPill = false,
}: {
  accounts: AccountSummary[];
  selectedDeviceIds: string[];
  onChange: (deviceIds: string[]) => void;
  compactPill?: boolean;
}) {
  const {t} = useI18n();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const validSelected = selectedDeviceIds.filter((id) => accounts.some((a) => a.id === id));

  let summaryText: string;
  if (validSelected.length === 0) {
    summaryText = t.chats.allAccounts(accounts.length);
  } else if (validSelected.length === 1) {
    const match = accounts.find((a) => a.id === validSelected[0]);
    summaryText = match?.display_name ?? validSelected[0];
  } else {
    summaryText = t.chats.selectedAccountsCount(validSelected.length);
  }

  const toggleDevice = (deviceId: string) => {
    const exists = validSelected.includes(deviceId);
    const next = exists
      ? validSelected.filter((id) => id !== deviceId)
      : [...validSelected, deviceId];
    onChange(next);
  };

  return (
    <div ref={containerRef} className={cn('relative', compactPill ? 'shrink-0' : 'min-w-0 flex-1')}>
      <button
        type="button"
        aria-label={t.chats.filterByAccountAria}
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        className={cn(
          'flex cursor-pointer items-center justify-between gap-1.5 text-start whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-ring',
          compactPill
            ? cn(
                'h-7 rounded-full px-3 text-xs font-medium',
                validSelected.length > 0
                  ? 'bg-accent text-accent-foreground'
                  : 'bg-secondary text-muted-foreground hover:text-foreground',
              )
            : 'h-9 w-full rounded-full bg-secondary px-3 text-xs font-medium text-foreground hover:bg-muted',
        )}
      >
        <span className={cn('truncate', compactPill ? 'max-w-[220px]' : 'min-w-0 flex-1')}>
          {summaryText}
        </span>
        <ChevronDown
          className={cn(
            'size-3.5 shrink-0 opacity-75 transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>

      {open && (
        <div
          role="listbox"
          aria-multiselectable="true"
          className="absolute start-0 top-full z-30 mt-1.5 min-w-[230px] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg"
        >
          <button
            type="button"
            onClick={() => onChange([])}
            className="flex w-full cursor-pointer items-center justify-between gap-2 border-b border-border px-3 py-2 text-start text-xs font-medium transition-colors hover:bg-muted/70"
          >
            <span>{t.chats.clearSelectionShowAll}</span>
            {validSelected.length === 0 && <Check className="size-3.5 shrink-0 text-primary" />}
          </button>

          <div className="max-h-60 overflow-y-auto py-1">
            {accounts.length === 0 ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">
                {t.chats.noAccountsAvailable}
              </p>
            ) : (
              accounts.map((acc) => {
                const checked = validSelected.includes(acc.id);
                return (
                  <button
                    key={acc.id}
                    type="button"
                    role="option"
                    aria-selected={checked}
                    onClick={() => toggleDevice(acc.id)}
                    className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-start text-xs transition-colors hover:bg-muted/70"
                  >
                    <span
                      className={cn(
                        'flex size-4 shrink-0 items-center justify-center rounded border transition-colors',
                        checked
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-input bg-card',
                      )}
                    >
                      {checked && <Check className="size-3" />}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-foreground">
                      {acc.display_name}
                    </span>
                    {acc.state !== 'logged_in' && (
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {t.chats.offlineTag}
                      </span>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function ChatList({
  headerTitle,
  headerActions,
  chats,
  accounts,
  jidAccountsMap,
  selectedKey,
  selectedDeviceIds,
  search,
  hasMedia,
  totalUnread,
  totalChatsCount,
  hasMore = false,
  isLoadingMore = false,
  isLoading,
  isFetching,
  errorMessage,
  onSelectedDeviceIdsChange,
  onSearchChange,
  onHasMediaChange,
  onRefresh,
  onLoadMore,
  onOpenNewChat,
  onSelect,
}: {
  headerTitle?: string;
  headerActions?: ReactNode;
  chats: UnifiedChat[];
  accounts: AccountSummary[];
  jidAccountsMap?: Map<string, OtherAccountRef[]>;
  deviceErrors?: Array<{device_id: string; display_name: string; message: string}>;
  selectedKey: string | null;
  selectedDeviceIds: string[];
  search: string;
  hasMedia: boolean;
  totalUnread?: number;
  totalChatsCount?: number;
  hasMore?: boolean;
  isLoadingMore?: boolean;
  isLoading: boolean;
  isFetching: boolean;
  errorMessage: string | null;
  onSelectedDeviceIdsChange: (deviceIds: string[]) => void;
  onSearchChange: (value: string) => void;
  onHasMediaChange: (value: boolean) => void;
  onRefresh: () => void;
  onLoadMore?: () => void;
  onOpenNewChat?: () => void;
  onSelect: (chat: UnifiedChat) => void;
}) {
  const {lang, t} = useI18n();
  const user = useAuthStore((s) => s.user);
  const [unreadOnly, setUnreadOnly] = useState(false);

  const computedUnreadCount = useMemo(
    () => chats.reduce((sum, chat) => sum + Math.max(0, chat.unread_count ?? 0), 0),
    [chats],
  );
  const totalUnreadCount = typeof totalUnread === 'number' ? totalUnread : computedUnreadCount;

  const isAllActive = !hasMedia && !unreadOnly && selectedDeviceIds.length === 0;
  const resolvedJidAccountsMap = useMemo(
    () => jidAccountsMap ?? buildJidAccountsMap(chats),
    [chats, jidAccountsMap],
  );

  const visibleChats = useMemo(() => {
    let filtered = chats;
    if (unreadOnly) {
      filtered = filtered.filter((chat) => (chat.unread_count ?? 0) > 0);
    }
    if (!search.trim()) return filtered;
    return filtered.filter((chat) =>
      matchesNormalizedQuery(
        [chatDisplayName(chat), formatJidPhone(chat.jid), chat.jid, chat.device_display_name],
        search,
      ),
    );
  }, [chats, search, unreadOnly]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      {/* Top WhatsApp Sidebar Header */}
      {headerTitle && (
        <div className="flex h-[58px] shrink-0 items-center justify-between gap-2 px-4">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-xl font-bold tracking-tight text-foreground">
              {headerTitle}
            </h1>
            {totalUnreadCount > 0 && (
              <span
                title={t.chats.unreadLabel(totalUnreadCount)}
                className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground tabular-nums"
              >
                {totalUnreadCount > 99 ? '99+' : totalUnreadCount}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {onOpenNewChat && (
              <button
                type="button"
                onClick={onOpenNewChat}
                title={t.chats.newChatBtn}
                aria-label={t.chats.newChatBtn}
                className="flex size-9 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
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
              className="flex size-9 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50"
            >
              <RefreshCw className={cn('size-4', isFetching && 'animate-spin')} />
            </button>
          </div>
        </div>
      )}

      {/* Search, Isolated User Unread Widget & Filter Strip */}
      <div className={cn('flex flex-col gap-2.5 px-3 pb-2.5', !headerTitle && 'pt-3')}>
        {user && (
          <button
            type="button"
            data-testid="user-unread-widget"
            onClick={() => setUnreadOnly((prev) => !prev)}
            aria-pressed={unreadOnly}
            title={t.chats.userUnreadIsolatedHint}
            className={cn(
              'flex w-full cursor-pointer items-center justify-between gap-2.5 rounded-xl border px-3 py-2 text-start transition-colors focus-visible:outline-2 focus-visible:outline-ring',
              unreadOnly
                ? 'border-primary/50 bg-primary/10'
                : 'border-border/80 bg-secondary/50 hover:bg-secondary/80',
            )}
          >
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-bold text-accent-foreground select-none">
                {user.display_name.slice(0, 1).toUpperCase()}
              </span>
              <div className="min-w-0">
                <p className="truncate text-xs font-semibold text-foreground">
                  {t.chats.userUnreadTitle(user.display_name)}
                </p>
                <p className="truncate text-[11px] text-muted-foreground">
                  {t.chats.userUnreadCountText(totalUnreadCount)}
                </p>
              </div>
            </div>
            <span
              className={cn(
                'inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full px-2 text-xs font-bold tabular-nums',
                totalUnreadCount > 0
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-background text-muted-foreground ring-1 ring-border',
              )}
            >
              {totalUnreadCount > 99 ? '99+' : totalUnreadCount}
            </span>
          </button>
        )}

        <div className="relative">
          <Search className="pointer-events-none absolute start-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={t.chats.searchChatsPlaceholder}
            className="h-9 w-full rounded-full bg-secondary ps-10 pe-4 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => {
              onHasMediaChange(false);
              setUnreadOnly(false);
              onSelectedDeviceIdsChange([]);
            }}
            className={cn(
              'h-7 cursor-pointer rounded-full px-3 text-xs font-medium whitespace-nowrap shrink-0 transition-colors',
              isAllActive
                ? 'bg-accent text-accent-foreground'
                : 'bg-secondary text-muted-foreground hover:text-foreground',
            )}
          >
            {t.scheduled.statusAll}
          </button>

          <button
            type="button"
            onClick={() => setUnreadOnly((prev) => !prev)}
            className={cn(
              'inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full px-3 text-xs font-medium whitespace-nowrap shrink-0 transition-colors',
              unreadOnly
                ? 'bg-accent text-accent-foreground'
                : 'bg-secondary text-muted-foreground hover:text-foreground',
            )}
          >
            <span>{t.chats.unreadOnly}</span>
            {totalUnreadCount > 0 && (
              <span className="text-[11px] font-semibold tabular-nums">
                {totalUnreadCount > 99 ? '99+' : totalUnreadCount}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => onHasMediaChange(!hasMedia)}
            className={cn(
              'h-7 cursor-pointer rounded-full px-3 text-xs font-medium whitespace-nowrap shrink-0 transition-colors',
              hasMedia
                ? 'bg-accent text-accent-foreground'
                : 'bg-secondary text-muted-foreground hover:text-foreground',
            )}
          >
            {t.chats.mediaOnly}
          </button>

          <AccountMultiSelect
            accounts={accounts}
            selectedDeviceIds={selectedDeviceIds}
            onChange={onSelectedDeviceIdsChange}
            compactPill
          />

          {!headerTitle && (
            <div className="ms-auto flex items-center gap-1">
              {onOpenNewChat && (
                <button
                  type="button"
                  onClick={onOpenNewChat}
                  title={t.chats.newChatBtn}
                  aria-label={t.chats.newChatBtn}
                  className="flex size-7 cursor-pointer items-center justify-center rounded-full bg-secondary text-muted-foreground transition-colors hover:text-foreground"
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
                className="flex size-7 cursor-pointer items-center justify-center rounded-full bg-secondary text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
              >
                <RefreshCw className={cn('size-3.5', isFetching && 'animate-spin')} />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Chat Rows */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            <span>{t.chats.loadingChats}</span>
          </div>
        ) : errorMessage ? (
          <div className="p-6 text-center text-sm text-destructive">{errorMessage}</div>
        ) : visibleChats.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">
            {t.chats.noMatchingChats}
          </div>
        ) : (
          <ul className="space-y-0.5">
            {visibleChats.map((chat) => {
              const key = chatUniqueKey(chat);
              const isSelected = selectedKey === key;
              const name = chatDisplayName(chat);
              const phone = formatJidPhone(chat.jid);
              const unreadCount = Math.max(0, chat.unread_count ?? 0);
              const hasUnread = unreadCount > 0;
              const otherAccounts = getOtherAccountsForChat(
                resolvedJidAccountsMap,
                chat.device_id,
                chat.jid,
              );
              const timeLabel = isZeroTime(chat.last_message_time)
                ? ''
                : formatShortTime(chat.last_message_time, lang);

              return (
                <li key={key}>
                  <button
                    type="button"
                    onClick={() => onSelect(chat)}
                    className={cn(
                      'flex w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-start transition-colors',
                      isSelected ? 'bg-secondary' : 'hover:bg-secondary/60',
                    )}
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
                              hasUnread ? 'font-semibold text-primary' : 'text-muted-foreground',
                            )}
                          >
                            {timeLabel}
                          </span>
                        )}
                      </div>

                      <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                        <span
                          title={chat.device_display_name}
                          className="inline-flex min-w-0 max-w-[72%] items-center gap-1.5 rounded-md border border-border/80 bg-background/70 px-2 py-0.5 text-[11px] font-medium text-foreground/90"
                        >
                          <span
                            aria-hidden="true"
                            className={cn('size-1.5 shrink-0 rounded-full', accountDotTone(chat.device_id))}
                          />
                          <span className="truncate">
                            {shortAccountWidgetLabel(chat.device_display_name)}
                          </span>
                        </span>
                        <span dir="ltr" className="min-w-0 flex-1 truncate font-mono text-[11px] tabular-nums">
                          {phone}
                        </span>
                        {hasUnread && (
                          <span
                            aria-label={t.chats.unreadLabel(unreadCount)}
                            title={t.chats.unreadLabel(unreadCount)}
                            className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground tabular-nums"
                          >
                            {unreadCount > 99 ? '99+' : unreadCount}
                          </span>
                        )}
                      </div>

                      {otherAccounts.length > 0 && (
                        <p
                          title={t.chats.alsoOnOtherAccount(
                            otherAccounts
                              .map((a) => shortAccountWidgetLabel(a.device_display_name))
                              .join('، '),
                          )}
                          className="mt-1 flex items-center gap-1.5 truncate text-[11px] font-medium text-amber-700 dark:text-amber-400"
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
                </li>
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
    </div>
  );
}
