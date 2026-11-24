import {useEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import {Check, ChevronDown, Loader2, RefreshCw, Search} from 'lucide-react';
import type {AccountSummary, UnifiedChat} from '@/api/types';
import {ContactAvatar, avatarToneClass} from '@/components/contact-avatar';
import {chatDisplayName, formatJidPhone} from '@/features/chat/display-name';
import {formatShortTime, isZeroTime} from '@/lib/format';
import {useI18n} from '@/lib/i18n';
import {matchesNormalizedQuery} from '@/lib/phone';
import {cn} from '@/lib/utils';

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

function accountDotTone(deviceId: string): string {
  let hash = 0;
  for (let i = 0; i < deviceId.length; i += 1) {
    hash = (hash * 31 + deviceId.charCodeAt(i)) | 0;
  }
  return ACCOUNT_DOT_TONES[Math.abs(hash) % ACCOUNT_DOT_TONES.length];
}

function shortAccountWidgetLabel(displayName: string): string {
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
        <span className="max-w-[140px] truncate">{summaryText}</span>
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
  deviceErrors,
  selectedKey,
  selectedDeviceIds,
  search,
  hasMedia,
  isLoading,
  isFetching,
  errorMessage,
  onSelectedDeviceIdsChange,
  onSearchChange,
  onHasMediaChange,
  onRefresh,
  onSelect,
}: {
  headerTitle?: string;
  headerActions?: ReactNode;
  chats: UnifiedChat[];
  accounts: AccountSummary[];
  deviceErrors: Array<{device_id: string; display_name: string; message: string}>;
  selectedKey: string | null;
  selectedDeviceIds: string[];
  search: string;
  hasMedia: boolean;
  isLoading: boolean;
  isFetching: boolean;
  errorMessage: string | null;
  onSelectedDeviceIdsChange: (deviceIds: string[]) => void;
  onSearchChange: (value: string) => void;
  onHasMediaChange: (value: boolean) => void;
  onRefresh: () => void;
  onSelect: (chat: UnifiedChat) => void;
}) {
  const {lang, t} = useI18n();
  const isAllActive = !hasMedia && selectedDeviceIds.length === 0;
  const visibleChats = useMemo(() => {
    if (!search.trim()) return chats;
    return chats.filter((chat) =>
      matchesNormalizedQuery(
        [chatDisplayName(chat), formatJidPhone(chat.jid), chat.jid, chat.device_display_name],
        search,
      ),
    );
  }, [chats, search]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      {/* Top WhatsApp Sidebar Header */}
      {headerTitle && (
        <div className="flex h-[58px] shrink-0 items-center justify-between gap-2 px-4">
          <h1 className="truncate text-xl font-bold tracking-tight text-foreground">
            {headerTitle}
          </h1>
          <div className="flex items-center gap-1">
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

      {/* Search & Filter Strip */}
      <div className={cn('flex flex-col gap-2.5 px-3 pb-2.5', !headerTitle && 'pt-3')}>
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
            <button
              type="button"
              onClick={onRefresh}
              disabled={isFetching}
              title={t.chats.refreshChatsTitle}
              aria-label={t.chats.refreshChatsTitle}
              className="ms-auto flex size-7 cursor-pointer items-center justify-center rounded-full bg-secondary text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
            >
              <RefreshCw className={cn('size-3.5', isFetching && 'animate-spin')} />
            </button>
          )}
        </div>
      </div>

      {deviceErrors.length > 0 && (
        <div className="mx-3 mb-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
          {t.chats.deviceFetchErrorPrefix(deviceErrors.length)}{' '}
          {deviceErrors.map((e) => `${e.display_name} (${e.message})`).join(' · ')}
        </div>
      )}

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
                        <span className="truncate text-[14.5px] font-medium text-foreground">
                          {name}
                        </span>
                        {timeLabel && (
                          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                            {timeLabel}
                          </span>
                        )}
                      </div>

                      <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                        <span
                          title={chat.device_display_name}
                          className="inline-flex max-w-[104px] shrink-0 items-center gap-1.5 rounded-md border border-border/80 bg-background/70 px-1.5 py-0.5 text-[10.5px] font-medium text-foreground/90"
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
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
