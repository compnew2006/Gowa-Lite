import {useEffect, useState, type FormEvent} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {CheckCircle2, Loader2, PlugZap, Save, XCircle} from 'lucide-react';
import {toast} from 'sonner';
import {getGowaSettings, saveGowaSettings, testGowaSettings} from '@/api/client';
import type {GowaProbeResult} from '@/api/types';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';
import {useAuthStore} from '@/stores/auth';

export default function SettingsPage() {
  const queryClient = useQueryClient();
  const {t} = useI18n();
  const setGowaConfigured = useAuthStore((s) => s.setGowaConfigured);

  const [gowaUrl, setGowaUrl] = useState('');
  const [gowaUsername, setGowaUsername] = useState('');
  const [gowaPassword, setGowaPassword] = useState('');
  const [clearPassword, setClearPassword] = useState(false);
  const [probeResult, setProbeResult] = useState<GowaProbeResult | null>(null);

  const query = useQuery({
    queryKey: ['gowa-settings'],
    queryFn: getGowaSettings,
  });

  useEffect(() => {
    if (query.data) {
      setGowaUrl(query.data.gowa_url);
      setGowaUsername(query.data.gowa_username);
      setGowaPassword('');
      setClearPassword(false);
    }
  }, [query.data]);

  const saveMutation = useMutation({
    mutationFn: () =>
      saveGowaSettings({
        gowa_url: gowaUrl.trim(),
        gowa_username: gowaUsername.trim(),
        gowa_password: gowaPassword || undefined,
        clear_password: clearPassword,
      }),
    onSuccess: (saved) => {
      toast.success(t.settings.savedToast);
      setGowaConfigured(Boolean(saved.gowa_url));
      setGowaPassword('');
      setClearPassword(false);
      void queryClient.invalidateQueries({queryKey: ['gowa-settings']});
      void queryClient.invalidateQueries({queryKey: ['devices']});
      void queryClient.invalidateQueries({queryKey: ['unified-chats']});
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const testMutation = useMutation({
    mutationFn: () =>
      testGowaSettings({
        gowa_url: gowaUrl.trim(),
        gowa_username: gowaUsername.trim(),
        gowa_password: clearPassword ? '' : gowaPassword || undefined,
      }),
    onSuccess: (res) => {
      setProbeResult(res);
    },
    onError: (err) => {
      setProbeResult({ok: false, devicesCount: 0, error: toApiError(err).message});
    },
  });

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    saveMutation.mutate();
  };

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5">
      <div>
        <h1 className="text-lg font-bold text-foreground">{t.settings.pageTitle}</h1>
        <p className="text-xs text-muted-foreground">{t.settings.pageSubtitle}</p>
      </div>

      <form
        onSubmit={handleSubmit}
        className="flex flex-col gap-4 rounded-xl border border-border bg-card p-6"
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="settings-gowa-url">{t.settings.gowaUrl}</Label>
          <Input
            id="settings-gowa-url"
            dir="ltr"
            placeholder="http://localhost:3000"
            value={gowaUrl}
            onChange={(e) => setGowaUrl(e.target.value)}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="settings-gowa-user">{t.settings.basicUser}</Label>
            <Input
              id="settings-gowa-user"
              dir="ltr"
              placeholder={t.optional}
              value={gowaUsername}
              onChange={(e) => setGowaUsername(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="settings-gowa-pass">{t.settings.basicPass}</Label>
            <Input
              id="settings-gowa-pass"
              type="password"
              dir="ltr"
              placeholder={
                query.data?.has_password && !clearPassword
                  ? t.settings.savedPassPlaceholder
                  : t.optional
              }
              value={gowaPassword}
              disabled={clearPassword}
              onChange={(e) => setGowaPassword(e.target.value)}
            />
            {query.data?.has_password && (
              <label className="mt-1 flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={clearPassword}
                  onChange={(e) => setClearPassword(e.target.checked)}
                />
                <span>{t.settings.clearSavedPass}</span>
              </label>
            )}
          </div>
        </div>

        {probeResult && (
          <div
            className={`rounded-lg border px-3.5 py-2.5 text-xs ${
              probeResult.ok
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300'
                : 'border-destructive/30 bg-destructive/10 text-destructive'
            }`}
          >
            <div className="flex items-center gap-2 font-medium">
              {probeResult.ok ? (
                <CheckCircle2 className="size-4 shrink-0" />
              ) : (
                <XCircle className="size-4 shrink-0" />
              )}
              <span>
                {probeResult.ok
                  ? t.settings.testSuccess(probeResult.devicesCount)
                  : probeResult.error || t.settings.testFailed}
              </span>
            </div>
            {probeResult.ok && probeResult.info && (
              <p className="mt-1 font-mono text-[11px] opacity-90">
                gowa {probeResult.info.version} · {probeResult.info.os}
              </p>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
          <Button
            type="button"
            variant="outline"
            disabled={testMutation.isPending || !gowaUrl.trim()}
            onClick={() => testMutation.mutate()}
          >
            {testMutation.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <PlugZap className="size-4" />
            )}
            <span>{t.settings.testButton}</span>
          </Button>

          <Button type="submit" disabled={saveMutation.isPending}>
            {saveMutation.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Save className="size-4" />
            )}
            <span>{t.settings.saveButton}</span>
          </Button>
        </div>
      </form>
    </div>
  );
}
