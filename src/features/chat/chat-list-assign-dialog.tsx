import {useEffect, useState, type FormEvent} from 'react';
import {useMutation, useQueryClient} from '@tanstack/react-query';
import {Check, Loader2, Plus, Trash2} from 'lucide-react';
import {toast} from 'sonner';
import {assignUnifiedChatLists, createChatList, deleteChatList} from '@/api/client';
import type {ChatListSummary, UnifiedChat} from '@/api/types';
import {Button} from '@/components/ui/button';
import {Dialog} from '@/components/ui/dialog';
import {chatDisplayName} from '@/features/chat/display-name';
import {UNIFIED_CHATS_QUERY_PREFIX} from '@/features/chat/inbox-query-keys';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';
import {cn} from '@/lib/utils';

export function ChatListAssignDialog({
  open,
  onOpenChange,
  chat,
  lists,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  chat: UnifiedChat | null;
  lists: ChatListSummary[];
}) {
  const {t} = useI18n();
  const queryClient = useQueryClient();
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [newListName, setNewListName] = useState('');

  useEffect(() => {
    if (!open || !chat) return;
    setSelectedIds(chat.list_ids ?? []);
    setNewListName('');
  }, [open, chat?.device_id, chat?.jid, chat?.list_ids]);

  const invalidate = () => {
    void queryClient.invalidateQueries({queryKey: UNIFIED_CHATS_QUERY_PREFIX});
  };

  const createMutation = useMutation({
    mutationFn: (name: string) => createChatList(name),
    onSuccess: (created) => {
      toast.success(t.chats.listCreatedToast);
      setNewListName('');
      setSelectedIds((prev) => (prev.includes(created.id) ? prev : [...prev, created.id]));
      invalidate();
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const deleteMutation = useMutation({
    mutationFn: (listId: number) => deleteChatList(listId),
    onSuccess: (_data, listId) => {
      toast.success(t.chats.listDeletedToast);
      setSelectedIds((prev) => prev.filter((id) => id !== listId));
      invalidate();
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!chat) return;
      return assignUnifiedChatLists(chat.device_id, chat.jid, selectedIds);
    },
    onSuccess: () => {
      toast.success(t.chats.listsSavedToast);
      invalidate();
      onOpenChange(false);
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  if (!chat) return null;

  const titleName = chatDisplayName(chat);

  const handleCreate = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = newListName.trim();
    if (!trimmed || createMutation.isPending) return;
    createMutation.mutate(trimmed);
  };

  const toggleId = (id: number) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !saveMutation.isPending) onOpenChange(false);
      }}
      title={t.chats.manageListsTitle(titleName)}
      description={t.chats.manageListsDesc}
    >
      <div className="space-y-4">
        <form onSubmit={handleCreate} className="flex items-center gap-2">
          <input
            type="text"
            value={newListName}
            onChange={(e) => setNewListName(e.target.value)}
            placeholder={t.chats.newListPlaceholder}
            maxLength={60}
            className="h-9 min-w-0 flex-1 rounded-lg border border-input bg-card px-3 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
          />
          <Button
            type="submit"
            size="sm"
            variant="secondary"
            disabled={!newListName.trim() || createMutation.isPending}
            className="h-9 shrink-0 whitespace-nowrap"
          >
            {createMutation.isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Plus className="size-3.5" />
            )}
            <span>{t.chats.createListBtn}</span>
          </Button>
        </form>

        <div className="max-h-60 space-y-1 overflow-y-auto rounded-lg border border-border/80 bg-secondary/30 p-2">
          {lists.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">{t.chats.noListsYet}</p>
          ) : (
            lists.map((item) => {
              const checked = selectedIds.includes(item.id);
              return (
                <div
                  key={item.id}
                  className="flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 transition-colors hover:bg-secondary"
                >
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    onClick={() => toggleId(item.id)}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-start focus-visible:outline-2 focus-visible:outline-ring rounded"
                  >
                    <span
                      className={cn(
                        'flex size-4 shrink-0 items-center justify-center rounded border transition-colors',
                        checked
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-input bg-card',
                      )}
                    >
                      {checked && <Check className="size-3" />}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                      {item.name}
                    </span>
                    <span className="text-[11px] text-muted-foreground tabular-nums">
                      {item.chat_count}
                    </span>
                  </button>
                  <button
                    type="button"
                    disabled={deleteMutation.isPending}
                    onClick={() => deleteMutation.mutate(item.id)}
                    aria-label={`${t.chats.deleteListAria}: ${item.name}`}
                    title={t.chats.deleteListAria}
                    className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-40"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={saveMutation.isPending}
            onClick={() => onOpenChange(false)}
          >
            {t.cancel}
          </Button>
          <Button
            type="button"
            disabled={saveMutation.isPending}
            onClick={() => saveMutation.mutate()}
          >
            {saveMutation.isPending && <Loader2 className="size-4 animate-spin" />}
            <span>{t.save}</span>
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
