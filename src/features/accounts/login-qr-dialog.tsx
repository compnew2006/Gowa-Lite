import {useCallback, useEffect, useRef, useState} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import {Loader2} from 'lucide-react';
import {toast} from 'sonner';
import {fetchAuthorizedBlobUrl, getDeviceStatus, loginDeviceQr} from '@/api/client';
import type {LoginQr, RegistryDevice} from '@/api/types';
import {Dialog} from '@/components/ui/dialog';
import {onWsEvent} from '@/lib/events';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';

const STATUS_POLL_MS = 3_000;

export function LoginQrDialog({
  device,
  onOpenChange,
}: {
  device: RegistryDevice | null;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const {t} = useI18n();
  const [qr, setQr] = useState<LoginQr | null>(null);
  const [qrBlobUrl, setQrBlobUrl] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const deviceId = device?.id ?? null;
  const succeededRef = useRef(false);

  const succeed = useCallback(() => {
    if (succeededRef.current) return;
    succeededRef.current = true;
    toast.success(t.accounts.linkedSuccessToast);
    void queryClient.invalidateQueries({queryKey: ['devices']});
    void queryClient.invalidateQueries({queryKey: ['unified-chats']});
    onOpenChange(false);
  }, [queryClient, onOpenChange, t.accounts.linkedSuccessToast]);

  const requestQr = useCallback(
    async (id: string) => {
      setError(null);
      try {
        const response = await loginDeviceQr(id);
        setQr(response);
        setSecondsLeft(Math.max(1, Math.round(response.qr_duration)));
      } catch (err) {
        const apiErr = toApiError(err);
        if (apiErr.code === 'ALREADY_LOGGED_IN') {
          setError(t.accounts.alreadyLoggedIn);
        } else {
          setError(apiErr.message);
        }
      }
    },
    [t.accounts.alreadyLoggedIn],
  );

  useEffect(() => {
    if (!deviceId || !qr?.qr_link) {
      setQrBlobUrl(null);
      return;
    }
    let active = true;
    let objectUrl = '';
    void fetchAuthorizedBlobUrl(qr.qr_link)
      .then((url) => {
        if (!active) {
          URL.revokeObjectURL(url);
          return;
        }
        objectUrl = url;
        setQrBlobUrl(url);
      })
      .catch((err) => {
        if (active) setError(toApiError(err).message);
      });

    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [deviceId, qr?.qr_link]);

  useEffect(() => {
    if (!deviceId) return;
    succeededRef.current = false;
    setQr(null);
    setQrBlobUrl(null);
    void requestQr(deviceId);

    const poll = window.setInterval(() => {
      void getDeviceStatus(deviceId)
        .then((st) => {
          if (st.is_logged_in) succeed();
        })
        .catch(() => undefined);
    }, STATUS_POLL_MS);

    const offLogin = onWsEvent((event) => {
      if (event.code !== 'LOGIN_SUCCESS') return;
      void getDeviceStatus(deviceId)
        .then((st) => {
          if (st.is_logged_in) succeed();
        })
        .catch(() => undefined);
    });

    return () => {
      window.clearInterval(poll);
      offLogin();
    };
  }, [deviceId, requestQr, succeed]);

  useEffect(() => {
    if (!deviceId || !qr) return;
    const timer = window.setInterval(() => {
      setSecondsLeft((prev) => {
        if (prev <= 1) {
          void requestQr(deviceId);
          return 0;
        }
        return prev - 1;
      });
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [deviceId, qr, requestQr]);

  return (
    <Dialog
      open={device !== null}
      onOpenChange={onOpenChange}
      title={t.accounts.qrTitle}
      description={
        device ? t.accounts.qrDesc(device.resolved_name || device.id) : undefined
      }
      className="sm:max-w-sm"
    >
      <div className="flex flex-col items-center gap-3 py-2">
        {error ? (
          <p className="py-6 text-center text-sm text-destructive">{error}</p>
        ) : qrBlobUrl ? (
          <>
            <img
              src={qrBlobUrl}
              alt={t.accounts.qrAlt}
              referrerPolicy="no-referrer"
              className="size-64 rounded-lg border border-border bg-white p-2"
            />
            <p className="text-xs text-muted-foreground tabular-nums">
              {t.accounts.qrRefreshIn(secondsLeft)}
            </p>
          </>
        ) : (
          <div className="flex size-64 items-center justify-center rounded-lg border border-border bg-muted/30">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        )}
      </div>
    </Dialog>
  );
}
