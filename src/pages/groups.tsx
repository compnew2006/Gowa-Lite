import {useMemo, useState} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {
  AlertCircle,
  Eye,
  Link2,
  Lock,
  Megaphone,
  Plus,
  Search,
  UsersRound,
} from 'lucide-react';
import {toast} from 'sonner';
import {
  createGroup,
  getGroupInfoFromLink,
  joinGroupWithLink,
  listGroups,
} from '@/api/client';
import type {GroupInfoFromLink, MyGroup} from '@/api/types';
import {ContactAvatar} from '@/components/contact-avatar';
import {DeviceSelectorBar, useActiveDevice} from '@/components/device-selector-bar';
import {Button} from '@/components/ui/button';
import {Dialog} from '@/components/ui/dialog';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {Skeleton} from '@/components/ui/skeleton';
import {GroupDetailDialog} from '@/features/groups/group-detail-dialog';
import {useI18n} from '@/lib/i18n';
import {toApiError} from '@/lib/http';
import {matchesNormalizedQuery} from '@/lib/phone';

function parseParticipants(raw: string): string[] {
  return raw
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export default function GroupsPage() {
  const {t} = useI18n();
  const queryClient = useQueryClient();
  const deviceState = useActiveDevice();
  const deviceId = deviceState.selectedDeviceId;

  const [search, setSearch] = useState('');
  const [selectedGroup, setSelectedGroup] = useState<MyGroup | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newParticipants, setNewParticipants] = useState('');

  const [joinOpen, setJoinOpen] = useState(false);
  const [joinLink, setJoinLink] = useState('');

  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLink, setPreviewLink] = useState('');
  const [previewInfo, setPreviewInfo] = useState<GroupInfoFromLink | null>(null);

  const groupsQuery = useQuery({
    queryKey: ['groups', deviceId],
    queryFn: () => listGroups(deviceId),
    enabled: Boolean(deviceId),
    retry: 1,
  });

  const createMutation = useMutation({
    mutationFn: () =>
      createGroup(deviceId, {
        title: newTitle.trim(),
        participants: parseParticipants(newParticipants),
      }),
    onSuccess: () => {
      toast.success(t.groups.createdToast);
      setCreateOpen(false);
      setNewTitle('');
      setNewParticipants('');
      void queryClient.invalidateQueries({queryKey: ['groups', deviceId]});
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const joinMutation = useMutation({
    mutationFn: () => joinGroupWithLink(deviceId, joinLink.trim()),
    onSuccess: () => {
      toast.success(t.groups.joinedToast);
      setJoinOpen(false);
      setJoinLink('');
      void queryClient.invalidateQueries({queryKey: ['groups', deviceId]});
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const previewMutation = useMutation({
    mutationFn: () => getGroupInfoFromLink(deviceId, previewLink.trim()),
    onSuccess: (res) => {
      setPreviewInfo(res);
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const allGroups = groupsQuery.data ?? [];
  const filteredGroups = useMemo(() => {
    if (!search.trim()) return allGroups;
    return allGroups.filter((g) => matchesNormalizedQuery([g.Name, g.JID, g.Topic], search));
  }, [allGroups, search]);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-foreground">{t.groups.pageTitle}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t.groups.pageSubtitle}</p>
        </div>

        {deviceId && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setPreviewInfo(null);
                setPreviewLink('');
                setPreviewOpen(true);
              }}
            >
              <Eye className="size-3.5" />
              <span>{t.groups.previewLink}</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setJoinLink('');
                setJoinOpen(true);
              }}
            >
              <Link2 className="size-3.5" />
              <span>{t.groups.joinWithLink}</span>
            </Button>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="size-3.5" />
              <span>{t.groups.createGroup}</span>
            </Button>
          </div>
        )}
      </div>

      <DeviceSelectorBar
        devices={deviceState.devices}
        selectedDevice={deviceState.selectedDevice}
        selectedDeviceId={deviceId}
        onSelectDevice={(id) => {
          setSelectedGroup(null);
          deviceState.setSelectedDeviceId(id);
        }}
        isLoading={deviceState.isLoading}
        isFetching={groupsQuery.isFetching}
        error={deviceState.error}
        onRefresh={() => {
          void deviceState.refetch();
          if (deviceId) void groupsQuery.refetch();
        }}
      />

      {deviceId && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="relative w-full max-w-sm">
              <Search className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t.groups.searchPlaceholder}
                className="ps-8 text-sm"
              />
            </div>
            <span className="text-xs tabular-nums text-muted-foreground">
              {filteredGroups.length} / {allGroups.length}
            </span>
          </div>

          {groupsQuery.isLoading ? (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-36 rounded-xl" />
              ))}
            </div>
          ) : groupsQuery.error ? (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
              <div className="flex items-center gap-2">
                <AlertCircle className="size-4 shrink-0" />
                <span>{toApiError(groupsQuery.error).message}</span>
              </div>
              <Button variant="outline" size="sm" onClick={() => void groupsQuery.refetch()}>
                {t.retry}
              </Button>
            </div>
          ) : allGroups.length === 0 ? (
            <div className="rounded-xl border border-border bg-card p-10 text-center">
              <UsersRound className="mx-auto size-8 text-muted-foreground" />
              <p className="mt-2 text-sm text-muted-foreground">{t.groups.empty}</p>
            </div>
          ) : filteredGroups.length === 0 ? (
            <div className="rounded-xl border border-border bg-card p-10 text-center">
              <p className="text-sm text-muted-foreground">{t.groups.noSearchMatches}</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              {filteredGroups.map((group) => {
                const count = group.ParticipantCount ?? group.Participants?.length ?? 0;
                return (
                  <button
                    key={group.JID}
                    type="button"
                    onClick={() => setSelectedGroup(group)}
                    className="flex flex-col justify-between rounded-xl border border-border bg-card p-4 text-start transition-colors hover:border-primary/40 hover:bg-muted/20 cursor-pointer"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-3">
                        <ContactAvatar
                          deviceId={deviceId}
                          jid={group.JID}
                          name={group.Name || group.JID}
                          sizeClass="size-10"
                        />
                        <div className="min-w-0 flex-1">
                          <h3 className="truncate text-sm font-semibold text-foreground">
                            {group.Name || group.JID}
                          </h3>
                          <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground" dir="ltr">
                            {group.JID}
                          </p>
                        </div>
                      </div>
                      {group.Topic && (
                        <p className="mt-2.5 line-clamp-2 text-xs text-muted-foreground">
                          {group.Topic}
                        </p>
                      )}
                    </div>

                    <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
                      <span className="tabular-nums font-medium text-foreground">
                        {t.groups.membersCount(count)}
                      </span>
                      {group.IsLocked && (
                        <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                          · <Lock className="size-3" /> {t.groups.lockedLabel}
                        </span>
                      )}
                      {group.IsAnnounce && (
                        <span className="inline-flex items-center gap-1 text-sky-600 dark:text-sky-400">
                          · <Megaphone className="size-3" /> {t.groups.announceLabel}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* Group Detail Modal */}
      <GroupDetailDialog
        deviceId={deviceId}
        group={selectedGroup}
        onClose={() => setSelectedGroup(null)}
        onChanged={() => void queryClient.invalidateQueries({queryKey: ['groups', deviceId]})}
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
            createMutation.mutate();
          }}
          className="space-y-4"
        >
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
            <Button type="submit" disabled={createMutation.isPending || !newTitle.trim()}>
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
            joinMutation.mutate();
          }}
          className="space-y-4"
        >
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
            <Button type="submit" disabled={joinMutation.isPending || !joinLink.trim()}>
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
            previewMutation.mutate();
          }}
          className="space-y-4"
        >
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
            <Button type="submit" disabled={previewMutation.isPending || !previewLink.trim()}>
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
              <dt className="text-muted-foreground">{t.groups.membersCount(previewInfo.participant_count)}</dt>
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
    </div>
  );
}
