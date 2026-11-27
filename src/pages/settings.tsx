import {SettingsTabs} from '@/components/settings-tabs';
import {GowaSettingsForm} from '@/features/settings/gowa-settings-form';
import {InboxPolicyForm} from '@/features/settings/inbox-policy-form';
import {useI18n} from '@/lib/i18n';
import {hasUserPermission, useAuthStore} from '@/stores/auth';

export default function SettingsPage() {
  const {t} = useI18n();
  const canWrite = useAuthStore((s) => hasUserPermission(s.user, 'settings:write'));

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        <SettingsTabs />
        <div>
          <h1 className="text-lg font-bold text-foreground" style={{textWrap: 'balance'}}>
            {t.settings.pageTitle}
          </h1>
          <p className="text-xs text-muted-foreground">{t.settings.pageSubtitle}</p>
        </div>
      </div>

      <GowaSettingsForm canWrite={canWrite} />
      <InboxPolicyForm canWrite={canWrite} />
    </div>
  );
}
