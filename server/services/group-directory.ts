import {extractGowaArray} from '../../shared/gowa-payload.ts';
import {gowaFetch, type GowaDevice} from '../gowa-client.ts';
import {normalizeWhatsAppJid} from './chat-sync.ts';

export interface RawGowaGroup {
  JID: string;
  OwnerJID?: string;
  Name?: string;
  Topic?: string;
  IsLocked?: boolean;
  IsAnnounce?: boolean;
  IsEphemeral?: boolean;
  IsJoinApprovalRequired?: boolean;
  GroupCreated?: string;
  ParticipantCount?: number;
  participant_count?: number;
  Participants?: unknown[];
  participants?: unknown[];
}

export interface RawGowaNewsletter {
  id: string;
  state?: {type?: string};
  thread_metadata?: {
    creation_time?: string;
    invite?: string;
    name?: {text?: string; id?: string; update_time?: string};
    description?: {text?: string; id?: string; update_time?: string};
    subscribers_count?: number;
    verification?: string;
    picture?: {url?: string; direct_path?: string; id?: string; type?: string};
    preview?: {url?: string; direct_path?: string; id?: string; type?: string};
  };
  viewer_metadata?: {
    mute?: string;
    role?: string;
  };
}

export function resolveGroupMemberCount(group: Partial<RawGowaGroup>): number {
  const explicitCount = Number(group.ParticipantCount ?? group.participant_count ?? 0);
  const safeExplicit = Number.isFinite(explicitCount) && explicitCount > 0 ? explicitCount : 0;
  const upperLen = Array.isArray(group.Participants) ? group.Participants.length : 0;
  const lowerLen = Array.isArray(group.participants) ? group.participants.length : 0;
  return Math.max(safeExplicit, upperLen, lowerLen);
}

interface CachedGroupMeta {
  count: number;
  patch?: Partial<RawGowaGroup>;
  expiresAt: number;
}

const GROUP_META_TTL_MS = 60_000;
const groupMetaCache = new Map<string, CachedGroupMeta>();
const backgroundEnrichInflight = new Set<string>();

export function invalidateGroupMetaCache(deviceId: string, groupId?: string): void {
  if (groupId) {
    groupMetaCache.delete(`${deviceId}::${groupId}`);
    return;
  }
  const prefix = `${deviceId}::`;
  for (const key of groupMetaCache.keys()) {
    if (key.startsWith(prefix)) groupMetaCache.delete(key);
  }
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let index = 0;
  const runners = Array.from({length: Math.min(limit, items.length)}, async () => {
    while (index < items.length) {
      const current = items[index++];
      await worker(current);
    }
  });
  await Promise.all(runners);
}

export function hydrateGroupsFromCache(
  deviceId: string,
  rawGroups: RawGowaGroup[],
): {groups: RawGowaGroup[]; missing: RawGowaGroup[]} {
  const now = Date.now();
  const missing: RawGowaGroup[] = [];
  const groups = rawGroups.map((g) => {
    const directCount = resolveGroupMemberCount(g);
    if (directCount > 0) {
      return {...g, ParticipantCount: directCount};
    }
    const cached = groupMetaCache.get(`${deviceId}::${g.JID}`);
    if (cached && cached.expiresAt > now) {
      return {
        ...g,
        ...cached.patch,
        ParticipantCount: cached.count,
      };
    }
    missing.push(g);
    return {...g, ParticipantCount: 0};
  });
  return {groups, missing};
}

export function scheduleBackgroundGroupEnrichment(deviceId: string, missing: RawGowaGroup[]): void {
  if (missing.length === 0 || backgroundEnrichInflight.has(deviceId)) return;
  backgroundEnrichInflight.add(deviceId);
  const batch = missing.slice(0, 30);
  void runWithConcurrency(batch, 3, async (g) => {
    const cacheKey = `${deviceId}::${g.JID}`;
    try {
      const info = await gowaFetch<RawGowaGroup | null>('/group/info', {
        deviceId,
        query: {group_id: g.JID},
        timeoutMs: 4_000,
      });
      let count = info ? resolveGroupMemberCount(info) : 0;
      if (count === 0) {
        const partRes = await gowaFetch<{participants?: unknown[]} | unknown[] | null>('/group/participants', {
          deviceId,
          query: {group_id: g.JID},
          timeoutMs: 4_000,
        }).catch(() => null);
        count = extractGowaArray(partRes, 'participants').length;
      }
      groupMetaCache.set(cacheKey, {
        count,
        patch: info
          ? {
              OwnerJID: info.OwnerJID ?? g.OwnerJID,
              Topic: info.Topic ?? g.Topic,
              IsLocked: info.IsLocked ?? g.IsLocked,
              IsAnnounce: info.IsAnnounce ?? g.IsAnnounce,
            }
          : undefined,
        expiresAt: Date.now() + GROUP_META_TTL_MS,
      });
    } catch {
      groupMetaCache.set(cacheKey, {
        count: 0,
        expiresAt: Date.now() + 20_000,
      });
    }
  }).finally(() => {
    backgroundEnrichInflight.delete(deviceId);
  });
}

export interface UnifiedDirectoryAccountRef {
  device_id: string;
  device_display_name: string;
  device_state: GowaDevice['state'];
}

export type UnifiedDirectoryEntry =
  | {
      kind: 'group';
      device_id: string;
      device_display_name: string;
      device_state: GowaDevice['state'];
      accounts?: UnifiedDirectoryAccountRef[];
      jid: string;
      name: string;
      participant_count: number;
      unread_count?: number;
      group: RawGowaGroup;
    }
  | {
      kind: 'newsletter';
      device_id: string;
      device_display_name: string;
      device_state: GowaDevice['state'];
      accounts?: UnifiedDirectoryAccountRef[];
      jid: string;
      name: string;
      subscribers_count: number;
      live_active: boolean;
      newsletter: RawGowaNewsletter;
    };

export function normalizeDirectoryJid(rawJid: string): string {
  const normalized = normalizeWhatsAppJid(rawJid);
  return (normalized || rawJid.trim()).toLowerCase();
}

function isFallbackJidName(name: string, jid: string): boolean {
  const trimmed = name.trim().toLowerCase();
  return !trimmed || trimmed === jid.trim().toLowerCase();
}

export function deduplicateUnifiedDirectoryItems(
  rawItems: UnifiedDirectoryEntry[],
): UnifiedDirectoryEntry[] {
  const byKey = new Map<string, UnifiedDirectoryEntry>();

  for (const rawItem of rawItems) {
    const canonicalJid = normalizeDirectoryJid(rawItem.jid);
    if (!canonicalJid) continue;

    const dedupKey = `${rawItem.kind}::${canonicalJid}`;
    const incomingAccounts: UnifiedDirectoryAccountRef[] =
      rawItem.accounts && rawItem.accounts.length > 0
        ? rawItem.accounts
        : [
            {
              device_id: rawItem.device_id,
              device_display_name: rawItem.device_display_name,
              device_state: rawItem.device_state,
            },
          ];

    const existing = byKey.get(dedupKey);
    if (!existing) {
      const uniqueAccounts = Array.from(
        new Map(incomingAccounts.map((acc) => [acc.device_id, acc])).values(),
      ).sort((a, b) => a.device_display_name.localeCompare(b.device_display_name, 'ar'));
      const primary = uniqueAccounts[0] ?? {
        device_id: rawItem.device_id,
        device_display_name: rawItem.device_display_name,
        device_state: rawItem.device_state,
      };
      byKey.set(dedupKey, {
        ...rawItem,
        jid: canonicalJid,
        device_id: primary.device_id,
        device_display_name: primary.device_display_name,
        device_state: primary.device_state,
        accounts: uniqueAccounts,
      });
      continue;
    }

    const accountMap = new Map<string, UnifiedDirectoryAccountRef>();
    for (const acc of existing.accounts ?? []) {
      accountMap.set(acc.device_id, acc);
    }
    for (const acc of incomingAccounts) {
      if (!accountMap.has(acc.device_id)) {
        accountMap.set(acc.device_id, acc);
      }
    }
    const mergedAccounts = Array.from(accountMap.values()).sort((a, b) =>
      a.device_display_name.localeCompare(b.device_display_name, 'ar'),
    );
    const primary = mergedAccounts[0] ?? {
      device_id: existing.device_id,
      device_display_name: existing.device_display_name,
      device_state: existing.device_state,
    };

    const existingHasRealName = !isFallbackJidName(existing.name, existing.jid);
    const incomingHasRealName = !isFallbackJidName(rawItem.name, canonicalJid);
    const mergedName =
      existingHasRealName || !incomingHasRealName ? existing.name : rawItem.name;

    if (existing.kind === 'group' && rawItem.kind === 'group') {
      const mergedCount = Math.max(existing.participant_count, rawItem.participant_count);
      const mergedUnread = (existing.unread_count ?? 0) + (rawItem.unread_count ?? 0);
      const preferIncomingGroup =
        (!existingHasRealName && incomingHasRealName) ||
        (!existing.group.Topic && Boolean(rawItem.group.Topic)) ||
        existing.participant_count < rawItem.participant_count;
      const baseGroup = preferIncomingGroup ? rawItem.group : existing.group;
      byKey.set(dedupKey, {
        ...existing,
        device_id: primary.device_id,
        device_display_name: primary.device_display_name,
        device_state: primary.device_state,
        accounts: mergedAccounts,
        name: mergedName,
        participant_count: mergedCount,
        unread_count: mergedUnread,
        group: {
          ...baseGroup,
          JID: baseGroup.JID || canonicalJid,
          Name: existingHasRealName ? existing.group.Name || mergedName : mergedName,
          Topic: existing.group.Topic || rawItem.group.Topic,
          ParticipantCount: mergedCount,
        },
      });
    } else if (existing.kind === 'newsletter' && rawItem.kind === 'newsletter') {
      const mergedSubs = Math.max(existing.subscribers_count, rawItem.subscribers_count);
      const preferIncomingNl =
        (!existingHasRealName && incomingHasRealName) ||
        existing.subscribers_count < rawItem.subscribers_count;
      byKey.set(dedupKey, {
        ...existing,
        device_id: primary.device_id,
        device_display_name: primary.device_display_name,
        device_state: primary.device_state,
        accounts: mergedAccounts,
        name: mergedName,
        subscribers_count: mergedSubs,
        live_active: existing.live_active || rawItem.live_active,
        newsletter: preferIncomingNl ? rawItem.newsletter : existing.newsletter,
      });
    }
  }

  return Array.from(byKey.values());
}
