import {CalendarClock, StickyNote, X} from 'lucide-react';
import type {UnifiedChat} from '@/api/types';
import {NotesPanelBody} from '@/features/chat/drawer-notes-panel';
import {ScheduledPanelBody} from '@/features/chat/drawer-schedules-panel';
import {useI18n} from '@/lib/i18n';
import {cn} from '@/lib/utils';

export type ContextDrawerTab = 'notes' | 'scheduled';

export function ChatContextDrawer({
  chat,
  activeTab,
  isContentRedacted = false,
  canReadNotes = true,
  canReadSchedules = true,
  notesCount,
  scheduledCount,
  onTabChange,
  onClose,
  onOpenCreateSchedule,
}: {
  chat: UnifiedChat;
  activeTab: ContextDrawerTab;
  isContentRedacted?: boolean;
  canReadNotes?: boolean;
  canReadSchedules?: boolean;
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
      <div className="flex h-[58px] shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <div
          role="tablist"
          className="flex min-w-0 flex-1 items-center gap-1 rounded-lg bg-secondary p-0.5 text-xs"
        >
          {canReadNotes && (
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
              {!isContentRedacted && notesCount > 0 && (
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  ({notesCount})
                </span>
              )}
            </button>
          )}

          {canReadSchedules && (
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
              {!isContentRedacted && scheduledCount > 0 && (
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  ({scheduledCount})
                </span>
              )}
            </button>
          )}
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

      {activeTab === 'notes' && canReadNotes ? (
        <NotesPanelBody chat={chat} isContentRedacted={isContentRedacted} />
      ) : activeTab === 'scheduled' && canReadSchedules ? (
        <ScheduledPanelBody
          chat={chat}
          isContentRedacted={isContentRedacted}
          onOpenCreateSchedule={onOpenCreateSchedule}
        />
      ) : null}
    </aside>
  );
}
