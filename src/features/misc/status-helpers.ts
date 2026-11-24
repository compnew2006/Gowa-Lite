import type {DeviceState, UnifiedStatusItem} from '@/api/types';
import {matchesNormalizedQuery} from '@/lib/phone';

export interface StatusContactGroup {
  key: string;
  device_id: string;
  device_display_name: string;
  device_state: DeviceState;
  sender_jid: string;
  sender_display_name: string;
  latest_timestamp: string;
  items: UnifiedStatusItem[];
}

function toEpochMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

export function groupStatusesByContact(
  items: ReadonlyArray<UnifiedStatusItem>,
): StatusContactGroup[] {
  const byKey = new Map<string, StatusContactGroup>();

  for (const item of items) {
    if (!item || !item.device_id || !item.id) continue;
    const senderIdentity = (item.sender_jid || (item.is_from_me ? 'me' : item.id))
      .trim()
      .toLowerCase();
    const key = `${item.device_id}::${senderIdentity}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, {
        key,
        device_id: item.device_id,
        device_display_name: item.device_display_name || item.device_id,
        device_state: item.device_state,
        sender_jid: item.sender_jid || '',
        sender_display_name: item.sender_display_name || item.sender_jid || item.device_display_name,
        latest_timestamp: item.timestamp,
        items: [item],
      });
      continue;
    }

    existing.items.push(item);
    if (toEpochMs(item.timestamp) > toEpochMs(existing.latest_timestamp)) {
      existing.latest_timestamp = item.timestamp;
    }
    if (
      item.sender_display_name &&
      existing.sender_display_name === existing.sender_jid
    ) {
      existing.sender_display_name = item.sender_display_name;
    }
  }

  const groups = Array.from(byKey.values());
  for (const group of groups) {
    group.items.sort((a, b) => toEpochMs(b.timestamp) - toEpochMs(a.timestamp));
  }
  groups.sort((a, b) => toEpochMs(b.latest_timestamp) - toEpochMs(a.latest_timestamp));
  return groups;
}

export function filterStatusGroups(
  groups: ReadonlyArray<StatusContactGroup>,
  accountFilter: string,
  search: string,
): StatusContactGroup[] {
  const trimmedSearch = search.trim();
  return groups.filter((group) => {
    if (accountFilter !== 'all' && group.device_id !== accountFilter) {
      return false;
    }
    if (!trimmedSearch) return true;
    return matchesNormalizedQuery(
      [
        group.sender_display_name,
        group.sender_jid,
        group.device_display_name,
        ...group.items.map((item) => item.content),
      ],
      trimmedSearch,
    );
  });
}
