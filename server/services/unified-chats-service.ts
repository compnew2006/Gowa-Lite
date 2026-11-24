import {
  clearChatCatchup,
  getUnreadCountsForUser,
  parseTimestampMs,
  syncChatWatermarks,
  upsertCachedMessages,
  type PublicUser,
} from '../db.ts';
import {
  GowaError,
  gowaFetch,
  type GowaDevice,
  type GowaChatInfo,
  type GowaMessageInfo,
  type GowaPagination,
} from '../gowa-client.ts';
import {hasDeviceAccess, hasPermission, isAdminSubject} from '../rbac.ts';
import {
  getAssignmentStatsForDevices,
  getChatLifecycleMap,
  handleIncomingCustomerMessageLifecycle,
  listAssignmentsForDevices,
  listDbChatsByLifecycleStatus,
  syncAssignmentMetadataFromChats,
  type ChatAssignmentInfo,
  type UnifiedChatTab,
  type UnifiedTabCounts,
} from './chat-lifecycle.ts';
import {
  isNewsletterJid,
  isStatusBroadcastJid,
  matchesUnifiedChatSearch,
  normalizePhoneQueryForGowa,
  resolveAccountDisplayName,
} from './chat-sync.ts';
import type {GowaWsBridge} from '../ws-bridge.ts';

const VALID_UNIFIED_TABS = new Set<UnifiedChatTab>(['all', 'me', 'pending', 'closed']);

export type RemoteUnifiedChat = GowaChatInfo & {
  device_id: string;
  device_display_name: string;
  device_state: GowaDevice['state'];
};

export interface ParsedUnifiedChatsQuery {
  selectedDeviceSet: Set<string>;
  rawSearch: string;
  search: string;
  isSearchMode: boolean;
  hasMedia: boolean;
  limit: number;
  offset: number;
  requestedTab?: UnifiedChatTab;
  assignedFilterUserId?: number | null;
  isSupervisor: boolean;
}

export function parseUnifiedChatsQuery(
  query: Record<string, unknown>,
  user: PublicUser,
): ParsedUnifiedChatsQuery {
  const filterDeviceId = typeof query.deviceId === 'string' ? query.deviceId.trim() : '';
  const filterDeviceIdsRaw = typeof query.deviceIds === 'string' ? query.deviceIds.trim() : '';
  const rawSearch = typeof query.search === 'string' ? query.search : '';
  const search = normalizePhoneQueryForGowa(rawSearch);
  const hasMedia = query.has_media === 'true';
  const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 100);
  const offset = Math.max(Number(query.offset) || 0, 0);

  const rawTab = typeof query.tab === 'string' ? query.tab.trim().toLowerCase() : '';
  let requestedTab: UnifiedChatTab | undefined;
  if (rawTab) {
    if (!VALID_UNIFIED_TABS.has(rawTab as UnifiedChatTab)) {
      throw new GowaError(
        400,
        'VALIDATION_ERROR',
        'قيمة التبويب غير صالحة (المسموح: all, me, pending, closed)',
      );
    }
    requestedTab = rawTab as UnifiedChatTab;
  }

  const rawAssignedTo =
    typeof query.assignedTo === 'string' ? query.assignedTo.trim().toLowerCase() : '';
  let assignedFilterUserId: number | null | undefined;
  if (rawAssignedTo) {
    if (rawAssignedTo === 'me') {
      assignedFilterUserId = user.id;
    } else if (rawAssignedTo === 'all') {
      assignedFilterUserId = null;
    } else {
      const parsedId = Number(rawAssignedTo);
      if (!Number.isInteger(parsedId) || parsedId <= 0) {
        throw new GowaError(400, 'VALIDATION_ERROR', 'معامل assignedTo غير صالح');
      }
      assignedFilterUserId = parsedId;
    }
  }

  const isSupervisor = isAdminSubject(user) || hasPermission(user, 'chats', 'view_all');
  if (!isSupervisor && (requestedTab === 'all' || requestedTab === 'closed')) {
    throw new GowaError(403, 'FORBIDDEN', 'غير مصرح لك بعرض تبويب الكل أو المحادثات المغلقة');
  }
  if (!isSupervisor && assignedFilterUserId !== undefined && assignedFilterUserId !== user.id) {
    throw new GowaError(403, 'FORBIDDEN', 'غير مصرح لك بعرض محادثات وكيل آخر');
  }

  const selectedDeviceSet = new Set<string>();
  if (filterDeviceIdsRaw) {
    for (const part of filterDeviceIdsRaw.split(',')) {
      const clean = part.trim();
      if (clean) selectedDeviceSet.add(clean);
    }
  }
  if (filterDeviceId) selectedDeviceSet.add(filterDeviceId);
  for (const requestedId of selectedDeviceSet) {
    if (!hasDeviceAccess(user, requestedId)) {
      throw new GowaError(403, 'DEVICE_FORBIDDEN', 'غير مصرح لك بالوصول إلى حساب واتساب هذا');
    }
  }

  return {
    selectedDeviceSet,
    rawSearch,
    search,
    isSearchMode: Boolean(rawSearch.trim()),
    hasMedia,
    limit,
    offset,
    requestedTab,
    assignedFilterUserId,
    isSupervisor,
  };
}

async function fetchSingleDeviceChats(params: {
  dev: GowaDevice;
  displayName: string;
  query: ParsedUnifiedChatsQuery;
  remoteFetchOffset: number;
}): Promise<{chats: RemoteUnifiedChat[]; totalRemote: number; hasMore: boolean}> {
  const {dev, displayName, query, remoteFetchOffset} = params;
  const chats: RemoteUnifiedChat[] = [];

  if (!query.isSearchMode) {
    const response = await gowaFetch<{data: GowaChatInfo[]; pagination: GowaPagination}>('/chats', {
      deviceId: dev.id,
      query: {limit: query.limit, offset: remoteFetchOffset, has_media: query.hasMedia ? true : undefined},
    });
    const items = response?.data ?? [];
    let excludedSkipped = 0;
    for (const chat of items) {
      if (isNewsletterJid(chat.jid) || isStatusBroadcastJid(chat.jid)) {
        excludedSkipped += 1;
        continue;
      }
      chats.push({...chat, device_id: dev.id, device_display_name: displayName, device_state: dev.state});
    }
    const rawTotal = response?.pagination?.total ?? 0;
    const totalRemote = rawTotal > 0 ? Math.max(chats.length, rawTotal - excludedSkipped) : chats.length;
    const hasMore =
      rawTotal > 0 ? remoteFetchOffset + items.length < rawTotal : items.length >= query.limit;
    return {chats, totalRemote, hasMore};
  }

  const byJid = new Map<string, GowaChatInfo>();
  const directHitJids = new Set<string>();
  const PAGE_LIMIT = 100;
  const MAX_SCAN_CHATS = 1000;

  const [directSearchRes, contactsRes] = await Promise.all([
    query.search
      ? gowaFetch<{data: GowaChatInfo[]; pagination: GowaPagination}>('/chats', {
          deviceId: dev.id,
          query: {limit: 100, offset: 0, search: query.search, has_media: query.hasMedia ? true : undefined},
        }).catch(() => null)
      : Promise.resolve(null),
    gowaFetch<{data?: Array<{jid?: string; name?: string}>} | null>('/user/my/contacts', {
      deviceId: dev.id,
      timeoutMs: 4_000,
    }).catch(() => null),
  ]);

  for (const chat of directSearchRes?.data ?? []) {
    byJid.set(chat.jid, chat);
    directHitJids.add(chat.jid);
  }
  const contactNameByJid = new Map<string, string>();
  for (const c of contactsRes?.data ?? []) {
    if (c.jid && c.name) contactNameByJid.set(c.jid, c.name);
  }

  for (let scanOffset = 0; scanOffset < MAX_SCAN_CHATS; scanOffset += PAGE_LIMIT) {
    const page = await gowaFetch<{data: GowaChatInfo[]; pagination: GowaPagination}>('/chats', {
      deviceId: dev.id,
      query: {limit: PAGE_LIMIT, offset: scanOffset, has_media: query.hasMedia ? true : undefined},
    });
    const items = page?.data ?? [];
    for (const chat of items) {
      if (!byJid.has(chat.jid)) byJid.set(chat.jid, chat);
    }
    const total = page?.pagination?.total ?? 0;
    if (items.length < PAGE_LIMIT || (total > 0 && scanOffset + items.length >= total)) break;
  }

  for (const chat of byJid.values()) {
    if (isNewsletterJid(chat.jid) || isStatusBroadcastJid(chat.jid)) continue;
    const contactName = contactNameByJid.get(chat.jid);
    if (
      directHitJids.has(chat.jid) ||
      matchesUnifiedChatSearch(chat, displayName, query.rawSearch, contactName)
    ) {
      chats.push({
        ...chat,
        name: chat.name?.trim() || contactName || chat.name,
        device_id: dev.id,
        device_display_name: displayName,
        device_state: dev.state,
      });
    }
  }
  return {chats, totalRemote: chats.length, hasMore: false};
}

export async function fetchRemoteChatsForDevices(params: {
  targetDevices: GowaDevice[];
  aliases: Record<string, string>;
  query: ParsedUnifiedChatsQuery;
}): Promise<{
  allChats: RemoteUnifiedChat[];
  totalRemoteChats: number;
  anyDeviceHasMore: boolean;
  deviceErrors: Array<{device_id: string; display_name: string; message: string}>;
}> {
  const {targetDevices, aliases, query} = params;
  const allChats: RemoteUnifiedChat[] = [];
  const deviceErrors: Array<{device_id: string; display_name: string; message: string}> = [];
  let totalRemoteChats = 0;
  let anyDeviceHasMore = false;
  const remoteFetchOffset =
    query.requestedTab === 'closed' || (query.requestedTab === 'me' && !query.hasMedia)
      ? 0
      : query.offset;

  await Promise.all(
    targetDevices.map(async (dev) => {
      const displayName = resolveAccountDisplayName(dev, aliases);
      if (dev.state !== 'logged_in' && dev.state !== 'connected') return;
      try {
        const res = await fetchSingleDeviceChats({dev, displayName, query, remoteFetchOffset});
        allChats.push(...res.chats);
        totalRemoteChats += res.totalRemote;
        if (res.hasMore) anyDeviceHasMore = true;
      } catch (err) {
        if (query.requestedTab !== 'closed') {
          const msg = err instanceof GowaError ? err.message : 'تعذر جلب المحادثات';
          deviceErrors.push({device_id: dev.id, display_name: displayName, message: msg});
        }
      }
    }),
  );

  return {allChats, totalRemoteChats, anyDeviceHasMore, deviceErrors};
}

export function sortChatsDesc(list: RemoteUnifiedChat[]): void {
  list.sort((a, b) => {
    const ta = new Date(a.last_message_time).getTime();
    const tb = new Date(b.last_message_time).getTime();
    const validA = Number.isNaN(ta) || ta <= 0 ? 0 : ta;
    const validB = Number.isNaN(tb) || tb <= 0 ? 0 : tb;
    return validB - validA;
  });
}

export function computeUnifiedTabCounts(params: {
  targetDeviceIds: string[];
  allChats: RemoteUnifiedChat[];
  assignmentsMap: Map<string, ChatAssignmentInfo>;
  remoteByKey: Map<string, RemoteUnifiedChat>;
  totalRemoteChats: number;
  anyDeviceHasMore: boolean;
  skipRemoteScan: boolean;
  effectiveMeOwnerId: number | null;
  query: ParsedUnifiedChatsQuery;
}): UnifiedTabCounts {
  const {
    targetDeviceIds,
    allChats,
    assignmentsMap,
    remoteByKey,
    totalRemoteChats,
    anyDeviceHasMore,
    skipRemoteScan,
    effectiveMeOwnerId,
    query,
  } = params;

  let dbClosedCount = 0;
  let dbMeOpenCount = 0;
  if (skipRemoteScan) {
    const stats = getAssignmentStatsForDevices(targetDeviceIds, effectiveMeOwnerId);
    dbClosedCount = stats.closed;
    dbMeOpenCount = stats.meOpen;
  } else {
    for (const row of assignmentsMap.values()) {
      if (isNewsletterJid(row.chat_jid) || isStatusBroadcastJid(row.chat_jid)) continue;
      if (row.status === 'closed') {
        dbClosedCount += 1;
      } else if (row.status === 'open') {
        if (effectiveMeOwnerId === null || row.assigned_user_id === effectiveMeOwnerId) {
          dbMeOpenCount += 1;
        }
      }
    }
  }

  let remotePendingInFetched = 0;
  let remoteOpenInFetched = 0;
  let remoteClosedInFetched = 0;
  for (const chat of allChats) {
    const st = assignmentsMap.get(`${chat.device_id}::${chat.jid}`)?.status ?? 'pending';
    if (st === 'closed') remoteClosedInFetched += 1;
    else if (st === 'open') remoteOpenInFetched += 1;
    else remotePendingInFetched += 1;
  }

  const effectiveTotalRemote = Math.max(totalRemoteChats, allChats.length);
  const remoteScannedCompletely =
    !skipRemoteScan &&
    !anyDeviceHasMore &&
    (query.offset === 0 ||
      query.isSearchMode ||
      query.requestedTab === 'closed' ||
      query.requestedTab === 'me');

  // When remote wasn't scanned completely, subtract only confirmed remote open/closed chats
  // so archived DB-only closed chats cannot undercount pending remote chats.
  const pendingCount = remoteScannedCompletely
    ? remotePendingInFetched
    : Math.max(
        remotePendingInFetched,
        effectiveTotalRemote - remoteOpenInFetched - remoteClosedInFetched,
      );

  let dbClosedExtraNotInRemote = 0;
  let dbOpenExtraNotInRemote = 0;
  if (remoteScannedCompletely) {
    for (const [key, row] of assignmentsMap.entries()) {
      if (isNewsletterJid(row.chat_jid) || isStatusBroadcastJid(row.chat_jid)) continue;
      if (remoteByKey.has(key)) continue;
      if (row.status === 'closed') dbClosedExtraNotInRemote += 1;
      else if (row.status === 'open') dbOpenExtraNotInRemote += 1;
    }
  } else {
    dbClosedExtraNotInRemote = Math.max(0, dbClosedCount - remoteClosedInFetched);
  }

  return {
    all: query.isSupervisor
      ? effectiveTotalRemote + dbClosedExtraNotInRemote + dbOpenExtraNotInRemote
      : 0,
    me: dbMeOpenCount,
    pending: pendingCount,
    closed: query.isSupervisor ? dbClosedCount : 0,
  };
}

export function paginateUnifiedChats(params: {
  query: ParsedUnifiedChatsQuery;
  userId: number;
  targetDeviceIds: string[];
  deviceInfoMap: Map<string, {device: GowaDevice; displayName: string}>;
  allChats: RemoteUnifiedChat[];
  remoteByKey: Map<string, RemoteUnifiedChat>;
  assignmentsMap: Map<string, ChatAssignmentInfo>;
  tabCounts: UnifiedTabCounts;
  totalRemoteChats: number;
  anyDeviceHasMore: boolean;
  effectiveMeOwnerId: number | null;
}): {pagedChats: RemoteUnifiedChat[]; totalAvailable: number; hasMore: boolean} {
  const {
    query,
    userId,
    targetDeviceIds,
    deviceInfoMap,
    allChats,
    remoteByKey,
    assignmentsMap,
    tabCounts,
    totalRemoteChats,
    anyDeviceHasMore,
    effectiveMeOwnerId,
  } = params;

  const buildFromDbEntries = (
    status: 'closed' | 'open',
    ownerUserId?: number | null,
    dbLimit?: number,
    dbOffset?: number,
  ) => {
    const entries = listDbChatsByLifecycleStatus({
      deviceIds: targetDeviceIds,
      status,
      assignedUserId: ownerUserId ?? undefined,
      limit: dbLimit,
      offset: dbOffset,
    });
    const merged: RemoteUnifiedChat[] = [];
    for (const entry of entries) {
      const key = `${entry.device_id}::${entry.jid}`;
      const remote = remoteByKey.get(key);
      if (query.hasMedia && !remote) continue;

      const info = deviceInfoMap.get(entry.device_id);
      const displayName = info?.displayName ?? entry.device_id;
      const candidate: RemoteUnifiedChat = remote
        ? {
            ...remote,
            name: remote.name?.trim() || entry.name,
            last_message_time: remote.last_message_time || entry.last_message_time,
          }
        : {
            jid: entry.jid,
            name: entry.name,
            last_message_time: entry.last_message_time,
            ephemeral_expiration: 0,
            created_at: entry.assignment.assigned_at ?? entry.assignment.closed_at ?? '',
            updated_at: entry.last_message_time,
            archived: false,
            device_id: entry.device_id,
            device_display_name: displayName,
            device_state: info?.device.state ?? 'disconnected',
          };

      if (query.isSearchMode && !matchesUnifiedChatSearch(candidate, displayName, query.rawSearch)) {
        continue;
      }
      merged.push(candidate);
    }
    sortChatsDesc(merged);
    return merged;
  };

  const canDirectSqlPaginate = !query.isSearchMode && !query.hasMedia;
  if (query.requestedTab === 'closed') {
    if (canDirectSqlPaginate) {
      const paged = buildFromDbEntries('closed', undefined, query.limit, query.offset);
      return {
        pagedChats: paged,
        totalAvailable: tabCounts.closed,
        hasMore: query.offset + paged.length < tabCounts.closed,
      };
    }
    const list = buildFromDbEntries('closed');
    const paged = list.slice(query.offset, query.offset + query.limit);
    return {pagedChats: paged, totalAvailable: list.length, hasMore: query.offset + paged.length < list.length};
  }

  if (query.requestedTab === 'me') {
    if (canDirectSqlPaginate) {
      const paged = buildFromDbEntries('open', effectiveMeOwnerId, query.limit, query.offset);
      return {
        pagedChats: paged,
        totalAvailable: tabCounts.me,
        hasMore: query.offset + paged.length < tabCounts.me,
      };
    }
    const list = buildFromDbEntries('open', effectiveMeOwnerId);
    const paged = list.slice(query.offset, query.offset + query.limit);
    return {pagedChats: paged, totalAvailable: list.length, hasMore: query.offset + paged.length < list.length};
  }

  sortChatsDesc(allChats);
  if (query.requestedTab === 'pending') {
    const list = allChats.filter(
      (chat) => (assignmentsMap.get(`${chat.device_id}::${chat.jid}`)?.status ?? 'pending') === 'pending',
    );
    if (query.isSearchMode) {
      const paged = list.slice(query.offset, query.offset + query.limit);
      return {pagedChats: paged, totalAvailable: list.length, hasMore: query.offset + paged.length < list.length};
    }
    return {
      pagedChats: list,
      totalAvailable: Math.max(tabCounts.pending, query.offset + list.length),
      hasMore: anyDeviceHasMore,
    };
  }

  const visibleList = query.isSupervisor
    ? allChats
    : allChats.filter((chat) => {
        const a = assignmentsMap.get(`${chat.device_id}::${chat.jid}`);
        if (!a || a.status === 'pending') return true;
        return a.status === 'open' && a.assigned_user_id === userId;
      });
  if (query.isSearchMode) {
    const paged = visibleList.slice(query.offset, query.offset + query.limit);
    return {
      pagedChats: paged,
      totalAvailable: visibleList.length,
      hasMore: query.offset + paged.length < visibleList.length,
    };
  }
  return {
    pagedChats: visibleList,
    totalAvailable: query.isSupervisor
      ? Math.max(totalRemoteChats, query.offset + visibleList.length)
      : Math.max(tabCounts.pending + tabCounts.me, query.offset + visibleList.length),
    hasMore: anyDeviceHasMore,
  };
}

export async function runInitialUnreadCatchup(params: {
  pagedChats: RemoteUnifiedChat[];
  devices: GowaDevice[];
  user: PublicUser;
  wsBridge: GowaWsBridge;
}): Promise<void> {
  const {pagedChats, devices, user, wsBridge} = params;
  const pendingCatchups = syncChatWatermarks(
    pagedChats.map((c) => ({
      device_id: c.device_id,
      chat_jid: c.jid,
      last_message_time: c.last_message_time,
    })),
  );
  if (pendingCatchups.length === 0) return;

  const onlineDeviceSet = new Set(
    devices.filter((d) => d.state === 'logged_in' || d.state === 'connected').map((d) => d.id),
  );
  const targetCatchups = pendingCatchups
    .filter((item) => onlineDeviceSet.has(item.device_id) && hasDeviceAccess(user, item.device_id))
    .slice(0, 10);

  await Promise.all(
    targetCatchups.map(async (changed) => {
      try {
        const latest = await gowaFetch<{data: GowaMessageInfo[]}>(
          `/chat/${encodeURIComponent(changed.chat_jid)}/messages`,
          {deviceId: changed.device_id, query: {limit: 15, offset: 0}, timeoutMs: 3_500},
        );
        if (latest?.data?.length) {
          upsertCachedMessages(changed.device_id, changed.chat_jid, latest.data, {
            markUnreadCandidate: true,
            minUnreadTimestampMs: changed.prev_last_message_ms,
          });
          let latestCustomerMs = 0;
          for (const msg of latest.data) {
            if (msg.is_from_me) continue;
            const ms = parseTimestampMs(msg.timestamp);
            if (ms > changed.prev_last_message_ms && ms > latestCustomerMs) {
              latestCustomerMs = ms;
            }
          }
          if (latestCustomerMs > 0) {
            const reopenEvent = handleIncomingCustomerMessageLifecycle(
              changed.device_id,
              changed.chat_jid,
              latestCustomerMs,
            );
            if (reopenEvent) wsBridge.broadcast(reopenEvent);
          }
        }
        clearChatCatchup(changed.device_id, changed.chat_jid);
      } catch {
        // Keep needs_catchup = 1 so the next poll automatically retries
      }
    }),
  );
}

export function enrichUnifiedChatsWithUnreadAndLifecycle(params: {
  user: PublicUser;
  pagedChats: RemoteUnifiedChat[];
  assignmentsMap: Map<string, ChatAssignmentInfo>;
}) {
  const {user, pagedChats, assignmentsMap} = params;
  const chatKeys = pagedChats.map((c) => ({device_id: c.device_id, chat_jid: c.jid}));
  const unreadByChat = getUnreadCountsForUser(user, chatKeys);
  const missingLifecycleKeys = chatKeys.filter(
    (k) => !assignmentsMap.has(`${k.device_id}::${k.chat_jid}`),
  );
  const lifecycleByChat: Map<string, ChatAssignmentInfo> =
    missingLifecycleKeys.length > 0 ? getChatLifecycleMap(missingLifecycleKeys) : new Map();

  let totalUnread = 0;
  const enrichedChats = pagedChats.map((chat) => {
    const key = `${chat.device_id}::${chat.jid}`;
    const unreadCount = unreadByChat.get(key) ?? 0;
    const assignment = lifecycleByChat.get(key) ?? assignmentsMap.get(key);
    totalUnread += unreadCount;
    return {
      ...chat,
      unread_count: unreadCount,
      lifecycle: {
        status: assignment?.status ?? 'pending',
        assigned_user_id: assignment?.assigned_user_id ?? null,
        assigned_user_name: assignment?.assigned_user_name ?? null,
        closed_by_id: assignment?.closed_by_id ?? null,
        closed_by_name: assignment?.closed_by_name ?? null,
        closed_at: assignment?.closed_at ?? null,
        close_reason: assignment?.close_reason ?? '',
      },
    };
  });

  return {enrichedChats, totalUnread};
}

export function refreshAssignmentsAfterRemoteFetch(
  allChats: RemoteUnifiedChat[],
  assignmentsMap: Map<string, ChatAssignmentInfo>,
  targetDeviceIds: string[],
): Map<string, ChatAssignmentInfo> {
  if (allChats.length === 0) return assignmentsMap;
  syncAssignmentMetadataFromChats(
    allChats.map((c) => ({
      device_id: c.device_id,
      chat_jid: c.jid,
      name: c.name,
      last_message_time: c.last_message_time,
    })),
    assignmentsMap,
  );
  return listAssignmentsForDevices(targetDeviceIds);
}
