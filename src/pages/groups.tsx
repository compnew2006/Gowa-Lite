import {useEffect, useMemo, useState} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {UsersRound} from 'lucide-react';
import {toast} from 'sonner';
import {
  createGroup,
  getGroupInfoFromLink,
  joinGroupWithLink,
  listUnifiedGroups,
} from '@/api/client';
import type {AccountSummary, GroupInfoFromLink, UnifiedDirectoryItem} from '@/api/types';
import {
  GowaSetupNotice,
  isGowaConnectionError,
  SplitWorkspace,
  WorkspaceEmptyState,
} from '@/components/layout/split-workspace';
import {Button} from '@/components/ui/button';
import {Dialog} from '@/components/ui/dialog';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {GroupWorkspacePanel} from '@/features/groups/group-workspace-panel';
import {
  directoryItemKey,
  GroupsSidebar,
  type DirectoryKindFilter,
} from '@/features/groups/groups-sidebar';
import {NewsletterWorkspacePanel} from '@/features/groups/newsletter-workspace-panel';
import {onWsEvent} from '@/lib/events';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';
import {parseParticipantsList} from '@/lib/participants';
import {hasUserAnyPermission, hasUserPermission, useAuthStore} from '@/stores/auth';

const SIDEBAR_STORAGE_KEY = 'gowa-lite:groups-sidebar-width';

function isOnlineAccount(account: AccountSummary): boolean {
  return account.state === 'logged_in' || account.state === 'connected';
}

export default function GroupsPage() {
  const queryClient = useQueryClient();
  const {t} = useI18n();
  const user = useAuthStore((s) => s.user);
  const canWriteGroups = hasUserPermission(user, 'groups:write');
  const canViewSettings = hasUserAnyPermission(user, ['settings:read', 'settings:write']);

  const [selectedDeviceIds, setSelectedDeviceIds] = useState<string[]>([]);
  const [kindFilter, setKindFilter] = useState<DirectoryKindFilter>('all');
  const [search, setSearch] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [mobileShowDetail, setMobileShowDetail] = useState(false);

  const [targetDeviceId, setTargetDeviceId] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newParticipants, setNewParticipants] = useState('');

  const [joinOpen, setJoinOpen] = useState(false);
  const [joinLink, setJoinLink] = useState('');

  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLink, setPreviewLink] = useState('');
  const [previewInfo, setPreviewInfo] = useState<GroupInfoFromLink | null>(null);

  const query = useQuery({
    queryKey: ['unified-groups', selectedDeviceIds],
    queryFn: () =>
      listUnifiedGroups({
        deviceIds: selectedDeviceIds.length > 0 ? selectedDeviceIds : undefined,
      }),
    refetchInterval: 30_000,
  });

  useEffect(() => {
    return onWsEvent((event) => {
      if (
        event.code === 'LOGIN_SUCCESS' ||
        event.code === 'DEVICE_LOGGED_OUT' ||
        event.code === 'DEVICE_REMOVED' ||
        event.code === 'LIST_DEVICES'
      ) {
        void queryClient.invalidateQueries({queryKey: ['unified-groups']});
      }
    });
  }, [queryClient]);

  const items = query.data?.items ?? [];
  const groupsCount = query.data?.groups_count ?? 0;
  const newslettersCount = query.data?.newsletters_count ?? 0;
  const accounts = query.data?.accounts ?? [];

  const actionableAccounts = useMemo(() => accounts.filter(isOnlineAccount), [accounts]);

  const defaultTargetDeviceId = useMemo(() => {
    if (selectedDeviceIds.length > 0) {
      const match = actionableAccounts.find((a) => selectedDeviceIds.includes(a.id));
      if (match) return match.id;
    }
    return actionableAccounts[0]?.id ?? '';
  }, [actionableAccounts, selectedDeviceIds]);

  const resolvedTargetDeviceId = useMemo(() => {
    if (targetDeviceId && actionableAccounts.some((a) => a.id === targetDeviceId)) {
      return targetDeviceId;
    }
    return defaultTargetDeviceId;
  }, [actionableAccounts, defaultTargetDeviceId, targetDeviceId]);

  const selectedItem = useMemo<UnifiedDirectoryItem | null>(() => {
    if (!selectedKey) return null;
    return items.find((entry) => directoryItemKey(entry) === selectedKey) ?? null;
  }, [items, selectedKey]);

  const createMutation = useMutation({
    mutationFn: () =>
      createGroup(resolvedTargetDeviceId, {
        title: newTitle.trim(),
        participants: parseParticipantsList(newParticipants),
      }),
    onSuccess: (res) => {
      toast.success(t.groups.createdToast);
      setCreateOpen(false);
      setNewTitle('');
      setNewParticipants('');
      if (res?.group_id && resolvedTargetDeviceId) {
        setSelectedKey(`group::${resolvedTargetDeviceId}::${res.group_id}`);
        setMobileShowDetail(true);
      }
      void queryClient.invalidateQueries({queryKey: ['unified-groups']});
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const joinMutation = useMutation({
    mutationFn: () => joinGroupWithLink(resolvedTargetDeviceId, joinLink.trim()),
    onSuccess: (res) => {
      toast.success(t.groups.joinedToast);
      setJoinOpen(false);
      setJoinLink('');
      if (res?.group_id && resolvedTargetDeviceId) {
        setSelectedKey(`group::${resolvedTargetDeviceId}::${res.group_id}`);
        setMobileShowDetail(true);
      }
      void queryClient.invalidateQueries({queryKey: ['unified-groups']});
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const previewMutation = useMutation({
    mutationFn: () => getGroupInfoFromLink(resolvedTargetDeviceId, previewLink.trim()),
    onSuccess: (res) => {
      setPreviewInfo(res);
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const apiErr = query.isError ? toApiError(query.error) : null;

  if (apiErr && isGowaConnectionError(apiErr)) {
    return (
      <GowaSetupNotice
        apiErr={apiErr}
        isAdmin={canViewSettings}
        onRetry={() => void query.refetch()}
      />
    );
  }

  const renderTargetAccountSelect = (selectId: string) => {
    if (actionableAccounts.length <= 1) return null;
    return (
      <div>
        <Label htmlFor={selectId}>{t.groups.targetAccountLabel}</Label>
        <select
          id={selectId}
          value={resolvedTargetDeviceId}
          onChange={(e) => setTargetDeviceId(e.target.value)}
          className="mt-1.5 h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          {actionableAccounts.map((acc) => (
            <option key={acc.id} value={acc.id}>
              {acc.display_name}
            </option>
          ))}
        </select>
      </div>
    );
  };

  return (
    <>
      <SplitWorkspace
        storageKey={SIDEBAR_STORAGE_KEY}
        showDetailOnMobile={Boolean(mobileShowDetail && selectedItem)}
        sidebar={
          <GroupsSidebar
            items={items}
            groupsCount={groupsCount}
            newslettersCount={newslettersCount}
            accounts={accounts}
            selectedKey={selectedKey}
            selectedDeviceIds={selectedDeviceIds}
            kindFilter={kindFilter}
            search={search}
            isLoading={query.isLoading}
            isFetching={query.isFetching}
            errorMessage={apiErr ? apiErr.message : null}
            canAct={actionableAccounts.length > 0}
            canCreateOrJoin={canWriteGroups && actionableAccounts.length > 0}
            onSelectedDeviceIdsChange={setSelectedDeviceIds}
            onKindFilterChange={setKindFilter}
            onSearchChange={setSearch}
            onRefresh={() => void query.refetch()}
            onSelect={(item) => {
              setSelectedKey(directoryItemKey(item));
              setMobileShowDetail(true);
            }}
            onOpenCreate={() => {
              setTargetDeviceId(defaultTargetDeviceId);
              setCreateOpen(true);
            }}
            onOpenJoin={() => {
              setTargetDeviceId(defaultTargetDeviceId);
              setJoinLink('');
              setJoinOpen(true);
            }}
            onOpenPreview={() => {
              setTargetDeviceId(defaultTargetDeviceId);
              setPreviewInfo(null);
              setPreviewLink('');
              setPreviewOpen(true);
            }}
          />
        }
        detail={
          selectedItem ? (
            selectedItem.kind === 'group' ? (
              <GroupWorkspacePanel
                key={directoryItemKey(selectedItem)}
                item={selectedItem}
                onBack={() => setMobileShowDetail(false)}
                onChanged={() => void queryClient.invalidateQueries({queryKey: ['unified-groups']})}
              />
            ) : (
              <NewsletterWorkspacePanel
                key={directoryItemKey(selectedItem)}
                item={selectedItem}
                onBack={() => setMobileShowDetail(false)}
                onChanged={() => void queryClient.invalidateQueries({queryKey: ['unified-groups']})}
              />
            )
          ) : null
        }
        emptyState={
          <WorkspaceEmptyState
            icon={UsersRound}
            title={t.groups.selectItemPrompt}
            hint={t.groups.selectItemHint}
          />
        }
      />

      {/* Create Group Dialog */}
      <Dialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        title={t.groups.createTitle}
        description={t.groups.createDesc}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!resolvedTargetDeviceId) return;
            createMutation.mutate();
          }}
          className="space-y-4"
        >
          {renderTargetAccountSelect('create-group-account')}
          <div>
            <Label htmlFor="create-group-title">{t.groups.titleLabel}</Label>
            <Input
              id="create-group-title"
              className="mt-1.5"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder={t.groups.titlePlaceholder}
              required
            />
          </div>
          <div>
            <Label htmlFor="create-group-members">{t.groups.participantsLabel}</Label>
            <textarea
              id="create-group-members"
              rows={3}
              dir="ltr"
              value={newParticipants}
              onChange={(e) => setNewParticipants(e.target.value)}
              placeholder={t.groups.participantsPlaceholder}
              className="mt-1.5 w-full rounded-lg border border-input bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
              {t.cancel}
            </Button>
            <Button
              type="submit"
              disabled={createMutation.isPending || !newTitle.trim() || !resolvedTargetDeviceId}
            >
              {t.groups.createGroup}
            </Button>
          </div>
        </form>
      </Dialog>

      {/* Join With Link Dialog */}
      <Dialog open={joinOpen} onOpenChange={setJoinOpen} title={t.groups.joinTitle}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!resolvedTargetDeviceId) return;
            joinMutation.mutate();
          }}
          className="space-y-4"
        >
          {renderTargetAccountSelect('join-group-account')}
          <div>
            <Label htmlFor="join-link-input">{t.groups.inviteLinkLabel}</Label>
            <Input
              id="join-link-input"
              dir="ltr"
              className="mt-1.5"
              value={joinLink}
              onChange={(e) => setJoinLink(e.target.value)}
              placeholder={t.groups.inviteLinkPlaceholder}
              required
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setJoinOpen(false)}>
              {t.cancel}
            </Button>
            <Button
              type="submit"
              disabled={joinMutation.isPending || !joinLink.trim() || !resolvedTargetDeviceId}
            >
              {t.groups.joinWithLink}
            </Button>
          </div>
        </form>
      </Dialog>

      {/* Preview Link Dialog */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen} title={t.groups.previewTitle}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!resolvedTargetDeviceId) return;
            previewMutation.mutate();
          }}
          className="space-y-4"
        >
          {renderTargetAccountSelect('preview-group-account')}
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <Label htmlFor="preview-link-input">{t.groups.inviteLinkLabel}</Label>
              <Input
                id="preview-link-input"
                dir="ltr"
                className="mt-1.5"
                value={previewLink}
                onChange={(e) => setPreviewLink(e.target.value)}
                placeholder={t.groups.inviteLinkPlaceholder}
                required
              />
            </div>
            <Button
              type="submit"
              disabled={previewMutation.isPending || !previewLink.trim() || !resolvedTargetDeviceId}
            >
              {t.groups.previewSubmit}
            </Button>
          </div>
        </form>

        {previewInfo && (
          <dl className="mt-4 divide-y divide-border rounded-lg border border-border text-xs">
            <div className="flex items-center justify-between gap-4 px-3.5 py-2.5">
              <dt className="text-muted-foreground">{t.groups.titleLabel}</dt>
              <dd className="font-semibold text-foreground">{previewInfo.name}</dd>
            </div>
            <div className="flex items-center justify-between gap-4 px-3.5 py-2.5">
              <dt className="text-muted-foreground">{t.groups.groupIdLabel}</dt>
              <dd className="font-mono text-foreground" dir="ltr">
                {previewInfo.group_id}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-4 px-3.5 py-2.5">
              <dt className="text-muted-foreground">
                {t.groups.membersCount(previewInfo.participant_count)}
              </dt>
              <dd className="tabular-nums text-foreground">{previewInfo.participant_count}</dd>
            </div>
            {(previewInfo.topic || previewInfo.description) && (
              <div className="px-3.5 py-2.5">
                <dt className="text-muted-foreground">{t.groups.topicLabel}</dt>
                <dd className="mt-1 text-foreground">
                  {previewInfo.topic || previewInfo.description}
                </dd>
              </div>
            )}
          </dl>
        )}
      </Dialog>
    </>
  );
}
