import {useEffect, useMemo, useRef, useState, type KeyboardEvent} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {
  Ban,
  CalendarClock,
  Check,
  FileText,
  Image as ImageIcon,
  Loader2,
  MessageSquare,
  Mic,
  Pause,
  Pencil,
  Pin,
  PinOff,
  Play,
  Plus,
  Search,
  Send,
  StickyNote,
  Trash2,
  Video,
  X,
} from 'lucide-react';
import {toast} from 'sonner';
import {
  actionUnifiedChatSchedule,
  createUnifiedChatNote,
  deleteUnifiedChatNote,
  listUnifiedChatNotes,
  listUnifiedChatSchedules,
  updateUnifiedChatNote,
  updateUnifiedChatSchedule,
} from '@/api/client';
import type {
  ConversationNote,
  ScheduleStatus,
  ScheduledSend,
  UnifiedChat,
} from '@/api/types';
import {Button} from '@/components/ui/button';
import {FormattedText} from '@/features/chat/formatted-text';
import {formatDate} from '@/lib/format';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';
import {cn} from '@/lib/utils';
import {useAuthStore} from '@/stores/auth';

export type ContextDrawerTab = 'notes' | 'scheduled';

function getAuthorInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] ?? ''}${parts[1][0] ?? ''}`.toUpperCase();
}

function formatRelativeNoteTime(iso: string, lang: 'ar' | 'en'): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const diffSec = Math.round((Date.now() - date.getTime()) / 1000);
  if (diffSec < 45) return lang === 'ar' ? 'الآن' : 'Just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) {
    return lang === 'ar' ? `منذ ${diffMin} د` : `${diffMin}m ago`;
  }
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) {
    return lang === 'ar' ? `منذ ${diffHours} س` : `${diffHours}h ago`;
  }
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) {
    return lang === 'ar' ? `منذ ${diffDays} ي` : `${diffDays}d ago`;
  }
  return new Intl.DateTimeFormat(lang === 'ar' ? 'ar-EG' : 'en-US', {
    month: 'short',
    day: 'numeric',
  }).format(date);
}

function toLocalDateTimeInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function ScheduleTypeIcon({type}: {type: string}) {
  switch (type) {
    case 'image':
      return <ImageIcon className="size-3.5 shrink-0 text-muted-foreground" />;
    case 'video':
      return <Video className="size-3.5 shrink-0 text-muted-foreground" />;
    case 'audio':
      return <Mic className="size-3.5 shrink-0 text-muted-foreground" />;
    case 'document':
      return <FileText className="size-3.5 shrink-0 text-muted-foreground" />;
    default:
      return <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />;
  }
}

function statusToneClass(status: ScheduleStatus): string {
  switch (status) {
    case 'active':
      return 'text-emerald-600 dark:text-emerald-400';
    case 'running':
      return 'text-sky-600 dark:text-sky-400';
    case 'paused':
      return 'text-amber-600 dark:text-amber-400';
    case 'failed':
      return 'text-destructive';
    case 'completed':
    case 'cancelled':
      return 'text-muted-foreground';
  }
}

function NoteRow({
  note,
  canModify,
  isBusy,
  onTogglePin,
  onSaveEdit,
  onDelete,
}: {
  note: ConversationNote;
  canModify: boolean;
  isBusy: boolean;
  onTogglePin: (note: ConversationNote) => void;
  onSaveEdit: (noteId: number, content: string) => Promise<void>;
  onDelete: (noteId: number) => void;
}) {
  const {lang, t} = useI18n();
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState(note.content);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const editRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) {
      setEditDraft(note.content);
    }
  }, [note.content, editing]);

  useEffect(() => {
    if (editing) {
      window.setTimeout(() => editRef.current?.focus(), 0);
    }
  }, [editing]);

  const wasEdited = note.updated_at !== note.created_at;

  const handleEditKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      if (editDraft.trim()) {
        void onSaveEdit(note.id, editDraft.trim()).then(() => setEditing(false));
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setEditing(false);
      setEditDraft(note.content);
    }
  };

  return (
    <article
      className={cn(
        'group px-4 py-3 transition-colors',
        note.is_pinned ? 'bg-secondary/40' : 'hover:bg-secondary/25',
      )}
    >
      <div className="flex items-start gap-2.5">
        <div
          aria-hidden="true"
          className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-secondary text-[10px] font-semibold text-foreground"
        >
          {getAuthorInitials(note.created_by_name)}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
              <span className="truncate font-semibold text-foreground">
                {note.created_by_name}
              </span>
              <span className="text-muted-foreground" aria-hidden="true">
                ·
              </span>
              <time
                dateTime={note.created_at}
                title={formatDate(note.created_at, lang)}
                className="text-[11px] text-muted-foreground tabular-nums"
              >
                {formatRelativeNoteTime(note.created_at, lang)}
              </time>
              {wasEdited && (
                <>
                  <span className="text-muted-foreground" aria-hidden="true">
                    ·
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {t.chats.editedMarker}
                  </span>
                </>
              )}
            </div>

            {!editing && (
              <div
                className={cn(
                  'flex shrink-0 items-center gap-0.5 transition-opacity',
                  note.is_pinned || confirmingDelete
                    ? 'opacity-100'
                    : 'opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100',
                )}
              >
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => onTogglePin(note)}
                  title={note.is_pinned ? t.chats.unpinNote : t.chats.pinNote}
                  aria-label={note.is_pinned ? t.chats.unpinNote : t.chats.pinNote}
                  className={cn(
                    'flex size-6 cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-secondary disabled:opacity-40',
                    note.is_pinned
                      ? 'text-primary'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {note.is_pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
                </button>

                {canModify && (
                  <>
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => {
                        setConfirmingDelete(false);
                        setEditing(true);
                      }}
                      title={t.editAction}
                      aria-label={t.editAction}
                      className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40"
                    >
                      <Pencil className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => setConfirmingDelete((prev) => !prev)}
                      title={t.deleteAction}
                      aria-label={t.deleteAction}
                      className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          {editing ? (
            <div className="mt-2 space-y-2">
              <textarea
                ref={editRef}
                rows={3}
                value={editDraft}
                onChange={(e) => setEditDraft(e.target.value)}
                onKeyDown={handleEditKeyDown}
                className="w-full resize-none rounded-lg border border-input bg-background px-2.5 py-2 text-[13px] leading-relaxed text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              />
              <div className="flex items-center justify-end gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={() => {
                    setEditing(false);
                    setEditDraft(note.content);
                  }}
                >
                  {t.cancel}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="h-7 px-2.5 text-xs"
                  disabled={isBusy || !editDraft.trim()}
                  onClick={() =>
                    void onSaveEdit(note.id, editDraft.trim()).then(() => setEditing(false))
                  }
                >
                  <Check className="size-3.5" />
                  <span>{t.save}</span>
                </Button>
              </div>
            </div>
          ) : (
            <div className="mt-1 text-[13px] leading-relaxed text-foreground/90">
              <FormattedText text={note.content} />
            </div>
          )}

          {confirmingDelete && !editing && (
            <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-2.5 py-1.5">
              <span className="text-xs font-medium text-destructive">
                {t.chats.confirmDeleteNotePrompt}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[11px]"
                  onClick={() => setConfirmingDelete(false)}
                >
                  {t.cancel}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  className="h-6 px-2 text-[11px]"
                  disabled={isBusy}
                  onClick={() => {
                    setConfirmingDelete(false);
                    onDelete(note.id);
                  }}
                >
                  {t.deleteAction}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

function NotesPanelBody({chat}: {chat: UnifiedChat}) {
  const {t} = useI18n();
  const queryClient = useQueryClient();
  const currentUser = useAuthStore((s) => s.user);
  const [filter, setFilter] = useState<'all' | 'pinned'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [newContent, setNewContent] = useState('');
  const [pinOnCreate, setPinOnCreate] = useState(false);

  const notesQuery = useQuery({
    queryKey: ['unified-chat-notes', chat.device_id, chat.jid],
    queryFn: () => listUnifiedChatNotes(chat.device_id, chat.jid),
  });

  const invalidateNotes = () => {
    void queryClient.invalidateQueries({
      queryKey: ['unified-chat-notes', chat.device_id, chat.jid],
    });
  };

  const createMutation = useMutation({
    mutationFn: () =>
      createUnifiedChatNote(chat.device_id, chat.jid, {
        content: newContent.trim(),
        is_pinned: pinOnCreate,
      }),
    onSuccess: () => {
      setNewContent('');
      setPinOnCreate(false);
      toast.success(t.chats.noteAddedToast);
      invalidateNotes();
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const updateMutation = useMutation({
    mutationFn: ({
      noteId,
      content,
      is_pinned,
    }: {
      noteId: number;
      content?: string;
      is_pinned?: boolean;
    }) => updateUnifiedChatNote(chat.device_id, chat.jid, noteId, {content, is_pinned}),
    onSuccess: (_data, vars) => {
      if (vars.content !== undefined) {
        toast.success(t.chats.noteUpdatedToast);
      } else if (vars.is_pinned !== undefined) {
        toast.success(vars.is_pinned ? t.chats.notePinnedToast : t.chats.noteUnpinnedToast);
      }
      invalidateNotes();
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const deleteMutation = useMutation({
    mutationFn: (noteId: number) => deleteUnifiedChatNote(chat.device_id, chat.jid, noteId),
    onSuccess: () => {
      toast.success(t.chats.noteDeletedToast);
      invalidateNotes();
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const allNotes = notesQuery.data?.notes ?? [];
  const pinnedCount = useMemo(() => allNotes.filter((n) => n.is_pinned).length, [allNotes]);

  const filteredNotes = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return allNotes.filter((note) => {
      if (filter === 'pinned' && !note.is_pinned) return false;
      if (!q) return true;
      return (
        note.content.toLowerCase().includes(q) ||
        note.created_by_name.toLowerCase().includes(q)
      );
    });
  }, [allNotes, filter, searchQuery]);

  const pinnedNotes = useMemo(() => filteredNotes.filter((n) => n.is_pinned), [filteredNotes]);
  const regularNotes = useMemo(() => filteredNotes.filter((n) => !n.is_pinned), [filteredNotes]);

  const isBusy =
    createMutation.isPending || updateMutation.isPending || deleteMutation.isPending;

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (newContent.trim() && !createMutation.isPending) {
        createMutation.mutate();
      }
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Filter & Search Toolbar (only when there are notes) */}
      {allNotes.length > 0 && (
        <div className="shrink-0 space-y-2 border-b border-border px-3 py-2.5">
          <div className="relative">
            <Search className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t.chats.notesSearchPlaceholder}
              className="h-8 w-full rounded-lg bg-secondary ps-8 pe-3 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
            />
          </div>

          <div className="flex items-center gap-1 rounded-lg bg-secondary p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setFilter('all')}
              className={cn(
                'flex-1 cursor-pointer rounded-md py-1 text-center font-medium transition-colors',
                filter === 'all'
                  ? 'bg-card text-foreground shadow-2xs'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t.chats.notesAllFilter}{' '}
              <span className="text-[11px] opacity-75 tabular-nums">({allNotes.length})</span>
            </button>
            <button
              type="button"
              onClick={() => setFilter('pinned')}
              className={cn(
                'flex-1 cursor-pointer rounded-md py-1 text-center font-medium transition-colors',
                filter === 'pinned'
                  ? 'bg-card text-foreground shadow-2xs'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t.chats.notesPinnedFilter}{' '}
              <span className="text-[11px] opacity-75 tabular-nums">({pinnedCount})</span>
            </button>
          </div>
        </div>
      )}

      {/* Notes List */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {notesQuery.isLoading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-xs text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            <span>{t.loading}</span>
          </div>
        ) : notesQuery.isError ? (
          <div className="p-4 text-center text-xs text-destructive">
            {toApiError(notesQuery.error).message}
          </div>
        ) : allNotes.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
            <div className="mb-3 flex size-11 items-center justify-center rounded-full bg-secondary text-muted-foreground">
              <StickyNote className="size-5" />
            </div>
            <p className="text-sm font-medium text-foreground">{t.chats.noNotesTitle}</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {t.chats.noNotesHint}
            </p>
          </div>
        ) : filteredNotes.length === 0 ? (
          <div className="px-6 py-12 text-center text-xs text-muted-foreground">
            {filter === 'pinned' && !searchQuery.trim()
              ? t.chats.noPinnedNotes
              : t.chats.noNotesMatch}
          </div>
        ) : (
          <div className="divide-y divide-border/70">
            {pinnedNotes.length > 0 && (
              <div>
                <div className="border-b border-border/60 bg-secondary/20 px-4 py-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground">
                  {t.chats.notesPinnedSection} ·{' '}
                  <span className="tabular-nums">{pinnedNotes.length}</span>
                </div>
                <div className="divide-y divide-border/70">
                  {pinnedNotes.map((note) => (
                    <NoteRow
                      key={note.id}
                      note={note}
                      canModify={
                        Boolean(currentUser) &&
                        (currentUser!.id === note.created_by_id || currentUser!.role === 'admin')
                      }
                      isBusy={isBusy}
                      onTogglePin={(item) =>
                        updateMutation.mutate({noteId: item.id, is_pinned: !item.is_pinned})
                      }
                      onSaveEdit={async (noteId, content) => {
                        await updateMutation.mutateAsync({noteId, content});
                      }}
                      onDelete={(noteId) => deleteMutation.mutate(noteId)}
                    />
                  ))}
                </div>
              </div>
            )}

            {regularNotes.length > 0 && (
              <div>
                {pinnedNotes.length > 0 && (
                  <div className="border-b border-border/60 bg-secondary/20 px-4 py-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground">
                    {t.chats.notesOtherSection} ·{' '}
                    <span className="tabular-nums">{regularNotes.length}</span>
                  </div>
                )}
                <div className="divide-y divide-border/70">
                  {regularNotes.map((note) => (
                    <NoteRow
                      key={note.id}
                      note={note}
                      canModify={
                        Boolean(currentUser) &&
                        (currentUser!.id === note.created_by_id || currentUser!.role === 'admin')
                      }
                      isBusy={isBusy}
                      onTogglePin={(item) =>
                        updateMutation.mutate({noteId: item.id, is_pinned: !item.is_pinned})
                      }
                      onSaveEdit={async (noteId, content) => {
                        await updateMutation.mutateAsync({noteId, content});
                      }}
                      onDelete={(noteId) => deleteMutation.mutate(noteId)}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bottom Note Composer */}
      <div className="shrink-0 border-t border-border bg-card p-3">
        <div className="rounded-xl border border-input bg-secondary/40 p-2.5 focus-within:border-ring">
          <textarea
            rows={2}
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
            onKeyDown={handleComposerKeyDown}
            placeholder={t.chats.writeNotePlaceholder}
            className="max-h-32 min-h-[44px] w-full resize-none bg-transparent text-[13px] leading-relaxed text-foreground placeholder:text-muted-foreground focus:outline-none"
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setPinOnCreate((prev) => !prev)}
              aria-pressed={pinOnCreate}
              className={cn(
                'inline-flex h-7 cursor-pointer items-center gap-1 rounded-md px-2 text-[11px] font-medium transition-colors',
                pinOnCreate
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
              )}
            >
              <Pin className="size-3" />
              <span>{t.chats.pinOnCreate}</span>
            </button>

            <Button
              type="button"
              size="sm"
              className="h-7 px-3 text-xs"
              disabled={!newContent.trim() || createMutation.isPending}
              onClick={() => createMutation.mutate()}
            >
              {createMutation.isPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Send className="size-3.5" />
              )}
              <span>{t.chats.addNoteSubmit}</span>
            </Button>
          </div>
        </div>
        <p className="mt-1.5 text-[10.5px] text-muted-foreground">{t.chats.noteShortcutHint}</p>
      </div>
    </div>
  );
}

function ScheduledPanelBody({
  chat,
  onOpenCreateSchedule,
}: {
  chat: UnifiedChat;
  onOpenCreateSchedule: () => void;
}) {
  const {lang, t} = useI18n();
  const queryClient = useQueryClient();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTime, setEditingTime] = useState('');
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null);

  const schedulesQuery = useQuery({
    queryKey: ['unified-chat-schedules', chat.device_id, chat.jid],
    queryFn: () => listUnifiedChatSchedules(chat.device_id, chat.jid),
  });

  const invalidateSchedules = () => {
    void queryClient.invalidateQueries({
      queryKey: ['unified-chat-schedules', chat.device_id, chat.jid],
    });
    void queryClient.invalidateQueries({queryKey: ['schedules', chat.device_id]});
  };

  const actionMutation = useMutation({
    mutationFn: ({id, action}: {id: string; action: 'pause' | 'resume' | 'cancel'}) =>
      actionUnifiedChatSchedule(chat.device_id, chat.jid, id, action),
    onSuccess: (_data, vars) => {
      if (vars.action === 'pause') toast.success(t.scheduled.pausedToast);
      else if (vars.action === 'resume') toast.success(t.scheduled.resumedToast);
      else {
        toast.success(t.scheduled.cancelledToast);
        setConfirmCancelId(null);
      }
      invalidateSchedules();
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const updateTimeMutation = useMutation({
    mutationFn: ({id, scheduledAt}: {id: string; scheduledAt: string}) =>
      updateUnifiedChatSchedule(chat.device_id, chat.jid, id, {scheduled_at: scheduledAt}),
    onSuccess: () => {
      toast.success(t.chats.scheduleUpdatedToast);
      setEditingId(null);
      setEditingTime('');
      invalidateSchedules();
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const statusLabels = useMemo<Record<ScheduleStatus, string>>(
    () => ({
      active: t.scheduled.statusActive,
      running: t.scheduled.statusRunning,
      paused: t.scheduled.statusPaused,
      completed: t.scheduled.statusCompleted,
      failed: t.scheduled.statusFailed,
      cancelled: t.scheduled.statusCancelled,
    }),
    [t],
  );

  const recurrenceLabels: Record<string, string> = {
    once: t.scheduled.recurrenceOnce,
    daily: t.scheduled.recurrenceDaily,
    weekly: t.scheduled.recurrenceWeekly,
    monthly: t.scheduled.recurrenceMonthly,
  };

  const items: ScheduledSend[] = schedulesQuery.data?.data ?? [];
  const minLocal = toLocalDateTimeInput(new Date(Date.now() + 60_000));
  const isBusy = actionMutation.isPending || updateTimeMutation.isPending;

  const startEditing = (item: ScheduledSend) => {
    const rawDate = item.next_run_at || item.scheduled_at;
    const parsed = rawDate ? new Date(rawDate) : new Date(Date.now() + 5 * 60_000);
    setConfirmCancelId(null);
    setEditingId(item.id);
    setEditingTime(
      toLocalDateTimeInput(
        Number.isNaN(parsed.getTime()) ? new Date(Date.now() + 5 * 60_000) : parsed,
      ),
    );
  };

  const handleSaveTime = (id: string) => {
    const ms = new Date(editingTime).getTime();
    if (!editingTime || !Number.isFinite(ms) || ms <= Date.now() + 60_000) {
      toast.error(t.chats.schedulePastError);
      return;
    }
    updateTimeMutation.mutate({id, scheduledAt: new Date(ms).toISOString()});
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-border px-3 py-2.5">
        <Button
          type="button"
          size="sm"
          className="h-8 w-full text-xs"
          onClick={onOpenCreateSchedule}
        >
          <Plus className="size-3.5" />
          <span>{t.scheduled.newSchedule}</span>
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {schedulesQuery.isLoading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-xs text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            <span>{t.loading}</span>
          </div>
        ) : schedulesQuery.isError ? (
          <div className="p-4 text-center text-xs text-destructive">
            {toApiError(schedulesQuery.error).message}
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
            <div className="mb-3 flex size-11 items-center justify-center rounded-full bg-secondary text-muted-foreground">
              <CalendarClock className="size-5" />
            </div>
            <p className="text-sm font-medium text-foreground">{t.chats.noScheduledMessages}</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {t.chats.noScheduledMessagesHint}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border/70">
            {items.map((item) => {
              const nextRunRaw = item.next_run_at || item.scheduled_at;
              const canPause = item.status === 'active';
              const canResume = item.status === 'paused';
              const canModify = item.status === 'active' || item.status === 'paused';
              const previewText = item.content || item.caption || item.filename || '—';

              return (
                <article key={item.id} className="group px-4 py-3 transition-colors hover:bg-secondary/25">
                  <div className="flex items-start gap-2.5">
                    <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-secondary">
                      <ScheduleTypeIcon type={item.message_type} />
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
                          <span className={cn('font-semibold', statusToneClass(item.status))}>
                            {statusLabels[item.status] || item.status}
                          </span>
                          <span className="text-muted-foreground" aria-hidden="true">
                            ·
                          </span>
                          <span className="text-[11px] text-muted-foreground tabular-nums">
                            {nextRunRaw ? formatDate(nextRunRaw, lang) : '—'}
                          </span>
                          {item.recurrence && item.recurrence !== 'once' && (
                            <>
                              <span className="text-muted-foreground" aria-hidden="true">
                                ·
                              </span>
                              <span className="text-[11px] text-muted-foreground">
                                {recurrenceLabels[item.recurrence] || item.recurrence}
                              </span>
                            </>
                          )}
                        </div>

                        {canModify && editingId !== item.id && (
                          <div
                            className={cn(
                              'flex shrink-0 items-center gap-0.5 transition-opacity',
                              confirmCancelId === item.id
                                ? 'opacity-100'
                                : 'opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100',
                            )}
                          >
                            {item.message_type === 'text' && (
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => startEditing(item)}
                                title={t.chats.editScheduleTime}
                                aria-label={t.chats.editScheduleTime}
                                className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40"
                              >
                                <Pencil className="size-3.5" />
                              </button>
                            )}
                            {canPause && (
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() =>
                                  actionMutation.mutate({id: item.id, action: 'pause'})
                                }
                                title={t.scheduled.pause}
                                aria-label={t.scheduled.pause}
                                className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40"
                              >
                                <Pause className="size-3.5" />
                              </button>
                            )}
                            {canResume && (
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() =>
                                  actionMutation.mutate({id: item.id, action: 'resume'})
                                }
                                title={t.scheduled.resume}
                                aria-label={t.scheduled.resume}
                                className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40"
                              >
                                <Play className="size-3.5" />
                              </button>
                            )}
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() =>
                                setConfirmCancelId((prev) => (prev === item.id ? null : item.id))
                              }
                              title={t.scheduled.cancelSchedule}
                              aria-label={t.scheduled.cancelSchedule}
                              className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                            >
                              <Ban className="size-3.5" />
                            </button>
                          </div>
                        )}
                      </div>

                      <p className="mt-1 line-clamp-4 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-foreground/90">
                        {previewText}
                      </p>

                      {item.last_error && (
                        <p className="mt-1 text-[11px] text-destructive">{item.last_error}</p>
                      )}

                      {editingId === item.id && (
                        <div className="mt-2 space-y-2">
                          <input
                            type="datetime-local"
                            dir="ltr"
                            min={minLocal}
                            value={editingTime}
                            onChange={(e) => setEditingTime(e.target.value)}
                            className="h-8 w-full rounded-lg border border-input bg-background px-2.5 text-xs text-foreground tabular-nums focus-visible:outline-2 focus-visible:outline-ring"
                          />
                          <div className="flex justify-end gap-1.5">
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-7 px-2 text-xs"
                              onClick={() => {
                                setEditingId(null);
                                setEditingTime('');
                              }}
                            >
                              {t.cancel}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              className="h-7 px-2.5 text-xs"
                              disabled={isBusy || !editingTime}
                              onClick={() => handleSaveTime(item.id)}
                            >
                              <Check className="size-3.5" />
                              <span>{t.save}</span>
                            </Button>
                          </div>
                        </div>
                      )}

                      {confirmCancelId === item.id && editingId !== item.id && (
                        <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-2.5 py-1.5">
                          <span className="text-xs font-medium text-destructive">
                            {t.chats.cancelScheduleInlineConfirm}
                          </span>
                          <div className="flex items-center gap-1">
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-6 px-2 text-[11px]"
                              onClick={() => setConfirmCancelId(null)}
                            >
                              {t.cancel}
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="destructive"
                              className="h-6 px-2 text-[11px]"
                              disabled={isBusy}
                              onClick={() =>
                                actionMutation.mutate({id: item.id, action: 'cancel'})
                              }
                            >
                              {t.scheduled.confirmCancelBtn}
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export function ChatContextDrawer({
  chat,
  activeTab,
  notesCount,
  scheduledCount,
  onTabChange,
  onClose,
  onOpenCreateSchedule,
}: {
  chat: UnifiedChat;
  activeTab: ContextDrawerTab;
  notesCount: number;
  scheduledCount: number;
  onTabChange: (tab: ContextDrawerTab) => void;
  onClose: () => void;
  onOpenCreateSchedule: () => void;
}) {
  const {t} = useI18n();

  return (
    <aside
      aria-label={
        activeTab === 'notes' ? t.chats.notesTitle : t.chats.scheduledMessagesTitle
      }
      className="absolute inset-0 z-30 flex min-h-0 flex-col border-s border-border bg-card md:static md:w-80 lg:w-[344px] md:shrink-0"
    >
      {/* Top Segmented Header */}
      <div className="flex h-[58px] shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <div
          role="tablist"
          className="flex min-w-0 flex-1 items-center gap-1 rounded-lg bg-secondary p-0.5 text-xs"
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'notes'}
            onClick={() => onTabChange('notes')}
            className={cn(
              'flex min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md px-2 py-1.5 font-medium transition-colors',
              activeTab === 'notes'
                ? 'bg-card text-foreground shadow-2xs'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <StickyNote className="size-3.5 shrink-0" />
            <span className="truncate">{t.chats.notesTab}</span>
            {notesCount > 0 && (
              <span className="text-[11px] text-muted-foreground tabular-nums">
                ({notesCount})
              </span>
            )}
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'scheduled'}
            onClick={() => onTabChange('scheduled')}
            className={cn(
              'flex min-w-0 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md px-2 py-1.5 font-medium transition-colors',
              activeTab === 'scheduled'
                ? 'bg-card text-foreground shadow-2xs'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <CalendarClock className="size-3.5 shrink-0" />
            <span className="truncate">{t.chats.scheduledTab}</span>
            {scheduledCount > 0 && (
              <span className="text-[11px] text-muted-foreground tabular-nums">
                ({scheduledCount})
              </span>
            )}
          </button>
        </div>

        <button
          type="button"
          onClick={onClose}
          title={t.chats.closeDrawerAria}
          aria-label={t.chats.closeDrawerAria}
          className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>

      {activeTab === 'notes' ? (
        <NotesPanelBody chat={chat} />
      ) : (
        <ScheduledPanelBody chat={chat} onOpenCreateSchedule={onOpenCreateSchedule} />
      )}
    </aside>
  );
}
