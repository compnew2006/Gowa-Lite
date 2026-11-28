import type {ScheduledSend} from '@/api/types';

// Scheduled sends that still belong in the chat timeline: waiting to run,
// running now, or paused. Completed ones are replaced by the sent message
// arriving over WS; cancelled/failed ones leave the timeline.
const VISIBLE_STATUSES = new Set(['active', 'running', 'paused']);

export interface ScheduledTimelineEntry {
  key: string;
  timestamp: string;
  timestampMs: number;
  item: ScheduledSend;
}

export function scheduledTimelineTimestamp(item: ScheduledSend): string {
  return item.next_run_at || item.scheduled_at;
}

// Same content fallback the schedules drawer uses, plus the `message`
// field the gateway record can carry.
export function scheduledBubbleText(item: ScheduledSend): string {
  return item.content || item.message || item.caption || item.filename || '—';
}

export function buildScheduledTimelineEntries(
  items: ScheduledSend[],
): ScheduledTimelineEntry[] {
  return items
    .filter((item) => VISIBLE_STATUSES.has(item.status))
    .map((item) => {
      const timestamp = scheduledTimelineTimestamp(item);
      return {
        key: `sched:${item.id}`,
        timestamp,
        timestampMs: Date.parse(timestamp) || 0,
        item,
      };
    })
    .sort((a, b) => a.timestampMs - b.timestampMs);
}
