import {useState} from 'react';
import {Bell, BellOff, Volume2} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Dialog} from '@/components/ui/dialog';
import {Label} from '@/components/ui/label';
import {Switch} from '@/components/ui/switch';
import {useI18n} from '@/lib/i18n';
import {
  getBrowserNotificationPermission,
  playIncomingMessageChime,
  useNotificationPrefsStore,
} from '@/lib/notifications';
import {cn} from '@/lib/utils';

export function NotificationControls({compactMobile = false}: {compactMobile?: boolean}) {
  const {t} = useI18n();
  const [open, setOpen] = useState(false);
  const soundEnabled = useNotificationPrefsStore((s) => s.soundEnabled);
  const browserEnabled = useNotificationPrefsStore((s) => s.browserEnabled);
  const setSoundEnabled = useNotificationPrefsStore((s) => s.setSoundEnabled);
  const setBrowserEnabled = useNotificationPrefsStore((s) => s.setBrowserEnabled);
  const [permissionState, setPermissionState] = useState<NotificationPermission | 'unsupported'>(() =>
    getBrowserNotificationPermission(),
  );

  const anyActive = soundEnabled || (browserEnabled && permissionState === 'granted');

  const handleOpen = () => {
    setPermissionState(getBrowserNotificationPermission());
    setOpen(true);
  };

  const handleToggleSound = (checked: boolean) => {
    setSoundEnabled(checked);
    if (checked) {
      playIncomingMessageChime();
    }
  };

  const handleToggleBrowser = async (checked: boolean) => {
    if (!checked) {
      setBrowserEnabled(false);
      return;
    }
    const current = getBrowserNotificationPermission();
    setPermissionState(current);
    if (current === 'unsupported') {
      setBrowserEnabled(false);
      return;
    }
    if (current === 'granted') {
      setBrowserEnabled(true);
      return;
    }
    if (current === 'denied') {
      setBrowserEnabled(false);
      return;
    }
    try {
      const result = await Notification.requestPermission();
      setPermissionState(result);
      setBrowserEnabled(result === 'granted');
    } catch {
      setBrowserEnabled(false);
    }
  };

  const Icon = anyActive ? Bell : BellOff;

  return (
    <>
      {compactMobile ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={handleOpen}
          title={t.nav.notificationsTitle}
          aria-label={t.nav.notificationsTitle}
          className={cn(anyActive && 'text-primary')}
        >
          <Icon className="size-4" />
        </Button>
      ) : (
        <button
          type="button"
          onClick={handleOpen}
          title={t.nav.notificationsTitle}
          aria-label={t.nav.notificationsTitle}
          className={cn(
            'flex size-10 cursor-pointer items-center justify-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-ring',
            anyActive
              ? 'bg-secondary text-primary'
              : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
          )}
        >
          <Icon className="size-5" />
        </button>
      )}

      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={t.nav.notificationsTitle}
        description={t.nav.notificationsDesc}
      >
        <div className="space-y-4">
          <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3.5">
            <div className="min-w-0 space-y-1">
              <Label htmlFor="notify-sound-switch" className="cursor-pointer">
                {t.nav.soundAlertsLabel}
              </Label>
              <p className="text-xs text-muted-foreground">{t.nav.soundAlertsHint}</p>
            </div>
            <Switch
              id="notify-sound-switch"
              checked={soundEnabled}
              onCheckedChange={handleToggleSound}
              ariaLabel={t.nav.soundAlertsLabel}
            />
          </div>

          <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3.5">
            <div className="min-w-0 space-y-1">
              <Label htmlFor="notify-browser-switch" className="cursor-pointer">
                {t.nav.browserAlertsLabel}
              </Label>
              <p className="text-xs text-muted-foreground">{t.nav.browserAlertsHint}</p>
              {permissionState === 'denied' && (
                <p className="text-xs text-destructive">{t.nav.browserPermissionBlocked}</p>
              )}
              {permissionState === 'unsupported' && (
                <p className="text-xs text-muted-foreground">
                  {t.nav.browserPermissionUnsupported}
                </p>
              )}
            </div>
            <Switch
              id="notify-browser-switch"
              checked={browserEnabled && permissionState === 'granted'}
              disabled={permissionState === 'unsupported' || permissionState === 'denied'}
              onCheckedChange={(checked) => void handleToggleBrowser(checked)}
              ariaLabel={t.nav.browserAlertsLabel}
            />
          </div>

          <div className="flex items-center justify-between gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={playIncomingMessageChime}
            >
              <Volume2 className="size-3.5" />
              <span>{t.nav.testSoundBtn}</span>
            </Button>
            <Button type="button" onClick={() => setOpen(false)}>
              {t.close}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
