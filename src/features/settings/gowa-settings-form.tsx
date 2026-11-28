import {useEffect, useState, type FormEvent} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {CheckCircle2, Loader2, PlugZap, Save, XCircle} from 'lucide-react';
import {toast} from 'sonner';
import {useNavigate} from 'react-router-dom';
import {getGowaSettings, saveGowaSettings, testGowaSettings} from '@/api/requests/settings';
import type {GowaProbeResult} from '@/api/types';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {useAuthStore} from '@/stores/auth';
import {Button} from '@/components/ui/button';
import {UNIFIED_CHATS_QUERY_PREFIX} from '@/features/chat/inbox-query-keys';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';
import {toastWithView} from '@/lib/toast-with-view';

export function GowaSettingsForm({canWrite}: {canWrite: boolean}) {
  const queryClient = useQueryClient();
  const {t} = useI18n();
  const navigate = useNavigate();
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
      toastWithView(t.settings.savedToast, {
        label: t.scheduled.viewAction,
        to: '/settings',
        navigate,
      });
      setGowaConfigured(Boolean(saved.gowa_url));
      setGowaPassword('');
      setClearPassword(false);
      void queryClient.invalidateQueries({queryKey: ['gowa-settings']});
      void queryClient.invalidateQueries({queryKey: ['devices']});
      void queryClient.invalidateQueries({queryKey: UNIFIED_CHATS_QUERY_PREFIX});
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
    if (!canWrite) return;
    saveMutation.mutate();
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="flex max-w-2xl flex-col gap-4 rounded-xl border border-border bg-card p-6"
    >
      {!canWrite && (
        <div className="rounded-lg border border-border bg-muted/40 px-3.5 py-2 text-xs text-muted-foreground">
          {t.settings.readOnlyNotice}
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="settings-gowa-url">{t.settings.gowaUrl}</Label>
        <Input
          id="settings-gowa-url"
          dir="ltr"
          placeholder="http://localhost:3000"
          value={gowaUrl}
          disabled={!canWrite}
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
            disabled={!canWrite}
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
            disabled={!canWrite || clearPassword}
            onChange={(e) => setGowaPassword(e.target.value)}
          />
          {canWrite && query.data?.has_password && (
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

      {canWrite && (
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
      )}
    </form>
  );
}
