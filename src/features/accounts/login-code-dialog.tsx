import {useEffect, useRef, useState, type FormEvent} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import {Check, Copy, Loader2} from 'lucide-react';
import {toast} from 'sonner';
import {useNavigate} from 'react-router-dom';
import {getDeviceStatus, loginDeviceCode} from '@/api/client';
import type {RegistryDevice} from '@/api/types';
import {Button} from '@/components/ui/button';
import {Dialog} from '@/components/ui/dialog';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {UNIFIED_CHATS_QUERY_PREFIX} from '@/features/chat/inbox-query-keys';
import {copyTextWithFallback} from '@/lib/clipboard';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';
import {toastWithView} from '@/lib/toast-with-view';

const STATUS_POLL_MS = 3_000;

export function LoginCodeDialog({
  device,
  onOpenChange,
}: {
  device: RegistryDevice | null;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const {t} = useI18n();
  const navigate = useNavigate();
  const [phone, setPhone] = useState('');
  const [pairCode, setPairCode] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);
  const deviceId = device?.id ?? null;
  const succeededRef = useRef(false);

  useEffect(() => {
    if (!deviceId) return;
    succeededRef.current = false;
    setPhone('');
    setPairCode(null);
    setCopied(false);
  }, [deviceId]);

  useEffect(() => {
    if (!deviceId || !pairCode) return;
    const poll = window.setInterval(() => {
      void getDeviceStatus(deviceId)
        .then((st) => {
          if (st.is_logged_in && !succeededRef.current) {
            succeededRef.current = true;
            toastWithView(t.accounts.linkedSuccessToast, {
              label: t.scheduled.viewAction,
              to: '/accounts',
              navigate,
            });
            void queryClient.invalidateQueries({queryKey: ['devices']});
            void queryClient.invalidateQueries({queryKey: UNIFIED_CHATS_QUERY_PREFIX});
            onOpenChange(false);
          }
        })
        .catch(() => undefined);
    }, STATUS_POLL_MS);
    return () => window.clearInterval(poll);
  }, [deviceId, navigate, pairCode, queryClient, onOpenChange, t.accounts.linkedSuccessToast]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!deviceId || !phone.trim()) return;
    setSubmitting(true);
    try {
      const response = await loginDeviceCode(deviceId, phone.trim());
      setPairCode(response.pair_code);
    } catch (err) {
      toast.error(toApiError(err).message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopy = async () => {
    if (!pairCode) return;
    const ok = await copyTextWithFallback(pairCode);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } else {
      toast.error(t.chats.copyFailedToast);
    }
  };

  return (
    <Dialog
      open={device !== null}
      onOpenChange={onOpenChange}
      title={t.accounts.codeTitle}
      description={t.accounts.codeDesc}
      className="sm:max-w-sm"
    >
      {pairCode ? (
        <div className="flex flex-col items-center gap-4 py-4">
          <p dir="ltr" className="font-mono text-3xl font-semibold tracking-widest tabular-nums">
            {pairCode}
          </p>
          <Button variant="outline" size="sm" onClick={handleCopy}>
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            <span>{copied ? t.accounts.copiedCode : t.accounts.copyCode}</span>
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            {t.accounts.enterPairCodeHint}
          </p>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pair-phone">{t.accounts.phoneInputLabel}</Label>
            <Input
              id="pair-phone"
              dir="ltr"
              placeholder="9665XXXXXXXX"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              required
            />
          </div>
          <Button type="submit" disabled={submitting || !phone.trim()}>
            {submitting && <Loader2 className="size-4 animate-spin" />}
            <span>{t.accounts.getPairCode}</span>
          </Button>
        </form>
      )}
    </Dialog>
  );
}
