import {
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  Eye,
  Hand,
  History,
  Image as ImageIcon,
  ListChecks,
  Loader2,
  RotateCcw,
  Search,
  StickyNote,
  UserCheck,
  UserMinus,
  X,
} from 'lucide-react';
import type {ChatAssignmentInfo, ChatAssignmentSummary, UnifiedChat} from '@/api/types';
import {ContactAvatar} from '@/components/contact-avatar';
import {Button} from '@/components/ui/button';
import type {ContextDrawerTab} from '@/features/chat/chat-context-drawer';
import {shortAccountWidgetLabel} from '@/features/accounts/account-display';
import {formatSecondaryChatPhone} from '@/features/chat/chat-ui-helpers';
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
  embeddedInGroup = false,
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
  canReadNotes = true,
  canReadSchedules = true,
  notesCount,
  activeScheduledCount,
  onToggleDrawerTab,
  isHistoryPending,
  onFetchHistory,
  lifecycle,
  currentUserId,
  viewers = [],
  canAssign = false,
  canClose = false,
  canViewAll = false,
  isContentRedacted = false,
  isLifecyclePending = false,
  onClaim,
  onOpenAssign,
  onRelease,
  onCloseChat,
  onReopen,
}: {
  chat: UnifiedChat;
  displayName: string;
  total: number;
  isDeviceReady: boolean;
  alwaysShowBack: boolean;
  embeddedInGroup?: boolean;
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
  canReadNotes?: boolean;
  canReadSchedules?: boolean;
  notesCount: number;
  activeScheduledCount: number;
  onToggleDrawerTab: (tab: ContextDrawerTab) => void;
  isHistoryPending: boolean;
  onFetchHistory: () => void;
  lifecycle?: ChatAssignmentSummary | ChatAssignmentInfo;
  currentUserId?: number;
  /** P2-1 presence: full viewer list from the server, including the current
   * user — the badge below filters the current user out. */
  viewers?: Array<{userId: number; displayName: string}>;
  canAssign?: boolean;
  canClose?: boolean;
  canViewAll?: boolean;
  isContentRedacted?: boolean;
  isLifecyclePending?: boolean;
  onClaim?: () => void;
  onOpenAssign?: () => void;
  onRelease?: () => void;
  onCloseChat?: () => void;
  onReopen?: () => void;
}) {
  const {isRtl, t} = useI18n();

  const status = lifecycle?.status ?? 'pending';
  const assignedUserId = lifecycle?.assigned_user_id ?? null;
  const isAssignedToMe =
    status === 'open' && currentUserId !== undefined && assignedUserId === currentUserId;
  const isOpenOwnerOrSupervisor = status === 'open' && (isAssignedToMe || canViewAll);

  const lifecycleLabel =
    status === 'closed'
      ? lifecycle?.closed_by_name
        ? t.chats.lifecycleClosedBy(lifecycle.closed_by_name)
        : t.chats.lifecycleClosed
      : status === 'open'
        ? isAssignedToMe
          ? t.chats.lifecycleOpenAssignedYou
          : lifecycle?.assigned_user_name
            ? t.chats.lifecycleOpenAssignedTo(lifecycle.assigned_user_name)
            : t.chats.lifecyclePending
        : t.chats.lifecyclePending;

  const secondaryPhone = formatSecondaryChatPhone(displayName, formatJidPhone(chat.jid));

  // P2-1 presence badge (warning only): other viewers of this chat, never
  // the current user themself. The server sends the full list; filtering
  // here (where currentUserId is known) is the guarantee, not the hook.
  const otherViewers = viewers.filter((viewer) => viewer.userId !== currentUserId);
  const viewersLabel =
    otherViewers.length === 1
      ? t.chats.viewingNowOne(otherViewers[0].displayName)
      : otherViewers.length > 1
        ? t.chats.viewingNowMany(otherViewers.map((viewer) => viewer.displayName).join('، '))
        : null;

  const statusTextClass =
    status === 'closed'
      ? 'text-muted-foreground'
      : status === 'open'
        ? 'text-emerald-700 dark:text-emerald-400'
        : 'text-amber-700 dark:text-amber-400';

  const showPendingAssignButtons = Boolean(lifecycle) && status === 'pending' && canAssign;
  const showOpenActionButtons =
    Boolean(lifecycle) && status === 'open' && isOpenOwnerOrSupervisor && (canAssign || canClose);
  const showPendingCloseButton = Boolean(lifecycle) && status === 'pending' && canClose;
  const showReopenButton = Boolean(lifecycle) && status === 'closed' && canClose;
  const hasLifecycleButtons =
    showPendingAssignButtons ||
    showOpenActionButtons ||
    showPendingCloseButton ||
    showReopenButton;

  return (
    <div
      className={cn(
        'flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-4',
        embeddedInGroup ? 'min-h-[44px] bg-card/60 py-1' : 'min-h-[58px] bg-card py-1.5',
      )}
    >
      {embeddedInGroup ? (
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          {total > 0 && (
            <span className="font-medium tabular-nums">{t.chats.messagesCount(total)}</span>
          )}
          {!isDeviceReady && (
            <span className="text-destructive">{t.chats.accountOfflineInline}</span>
          )}
        </div>
      ) : (
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
              {secondaryPhone && (
                <>
                  <span className="hidden text-xs text-muted-foreground sm:inline">·</span>
                  <span
                    dir="ltr"
                    className="hidden truncate font-mono text-xs text-muted-foreground tabular-nums sm:inline"
                  >
                    {secondaryPhone}
                  </span>
                </>
              )}
            </div>
            <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 truncate text-xs text-muted-foreground">
              <span className="font-medium text-primary">{chat.device_display_name}</span>
              {!isContentRedacted && total > 0 && (
                <span className="tabular-nums">{t.chats.messagesCount(total)}</span>
              )}
              {lifecycle && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className={cn('font-medium', statusTextClass)}>
                    {lifecycleLabel}
                  </span>
                </>
              )}
              {!isDeviceReady && (
                <span className="text-destructive">{t.chats.accountOfflineInline}</span>
              )}
            </p>
            {viewersLabel && (
              <div
                data-testid="chat-viewers-badge"
                className="mt-0.5 flex items-center gap-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-400"
              >
                <Eye className="size-3 shrink-0" aria-hidden="true" />
                <span>{viewersLabel}</span>
              </div>
            )}
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
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {hasLifecycleButtons && (
          <div className="flex items-center gap-1.5">
            {showPendingAssignButtons && (
              <>
                {onClaim && (
                  <Button
                    type="button"
                    size="sm"
                    disabled={isLifecyclePending}
                    onClick={onClaim}
                    className="h-8 whitespace-nowrap shrink-0 px-2.5 text-xs"
                  >
                    <Hand className="size-3.5" />
                    <span>{t.chats.claimAction}</span>
                  </Button>
                )}
                {onOpenAssign && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={isLifecyclePending}
                    onClick={onOpenAssign}
                    className="h-8 whitespace-nowrap shrink-0 px-2.5 text-xs"
                  >
                    <UserCheck className="size-3.5" />
                    <span>{t.chats.assignAction}</span>
                  </Button>
                )}
              </>
            )}

            {showOpenActionButtons && (
              <>
                {canAssign && onOpenAssign && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={isLifecyclePending}
                    onClick={onOpenAssign}
                    className="h-8 whitespace-nowrap shrink-0 px-2.5 text-xs"
                  >
                    <UserCheck className="size-3.5" />
                    <span>{t.chats.transferAction}</span>
                  </Button>
                )}
                {canAssign && onRelease && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={isLifecyclePending}
                    onClick={onRelease}
                    title={t.chats.releaseAction}
                    className="h-8 whitespace-nowrap shrink-0 px-2.5 text-xs"
                  >
                    <UserMinus className="size-3.5" />
                    <span className="hidden sm:inline">{t.chats.releaseAction}</span>
                  </Button>
                )}
                {canClose && onCloseChat && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={isLifecyclePending}
                    onClick={onCloseChat}
                    className="h-8 whitespace-nowrap shrink-0 px-2.5 text-xs"
                  >
                    <CheckCircle2 className="size-3.5" />
                    <span>{t.chats.closeAction}</span>
                  </Button>
                )}
              </>
            )}

            {showPendingCloseButton && onCloseChat && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={isLifecyclePending}
                onClick={onCloseChat}
                className="h-8 whitespace-nowrap shrink-0 px-2.5 text-xs"
              >
                <CheckCircle2 className="size-3.5" />
                <span>{t.chats.closeAction}</span>
              </Button>
            )}

            {showReopenButton && onReopen && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={isLifecyclePending}
                onClick={onReopen}
                className="h-8 whitespace-nowrap shrink-0 px-2.5 text-xs"
              >
                <RotateCcw className="size-3.5" />
                <span>{t.chats.reopenAction}</span>
              </Button>
            )}

            <span aria-hidden="true" className="mx-0.5 h-5 w-px bg-border" />
          </div>
        )}

        {!isContentRedacted && searchOpen && (
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
              className="cursor-pointer rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            >
              <X className="size-3.5" />
            </button>
          </div>
        )}

        {canReadNotes && !isContentRedacted && (
          <button
            type="button"
            onClick={() => onToggleDrawerTab('notes')}
            title={t.chats.notesTitle}
            aria-label={t.chats.notesTitle}
            aria-pressed={drawerTab === 'notes'}
            className={cn(
              'flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-full px-2.5 transition-colors focus-visible:outline-2 focus-visible:outline-ring',
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
        )}

        {canReadSchedules && !isContentRedacted && (
          <button
            type="button"
            onClick={() => onToggleDrawerTab('scheduled')}
            title={t.chats.scheduledMessagesTitle}
            aria-label={t.chats.scheduledMessagesTitle}
            aria-pressed={drawerTab === 'scheduled'}
            className={cn(
              'flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-full px-2.5 transition-colors focus-visible:outline-2 focus-visible:outline-ring',
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
        )}

        {!isContentRedacted && (
          <>
            <button
              type="button"
              onClick={onToggleMediaOnly}
              title={t.chats.mediaOnly}
              aria-label={t.chats.mediaOnly}
              aria-pressed={mediaOnly}
              className={cn(
                'flex size-9 cursor-pointer items-center justify-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-ring',
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
                'flex h-9 cursor-pointer items-center justify-center gap-1 rounded-full px-2.5 transition-colors focus-visible:outline-2 focus-visible:outline-ring',
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
                'flex size-9 cursor-pointer items-center justify-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-ring',
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
              className="flex size-9 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
            >
              {isHistoryPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <History className="size-4" />
              )}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
