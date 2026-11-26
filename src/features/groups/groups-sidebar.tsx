import {AlertTriangle, Eye, Link2, Loader2, Lock, Megaphone, Plus, RefreshCw, Search} from 'lucide-react';
import type {
  AccountSummary,
  UnifiedDirectoryAccountRef,
  UnifiedDirectoryItem,
} from '@/api/types';
import {ContactAvatar} from '@/components/contact-avatar';
import {Button} from '@/components/ui/button';
import {
  AccountMultiSelect,
  accountDotTone,
  shortAccountWidgetLabel,
} from '@/features/chat/chat-list';
import {NewsletterAvatar} from '@/features/groups/newsletter-workspace-panel';
import {useI18n} from '@/lib/i18n';
import {matchesNormalizedQuery} from '@/lib/phone';
import {cn} from '@/lib/utils';

export type DirectoryKindFilter = 'all' | 'group' | 'newsletter';

export function directoryItemKey(item: Pick<UnifiedDirectoryItem, 'kind' | 'jid'>): string {
  return `${item.kind}::${item.jid.trim().toLowerCase()}`;
}

export function getDirectoryItemAccounts(
  item: UnifiedDirectoryItem,
): UnifiedDirectoryAccountRef[] {
  if (item.accounts && item.accounts.length > 0) {
    return item.accounts;
  }
  return [
    {
      device_id: item.device_id,
      device_display_name: item.device_display_name,
      device_state: item.device_state,
    },
  ];
}

export function GroupsSidebar({
  items,
  groupsCount,
  newslettersCount,
  accounts,
  deviceErrors = [],
  selectedKey,
  selectedDeviceIds,
  kindFilter,
  search,
  isLoading,
  isFetching,
  errorMessage,
  canAct,
  canCreateOrJoin = canAct,
  onSelectedDeviceIdsChange,
  onKindFilterChange,
  onSearchChange,
  onRefresh,
  onSelect,
  onOpenCreate,
  onOpenJoin,
  onOpenPreview,
}: {
  items: UnifiedDirectoryItem[];
  groupsCount: number;
  newslettersCount: number;
  accounts: AccountSummary[];
  deviceErrors?: Array<{device_id: string; display_name: string; message: string}>;
  selectedKey: string | null;
  selectedDeviceIds: string[];
  kindFilter: DirectoryKindFilter;
  search: string;
  isLoading: boolean;
  isFetching: boolean;
  errorMessage: string | null;
  canAct: boolean;
  canCreateOrJoin?: boolean;
  onSelectedDeviceIdsChange: (deviceIds: string[]) => void;
  onKindFilterChange: (kind: DirectoryKindFilter) => void;
  onSearchChange: (value: string) => void;
  onRefresh: () => void;
  onSelect: (item: UnifiedDirectoryItem) => void;
  onOpenCreate: () => void;
  onOpenJoin: () => void;
  onOpenPreview: () => void;
}) {
  const {t} = useI18n();

  const visibleItems = items.filter((item) => {
    if (kindFilter !== 'all' && item.kind !== kindFilter) return false;
    if (!search.trim()) return true;
    const extra =
      item.kind === 'group'
        ? item.group.Topic
        : item.newsletter.thread_metadata?.description?.text;
    const accountNames = getDirectoryItemAccounts(item).map((acc) => acc.device_display_name);
    return matchesNormalizedQuery([item.name, item.jid, ...accountNames, extra], search);
  });

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      {/* Top Sidebar Header matching ChatList */}
      <div className="flex h-[58px] shrink-0 items-center justify-between gap-2 px-4">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="truncate text-xl font-bold tracking-tight text-foreground">
            {t.groups.pageTitle}
          </h1>
          <span className="text-xs font-medium text-muted-foreground tabular-nums">
            {items.length}
          </span>
        </div>

        <div className="flex items-center gap-1">
          {canAct && (
            <button
              type="button"
              onClick={onOpenPreview}
              title={t.groups.previewLink}
              aria-label={t.groups.previewLink}
              className="flex size-9 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              <Eye className="size-4" />
            </button>
          )}
          {canCreateOrJoin && (
            <>
              <button
                type="button"
                onClick={onOpenJoin}
                title={t.groups.joinWithLink}
                aria-label={t.groups.joinWithLink}
                className="flex size-9 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              >
                <Link2 className="size-4" />
              </button>
              <button
                type="button"
                onClick={onOpenCreate}
                title={t.groups.createGroup}
                aria-label={t.groups.createGroup}
                className="flex size-9 cursor-pointer items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90"
              >
                <Plus className="size-4" />
              </button>
            </>
          )}
          <button
            type="button"
            onClick={onRefresh}
            disabled={isFetching}
            title={t.groups.refreshDirectoryTitle}
            aria-label={t.groups.refreshDirectoryTitle}
            className="flex size-9 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50"
          >
            <RefreshCw className={cn('size-4', isFetching && 'animate-spin')} />
          </button>
        </div>
      </div>

      {/* Search & Filter Strip matching ChatList */}
      <div className="flex flex-col gap-2.5 px-3 pb-2.5">
        <div className="relative">
          <Search className="pointer-events-none absolute start-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={t.groups.searchPlaceholder}
            className="h-9 w-full rounded-full bg-secondary ps-10 pe-4 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {(
            [
              {id: 'all', label: t.groups.filterAll, count: items.length},
              {id: 'group', label: t.groups.filterGroups, count: groupsCount},
              {id: 'newsletter', label: t.groups.filterChannels, count: newslettersCount},
            ] as const
          ).map((tab) => {
            const active = kindFilter === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => onKindFilterChange(tab.id)}
                className={cn(
                  'inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full px-3 text-xs font-medium whitespace-nowrap shrink-0 transition-colors',
                  active
                    ? 'bg-accent text-accent-foreground'
                    : 'bg-secondary text-muted-foreground hover:text-foreground',
                )}
              >
                <span>{tab.label}</span>
                <span className="text-[11px] tabular-nums opacity-80">{tab.count}</span>
              </button>
            );
          })}

          <AccountMultiSelect
            accounts={accounts}
            selectedDeviceIds={selectedDeviceIds}
            onChange={onSelectedDeviceIdsChange}
            compactPill
          />
        </div>
      </div>

      {/* Directory Rows */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            <span>{t.groups.loadingDirectory}</span>
          </div>
        ) : errorMessage ? (
          <div className="m-2 flex flex-col items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/10 p-5 text-center text-sm text-destructive">
            <AlertTriangle className="size-5 shrink-0" />
            <p className="leading-relaxed">{errorMessage}</p>
            <Button type="button" variant="outline" size="sm" onClick={onRefresh} disabled={isFetching}>
              <RefreshCw className={cn('size-3.5', isFetching && 'animate-spin')} />
              <span>{t.retry}</span>
            </Button>
          </div>
        ) : items.length === 0 && deviceErrors.length > 0 ? (
          <div className="m-2 flex flex-col items-center gap-3 rounded-xl border border-destructive/30 bg-destructive/10 p-5 text-center text-sm text-destructive">
            <AlertTriangle className="size-5 shrink-0" />
            <div className="space-y-1">
              <p className="font-medium">{t.groups.partialLoadError(deviceErrors.length)}</p>
              <p className="text-xs opacity-90">
                {deviceErrors.map((e) => `${e.display_name}: ${e.message}`).join(' · ')}
              </p>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={onRefresh} disabled={isFetching}>
              <RefreshCw className={cn('size-3.5', isFetching && 'animate-spin')} />
              <span>{t.retry}</span>
            </Button>
          </div>
        ) : items.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">{t.groups.empty}</div>
        ) : visibleItems.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">
            {t.groups.noSearchMatches}
          </div>
        ) : (
          <>
            {deviceErrors.length > 0 && (
              <div className="mb-2 flex items-center justify-between gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                <span className="min-w-0 truncate">
                  {t.groups.partialLoadError(deviceErrors.length)} {deviceErrors[0]?.display_name}
                </span>
                <button
                  type="button"
                  onClick={onRefresh}
                  disabled={isFetching}
                  className="inline-flex shrink-0 cursor-pointer items-center gap-1 font-medium underline hover:opacity-80 disabled:opacity-50"
                >
                  <RefreshCw className={cn('size-3', isFetching && 'animate-spin')} />
                  <span>{t.retry}</span>
                </button>
              </div>
            )}
            <ul className="space-y-0.5">
            {visibleItems.map((item) => {
              const key = directoryItemKey(item);
              const isSelected = selectedKey === key;
              const isNewsletter = item.kind === 'newsletter';
              const unreadCount = !isNewsletter ? (item.unread_count ?? 0) : 0;
              const rowAccounts = getDirectoryItemAccounts(item);
              const isMultiAccount = rowAccounts.length > 1;
              const countLabel = isNewsletter
                ? t.misc.subscribersCount(item.subscribers_count)
                : t.groups.membersCount(item.participant_count);

              const renderAccountBadge = (acc: UnifiedDirectoryAccountRef) => (
                <span
                  key={acc.device_id}
                  title={acc.device_display_name}
                  className={cn(
                    'inline-flex min-w-0 items-center gap-1.5 rounded-md border border-border/80 bg-background/70 px-2 py-0.5 text-[11px] font-medium text-foreground/90',
                    isMultiAccount ? 'max-w-[48%]' : 'max-w-[65%]',
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      'size-1.5 shrink-0 rounded-full',
                      accountDotTone(acc.device_id),
                    )}
                  />
                  <span className="truncate">
                    {shortAccountWidgetLabel(acc.device_display_name)}
                  </span>
                </span>
              );

              const renderMetaTail = () =>
                isNewsletter ? (
                  <span className="truncate text-[11px] text-primary">
                    · {t.groups.channelTag}
                  </span>
                ) : (
                  <>
                    {item.group.IsLocked && (
                      <span className="inline-flex shrink-0 items-center gap-0.5 text-[11px] text-amber-600 dark:text-amber-400">
                        · <Lock className="size-3" />
                      </span>
                    )}
                    {item.group.IsAnnounce && (
                      <span className="inline-flex shrink-0 items-center gap-0.5 text-[11px] text-sky-600 dark:text-sky-400">
                        · <Megaphone className="size-3" />
                      </span>
                    )}
                    <span
                      dir="ltr"
                      className="min-w-0 flex-1 truncate font-mono text-[11px] tabular-nums"
                    >
                      {item.jid}
                    </span>
                    {unreadCount > 0 && (
                      <span
                        aria-label={t.chats.unreadLabel(unreadCount)}
                        title={t.chats.unreadLabel(unreadCount)}
                        className="ms-auto inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-live px-1.5 text-[11px] font-semibold text-white tabular-nums"
                      >
                        {String(unreadCount)}
                      </span>
                    )}
                  </>
                );

              return (
                <li key={key}>
                  <button
                    type="button"
                    onClick={() => onSelect(item)}
                    className={cn(
                      'flex w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-start transition-colors',
                      isSelected ? 'bg-secondary' : 'hover:bg-secondary/60',
                    )}
                  >
                    {isNewsletter ? (
                      <NewsletterAvatar
                        name={item.name}
                        pictureUrl={
                          item.newsletter.thread_metadata?.picture?.url ||
                          item.newsletter.thread_metadata?.preview?.url
                        }
                        sizeClass="size-11"
                      />
                    ) : (
                      <ContactAvatar
                        deviceId={item.device_id}
                        jid={item.jid}
                        name={item.name}
                        sizeClass="size-11"
                      />
                    )}

                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span
                          className={cn(
                            'truncate text-[14.5px] text-foreground',
                            unreadCount > 0 ? 'font-semibold' : 'font-medium',
                          )}
                        >
                          {item.name}
                        </span>
                        <span className="shrink-0 text-[11px] font-medium tabular-nums text-muted-foreground">
                          {countLabel}
                        </span>
                      </div>

                      {isMultiAccount ? (
                        <>
                          <div className="mt-1 flex flex-wrap items-center gap-1">
                            {rowAccounts.map(renderAccountBadge)}
                          </div>
                          <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                            {renderMetaTail()}
                          </div>
                        </>
                      ) : (
                        <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                          {rowAccounts.map(renderAccountBadge)}
                          {renderMetaTail()}
                        </div>
                      )}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
          </>
        )}
      </div>
    </div>
  );
}
