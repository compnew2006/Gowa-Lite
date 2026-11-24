import {useState} from 'react';
import {useMutation} from '@tanstack/react-query';
import {PhoneOff} from 'lucide-react';
import {toast} from 'sonner';
import {rejectCall} from '@/api/client';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';

export function RejectCallPanel({deviceId}: {deviceId: string}) {
  const {t} = useI18n();
  const [callerJid, setCallerJid] = useState('');
  const [callId, setCallId] = useState('');

  const rejectCallMutation = useMutation({
    mutationFn: () =>
      rejectCall(deviceId, {
        caller_jid: callerJid.trim(),
        call_id: callId.trim(),
      }),
    onSuccess: () => {
      toast.success(t.misc.callRejectedToast);
      setCallerJid('');
      setCallId('');
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!deviceId || !callerJid.trim() || !callId.trim()) return;
        rejectCallMutation.mutate();
      }}
      className="max-w-lg space-y-4 rounded-xl border border-border bg-card p-5"
    >
      <div>
        <h3 className="text-sm font-semibold text-foreground">{t.misc.callRejectTitle}</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {t.misc.callRejectDesc}
        </p>
      </div>

      <div>
        <Label htmlFor="call-caller-jid">{t.misc.callerJidLabel}</Label>
        <Input
          id="call-caller-jid"
          dir="ltr"
          className="mt-1.5"
          value={callerJid}
          onChange={(e) => setCallerJid(e.target.value)}
          placeholder={t.misc.callerJidPlaceholder}
          required
        />
      </div>

      <div>
        <Label htmlFor="call-id-input">{t.misc.callIdLabel}</Label>
        <Input
          id="call-id-input"
          dir="ltr"
          className="mt-1.5"
          value={callId}
          onChange={(e) => setCallId(e.target.value)}
          placeholder={t.misc.callIdPlaceholder}
          required
        />
      </div>

      <Button
        type="submit"
        variant="destructive"
        disabled={!deviceId || rejectCallMutation.isPending || !callerJid.trim() || !callId.trim()}
      >
        <PhoneOff className="size-4" />
        <span>{t.misc.rejectCallBtn}</span>
      </Button>
    </form>
  );
}
