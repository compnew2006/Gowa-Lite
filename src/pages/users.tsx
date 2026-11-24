import {useState, type FormEvent} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {Loader2, Pencil, Plus, Trash2} from 'lucide-react';
import {toast} from 'sonner';
import {createUser, deleteUser, listUsers, updateUser} from '@/api/client';
import type {User, UserRole} from '@/api/types';
import {Button} from '@/components/ui/button';
import {Dialog} from '@/components/ui/dialog';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {Switch} from '@/components/ui/switch';
import {formatDate} from '@/lib/format';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';
import {useAuthStore} from '@/stores/auth';

export default function UsersPage() {
  const queryClient = useQueryClient();
  const {lang, t} = useI18n();
  const currentUser = useAuthStore((s) => s.user);

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<UserRole>('agent');

  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [editName, setEditName] = useState('');
  const [editRole, setEditRole] = useState<UserRole>('agent');
  const [editActive, setEditActive] = useState(true);
  const [editPassword, setEditPassword] = useState('');

  const [deletingUser, setDeletingUser] = useState<User | null>(null);

  const query = useQuery({
    queryKey: ['users'],
    queryFn: listUsers,
  });

  const createMutation = useMutation({
    mutationFn: () =>
      createUser({
        display_name: newName.trim(),
        username: newUsername.trim(),
        password: newPassword,
        role: newRole,
      }),
    onSuccess: () => {
      toast.success(t.users.createdToast);
      void queryClient.invalidateQueries({queryKey: ['users']});
      setNewName('');
      setNewUsername('');
      setNewPassword('');
      setNewRole('agent');
      setCreateOpen(false);
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const updateMutation = useMutation({
    mutationFn: () => {
      if (!editingUser) throw new Error('No user selected');
      return updateUser(editingUser.id, {
        display_name: editName.trim(),
        role: editRole,
        is_active: editActive,
        password: editPassword || undefined,
      });
    },
    onSuccess: () => {
      toast.success(t.users.updatedToast);
      void queryClient.invalidateQueries({queryKey: ['users']});
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
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const openEdit = (u: User) => {
    setEditingUser(u);
    setEditName(u.display_name);
    setEditRole(u.role);
    setEditActive(u.is_active);
    setEditPassword('');
  };

  const users = query.data ?? [];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold text-foreground">{t.users.pageTitle}</h1>
          <p className="text-xs text-muted-foreground">{t.users.pageSubtitle}</p>
        </div>

        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="size-4" />
          <span>{t.users.addUser}</span>
        </Button>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full text-start text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40 text-xs text-muted-foreground">
              <th className="px-4 py-3 font-medium">{t.users.colName}</th>
              <th className="px-4 py-3 font-medium">{t.users.colUsername}</th>
              <th className="px-4 py-3 font-medium">{t.users.colRole}</th>
              <th className="px-4 py-3 font-medium">{t.users.colStatus}</th>
              <th className="px-4 py-3 font-medium">{t.users.colCreatedAt}</th>
              <th className="px-4 py-3 font-medium">{t.users.colActions}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {query.isLoading ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                  {t.loading}
                </td>
              </tr>
            ) : users.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                  {t.users.empty}
                </td>
              </tr>
            ) : (
              users.map((u) => (
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
                  <td className="px-4 py-3 text-xs">
                    {u.role === 'admin' ? t.users.roleAdmin : t.users.roleAgent}
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
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => openEdit(u)}
                        title={t.editAction}
                        aria-label={`${t.editAction} ${u.display_name}`}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={u.id === currentUser?.id}
                        onClick={() => setDeletingUser(u)}
                        title={t.deleteAction}
                        aria-label={`${t.deleteAction} ${u.display_name}`}
                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </td>
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
        className="sm:max-w-md"
      >
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            createMutation.mutate();
          }}
          className="flex flex-col gap-4"
        >
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
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as UserRole)}
              className="h-10 rounded-lg border border-input bg-card px-3 text-sm text-foreground"
            >
              <option value="agent">{t.users.roleAgentOption}</option>
              <option value="admin">{t.users.roleAdminOption}</option>
            </select>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
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
        className="sm:max-w-md"
      >
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            updateMutation.mutate();
          }}
          className="flex flex-col gap-4"
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
              value={editRole}
              onChange={(e) => setEditRole(e.target.value as UserRole)}
              className="h-10 rounded-lg border border-input bg-card px-3 text-sm text-foreground"
            >
              <option value="agent">{t.users.roleAgentOption}</option>
              <option value="admin">{t.users.roleAdminOption}</option>
            </select>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5">
            <span className="text-sm font-medium">{t.users.accountActive}</span>
            <Switch checked={editActive} onCheckedChange={setEditActive} />
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
            <Button variant="outline" onClick={() => setEditingUser(null)}>
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
          <Button variant="outline" onClick={() => setDeletingUser(null)}>
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
