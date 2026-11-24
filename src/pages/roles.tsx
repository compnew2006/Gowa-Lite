import {useEffect, useMemo, useState, type FormEvent} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {Copy, Loader2, Lock, Plus, Save, ShieldCheck, Trash2} from 'lucide-react';
import {toast} from 'sonner';
import {
  createRole,
  deleteRole,
  listPermissions,
  listRoles,
  updateRole,
} from '@/api/client';
import type {RoleRecord} from '@/api/types';
import {SettingsTabs} from '@/components/settings-tabs';
import {Button} from '@/components/ui/button';
import {Dialog} from '@/components/ui/dialog';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {Switch} from '@/components/ui/switch';
import {PermissionMatrix} from '@/features/rbac/permission-matrix';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';
import {cn} from '@/lib/utils';
import {hasUserPermission, isAdminUser, useAuthStore} from '@/stores/auth';

function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every((item) => setB.has(item));
}

export default function RolesPage() {
  const queryClient = useQueryClient();
  const {t} = useI18n();
  const currentUser = useAuthStore((s) => s.user);
  const canWrite = hasUserPermission(currentUser, 'roles:write');
  const canDelete = hasUserPermission(currentUser, 'roles:delete');
  const isCurrentAdmin = isAdminUser(currentUser);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftDesc, setDraftDesc] = useState('');
  const [draftDefault, setDraftDefault] = useState(false);
  const [draftPermissions, setDraftPermissions] = useState<string[]>([]);

  const [pendingRoleId, setPendingRoleId] = useState<number | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newDefault, setNewDefault] = useState(false);
  const [newPermissions, setNewPermissions] = useState<string[]>([
    'chats:read',
    'chats:write',
    'notes:read',
    'notes:write',
  ]);
  const [deletingRole, setDeletingRole] = useState<RoleRecord | null>(null);

  const rolesQuery = useQuery({
    queryKey: ['roles'],
    queryFn: listRoles,
  });

  const permissionsQuery = useQuery({
    queryKey: ['permissions-catalog'],
    queryFn: listPermissions,
    staleTime: 300_000,
  });

  const roles = useMemo(() => rolesQuery.data ?? [], [rolesQuery.data]);
  const groups = permissionsQuery.data ?? [];

  const disabledKeys = useMemo(() => {
    if (isCurrentAdmin) return undefined;
    const held = new Set(currentUser?.permissions ?? []);
    const locked = new Set<string>();
    for (const group of groups) {
      for (const perm of group.permissions ?? []) {
        if (!held.has(perm.key)) locked.add(perm.key);
      }
    }
    return locked;
  }, [currentUser?.permissions, groups, isCurrentAdmin]);

  const activeRole = useMemo(() => {
    if (roles.length === 0) return null;
    if (selectedId !== null) {
      const found = roles.find((r) => r.id === selectedId);
      if (found) return found;
    }
    return roles[0];
  }, [roles, selectedId]);

  useEffect(() => {
    if (!activeRole) return;
    if (selectedId !== activeRole.id) {
      setSelectedId(activeRole.id);
    }
    setDraftName(activeRole.name);
    setDraftDesc(activeRole.description);
    setDraftDefault(activeRole.is_default);
    setDraftPermissions(activeRole.permissions);
  }, [activeRole, selectedId]);

  const isDirty = useMemo(() => {
    if (!activeRole || activeRole.is_system || !canWrite) return false;
    return (
      draftName.trim() !== activeRole.name ||
      draftDesc.trim() !== activeRole.description ||
      draftDefault !== activeRole.is_default ||
      !sameStringSet(draftPermissions, activeRole.permissions)
    );
  }, [activeRole, canWrite, draftDefault, draftDesc, draftName, draftPermissions]);

  const formatRoleTitle = (role: RoleRecord) =>
    role.is_system ? t.rbac.systemRoleNames[role.slug] ?? role.name : role.name;

  const updateMutation = useMutation({
    mutationFn: () => {
      if (!activeRole) throw new Error('No role selected');
      return updateRole(activeRole.id, {
        name: draftName.trim(),
        description: draftDesc.trim(),
        is_default: draftDefault,
        permissions: draftPermissions,
      });
    },
    onSuccess: (updated) => {
      toast.success(t.roles.updatedToast);
      void queryClient.invalidateQueries({queryKey: ['roles']});
      void queryClient.invalidateQueries({queryKey: ['users']});
      setSelectedId(updated.id);
      setDraftName(updated.name);
      setDraftDesc(updated.description);
      setDraftDefault(updated.is_default);
      setDraftPermissions(updated.permissions);
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      createRole({
        name: newName.trim(),
        description: newDesc.trim(),
        is_default: newDefault,
        permissions: newPermissions,
      }),
    onSuccess: (created) => {
      toast.success(t.roles.createdToast);
      setCreateOpen(false);
      setNewName('');
      setNewDesc('');
      setNewDefault(false);
      void queryClient.invalidateQueries({queryKey: ['roles']});
      setSelectedId(created.id);
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => deleteRole(id),
    onSuccess: () => {
      toast.success(t.roles.deletedToast);
      setDeletingRole(null);
      setSelectedId(null);
      void queryClient.invalidateQueries({queryKey: ['roles']});
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const handleSelectRole = (id: number) => {
    if (id === activeRole?.id) return;
    if (isDirty) {
      setPendingRoleId(id);
      return;
    }
    setSelectedId(id);
  };

  const handleDiscardEdits = () => {
    if (!activeRole) return;
    setDraftName(activeRole.name);
    setDraftDesc(activeRole.description);
    setDraftDefault(activeRole.is_default);
    setDraftPermissions(activeRole.permissions);
  };

  const openCloneModal = (role: RoleRecord) => {
    const heldSet = isCurrentAdmin ? null : new Set(currentUser?.permissions ?? []);
    const safePerms = heldSet
      ? role.permissions.filter((key) => heldSet.has(key))
      : role.permissions;
    setNewName(`${formatRoleTitle(role)} — ${t.roles.cloneSuffix}`);
    setNewDesc(role.description);
    setNewDefault(false);
    setNewPermissions(safePerms);
    setCreateOpen(true);
  };

  const isEditorReadOnly = !activeRole || activeRole.is_system || !canWrite;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        <SettingsTabs />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-bold text-foreground" style={{textWrap: 'balance'}}>
              {t.roles.pageTitle}
            </h1>
            <p className="text-xs text-muted-foreground">{t.roles.pageSubtitle}</p>
          </div>

          {canWrite && (
            <Button
              onClick={() => {
                setNewName('');
                setNewDesc('');
                setNewDefault(false);
                setNewPermissions(['chats:read', 'chats:write']);
                setCreateOpen(true);
              }}
              className="whitespace-nowrap shrink-0"
            >
              <Plus className="size-4" />
              <span>{t.roles.newRole}</span>
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[280px_minmax(0,1fr)] lg:items-start">
        {/* Role Directory */}
        <aside className="overflow-hidden rounded-xl border border-border bg-card">
          {rolesQuery.isLoading ? (
            <div className="p-6 text-center text-xs text-muted-foreground">{t.loading}</div>
          ) : roles.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">{t.roles.emptyList}</div>
          ) : (
            <div className="divide-y divide-border">
              {roles.map((role) => {
                const isSelected = role.id === activeRole?.id;
                return (
                  <button
                    key={role.id}
                    type="button"
                    onClick={() => handleSelectRole(role.id)}
                    className={cn(
                      'flex w-full cursor-pointer flex-col gap-1 px-4 py-3 text-start transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
                      isSelected ? 'border-s-2 border-primary bg-secondary/70' : 'hover:bg-muted/40',
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-semibold text-foreground">
                        {formatRoleTitle(role)}
                      </span>
                      {role.is_system && (
                        <Lock className="size-3.5 shrink-0 text-muted-foreground" />
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground tabular-nums">
                      <span>{t.roles.usersCount(role.user_count)}</span>
                      <span>·</span>
                      <span>{t.roles.permsCount(role.permissions.length)}</span>
                      {role.is_default && (
                        <>
                          <span>·</span>
                          <span className="font-medium text-primary">{t.roles.defaultBadge}</span>
                        </>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </aside>

        {/* Role Editor & Matrix */}
        <section className="flex min-w-0 flex-col gap-4">
          {!activeRole ? (
            <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
              {t.roles.selectPrompt}
            </div>
          ) : (
            <>
              <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5">
                {activeRole.is_system && (
                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-3.5 py-2.5 text-xs">
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <Lock className="size-4 shrink-0" />
                      <span>{t.roles.systemReadOnlyBanner}</span>
                    </div>
                    {canWrite && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => openCloneModal(activeRole)}
                        className="whitespace-nowrap shrink-0"
                      >
                        <Copy className="size-3.5" />
                        <span>{t.roles.cloneToCustom}</span>
                      </Button>
                    )}
                  </div>
                )}

                {!activeRole.is_system && !canWrite && (
                  <div className="rounded-lg border border-border bg-muted/40 px-3.5 py-2 text-xs text-muted-foreground">
                    {t.roles.readOnlyHint}
                  </div>
                )}

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="role-editor-name">{t.roles.nameLabel}</Label>
                    <Input
                      id="role-editor-name"
                      value={activeRole.is_system ? formatRoleTitle(activeRole) : draftName}
                      disabled={isEditorReadOnly}
                      onChange={(e) => setDraftName(e.target.value)}
                      placeholder={t.roles.namePlaceholder}
                    />
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="role-editor-desc">{t.roles.descriptionLabel}</Label>
                    <Input
                      id="role-editor-desc"
                      value={draftDesc}
                      disabled={isEditorReadOnly}
                      onChange={(e) => setDraftDesc(e.target.value)}
                      placeholder={t.roles.descriptionPlaceholder}
                    />
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
                  <div className="flex items-center gap-3">
                    {!activeRole.is_system && (
                      <label className="flex items-center gap-2.5 text-xs font-medium text-foreground">
                        <Switch
                          checked={draftDefault}
                          disabled={isEditorReadOnly}
                          onCheckedChange={setDraftDefault}
                        />
                        <span>{t.roles.isDefaultLabel}</span>
                      </label>
                    )}
                    {activeRole.is_system && (
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <ShieldCheck className="size-4 text-primary" />
                        <span>{t.roles.systemBadge}</span>
                        <span>·</span>
                        <span dir="ltr" className="font-mono">
                          {activeRole.slug}
                        </span>
                      </div>
                    )}
                  </div>

                  {!activeRole.is_system && canDelete && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={activeRole.user_count > 0 || deleteMutation.isPending}
                      title={
                        activeRole.user_count > 0
                          ? t.roles.roleInUseNotice(activeRole.user_count)
                          : undefined
                      }
                      onClick={() => setDeletingRole(activeRole)}
                      className="whitespace-nowrap shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 className="size-3.5" />
                      <span>{t.roles.deleteRole}</span>
                    </Button>
                  )}
                </div>

                {!activeRole.is_system && activeRole.user_count > 0 && canDelete && (
                  <p className="text-xs text-muted-foreground">
                    {t.roles.roleInUseNotice(activeRole.user_count)}
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold text-foreground">{t.roles.matrixTitle}</h2>
                  {!isCurrentAdmin && !isEditorReadOnly && (
                    <span className="text-xs text-muted-foreground">{t.roles.escalationHint}</span>
                  )}
                </div>

                {permissionsQuery.isLoading ? (
                  <div className="rounded-xl border border-border bg-card p-6 text-center text-xs text-muted-foreground">
                    {t.loading}
                  </div>
                ) : (
                  <PermissionMatrix
                    groups={groups}
                    selectedKeys={draftPermissions}
                    onChange={setDraftPermissions}
                    readOnly={isEditorReadOnly}
                    disabledKeys={isEditorReadOnly ? undefined : disabledKeys}
                  />
                )}
              </div>

              {isDirty && (
                <div className="sticky bottom-3 z-20 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/40 bg-card px-4 py-3 shadow-lg">
                  <span className="text-xs font-medium text-foreground tabular-nums">
                    {t.roles.unsavedChangesCount(draftPermissions.length)}
                  </span>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleDiscardEdits}
                      disabled={updateMutation.isPending}
                    >
                      {t.roles.discardChanges}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      disabled={updateMutation.isPending || !draftName.trim()}
                      onClick={() => updateMutation.mutate()}
                    >
                      {updateMutation.isPending ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Save className="size-4" />
                      )}
                      <span>{t.saveChanges}</span>
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </section>
      </div>

      {/* Create Role Dialog */}
      <Dialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title={t.roles.createTitle}
        description={t.roles.createDesc}
        className="sm:max-w-2xl"
      >
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            createMutation.mutate();
          }}
          className="flex max-h-[75vh] flex-col gap-4"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-role-name">{t.roles.nameLabel}</Label>
              <Input
                id="new-role-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={t.roles.namePlaceholder}
                required
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-role-desc">{t.roles.descriptionLabel}</Label>
              <Input
                id="new-role-desc"
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                placeholder={t.roles.descriptionPlaceholder}
              />
            </div>
          </div>

          <label className="flex items-center gap-2.5 text-xs font-medium text-foreground">
            <Switch checked={newDefault} onCheckedChange={setNewDefault} />
            <span>{t.roles.isDefaultLabel}</span>
          </label>

          <div className="min-h-0 flex-1 overflow-y-auto pe-1">
            <PermissionMatrix
              groups={groups}
              selectedKeys={newPermissions}
              onChange={setNewPermissions}
              disabledKeys={disabledKeys}
            />
          </div>

          <div className="flex justify-end gap-2 border-t border-border pt-3">
            <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
              {t.cancel}
            </Button>
            <Button type="submit" disabled={createMutation.isPending || !newName.trim()}>
              {createMutation.isPending && <Loader2 className="size-4 animate-spin" />}
              <span>{t.roles.createSubmit}</span>
            </Button>
          </div>
        </form>
      </Dialog>

      {/* Delete Role Dialog */}
      <Dialog
        open={deletingRole !== null}
        onOpenChange={(open) => !open && setDeletingRole(null)}
        title={t.roles.deleteTitle}
        description={deletingRole ? t.roles.deleteDesc(formatRoleTitle(deletingRole)) : undefined}
        className="sm:max-w-sm"
      >
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={() => setDeletingRole(null)}>
            {t.cancel}
          </Button>
          <Button
            variant="destructive"
            disabled={deleteMutation.isPending}
            onClick={() => deletingRole && deleteMutation.mutate(deletingRole.id)}
          >
            {t.confirmDelete}
          </Button>
        </div>
      </Dialog>

      {/* Unsaved Changes Guard Dialog */}
      <Dialog
        open={pendingRoleId !== null}
        onOpenChange={(open) => !open && setPendingRoleId(null)}
        title={t.roles.leaveConfirmTitle}
        description={t.roles.leaveConfirmDesc}
        className="sm:max-w-sm"
      >
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={() => setPendingRoleId(null)}>
            {t.cancel}
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              if (pendingRoleId !== null) {
                setSelectedId(pendingRoleId);
              }
              setPendingRoleId(null);
            }}
          >
            {t.roles.leaveDiscardBtn}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
