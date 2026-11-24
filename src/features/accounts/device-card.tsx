import {useState} from 'react';
import {useMutation, useQueryClient} from '@tanstack/react-query';
import {
  KeyRound,
  LogOut,
  Pencil,
  QrCode,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import {toast} from 'sonner';
import {deleteDevice, logoutDevice, reconnectDevice} from '@/api/client';
import type {DeviceState, RegistryDevice} from '@/api/types';
import {Button} from '@/components/ui/button';
import {Dialog} from '@/components/ui/dialog';
import {formatDate} from '@/lib/format';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';
import {cn} from '@/lib/utils';

const stateToneClass: Record<DeviceState, string> = {
  logged_in: 'text-emerald-700 dark:text-emerald-400',
  connected: 'text-amber-700 dark:text-amber-400',
  connecting: 'text-amber-700 dark:text-amber-400',
  disconnected: 'text-destructive',
};

export function DeviceCard({
  device,
  onLoginQr,
  onLoginCode,
  onEditAlias,
}: {
  device: RegistryDevice;
  onLoginQr: (device: RegistryDevice) => void;
  onLoginCode: (device: RegistryDevice) => void;
  onEditAlias: (device: RegistryDevice) => void;
}) {
  const queryClient = useQueryClient();
  const {lang, t} = useI18n();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const reconnectMutation = useMutation({
    mutationFn: () => reconnectDevice(device.id),
    onSuccess: () => {
      toast.success(t.accounts.reconnectToast);
      void queryClient.invalidateQueries({queryKey: ['devices']});
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const logoutMutation = useMutation({
    mutationFn: () => logoutDevice(device.id),
    onSuccess: () => {
      toast.success(t.accounts.loggedOutToast);
      void queryClient.invalidateQueries({queryKey: ['devices']});
      void queryClient.invalidateQueries({queryKey: ['unified-chats']});
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteDevice(device.id),
    onSuccess: () => {
      toast.success(t.accounts.deletedToast);
      setConfirmDelete(false);
      void queryClient.invalidateQueries({queryKey: ['devices']});
      void queryClient.invalidateQueries({queryKey: ['unified-chats']});
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const toneClass = stateToneClass[device.state] ?? stateToneClass.disconnected;
  const stateLabel = t.accounts.states[device.state] ?? t.accounts.states.disconnected;
  const title = device.resolved_name || device.alias || device.display_name || device.id;
  const isLoggedIn = device.state === 'logged_in';

  return (
    <div className="flex flex-col justify-between gap-4 rounded-xl border border-border bg-card p-5">
      <div>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold text-foreground">{title}</h3>
            <p className={cn('mt-1 text-xs font-medium', toneClass)}>{stateLabel}</p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onEditAlias(device)}
            title={t.accounts.editAliasAria}
            aria-label={t.accounts.editAliasAria}
          >
            <Pencil className="size-4" />
          </Button>
        </div>

        <dl className="mt-4 space-y-1.5 border-t border-border pt-3 text-xs">
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">{t.accounts.deviceIdLabel}</dt>
            <dd dir="ltr" className="truncate font-mono text-foreground">
              {device.id}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">{t.accounts.phoneLabel}</dt>
            <dd dir="ltr" className="truncate font-mono text-foreground tabular-nums">
              {device.phone_number || '—'}
            </dd>
          </div>
          <div className="flex items-center justify-between gap-2">
            <dt className="text-muted-foreground">{t.accounts.createdAtLabel}</dt>
            <dd className="text-foreground tabular-nums">{formatDate(device.created_at, lang)}</dd>
          </div>
        </dl>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        {!isLoggedIn ? (
          <>
            <Button size="sm" onClick={() => onLoginQr(device)}>
              <QrCode className="size-3.5" />
              <span>{t.accounts.linkQr}</span>
            </Button>
            <Button variant="outline" size="sm" onClick={() => onLoginCode(device)}>
              <KeyRound className="size-3.5" />
              <span>{t.accounts.linkCode}</span>
            </Button>
          </>
        ) : (
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
          variant="outline"
          size="sm"
          disabled={reconnectMutation.isPending}
          onClick={() => reconnectMutation.mutate()}
        >
          <RefreshCw className={cn('size-3.5', reconnectMutation.isPending && 'animate-spin')} />
          <span>{t.accounts.reconnectDevice}</span>
        </Button>

        <Button
          variant="ghost"
          size="sm"
          className="ms-auto text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={() => setConfirmDelete(true)}
        >
          <Trash2 className="size-3.5" />
          <span>{t.deleteAction}</span>
        </Button>
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
