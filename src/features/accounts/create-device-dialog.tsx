import {useState, type FormEvent} from 'react';
import {useMutation, useQueryClient} from '@tanstack/react-query';
import {Loader2, Plus} from 'lucide-react';
import {toast} from 'sonner';
import {createDevice} from '@/api/client';
import {Button} from '@/components/ui/button';
import {Dialog} from '@/components/ui/dialog';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';

export function CreateDeviceDialog() {
  const queryClient = useQueryClient();
  const {t} = useI18n();
  const [open, setOpen] = useState(false);
  const [deviceId, setDeviceId] = useState('');
  const [displayName, setDisplayName] = useState('');

  const mutation = useMutation({
    mutationFn: () =>
      createDevice({
        device_id: deviceId.trim() || undefined,
        display_name: displayName.trim() || undefined,
      }),
    onSuccess: () => {
      toast.success(t.accounts.createdToast);
      void queryClient.invalidateQueries({queryKey: ['devices']});
      void queryClient.invalidateQueries({queryKey: ['unified-chats']});
      setDeviceId('');
      setDisplayName('');
      setOpen(false);
    },
    onError: (err) => {
      toast.error(toApiError(err).message);
    },
  });

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    mutation.mutate();
  };

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="size-4" />
        <span>{t.accounts.addAccount}</span>
      </Button>

      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={t.accounts.createTitle}
        description={t.accounts.createDesc}
      >
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="device-display-name">{t.accounts.displayNameOptional}</Label>
            <Input
              id="device-display-name"
              placeholder={t.accounts.displayNamePlaceholder}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="device-custom-id">{t.accounts.deviceIdOptional}</Label>
            <Input
              id="device-custom-id"
              dir="ltr"
              placeholder={t.accounts.deviceIdPlaceholder}
              value={deviceId}
              onChange={(event) => setDeviceId(event.target.value)}
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t.cancel}
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
              <span>{t.accounts.createSubmit}</span>
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
