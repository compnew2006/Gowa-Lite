import {useState} from 'react';
import {useMutation, useQueryClient} from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRight,
  Clock,
  KeyRound,
  LogOut,
  MessagesSquare,
  Pencil,
  QrCode,
  RefreshCw,
  Search,
  Shield,
  Smartphone,
  Star,
  Trash2,
  Wrench,
} from 'lucide-react';
import {Link, useNavigate} from 'react-router-dom';
import {toast} from 'sonner';
import {deleteDevice, logoutDevice, reconnectDevice} from '@/api/client';
import type {RegistryDevice} from '@/api/types';
import {ContactAvatar} from '@/components/contact-avatar';
import {Button} from '@/components/ui/button';
import {Dialog} from '@/components/ui/dialog';
import {AccountProfilePanel} from '@/features/accounts/account-profile-panel';
import {AccountCloseRatingPanel} from '@/features/accounts/account-close-rating-panel';
import {AccountDailyResetPanel} from '@/features/accounts/account-daily-reset-panel';
import {RejectCallPanel} from '@/features/accounts/reject-call-panel';
import {accountDotTone, accountStateToneClass} from '@/features/accounts/account-display';
import {phoneFromJid} from '@/features/chat/display-name';
import {UNIFIED_CHATS_QUERY_PREFIX} from '@/features/chat/inbox-query-keys';
import {formatDate} from '@/lib/format';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';
import {toastWithView} from '@/lib/toast-with-view';
import {cn} from '@/lib/utils';
import {hasUserPermission, useAuthStore} from '@/stores/auth';

type AccountWorkspaceTab = 'connection' | 'profile' | 'tools' | 'ratings' | 'dailyReset';

export function AccountWorkspacePanel({
  device,
  onBack,
  onLoginQr,
  onLoginCode,
  onEditAlias,
  onDeleted,
}: {
  device: RegistryDevice;
  onBack: () => void;
  onLoginQr: (device: RegistryDevice) => void;
  onLoginCode: (device: RegistryDevice) => void;
  onEditAlias: (device: RegistryDevice) => void;
  onDeleted: (deviceId: string) => void;
}) {
  const queryClient = useQueryClient();
  const {lang, t} = useI18n();
  const navigate = useNavigate();
  const isRtl = lang === 'ar';
  const BackIcon = isRtl ? ArrowRight : ArrowLeft;
  const user = useAuthStore((s) => s.user);
  const canReadAccounts = hasUserPermission(user, 'accounts:read');
  const canWriteAccounts = hasUserPermission(user, 'accounts:write');
  const canRejectCalls = hasUserPermission(user, 'misc:calls.reject');
  const canReadChats = hasUserPermission(user, 'chats:read');

  const [activeTab, setActiveTab] = useState<AccountWorkspaceTab>('connection');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const reconnectMutation = useMutation({
    mutationFn: () => reconnectDevice(device.id),
    onSuccess: () => {
      toastWithView(t.accounts.reconnectToast, {
        label: t.scheduled.viewAction,
        to: '/accounts',
        navigate,
      });
      void queryClient.invalidateQueries({queryKey: ['devices']});
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const logoutMutation = useMutation({
    mutationFn: () => logoutDevice(device.id),
    onSuccess: () => {
      toastWithView(t.accounts.loggedOutToast, {
        label: t.scheduled.viewAction,
        to: '/accounts',
        navigate,
      });
      void queryClient.invalidateQueries({queryKey: ['devices']});
      void queryClient.invalidateQueries({queryKey: UNIFIED_CHATS_QUERY_PREFIX});
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteDevice(device.id),
    onSuccess: () => {
      toastWithView(t.accounts.deletedToast, {
        label: t.scheduled.viewAction,
        to: '/accounts',
        navigate,
      });
      setConfirmDelete(false);
      void queryClient.invalidateQueries({queryKey: ['devices']});
      void queryClient.invalidateQueries({queryKey: UNIFIED_CHATS_QUERY_PREFIX});
      onDeleted(device.id);
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const title = device.resolved_name || device.alias || device.display_name || device.id;
  const accountPhone = device.phone_number || phoneFromJid(device.jid);
  const isLoggedIn = device.state === 'logged_in';
  const stateLabel = t.accounts.states[device.state] ?? t.accounts.states.disconnected;
  const toneClass = accountStateToneClass[device.state] ?? accountStateToneClass.disconnected;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* Sticky 58px Workspace Header matching MessageView */}
      <header className="flex h-[58px] shrink-0 items-center justify-between gap-3 border-b border-border bg-card px-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <button
            type="button"
            onClick={onBack}
            title={t.accounts.backToList}
            aria-label={t.accounts.backToList}
            className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground lg:hidden"
          >
            <BackIcon className="size-4" />
          </button>

          {device.jid || device.phone_number ? (
            <ContactAvatar
              deviceId={device.id}
              jid={device.jid || device.phone_number || ''}
              name={title}
              sizeClass="size-10"
              eager
            />
          ) : (
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground">
              <Smartphone className="size-5" />
            </span>
          )}

          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-foreground">{title}</h2>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className={cn('inline-flex items-center gap-1 font-medium', toneClass)}>
                <span
                  aria-hidden="true"
                  className={cn('size-1.5 shrink-0 rounded-full', accountDotTone(device.id))}
                />
                <span>{stateLabel}</span>
              </span>
              <span aria-hidden="true">·</span>
              <span dir="ltr" className="font-mono">
                {device.id}
              </span>
              {accountPhone && (
                <>
                  <span aria-hidden="true">·</span>
                  <span dir="ltr" className="font-mono tabular-nums">
                    {accountPhone}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        {canWriteAccounts && (
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onEditAlias(device)}
              title={t.accounts.editAliasAria}
              aria-label={t.accounts.editAliasAria}
            >
              <Pencil className="size-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={reconnectMutation.isPending}
              onClick={() => reconnectMutation.mutate()}
            >
              <RefreshCw className={cn('size-3.5', reconnectMutation.isPending && 'animate-spin')} />
              <span className="hidden sm:inline">{t.accounts.reconnectDevice}</span>
            </Button>
          </div>
        )}
      </header>

      {/* Workspace Tabs */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border bg-card/60 px-4 py-2 overflow-x-auto">
        {(
          [
            {id: 'connection' as const, label: t.accounts.tabConnection, icon: Smartphone},
            {id: 'profile' as const, label: t.accounts.tabProfile, icon: Shield},
            ...(canReadAccounts
              ? [
                  {id: 'ratings' as const, label: t.accounts.closeRatings.tab, icon: Star},
                  {id: 'dailyReset' as const, label: t.accounts.dailyReset.tab, icon: Clock},
                ]
              : []),
            ...(canRejectCalls
              ? [{id: 'tools' as const, label: t.accounts.tabTools, icon: Wrench}]
              : []),
          ]
        ).map((tab) => {
          const Icon = tab.icon;
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              aria-pressed={active}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                'inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-3 text-xs font-medium whitespace-nowrap transition-colors',
                active
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
              )}
            >
              <Icon className="size-3.5" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* Workspace Body */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        <div className="mx-auto max-w-3xl space-y-5">
          {activeTab === 'connection' && (
            <>
              {!isLoggedIn && canWriteAccounts && (
                <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-5">
                  <h3 className="text-sm font-semibold text-foreground">
                    {t.accounts.pairingPromptTitle}
                  </h3>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {t.accounts.pairingPromptDesc}
                  </p>
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <Button size="sm" onClick={() => onLoginQr(device)}>
                      <QrCode className="size-3.5" />
                      <span>{t.accounts.linkQr}</span>
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => onLoginCode(device)}>
                      <KeyRound className="size-3.5" />
                      <span>{t.accounts.linkCode}</span>
                    </Button>
                  </div>
                </div>
              )}

              <dl className="divide-y divide-border rounded-xl border border-border bg-card text-xs">
                <div className="flex items-center justify-between gap-4 px-5 py-3">
                  <dt className="text-muted-foreground">{t.accounts.deviceIdLabel}</dt>
                  <dd dir="ltr" className="font-mono font-medium text-foreground">
                    {device.id}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4 px-5 py-3">
                  <dt className="text-muted-foreground">{t.accounts.phoneLabel}</dt>
                  <dd dir="ltr" className="font-mono tabular-nums text-foreground">
                    {accountPhone || '—'}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4 px-5 py-3">
                  <dt className="text-muted-foreground">{t.accounts.jidLabel}</dt>
                  <dd dir="ltr" className="truncate font-mono text-foreground">
                    {device.jid || '—'}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4 px-5 py-3">
                  <dt className="text-muted-foreground">{t.accounts.createdAtLabel}</dt>
                  <dd className="tabular-nums text-foreground">
                    {formatDate(device.created_at, lang)}
                  </dd>
                </div>
              </dl>

              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-4">
                <div className="flex flex-wrap items-center gap-2">
                  {canReadChats && (
                    <Link
                      to={`/chats?device=${encodeURIComponent(device.id)}`}
                      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted whitespace-nowrap"
                    >
                      <MessagesSquare className="size-3.5" />
                      <span>{t.accounts.openInChats}</span>
                    </Link>
                  )}
                  <Link
                    to={`/account?device=${encodeURIComponent(device.id)}`}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted whitespace-nowrap"
                  >
                    <Search className="size-3.5" />
                    <span>{t.accounts.openProfileLookup}</span>
                  </Link>
                </div>

                {canWriteAccounts && (
                  <div className="flex flex-wrap items-center gap-2">
                    {isLoggedIn && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={logoutMutation.isPending}
                        onClick={() => logoutMutation.mutate()}
                      >
                        <LogOut className="size-3.5" />
                        <span>{t.accounts.logoutDevice}</span>
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => setConfirmDelete(true)}
                    >
                      <Trash2 className="size-3.5" />
                      <span>{t.deleteAction}</span>
                    </Button>
                  </div>
                )}
              </div>
            </>
          )}

          {activeTab === 'profile' && (
            <AccountProfilePanel
              key={device.id}
              device={device}
              onDeviceUpdated={() => void queryClient.invalidateQueries({queryKey: ['devices']})}
            />
          )}

          {activeTab === 'tools' && canRejectCalls && <RejectCallPanel deviceId={device.id} />}
          {activeTab === 'ratings' && canReadAccounts && (
            <AccountCloseRatingPanel key={device.id} deviceId={device.id} canWrite={canWriteAccounts} />
          )}
          {activeTab === 'dailyReset' && canReadAccounts && (
            <AccountDailyResetPanel key={device.id} deviceId={device.id} canWrite={canWriteAccounts} />
          )}
        </div>
      </div>

      <Dialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t.accounts.deleteTitle}
        description={t.accounts.deleteDesc(title)}
        className="sm:max-w-sm"
      >
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={() => setConfirmDelete(false)}>
            {t.cancel}
          </Button>
          <Button
            variant="destructive"
            disabled={deleteMutation.isPending}
            onClick={() => deleteMutation.mutate()}
          >
            {t.confirmDelete}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
