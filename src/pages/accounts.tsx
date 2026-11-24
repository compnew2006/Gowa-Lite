import {useEffect, useMemo, useState} from 'react';
import {useQuery, useQueryClient} from '@tanstack/react-query';
import {Loader2, RefreshCw, Search, Smartphone} from 'lucide-react';
import {listDevices} from '@/api/client';
import type {DeviceState, RegistryDevice} from '@/api/types';
import {ContactAvatar} from '@/components/contact-avatar';
import {
  GowaSetupNotice,
  isGowaConnectionError,
  SplitWorkspace,
  WorkspaceEmptyState,
} from '@/components/layout/split-workspace';
import {AccountWorkspacePanel} from '@/features/accounts/account-workspace-panel';
import {CreateDeviceDialog} from '@/features/accounts/create-device-dialog';
import {EditAliasDialog} from '@/features/accounts/edit-alias-dialog';
import {LoginCodeDialog} from '@/features/accounts/login-code-dialog';
import {LoginQrDialog} from '@/features/accounts/login-qr-dialog';
import {accountDotTone} from '@/features/chat/chat-list';
import {onWsEvent} from '@/lib/events';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';
import {matchesNormalizedQuery} from '@/lib/phone';
import {cn} from '@/lib/utils';
import {hasUserAnyPermission, hasUserPermission, useAuthStore} from '@/stores/auth';

const SIDEBAR_STORAGE_KEY = 'gowa-lite:accounts-sidebar-width';

type AccountStateFilter = 'all' | 'online' | 'offline';

const stateToneClass: Record<DeviceState, string> = {
  logged_in: 'text-emerald-700 dark:text-emerald-400',
  connected: 'text-amber-700 dark:text-amber-400',
  connecting: 'text-amber-700 dark:text-amber-400',
  disconnected: 'text-destructive',
};

export default function AccountsPage() {
  const queryClient = useQueryClient();
  const {t} = useI18n();
  const user = useAuthStore((s) => s.user);
  const canWriteAccounts = hasUserPermission(user, 'accounts:write');
  const canViewSettings = hasUserAnyPermission(user, ['settings:read', 'settings:write']);

  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState<AccountStateFilter>('all');
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [mobileShowDetail, setMobileShowDetail] = useState(false);

  const [qrDevice, setQrDevice] = useState<RegistryDevice | null>(null);
  const [codeDevice, setCodeDevice] = useState<RegistryDevice | null>(null);
  const [aliasDevice, setAliasDevice] = useState<RegistryDevice | null>(null);

  const query = useQuery({
    queryKey: ['devices'],
    queryFn: listDevices,
    refetchInterval: 15_000,
  });

  useEffect(() => {
    return onWsEvent((event) => {
      if (
        event.code === 'LOGIN_SUCCESS' ||
        event.code === 'LIST_DEVICES' ||
        event.code === 'DEVICE_REMOVED' ||
        event.code === 'DEVICE_LOGGED_OUT'
      ) {
        void queryClient.invalidateQueries({queryKey: ['devices']});
      }
    });
  }, [queryClient]);

  const devices = query.data ?? [];

  useEffect(() => {
    if (devices.length === 0) {
      if (selectedDeviceId) setSelectedDeviceId(null);
      return;
    }
    if (!selectedDeviceId || !devices.some((d) => d.id === selectedDeviceId)) {
      const preferred = devices.find((d) => d.state === 'logged_in') ?? devices[0];
      setSelectedDeviceId(preferred.id);
    }
  }, [devices, selectedDeviceId]);

  const onlineCount = useMemo(
    () => devices.filter((d) => d.state === 'logged_in').length,
    [devices],
  );
  const offlineCount = devices.length - onlineCount;

  const visibleDevices = useMemo(() => {
    return devices.filter((dev) => {
      const isOnline = dev.state === 'logged_in';
      if (stateFilter === 'online' && !isOnline) return false;
      if (stateFilter === 'offline' && isOnline) return false;
      if (!search.trim()) return true;
      return matchesNormalizedQuery(
        [dev.resolved_name, dev.alias, dev.display_name, dev.id, dev.phone_number, dev.jid],
        search,
      );
    });
  }, [devices, search, stateFilter]);

  const selectedDevice = useMemo<RegistryDevice | null>(() => {
    if (!selectedDeviceId) return null;
    return devices.find((d) => d.id === selectedDeviceId) ?? null;
  }, [devices, selectedDeviceId]);

  const apiErr = query.isError ? toApiError(query.error) : null;

  if (apiErr && isGowaConnectionError(apiErr)) {
    return (
      <GowaSetupNotice
        apiErr={apiErr}
        isAdmin={canViewSettings}
        onRetry={() => void query.refetch()}
      />
    );
  }

  return (
    <>
      <SplitWorkspace
        storageKey={SIDEBAR_STORAGE_KEY}
        showDetailOnMobile={Boolean(mobileShowDetail && selectedDevice)}
        sidebar={
          <div className="flex h-full min-h-0 flex-col bg-card">
            {/* 58px Sidebar Header matching ChatList & GroupsSidebar */}
            <div className="flex h-[58px] shrink-0 items-center justify-between gap-2 px-4">
              <div className="flex min-w-0 items-center gap-2">
                <h1 className="truncate text-xl font-bold tracking-tight text-foreground">
                  {t.accounts.pageTitle}
                </h1>
                <span className="text-xs font-medium text-muted-foreground tabular-nums">
                  {devices.length}
                </span>
              </div>

              <div className="flex items-center gap-1">
                {canWriteAccounts && <CreateDeviceDialog compact />}
                <button
                  type="button"
                  onClick={() => void query.refetch()}
                  disabled={query.isFetching}
                  title={t.refresh}
                  aria-label={t.refresh}
                  className="flex size-9 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50"
                >
                  <RefreshCw className={cn('size-4', query.isFetching && 'animate-spin')} />
                </button>
              </div>
            </div>

            {/* Search & Status Filters */}
            <div className="flex flex-col gap-2.5 px-3 pb-2.5">
              <div className="relative">
                <Search className="pointer-events-none absolute start-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t.accounts.searchPlaceholder}
                  className="h-9 w-full rounded-full bg-secondary ps-10 pe-4 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
                />
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                {(
                  [
                    {id: 'all', label: t.accounts.filterAll, count: devices.length},
                    {id: 'online', label: t.accounts.filterOnline, count: onlineCount},
                    {id: 'offline', label: t.accounts.filterOffline, count: offlineCount},
                  ] as const
                ).map((tab) => {
                  const active = stateFilter === tab.id;
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setStateFilter(tab.id)}
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
              </div>
            </div>

            {/* Account Rows */}
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
              {query.isLoading ? (
                <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  <span>{t.loading}</span>
                </div>
              ) : apiErr ? (
                <div className="p-6 text-center text-sm text-destructive">{apiErr.message}</div>
              ) : devices.length === 0 ? (
                <div className="p-6 text-center text-sm text-muted-foreground">
                  <p className="font-medium text-foreground">{t.accounts.emptyTitle}</p>
                  <p className="mt-1 text-xs">{t.accounts.emptyDesc}</p>
                </div>
              ) : visibleDevices.length === 0 ? (
                <div className="p-6 text-center text-sm text-muted-foreground">
                  {t.accounts.noMatches}
                </div>
              ) : (
                <ul className="space-y-0.5">
                  {visibleDevices.map((dev) => {
                    const isSelected = selectedDeviceId === dev.id;
                    const title = dev.resolved_name || dev.alias || dev.display_name || dev.id;
                    const stateLabel =
                      t.accounts.states[dev.state] ?? t.accounts.states.disconnected;
                    const toneClass = stateToneClass[dev.state] ?? stateToneClass.disconnected;

                    return (
                      <li key={dev.id}>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedDeviceId(dev.id);
                            setMobileShowDetail(true);
                          }}
                          className={cn(
                            'flex w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 text-start transition-colors',
                            isSelected ? 'bg-secondary' : 'hover:bg-secondary/60',
                          )}
                        >
                          {dev.jid || dev.phone_number ? (
                            <ContactAvatar
                              deviceId={dev.id}
                              jid={dev.jid || dev.phone_number || ''}
                              name={title}
                              sizeClass="size-11"
                            />
                          ) : (
                            <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                              <Smartphone className="size-5" />
                            </span>
                          )}

                          <div className="min-w-0 flex-1">
                            <div className="flex items-baseline justify-between gap-2">
                              <span className="truncate text-[14.5px] font-medium text-foreground">
                                {title}
                              </span>
                              <span
                                className={cn(
                                  'shrink-0 text-[11px] font-medium whitespace-nowrap',
                                  toneClass,
                                )}
                              >
                                {stateLabel}
                              </span>
                            </div>

                            <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                              <span
                                aria-hidden="true"
                                className={cn(
                                  'size-1.5 shrink-0 rounded-full',
                                  accountDotTone(dev.id),
                                )}
                              />
                              <span dir="ltr" className="truncate font-mono text-[11px]">
                                {dev.id}
                              </span>
                              {dev.phone_number && (
                                <>
                                  <span aria-hidden="true">·</span>
                                  <span
                                    dir="ltr"
                                    className="truncate font-mono text-[11px] tabular-nums"
                                  >
                                    {dev.phone_number}
                                  </span>
                                </>
                              )}
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
        }
        detail={
          selectedDevice ? (
            <AccountWorkspacePanel
              key={selectedDevice.id}
              device={selectedDevice}
              onBack={() => setMobileShowDetail(false)}
              onLoginQr={setQrDevice}
              onLoginCode={setCodeDevice}
              onEditAlias={setAliasDevice}
              onDeleted={(deletedId) => {
                if (selectedDeviceId === deletedId) {
                  setSelectedDeviceId(null);
                  setMobileShowDetail(false);
                }
              }}
            />
          ) : null
        }
        emptyState={
          <WorkspaceEmptyState
            icon={Smartphone}
            title={t.accounts.selectPrompt}
            hint={t.accounts.selectHint}
            action={canWriteAccounts ? <CreateDeviceDialog /> : undefined}
          />
        }
      />

      <LoginQrDialog device={qrDevice} onOpenChange={(open) => !open && setQrDevice(null)} />
      <LoginCodeDialog
        device={codeDevice}
        onOpenChange={(open) => !open && setCodeDevice(null)}
      />
      <EditAliasDialog
        device={aliasDevice}
        onOpenChange={(open) => !open && setAliasDevice(null)}
      />
    </>
  );
}
