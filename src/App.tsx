import {useEffect} from 'react';
import {Loader2} from 'lucide-react';
import {Navigate, Route, Routes} from 'react-router-dom';
import {Toaster} from 'sonner';
import {getAuthStatus} from '@/api/client';
import {AppShell} from '@/components/layout/app-shell';
import {useI18n} from '@/lib/i18n';
import {wsClient} from '@/lib/ws';
import AccountPage from '@/pages/account';
import AccountsPage from '@/pages/accounts';
import ChatsPage from '@/pages/chats';
import GroupsPage from '@/pages/groups';
import LoginPage from '@/pages/login';
import MiscPage from '@/pages/misc';
import ScheduledPage from '@/pages/scheduled';
import SettingsPage from '@/pages/settings';
import SetupPage from '@/pages/setup';
import UsersPage from '@/pages/users';
import {applyLanguageToDom, applyThemeToDom, useAuthStore} from '@/stores/auth';

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

function RequireAdmin({children}: {children: React.ReactNode}) {
  const user = useAuthStore((s) => s.user);
  if (user?.role !== 'admin') {
    return <Navigate to="/chats" replace />;
  }
  return <>{children}</>;
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
          <Route path="/chats" element={<ChatsPage />} />
          <Route
            path="/scheduled"
            element={
              <RequireAdmin>
                <ScheduledPage />
              </RequireAdmin>
            }
          />
          <Route
            path="/groups"
            element={
              <RequireAdmin>
                <GroupsPage />
              </RequireAdmin>
            }
          />
          <Route
            path="/account"
            element={
              <RequireAdmin>
                <AccountPage />
              </RequireAdmin>
            }
          />
          <Route
            path="/misc"
            element={
              <RequireAdmin>
                <MiscPage />
              </RequireAdmin>
            }
          />
          <Route
            path="/accounts"
            element={
              <RequireAdmin>
                <AccountsPage />
              </RequireAdmin>
            }
          />
          <Route
            path="/users"
            element={
              <RequireAdmin>
                <UsersPage />
              </RequireAdmin>
            }
          />
          <Route
            path="/settings"
            element={
              <RequireAdmin>
                <SettingsPage />
              </RequireAdmin>
            }
          />
          <Route path="/" element={<Navigate to="/chats" replace />} />
        </Route>
        <Route path="*" element={<Navigate to="/chats" replace />} />
      </Routes>
    );
  }

  return (
    <>
      {content}
      <AppToaster />
    </>
  );
}
