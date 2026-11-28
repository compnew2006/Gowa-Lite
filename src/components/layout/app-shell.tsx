import {useEffect, useEffectEvent, useRef, useState} from 'react';
import {useQuery, useQueryClient} from '@tanstack/react-query';
import {
  CalendarClock,
  LogOut,
  Menu,
  MessagesSquare,
  Moon,
  Radio,
  Settings,
  ShieldCheck,
  Smartphone,
  Sun,
  UserCog,
  Users,
  UsersRound,
  X,
} from 'lucide-react';
import {NavLink, Outlet, useLocation, useNavigate} from 'react-router-dom';
import {toast} from 'sonner';
import {
  getAuthStatus,
  getUnifiedGroupsUnread,
  logoutUser,
  updateMyTheme,
} from '@/api/client';
import type {ChatAssignmentSummary, User} from '@/api/types';
import {LanguageToggle} from '@/components/language-toggle';
import {AvatarMenu} from '@/components/layout/avatar-menu';
import {Button} from '@/components/ui/button';
import {NotificationControls} from '@/features/notifications/notification-controls';
import {formatNavUnreadCount, shouldShowNavUnreadBadge} from '@/features/chat/chat-ui-helpers';
import {createUnifiedChatsQueryOptions} from '@/features/chat/inbox-queries';
import {onWsBatch, type WsEvent} from '@/lib/events';
import {syncLiveQueryBatch, syncLiveQueryCache} from '@/lib/live-query-sync';
import {useI18n} from '@/lib/i18n';
import {
  extractIncomingAlertData,
  formatUnreadTabTitle,
  getBrowserNotificationPermission,
  playIncomingMessageChime,
  shouldAlertIncomingChat,
  useNotificationPrefsStore,
} from '@/lib/notifications';
import {cn} from '@/lib/utils';
import {wsClient} from '@/lib/ws';
import {hasSameAccessScope, hasUserAnyPermission, hasUserPermission, useAuthStore} from '@/stores/auth';

export function AppShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const {t} = useI18n();
  const user = useAuthStore((s) => s.user);
  const theme = useAuthStore((s) => s.theme);
  const setThemeLocal = useAuthStore((s) => s.setThemeLocal);
  const clearSession = useAuthStore((s) => s.clearSession);
  const soundEnabled = useNotificationPrefsStore((s) => s.soundEnabled);
  const browserEnabled = useNotificationPrefsStore((s) => s.browserEnabled);
  const [mobileOpen, setMobileOpen] = useState(false);
  const notifiedIdsRef = useRef<Set<string>>(new Set());
  const lifecycleMapRef = useRef<Map<string, Pick<ChatAssignmentSummary, 'status' | 'assigned_user_id'>>>(
    new Map(),
  );
  const mutedKeysRef = useRef<Set<string>>(new Set());

  const canReadChats = hasUserPermission(user, 'chats:read');
  const canReadGroups = hasUserPermission(user, 'groups:read');

  const unreadQuery = useQuery(createUnifiedChatsQueryOptions({
    options: {
      enabled: Boolean(user) && canReadChats,
      refetchInterval: 30_000,
      staleTime: 25_000,
    },
  }));
  const totalUnread = unreadQuery.data?.total_unread ?? 0;
  const accounts = unreadQuery.data?.accounts ?? [];

  const groupsUnreadQuery = useQuery({
    queryKey: ['unified-groups-unread'],
    queryFn: getUnifiedGroupsUnread,
    enabled: Boolean(user) && canReadGroups,
    refetchInterval: 30_000,
    staleTime: 25_000,
  });
  const totalGroupsUnread = groupsUnreadQuery.data?.total_unread ?? 0;

  useEffect(() => {
    const rows = unreadQuery.data?.data;
    if (!rows) return;
    const next = new Map<string, Pick<ChatAssignmentSummary, 'status' | 'assigned_user_id'>>();
    for (const chat of rows) {
      if (chat.lifecycle) {
        next.set(`${chat.device_id}::${chat.jid}`, {
          status: chat.lifecycle.status,
          assigned_user_id: chat.lifecycle.assigned_user_id,
        });
      }
    }
    lifecycleMapRef.current = next;
    const nextMuted = new Set<string>();
    for (const k of unreadQuery.data?.muted_keys ?? []) {
      nextMuted.add(k);
      nextMuted.add(k.toLowerCase());
    }
    mutedKeysRef.current = nextMuted;
  }, [unreadQuery.data]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const baseTitle = `${t.appName} — ${t.appSubtitle}`;
    document.title = formatUnreadTabTitle(totalUnread, baseTitle);
    return () => {
      document.title = baseTitle;
    };
  }, [t.appName, t.appSubtitle, totalUnread]);

  // skipCacheSync is set by handleLiveBatch, which already applied the whole
  // batch's cache patches (with one coalesced inbox invalidation) up front.
  const handleLiveEvent = useEffectEvent((event: WsEvent, skipCacheSync = false) => {
    if (!user) return;
    const code = (event.code || '').toUpperCase();
    if (code === 'USER_ACCESS_UPDATED') {
      if (event.device_id) return;
      const update = (nextUser: User) => {
        const current = useAuthStore.getState().user;
        if (current?.id !== nextUser.id) return;
        const accessChanged = !hasSameAccessScope(current, nextUser);
        useAuthStore.getState().setUser(nextUser);
        if (accessChanged) void queryClient.resetQueries();
      };
      const payloadUser = (event.result as {user?: User} | null)?.user;
      if (payloadUser?.id === user.id) {
        update(payloadUser);
      } else {
        void getAuthStatus().then((status) => {
          if (status.authenticated && status.user) update(status.user);
        }).catch(() => {
          // Keep the current session until its next successful refresh.
        });
      }
      return;
    }
    if (!skipCacheSync) syncLiveQueryCache(queryClient, event);

    if (code === 'CHAT_LIFECYCLE_UPDATED' && event.result && typeof event.result === 'object') {
      const payload = event.result as {
        device_id?: string;
        chat_jid?: string;
        assignment?: {status?: ChatAssignmentSummary['status']; assigned_user_id?: number | null};
      };
      if (payload.device_id && payload.chat_jid && payload.assignment?.status) {
        lifecycleMapRef.current.set(`${payload.device_id}::${payload.chat_jid}`, {
          status: payload.assignment.status,
          assigned_user_id: payload.assignment.assigned_user_id ?? null,
        });
      }
    }

    if (code === 'CHAT_DAILY_RESET' && event.result && typeof event.result === 'object') {
      const payload = event.result as {device_id?: string; chat_jids?: unknown};
      const devId = payload.device_id || event.device_id || '';
      if (devId && Array.isArray(payload.chat_jids)) {
        for (const rawJid of payload.chat_jids) {
          if (typeof rawJid === 'string' && rawJid) {
            lifecycleMapRef.current.set(`${devId}::${rawJid}`, {
              status: 'pending',
              assigned_user_id: null,
            });
          }
        }
      }
    }

    const alert = extractIncomingAlertData(event);
    if (!alert) return;

    const chatKey = `${alert.deviceId}::${alert.chatJid}`;
    const lifecycle = lifecycleMapRef.current.get(chatKey) ?? null;
    if (
      !shouldAlertIncomingChat({
        user,
        deviceId: alert.deviceId,
        chatJid: alert.chatJid,
        lifecycle,
        mutedKeys: mutedKeysRef.current,
      })
    ) {
      return;
    }

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
      const bodyText = alert.contentRedacted
        ? t.chats.redactedNotificationBody
        : alert.body ||
          (alert.mediaType
            ? t.chats.mediaLabels[alert.mediaType] || t.messageFallback
            : t.messageFallback);
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

  // Batched delivery (P2): apply the whole batch's React Query patches first
  // with one coalesced inbox invalidation, then run the per-event side
  // effects (lifecycle map, alerts) for each event in order. Plain frames
  // arrive here as one-event batches, so behaviour is unchanged for them.
  const handleLiveBatch = useEffectEvent((events: WsEvent[]) => {
    if (!user || events.length === 0) return;
    syncLiveQueryBatch(queryClient, events);
    for (const event of events) handleLiveEvent(event, true);
  });

  const hasSession = Boolean(user);
  useEffect(() => {
    if (hasSession) return onWsBatch(handleLiveBatch);
  }, [hasSession]);

  const primaryNav = [
    {to: '/chats', label: t.nav.chats, icon: MessagesSquare, perms: ['chats:read']},
    {
      to: '/scheduled',
      label: t.nav.scheduled,
      icon: CalendarClock,
      perms: ['schedules:read', 'schedules:write', 'schedules:manage'],
    },
    {
      to: '/groups',
      label: t.nav.groups,
      icon: UsersRound,
      perms: ['groups:read', 'groups:write', 'groups:manage'],
    },
    {
      to: '/account',
      label: t.nav.account,
      icon: UserCog,
      perms: ['accounts:read', 'accounts:write'],
    },
    {
      to: '/misc',
      label: t.nav.misc,
      icon: Radio,
      perms: ['misc:status.read', 'misc:channels.manage', 'misc:calls.reject'],
    },
    {
      to: '/accounts',
      label: t.nav.accounts,
      icon: Smartphone,
      perms: ['accounts:read', 'accounts:write'],
    },
    {
      to: '/settings/users',
      label: t.nav.users,
      icon: Users,
      perms: ['users:read', 'users:write', 'users:delete'],
    },
  ];

  const canAccessGowaSettings = hasUserAnyPermission(user, ['settings:read', 'settings:write']);
  const canAccessRoles = hasUserAnyPermission(user, ['roles:read', 'roles:write', 'roles:delete']);
  const canAccessUsers = hasUserAnyPermission(user, ['users:read', 'users:write', 'users:delete']);
  const settingsEntryTo = canAccessGowaSettings
    ? '/settings'
    : canAccessRoles
      ? '/settings/roles'
      : canAccessUsers
        ? '/settings/users'
        : null;

  const mobileSettingsNav = [
    ...(canAccessRoles
      ? [{to: '/settings/roles', label: t.nav.roles, icon: ShieldCheck, perms: ['roles:read', 'roles:write', 'roles:delete']}]
      : []),
    ...(canAccessGowaSettings
      ? [{to: '/settings', label: t.nav.settings, icon: Settings, perms: ['settings:read', 'settings:write']}]
      : []),
  ];

  const visiblePrimary = primaryNav.filter((item) => hasUserAnyPermission(user, item.perms));
  const visibleAll = [...visiblePrimary, ...mobileSettingsNav];
  const roleDisplayName = user
    ? (t.rbac.systemRoleNames[user.role_slug] ?? user.role_name) ||
      (user.role === 'admin' ? t.nav.adminRole : t.nav.agentRole)
    : '';
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
            const isGroups = to === '/groups';
            const badgeCount = isChats ? totalUnread : isGroups ? totalGroupsUnread : 0;
            const isRouteActive =
              (isChats && location.pathname.startsWith('/chats')) ||
              (isGroups && location.pathname.startsWith('/groups'));
            const showUnreadBadge =
              (isChats || isGroups) && shouldShowNavUnreadBadge(isRouteActive, badgeCount);
            return (
              <NavLink
                key={to}
                to={to}
                title={
                  (isChats || isGroups) && !isRouteActive && badgeCount > 0
                    ? `${label} (${t.chats.unreadLabel(badgeCount)})`
                    : label
                }
                aria-label={label}
                className={({isActive}) =>
                  cn(
                    'relative flex size-10 items-center justify-center rounded-full transition-colors',
                    isActive
                      ? 'bg-black/[0.07] text-foreground dark:bg-secondary'
                      : 'text-muted-foreground hover:bg-black/[0.04] hover:text-foreground dark:hover:bg-secondary/70',
                  )
                }
              >
                <Icon className="size-5" />
                {showUnreadBadge && (
                  <span
                    aria-label={t.chats.unreadLabel(badgeCount)}
                    className="absolute -end-1.5 -top-1 inline-flex h-4 min-w-4 max-w-[44px] items-center justify-center rounded-full bg-live px-1 text-[10px] font-bold leading-none text-white tabular-nums ring-2 ring-rail"
                  >
                    {formatNavUnreadCount(badgeCount)}
                  </span>
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

          {(canAccessGowaSettings || canAccessRoles) && settingsEntryTo && (
            <NavLink
              to={settingsEntryTo}
              end
              title={canAccessGowaSettings ? t.nav.settings : t.nav.roles}
              aria-label={canAccessGowaSettings ? t.nav.settings : t.nav.roles}
              className={() => {
                const active =
                  location.pathname === '/settings' ||
                  location.pathname.startsWith('/settings/roles');
                return cn(
                  'flex size-10 items-center justify-center rounded-full transition-colors',
                  active
                    ? 'bg-secondary text-foreground'
                    : 'text-muted-foreground hover:bg-secondary/70 hover:text-foreground',
                );
              }}
            >
              <Settings className="size-5" />
            </NavLink>
          )}

          {user && (
            <AvatarMenu
              displayName={user.display_name}
              roleDisplayName={roleDisplayName}
              isDark={isDark}
              onToggleTheme={handleToggleTheme}
              onLogout={handleLogout}
            />
          )}
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
                  {(to === '/chats' || to === '/groups') && (() => {
                    const isChats = to === '/chats';
                    const badgeCount = isChats ? totalUnread : totalGroupsUnread;
                    const isRouteActive = isChats
                      ? location.pathname.startsWith('/chats')
                      : location.pathname.startsWith('/groups');
                    if (!shouldShowNavUnreadBadge(isRouteActive, badgeCount)) return null;
                    return (
                      <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-live px-1.5 text-[11px] font-semibold text-white tabular-nums">
                        {formatNavUnreadCount(badgeCount)}
                      </span>
                    );
                  })()}
                </NavLink>
              ))}
            </nav>
            {user && (
              <div className="border-t border-border p-3 text-xs">
                <p className="truncate font-semibold text-foreground">{user.display_name}</p>
                <p className="mt-0.5 text-muted-foreground">{roleDisplayName}</p>
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
