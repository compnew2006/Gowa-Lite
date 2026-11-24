import {useEffect, useRef, useState} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {
  Camera,
  Check,
  Copy,
  Download,
  Link2,
  LogOut,
  RefreshCw,
  ShieldCheck,
  ShieldMinus,
  Trash2,
  UserCheck,
  UserPlus,
  UserX,
} from 'lucide-react';
import {toast} from 'sonner';
import {
  actOnGroupParticipants,
  decideGroupParticipantRequests,
  exportGroupParticipantsCsv,
  getGroupInfo,
  getGroupInviteLink,
  leaveGroup,
  listGroupParticipantRequests,
  listGroupParticipants,
  setGroupAnnounce,
  setGroupLocked,
  setGroupName,
  setGroupPhoto,
  setGroupTopic,
  fileToImageUpload,
} from '@/api/client';
import type {MyGroup} from '@/api/types';
import {ContactAvatar} from '@/components/contact-avatar';
import {Button} from '@/components/ui/button';
import {Dialog} from '@/components/ui/dialog';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {Skeleton} from '@/components/ui/skeleton';
import {Switch} from '@/components/ui/switch';
import {useI18n} from '@/lib/i18n';
import {toApiError} from '@/lib/http';
import {cn} from '@/lib/utils';

function parseParticipantsInput(raw: string): string[] {
  return raw
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function GroupDetailDialog({
  deviceId,
  group,
  onClose,
  onChanged,
}: {
  deviceId: string;
  group: MyGroup | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const {t} = useI18n();
  const queryClient = useQueryClient();
  const groupId = group?.JID ?? '';

  const [tab, setTab] = useState<'overview' | 'participants' | 'settings'>('overview');
  const [inviteLink, setInviteLink] = useState<string>('');
  const [copiedLink, setCopiedLink] = useState(false);
  const [leaveConfirmOpen, setLeaveConfirmOpen] = useState(false);

  const [addParticipantsRaw, setAddParticipantsRaw] = useState('');
  const [nameInput, setNameInput] = useState('');
  const [topicInput, setTopicInput] = useState('');
  const photoInputRef = useRef<HTMLInputElement | null>(null);

  const infoQuery = useQuery({
    queryKey: ['group-info', deviceId, groupId],
    queryFn: () => getGroupInfo(deviceId, groupId),
    enabled: Boolean(deviceId && groupId),
    retry: 1,
  });

  const activeGroup = infoQuery.data ?? group;

  useEffect(() => {
    setTab('overview');
    setInviteLink('');
    setCopiedLink(false);
    setAddParticipantsRaw('');
    setLeaveConfirmOpen(false);
  }, [groupId]);

  useEffect(() => {
    if (activeGroup) {
      setNameInput(activeGroup.Name || '');
      setTopicInput(activeGroup.Topic || '');
    }
  }, [activeGroup]);

  const participantsQuery = useQuery({
    queryKey: ['group-participants', deviceId, groupId],
    queryFn: () => listGroupParticipants(deviceId, groupId),
    enabled: Boolean(deviceId && groupId && tab === 'participants'),
    retry: 1,
  });

  const requestsQuery = useQuery({
    queryKey: ['group-requests', deviceId, groupId],
    queryFn: () => listGroupParticipantRequests(deviceId, groupId),
    enabled: Boolean(deviceId && groupId && tab === 'participants'),
    retry: false,
  });

  const inviteLinkMutation = useMutation({
    mutationFn: (reset: boolean) => getGroupInviteLink(deviceId, groupId, reset),
    onSuccess: (res, reset) => {
      setInviteLink(res.invite_link || '');
      if (reset) toast.success(t.groups.inviteLinkResetToast);
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const leaveMutation = useMutation({
    mutationFn: () => leaveGroup(deviceId, groupId),
    onSuccess: () => {
      toast.success(t.groups.leftToast);
      setLeaveConfirmOpen(false);
      onChanged();
      onClose();
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const participantActionMutation = useMutation({
    mutationFn: ({
      action,
      participants,
    }: {
      action: 'add' | 'remove' | 'promote' | 'demote';
      participants: string[];
    }) => actOnGroupParticipants(deviceId, action, {group_id: groupId, participants}),
    onSuccess: (_res, vars) => {
      if (vars.action === 'add') {
        toast.success(t.groups.participantsAddedToast);
        setAddParticipantsRaw('');
      } else if (vars.action === 'promote') {
        toast.success(t.groups.promotedToast);
      } else if (vars.action === 'demote') {
        toast.success(t.groups.demotedToast);
      } else {
        toast.success(t.groups.removedToast);
      }
      void queryClient.invalidateQueries({queryKey: ['group-participants', deviceId, groupId]});
      void queryClient.invalidateQueries({queryKey: ['group-info', deviceId, groupId]});
      onChanged();
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const decideRequestMutation = useMutation({
    mutationFn: ({decision, jid}: {decision: 'approve' | 'reject'; jid: string}) =>
      decideGroupParticipantRequests(deviceId, decision, {group_id: groupId, participants: [jid]}),
    onSuccess: (_res, vars) => {
      toast.success(
        vars.decision === 'approve' ? t.groups.requestApprovedToast : t.groups.requestRejectedToast,
      );
      void queryClient.invalidateQueries({queryKey: ['group-requests', deviceId, groupId]});
      void queryClient.invalidateQueries({queryKey: ['group-participants', deviceId, groupId]});
      onChanged();
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const exportCsvMutation = useMutation({
    mutationFn: () => exportGroupParticipantsCsv(deviceId, groupId),
    onSuccess: (blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `participants-${groupId.replace(/[^a-zA-Z0-9_-]/g, '_')}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success(t.groups.exportedToast);
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const nameMutation = useMutation({
    mutationFn: () => setGroupName(deviceId, groupId, nameInput.trim()),
    onSuccess: () => {
      toast.success(t.groups.nameUpdatedToast);
      void queryClient.invalidateQueries({queryKey: ['group-info', deviceId, groupId]});
      onChanged();
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const topicMutation = useMutation({
    mutationFn: () => setGroupTopic(deviceId, groupId, topicInput),
    onSuccess: () => {
      toast.success(t.groups.topicUpdatedToast);
      void queryClient.invalidateQueries({queryKey: ['group-info', deviceId, groupId]});
      onChanged();
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const photoMutation = useMutation({
    mutationFn: async (file?: File) => {
      if (file) {
        const upload = await fileToImageUpload(file);
        await setGroupPhoto(deviceId, groupId, upload);
      } else {
        await setGroupPhoto(deviceId, groupId);
      }
    },
    onSuccess: () => {
      toast.success(t.groups.photoUpdatedToast);
      void queryClient.invalidateQueries({queryKey: ['contact-avatar', deviceId, groupId]});
      onChanged();
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const lockedMutation = useMutation({
    mutationFn: (locked: boolean) => setGroupLocked(deviceId, groupId, locked),
    onSuccess: () => {
      toast.success(t.groups.settingUpdatedToast);
      void queryClient.invalidateQueries({queryKey: ['group-info', deviceId, groupId]});
      onChanged();
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const announceMutation = useMutation({
    mutationFn: (announce: boolean) => setGroupAnnounce(deviceId, groupId, announce),
    onSuccess: () => {
      toast.success(t.groups.settingUpdatedToast);
      void queryClient.invalidateQueries({queryKey: ['group-info', deviceId, groupId]});
      onChanged();
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const handleCopyInviteLink = async () => {
    if (!inviteLink) return;
    try {
      await navigator.clipboard.writeText(inviteLink);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 1800);
    } catch {
      // ignore clipboard errors
    }
  };

  if (!group) return null;

  const participantList = participantsQuery.data?.participants ?? [];
  const memberCount =
    participantList.length ||
    activeGroup?.ParticipantCount ||
    activeGroup?.Participants?.length ||
    0;

  return (
    <>
      <Dialog
        open={Boolean(group)}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        title={activeGroup?.Name || group.JID}
        description={t.groups.membersCount(memberCount)}
        className="max-w-2xl max-h-[88vh] overflow-y-auto"
      >
        {/* Tabs */}
        <div className="mb-4 flex flex-wrap gap-1.5 border-b border-border pb-3">
          {(
            [
              {id: 'overview', label: t.groups.tabOverview},
              {id: 'participants', label: t.groups.tabParticipants},
              {id: 'settings', label: t.groups.tabSettings},
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
              className={cn(
                'h-8 rounded-lg px-3 text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer transition-colors',
                tab === item.id
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>

        {tab === 'overview' && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/20 p-3">
              <ContactAvatar
                deviceId={deviceId}
                jid={groupId}
                name={activeGroup?.Name || groupId}
                sizeClass="size-12"
                textClass="text-base"
                eager
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-foreground">
                  {activeGroup?.Name || groupId}
                </p>
                <p className="truncate font-mono text-[11px] text-muted-foreground" dir="ltr">
                  {activeGroup?.JID}
                </p>
              </div>
            </div>

            <dl className="divide-y divide-border rounded-lg border border-border text-xs">
              <div className="flex items-center justify-between gap-4 px-3.5 py-2.5">
                <dt className="text-muted-foreground">{t.groups.groupIdLabel}</dt>
                <dd className="truncate font-mono text-foreground" dir="ltr">
                  {activeGroup?.JID}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-4 px-3.5 py-2.5">
                <dt className="text-muted-foreground">{t.groups.ownerLabel}</dt>
                <dd className="truncate font-mono text-foreground" dir="ltr">
                  {activeGroup?.OwnerJID || '—'}
                </dd>
              </div>
              {activeGroup?.Topic && (
                <div className="px-3.5 py-2.5">
                  <dt className="text-muted-foreground">{t.groups.topicLabel}</dt>
                  <dd className="mt-1 whitespace-pre-wrap text-foreground">{activeGroup.Topic}</dd>
                </div>
              )}
            </dl>

            <div className="space-y-2.5 rounded-lg border border-border p-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold text-foreground">
                  {t.groups.inviteLinkSection}
                </span>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={inviteLinkMutation.isPending}
                    onClick={() => inviteLinkMutation.mutate(false)}
                  >
                    <Link2 className="size-3.5" />
                    <span>{t.groups.loadInviteLink}</span>
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={inviteLinkMutation.isPending}
                    onClick={() => inviteLinkMutation.mutate(true)}
                  >
                    <RefreshCw className="size-3.5" />
                    <span>{t.groups.resetInviteLink}</span>
                  </Button>
                </div>
              </div>

              {inviteLink && (
                <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground" dir="ltr">
                    {inviteLink}
                  </span>
                  <Button variant="ghost" size="sm" onClick={handleCopyInviteLink}>
                    {copiedLink ? <Check className="size-3.5 text-live" /> : <Copy className="size-3.5" />}
                    <span>{copiedLink ? t.groups.copiedLink : t.groups.copyLink}</span>
                  </Button>
                </div>
              )}
            </div>

            <div className="flex justify-end border-t border-border pt-3">
              <Button variant="destructive" size="sm" onClick={() => setLeaveConfirmOpen(true)}>
                <LogOut className="size-3.5" />
                <span>{t.groups.leaveGroup}</span>
              </Button>
            </div>
          </div>
        )}

        {tab === 'participants' && (
          <div className="space-y-4">
            {/* Add Members */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const parsed = parseParticipantsInput(addParticipantsRaw);
                if (parsed.length === 0) return;
                participantActionMutation.mutate({action: 'add', participants: parsed});
              }}
              className="space-y-2 rounded-lg border border-border p-3"
            >
              <Label htmlFor="add-members-input">{t.groups.addParticipantsTitle}</Label>
              <div className="flex flex-wrap items-start gap-2">
                <textarea
                  id="add-members-input"
                  rows={2}
                  dir="ltr"
                  value={addParticipantsRaw}
                  onChange={(e) => setAddParticipantsRaw(e.target.value)}
                  placeholder={t.groups.addParticipantsPlaceholder}
                  className="min-w-[200px] flex-1 rounded-lg border border-input bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
                />
                <Button
                  type="submit"
                  size="sm"
                  disabled={
                    participantActionMutation.isPending ||
                    parseParticipantsInput(addParticipantsRaw).length === 0
                  }
                >
                  <UserPlus className="size-3.5" />
                  <span>{t.groups.addParticipantsBtn}</span>
                </Button>
              </div>
            </form>

            {/* Participants List */}
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold text-foreground">
                  {t.groups.membersCount(participantList.length)}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={exportCsvMutation.isPending}
                  onClick={() => exportCsvMutation.mutate()}
                >
                  <Download className="size-3.5" />
                  <span>{t.groups.exportCsv}</span>
                </Button>
              </div>

              {participantsQuery.isLoading ? (
                <div className="space-y-2">
                  {[0, 1, 2].map((i) => (
                    <Skeleton key={i} className="h-11 w-full" />
                  ))}
                </div>
              ) : participantsQuery.error ? (
                <p className="text-xs text-destructive">
                  {toApiError(participantsQuery.error).message}
                </p>
              ) : (
                <div className="max-h-64 divide-y divide-border overflow-y-auto rounded-lg border border-border">
                  {participantList.map((member) => {
                    const roleText = member.is_super_admin
                      ? t.groups.roleSuperAdmin
                      : member.is_admin
                        ? t.groups.roleAdmin
                        : t.groups.roleMember;
                    return (
                      <div
                        key={member.jid}
                        className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs"
                      >
                        <div className="flex min-w-0 items-center gap-2.5">
                          <ContactAvatar
                            deviceId={deviceId}
                            jid={member.jid}
                            name={member.display_name || member.phone_number || member.jid}
                            sizeClass="size-8"
                            textClass="text-xs"
                          />
                          <div className="min-w-0">
                            <p className="truncate font-medium text-foreground">
                              {member.display_name || member.phone_number || member.jid}
                            </p>
                            <p className="truncate font-mono text-[11px] text-muted-foreground" dir="ltr">
                              {member.jid} · {roleText}
                            </p>
                          </div>
                        </div>
                        {!member.is_super_admin && (
                          <div className="flex items-center gap-1">
                            {member.is_admin ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={participantActionMutation.isPending}
                                onClick={() =>
                                  participantActionMutation.mutate({
                                    action: 'demote',
                                    participants: [member.jid],
                                  })
                                }
                                title={t.groups.demote}
                              >
                                <ShieldMinus className="size-3.5" />
                                <span className="hidden sm:inline">{t.groups.demote}</span>
                              </Button>
                            ) : (
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={participantActionMutation.isPending}
                                onClick={() =>
                                  participantActionMutation.mutate({
                                    action: 'promote',
                                    participants: [member.jid],
                                  })
                                }
                                title={t.groups.promote}
                              >
                                <ShieldCheck className="size-3.5" />
                                <span className="hidden sm:inline">{t.groups.promote}</span>
                              </Button>
                            )}
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                              disabled={participantActionMutation.isPending}
                              onClick={() =>
                                participantActionMutation.mutate({
                                  action: 'remove',
                                  participants: [member.jid],
                                })
                              }
                              title={t.groups.removeMember}
                            >
                              <Trash2 className="size-3.5" />
                            </Button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Join Requests */}
            <div className="space-y-2 border-t border-border pt-3">
              <p className="text-xs font-semibold text-foreground">{t.groups.joinRequestsTitle}</p>
              {requestsQuery.isLoading ? (
                <Skeleton className="h-10 w-full" />
              ) : requestsQuery.error ? (
                <p className="text-xs text-muted-foreground">
                  {toApiError(requestsQuery.error).message}
                </p>
              ) : (requestsQuery.data ?? []).length === 0 ? (
                <p className="text-xs text-muted-foreground">{t.groups.noJoinRequests}</p>
              ) : (
                <div className="divide-y divide-border rounded-lg border border-border">
                  {(requestsQuery.data ?? []).map((req) => (
                    <div
                      key={req.jid}
                      className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-medium text-foreground">
                          {req.display_name || req.phone_number || req.jid}
                        </p>
                        <p className="font-mono text-[11px] text-muted-foreground" dir="ltr">
                          {req.jid}
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={decideRequestMutation.isPending}
                          onClick={() =>
                            decideRequestMutation.mutate({decision: 'approve', jid: req.jid})
                          }
                        >
                          <UserCheck className="size-3.5" />
                          <span>{t.groups.approve}</span>
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                          disabled={decideRequestMutation.isPending}
                          onClick={() =>
                            decideRequestMutation.mutate({decision: 'reject', jid: req.jid})
                          }
                        >
                          <UserX className="size-3.5" />
                          <span>{t.groups.reject}</span>
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {tab === 'settings' && (
          <div className="space-y-4">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!nameInput.trim()) return;
                nameMutation.mutate();
              }}
            >
              <Label htmlFor="group-name-edit">{t.groups.renameGroupLabel}</Label>
              <div className="mt-1.5 flex items-center gap-2">
                <Input
                  id="group-name-edit"
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  required
                />
                <Button type="submit" disabled={nameMutation.isPending || !nameInput.trim()}>
                  {t.groups.saveName}
                </Button>
              </div>
            </form>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                topicMutation.mutate();
              }}
            >
              <Label htmlFor="group-topic-edit">{t.groups.topicLabel}</Label>
              <textarea
                id="group-topic-edit"
                rows={3}
                value={topicInput}
                onChange={(e) => setTopicInput(e.target.value)}
                placeholder={t.groups.topicPlaceholder}
                className="mt-1.5 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
              />
              <div className="mt-2 flex justify-end">
                <Button type="submit" size="sm" disabled={topicMutation.isPending}>
                  {t.groups.saveTopic}
                </Button>
              </div>
            </form>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
              <span className="text-sm font-medium text-foreground">{t.groups.photoLabel}</span>
              <div className="flex items-center gap-2">
                <input
                  ref={photoInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (file) photoMutation.mutate(file);
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={photoMutation.isPending}
                  onClick={() => photoInputRef.current?.click()}
                >
                  <Camera className="size-3.5" />
                  <span>{t.groups.uploadPhoto}</span>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={photoMutation.isPending}
                  onClick={() => photoMutation.mutate(undefined)}
                >
                  {t.groups.removePhoto}
                </Button>
              </div>
            </div>

            <div className="space-y-3 border-t border-border pt-3">
              <div className="flex items-center justify-between gap-4">
                <Label htmlFor="group-locked-switch" className="cursor-pointer">
                  {t.groups.lockedSettingLabel}
                </Label>
                <Switch
                  id="group-locked-switch"
                  checked={Boolean(activeGroup?.IsLocked)}
                  disabled={lockedMutation.isPending}
                  onCheckedChange={(checked) => lockedMutation.mutate(checked)}
                />
              </div>
              <div className="flex items-center justify-between gap-4">
                <Label htmlFor="group-announce-switch" className="cursor-pointer">
                  {t.groups.announceSettingLabel}
                </Label>
                <Switch
                  id="group-announce-switch"
                  checked={Boolean(activeGroup?.IsAnnounce)}
                  disabled={announceMutation.isPending}
                  onCheckedChange={(checked) => announceMutation.mutate(checked)}
                />
              </div>
            </div>
          </div>
        )}
      </Dialog>

      <Dialog
        open={leaveConfirmOpen}
        onOpenChange={setLeaveConfirmOpen}
        title={t.groups.leaveConfirmTitle}
        description={t.groups.leaveConfirmDesc(activeGroup?.Name || group.JID)}
      >
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={() => setLeaveConfirmOpen(false)}>
            {t.cancel}
          </Button>
          <Button
            variant="destructive"
            disabled={leaveMutation.isPending}
            onClick={() => leaveMutation.mutate()}
          >
            {t.groups.leaveGroup}
          </Button>
        </div>
      </Dialog>
    </>
  );
}
