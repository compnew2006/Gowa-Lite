import {PlugZap, ShieldCheck, Users} from 'lucide-react';
import {NavLink} from 'react-router-dom';
import {useI18n} from '@/lib/i18n';
import {cn} from '@/lib/utils';
import {hasUserAnyPermission, useAuthStore} from '@/stores/auth';

export function SettingsTabs() {
  const {t} = useI18n();
  const user = useAuthStore((s) => s.user);

  const tabs = [
    {
      to: '/settings',
      label: t.settingsTabs.connection,
      icon: PlugZap,
      visible: hasUserAnyPermission(user, ['settings:read', 'settings:write']),
    },
    {
      to: '/settings/users',
      label: t.settingsTabs.users,
      icon: Users,
      visible: hasUserAnyPermission(user, ['users:read', 'users:write', 'users:delete']),
    },
    {
      to: '/settings/roles',
      label: t.settingsTabs.roles,
      icon: ShieldCheck,
      visible: hasUserAnyPermission(user, ['roles:read', 'roles:write', 'roles:delete']),
    },
  ].filter((tab) => tab.visible);

  if (tabs.length <= 1) return null;

  return (
    <nav
      aria-label={t.nav.settings}
      className="flex items-center gap-1 overflow-x-auto border-b border-border"
    >
      {tabs.map(({to, label, icon: Icon}) => (
        <NavLink
          key={to}
          to={to}
          end
          className={({isActive}) =>
            cn(
              'inline-flex shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors',
              isActive
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )
          }
        >
          <Icon className="size-4 shrink-0" />
          <span>{label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
