import {useRef, useState} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {Camera, Shield, UserRound} from 'lucide-react';
import {toast} from 'sonner';
import {useNavigate} from 'react-router-dom';
import {
  changeAccountAvatar,
  changeAccountPushName,
  fileToImageUpload,
  getAccountPrivacy,
  lookupUserAvatar,
} from '@/api/client';
import type {RegistryDevice} from '@/api/types';
import {ContactAvatar} from '@/components/contact-avatar';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {Skeleton} from '@/components/ui/skeleton';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';
import {toastWithView} from '@/lib/toast-with-view';
import {hasUserPermission, useAuthStore} from '@/stores/auth';

export function AccountProfilePanel({
  device,
  onDeviceUpdated,
}: {
  device: RegistryDevice;
  onDeviceUpdated: () => void;
}) {
  const {t} = useI18n();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const canWriteAccounts = hasUserPermission(user, 'accounts:write');
  const [pushName, setPushName] = useState('');
  const [myAvatarUrl, setMyAvatarUrl] = useState<string | null>(null);
  const avatarFileInputRef = useRef<HTMLInputElement | null>(null);

  const privacyQuery = useQuery({
    queryKey: ['account-privacy', device.id],
    queryFn: () => getAccountPrivacy(device.id),
    retry: 1,
  });

  const pushNameMutation = useMutation({
    mutationFn: () => changeAccountPushName(device.id, pushName.trim()),
    onSuccess: () => {
      toastWithView(t.account.pushNameUpdatedToast, {
        label: t.scheduled.viewAction,
        to: '/account',
        navigate,
      });
      setPushName('');
      onDeviceUpdated();
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const avatarMutation = useMutation({
    mutationFn: async (file: File) => {
      const payload = await fileToImageUpload(file);
      await changeAccountAvatar(device.id, payload);
    },
    onSuccess: () => {
      toastWithView(t.account.avatarUpdatedToast, {
        label: t.scheduled.viewAction,
        to: '/account',
        navigate,
      });
      setMyAvatarUrl(null);
      void queryClient.invalidateQueries({queryKey: ['contact-avatar', device.id]});
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const loadMyAvatarMutation = useMutation({
    mutationFn: async () => {
      const target = device.jid || device.phone_number || '';
      if (!target) throw new Error(t.account.noAvatarFound);
      return lookupUserAvatar(device.id, target, false, false);
    },
    onSuccess: (res) => {
      void queryClient.invalidateQueries({queryKey: ['contact-avatar', device.id]});
      if (!res?.url) {
        toast.info(t.account.noAvatarFound);
        setMyAvatarUrl(null);
      } else {
        setMyAvatarUrl(res.url);
      }
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const privacyEntries = Object.entries(privacyQuery.data ?? {}).filter(
    ([, v]) => v !== undefined && v !== '',
  );
  const title = device.resolved_name || device.alias || device.display_name || device.id;

  return (
    <div className="space-y-5">
      {/* Avatar & Push Name */}
      <div className="space-y-5 rounded-xl border border-border bg-card p-5">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-muted">
            {myAvatarUrl ? (
              <img
                src={myAvatarUrl}
                alt={title}
                referrerPolicy="no-referrer"
                className="size-full object-cover"
              />
            ) : device.jid || device.phone_number ? (
              <ContactAvatar
                deviceId={device.id}
                jid={device.jid || device.phone_number || ''}
                name={title}
                sizeClass="size-16"
                textClass="text-lg"
                eager
              />
            ) : (
              <UserRound className="size-7 text-muted-foreground" />
            )}
          </div>

          <div className="min-w-0 flex-1">
            <p className="truncate text-base font-semibold text-foreground">{title}</p>
            <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground" dir="ltr">
              {device.jid || device.phone_number || device.id}
            </p>
            {(canWriteAccounts || device.jid || device.phone_number) && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {canWriteAccounts && (
                  <>
                    <input
                      ref={avatarFileInputRef}
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/gif"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (file) avatarMutation.mutate(file);
                      }}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={avatarMutation.isPending}
                      onClick={() => avatarFileInputRef.current?.click()}
                    >
                      <Camera className="size-3.5" />
                      <span>{t.account.uploadAvatar}</span>
                    </Button>
                  </>
                )}
                {(device.jid || device.phone_number) && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={loadMyAvatarMutation.isPending}
                    onClick={() => loadMyAvatarMutation.mutate()}
                  >
                    {t.account.loadMyAvatar}
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>

        {canWriteAccounts && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!pushName.trim()) return;
              pushNameMutation.mutate();
            }}
            className="border-t border-border pt-4"
          >
            <Label htmlFor="workspace-push-name-input">{t.account.pushNameLabel}</Label>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <Input
                id="workspace-push-name-input"
                className="min-w-[200px] flex-1"
                value={pushName}
                onChange={(e) => setPushName(e.target.value)}
                placeholder={t.account.pushNamePlaceholder}
                required
              />
              <Button type="submit" disabled={pushNameMutation.isPending || !pushName.trim()}>
                {t.account.updatePushName}
              </Button>
            </div>
          </form>
        )}
      </div>

      {/* Privacy Table */}
      <div className="rounded-xl border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border px-5 py-3.5 text-sm font-semibold text-foreground">
          <Shield className="size-4 text-primary" />
          <span>{t.account.privacyTitle}</span>
        </div>

        {privacyQuery.isLoading ? (
          <div className="space-y-2 p-4">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : privacyQuery.error ? (
          <p className="p-4 text-xs text-destructive">{toApiError(privacyQuery.error).message}</p>
        ) : privacyEntries.length === 0 ? (
          <p className="p-4 text-xs text-muted-foreground">—</p>
        ) : (
          <dl className="divide-y divide-border">
            {privacyEntries.map(([key, value]) => (
              <div
                key={key}
                className="flex items-center justify-between gap-4 px-5 py-2.5 text-xs"
              >
                <dt className="text-muted-foreground">{t.account.privacyKeys[key] || key}</dt>
                <dd className="font-medium text-foreground">{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </div>
  );
}
