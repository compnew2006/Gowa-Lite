import {useState, type FormEvent} from 'react';
import {Loader2, MessagesSquare} from 'lucide-react';
import {useNavigate} from 'react-router-dom';
import {getAuthStatus, loginUser} from '@/api/client';
import {LanguageToggle} from '@/components/language-toggle';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';
import {wsClient} from '@/lib/ws';
import {useAuthStore} from '@/stores/auth';

export default function LoginPage() {
  const navigate = useNavigate();
  const {t} = useI18n();
  const setSession = useAuthStore((s) => s.setSession);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const {token, user} = await loginUser({
        username: username.trim(),
        password,
      });
      setSession(token, user);
      try {
        const status = await getAuthStatus();
        useAuthStore.getState().setGowaConfigured(status.gowaConfigured);
      } catch {
        // ignore
      }
      wsClient.sync();
      navigate('/chats', {replace: true});
    } catch (err) {
      setError(toApiError(err).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-svh items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-6 sm:p-7">
        <div className="mb-6 flex items-start justify-between gap-2">
          <div className="flex items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
              <MessagesSquare className="size-5" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-foreground">{t.login.title}</h1>
              <p className="text-xs text-muted-foreground">
                {t.appName} — {t.appSubtitle}
              </p>
            </div>
          </div>
          <LanguageToggle />
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="login-username">{t.login.username}</Label>
            <Input
              id="login-username"
              dir="ltr"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="login-password">{t.login.password}</Label>
            <Input
              id="login-password"
              type="password"
              dir="ltr"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>

          {error && (
            <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          )}

          <Button type="submit" disabled={submitting} className="mt-1 w-full">
            {submitting && <Loader2 className="size-4 animate-spin" />}
            <span>{t.login.submit}</span>
          </Button>
        </form>
      </div>
    </div>
  );
}
