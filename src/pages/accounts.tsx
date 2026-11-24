import {useEffect, useState} from 'react';
import {useQuery, useQueryClient} from '@tanstack/react-query';
import {RefreshCw, Settings, Smartphone} from 'lucide-react';
import {Link} from 'react-router-dom';
import {listDevices} from '@/api/client';
import type {RegistryDevice} from '@/api/types';
import {Button} from '@/components/ui/button';
import {Skeleton} from '@/components/ui/skeleton';
import {CreateDeviceDialog} from '@/features/accounts/create-device-dialog';
import {DeviceCard} from '@/features/accounts/device-card';
import {EditAliasDialog} from '@/features/accounts/edit-alias-dialog';
import {LoginCodeDialog} from '@/features/accounts/login-code-dialog';
import {LoginQrDialog} from '@/features/accounts/login-qr-dialog';
import {onWsEvent} from '@/lib/events';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';

export default function AccountsPage() {
  const queryClient = useQueryClient();
  const {t} = useI18n();
  const [qrDevice, setQrDevice] = useState<RegistryDevice | null>(null);
  const [codeDevice, setCodeDevice] = useState<RegistryDevice | null>(null);
  const [aliasDevice, setAliasDevice] = useState<RegistryDevice | null>(null);

  const query = useQuery({
    queryKey: ['devices'],
    queryFn: listDevices,
    refetchInterval: 15_000,
  });

  useEffect(() => {
    return onWsEvent((event) => {
      if (
        event.code === 'LOGIN_SUCCESS' ||
        event.code === 'LIST_DEVICES' ||
        event.code === 'DEVICE_REMOVED' ||
        event.code === 'DEVICE_LOGGED_OUT'
      ) {
        void queryClient.invalidateQueries({queryKey: ['devices']});
      }
    });
  }, [queryClient]);

  const apiErr = query.isError ? toApiError(query.error) : null;
  const devices = query.data ?? [];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold text-foreground">{t.accounts.pageTitle}</h1>
          <p className="text-xs text-muted-foreground">{t.accounts.pageSubtitle}</p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
          >
            <RefreshCw className={query.isFetching ? 'size-3.5 animate-spin' : 'size-3.5'} />
            <span>{t.refresh}</span>
          </Button>
          <CreateDeviceDialog />
        </div>
      </div>

      {apiErr && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-5 text-sm text-destructive">
          <p className="font-medium">{apiErr.message}</p>
          {(apiErr.code === 'GOWA_NOT_CONFIGURED' || apiErr.code === 'GOWA_UNREACHABLE') && (
            <div className="mt-3">
              <Link
                to="/settings"
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-xs font-medium text-foreground hover:bg-muted"
              >
                <Settings className="size-3.5" />
                <span>{t.accounts.checkSettings}</span>
              </Link>
            </div>
          )}
        </div>
      )}

      {query.isLoading && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <Skeleton className="h-52" />
          <Skeleton className="h-52" />
          <Skeleton className="h-52" />
        </div>
      )}

      {!query.isLoading && !apiErr && devices.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-xl border border-border bg-card p-10 text-center">
          <Smartphone className="mb-3 size-8 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">{t.accounts.emptyTitle}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t.accounts.emptyDesc}</p>
        </div>
      )}

      {!apiErr && devices.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {devices.map((device) => (
            <DeviceCard
              key={device.id}
              device={device}
              onLoginQr={setQrDevice}
              onLoginCode={setCodeDevice}
              onEditAlias={setAliasDevice}
            />
          ))}
        </div>
      )}

      <LoginQrDialog device={qrDevice} onOpenChange={(open) => !open && setQrDevice(null)} />
      <LoginCodeDialog
        device={codeDevice}
        onOpenChange={(open) => !open && setCodeDevice(null)}
      />
      <EditAliasDialog
        device={aliasDevice}
        onOpenChange={(open) => !open && setAliasDevice(null)}
      />
    </div>
  );
}
