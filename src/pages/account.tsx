import {useMemo, useRef, useState} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {
  AlertCircle,
  Building2,
  Camera,
  CheckCircle2,
  Search,
  Shield,
  UserCheck,
  UserRound,
  XCircle,
} from 'lucide-react';
import {toast} from 'sonner';
import {
  changeAccountAvatar,
  changeAccountPushName,
  fileToImageUpload,
  getAccountPrivacy,
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
import {DeviceSelectorBar, useActiveDevice} from '@/components/device-selector-bar';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {Skeleton} from '@/components/ui/skeleton';
import {formatJidPhone} from '@/features/chat/display-name';
import {useI18n} from '@/lib/i18n';
import {toApiError} from '@/lib/http';
import {matchesNormalizedQuery, normalizeSearchInput} from '@/lib/phone';
import {cn} from '@/lib/utils';

type LookupMode = 'info' | 'check' | 'avatar' | 'business';

export default function AccountPage() {
  const {t} = useI18n();
  const queryClient = useQueryClient();
  const deviceState = useActiveDevice();
  const deviceId = deviceState.selectedDeviceId;
  const activeDevice = deviceState.selectedDevice;

  const [activeTab, setActiveTab] = useState<'profile' | 'lookup'>('profile');

  // Profile form states
  const [pushName, setPushName] = useState('');
  const [myAvatarUrl, setMyAvatarUrl] = useState<string | null>(null);
  const [contactSearch, setContactSearch] = useState('');
  const avatarFileInputRef = useRef<HTMLInputElement | null>(null);

  // Lookup states
  const [lookupPhone, setLookupPhone] = useState('');
  const [lookupMode, setLookupMode] = useState<LookupMode>('info');
  const [isPreviewAvatar, setIsPreviewAvatar] = useState(false);
  const [isCommunityAvatar, setIsCommunityAvatar] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [userInfoResult, setUserInfoResult] = useState<UserInfoResponse | null>(null);
  const [checkResult, setCheckResult] = useState<CheckResponse | null>(null);
  const [avatarResult, setAvatarResult] = useState<AvatarResponse | null>(null);
  const [businessResult, setBusinessResult] = useState<BusinessProfileResponse | null>(null);

  const privacyQuery = useQuery({
    queryKey: ['account-privacy', deviceId],
    queryFn: () => getAccountPrivacy(deviceId),
    enabled: Boolean(deviceId) && activeTab === 'profile',
    retry: 1,
  });

  const contactsQuery = useQuery({
    queryKey: ['account-contacts', deviceId],
    queryFn: () => listAccountContacts(deviceId),
    enabled: Boolean(deviceId) && activeTab === 'profile',
    retry: 1,
  });

  const pushNameMutation = useMutation({
    mutationFn: () => changeAccountPushName(deviceId, pushName.trim()),
    onSuccess: () => {
      toast.success(t.account.pushNameUpdatedToast);
      setPushName('');
      void deviceState.refetch();
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const avatarMutation = useMutation({
    mutationFn: async (file: File) => {
      const payload = await fileToImageUpload(file);
      await changeAccountAvatar(deviceId, payload);
    },
    onSuccess: () => {
      toast.success(t.account.avatarUpdatedToast);
      setMyAvatarUrl(null);
      void queryClient.invalidateQueries({queryKey: ['contact-avatar', deviceId]});
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const loadMyAvatarMutation = useMutation({
    mutationFn: async () => {
      const target = activeDevice?.jid || activeDevice?.phone_number || '';
      if (!target) throw new Error(t.account.noAvatarFound);
      return lookupUserAvatar(deviceId, target, false, false);
    },
    onSuccess: (res) => {
      void queryClient.invalidateQueries({queryKey: ['contact-avatar', deviceId]});
      if (!res?.url) {
        toast.info(t.account.noAvatarFound);
        setMyAvatarUrl(null);
      } else {
        setMyAvatarUrl(res.url);
      }
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const lookupMutation = useMutation({
    mutationFn: async () => {
      const target = normalizeSearchInput(lookupPhone) || lookupPhone.trim();
      setLookupError(null);
      setUserInfoResult(null);
      setCheckResult(null);
      setAvatarResult(null);
      setBusinessResult(null);

      if (lookupMode === 'info') {
        const res = await lookupUserInfo(deviceId, target);
        setUserInfoResult(res);
      } else if (lookupMode === 'check') {
        const res = await lookupUserCheck(deviceId, target);
        setCheckResult(res);
      } else if (lookupMode === 'avatar') {
        const res = await lookupUserAvatar(deviceId, target, isPreviewAvatar, isCommunityAvatar);
        setAvatarResult(res);
      } else {
        const res = await lookupBusinessProfile(deviceId, target);
        setBusinessResult(res);
      }
    },
    onError: (err) => {
      setLookupError(toApiError(err).message);
    },
  });

  const filteredContacts = useMemo(() => {
    const contacts = contactsQuery.data ?? [];
    if (!contactSearch.trim()) return contacts;
    return contacts.filter((c) =>
      matchesNormalizedQuery([c.name, formatJidPhone(c.jid), c.jid], contactSearch),
    );
  }, [contactsQuery.data, contactSearch]);

  const privacyEntries = Object.entries(privacyQuery.data ?? {}).filter(
    ([, v]) => v !== undefined && v !== '',
  );

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold text-foreground">{t.account.pageTitle}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t.account.pageSubtitle}</p>
      </div>

      <DeviceSelectorBar
        devices={deviceState.devices}
        selectedDevice={activeDevice}
        selectedDeviceId={deviceId}
        onSelectDevice={(id) => {
          deviceState.setSelectedDeviceId(id);
          setMyAvatarUrl(null);
          setUserInfoResult(null);
          setCheckResult(null);
          setAvatarResult(null);
          setBusinessResult(null);
          setLookupError(null);
        }}
        isLoading={deviceState.isLoading}
        error={deviceState.error}
        onRefresh={() => {
          void deviceState.refetch();
          if (deviceId && activeTab === 'profile') {
            void privacyQuery.refetch();
            void contactsQuery.refetch();
          }
        }}
      />

      {deviceId && (
        <>
          {/* Section Switcher */}
          <div className="inline-flex rounded-xl border border-border bg-card p-1">
            <button
              type="button"
              onClick={() => setActiveTab('profile')}
              className={cn(
                'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium whitespace-nowrap shrink-0 cursor-pointer transition-colors',
                activeTab === 'profile'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <UserRound className="size-4" />
              <span>{t.account.tabProfile}</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('lookup')}
              className={cn(
                'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium whitespace-nowrap shrink-0 cursor-pointer transition-colors',
                activeTab === 'lookup'
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Search className="size-4" />
              <span>{t.account.tabLookup}</span>
            </button>
          </div>

          {activeTab === 'profile' ? (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {/* Identity & Update Card */}
              <div className="space-y-5 rounded-xl border border-border bg-card p-5">
                <div className="flex flex-wrap items-center gap-4">
                  <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-muted">
                    {myAvatarUrl ? (
                      <img
                        src={myAvatarUrl}
                        alt={activeDevice?.resolved_name || deviceId}
                        referrerPolicy="no-referrer"
                        className="size-full object-cover"
                      />
                    ) : activeDevice?.jid || activeDevice?.phone_number ? (
                      <ContactAvatar
                        deviceId={deviceId}
                        jid={activeDevice?.jid || activeDevice?.phone_number || ''}
                        name={activeDevice?.resolved_name || activeDevice?.display_name || deviceId}
                        sizeClass="size-16"
                        textClass="text-lg"
                        eager
                      />
                    ) : (
                      <UserRound className="size-7 text-muted-foreground" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-base font-semibold text-foreground">
                      {activeDevice?.resolved_name ||
                        activeDevice?.display_name ||
                        activeDevice?.id}
                    </p>
                    <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground" dir="ltr">
                      {activeDevice?.jid || activeDevice?.phone_number || deviceId}
                    </p>
                    <div className="mt-2.5 flex flex-wrap items-center gap-2">
                      <input
                        ref={avatarFileInputRef}
                        type="file"
                        accept="image/jpeg,image/png,image/webp,image/gif"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          e.target.value = '';
                          if (file) avatarMutation.mutate(file);
                        }}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={avatarMutation.isPending}
                        onClick={() => avatarFileInputRef.current?.click()}
                      >
                        <Camera className="size-3.5" />
                        <span>{t.account.uploadAvatar}</span>
                      </Button>
                      {(activeDevice?.jid || activeDevice?.phone_number) && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={loadMyAvatarMutation.isPending}
                          onClick={() => loadMyAvatarMutation.mutate()}
                        >
                          {t.account.loadMyAvatar}
                        </Button>
                      )}
                    </div>
                  </div>
                </div>

                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    pushNameMutation.mutate();
                  }}
                  className="border-t border-border pt-4"
                >
                  <Label htmlFor="push-name-input">{t.account.pushNameLabel}</Label>
                  <div className="mt-1.5 flex items-center gap-2">
                    <Input
                      id="push-name-input"
                      value={pushName}
                      onChange={(e) => setPushName(e.target.value)}
                      placeholder={t.account.pushNamePlaceholder}
                      required
                    />
                    <Button type="submit" disabled={pushNameMutation.isPending || !pushName.trim()}>
                      {t.account.updatePushName}
                    </Button>
                  </div>
                </form>

                {/* Privacy Section */}
                <div className="border-t border-border pt-4">
                  <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
                    <Shield className="size-4 text-primary" />
                    <span>{t.account.privacyTitle}</span>
                  </div>
                  {privacyQuery.isLoading ? (
                    <div className="space-y-2">
                      <Skeleton className="h-7 w-full" />
                      <Skeleton className="h-7 w-full" />
                    </div>
                  ) : privacyQuery.error ? (
                    <p className="text-xs text-destructive">
                      {toApiError(privacyQuery.error).message}
                    </p>
                  ) : privacyEntries.length === 0 ? (
                    <p className="text-xs text-muted-foreground">—</p>
                  ) : (
                    <dl className="divide-y divide-border rounded-lg border border-border">
                      {privacyEntries.map(([key, value]) => (
                        <div
                          key={key}
                          className="flex items-center justify-between gap-3 px-3 py-2 text-xs"
                        >
                          <dt className="text-muted-foreground">
                            {t.account.privacyKeys[key] || key}
                          </dt>
                          <dd className="font-medium text-foreground">{value}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </div>
              </div>

              {/* Contacts Card */}
              <div className="flex flex-col rounded-xl border border-border bg-card p-5">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold text-foreground">
                    {t.account.contactsTitle} ({filteredContacts.length})
                  </h2>
                  <div className="relative">
                    <Search className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={contactSearch}
                      onChange={(e) => setContactSearch(e.target.value)}
                      placeholder={t.account.contactsSearchPlaceholder}
                      className="h-8 w-52 ps-8 text-xs"
                    />
                  </div>
                </div>

                {contactsQuery.isLoading ? (
                  <div className="space-y-2">
                    {[0, 1, 2, 3, 4].map((i) => (
                      <Skeleton key={i} className="h-10 w-full" />
                    ))}
                  </div>
                ) : contactsQuery.error ? (
                  <p className="text-xs text-destructive">
                    {toApiError(contactsQuery.error).message}
                  </p>
                ) : filteredContacts.length === 0 ? (
                  <p className="py-8 text-center text-xs text-muted-foreground">
                    {t.account.contactsEmpty}
                  </p>
                ) : (
                  <div className="max-h-[460px] divide-y divide-border overflow-y-auto rounded-lg border border-border">
                    {filteredContacts.map((contact) => {
                      const phoneLabel = formatJidPhone(contact.jid);
                      return (
                        <div
                          key={contact.jid}
                          className="flex items-center justify-between gap-3 px-3 py-2 text-xs"
                        >
                          <div className="flex min-w-0 items-center gap-2.5">
                            <ContactAvatar
                              deviceId={deviceId}
                              jid={contact.jid}
                              name={contact.name || phoneLabel}
                              sizeClass="size-9"
                              textClass="text-xs"
                            />
                            <span className="truncate font-medium text-foreground">
                              {contact.name || phoneLabel || '—'}
                            </span>
                          </div>
                          <span className="shrink-0 font-mono text-muted-foreground" dir="ltr">
                            {phoneLabel || contact.jid}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          ) : (
            /* Lookup Tab */
            <div className="space-y-4 rounded-xl border border-border bg-card p-5">
              <div>
                <h2 className="text-sm font-semibold text-foreground">{t.account.lookupTitle}</h2>
              </div>

              <div className="flex flex-wrap gap-1.5">
                {(
                  [
                    {id: 'info', label: t.account.lookupModeInfo, icon: UserRound},
                    {id: 'check', label: t.account.lookupModeCheck, icon: UserCheck},
                    {id: 'avatar', label: t.account.lookupModeAvatar, icon: Camera},
                    {id: 'business', label: t.account.lookupModeBusiness, icon: Building2},
                  ] as const
                ).map((mode) => {
                  const Icon = mode.icon;
                  return (
                    <button
                      key={mode.id}
                      type="button"
                      onClick={() => {
                        setLookupMode(mode.id);
                        setLookupError(null);
                      }}
                      className={cn(
                        'flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer transition-colors',
                        lookupMode === mode.id
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground',
                      )}
                    >
                      <Icon className="size-3.5" />
                      <span>{mode.label}</span>
                    </button>
                  );
                })}
              </div>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!lookupPhone.trim()) return;
                  lookupMutation.mutate();
                }}
                className="space-y-3"
              >
                <div className="flex flex-wrap items-end gap-2">
                  <div className="min-w-[240px] flex-1">
                    <Label htmlFor="lookup-phone">{t.account.lookupTargetLabel}</Label>
                    <Input
                      id="lookup-phone"
                      dir="ltr"
                      className="mt-1.5"
                      value={lookupPhone}
                      onChange={(e) => setLookupPhone(e.target.value)}
                      placeholder={t.account.lookupTargetPlaceholder}
                      required
                    />
                  </div>
                  <Button type="submit" disabled={lookupMutation.isPending || !lookupPhone.trim()}>
                    <Search className="size-4" />
                    <span>{lookupMutation.isPending ? t.loading : t.account.lookupSubmit}</span>
                  </Button>
                </div>

                {lookupMode === 'avatar' && (
                  <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
                    <label className="inline-flex cursor-pointer items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={isPreviewAvatar}
                        onChange={(e) => setIsPreviewAvatar(e.target.checked)}
                        className="size-3.5 accent-primary"
                      />
                      <span>{t.account.previewOnly}</span>
                    </label>
                    <label className="inline-flex cursor-pointer items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={isCommunityAvatar}
                        onChange={(e) => setIsCommunityAvatar(e.target.checked)}
                        className="size-3.5 accent-primary"
                      />
                      <span>{t.account.communityAvatar}</span>
                    </label>
                  </div>
                )}
              </form>

              {lookupError && (
                <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  <AlertCircle className="size-4 shrink-0" />
                  <span>{lookupError}</span>
                </div>
              )}

              {/* Results */}
              {lookupMode === 'info' && userInfoResult && (
                <dl className="divide-y divide-border rounded-lg border border-border">
                  <div className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm">
                    <dt className="text-muted-foreground">{t.account.verifiedName}</dt>
                    <dd className="font-medium text-foreground">
                      {userInfoResult.verified_name || '—'}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm">
                    <dt className="text-muted-foreground">{t.account.bioStatus}</dt>
                    <dd className="text-foreground">{userInfoResult.status || '—'}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm">
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
                    'flex items-center gap-2 rounded-lg border px-4 py-3 text-sm font-medium',
                    checkResult.is_on_whatsapp
                      ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300'
                      : 'border-border bg-muted/40 text-muted-foreground',
                  )}
                >
                  {checkResult.is_on_whatsapp ? (
                    <CheckCircle2 className="size-4 shrink-0" />
                  ) : (
                    <XCircle className="size-4 shrink-0" />
                  )}
                  <span>
                    {checkResult.is_on_whatsapp
                      ? t.account.onWhatsappYes
                      : t.account.onWhatsappNo}
                  </span>
                </div>
              )}

              {lookupMode === 'avatar' && avatarResult && (
                <div className="rounded-lg border border-border p-4">
                  {avatarResult.url ? (
                    <div className="flex flex-wrap items-center gap-4">
                      <img
                        src={avatarResult.url}
                        alt={lookupPhone}
                        className="size-28 rounded-xl border border-border object-cover"
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
                <dl className="divide-y divide-border rounded-lg border border-border">
                  <div className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm">
                    <dt className="text-muted-foreground">JID</dt>
                    <dd className="font-mono text-xs text-foreground" dir="ltr">
                      {businessResult.jid}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm">
                    <dt className="text-muted-foreground">{t.account.businessEmail}</dt>
                    <dd className="text-foreground" dir="ltr">
                      {businessResult.email || '—'}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm">
                    <dt className="text-muted-foreground">{t.account.businessAddress}</dt>
                    <dd className="text-foreground">{businessResult.address || '—'}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm">
                    <dt className="text-muted-foreground">{t.account.businessCategories}</dt>
                    <dd className="text-foreground">
                      {businessResult.categories?.map((c) => c.name).join(' · ') || '—'}
                    </dd>
                  </div>
                  {businessResult.business_hours && businessResult.business_hours.length > 0 && (
                    <div className="px-4 py-3 text-xs">
                      <p className="mb-2 font-medium text-muted-foreground">
                        {t.account.businessHours} ({businessResult.business_hours_timezone || 'UTC'})
                      </p>
                      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                        {businessResult.business_hours.map((h, i) => (
                          <div
                            key={`${h.day_of_week}-${i}`}
                            className="flex items-center justify-between rounded bg-muted/40 px-2.5 py-1.5"
                          >
                            <span className="font-medium text-foreground">{h.day_of_week}</span>
                            <span className="tabular-nums text-muted-foreground" dir="ltr">
                              {h.open_time && h.close_time ? `${h.open_time}–${h.close_time}` : h.mode}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </dl>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
