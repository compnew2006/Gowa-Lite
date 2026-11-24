import {
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  CalendarClock,
  History,
  Image as ImageIcon,
  ListChecks,
  Loader2,
  Search,
  StickyNote,
  X,
} from 'lucide-react';
import type {UnifiedChat} from '@/api/types';
import {ContactAvatar} from '@/components/contact-avatar';
import {Button} from '@/components/ui/button';
import type {ContextDrawerTab} from '@/features/chat/chat-context-drawer';
import {shortAccountWidgetLabel} from '@/features/chat/chat-list';
import {formatJidPhone} from '@/features/chat/display-name';
import type {OtherAccountRef} from '@/features/chat/other-accounts';
import {useI18n} from '@/lib/i18n';
import {cn} from '@/lib/utils';

export function MessageViewHeader({
  chat,
  displayName,
  total,
  isDeviceReady,
  alwaysShowBack,
  otherAccounts = [],
  onSwitchAccount,
  onBack,
  searchOpen,
  search,
  onSearchChange,
  onToggleSearch,
  onCloseSearch,
  mediaOnly,
  onToggleMediaOnly,
  selectMode,
  selectedMediaCount,
  onToggleSelectMode,
  drawerTab,
  notesCount,
  activeScheduledCount,
  onToggleDrawerTab,
  isHistoryPending,
  onFetchHistory,
}: {
  chat: UnifiedChat;
  displayName: string;
  total: number;
  isDeviceReady: boolean;
  alwaysShowBack: boolean;
  otherAccounts?: OtherAccountRef[];
  onSwitchAccount?: (deviceId: string, jid: string) => void;
  onBack?: () => void;
  searchOpen: boolean;
  search: string;
  onSearchChange: (val: string) => void;
  onToggleSearch: () => void;
  onCloseSearch: () => void;
  mediaOnly: boolean;
  onToggleMediaOnly: () => void;
  selectMode: boolean;
  selectedMediaCount: number;
  onToggleSelectMode: () => void;
  drawerTab: ContextDrawerTab | null;
  notesCount: number;
  activeScheduledCount: number;
  onToggleDrawerTab: (tab: ContextDrawerTab) => void;
  isHistoryPending: boolean;
  onFetchHistory: () => void;
}) {
  const {isRtl, t} = useI18n();

  return (
    <div className="flex min-h-[58px] shrink-0 items-center justify-between gap-3 border-b border-border bg-card px-4 py-1.5">
      <div className="flex min-w-0 items-center gap-3">
        {onBack && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onBack}
            className={
              alwaysShowBack ? 'size-8 shrink-0 rounded-full' : 'size-8 shrink-0 rounded-full lg:hidden'
            }
            aria-label={t.chats.backToChatsAria}
            title={t.chats.backToChatsAria}
          >
            {isRtl ? <ArrowRight className="size-4" /> : <ArrowLeft className="size-4" />}
          </Button>
        )}
        <ContactAvatar
          deviceId={chat.device_id}
          jid={chat.jid}
          name={displayName}
          sizeClass="size-10"
          eager
        />
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <h2 className="truncate text-[15px] font-semibold text-foreground">{displayName}</h2>
            <span className="hidden text-xs text-muted-foreground sm:inline">·</span>
            <span
              dir="ltr"
              className="hidden truncate font-mono text-xs text-muted-foreground tabular-nums sm:inline"
            >
              {formatJidPhone(chat.jid)}
            </span>
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {t.chats.autoReplyVia}{' '}
            <span className="font-medium text-primary">{chat.device_display_name}</span>
            {total > 0 && <span className="tabular-nums">{t.chats.messagesCount(total)}</span>}
            {!isDeviceReady && (
              <span className="text-destructive">{t.chats.accountOfflineInline}</span>
            )}
          </p>
          {otherAccounts.length > 0 && (
            <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-amber-700 dark:text-amber-400">
              <ArrowLeftRight className="size-3 shrink-0" />
              <span className="font-medium">{t.chats.alsoOnOtherAccountPrefix}</span>
              {otherAccounts.map((acc, index) => (
                <span key={acc.device_id} className="inline-flex items-center gap-1">
                  {index > 0 && <span aria-hidden="true">·</span>}
                  {onSwitchAccount ? (
                    <button
                      type="button"
                      onClick={() => onSwitchAccount(acc.device_id, chat.jid)}
                      title={t.chats.switchToAccountChatTitle(acc.device_display_name)}
                      className="cursor-pointer font-semibold underline decoration-dotted underline-offset-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      {shortAccountWidgetLabel(acc.device_display_name)}
                    </button>
                  ) : (
                    <span className="font-semibold">
                      {shortAccountWidgetLabel(acc.device_display_name)}
                    </span>
                  )}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        {searchOpen && (
          <div className="flex items-center gap-1 rounded-full bg-secondary px-3 py-1">
            <input
              type="search"
              autoFocus
              placeholder={t.chats.searchMessagesPlaceholder}
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              className="w-32 bg-transparent text-xs text-foreground placeholder:text-muted-foreground focus:outline-none sm:w-44"
            />
            <button
              type="button"
              onClick={onCloseSearch}
              aria-label={t.close}
              className="cursor-pointer text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </div>
        )}

        <button
          type="button"
          onClick={() => onToggleDrawerTab('notes')}
          title={t.chats.notesTitle}
          aria-label={t.chats.notesTitle}
          aria-pressed={drawerTab === 'notes'}
          className={cn(
            'flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-full px-2.5 transition-colors',
            drawerTab === 'notes'
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
          )}
        >
          <StickyNote className="size-4" />
          {notesCount > 0 && (
            <span className="text-[11px] font-semibold tabular-nums">{notesCount}</span>
          )}
        </button>

        <button
          type="button"
          onClick={() => onToggleDrawerTab('scheduled')}
          title={t.chats.scheduledMessagesTitle}
          aria-label={t.chats.scheduledMessagesTitle}
          aria-pressed={drawerTab === 'scheduled'}
          className={cn(
            'flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-full px-2.5 transition-colors',
            drawerTab === 'scheduled'
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
          )}
        >
          <CalendarClock className="size-4" />
          {activeScheduledCount > 0 && (
            <span className="text-[11px] font-semibold tabular-nums">{activeScheduledCount}</span>
          )}
        </button>

        <button
          type="button"
          onClick={onToggleMediaOnly}
          title={t.chats.mediaOnly}
          aria-label={t.chats.mediaOnly}
          aria-pressed={mediaOnly}
          className={cn(
            'flex size-9 cursor-pointer items-center justify-center rounded-full transition-colors',
            mediaOnly
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
          )}
        >
          <ImageIcon className="size-4" />
        </button>

        <button
          type="button"
          onClick={onToggleSelectMode}
          title={t.chats.selectMediaTitle}
          aria-label={t.chats.selectMediaTitle}
          aria-pressed={selectMode}
          className={cn(
            'flex h-9 cursor-pointer items-center justify-center gap-1 rounded-full px-2.5 transition-colors',
            selectMode
              ? 'bg-accent text-accent-foreground'
              : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
          )}
        >
          <ListChecks className="size-4" />
          {selectMode && selectedMediaCount > 0 && (
            <span className="text-[11px] font-semibold tabular-nums">{selectedMediaCount}</span>
          )}
        </button>

        <button
          type="button"
          onClick={onToggleSearch}
          title={t.chats.searchMessagesPlaceholder}
          aria-label={t.chats.searchMessagesPlaceholder}
          aria-pressed={searchOpen}
          className={cn(
            'flex size-9 cursor-pointer items-center justify-center rounded-full transition-colors',
            searchOpen
              ? 'bg-secondary text-foreground'
              : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
          )}
        >
          <Search className="size-4" />
        </button>

        <button
          type="button"
          disabled={isHistoryPending}
          onClick={onFetchHistory}
          title={t.chats.fetchOlderFromPhone}
          aria-label={t.chats.fetchOlderFromPhone}
          className="flex size-9 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50"
        >
          {isHistoryPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <History className="size-4" />
          )}
        </button>
      </div>
    </div>
  );
}
