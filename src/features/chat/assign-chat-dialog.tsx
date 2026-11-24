import {useEffect, useMemo, useState, type FormEvent} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {AlertTriangle, Check, Loader2, Search, UserCheck, UserMinus} from 'lucide-react';
import {toast} from 'sonner';
import {assignUnifiedChat, listAssignableAgents} from '@/api/client';
import type {AssignableAgent} from '@/api/types';
import {Button} from '@/components/ui/button';
import {Dialog} from '@/components/ui/dialog';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';
import {cn} from '@/lib/utils';

export function AssignChatDialog({
  open,
  onOpenChange,
  deviceId,
  chatJid,
  chatTitle,
  currentAssigneeId,
  currentUserId,
  canViewAll,
  onCompleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deviceId: string;
  chatJid: string;
  chatTitle: string;
  currentAssigneeId: number | null;
  currentUserId?: number;
  canViewAll: boolean;
  onCompleted?: () => void;
}) {
  const queryClient = useQueryClient();
  const {t} = useI18n();
  const [search, setSearch] = useState('');
  const [selectedUserId, setSelectedUserId] = useState<number | null>(currentAssigneeId);
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!open) return;
    setSearch('');
    setSelectedUserId(currentAssigneeId);
    setNote('');
  }, [open, currentAssigneeId, deviceId, chatJid]);

  const agentsQuery = useQuery({
    queryKey: ['assignable-agents', deviceId],
    queryFn: () => listAssignableAgents(deviceId),
    enabled: open && Boolean(deviceId),
    staleTime: 10_000,
  });

  const filteredAgents = useMemo<AssignableAgent[]>(() => {
    const list = agentsQuery.data ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (agent) =>
        agent.display_name.toLowerCase().includes(q) ||
        agent.username.toLowerCase().includes(q) ||
        agent.role_name.toLowerCase().includes(q),
    );
  }, [agentsQuery.data, search]);

  const assignMutation = useMutation({
    mutationFn: (targetUserId: number | null) =>
      assignUnifiedChat(deviceId, chatJid, {
        assigned_user_id: targetUserId,
        note: note.trim() || undefined,
        cached_title: chatTitle,
      }),
    onSuccess: (_res, targetUserId) => {
      toast.success(targetUserId === null ? t.chats.unassignedToast : t.chats.assignedToast);
      void queryClient.invalidateQueries({queryKey: ['chat-lifecycle', deviceId, chatJid]});
      void queryClient.invalidateQueries({queryKey: ['unified-chats']});
      void queryClient.invalidateQueries({queryKey: ['assignable-agents', deviceId]});
      onCompleted?.();
      onOpenChange(false);
    },
    onError: (err) => {
      toast.error(toApiError(err).message);
      void queryClient.invalidateQueries({queryKey: ['chat-lifecycle', deviceId, chatJid]});
      void queryClient.invalidateQueries({queryKey: ['unified-chats']});
    },
  });

  const showSelfTransferWarning =
    !canViewAll &&
    currentUserId !== undefined &&
    currentAssigneeId === currentUserId &&
    selectedUserId !== null &&
    selectedUserId !== currentUserId;

  const isConfirmDisabled =
    assignMutation.isPending ||
    selectedUserId === null ||
    selectedUserId === currentAssigneeId;

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (isConfirmDisabled) return;
    assignMutation.mutate(selectedUserId);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!assignMutation.isPending) onOpenChange(nextOpen);
      }}
      title={t.chats.assignDialogTitle}
      description={t.chats.assignDialogDesc(chatTitle)}
      className="max-w-lg"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="relative">
          <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t.chats.assignSearchPlaceholder}
            className="ps-9"
          />
        </div>

        <div className="max-h-64 overflow-y-auto rounded-lg border border-border bg-background/50">
          {agentsQuery.isLoading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              <span>{t.loading}</span>
            </div>
          ) : agentsQuery.isError ? (
            <div className="px-4 py-6 text-center text-xs text-destructive">
              {toApiError(agentsQuery.error).message}
            </div>
          ) : (agentsQuery.data?.length ?? 0) === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-muted-foreground">
              {t.chats.assignAgentsEmpty}
            </div>
          ) : filteredAgents.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-muted-foreground">
              {t.chats.assignNoMatchingAgents}
            </div>
          ) : (
            <div role="radiogroup" aria-label={t.chats.assignDialogTitle} className="divide-y divide-border">
              {filteredAgents.map((agent) => {
                const isSelected = selectedUserId === agent.id;
                const isCurrentOwner = currentAssigneeId === agent.id;
                return (
                  <button
                    key={agent.id}
                    type="button"
                    role="radio"
                    aria-checked={isSelected}
                    onClick={() => setSelectedUserId(agent.id)}
                    className={cn(
                      'flex w-full cursor-pointer items-center justify-between gap-3 px-3.5 py-2.5 text-start transition-colors hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring',
                      isSelected && 'bg-accent/70',
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-foreground">
                          {agent.display_name}
                        </span>
                        {isCurrentOwner && (
                          <span className="inline-flex shrink-0 items-center rounded border border-border bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                            {t.chats.assignCurrentOwnerTag}
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        <span dir="ltr" className="font-mono">
                          @{agent.username}
                        </span>
                        <span> · </span>
                        <span>{agent.role_name}</span>
                      </p>
                    </div>

                    <div className="flex shrink-0 items-center gap-2.5">
                      <span className="text-xs font-medium text-muted-foreground tabular-nums">
                        {t.chats.assignOpenCount(agent.open_chat_count)}
                      </span>
                      <span
                        className={cn(
                          'flex size-5 items-center justify-center rounded-full border',
                          isSelected
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-border bg-card',
                        )}
                      >
                        {isSelected && <Check className="size-3" />}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {showSelfTransferWarning && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>{t.chats.assignTransferSelfWarning}</span>
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="assign-chat-note">{t.chats.assignNoteLabel}</Label>
          <Input
            id="assign-chat-note"
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t.chats.assignNotePlaceholder}
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
          <div>
            {currentAssigneeId !== null && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={assignMutation.isPending}
                onClick={() => assignMutation.mutate(null)}
              >
                <UserMinus className="size-3.5" />
                <span>{t.chats.assignUnassignBtn}</span>
              </Button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={assignMutation.isPending}
              onClick={() => onOpenChange(false)}
            >
              {t.cancel}
            </Button>
            <Button type="submit" size="sm" disabled={isConfirmDisabled}>
              {assignMutation.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <UserCheck className="size-3.5" />
              )}
              <span>{t.chats.assignSubmitBtn}</span>
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}
