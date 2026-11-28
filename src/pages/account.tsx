import {useCallback, useMemo, useRef, useState} from 'react';
import {useMutation, useQuery} from '@tanstack/react-query';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Building2,
  Camera,
  CheckCircle2,
  Loader2,
  MessagesSquare,
  RefreshCw,
  Search,
  UserCheck,
  UserRound,
  XCircle,
} from 'lucide-react';
import {Link, useSearchParams} from 'react-router-dom';
import {
  listAccountContacts,
  lookupBusinessProfile,
  lookupUserAvatar,
  lookupUserCheck,
  lookupUserInfo,
} from '@/api/client';
import type {
  AvatarResponse,
  BusinessProfileResponse,
  CheckResponse,
  UserInfoResponse,
} from '@/api/types';
import {ContactAvatar} from '@/components/contact-avatar';
import {SidebarAccountSelect, useActiveDevice} from '@/components/device-selector-bar';
import {
  GowaSetupNotice,
  isGowaConnectionError,
  SplitWorkspace,
  WorkspaceEmptyState,
} from '@/components/layout/split-workspace';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Skeleton} from '@/components/ui/skeleton';
import {formatJidPhone} from '@/features/chat/display-name';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';
import {matchesNormalizedQuery, normalizeSearchInput, toWhatsAppJid} from '@/lib/phone';
import {cn} from '@/lib/utils';
import {hasUserAnyPermission, hasUserPermission, useAuthStore} from '@/stores/auth';

type LookupMode = 'info' | 'check' | 'avatar' | 'business';

const SIDEBAR_STORAGE_KEY = 'gowa-lite:account-sidebar-width';

export default function AccountPage() {
  const {lang, t} = useI18n();
  const isRtl = lang === 'ar';
  const BackIcon = isRtl ? ArrowRight : ArrowLeft;
  const user = useAuthStore((s) => s.user);
  const canReadChats = hasUserPermission(user, 'chats:read');
  const canViewSettings = hasUserAnyPermission(user, ['settings:read', 'settings:write']);
  const [searchParams] = useSearchParams();
  const initialDeviceParam = searchParams.get('device') ?? undefined;

  const deviceState = useActiveDevice(initialDeviceParam);
  const deviceId = deviceState.selectedDeviceId;
  const activeDevice = deviceState.selectedDevice;

  const [contactSearch, setContactSearch] = useState('');
  const [selectedContactName, setSelectedContactName] = useState('');
  const [lookupTarget, setLookupTarget] = useState('');
  const [mobileShowDetail, setMobileShowDetail] = useState(false);

  const [lookupMode, setLookupMode] = useState<LookupMode>('info');
  const [isPreviewAvatar, setIsPreviewAvatar] = useState(false);
  const [isCommunityAvatar, setIsCommunityAvatar] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [userInfoResult, setUserInfoResult] = useState<UserInfoResponse | null>(null);
  const [checkResult, setCheckResult] = useState<CheckResponse | null>(null);
  const [avatarResult, setAvatarResult] = useState<AvatarResponse | null>(null);
  const [businessResult, setBusinessResult] = useState<BusinessProfileResponse | null>(null);

  const latestLookupRef = useRef({deviceId: '', mode: 'info' as LookupMode, target: ''});

  const contactsQuery = useQuery({
    queryKey: ['account-contacts', deviceId],
    queryFn: () => listAccountContacts(deviceId),
    enabled: Boolean(deviceId),
    retry: 1,
  });

  const resetResults = useCallback(() => {
    setLookupError(null);
    setUserInfoResult(null);
    setCheckResult(null);
    setAvatarResult(null);
    setBusinessResult(null);
  }, []);

  const lookupMutation = useMutation({
    mutationFn: async ({
      targetDeviceId,
      targetMode,
      rawTarget,
      preview,
      community,
    }: {
      targetDeviceId: string;
      targetMode: LookupMode;
      rawTarget: string;
      preview: boolean;
      community: boolean;
    }) => {
      const normalized = normalizeSearchInput(rawTarget) || rawTarget.trim();
      if (targetMode === 'info') {
        return {
          targetDeviceId,
          targetMode,
          rawTarget,
          data: await lookupUserInfo(targetDeviceId, normalized),
        };
      }
      if (targetMode === 'check') {
        return {
          targetDeviceId,
          targetMode,
          rawTarget,
          data: await lookupUserCheck(targetDeviceId, normalized),
        };
      }
      if (targetMode === 'avatar') {
        return {
          targetDeviceId,
          targetMode,
          rawTarget,
          data: await lookupUserAvatar(targetDeviceId, normalized, preview, community),
        };
      }
      return {
        targetDeviceId,
        targetMode,
        rawTarget,
        data: await lookupBusinessProfile(targetDeviceId, normalized),
      };
    },
    onMutate: (vars) => {
      latestLookupRef.current = {
        deviceId: vars.targetDeviceId,
        mode: vars.targetMode,
        target: vars.rawTarget,
      };
      resetResults();
    },
    onSuccess: (res) => {
      const latest = latestLookupRef.current;
      if (
        res.targetDeviceId !== latest.deviceId ||
        res.targetMode !== latest.mode ||
        res.rawTarget !== latest.target
      ) {
        return;
      }
      if (res.targetMode === 'info') setUserInfoResult(res.data as UserInfoResponse);
      else if (res.targetMode === 'check') setCheckResult(res.data as CheckResponse);
      else if (res.targetMode === 'avatar') setAvatarResult(res.data as AvatarResponse);
      else setBusinessResult(res.data as BusinessProfileResponse);
    },
    onError: (err, vars) => {
      const latest = latestLookupRef.current;
      if (
        vars.targetDeviceId !== latest.deviceId ||
        vars.targetMode !== latest.mode ||
        vars.rawTarget !== latest.target
      ) {
        return;
      }
      setLookupError(toApiError(err).message);
    },
  });

  const runLookup = useCallback(
    (
      rawTarget: string,
      modeOverride?: LookupMode,
      previewOverride?: boolean,
      communityOverride?: boolean,
    ) => {
      const trimmed = rawTarget.trim();
      if (!deviceId || !trimmed) return;
      const mode = modeOverride ?? lookupMode;
      lookupMutation.mutate({
        targetDeviceId: deviceId,
        targetMode: mode,
        rawTarget: trimmed,
        preview: previewOverride ?? isPreviewAvatar,
        community: communityOverride ?? isCommunityAvatar,
      });
    },
    [deviceId, isCommunityAvatar, isPreviewAvatar, lookupMode, lookupMutation],
  );

  const contacts = useMemo(() => contactsQuery.data ?? [], [contactsQuery.data]);
  const filteredContacts = useMemo(() => {
    if (!contactSearch.trim()) return contacts;
    return contacts.filter((c) =>
      matchesNormalizedQuery([c.name, formatJidPhone(c.jid), c.jid], contactSearch),
    );
  }, [contacts, contactSearch]);

  const typedTarget = contactSearch.trim();
  const hasDetail = Boolean(lookupTarget.trim());

  const deviceErr = deviceState.error ? toApiError(deviceState.error) : null;
  if (deviceErr && isGowaConnectionError(deviceErr)) {
    return (
      <GowaSetupNotice
        apiErr={deviceErr}
        isAdmin={canViewSettings}
        onRetry={() => void deviceState.refetch()}
      />
    );
  }

  return (
    <SplitWorkspace
      storageKey={SIDEBAR_STORAGE_KEY}
      showDetailOnMobile={mobileShowDetail && hasDetail}
      sidebar={
        <div className="flex h-full min-h-0 flex-col bg-card">
          {/* 58px Sidebar Header */}
          <div className="flex h-[58px] shrink-0 items-center justify-between gap-2 px-4">
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="truncate text-xl font-bold tracking-tight text-foreground">
                {t.account.pageTitle}
              </h1>
              {contacts.length > 0 && (
                <span className="text-xs font-medium text-muted-foreground tabular-nums">
                  {contacts.length}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => {
                void deviceState.refetch();
                if (deviceId) void contactsQuery.refetch();
              }}
              disabled={deviceState.isFetching || contactsQuery.isFetching}
              title={t.refresh}
              aria-label={t.refresh}
              className="flex size-9 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50"
            >
              <RefreshCw
                className={cn(
                  'size-4',
                  (deviceState.isFetching || contactsQuery.isFetching) && 'animate-spin',
                )}
              />
            </button>
          </div>

          {/* Account Switcher & Unified Search/Inspect Input */}
          <div className="flex flex-col gap-2.5 border-b border-border/60 px-3 pb-3">
            <SidebarAccountSelect
              devices={deviceState.devices}
              selectedDevice={activeDevice}
              selectedDeviceId={deviceId}
              onSelectDevice={(id) => {
                latestLookupRef.current = {deviceId: id, mode: lookupMode, target: ''};
                deviceState.setSelectedDeviceId(id);
                setLookupTarget('');
                setSelectedContactName('');
                setMobileShowDetail(false);
                resetResults();
              }}
            />

            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!typedTarget) return;
                setSelectedContactName('');
                setLookupTarget(typedTarget);
                setMobileShowDetail(true);
                runLookup(typedTarget);
              }}
              className="relative"
            >
              <Search className="pointer-events-none absolute start-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                value={contactSearch}
                onChange={(e) => setContactSearch(e.target.value)}
                placeholder={t.account.searchAndLookupPlaceholder}
                className="h-9 w-full rounded-full bg-secondary ps-10 pe-4 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
              />
            </form>
          </div>

          {/* Contacts & Direct Inspect Rows */}
          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
            {typedTarget && (
              <button
                type="button"
                onClick={() => {
                  setSelectedContactName('');
                  setLookupTarget(typedTarget);
                  setMobileShowDetail(true);
                  runLookup(typedTarget);
                }}
                className="mb-1.5 flex w-full cursor-pointer items-center gap-2.5 rounded-xl border border-primary/30 bg-primary/5 px-3 py-2 text-start text-xs font-medium text-primary transition-colors hover:bg-primary/10"
              >
                <Search className="size-4 shrink-0" />
                <span className="truncate">{t.account.inspectTypedTarget(typedTarget)}</span>
              </button>
            )}

            {deviceState.isLoading || contactsQuery.isLoading ? (
              <div className="space-y-0.5" aria-busy="true">
                {Array.from({length: 6}).map((_, index) => (
                  <Skeleton key={index} className="h-14 w-full" />
                ))}
              </div>
            ) : deviceErr ? (
              <div className="p-6 text-center text-sm text-destructive">{deviceErr.message}</div>
            ) : !deviceId ? (
              <div className="p-6 text-center text-xs text-muted-foreground">
                <p className="font-medium text-foreground">{t.deviceSelector.noDevicesTitle}</p>
                <p className="mt-1">{t.deviceSelector.noDevicesDesc}</p>
              </div>
            ) : contactsQuery.error ? (
              <div className="p-6 text-center text-xs text-destructive">
                {toApiError(contactsQuery.error).message}
              </div>
            ) : filteredContacts.length === 0 ? (
              <div className="p-6 text-center text-xs text-muted-foreground">
                {t.account.contactsEmpty}
              </div>
            ) : (
              <ul className="space-y-0.5">
                {filteredContacts.map((contact) => {
                  const phoneLabel = formatJidPhone(contact.jid);
                  const display = contact.name || phoneLabel || contact.jid;
                  const isSelected = lookupTarget === contact.jid;

                  return (
                    <li key={contact.jid}>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedContactName(display);
                          setLookupTarget(contact.jid);
                          setMobileShowDetail(true);
                          runLookup(contact.jid);
                        }}
                        className={cn(
                          'flex w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-2 text-start transition-colors',
                          isSelected ? 'bg-secondary' : 'hover:bg-secondary/60',
                        )}
                      >
                        <ContactAvatar
                          deviceId={deviceId}
                          jid={contact.jid}
                          name={display}
                          sizeClass="size-10"
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[14px] font-medium text-foreground">
                            {display}
                          </p>
                          <p
                            dir="ltr"
                            className="truncate font-mono text-[11px] tabular-nums text-muted-foreground"
                          >
                            {phoneLabel || contact.jid}
                          </p>
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
        hasDetail ? (
          <div className="flex h-full min-h-0 flex-col bg-background">
            {/* Sticky 58px Detail Header */}
            <header className="flex h-[58px] shrink-0 items-center justify-between gap-3 border-b border-border bg-card px-3">
              <div className="flex min-w-0 items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => setMobileShowDetail(false)}
                  title={t.account.backToContacts}
                  aria-label={t.account.backToContacts}
                  className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground lg:hidden"
                >
                  <BackIcon className="size-4" />
                </button>

                {lookupTarget.includes('@') ? (
                  <ContactAvatar
                    deviceId={deviceId}
                    jid={lookupTarget}
                    name={selectedContactName || lookupTarget}
                    sizeClass="size-10"
                    eager
                  />
                ) : (
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-secondary text-primary">
                    <UserRound className="size-5" />
                  </span>
                )}

                <div className="min-w-0">
                  <h2 className="truncate text-sm font-semibold text-foreground">
                    {selectedContactName || formatJidPhone(lookupTarget) || lookupTarget}
                  </h2>
                  <p dir="ltr" className="truncate font-mono text-[11px] text-muted-foreground">
                    {lookupTarget}
                  </p>
                </div>
              </div>

              {canReadChats && (
                <Link
                  to={
                    deviceId && toWhatsAppJid(lookupTarget)
                      ? `/chats?device=${encodeURIComponent(deviceId)}&jid=${encodeURIComponent(toWhatsAppJid(lookupTarget))}`
                      : deviceId
                        ? `/chats?device=${encodeURIComponent(deviceId)}`
                        : '/chats'
                  }
                  className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted whitespace-nowrap"
                >
                  <MessagesSquare className="size-3.5" />
                  <span className="hidden sm:inline">{t.account.openInChats}</span>
                </Link>
              )}
            </header>

            {/* Lookup Modes Toolbar */}
            <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-card/60 px-4 py-2">
              {(
                [
                  {id: 'info', label: t.account.lookupModeInfo, icon: UserRound},
                  {id: 'check', label: t.account.lookupModeCheck, icon: UserCheck},
                  {id: 'avatar', label: t.account.lookupModeAvatar, icon: Camera},
                  {id: 'business', label: t.account.lookupModeBusiness, icon: Building2},
                ] as const
              ).map((mode) => {
                const Icon = mode.icon;
                const active = lookupMode === mode.id;
                return (
                  <button
                    key={mode.id}
                    type="button"
                    onClick={() => {
                      setLookupMode(mode.id);
                      runLookup(lookupTarget, mode.id);
                    }}
                    className={cn(
                      'inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-3 text-xs font-medium whitespace-nowrap transition-colors',
                      active
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                    )}
                  >
                    <Icon className="size-3.5" />
                    <span>{mode.label}</span>
                  </button>
                );
              })}
            </div>

            {/* Lookup Form & Results */}
            <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
              <div className="mx-auto max-w-3xl space-y-5">
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    runLookup(lookupTarget);
                  }}
                  className="space-y-3 rounded-xl border border-border bg-card p-4"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      dir="ltr"
                      aria-label={t.account.lookupTargetLabel}
                      className="min-w-[220px] flex-1"
                      value={lookupTarget}
                      onChange={(e) => {
                        setSelectedContactName('');
                        setLookupTarget(e.target.value);
                      }}
                      placeholder={t.account.lookupTargetPlaceholder}
                      required
                    />
                    <Button type="submit" disabled={lookupMutation.isPending || !lookupTarget.trim()}>
                      {lookupMutation.isPending ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Search className="size-4" />
                      )}
                      <span>{lookupMutation.isPending ? t.loading : t.account.lookupSubmit}</span>
                    </Button>
                  </div>

                  {lookupMode === 'avatar' && (
                    <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
                      <label className="inline-flex cursor-pointer items-center gap-1.5">
                        <input
                          type="checkbox"
                          checked={isPreviewAvatar}
                          onChange={(e) => {
                            const next = e.target.checked;
                            setIsPreviewAvatar(next);
                            runLookup(lookupTarget, 'avatar', next, isCommunityAvatar);
                          }}
                          className="size-3.5 accent-primary"
                        />
                        <span>{t.account.previewOnly}</span>
                      </label>
                      <label className="inline-flex cursor-pointer items-center gap-1.5">
                        <input
                          type="checkbox"
                          checked={isCommunityAvatar}
                          onChange={(e) => {
                            const next = e.target.checked;
                            setIsCommunityAvatar(next);
                            runLookup(lookupTarget, 'avatar', isPreviewAvatar, next);
                          }}
                          className="size-3.5 accent-primary"
                        />
                        <span>{t.account.communityAvatar}</span>
                      </label>
                    </div>
                  )}
                </form>

                {lookupError && (
                  <div className="flex items-center gap-2 rounded-xl border border-destructive/40 bg-destructive/5 px-4 py-3 text-xs text-destructive">
                    <AlertCircle className="size-4 shrink-0" />
                    <span>{lookupError}</span>
                  </div>
                )}

                {lookupMode === 'info' && userInfoResult && (
                  <dl className="divide-y divide-border rounded-xl border border-border bg-card text-sm">
                    <div className="flex items-center justify-between gap-4 px-5 py-3">
                      <dt className="text-muted-foreground">{t.account.verifiedName}</dt>
                      <dd className="font-medium text-foreground">
                        {userInfoResult.verified_name || '—'}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between gap-4 px-5 py-3">
                      <dt className="text-muted-foreground">{t.account.bioStatus}</dt>
                      <dd className="text-foreground">{userInfoResult.status || '—'}</dd>
                    </div>
                    <div className="flex items-center justify-between gap-4 px-5 py-3">
                      <dt className="text-muted-foreground">{t.account.devicesLinked}</dt>
                      <dd className="font-mono text-xs tabular-nums text-foreground" dir="ltr">
                        {userInfoResult.devices?.map((d) => d.Device).join(', ') || '—'}
                      </dd>
                    </div>
                  </dl>
                )}

                {lookupMode === 'check' && checkResult && (
                  <div
                    className={cn(
                      'flex items-center gap-2.5 rounded-xl border px-5 py-4 text-sm font-medium',
                      checkResult.is_on_whatsapp
                        ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300'
                        : 'border-border bg-card text-muted-foreground',
                    )}
                  >
                    {checkResult.is_on_whatsapp ? (
                      <CheckCircle2 className="size-4 shrink-0" />
                    ) : (
                      <XCircle className="size-4 shrink-0" />
                    )}
                    <span>
                      {checkResult.is_on_whatsapp ? t.account.onWhatsappYes : t.account.onWhatsappNo}
                    </span>
                  </div>
                )}

                {lookupMode === 'avatar' && avatarResult && (
                  <div className="rounded-xl border border-border bg-card p-5">
                    {avatarResult.url ? (
                      <div className="flex flex-wrap items-center gap-4">
                        <img
                          src={avatarResult.url}
                          alt={lookupTarget}
                          referrerPolicy="no-referrer"
                          className="size-32 rounded-xl border border-border object-cover"
                        />
                        <div className="space-y-1 text-xs text-muted-foreground">
                          <p className="font-mono" dir="ltr">
                            ID: {avatarResult.id || '—'}
                          </p>
                          <p>Type: {avatarResult.type || '—'}</p>
                        </div>
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">{t.account.noAvatarFound}</p>
                    )}
                  </div>
                )}

                {lookupMode === 'business' && businessResult && (
                  <dl className="divide-y divide-border rounded-xl border border-border bg-card text-sm">
                    <div className="flex items-center justify-between gap-4 px-5 py-3">
                      <dt className="text-muted-foreground">JID</dt>
                      <dd className="font-mono text-xs text-foreground" dir="ltr">
                        {businessResult.jid}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between gap-4 px-5 py-3">
                      <dt className="text-muted-foreground">{t.account.businessEmail}</dt>
                      <dd className="text-foreground" dir="ltr">
                        {businessResult.email || '—'}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between gap-4 px-5 py-3">
                      <dt className="text-muted-foreground">{t.account.businessAddress}</dt>
                      <dd className="text-foreground">{businessResult.address || '—'}</dd>
                    </div>
                    <div className="flex items-center justify-between gap-4 px-5 py-3">
                      <dt className="text-muted-foreground">{t.account.businessCategories}</dt>
                      <dd className="text-foreground">
                        {businessResult.categories?.map((c) => c.name).join(' · ') || '—'}
                      </dd>
                    </div>
                    {businessResult.business_hours && businessResult.business_hours.length > 0 && (
                      <div className="px-5 py-3.5 text-xs">
                        <p className="mb-2.5 font-medium text-muted-foreground">
                          {t.account.businessHours} ({businessResult.business_hours_timezone || 'UTC'})
                        </p>
                        <div className="grid grid-cols-1 divide-y divide-border sm:grid-cols-2 sm:gap-x-8">
                          {businessResult.business_hours.map((h, i) => (
                            <div
                              key={`${h.day_of_week}-${i}`}
                              className="flex items-center justify-between py-2"
                            >
                              <span className="font-medium text-foreground">{h.day_of_week}</span>
                              <span className="tabular-nums text-muted-foreground" dir="ltr">
                                {h.open_time && h.close_time
                                  ? `${h.open_time}–${h.close_time}`
                                  : h.mode}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </dl>
                )}
              </div>
            </div>
          </div>
        ) : null
      }
      emptyState={
        <WorkspaceEmptyState
          icon={Search}
          title={t.account.selectContactPrompt}
          hint={t.account.selectContactHint}
        />
      }
    />
  );
}
