import {useEffect, useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {AlertCircle, RefreshCw, Smartphone} from 'lucide-react';
import {Link} from 'react-router-dom';
import {listDevices} from '@/api/client';
import type {RegistryDevice} from '@/api/types';
import {Button} from '@/components/ui/button';
import {Skeleton} from '@/components/ui/skeleton';
import {useI18n} from '@/lib/i18n';
import {toApiError} from '@/lib/http';

export function useActiveDevice() {
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const {
    data: devices = [],
    isLoading,
    isFetching,
    error,
    refetch,
  } = useQuery({
    queryKey: ['devices'],
    queryFn: listDevices,
    retry: 1,
  });

  useEffect(() => {
    if (devices.length === 0) {
      if (selectedDeviceId) setSelectedDeviceId('');
      return;
    }
    const stillExists = devices.some((d) => d.id === selectedDeviceId);
    if (!stillExists) {
      const preferred = devices.find((d) => d.state === 'logged_in') ?? devices[0];
      setSelectedDeviceId(preferred.id);
    }
  }, [devices, selectedDeviceId]);

  const selectedDevice: RegistryDevice | null =
    devices.find((d) => d.id === selectedDeviceId) ?? null;

  return {
    devices,
    selectedDevice,
    selectedDeviceId,
    setSelectedDeviceId,
    isLoading,
    isFetching,
    error,
    refetch,
  };
}

export function DeviceSelectorBar({
  devices,
  selectedDevice,
  selectedDeviceId,
  onSelectDevice,
  isLoading,
  isFetching,
  error,
  onRefresh,
  actions,
}: {
  devices: RegistryDevice[];
  selectedDevice: RegistryDevice | null;
  selectedDeviceId: string;
  onSelectDevice: (id: string) => void;
  isLoading: boolean;
  isFetching?: boolean;
  error: unknown;
  onRefresh?: () => void;
  actions?: React.ReactNode;
}) {
  const {t} = useI18n();

  if (isLoading) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-3">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-9 w-28" />
      </div>
    );
  }

  if (error) {
    const err = toApiError(error);
    return (
      <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm text-destructive">
            <AlertCircle className="size-4 shrink-0" />
            <span>{err.message}</span>
          </div>
          <div className="flex items-center gap-2">
            {onRefresh && (
              <Button variant="outline" size="sm" onClick={onRefresh}>
                <RefreshCw className="size-3.5" />
                <span>{t.retry}</span>
              </Button>
            )}
            <Link
              to="/settings"
              className="inline-flex h-8 items-center rounded-lg border border-border bg-card px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted whitespace-nowrap shrink-0"
            >
              {t.chats.goToSettings}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (devices.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card p-6 text-center">
        <Smartphone className="mx-auto size-8 text-muted-foreground" />
        <p className="mt-2 text-sm font-semibold text-foreground">
          {t.deviceSelector.noDevicesTitle}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">{t.deviceSelector.noDevicesDesc}</p>
        <div className="mt-4">
          <Link
            to="/accounts"
            className="inline-flex h-9 items-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 whitespace-nowrap"
          >
            {t.deviceSelector.goToAccounts}
          </Link>
        </div>
      </div>
    );
  }

  const isOffline = selectedDevice && selectedDevice.state !== 'logged_in';

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2.5">
          <label
            htmlFor="active-device-select"
            className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground whitespace-nowrap"
          >
            <Smartphone className="size-3.5" />
            <span>{t.deviceSelector.label}</span>
          </label>
          <select
            id="active-device-select"
            value={selectedDeviceId}
            onChange={(e) => onSelectDevice(e.target.value)}
            className="h-9 min-w-[220px] max-w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            {devices.map((dev) => {
              const title = dev.resolved_name || dev.alias || dev.display_name || dev.id;
              const statusText =
                dev.state === 'logged_in'
                  ? t.deviceSelector.stateLoggedIn
                  : t.deviceSelector.stateOffline;
              return (
                <option key={dev.id} value={dev.id}>
                  {title} ({dev.phone_number || dev.id}) — {statusText}
                </option>
              );
            })}
          </select>
          {onRefresh && (
            <Button
              variant="outline"
              size="icon"
              onClick={onRefresh}
              disabled={isFetching}
              title={t.refresh}
              aria-label={t.refresh}
            >
              <RefreshCw className={`size-4 ${isFetching ? 'animate-spin' : ''}`} />
            </Button>
          )}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>

      {isOffline && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <AlertCircle className="size-3.5 shrink-0" />
          <span>{t.deviceSelector.offlineNotice}</span>
        </div>
      )}
    </div>
  );
}
