import {useEffect, useMemo, useRef, useState} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  Copy,
  Download,
  Link2,
  Lock,
  LogOut,
  Megaphone,
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
  fileToImageUpload,
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
} from '@/api/client';
import type {UnifiedChat, UnifiedGroupItem} from '@/api/types';
import {ContactAvatar} from '@/components/contact-avatar';
import {Button} from '@/components/ui/button';
import {Dialog} from '@/components/ui/dialog';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {Skeleton} from '@/components/ui/skeleton';
import {Switch} from '@/components/ui/switch';
import {accountDotTone, shortAccountWidgetLabel} from '@/features/chat/chat-list';
import {MessageView} from '@/features/chat/message-view';
import {copyTextWithFallback} from '@/lib/clipboard';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';
import {parseParticipantsList} from '@/lib/participants';
import {cn} from '@/lib/utils';
import {hasUserPermission, useAuthStore} from '@/stores/auth';

export function GroupWorkspacePanel({
  item,
  onBack,
  onChanged,
}: {
  item: UnifiedGroupItem;
  onBack: () => void;
  onChanged: () => void;
}) {
  const {lang, t} = useI18n();
  const isRtl = lang === 'ar';
  const BackIcon = isRtl ? ArrowRight : ArrowLeft;
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const canManageGroups = hasUserPermission(user, 'groups:manage');
  const deviceId = item.device_id;
  const groupId = item.jid;

  const [tab, setTab] = useState<'messages' | 'overview' | 'participants' | 'settings'>('messages');
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

  const activeGroup = infoQuery.data ?? item.group;

  const groupAsChat = useMemo<UnifiedChat>(
    () => ({
      jid: groupId,
      name: activeGroup.Name || item.name || groupId,
      last_message_time: activeGroup.GroupCreated || '',
      ephemeral_expiration: activeGroup.IsEphemeral ? 1 : 0,
      created_at: activeGroup.GroupCreated || '',
      updated_at: activeGroup.GroupCreated || '',
      archived: false,
      device_id: deviceId,
      device_display_name: item.device_display_name,
      device_state: item.device_state,
      unread_count: item.unread_count,
    }),
    [
      activeGroup.GroupCreated,
      activeGroup.IsEphemeral,
      activeGroup.Name,
      deviceId,
      groupId,
      item.device_display_name,
      item.device_state,
      item.name,
      item.unread_count,
    ],
  );

  useEffect(() => {
    setTab('messages');
    setInviteLink('');
    setCopiedLink(false);
    setAddParticipantsRaw('');
    setLeaveConfirmOpen(false);
  }, [deviceId, groupId]);

  useEffect(() => {
    setNameInput(activeGroup.Name || '');
    setTopicInput(activeGroup.Topic || '');
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
      onBack();
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
      window.setTimeout(() => URL.revokeObjectURL(url), 5_000);
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
    const ok = await copyTextWithFallback(inviteLink);
    if (ok) {
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 1800);
    } else {
      toast.error(t.chats.copyFailedToast);
    }
  };

  const participantList = participantsQuery.data?.participants ?? [];
  const memberCount = Math.max(
    participantList.length,
    activeGroup.ParticipantCount ?? 0,
    activeGroup.Participants?.length ?? 0,
    item.participant_count ?? 0,
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* Sticky Group Workspace Header matching MessageViewHeader */}
      <header className="flex h-[58px] shrink-0 items-center justify-between gap-3 border-b border-border bg-card px-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <button
            type="button"
            onClick={onBack}
            title={t.groups.backToDirectory}
            aria-label={t.groups.backToDirectory}
            className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground lg:hidden"
          >
            <BackIcon className="size-4" />
          </button>

          <ContactAvatar
            deviceId={deviceId}
            jid={groupId}
            name={activeGroup.Name || groupId}
            sizeClass="size-10"
            eager
          />

          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-foreground">
              {activeGroup.Name || groupId}
            </h2>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1 font-medium text-foreground/90">
                <span
                  aria-hidden="true"
                  className={cn('size-1.5 shrink-0 rounded-full', accountDotTone(deviceId))}
                />
                <span className="truncate">{shortAccountWidgetLabel(item.device_display_name)}</span>
              </span>
              <span aria-hidden="true">·</span>
              <span className="font-medium tabular-nums text-foreground">
                {t.groups.membersCount(memberCount)}
              </span>
              {activeGroup.IsLocked && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
                    <Lock className="size-3" /> {t.groups.lockedLabel}
                  </span>
                </>
              )}
              {activeGroup.IsAnnounce && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="inline-flex items-center gap-1 text-sky-600 dark:text-sky-400">
                    <Megaphone className="size-3" /> {t.groups.announceLabel}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        {canManageGroups && (
          <Button
            type="button"
            variant="destructive"
            size="sm"
            className="shrink-0 whitespace-nowrap"
            onClick={() => setLeaveConfirmOpen(true)}
          >
            <LogOut className="size-3.5" />
            <span className="hidden sm:inline">{t.groups.leaveGroup}</span>
          </Button>
        )}
      </header>

      {/* Tabs Bar */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border bg-card/60 px-4 py-2">
        {(
          [
            {id: 'messages' as const, label: t.groups.tabMessages},
            {id: 'overview' as const, label: t.groups.tabOverview},
            {id: 'participants' as const, label: `${t.groups.tabParticipants} (${memberCount})`},
            ...(canManageGroups ? [{id: 'settings' as const, label: t.groups.tabSettings}] : []),
          ]
        ).map((itemTab) => (
          <button
            key={itemTab.id}
            type="button"
            onClick={() => setTab(itemTab.id)}
            className={cn(
              'h-8 rounded-lg px-3 text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer transition-colors tabular-nums',
              tab === itemTab.id
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            {itemTab.label}
          </button>
        ))}
      </div>

      {/* Workspace Content */}
      {tab === 'messages' ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <MessageView
            key={`${deviceId}::${groupId}`}
            chat={groupAsChat}
            embeddedInGroup
          />
        </div>
      ) : (
      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        <div className="mx-auto max-w-3xl space-y-5">
          {tab === 'overview' && (
            <>
              <dl className="divide-y divide-border rounded-xl border border-border bg-card text-xs">
                <div className="flex items-center justify-between gap-4 px-4 py-3">
                  <dt className="text-muted-foreground">{t.groups.groupIdLabel}</dt>
                  <dd className="truncate font-mono text-foreground" dir="ltr">
                    {activeGroup.JID}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4 px-4 py-3">
                  <dt className="text-muted-foreground">{t.groups.ownerLabel}</dt>
                  <dd className="truncate font-mono text-foreground" dir="ltr">
                    {activeGroup.OwnerJID || '—'}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4 px-4 py-3">
                  <dt className="text-muted-foreground">{t.groups.tabParticipants}</dt>
                  <dd className="font-semibold tabular-nums text-foreground">
                    {t.groups.membersCount(memberCount)}
                  </dd>
                </div>
                {activeGroup.Topic && (
                  <div className="px-4 py-3">
                    <dt className="text-muted-foreground">{t.groups.topicLabel}</dt>
                    <dd className="mt-1.5 whitespace-pre-wrap text-foreground">
                      {activeGroup.Topic}
                    </dd>
                  </div>
                )}
              </dl>

              <div className="space-y-3 rounded-xl border border-border bg-card p-4">
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
                    {canManageGroups && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={inviteLinkMutation.isPending}
                        onClick={() => inviteLinkMutation.mutate(true)}
                      >
                        <RefreshCw className="size-3.5" />
                        <span>{t.groups.resetInviteLink}</span>
                      </Button>
                    )}
                  </div>
                </div>

                {inviteLink && (
                  <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-xs text-foreground"
                      dir="ltr"
                    >
                      {inviteLink}
                    </span>
                    <Button variant="ghost" size="sm" onClick={handleCopyInviteLink}>
                      {copiedLink ? (
                        <Check className="size-3.5 text-live" />
                      ) : (
                        <Copy className="size-3.5" />
                      )}
                      <span>{copiedLink ? t.groups.copiedLink : t.groups.copyLink}</span>
                    </Button>
                  </div>
                )}
              </div>
            </>
          )}

          {tab === 'participants' && (
            <>
              {canManageGroups && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const parsed = parseParticipantsList(addParticipantsRaw);
                    if (parsed.length === 0) return;
                    participantActionMutation.mutate({action: 'add', participants: parsed});
                  }}
                  className="space-y-2.5 rounded-xl border border-border bg-card p-4"
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
                        parseParticipantsList(addParticipantsRaw).length === 0
                      }
                    >
                      <UserPlus className="size-3.5" />
                      <span>{t.groups.addParticipantsBtn}</span>
                    </Button>
                  </div>
                </form>
              )}

              <div className="space-y-2.5 rounded-xl border border-border bg-card p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-semibold tabular-nums text-foreground">
                    {t.groups.membersCount(participantList.length || memberCount)}
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
                  <div className="divide-y divide-border rounded-lg border border-border">
                    {participantList.map((member) => {
                      const roleText = member.is_super_admin
                        ? t.groups.roleSuperAdmin
                        : member.is_admin
                          ? t.groups.roleAdmin
                          : t.groups.roleMember;
                      return (
                        <div
                          key={member.jid}
                          className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-xs"
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
                              <p
                                className="truncate font-mono text-[11px] text-muted-foreground"
                                dir="ltr"
                              >
                                {member.jid} · {roleText}
                              </p>
                            </div>
                          </div>
                          {canManageGroups && !member.is_super_admin && (
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

              <div className="space-y-2.5 rounded-xl border border-border bg-card p-4">
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
                        {canManageGroups && (
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
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          {tab === 'settings' && canManageGroups && (
            <div className="space-y-4 rounded-xl border border-border bg-card p-4">
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
                    checked={Boolean(activeGroup.IsLocked)}
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
                    checked={Boolean(activeGroup.IsAnnounce)}
                    disabled={announceMutation.isPending}
                    onCheckedChange={(checked) => announceMutation.mutate(checked)}
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
      )}

      <Dialog
        open={leaveConfirmOpen}
        onOpenChange={setLeaveConfirmOpen}
        title={t.groups.leaveConfirmTitle}
        description={t.groups.leaveConfirmDesc(activeGroup.Name || groupId)}
      >
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={() => setLeaveConfirmOpen(false)}>
            {t.cancel}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={leaveMutation.isPending}
            onClick={() => leaveMutation.mutate()}
          >
            {t.groups.leaveGroup}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
