import {useEffect, useMemo, useRef, useState, type KeyboardEvent} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {Check, History, Loader2, Lock, Pencil, Pin, PinOff, Search, Send, StickyNote, Trash2} from 'lucide-react';
import {toast} from 'sonner';
import {useNavigate} from 'react-router-dom';
import {
  createUnifiedChatNote,
  deleteUnifiedChatNote,
  listNoteEditHistory,
  listUnifiedChatNotes,
  updateUnifiedChatNote,
} from '@/api/client';
import type {ConversationNote, NoteEditHistoryEntry, UnifiedChat} from '@/api/types';
import {Button} from '@/components/ui/button';
import {FormattedText} from '@/features/chat/formatted-text';
import {formatDate} from '@/lib/format';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';
import {toastWithView} from '@/lib/toast-with-view';
import {buildConversationDeepLink} from '@/lib/deep-links';
import {cn} from '@/lib/utils';
import {hasUserPermission, isAdminUser, useAuthStore} from '@/stores/auth';

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
  if (diffMin < 60) return lang === 'ar' ? `منذ ${diffMin} د` : `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return lang === 'ar' ? `منذ ${diffHours} س` : `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return lang === 'ar' ? `منذ ${diffDays} ي` : `${diffDays}d ago`;
  return new Intl.DateTimeFormat(lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-US', {
    month: 'short',
    day: 'numeric',
  }).format(date);
}

function NoteRow({
  note,
  deviceId,
  chatJid,
  canPin,
  canEdit,
  canDelete,
  isBusy,
  onTogglePin,
  onSaveEdit,
  onDelete,
}: {
  note: ConversationNote;
  deviceId: string;
  chatJid: string;
  canPin: boolean;
  canEdit: boolean;
  canDelete: boolean;
  isBusy: boolean;
  onTogglePin: (note: ConversationNote) => void;
  onSaveEdit: (noteId: number, content: string) => Promise<void>;
  onDelete: (noteId: number) => void;
}) {
  const {lang, t} = useI18n();
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState(note.content);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const editRef = useRef<HTMLTextAreaElement>(null);

  // P2-7: per-note edit history, fetched only when the section is opened.
  const historyQuery = useQuery({
    queryKey: ['unified-chat-notes-history', deviceId, chatJid, note.id],
    queryFn: () => listNoteEditHistory(deviceId, chatJid, note.id),
    enabled: showHistory,
  });
  const historyEntries: NoteEditHistoryEntry[] = historyQuery.data?.history ?? [];

  useEffect(() => {
    if (!editing) setEditDraft(note.content);
  }, [note.content, editing]);

  useEffect(() => {
    if (editing) window.setTimeout(() => editRef.current?.focus(), 0);
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
              <span className="truncate font-semibold text-foreground">{note.created_by_name}</span>
              <span className="text-muted-foreground" aria-hidden="true">·</span>
              <time
                dateTime={note.created_at}
                title={formatDate(note.created_at, lang)}
                className="text-[11px] text-muted-foreground tabular-nums"
              >
                {formatRelativeNoteTime(note.created_at, lang)}
              </time>
              {wasEdited && (
                <>
                  <span className="text-muted-foreground" aria-hidden="true">·</span>
                  <span className="text-[11px] text-muted-foreground">{t.chats.editedMarker}</span>
                  <time
                    dateTime={note.updated_at}
                    title={formatDate(note.updated_at, lang)}
                    className="text-[11px] text-muted-foreground tabular-nums"
                  >
                    {formatDate(note.updated_at, lang)}
                  </time>
                </>
              )}
            </div>

            {!editing && (
              <div
                className={cn(
                  'flex shrink-0 items-center gap-0.5 transition-opacity',
                  note.is_pinned || confirmingDelete || showHistory
                    ? 'opacity-100'
                    : 'opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100',
                )}
              >
                {/* P2-7: per-note edit history (editor + time + before/after). */}
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => setShowHistory((prev) => !prev)}
                  title={showHistory ? t.chats.noteHistoryHide : t.chats.noteHistoryShow}
                  aria-label={showHistory ? t.chats.noteHistoryHide : t.chats.noteHistoryShow}
                  aria-expanded={showHistory}
                  className={cn(
                    'flex size-6 cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-secondary disabled:opacity-40',
                    showHistory ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <History className="size-3.5" />
                </button>

                {canPin && (
                  <button
                    type="button"
                    disabled={isBusy}
                    onClick={() => onTogglePin(note)}
                    title={note.is_pinned ? t.chats.unpinNote : t.chats.pinNote}
                    aria-label={note.is_pinned ? t.chats.unpinNote : t.chats.pinNote}
                    className={cn(
                      'flex size-6 cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-secondary disabled:opacity-40',
                      note.is_pinned ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {note.is_pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
                  </button>
                )}

                {canEdit && (
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
                )}

                {canDelete && (
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

          {showHistory && !editing && (
            <div className="mt-2 rounded-lg border border-border/70 bg-secondary/30 px-2.5 py-2">
              <p className="text-[11px] font-semibold text-muted-foreground">
                {t.chats.noteHistoryTitle}
              </p>
              {historyQuery.isLoading ? (
                <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  <span>{t.loading}</span>
                </div>
              ) : historyQuery.isError ? (
                <p className="mt-1 text-xs text-destructive">
                  {toApiError(historyQuery.error).message}
                </p>
              ) : historyEntries.length === 0 ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {t.chats.noteHistoryEmpty}
                </p>
              ) : (
                <ul className="mt-1.5 space-y-2.5">
                  {historyEntries.map((entry) => (
                    <li key={entry.id} className="space-y-1 text-xs leading-relaxed">
                      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                        <span className="font-semibold text-foreground">
                          {entry.edited_by_name}
                        </span>
                        <span className="text-muted-foreground" aria-hidden="true">·</span>
                        <time
                          dateTime={entry.edited_at}
                          title={formatDate(entry.edited_at, lang)}
                          className="text-[11px] text-muted-foreground tabular-nums"
                        >
                          {formatDate(entry.edited_at, lang)}
                        </time>
                      </div>
                      <p className="text-foreground/85">
                        <span className="font-medium text-muted-foreground">
                          {t.chats.noteHistoryBefore}:{' '}
                        </span>
                        <FormattedText text={entry.previous_content} />
                      </p>
                      <p className="text-foreground/85">
                        <span className="font-medium text-muted-foreground">
                          {t.chats.noteHistoryAfter}:{' '}
                        </span>
                        <FormattedText text={entry.new_content} />
                      </p>
                    </li>
                  ))}
                </ul>
              )}
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

export function NotesPanelBody({
  chat,
  isContentRedacted = false,
}: {
  chat: UnifiedChat;
  isContentRedacted?: boolean;
}) {
  const {t} = useI18n();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const currentUser = useAuthStore((s) => s.user);
  const canWriteNotes = hasUserPermission(currentUser, 'notes:write');
  const canDeleteAnyNote = hasUserPermission(currentUser, 'notes:delete');
  const isAdmin = isAdminUser(currentUser);
  const [filter, setFilter] = useState<'all' | 'pinned'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [newContent, setNewContent] = useState('');
  const [pinOnCreate, setPinOnCreate] = useState(false);

  const notesQuery = useQuery({
    queryKey: ['unified-chat-notes', chat.device_id, chat.jid],
    queryFn: () => listUnifiedChatNotes(chat.device_id, chat.jid),
    enabled: !isContentRedacted,
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
      toastWithView(t.chats.noteAddedToast, {
        label: t.scheduled.viewAction,
        to: buildConversationDeepLink(chat.device_id, chat.jid),
        navigate,
      });
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
      if (vars.content !== undefined)
        toastWithView(t.chats.noteUpdatedToast, {
          label: t.scheduled.viewAction,
          to: buildConversationDeepLink(chat.device_id, chat.jid),
          navigate,
        });
      else if (vars.is_pinned !== undefined) {
        toastWithView(vars.is_pinned ? t.chats.notePinnedToast : t.chats.noteUnpinnedToast, {
          label: t.scheduled.viewAction,
          to: buildConversationDeepLink(chat.device_id, chat.jid),
          navigate,
        });
      }
      invalidateNotes();
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  const deleteMutation = useMutation({
    mutationFn: (noteId: number) => deleteUnifiedChatNote(chat.device_id, chat.jid, noteId),
    onSuccess: () => {
      toastWithView(t.chats.noteDeletedToast, {
        label: t.scheduled.viewAction,
        to: buildConversationDeepLink(chat.device_id, chat.jid),
        navigate,
      });
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
        note.content.toLowerCase().includes(q) || note.created_by_name.toLowerCase().includes(q)
      );
    });
  }, [allNotes, filter, searchQuery]);

  const pinnedNotes = useMemo(() => filteredNotes.filter((n) => n.is_pinned), [filteredNotes]);
  const regularNotes = useMemo(() => filteredNotes.filter((n) => !n.is_pinned), [filteredNotes]);
  const isBusy = createMutation.isPending || updateMutation.isPending || deleteMutation.isPending;

  const canEditNote = (note: ConversationNote) =>
    canWriteNotes &&
    Boolean(currentUser) &&
    (currentUser!.id === note.created_by_id || isAdmin || canDeleteAnyNote);
  const canDeleteNote = (note: ConversationNote) =>
    Boolean(currentUser) &&
    (isAdmin || canDeleteAnyNote || (canWriteNotes && currentUser!.id === note.created_by_id));

  const renderNoteRows = (notes: ConversationNote[]) => (
    <div className="divide-y divide-border/70">
      {notes.map((note) => (
        <NoteRow
          key={note.id}
          note={note}
          deviceId={chat.device_id}
          chatJid={chat.jid}
          canPin={canWriteNotes}
          canEdit={canEditNote(note)}
          canDelete={canDeleteNote(note)}
          isBusy={isBusy}
          onTogglePin={(item) => updateMutation.mutate({noteId: item.id, is_pinned: !item.is_pinned})}
          onSaveEdit={async (noteId, content) => {
            await updateMutation.mutateAsync({noteId, content});
          }}
          onDelete={(noteId) => deleteMutation.mutate(noteId)}
        />
      ))}
    </div>
  );

  const redacted = isContentRedacted || Boolean(notesQuery.data?.content_redacted);

  if (redacted) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 py-14 text-center">
        <div className="mb-3 flex size-11 items-center justify-center rounded-full bg-secondary text-muted-foreground">
          <Lock className="size-5" />
        </div>
        <p className="text-sm font-medium text-foreground">{t.chats.redactedLockedHint}</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {t.chats.redactedNotesHint}
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
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
                filter === 'all' ? 'bg-card text-foreground shadow-2xs' : 'text-muted-foreground hover:text-foreground',
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
                filter === 'pinned' ? 'bg-card text-foreground shadow-2xs' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t.chats.notesPinnedFilter}{' '}
              <span className="text-[11px] opacity-75 tabular-nums">({pinnedCount})</span>
            </button>
          </div>
        </div>
      )}

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
            {filter === 'pinned' && !searchQuery.trim() ? t.chats.noPinnedNotes : t.chats.noNotesMatch}
          </div>
        ) : (
          <div className="divide-y divide-border/70">
            {pinnedNotes.length > 0 && (
              <div>
                <div className="border-b border-border/60 bg-secondary/20 px-4 py-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground">
                  {t.chats.notesPinnedSection} ·{' '}
                  <span className="tabular-nums">{pinnedNotes.length}</span>
                </div>
                {renderNoteRows(pinnedNotes)}
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
                {renderNoteRows(regularNotes)}
              </div>
            )}
          </div>
        )}
      </div>

      {canWriteNotes && (
        <div className="shrink-0 border-t border-border bg-card p-3">
          <div className="rounded-xl border border-input bg-secondary/40 p-2.5 focus-within:border-ring">
            <textarea
              rows={2}
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  if (newContent.trim() && !createMutation.isPending) createMutation.mutate();
                }
              }}
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
      )}
    </div>
  );
}
