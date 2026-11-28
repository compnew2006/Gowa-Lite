import {useEffect, useMemo, useState, type FormEvent} from 'react';
import {useQueries} from '@tanstack/react-query';
import {AlertTriangle, Check, Loader2, Search, UserCheck} from 'lucide-react';
import {listAssignableAgents} from '@/api/client';
import type {AssignableAgent} from '@/api/types';
import {Button} from '@/components/ui/button';
import {Dialog} from '@/components/ui/dialog';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';
import {cn} from '@/lib/utils';

/**
 * P2-8: bulk assign — pick one agent for the whole selection. The selection
 * may span several WhatsApp accounts, and the assignable-agent list is
 * per-account, so only agents authorized for EVERY selected account are
 * offered (intersection). The server still validates each chat (target
 * device access, active user) per item and reports partial failures.
 */
export function intersectAssignableAgents(lists: AssignableAgent[][]): AssignableAgent[] {
  if (lists.length === 0) return [];
  const byId = new Map<number, AssignableAgent>();
  for (const agent of lists[0]) {
    byId.set(agent.id, {...agent});
  }
  for (const list of lists.slice(1)) {
    const byIdInList = new Map(list.map((agent) => [agent.id, agent]));
    for (const id of [...byId.keys()]) {
      const other = byIdInList.get(id);
      if (!other) {
        byId.delete(id);
      } else {
        byId.get(id)!.open_chat_count += other.open_chat_count;
      }
    }
  }
  return [...byId.values()].sort(
    (a, b) =>
      a.open_chat_count - b.open_chat_count ||
      a.display_name.localeCompare(b.display_name),
  );
}

export function BulkAssignDialog({
  open,
  onOpenChange,
  deviceIds,
  selectedCount,
  currentUserId,
  canViewAll,
  isPending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deviceIds: string[];
  selectedCount: number;
  currentUserId?: number;
  canViewAll: boolean;
  isPending: boolean;
  onConfirm: (targetUserId: number, note?: string) => void;
}) {
  const {t} = useI18n();
  const [search, setSearch] = useState('');
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null);
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!open) return;
    setSearch('');
    setSelectedUserId(null);
    setNote('');
  }, [open, deviceIds.join(',')]);

  const agentQueries = useQueries({
    queries: deviceIds.map((deviceId) => ({
      queryKey: ['assignable-agents', deviceId],
      queryFn: () => listAssignableAgents(deviceId),
      enabled: open && Boolean(deviceId),
      staleTime: 10_000,
    })),
  });

  const isLoading = agentQueries.some((q) => q.isLoading);
  const isError = agentQueries.some((q) => q.isError);
  const errorMessage = agentQueries.find((q) => q.isError)?.error;

  const agents = useMemo<AssignableAgent[]>(() => {
    if (agentQueries.some((q) => q.data === undefined)) return [];
    return intersectAssignableAgents(agentQueries.map((q) => q.data ?? []));
  }, [agentQueries]);

  const filteredAgents = useMemo<AssignableAgent[]>(() => {
    const q = search.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter(
      (agent) =>
        agent.display_name.toLowerCase().includes(q) ||
        agent.username.toLowerCase().includes(q) ||
        agent.role_name.toLowerCase().includes(q),
    );
  }, [agents, search]);

  const showSelfTransferWarning =
    !canViewAll &&
    currentUserId !== undefined &&
    selectedUserId !== null &&
    selectedUserId !== currentUserId;

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (selectedUserId === null || isPending) return;
    onConfirm(selectedUserId, note.trim() || undefined);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isPending) onOpenChange(nextOpen);
      }}
      title={t.chats.bulkAssignDialogTitle}
      description={t.chats.bulkAssignDialogDesc(selectedCount)}
      className="max-w-lg"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {deviceIds.length > 1 && (
          <p className="text-xs text-muted-foreground">{t.chats.bulkAssignMultiDeviceHint}</p>
        )}
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
          {isLoading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              <span>{t.loading}</span>
            </div>
          ) : isError ? (
            <div className="px-4 py-6 text-center text-xs text-destructive">
              {errorMessage ? toApiError(errorMessage).message : t.chats.assignAgentsEmpty}
            </div>
          ) : agents.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-muted-foreground">
              {t.chats.bulkAssignAgentsEmpty}
            </div>
          ) : filteredAgents.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-muted-foreground">
              {t.chats.assignNoMatchingAgents}
            </div>
          ) : (
            <div role="radiogroup" aria-label={t.chats.bulkAssignDialogTitle} className="divide-y divide-border">
              {filteredAgents.map((agent) => {
                const isSelected = selectedUserId === agent.id;
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
                      <span className="truncate text-sm font-medium text-foreground">
                        {agent.display_name}
                      </span>
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
            <span>{t.chats.bulkAssignTransferWarning}</span>
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="bulk-assign-note">{t.chats.assignNoteLabel}</Label>
          <Input
            id="bulk-assign-note"
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t.chats.assignNotePlaceholder}
          />
        </div>

        <div className="flex justify-end gap-2 border-t border-border pt-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isPending}
            onClick={() => onOpenChange(false)}
          >
            {t.cancel}
          </Button>
          <Button type="submit" size="sm" disabled={isPending || selectedUserId === null}>
            {isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <UserCheck className="size-3.5" />
            )}
            <span>{t.chats.bulkAssignSubmitBtn}</span>
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
