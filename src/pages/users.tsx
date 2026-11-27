import {Suspense, lazy, useMemo, useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {Pencil, Plus, Search, Smartphone, Star, Trash2} from 'lucide-react';
import {
  listAssignableAccounts,
  listRoles,
  listUsers,
  listUsersRatings,
} from '@/api/client';
import type {RoleRecord, UserRatingSummary} from '@/api/types';
import {SettingsTabs} from '@/components/settings-tabs';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Skeleton} from '@/components/ui/skeleton';
import {summarizeAssignedAccounts} from '@/features/users/device-access-helpers';
import type {UserDialogSelection} from '@/features/users/user-dialogs';
import {formatDate} from '@/lib/format';
import {useI18n} from '@/lib/i18n';
import {hasUserPermission, isAdminUser, useAuthStore} from '@/stores/auth';

const UserDialogs = lazy(() => import('@/features/users/user-dialogs'));

export default function UsersPage() {
  const {lang, t} = useI18n();
  const currentUser = useAuthStore((s) => s.user);
  const canWrite = hasUserPermission(currentUser, 'users:write');
  const canDelete = hasUserPermission(currentUser, 'users:delete');
  const canAssignDevices = hasUserPermission(currentUser, 'accounts:assign');
  const isCurrentAdmin = isAdminUser(currentUser);

  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'disabled'>('all');

  const [dialog, setDialog] = useState<UserDialogSelection | null>(null);

  const usersQuery = useQuery({
    queryKey: ['users'],
    queryFn: listUsers,
  });

  const ratingsQuery = useQuery({
    queryKey: ['users-ratings'],
    queryFn: listUsersRatings,
  });

  const rolesQuery = useQuery({
    queryKey: ['roles'],
    queryFn: listRoles,
  });

  const accountsQuery = useQuery({
    queryKey: ['unified-accounts-assign'],
    queryFn: listAssignableAccounts,
    retry: false,
  });

  const roles = useMemo(() => rolesQuery.data ?? [], [rolesQuery.data]);
  const accountsCatalog = accountsQuery.data;
  const accounts = useMemo(() => accountsCatalog?.accounts ?? [], [accountsCatalog?.accounts]);
  const gowaReachable = accountsCatalog?.gowa_reachable ?? true;

  const currentUserPermsSet = useMemo(
    () => new Set(currentUser?.permissions ?? []),
    [currentUser?.permissions],
  );

  const canAssignRole = (role: RoleRecord): boolean => {
    if (isCurrentAdmin) return true;
    if (role.slug === 'admin') return false;
    return role.permissions.every((key) => currentUserPermsSet.has(key));
  };

  const defaultRoleId = useMemo(() => {
    const def = roles.find((r) => r.is_default) ?? roles.find((r) => r.slug === 'agent') ?? roles[0];
    return def?.id ?? '';
  }, [roles]);

  const formatRoleLabel = (roleSlug: string, fallbackName: string) =>
    t.rbac.systemRoleNames[roleSlug] ?? fallbackName;

  const accountNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const acc of accounts) {
      map.set(acc.id, acc.display_name);
    }
    return map;
  }, [accounts]);

  const ratingSummaryByUserId = useMemo(() => {
    const map = new Map<number, UserRatingSummary>();
    for (const entry of ratingsQuery.data ?? []) {
      map.set(entry.user_id, entry);
    }
    return map;
  }, [ratingsQuery.data]);

  const formatScoreNumber = useMemo(
    () => new Intl.NumberFormat(lang, {maximumFractionDigits: 1}),
    [lang],
  );

  const users = usersQuery.data ?? [];

  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return users.filter((u) => {
      if (q) {
        const matched =
          u.display_name.toLowerCase().includes(q) ||
          u.username.toLowerCase().includes(q) ||
          u.role_name.toLowerCase().includes(q);
        if (!matched) return false;
      }
      if (roleFilter !== 'all' && String(u.role_id) !== roleFilter) return false;
      if (statusFilter === 'active' && !u.is_active) return false;
      if (statusFilter === 'disabled' && u.is_active) return false;
      return true;
    });
  }, [roleFilter, search, statusFilter, users]);

  const formatAccountsSummary = (deviceIds: string[]) =>
    summarizeAssignedAccounts(deviceIds, accountNameMap, t.users.allAccountsAccess, 2);

  const formatAccountsFullTooltip = (deviceIds: string[]) => {
    if (!deviceIds || deviceIds.length === 0) return t.users.allAccountsAccess;
    return deviceIds.map((id) => accountNameMap.get(id) ?? id).join(' · ');
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        <SettingsTabs />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-bold text-foreground" style={{textWrap: 'balance'}}>
              {t.users.pageTitle}
            </h1>
            <p className="text-xs text-muted-foreground">{t.users.pageSubtitle}</p>
          </div>

          {canWrite && (
            <Button onClick={() => setDialog({kind: 'create'})} className="whitespace-nowrap shrink-0">
              <Plus className="size-4" />
              <span>{t.users.addUser}</span>
            </Button>
          )}
        </div>
      </div>

      {/* Filter Bar */}
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="relative min-w-52 flex-1">
          <Search className="pointer-events-none absolute top-1/2 start-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t.users.searchPlaceholder}
            className="h-9 ps-9 text-sm"
          />
        </div>

        <select
          aria-label={t.users.colRole}
          value={roleFilter}
          onChange={(e) => setRoleFilter(e.target.value)}
          className="h-9 rounded-lg border border-input bg-card px-3 text-xs text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <option value="all">{t.users.filterAllRoles}</option>
          {roles.map((r) => (
            <option key={r.id} value={String(r.id)}>
              {formatRoleLabel(r.slug, r.name)}
            </option>
          ))}
        </select>

        <select
          aria-label={t.users.colStatus}
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as 'all' | 'active' | 'disabled')}
          className="h-9 rounded-lg border border-input bg-card px-3 text-xs text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <option value="all">{t.users.filterAllStatus}</option>
          <option value="active">{t.users.active}</option>
          <option value="disabled">{t.users.disabled}</option>
        </select>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full text-start text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-xs text-muted-foreground">
              <th className="px-4 py-3 font-medium">{t.users.colName}</th>
              <th className="px-4 py-3 font-medium">{t.users.colUsername}</th>
              <th className="px-4 py-3 font-medium">{t.users.colRole}</th>
              <th className="px-4 py-3 font-medium">{t.users.colAccounts}</th>
              <th className="px-4 py-3 font-medium">{t.users.colRatings}</th>
              <th className="px-4 py-3 font-medium">{t.users.colStatus}</th>
              <th className="px-4 py-3 font-medium">{t.users.colCreatedAt}</th>
              {(canWrite || canDelete) && (
                <th className="px-4 py-3 font-medium">{t.users.colActions}</th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {usersQuery.isLoading ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                  {t.loading}
                </td>
              </tr>
            ) : users.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                  {t.users.empty}
                </td>
              </tr>
            ) : filteredUsers.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                  {t.users.noFilteredUsers}
                </td>
              </tr>
            ) : (
              filteredUsers.map((u) => {
                const accountsSummary = formatAccountsSummary(u.allowed_device_ids);
                const fullTooltip = formatAccountsFullTooltip(u.allowed_device_ids);
                const ratingSummary = ratingSummaryByUserId.get(u.id);
                return (
                  <tr key={u.id} className="hover:bg-muted/35">
                    <td className="px-4 py-3 font-medium text-foreground">
                      {u.display_name}
                      {u.id === currentUser?.id && (
                        <span className="ms-1.5 text-xs text-muted-foreground">{t.users.youBadge}</span>
                      )}
                    </td>
                    <td dir="ltr" className="px-4 py-3 text-start font-mono text-xs text-muted-foreground">
                      {u.username}
                    </td>
                    <td className="px-4 py-3 text-xs font-medium text-foreground">
                      {formatRoleLabel(u.role_slug, u.role_name)}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {canWrite && canAssignDevices ? (
                        <button
                          type="button"
                          onClick={() => setDialog({kind: 'accounts', user: u})}
                          title={fullTooltip}
                          className="inline-flex max-w-64 items-center gap-1.5 truncate rounded-md px-2 py-1 text-start text-xs font-medium text-foreground underline decoration-border underline-offset-4 transition-colors hover:bg-muted hover:decoration-primary focus-visible:outline-2 focus-visible:outline-ring"
                        >
                          <Smartphone className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="truncate">{accountsSummary}</span>
                        </button>
                      ) : (
                        <span title={fullTooltip} className="text-muted-foreground">
                          {accountsSummary}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs tabular-nums">
                      {ratingSummary && ratingSummary.count > 0 && ratingSummary.average !== null ? (
                        <button
                          type="button"
                          onClick={() => setDialog({kind: 'ratings', user: u})}
                          className="inline-flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 font-medium text-foreground underline decoration-border underline-offset-4 transition-colors hover:bg-muted hover:decoration-primary focus-visible:outline-2 focus-visible:outline-ring"
                        >
                          <Star className="size-3.5 text-primary" aria-hidden />
                          <span>
                            {t.users.ratingsSummary(
                              formatScoreNumber.format(ratingSummary.average),
                              ratingSummary.count,
                            )}
                          </span>
                        </button>
                      ) : (
                        <span className="text-muted-foreground">{t.users.noRatingsYet}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      <span
                        className={
                          u.is_active
                            ? 'font-medium text-emerald-700 dark:text-emerald-400'
                            : 'font-medium text-destructive'
                        }
                      >
                        {u.is_active ? t.users.active : t.users.disabled}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground tabular-nums">
                      {formatDate(u.created_at, lang)}
                    </td>
                    {(canWrite || canDelete) && (
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1">
                          {canWrite && canAssignDevices && (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => setDialog({kind: 'accounts', user: u})}
                              title={t.users.manageAccountsAction}
                              aria-label={`${t.users.manageAccountsAction} ${u.display_name}`}
                            >
                              <Smartphone className="size-4" />
                            </Button>
                          )}
                          {canWrite && (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => setDialog({kind: 'edit', user: u})}
                              title={t.editAction}
                              aria-label={`${t.editAction} ${u.display_name}`}
                            >
                              <Pencil className="size-4" />
                            </Button>
                          )}
                          {canDelete && (
                            <Button
                              variant="ghost"
                              size="icon"
                              disabled={u.id === currentUser?.id || (u.role_slug === 'admin' && !isCurrentAdmin)}
                              onClick={() => setDialog({kind: 'delete', user: u})}
                              title={t.deleteAction}
                              aria-label={`${t.deleteAction} ${u.display_name}`}
                              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {dialog && (
        <Suspense fallback={null}>
          <UserDialogs
            dialog={dialog}
            roles={roles}
            defaultRoleId={defaultRoleId}
            currentUserId={currentUser?.id}
            canAssignDevices={canAssignDevices}
            canAssignRole={canAssignRole}
            formatRoleLabel={formatRoleLabel}
            formatAccountsFullTooltip={formatAccountsFullTooltip}
            accountNameMap={accountNameMap}
            accounts={accounts}
            gowaReachable={gowaReachable}
            onRetryAccounts={() => void accountsQuery.refetch()}
            isRetrying={accountsQuery.isFetching}
            onClose={() => setDialog((current) => current === dialog ? null : current)}
          />
        </Suspense>
      )}
    </div>
  );
}
