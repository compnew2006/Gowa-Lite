import {useEffect, useMemo, useState, type FormEvent} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {Loader2, Pencil, Plus, Search, Smartphone, Star, Trash2} from 'lucide-react';
import {toast} from 'sonner';
import {
  createUser,
  deleteUser,
  getUserRatings,
  listAssignableAccounts,
  listRoles,
  listUsers,
  listUsersRatings,
  updateUser,
} from '@/api/client';
import type {RoleRecord, User, UserRatingSummary} from '@/api/types';
import {SettingsTabs} from '@/components/settings-tabs';
import {Button} from '@/components/ui/button';
import {Dialog} from '@/components/ui/dialog';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {Skeleton} from '@/components/ui/skeleton';
import {Switch} from '@/components/ui/switch';
import {
  summarizeAssignedAccounts,
  validateDeviceAccessSelection,
  type DeviceAccessMode,
} from '@/features/users/device-access-helpers';
import {DeviceAccessSelector} from '@/features/users/device-access-selector';
import {onWsEvent} from '@/lib/events';
import {formatDate} from '@/lib/format';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';
import {hasUserPermission, isAdminUser, useAuthStore} from '@/stores/auth';

export default function UsersPage() {
  const queryClient = useQueryClient();
  const {lang, t} = useI18n();
  const currentUser = useAuthStore((s) => s.user);
  const canWrite = hasUserPermission(currentUser, 'users:write');
  const canDelete = hasUserPermission(currentUser, 'users:delete');
  const canAssignDevices = hasUserPermission(currentUser, 'accounts:assign');
  const isCurrentAdmin = isAdminUser(currentUser);

  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'disabled'>('all');

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRoleId, setNewRoleId] = useState<number | ''>('');
  const [newDeviceMode, setNewDeviceMode] = useState<DeviceAccessMode>('all');
  const [newDeviceIds, setNewDeviceIds] = useState<string[]>([]);
  const [createTriedSubmit, setCreateTriedSubmit] = useState(false);

  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [editName, setEditName] = useState('');
  const [editRoleId, setEditRoleId] = useState<number | ''>('');
  const [editDeviceMode, setEditDeviceMode] = useState<DeviceAccessMode>('all');
  const [editDeviceIds, setEditDeviceIds] = useState<string[]>([]);
  const [editActive, setEditActive] = useState(true);
  const [editPassword, setEditPassword] = useState('');
  const [editTriedSubmit, setEditTriedSubmit] = useState(false);

  const [managingAccountsUser, setManagingAccountsUser] = useState<User | null>(null);
  const [quickDeviceMode, setQuickDeviceMode] = useState<DeviceAccessMode>('all');
  const [quickDeviceIds, setQuickDeviceIds] = useState<string[]>([]);
  const [quickTriedSubmit, setQuickTriedSubmit] = useState(false);

  const [deletingUser, setDeletingUser] = useState<User | null>(null);
  const [ratingsUser, setRatingsUser] = useState<User | null>(null);

  const usersQuery = useQuery({
    queryKey: ['users'],
    queryFn: listUsers,
  });

  const ratingsQuery = useQuery({
    queryKey: ['users-ratings'],
    queryFn: listUsersRatings,
  });

  const userRatingDetailQuery = useQuery({
    queryKey: ['user-ratings-detail', ratingsUser?.id ?? null],
    queryFn: () => getUserRatings(ratingsUser!.id),
    enabled: ratingsUser !== null,
  });

  useEffect(
    () =>
      onWsEvent((event) => {
        if (event.code === 'CHAT_CLOSE_RATING_UPDATED') {
          void queryClient.invalidateQueries({queryKey: ['users-ratings']});
          void queryClient.invalidateQueries({queryKey: ['user-ratings-detail']});
        }
      }),
    [queryClient],
  );

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

  const selectedCreateRole = roles.find((r) => r.id === newRoleId);
  const selectedEditRole = roles.find((r) => r.id === editRoleId);

  const createMutation = useMutation({
    mutationFn: (resolvedDeviceIds: string[]) =>
      createUser({
        display_name: newName.trim(),
        username: newUsername.trim(),
        password: newPassword,
        role_id: typeof newRoleId === 'number' ? newRoleId : undefined,
        ...(canAssignDevices ? {allowed_device_ids: resolvedDeviceIds} : {}),
      }),
    onSuccess: () => {
      toast.success(t.users.createdToast);
      void queryClient.invalidateQueries({queryKey: ['users']});
      void queryClient.invalidateQueries({queryKey: ['roles']});
      setNewName('');
      setNewUsername('');
      setNewPassword('');
      setNewRoleId(defaultRoleId);
      setNewDeviceMode('all');
      setNewDeviceIds([]);
      setCreateTriedSubmit(false);
      setCreateOpen(false);
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const updateMutation = useMutation({
    mutationFn: (resolvedDeviceIds: string[]) => {
      if (!editingUser) throw new Error('No user selected');
      return updateUser(editingUser.id, {
        display_name: editName.trim(),
        role_id: typeof editRoleId === 'number' ? editRoleId : undefined,
        ...(canAssignDevices ? {allowed_device_ids: resolvedDeviceIds} : {}),
        is_active: editActive,
        password: editPassword || undefined,
      });
    },
    onSuccess: () => {
      toast.success(t.users.updatedToast);
      void queryClient.invalidateQueries({queryKey: ['users']});
      void queryClient.invalidateQueries({queryKey: ['roles']});
      setEditTriedSubmit(false);
      setEditingUser(null);
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const manageAccountsMutation = useMutation({
    mutationFn: (resolvedDeviceIds: string[]) => {
      if (!managingAccountsUser) throw new Error('No user selected');
      return updateUser(managingAccountsUser.id, {
        allowed_device_ids: resolvedDeviceIds,
      });
    },
    onSuccess: () => {
      toast.success(t.users.accountsUpdatedToast);
      void queryClient.invalidateQueries({queryKey: ['users']});
      void queryClient.invalidateQueries({queryKey: ['unified-accounts-assign']});
      setQuickTriedSubmit(false);
      setManagingAccountsUser(null);
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => deleteUser(id),
    onSuccess: () => {
      toast.success(t.users.deletedToast);
      setDeletingUser(null);
      void queryClient.invalidateQueries({queryKey: ['users']});
      void queryClient.invalidateQueries({queryKey: ['roles']});
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const openCreate = () => {
    setNewName('');
    setNewUsername('');
    setNewPassword('');
    setNewRoleId(defaultRoleId);
    setNewDeviceMode('all');
    setNewDeviceIds([]);
    setCreateTriedSubmit(false);
    setCreateOpen(true);
  };

  const openEdit = (u: User) => {
    const initialIds = u.allowed_device_ids ?? [];
    setEditingUser(u);
    setEditName(u.display_name);
    setEditRoleId(u.role_id);
    setEditDeviceMode(initialIds.length > 0 ? 'specific' : 'all');
    setEditDeviceIds(initialIds);
    setEditActive(u.is_active);
    setEditPassword('');
    setEditTriedSubmit(false);
  };

  const openManageAccounts = (u: User) => {
    const initialIds = u.allowed_device_ids ?? [];
    setManagingAccountsUser(u);
    setQuickDeviceMode(initialIds.length > 0 ? 'specific' : 'all');
    setQuickDeviceIds(initialIds);
    setQuickTriedSubmit(false);
  };

  const handleCreateSubmit = (e: FormEvent) => {
    e.preventDefault();
    setCreateTriedSubmit(true);
    if (!canAssignDevices) {
      createMutation.mutate([]);
      return;
    }
    const validation = validateDeviceAccessSelection(newDeviceMode, newDeviceIds);
    if (!validation.ok) {
      toast.error(t.users.deviceAccessSelectPrompt);
      return;
    }
    createMutation.mutate(validation.deviceIds);
  };

  const handleEditSubmit = (e: FormEvent) => {
    e.preventDefault();
    setEditTriedSubmit(true);
    if (!canAssignDevices) {
      updateMutation.mutate([]);
      return;
    }
    const validation = validateDeviceAccessSelection(editDeviceMode, editDeviceIds);
    if (!validation.ok) {
      toast.error(t.users.deviceAccessSelectPrompt);
      return;
    }
    updateMutation.mutate(validation.deviceIds);
  };

  const handleManageAccountsSubmit = (e: FormEvent) => {
    e.preventDefault();
    setQuickTriedSubmit(true);
    const validation = validateDeviceAccessSelection(quickDeviceMode, quickDeviceIds);
    if (!validation.ok) {
      toast.error(t.users.deviceAccessSelectPrompt);
      return;
    }
    manageAccountsMutation.mutate(validation.deviceIds);
  };

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
            <Button onClick={openCreate} className="whitespace-nowrap shrink-0">
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
                          onClick={() => openManageAccounts(u)}
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
                          onClick={() => setRatingsUser(u)}
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
                              onClick={() => openManageAccounts(u)}
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
                              onClick={() => openEdit(u)}
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
                              onClick={() => setDeletingUser(u)}
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

      {/* Create User Dialog */}
      <Dialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title={t.users.createTitle}
        className="sm:max-w-lg"
      >
        <form
          onSubmit={handleCreateSubmit}
          className="flex max-h-[78vh] flex-col gap-4 overflow-y-auto pe-1"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-user-name">{t.users.fullName}</Label>
              <Input
                id="new-user-name"
                placeholder={t.users.fullNamePlaceholder}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                required
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-user-username">{t.users.username}</Label>
              <Input
                id="new-user-username"
                dir="ltr"
                placeholder="sara.agent"
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                required
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-user-password">{t.users.passwordMin}</Label>
            <Input
              id="new-user-password"
              type="password"
              dir="ltr"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
              minLength={8}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="new-user-role">{t.users.roleLabel}</Label>
            <select
              id="new-user-role"
              value={newRoleId}
              onChange={(e) => setNewRoleId(e.target.value ? Number(e.target.value) : '')}
              className="h-10 rounded-lg border border-input bg-card px-3 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            >
              {roles.map((role) => (
                <option key={role.id} value={role.id} disabled={!canAssignRole(role)}>
                  {formatRoleLabel(role.slug, role.name)}
                </option>
              ))}
            </select>
            {selectedCreateRole && (
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {t.users.rolePermsPreview(selectedCreateRole.permissions.length)}
              </span>
            )}
          </div>

          {canAssignDevices ? (
            <DeviceAccessSelector
              idPrefix="create"
              accounts={accounts}
              mode={newDeviceMode}
              selectedIds={newDeviceIds}
              onModeChange={setNewDeviceMode}
              onChange={setNewDeviceIds}
              gowaReachable={gowaReachable}
              onRetryAccounts={() => void accountsQuery.refetch()}
              isRetrying={accountsQuery.isFetching}
              showValidationError={createTriedSubmit}
            />
          ) : (
            <p className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
              {t.users.deviceAccessNoPermissionHint}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
              {t.cancel}
            </Button>
            <Button type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending && <Loader2 className="size-4 animate-spin" />}
              <span>{t.users.createSubmit}</span>
            </Button>
          </div>
        </form>
      </Dialog>

      {/* Edit User Dialog */}
      <Dialog
        open={editingUser !== null}
        onOpenChange={(open) => !open && setEditingUser(null)}
        title={t.users.editTitle}
        className="sm:max-w-lg"
      >
        <form
          onSubmit={handleEditSubmit}
          className="flex max-h-[78vh] flex-col gap-4 overflow-y-auto pe-1"
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-user-name">{t.users.fullName}</Label>
            <Input
              id="edit-user-name"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              required
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-user-role">{t.users.roleLabel}</Label>
            <select
              id="edit-user-role"
              value={editRoleId}
              onChange={(e) => setEditRoleId(e.target.value ? Number(e.target.value) : '')}
              className="h-10 rounded-lg border border-input bg-card px-3 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            >
              {roles.map((role) => (
                <option
                  key={role.id}
                  value={role.id}
                  disabled={role.id !== editingUser?.role_id && !canAssignRole(role)}
                >
                  {formatRoleLabel(role.slug, role.name)}
                </option>
              ))}
            </select>
            {selectedEditRole && (
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {t.users.rolePermsPreview(selectedEditRole.permissions.length)}
              </span>
            )}
          </div>

          {canAssignDevices ? (
            <DeviceAccessSelector
              idPrefix="edit"
              accounts={accounts}
              mode={editDeviceMode}
              selectedIds={editDeviceIds}
              onModeChange={setEditDeviceMode}
              onChange={setEditDeviceIds}
              gowaReachable={gowaReachable}
              onRetryAccounts={() => void accountsQuery.refetch()}
              isRetrying={accountsQuery.isFetching}
              showValidationError={editTriedSubmit}
            />
          ) : (
            <div className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
              <p className="font-medium text-foreground">{t.users.deviceAccessLabel}</p>
              <p className="mt-1">{formatAccountsFullTooltip(editingUser?.allowed_device_ids ?? [])}</p>
              <p className="mt-1 text-[11px]">{t.users.deviceAccessNoPermissionHint}</p>
            </div>
          )}

          <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5">
            <span className="text-sm font-medium">{t.users.accountActive}</span>
            <Switch
              checked={editActive}
              disabled={editingUser?.id === currentUser?.id}
              onCheckedChange={setEditActive}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edit-user-password">{t.users.newPasswordOptional}</Label>
            <Input
              id="edit-user-password"
              type="password"
              dir="ltr"
              placeholder={t.users.keepCurrentPasswordPlaceholder}
              value={editPassword}
              onChange={(e) => setEditPassword(e.target.value)}
              minLength={8}
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setEditingUser(null)}>
              {t.cancel}
            </Button>
            <Button type="submit" disabled={updateMutation.isPending}>
              {updateMutation.isPending && <Loader2 className="size-4 animate-spin" />}
              <span>{t.saveChanges}</span>
            </Button>
          </div>
        </form>
      </Dialog>

      {/* Focused Allowed Accounts Dialog */}
      <Dialog
        open={managingAccountsUser !== null}
        onOpenChange={(open) => !open && setManagingAccountsUser(null)}
        title={managingAccountsUser ? t.users.manageAccountsTitle(managingAccountsUser.display_name) : ''}
        description={t.users.manageAccountsDesc}
        className="sm:max-w-lg"
      >
        <form
          onSubmit={handleManageAccountsSubmit}
          className="flex max-h-[75vh] flex-col gap-4 overflow-y-auto pe-1"
        >
          <DeviceAccessSelector
            idPrefix="quick-accounts"
            accounts={accounts}
            mode={quickDeviceMode}
            selectedIds={quickDeviceIds}
            onModeChange={setQuickDeviceMode}
            onChange={setQuickDeviceIds}
            gowaReachable={gowaReachable}
            onRetryAccounts={() => void accountsQuery.refetch()}
            isRetrying={accountsQuery.isFetching}
            showValidationError={quickTriedSubmit}
          />

          <div className="flex justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              onClick={() => setManagingAccountsUser(null)}
            >
              {t.cancel}
            </Button>
            <Button type="submit" disabled={manageAccountsMutation.isPending}>
              {manageAccountsMutation.isPending && <Loader2 className="size-4 animate-spin" />}
              <span>{t.saveChanges}</span>
            </Button>
          </div>
        </form>
      </Dialog>

      {/* Delete User Dialog */}
      <Dialog
        open={deletingUser !== null}
        onOpenChange={(open) => !open && setDeletingUser(null)}
        title={t.users.deleteTitle}
        description={deletingUser ? t.users.deleteDesc(deletingUser.display_name) : undefined}
        className="sm:max-w-sm"
      >
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={() => setDeletingUser(null)}>
            {t.cancel}
          </Button>
          <Button
            variant="destructive"
            disabled={deleteMutation.isPending}
            onClick={() => deletingUser && deleteMutation.mutate(deletingUser.id)}
          >
            {t.confirmDelete}
          </Button>
        </div>
      </Dialog>

      {/* User Ratings Detail Dialog */}
      <Dialog
        open={ratingsUser !== null}
        onOpenChange={(open) => !open && setRatingsUser(null)}
        title={ratingsUser ? t.users.ratingsDialogTitle(ratingsUser.display_name) : ''}
        description={t.users.ratingsDialogDesc}
        className="sm:max-w-lg"
      >
        {userRatingDetailQuery.isPending ? (
          <Skeleton className="h-32 w-full" />
        ) : !userRatingDetailQuery.data ? (
          <div className="flex flex-wrap items-center gap-2 py-2">
            <p role="alert" className="text-sm text-destructive">{t.users.ratingsLoadError}</p>
            <Button variant="outline" size="sm" onClick={() => void userRatingDetailQuery.refetch()}>
              {t.refresh}
            </Button>
          </div>
        ) : (
          <div className="flex max-h-[75vh] flex-col gap-4 overflow-y-auto pe-1">
            <dl className="grid grid-cols-2 gap-4 border-y border-border py-3">
              <div>
                <dt className="text-xs text-muted-foreground">{t.users.ratingsAverageLabel}</dt>
                <dd className="mt-1 text-lg font-semibold tabular-nums">
                  {userRatingDetailQuery.data.average === null
                    ? '—'
                    : formatScoreNumber.format(userRatingDetailQuery.data.average)}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t.users.ratingsTotalLabel}</dt>
                <dd className="mt-1 text-lg font-semibold tabular-nums">
                  {formatScoreNumber.format(userRatingDetailQuery.data.count)}
                </dd>
              </div>
            </dl>

            {userRatingDetailQuery.data.by_account.length > 0 && (
              <div>
                <h4 className="mb-1.5 text-sm font-medium text-foreground">
                  {t.users.ratingsByAccountTitle}
                </h4>
                <ul className="divide-y divide-border rounded-lg border border-border px-3">
                  {userRatingDetailQuery.data.by_account.map((acc) => (
                    <li
                      key={acc.device_id}
                      className="flex items-center justify-between gap-3 py-2 text-sm"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-medium text-foreground">
                          {accountNameMap.get(acc.device_id) || acc.device_name}
                        </p>
                        <p className="text-xs text-muted-foreground tabular-nums">
                          {t.accounts.closeRatings.ratingsCountSuffix(acc.count)}
                        </p>
                      </div>
                      <span className="inline-flex shrink-0 items-center gap-1 font-medium tabular-nums">
                        <Star className="size-3.5 text-primary" aria-hidden />
                        <bdi>
                          {formatScoreNumber.format(acc.average)} / {formatScoreNumber.format(5)}
                        </bdi>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div>
              <h4 className="mb-1.5 text-sm font-medium text-foreground">
                {t.users.ratingsRecentTitle}
              </h4>
              {userRatingDetailQuery.data.recent.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t.users.ratingsEmpty}</p>
              ) : (
                <ul className="divide-y divide-border">
                  {userRatingDetailQuery.data.recent.map((rating) => (
                    <li
                      key={rating.id}
                      className="flex items-center justify-between gap-3 py-2 text-sm"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-medium text-foreground">
                          {accountNameMap.get(rating.device_id) || rating.device_name}
                        </p>
                        <time
                          dateTime={rating.rated_at}
                          className="text-xs text-muted-foreground"
                        >
                          {formatDate(rating.rated_at, lang)}
                        </time>
                      </div>
                      <span className="inline-flex shrink-0 items-center gap-1 font-medium tabular-nums">
                        <Star className="size-3.5 text-primary" aria-hidden />
                        <bdi>
                          {formatScoreNumber.format(rating.score)} / {formatScoreNumber.format(5)}
                        </bdi>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
