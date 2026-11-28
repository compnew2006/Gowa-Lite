import type {ChatLifecycleEvent} from '@/api/contracts/workflow';
import {formatDate} from '@/lib/format';
import {useI18n} from '@/lib/i18n';

export function formatLifecycleEventText(
  event: ChatLifecycleEvent,
  t: ReturnType<typeof useI18n>['t'],
): string {
  const actor = event.actor_name || '';
  const target = event.target_name || '—';
  switch (event.event_type) {
    case 'claimed':
      return t.chats.timelineEvents.claimed(actor || '—');
    case 'auto_claimed':
      return t.chats.timelineEvents.auto_claimed(actor || '—');
    case 'assigned':
      return t.chats.timelineEvents.assigned(actor || '—', target);
    case 'transferred':
      return t.chats.timelineEvents.transferred(actor || '—', target);
    case 'released':
      return t.chats.timelineEvents.released(actor || '—');
    case 'closed':
      return t.chats.timelineEvents.closed(actor || '—');
    case 'reopened':
      return t.chats.timelineEvents.reopened(actor || '—', event.target_name || undefined);
    case 'reopened_by_customer':
      return t.chats.timelineEvents.reopened_by_customer;
    case 'note_added':
      return t.chats.timelineEvents.note_added(actor || '—');
    case 'note_edited':
      return t.chats.timelineEvents.note_edited(actor || '—');
    case 'note_deleted':
      return t.chats.timelineEvents.note_deleted(actor || '—');
    case 'schedule_created':
      return t.chats.timelineEvents.schedule_created(actor || '—');
    case 'schedule_paused':
      return t.chats.timelineEvents.schedule_paused(actor || '—');
    case 'schedule_resumed':
      return t.chats.timelineEvents.schedule_resumed(actor || '—');
    case 'schedule_cancelled':
      return t.chats.timelineEvents.schedule_cancelled(actor || '—');
    case 'message_revoked':
      return t.chats.timelineEvents.message_revoked(actor || '—');
    case 'message_edited':
      return t.chats.timelineEvents.message_edited(actor);
    case 'rating_submitted':
      // The score travels in the event note (a bare digit); it is already
      // part of the line text, so the note sub-line below stays hidden.
      return t.chats.timelineEvents.rating_submitted(actor, event.note || undefined);
  }
}

/**
 * P2-11: one system line in the chat timeline. The actor and the FULL
 * date-time (date + time, e.g. "28 نوفمبر 2026، 10:57 ص") live inside the
 * line itself for every event — the eight old lifecycle transitions and
 * the nine new action events alike. Previously the line showed only
 * formatShortTime (time-only for today, date-only otherwise).
 */
export function LifecycleTimelineLine({event}: {event: ChatLifecycleEvent}) {
  const {lang, t} = useI18n();
  const showNote = Boolean(event.note) && event.event_type !== 'rating_submitted';
  return (
    <div className="mx-auto my-0.5 flex w-full max-w-4xl justify-center px-4 sm:px-8 lg:px-14">
      <div className="max-w-md rounded-lg border border-border/80 bg-card/90 px-3 py-1 text-center text-[11px] text-muted-foreground shadow-2xs">
        <span>{formatLifecycleEventText(event, t)}</span>
        <span className="ms-1.5 text-[10px] opacity-75 tabular-nums">
          {formatDate(event.created_at, lang)}
        </span>
        {showNote && (
          <p className="mt-0.5 text-[10px] text-foreground/80">{event.note}</p>
        )}
      </div>
    </div>
  );
}
