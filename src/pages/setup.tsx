import {useState, type FormEvent} from 'react';
import {CheckCircle2, Loader2, ShieldCheck} from 'lucide-react';
import {useNavigate} from 'react-router-dom';
import {toast} from 'sonner';
import {submitInitialSetup, testGowaSettings} from '@/api/client';
import {LanguageToggle} from '@/components/language-toggle';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';
import {wsClient} from '@/lib/ws';
import {useAuthStore} from '@/stores/auth';

export default function SetupPage() {
  const navigate = useNavigate();
  const {t} = useI18n();
  const setSession = useAuthStore((s) => s.setSession);

  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  const [gowaUrl, setGowaUrl] = useState('');
  const [gowaUsername, setGowaUsername] = useState('');
  const [gowaPassword, setGowaPassword] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [probeMessage, setProbeMessage] = useState<{ok: boolean; text: string} | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError(t.setup.passwordMismatch);
      return;
    }

    setSubmitting(true);
    try {
      const session = await submitInitialSetup({
        display_name: displayName.trim(),
        username: username.trim(),
        password,
        gowa_url: gowaUrl.trim() || undefined,
        gowa_username: gowaUsername.trim() || undefined,
        gowa_password: gowaPassword || undefined,
      });
      if (!session?.token || !session?.user) {
        setError(t.login.incompleteSession);
        return;
      }
      setSession(session.token, session.user, Boolean(gowaUrl.trim()));
      wsClient.sync();
      toast.success(t.setup.successToast);
      navigate('/chats', {replace: true});
    } catch (err) {
      setError(toApiError(err).message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleTest = async () => {
    if (!gowaUrl.trim()) return;
    setTesting(true);
    setProbeMessage(null);
    try {
      const res = await testGowaSettings({
        gowa_url: gowaUrl.trim(),
        gowa_username: gowaUsername.trim(),
        gowa_password: gowaPassword,
      });
      setProbeMessage({
        ok: res.ok,
        text: res.ok ? t.setup.testSuccess(res.devicesCount) : res.error || t.setup.testFailed,
      });
    } catch (err) {
      setProbeMessage({ok: false, text: toApiError(err).message});
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="flex min-h-svh items-center justify-center bg-background p-4">
      <div className="w-full max-w-lg rounded-xl border border-border bg-card p-6 sm:p-8">
        <div className="mb-6 flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-foreground">
              <ShieldCheck className="size-5" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-foreground">{t.setup.title}</h1>
              <p className="text-xs text-muted-foreground">{t.setup.subtitle}</p>
            </div>
          </div>
          <LanguageToggle />
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          <div className="space-y-3">
            <h2 className="text-sm font-semibold text-foreground">{t.setup.adminSection}</h2>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="setup-display-name">{t.setup.fullName}</Label>
                <Input
                  id="setup-display-name"
                  placeholder={t.setup.fullNamePlaceholder}
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  required
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="setup-username">{t.setup.username}</Label>
                <Input
                  id="setup-username"
                  dir="ltr"
                  placeholder="admin"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                />
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="setup-password">{t.setup.passwordMin}</Label>
                <Input
                  id="setup-password"
                  type="password"
                  dir="ltr"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="setup-confirm">{t.setup.confirmPassword}</Label>
                <Input
                  id="setup-confirm"
                  type="password"
                  dir="ltr"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  minLength={8}
                />
              </div>
            </div>
          </div>

          <div className="space-y-3 border-t border-border pt-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-foreground">{t.setup.gowaSection}</h2>
              <span className="text-xs text-muted-foreground">{t.setup.gowaEditLater}</span>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="setup-gowa-url">{t.setup.gowaUrl}</Label>
              <Input
                id="setup-gowa-url"
                dir="ltr"
                placeholder="http://localhost:3000"
                value={gowaUrl}
                onChange={(e) => setGowaUrl(e.target.value)}
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="setup-gowa-user">{t.setup.basicUser}</Label>
                <Input
                  id="setup-gowa-user"
                  dir="ltr"
                  placeholder={t.optional}
                  value={gowaUsername}
                  onChange={(e) => setGowaUsername(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="setup-gowa-pass">{t.setup.basicPass}</Label>
                <Input
                  id="setup-gowa-pass"
                  type="password"
                  dir="ltr"
                  placeholder={t.optional}
                  value={gowaPassword}
                  onChange={(e) => setGowaPassword(e.target.value)}
                />
              </div>
            </div>

            {gowaUrl.trim() && (
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={testing}
                  onClick={handleTest}
                >
                  {testing && <Loader2 className="size-3.5 animate-spin" />}
                  <span>{t.setup.testConnection}</span>
                </Button>
                {probeMessage && (
                  <span
                    className={`flex items-center gap-1 text-xs ${
                      probeMessage.ok
                        ? 'text-emerald-700 dark:text-emerald-400'
                        : 'text-destructive'
                    }`}
                  >
                    {probeMessage.ok && <CheckCircle2 className="size-3.5" />}
                    {probeMessage.text}
                  </span>
                )}
              </div>
            )}
          </div>

          {error && (
            <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          )}

          <Button type="submit" disabled={submitting} className="w-full">
            {submitting && <Loader2 className="size-4 animate-spin" />}
            <span>{t.setup.submit}</span>
          </Button>
        </form>
      </div>
    </div>
  );
}
