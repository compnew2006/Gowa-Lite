import {Suspense, lazy, useEffect} from 'react';
import {Loader2} from 'lucide-react';
import {Navigate, Route, Routes} from 'react-router-dom';
import {Toaster} from 'sonner';
import {getAuthStatus} from '@/api/client';
import {AppShell} from '@/components/layout/app-shell';
import {useI18n} from '@/lib/i18n';
import {wsClient} from '@/lib/ws';
import {
  applyLanguageToDom,
  applyThemeToDom,
  firstAllowedRoute,
  hasUserAnyPermission,
  useAuthStore,
} from '@/stores/auth';

const AccountPage = lazy(() => import('@/pages/account'));
const AccountsPage = lazy(() => import('@/pages/accounts'));
const ChatsPage = lazy(() => import('@/pages/chats'));
const GroupsPage = lazy(() => import('@/pages/groups'));
const LoginPage = lazy(() => import('@/pages/login'));
const MiscPage = lazy(() => import('@/pages/misc'));
const RolesPage = lazy(() => import('@/pages/roles'));
const ScheduledPage = lazy(() => import('@/pages/scheduled'));
const SettingsPage = lazy(() => import('@/pages/settings'));
const SetupPage = lazy(() => import('@/pages/setup'));
const UsersPage = lazy(() => import('@/pages/users'));

function BootLoader() {
  const {t} = useI18n();
  return (
    <div className="flex min-h-svh items-center justify-center bg-background">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
        <span>{t.booting}</span>
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
  const {lang} = useI18n();
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
    <Suspense fallback={<BootLoader />}>
      {content}
      <AppToaster />
    </Suspense>
  );
}
