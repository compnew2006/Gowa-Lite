import {useEffect, useState, type FormEvent} from 'react';
import {useMutation, useQueryClient} from '@tanstack/react-query';
import {Loader2} from 'lucide-react';
import {toast} from 'sonner';
import {updateDeviceAlias} from '@/api/client';
import type {RegistryDevice} from '@/api/types';
import {Button} from '@/components/ui/button';
import {Dialog} from '@/components/ui/dialog';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';

export function EditAliasDialog({
  device,
  onOpenChange,
}: {
  device: RegistryDevice | null;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const {t} = useI18n();
  const [alias, setAlias] = useState('');

  useEffect(() => {
    if (device) {
      setAlias(device.alias || device.display_name || '');
    }
  }, [device]);

  const mutation = useMutation({
    mutationFn: () => {
      if (!device) throw new Error('No device selected');
      return updateDeviceAlias(device.id, alias);
    },
    onSuccess: () => {
      toast.success(t.accounts.aliasUpdatedToast);
      void queryClient.invalidateQueries({queryKey: ['devices']});
      void queryClient.invalidateQueries({queryKey: ['unified-chats']});
      onOpenChange(false);
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
    <Dialog
      open={device !== null}
      onOpenChange={onOpenChange}
      title={t.accounts.editAliasTitle}
      description={t.accounts.editAliasDesc}
      className="sm:max-w-sm"
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="account-alias-input">{t.accounts.displayNameLabel}</Label>
          <Input
            id="account-alias-input"
            placeholder={t.accounts.aliasPlaceholder}
            value={alias}
            onChange={(event) => setAlias(event.target.value)}
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t.cancel}
          </Button>
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending && <Loader2 className="size-4 animate-spin" />}
            <span>{t.save}</span>
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
