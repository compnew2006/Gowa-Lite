import {Suspense, lazy, useEffect} from 'react';
import {Loader2} from 'lucide-react';
import {Navigate, Route, Routes} from 'react-router-dom';
import {Toaster} from 'sonner';
import {DEFAULT_UNIFIED_CHATS_QUERY_KEY, getAuthStatus, listUnifiedChats} from '@/api/client';
import {AppShell} from '@/components/layout/app-shell';
import {bootingLabels, loadEnglishTranslations} from '@/lib/i18n';
import {queryClient} from '@/lib/query-client';
import {wsClient} from '@/lib/ws';
import {
  applyLanguageToDom,
  applyThemeToDom,
  firstAllowedRoute,
  hasUserAnyPermission,
  hasUserPermission,
  useAuthStore,
} from '@/stores/auth';

const AccountPage = lazy(() => import('@/pages/account'));
const AccountsPage = lazy(() => import('@/pages/accounts'));
const loadChatsPage = () => import('@/pages/chats');
const ChatsPage = lazy(loadChatsPage);
const GroupsPage = lazy(() => import('@/pages/groups'));
const LoginPage = lazy(() => import('@/pages/login'));
const MiscPage = lazy(() => import('@/pages/misc'));
const RolesPage = lazy(() => import('@/pages/roles'));
const ScheduledPage = lazy(() => import('@/pages/scheduled'));
const SettingsPage = lazy(() => import('@/pages/settings'));
const SetupPage = lazy(() => import('@/pages/setup'));
const UsersPage = lazy(() => import('@/pages/users'));

function BootLoader() {
  const lang = useAuthStore((state) => state.language);
  return (
    <div className="flex min-h-svh items-center justify-center bg-background">
      <div className="flex items-center gap-2 font-[system-ui] text-sm text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
        <span>{bootingLabels[lang]}</span>
      </div>
    </div>
  );
}

function RequirePermission({
  perms,
  children,
}: {
  perms: string[];
  children: React.ReactNode;
}) {
  const user = useAuthStore((s) => s.user);
  if (!hasUserAnyPermission(user, perms)) {
    return <Navigate to={firstAllowedRoute(user)} replace />;
  }
  return <>{children}</>;
}

function DefaultRedirect() {
  const user = useAuthStore((s) => s.user);
  return <Navigate to={firstAllowedRoute(user)} replace />;
}

function AppToaster() {
  const lang = useAuthStore((s) => s.language);
  return (
    <Toaster
      richColors
      position={lang === 'ar' ? 'top-left' : 'top-right'}
      dir={lang === 'ar' ? 'rtl' : 'ltr'}
    />
  );
}

export default function App() {
  const status = useAuthStore((s) => s.status);
  const setBootState = useAuthStore((s) => s.setBootState);

  useEffect(() => {
    applyThemeToDom('dark');
    applyLanguageToDom(useAuthStore.getState().language);
    let active = true;
    void getAuthStatus()
      .then((res) => {
        if (!active) return;
        if (!res.initialized) {
          setBootState({status: 'needs_setup', gowaConfigured: res.gowaConfigured});
        } else if (res.authenticated && res.user) {
          if (res.user.language === 'en') {
            void loadEnglishTranslations().catch(() => undefined);
          }
          if (hasUserPermission(res.user, 'chats:read')) {
            const requestedPath = window.location.hash.slice(1).split('?')[0];
            const initialPath = requestedPath && requestedPath !== '/' ? requestedPath : firstAllowedRoute(res.user);
            if (initialPath === '/chats') void loadChatsPage().catch(() => undefined);
            void queryClient.prefetchQuery({
              queryKey: DEFAULT_UNIFIED_CHATS_QUERY_KEY,
              queryFn: () => listUnifiedChats({}),
              staleTime: 25_000,
            });
          }
          setBootState({
            status: 'authenticated',
            user: res.user,
            gowaConfigured: res.gowaConfigured,
          });
          wsClient.sync();
        } else {
          setBootState({
            status: 'unauthenticated',
            gowaConfigured: res.gowaConfigured,
          });
        }
      })
      .catch(() => {
        if (!active) return;
        setBootState({status: 'unauthenticated', gowaConfigured: false});
      });

    return () => {
      active = false;
      wsClient.stop();
    };
  }, [setBootState]);

  let content: React.ReactNode;

  if (status === 'booting') {
    content = <BootLoader />;
  } else if (status === 'needs_setup') {
    content = (
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="*" element={<Navigate to="/setup" replace />} />
      </Routes>
    );
  } else if (status === 'unauthenticated') {
    content = (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  } else {
    content = (
      <Routes>
        <Route element={<AppShell />}>
          <Route
            path="/chats"
            element={
              <RequirePermission perms={['chats:read']}>
                <ChatsPage />
              </RequirePermission>
            }
          />
          <Route
            path="/scheduled"
            element={
              <RequirePermission perms={['schedules:read', 'schedules:write', 'schedules:manage']}>
                <ScheduledPage />
              </RequirePermission>
            }
          />
          <Route
            path="/groups"
            element={
              <RequirePermission perms={['groups:read', 'groups:write', 'groups:manage']}>
                <GroupsPage />
              </RequirePermission>
            }
          />
          <Route
            path="/account"
            element={
              <RequirePermission perms={['accounts:read', 'accounts:write']}>
                <AccountPage />
              </RequirePermission>
            }
          />
          <Route
            path="/misc"
            element={
              <RequirePermission
                perms={['misc:status.read', 'misc:channels.manage', 'misc:calls.reject']}
              >
                <MiscPage />
              </RequirePermission>
            }
          />
          <Route
            path="/accounts"
            element={
              <RequirePermission perms={['accounts:read', 'accounts:write']}>
                <AccountsPage />
              </RequirePermission>
            }
          />
          <Route path="/users" element={<Navigate to="/settings/users" replace />} />
          <Route
            path="/settings/users"
            element={
              <RequirePermission perms={['users:read', 'users:write', 'users:delete']}>
                <UsersPage />
              </RequirePermission>
            }
          />
          <Route
            path="/settings/roles"
            element={
              <RequirePermission perms={['roles:read', 'roles:write', 'roles:delete']}>
                <RolesPage />
              </RequirePermission>
            }
          />
          <Route
            path="/settings"
            element={
              <RequirePermission perms={['settings:read', 'settings:write']}>
                <SettingsPage />
              </RequirePermission>
            }
          />
          <Route path="/" element={<DefaultRedirect />} />
        </Route>
        <Route path="*" element={<DefaultRedirect />} />
      </Routes>
    );
  }

  return (
    <>
      <Suspense fallback={<BootLoader />}>{content}</Suspense>
      <AppToaster />
    </>
  );
}
