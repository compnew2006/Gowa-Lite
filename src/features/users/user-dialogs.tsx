import {useState, type FormEvent} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {Loader2, Star} from 'lucide-react';
import {toast} from 'sonner';
import {createUser, deleteUser, getUserRatings, updateUser} from '@/api/requests/users';
import type {AssignableAccountSummary, RoleRecord, User} from '@/api/types';
import {Button} from '@/components/ui/button';
import {Dialog} from '@/components/ui/dialog';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {Skeleton} from '@/components/ui/skeleton';
import {Switch} from '@/components/ui/switch';
import {DeviceAccessSelector} from '@/features/users/device-access-selector';
import {validateDeviceAccessSelection, type DeviceAccessMode} from '@/features/users/device-access-helpers';
import {formatDate, formatNumber} from '@/lib/format';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';

export type UserDialogSelection =
  | {kind: 'create'}
  | {kind: 'edit' | 'accounts' | 'delete' | 'ratings'; user: User};

interface AccountFields {
  accounts: AssignableAccountSummary[];
  gowaReachable: boolean;
  onRetryAccounts: () => void;
  isRetrying: boolean;
}

interface EditFields extends AccountFields {
  roles: RoleRecord[];
  canAssignDevices: boolean;
  canAssignRole: (role: RoleRecord) => boolean;
  formatRoleLabel: (slug: string, name: string) => string;
  onClose: () => void;
}

export default function UserDialogs({
  dialog, defaultRoleId, currentUserId, formatAccountsFullTooltip, accountNameMap, ...fields
}: EditFields & {
  dialog: UserDialogSelection;
  defaultRoleId: number | '';
  currentUserId?: number;
  formatAccountsFullTooltip: (deviceIds: string[]) => string;
  accountNameMap: Map<string, string>;
}) {
  switch (dialog.kind) {
    case 'create':
      return <CreateUserDialog {...fields} defaultRoleId={defaultRoleId} />;
    case 'edit':
      return <EditUserDialog {...fields} editingUser={dialog.user} currentUserId={currentUserId}
        formatAccountsFullTooltip={formatAccountsFullTooltip} />;
    case 'accounts':
      return <UserAccountsDialog {...fields} managingAccountsUser={dialog.user} />;
    case 'delete':
      return <DeleteUserDialog deletingUser={dialog.user} onClose={fields.onClose} />;
    case 'ratings':
      return <UserRatingsDialog ratingsUser={dialog.user} accountNameMap={accountNameMap} onClose={fields.onClose} />;
  }
}

function CreateUserDialog({
  defaultRoleId, roles, canAssignDevices, canAssignRole, formatRoleLabel,
  accounts, gowaReachable, onRetryAccounts, isRetrying, onClose,
}: EditFields & {defaultRoleId: number | ''}) {
  const {t} = useI18n();
  const queryClient = useQueryClient();
  const [newName, setNewName] = useState('');
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRoleId, setNewRoleId] = useState<number | ''>(defaultRoleId);
  const [newDeviceMode, setNewDeviceMode] = useState<DeviceAccessMode>('all');
  const [newDeviceIds, setNewDeviceIds] = useState<string[]>([]);
  const [createTriedSubmit, setCreateTriedSubmit] = useState(false);

  const selectedCreateRole = roles.find((role) => role.id === newRoleId);

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
      onClose();
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

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

  return (
    <Dialog
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
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
            onRetryAccounts={onRetryAccounts}
            isRetrying={isRetrying}
            showValidationError={createTriedSubmit}
          />
        ) : (
          <p className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
            {t.users.deviceAccessNoPermissionHint}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>
            {t.cancel}
          </Button>
          <Button type="submit" disabled={createMutation.isPending}>
            {createMutation.isPending && <Loader2 className="size-4 animate-spin" />}
            <span>{t.users.createSubmit}</span>
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function EditUserDialog({
  editingUser, currentUserId, formatAccountsFullTooltip,
  roles, canAssignDevices, canAssignRole, formatRoleLabel, accounts, gowaReachable,
  onRetryAccounts, isRetrying, onClose,
}: EditFields & {
  editingUser: User;
  currentUserId?: number;
  formatAccountsFullTooltip: (deviceIds: string[]) => string;
}) {
  const {t} = useI18n();
  const queryClient = useQueryClient();
  const initialIds = editingUser.allowed_device_ids ?? [];
  const [editName, setEditName] = useState(editingUser.display_name);
  const [editRoleId, setEditRoleId] = useState<number | ''>(editingUser.role_id);
  const [editDeviceMode, setEditDeviceMode] = useState<DeviceAccessMode>(initialIds.length ? 'specific' : 'all');
  const [editDeviceIds, setEditDeviceIds] = useState(initialIds);
  const [editActive, setEditActive] = useState(editingUser.is_active);
  const [editPassword, setEditPassword] = useState('');
  const [editTriedSubmit, setEditTriedSubmit] = useState(false);

  const selectedEditRole = roles.find((role) => role.id === editRoleId);

  const updateMutation = useMutation({
    mutationFn: (resolvedDeviceIds: string[]) => {
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
      onClose();
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

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

  return (
    <Dialog
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
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
                disabled={role.id !== editingUser.role_id && !canAssignRole(role)}
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
            onRetryAccounts={onRetryAccounts}
            isRetrying={isRetrying}
            showValidationError={editTriedSubmit}
          />
        ) : (
          <div className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">{t.users.deviceAccessLabel}</p>
            <p className="mt-1">{formatAccountsFullTooltip(editingUser.allowed_device_ids ?? [])}</p>
            <p className="mt-1 text-[11px]">{t.users.deviceAccessNoPermissionHint}</p>
          </div>
        )}

        <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5">
          <span className="text-sm font-medium">{t.users.accountActive}</span>
          <Switch
            checked={editActive}
            disabled={editingUser.id === currentUserId}
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
          <Button type="button" variant="outline" onClick={onClose}>
            {t.cancel}
          </Button>
          <Button type="submit" disabled={updateMutation.isPending}>
            {updateMutation.isPending && <Loader2 className="size-4 animate-spin" />}
            <span>{t.saveChanges}</span>
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function UserAccountsDialog({
  managingAccountsUser, accounts, gowaReachable, onRetryAccounts, isRetrying, onClose,
}: AccountFields & {managingAccountsUser: User; onClose: () => void}) {
  const {t} = useI18n();
  const queryClient = useQueryClient();
  const initialIds = managingAccountsUser.allowed_device_ids ?? [];
  const [quickDeviceMode, setQuickDeviceMode] = useState<DeviceAccessMode>(initialIds.length ? 'specific' : 'all');
  const [quickDeviceIds, setQuickDeviceIds] = useState(initialIds);
  const [quickTriedSubmit, setQuickTriedSubmit] = useState(false);

  const manageAccountsMutation = useMutation({
    mutationFn: (resolvedDeviceIds: string[]) => {
      return updateUser(managingAccountsUser.id, {
        allowed_device_ids: resolvedDeviceIds,
      });
    },
    onSuccess: () => {
      toast.success(t.users.accountsUpdatedToast);
      void queryClient.invalidateQueries({queryKey: ['users']});
      void queryClient.invalidateQueries({queryKey: ['unified-accounts-assign']});
      onClose();
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

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

  return (
    <Dialog
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      title={t.users.manageAccountsTitle(managingAccountsUser.display_name)}
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
          onRetryAccounts={onRetryAccounts}
          isRetrying={isRetrying}
          showValidationError={quickTriedSubmit}
        />

        <div className="flex justify-end gap-2 pt-1">
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
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
  );
}

function DeleteUserDialog({deletingUser, onClose}: {deletingUser: User; onClose: () => void}) {
  const {t} = useI18n();
  const queryClient = useQueryClient();
  const deleteMutation = useMutation({
    mutationFn: (id: number) => deleteUser(id),
    onSuccess: () => {
      toast.success(t.users.deletedToast);
      onClose();
      void queryClient.invalidateQueries({queryKey: ['users']});
      void queryClient.invalidateQueries({queryKey: ['roles']});
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      title={t.users.deleteTitle}
      description={t.users.deleteDesc(deletingUser.display_name)}
      className="sm:max-w-sm"
    >
      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="outline" onClick={onClose}>
          {t.cancel}
        </Button>
        <Button
          variant="destructive"
          disabled={deleteMutation.isPending}
          onClick={() => deleteMutation.mutate(deletingUser.id)}
        >
          {t.confirmDelete}
        </Button>
      </div>
    </Dialog>
  );
}

function UserRatingsDialog({ratingsUser, accountNameMap, onClose}: {
  ratingsUser: User;
  accountNameMap: Map<string, string>;
  onClose: () => void;
}) {
  const {lang, t} = useI18n();
  const userRatingDetailQuery = useQuery({
    queryKey: ['user-ratings-detail', ratingsUser.id],
    queryFn: () => getUserRatings(ratingsUser.id),
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      title={t.users.ratingsDialogTitle(ratingsUser.display_name)}
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
                  : formatNumber(userRatingDetailQuery.data.average, lang, {maximumFractionDigits: 1})}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t.users.ratingsTotalLabel}</dt>
              <dd className="mt-1 text-lg font-semibold tabular-nums">
                {formatNumber(userRatingDetailQuery.data.count, lang, {maximumFractionDigits: 1})}
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
                        {formatNumber(acc.average, lang, {maximumFractionDigits: 1})} / {formatNumber(5, lang, {maximumFractionDigits: 1})}
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
                        {formatNumber(rating.score, lang, {maximumFractionDigits: 1})} / {formatNumber(5, lang, {maximumFractionDigits: 1})}
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
  );
}
