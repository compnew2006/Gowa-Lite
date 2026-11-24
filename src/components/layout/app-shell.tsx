import {useEffect, useRef, useState} from 'react';
import {useQuery, useQueryClient} from '@tanstack/react-query';
import {
  CalendarClock,
  LogOut,
  Menu,
  MessagesSquare,
  Moon,
  Radio,
  Settings,
  Smartphone,
  Sun,
  UserCog,
  Users,
  UsersRound,
  X,
} from 'lucide-react';
import {NavLink, Outlet, useLocation, useNavigate} from 'react-router-dom';
import {toast} from 'sonner';
import {listUnifiedChats, logoutUser, updateMyTheme} from '@/api/client';
import {LanguageToggle} from '@/components/language-toggle';
import {Button} from '@/components/ui/button';
import {NotificationControls} from '@/features/notifications/notification-controls';
import {onWsEvent} from '@/lib/events';
import {useI18n} from '@/lib/i18n';
import {
  extractIncomingAlertData,
  formatUnreadTabTitle,
  getBrowserNotificationPermission,
  playIncomingMessageChime,
  useNotificationPrefsStore,
} from '@/lib/notifications';
import {cn} from '@/lib/utils';
import {wsClient, useWsStore} from '@/lib/ws';
import {useAuthStore} from '@/stores/auth';

export function AppShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const {t} = useI18n();
  const user = useAuthStore((s) => s.user);
  const theme = useAuthStore((s) => s.theme);
  const setThemeLocal = useAuthStore((s) => s.setThemeLocal);
  const clearSession = useAuthStore((s) => s.clearSession);
  const wsStatus = useWsStore((s) => s.status);
  const soundEnabled = useNotificationPrefsStore((s) => s.soundEnabled);
  const browserEnabled = useNotificationPrefsStore((s) => s.browserEnabled);
  const [mobileOpen, setMobileOpen] = useState(false);
  const notifiedIdsRef = useRef<Set<string>>(new Set());

  const unreadQuery = useQuery({
    queryKey: ['unified-chats', [], '', false],
    queryFn: () => listUnifiedChats({}),
    enabled: Boolean(user),
    refetchInterval: 30_000,
    staleTime: 20_000,
  });
  const totalUnread = unreadQuery.data?.total_unread ?? 0;
  const accounts = unreadQuery.data?.accounts ?? [];

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const baseTitle = `${t.appName} — ${t.appSubtitle}`;
    document.title = formatUnreadTabTitle(totalUnread, baseTitle);
    return () => {
      document.title = baseTitle;
    };
  }, [t.appName, t.appSubtitle, totalUnread]);

  useEffect(() => {
    if (!user) return;
    return onWsEvent((event) => {
      const code = (event.code || '').toUpperCase();
      if (
        !location.pathname.startsWith('/chats') &&
        (code === 'MESSAGE_RECEIVED' ||
          code === 'MESSAGE' ||
          code === 'CHAT_UPDATED' ||
          code === 'MESSAGE_REVOKED' ||
          code === 'MESSAGE.REVOKED' ||
          code === 'MESSAGE_DELETED' ||
          code === 'MESSAGE.DELETED')
      ) {
        void queryClient.invalidateQueries({queryKey: ['unified-chats']});
      }

      const alert = extractIncomingAlertData(event);
      if (!alert) return;

      const dedupeKey = `${alert.deviceId}::${alert.messageId}`;
      if (notifiedIdsRef.current.has(dedupeKey)) return;
      if (notifiedIdsRef.current.size >= 200) {
        notifiedIdsRef.current.clear();
      }
      notifiedIdsRef.current.add(dedupeKey);

      if (soundEnabled) {
        playIncomingMessageChime();
      }

      const isTabInactive =
        typeof document !== 'undefined' &&
        (document.visibilityState !== 'visible' || !document.hasFocus());
      if (
        browserEnabled &&
        isTabInactive &&
        getBrowserNotificationPermission() === 'granted'
      ) {
        const accountName =
          accounts.find((a) => a.id === alert.deviceId)?.display_name ?? alert.deviceId;
        const bodyText =
          alert.body ||
          (alert.mediaType ? t.chats.mediaLabels[alert.mediaType] || t.messageFallback : t.messageFallback);
        try {
          const notif = new Notification(
            t.nav.newMessageFromAccount(alert.senderName, accountName),
            {
              body: bodyText,
              tag: `${alert.deviceId}::${alert.chatJid}`,
            },
          );
          notif.onclick = () => {
            window.focus();
            navigate(
              `/chats?device=${encodeURIComponent(alert.deviceId)}&jid=${encodeURIComponent(alert.chatJid)}`,
            );
            notif.close();
          };
        } catch {
          // Ignore browser Notification construction errors
        }
      }
    });
  }, [
    accounts,
    browserEnabled,
    location.pathname,
    navigate,
    queryClient,
    soundEnabled,
    t,
    user,
  ]);

  const primaryNav = [
    {to: '/chats', label: t.nav.chats, icon: MessagesSquare, adminOnly: false},
    {to: '/scheduled', label: t.nav.scheduled, icon: CalendarClock, adminOnly: true},
    {to: '/groups', label: t.nav.groups, icon: UsersRound, adminOnly: true},
    {to: '/account', label: t.nav.account, icon: UserCog, adminOnly: true},
    {to: '/misc', label: t.nav.misc, icon: Radio, adminOnly: true},
    {to: '/accounts', label: t.nav.accounts, icon: Smartphone, adminOnly: true},
    {to: '/users', label: t.nav.users, icon: Users, adminOnly: true},
  ];

  const allNav = [
    ...primaryNav,
    {to: '/settings', label: t.nav.settings, icon: Settings, adminOnly: true},
  ];

  const isAdmin = user?.role === 'admin';
  const visiblePrimary = primaryNav.filter((item) => !item.adminOnly || isAdmin);
  const visibleAll = allNav.filter((item) => !item.adminOnly || isAdmin);
  const isDark =
    typeof document !== 'undefined'
      ? document.documentElement.classList.contains('dark')
      : theme !== 'light';
  const isWorkspaceRoute =
    location.pathname.startsWith('/chats') ||
    location.pathname.startsWith('/groups') ||
    location.pathname.startsWith('/accounts') ||
    location.pathname.startsWith('/account') ||
    location.pathname.startsWith('/misc');

  const wsTitle =
    wsStatus === 'connected'
      ? t.nav.wsConnected
      : wsStatus === 'connecting'
        ? t.nav.wsConnecting
        : t.nav.wsDisconnected;

  const handleToggleTheme = async () => {
    const nextTheme = isDark ? 'light' : 'dark';
    setThemeLocal(nextTheme);
    try {
      await updateMyTheme(nextTheme);
    } catch {
      // Keep local choice if network fails
    }
  };

  const handleLogout = async () => {
    try {
      await logoutUser();
    } catch {
      // ignore error during logout
    } finally {
      wsClient.stop();
      clearSession(false);
      navigate('/login', {replace: true});
      toast.success(t.nav.loggedOutToast);
    }
  };

  return (
    <div className="flex h-svh overflow-hidden bg-background text-foreground">
      {/* Desktop WhatsApp Slim Icon Rail */}
      <aside
        aria-label={t.nav.ariaLabel}
        className="hidden w-[62px] shrink-0 flex-col items-center justify-between border-e border-border bg-rail py-3 md:flex"
      >
        {/* Top Icon Group */}
        <div className="flex flex-col items-center gap-1.5">
          {visiblePrimary.map(({to, label, icon: Icon}) => {
            const isChats = to === '/chats';
            return (
              <NavLink
                key={to}
                to={to}
                title={
                  isChats
                    ? `${label}${totalUnread > 0 ? ` (${t.chats.unreadLabel(totalUnread)})` : ''} — ${wsTitle}`
                    : label
                }
                aria-label={label}
                className={({isActive}) =>
                  cn(
                    'relative flex size-10 items-center justify-center rounded-full transition-colors',
                    isActive
                      ? 'bg-secondary text-foreground shadow-2xs'
                      : 'text-muted-foreground hover:bg-secondary/70 hover:text-foreground',
                  )
                }
              >
                <Icon className="size-5" />
                {isChats && totalUnread > 0 && (
                  <span
                    aria-label={t.chats.unreadLabel(totalUnread)}
                    className="absolute -end-0.5 -top-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground tabular-nums ring-2 ring-rail"
                  >
                    {totalUnread > 99 ? '99+' : totalUnread}
                  </span>
                )}
                {isChats && (
                  <span
                    aria-hidden="true"
                    className={cn(
                      'absolute end-1.5 bottom-1.5 size-2 rounded-full ring-2 ring-rail',
                      wsStatus === 'connected'
                        ? 'bg-live'
                        : wsStatus === 'connecting'
                          ? 'bg-amber-500'
                          : 'bg-muted-foreground/50',
                    )}
                  />
                )}
              </NavLink>
            );
          })}
        </div>

        {/* Bottom Utility & Profile Rail Group */}
        <div className="flex flex-col items-center gap-1.5">
          <NotificationControls />

          <LanguageToggle compact />

          <button
            type="button"
            onClick={handleToggleTheme}
            title={isDark ? t.nav.lightMode : t.nav.darkMode}
            aria-label={isDark ? t.nav.activateLight : t.nav.activateDark}
            className="flex size-10 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            {isDark ? <Sun className="size-5" /> : <Moon className="size-5" />}
          </button>

          {isAdmin && (
            <NavLink
              to="/settings"
              title={t.nav.settings}
              aria-label={t.nav.settings}
              className={({isActive}) =>
                cn(
                  'flex size-10 items-center justify-center rounded-full transition-colors',
                  isActive
                    ? 'bg-secondary text-foreground'
                    : 'text-muted-foreground hover:bg-secondary/70 hover:text-foreground',
                )
              }
            >
              <Settings className="size-5" />
            </NavLink>
          )}

          {user && (
            <div
              title={`${user.display_name} (${isAdmin ? t.nav.adminRole : t.nav.agentRole})`}
              className="mt-1 flex size-9 items-center justify-center rounded-full bg-accent text-xs font-bold text-accent-foreground select-none"
            >
              {user.display_name.slice(0, 1).toUpperCase()}
            </div>
          )}

          <button
            type="button"
            onClick={handleLogout}
            title={t.nav.logout}
            aria-label={t.nav.logout}
            className="flex size-10 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive focus-visible:outline-2 focus-visible:outline-ring"
          >
            <LogOut className="size-[18px]" />
          </button>
        </div>
      </aside>

      {/* Mobile Navigation Drawer */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-50 flex bg-black/60 md:hidden"
          onClick={() => setMobileOpen(false)}
        >
          <aside
            className="flex h-full w-64 flex-col border-e border-border bg-rail"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex h-12 items-center justify-between border-b border-border px-4">
              <span className="text-sm font-bold text-foreground">{t.appName}</span>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t.nav.closeMenu}
                onClick={() => setMobileOpen(false)}
              >
                <X className="size-4" />
              </Button>
            </div>
            <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-3" aria-label={t.nav.ariaLabel}>
              {visibleAll.map(({to, label, icon: Icon}) => (
                <NavLink
                  key={to}
                  to={to}
                  onClick={() => setMobileOpen(false)}
                  className={({isActive}) =>
                    cn(
                      'flex items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
                      isActive
                        ? 'bg-secondary text-foreground'
                        : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
                    )
                  }
                >
                  <Icon className="size-4 shrink-0" />
                  <span className="flex-1">{label}</span>
                  {to === '/chats' && totalUnread > 0 && (
                    <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground tabular-nums">
                      {totalUnread > 99 ? '99+' : totalUnread}
                    </span>
                  )}
                </NavLink>
              ))}
            </nav>
            {user && (
              <div className="border-t border-border p-3 text-xs">
                <p className="truncate font-semibold text-foreground">{user.display_name}</p>
                <p className="mt-0.5 text-muted-foreground">
                  {isAdmin ? t.nav.adminRole : t.nav.agentRole}
                </p>
              </div>
            )}
          </aside>
        </div>
      )}

      {/* Main Content Shell */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Compact Mobile Top Header Only */}
        <header className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border bg-card px-3 md:hidden">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              aria-label={t.nav.openMenu}
              onClick={() => setMobileOpen(true)}
            >
              <Menu className="size-5" />
            </Button>
            <span className="text-sm font-bold text-foreground whitespace-nowrap">{t.appName}</span>
          </div>

          <div className="flex items-center gap-1.5">
            <NotificationControls compactMobile />
            <LanguageToggle compact />
            <Button
              variant="ghost"
              size="icon"
              onClick={handleToggleTheme}
              title={isDark ? t.nav.lightMode : t.nav.darkMode}
              aria-label={isDark ? t.nav.activateLight : t.nav.activateDark}
            >
              {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleLogout}
              title={t.nav.logout}
              aria-label={t.nav.logout}
            >
              <LogOut className="size-4" />
            </Button>
          </div>
        </header>

        <main
          className={cn(
            'min-h-0 flex-1',
            isWorkspaceRoute ? 'overflow-hidden p-0' : 'overflow-y-auto p-4 md:p-6',
          )}
        >
          <div className={cn(isWorkspaceRoute ? 'h-full w-full' : 'mx-auto max-w-6xl')}>
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
