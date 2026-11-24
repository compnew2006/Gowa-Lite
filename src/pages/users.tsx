import {useMemo, useState, type FormEvent} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {Loader2, Pencil, Plus, Search, Trash2} from 'lucide-react';
import {toast} from 'sonner';
import {
  createUser,
  deleteUser,
  listRoles,
  listUnifiedAccounts,
  listUsers,
  updateUser,
} from '@/api/client';
import type {RoleRecord, User} from '@/api/types';
import {SettingsTabs} from '@/components/settings-tabs';
import {Button} from '@/components/ui/button';
import {Dialog} from '@/components/ui/dialog';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {Switch} from '@/components/ui/switch';
import {formatDate} from '@/lib/format';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';
import {hasUserPermission, isAdminUser, useAuthStore} from '@/stores/auth';

function DeviceAccessSelector({
  idPrefix,
  accounts,
  selectedIds,
  onChange,
  disabled,
}: {
  idPrefix: string;
  accounts: Array<{id: string; display_name: string; phone_number: string | null}>;
  selectedIds: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const {t} = useI18n();
  const isAll = selectedIds.length === 0;

  const knownIds = new Set(accounts.map((a) => a.id));
  const extraIds = selectedIds.filter((id) => !knownIds.has(id));
  const combinedAccounts = [
    ...accounts,
    ...extraIds.map((id) => ({id, display_name: id, phone_number: null})),
  ];

  const toggleMode = (allMode: boolean) => {
    if (disabled) return;
    if (allMode) {
      onChange([]);
    } else if (combinedAccounts.length > 0) {
      onChange([combinedAccounts[0].id]);
    }
  };

  const toggleAccount = (accountId: string) => {
    if (disabled) return;
    const exists = selectedIds.includes(accountId);
    const next = exists
      ? selectedIds.filter((id) => id !== accountId)
      : [...selectedIds, accountId];
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/20 p-3">
      <span className="text-xs font-medium text-foreground">{t.users.deviceAccessLabel}</span>

      <div className="flex flex-col gap-1.5 text-xs">
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="radio"
            name={`${idPrefix}-device-mode`}
            checked={isAll}
            disabled={disabled}
            onChange={() => toggleMode(true)}
            className="accent-primary"
          />
          <span className="font-medium text-foreground">{t.users.deviceAccessAllOption}</span>
        </label>
        <p className="ps-5 text-[11px] text-muted-foreground">{t.users.deviceAccessAllHint}</p>

        <label className="mt-1 flex cursor-pointer items-center gap-2">
          <input
            type="radio"
            name={`${idPrefix}-device-mode`}
            checked={!isAll}
            disabled={disabled || combinedAccounts.length === 0}
            onChange={() => toggleMode(false)}
            className="accent-primary"
          />
          <span className="font-medium text-foreground">{t.users.deviceAccessSpecificOption}</span>
        </label>
      </div>

      {combinedAccounts.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">{t.users.deviceAccessNoAccounts}</p>
      ) : (
        <div className="mt-1 grid max-h-40 gap-1.5 overflow-y-auto border-t border-border pt-2">
          {combinedAccounts.map((acc) => {
            const checked = !isAll && selectedIds.includes(acc.id);
            return (
              <label
                key={acc.id}
                className="flex cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1 text-xs hover:bg-muted/40"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled}
                    onChange={() => toggleAccount(acc.id)}
                    className="size-3.5 shrink-0 accent-primary"
                  />
                  <span className="truncate font-medium text-foreground">{acc.display_name}</span>
                </span>
                <span dir="ltr" className="shrink-0 font-mono text-[11px] text-muted-foreground">
                  {acc.phone_number || acc.id}
                </span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

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
  const [newDeviceIds, setNewDeviceIds] = useState<string[]>([]);

  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [editName, setEditName] = useState('');
  const [editRoleId, setEditRoleId] = useState<number | ''>('');
  const [editDeviceIds, setEditDeviceIds] = useState<string[]>([]);
  const [editActive, setEditActive] = useState(true);
  const [editPassword, setEditPassword] = useState('');

  const [deletingUser, setDeletingUser] = useState<User | null>(null);

  const usersQuery = useQuery({
    queryKey: ['users'],
    queryFn: listUsers,
  });

  const rolesQuery = useQuery({
    queryKey: ['roles'],
    queryFn: listRoles,
  });

  const accountsQuery = useQuery({
    queryKey: ['unified-accounts-assign'],
    queryFn: listUnifiedAccounts,
    enabled: canAssignDevices,
    retry: false,
  });

  const roles = useMemo(() => rolesQuery.data ?? [], [rolesQuery.data]);
  const accounts = useMemo(() => accountsQuery.data ?? [], [accountsQuery.data]);
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
    mutationFn: () =>
      createUser({
        display_name: newName.trim(),
        username: newUsername.trim(),
        password: newPassword,
        role_id: typeof newRoleId === 'number' ? newRoleId : undefined,
        ...(canAssignDevices ? {allowed_device_ids: newDeviceIds} : {}),
      }),
    onSuccess: () => {
      toast.success(t.users.createdToast);
      void queryClient.invalidateQueries({queryKey: ['users']});
      void queryClient.invalidateQueries({queryKey: ['roles']});
      setNewName('');
      setNewUsername('');
      setNewPassword('');
      setNewRoleId(defaultRoleId);
      setNewDeviceIds([]);
      setCreateOpen(false);
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const updateMutation = useMutation({
    mutationFn: () => {
      if (!editingUser) throw new Error('No user selected');
      return updateUser(editingUser.id, {
        display_name: editName.trim(),
        role_id: typeof editRoleId === 'number' ? editRoleId : undefined,
        ...(canAssignDevices ? {allowed_device_ids: editDeviceIds} : {}),
        is_active: editActive,
        password: editPassword || undefined,
      });
    },
    onSuccess: () => {
      toast.success(t.users.updatedToast);
      void queryClient.invalidateQueries({queryKey: ['users']});
      void queryClient.invalidateQueries({queryKey: ['roles']});
      setEditingUser(null);
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
    setNewDeviceIds([]);
    setCreateOpen(true);
  };

  const openEdit = (u: User) => {
    setEditingUser(u);
    setEditName(u.display_name);
    setEditRoleId(u.role_id);
    setEditDeviceIds(u.allowed_device_ids ?? []);
    setEditActive(u.is_active);
    setEditPassword('');
  };

  const formatAccountsSummary = (deviceIds: string[]) => {
    if (!deviceIds || deviceIds.length === 0) return t.users.allAccountsAccess;
    if (deviceIds.length <= 2) {
      return deviceIds.map((id) => accountNameMap.get(id) ?? id).join(' · ');
    }
    return t.users.restrictedAccountsCount(deviceIds.length);
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
          className="h-9 rounded-lg border border-input bg-card px-3 text-xs text-foreground"
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
          className="h-9 rounded-lg border border-input bg-card px-3 text-xs text-foreground"
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
                <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                  {t.loading}
                </td>
              </tr>
            ) : users.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                  {t.users.empty}
                </td>
              </tr>
            ) : filteredUsers.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                  {t.users.noFilteredUsers}
                </td>
              </tr>
            ) : (
              filteredUsers.map((u) => (
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
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {formatAccountsSummary(u.allowed_device_ids)}
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
              ))
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
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            createMutation.mutate();
          }}
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
              className="h-10 rounded-lg border border-input bg-card px-3 text-sm text-foreground"
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

          {canAssignDevices && (
            <DeviceAccessSelector
              idPrefix="create"
              accounts={accounts}
              selectedIds={newDeviceIds}
              onChange={setNewDeviceIds}
            />
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
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            updateMutation.mutate();
          }}
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
              className="h-10 rounded-lg border border-input bg-card px-3 text-sm text-foreground"
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

          {canAssignDevices && (
            <DeviceAccessSelector
              idPrefix="edit"
              accounts={accounts}
              selectedIds={editDeviceIds}
              onChange={setEditDeviceIds}
            />
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
    </div>
  );
}
