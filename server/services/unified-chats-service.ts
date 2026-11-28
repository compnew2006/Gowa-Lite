import {
  clearChatCatchup,
  getChatDeviceStatesMap,
  getChatsMessagePresenceMap,
  getLastMessagePreviews,
  getUnreadCountsForUser,
  getUserChatListMemberships,
  getUserChatPreferencesMap,
  parseTimestampMs,
  setChatMessagePresence,
  syncChatWatermarks,
  upsertCachedMessages,
  type ChatDeviceState,
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
  buildCloseRatingUpdatedEvent,
  captureChatCloseRating,
  hasPendingChatCloseRating,
} from './chat-close-rating.ts';
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
  isExcludedFromUnifiedChats,
  matchesUnifiedChatSearch,
  normalizePhoneQueryForGowa,
  resolveAccountDisplayName,
} from './chat-sync.ts';
import type {GowaWsBridge} from '../ws-bridge.ts';

const VALID_UNIFIED_TABS = new Set<UnifiedChatTab>(['all', 'me', 'open', 'pending', 'closed']);

export type RemoteUnifiedChat = GowaChatInfo & {
  device_id: string;
  device_display_name: string;
  device_state: GowaDevice['state'];
  is_pinned?: boolean;
  pinned_at_ms?: number;
  is_blocked?: boolean;
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
        'قيمة التبويب غير صالحة (المسموح: all, me, open, pending, closed)',
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
  if (!isSupervisor && requestedTab === 'all') {
    throw new GowaError(403, 'FORBIDDEN', 'غير مصرح لك بعرض تبويب الكل');
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

function applyChatDeviceStateToRemote(
  chat: GowaChatInfo,
  deviceId: string,
  displayName: string,
  deviceState: GowaDevice['state'],
  state: ChatDeviceState | undefined,
): RemoteUnifiedChat | null {
  if (state && state.deleted_before_ms > 0) {
    const lastMs = parseTimestampMs(chat.last_message_time);
    if (lastMs <= state.deleted_before_ms) {
      return null;
    }
  }
  const effectiveArchived =
    state?.archived_override !== null && state?.archived_override !== undefined
      ? state.archived_override
      : Boolean(chat.archived);
  return {
    ...chat,
    archived: effectiveArchived,
    device_id: deviceId,
    device_display_name: displayName,
    device_state: deviceState,
    is_pinned: Boolean(state?.is_pinned),
    pinned_at_ms: state?.pinned_at_ms ?? 0,
    is_blocked: Boolean(state?.is_blocked),
  };
}

async function fetchSingleDeviceChats(params: {
  dev: GowaDevice;
  displayName: string;
  query: ParsedUnifiedChatsQuery;
  remoteFetchOffset: number;
  deviceStatesMap: Map<string, ChatDeviceState>;
}): Promise<{chats: RemoteUnifiedChat[]; totalRemote: number; hasMore: boolean}> {
  const {dev, displayName, query, remoteFetchOffset, deviceStatesMap} = params;
  const chats: RemoteUnifiedChat[] = [];

  if (!query.isSearchMode) {
    const response = await gowaFetch<{data: GowaChatInfo[]; pagination: GowaPagination}>('/chats', {
      deviceId: dev.id,
      query: {limit: query.limit, offset: remoteFetchOffset, has_media: query.hasMedia ? true : undefined},
    });
    const items = response?.data ?? [];
    let excludedSkipped = 0;
    for (const chat of items) {
      if (isExcludedFromUnifiedChats(chat.jid)) {
        excludedSkipped += 1;
        continue;
      }
      const mapped = applyChatDeviceStateToRemote(
        chat,
        dev.id,
        displayName,
        dev.state,
        deviceStatesMap.get(`${dev.id}::${chat.jid}`),
      );
      if (!mapped) {
        excludedSkipped += 1;
        continue;
      }
      chats.push(mapped);
    }
    const rawTotal = response?.pagination?.total ?? 0;
    const totalRemote = rawTotal > 0 ? Math.max(chats.length, rawTotal - excludedSkipped) : chats.length;
    const hasMore =
      rawTotal > 0 ? remoteFetchOffset + items.length < rawTotal : items.length >= query.limit;
    return {chats, totalRemote, hasMore};
  }

  const isPhoneSearch = /^\d{3,}$/.test(query.search);
  const fetchContactNames = async () => {
    const contacts = await gowaFetch<{data?: Array<{jid?: string; name?: string}>}>('/user/my/contacts', {
      deviceId: dev.id,
      timeoutMs: 4_000,
    }).catch(() => null);
    const names = new Map<string, string>();
    for (const {jid, name} of contacts?.data ?? []) {
      if (jid && name) names.set(jid, name);
    }
    return names;
  };
  const pendingContactNames = isPhoneSearch ? null : fetchContactNames();
  const directSearchRes = query.search
    ? await gowaFetch<{data: GowaChatInfo[]; pagination: GowaPagination}>('/chats', {
        deviceId: dev.id,
        query: {limit: 100, offset: 0, search: query.search, has_media: query.hasMedia ? true : undefined},
      }).catch(() => null)
    : null;

  const directHits = new Map((directSearchRes?.data ?? []).map((chat) => [chat.jid, chat]));
  const mapVisibleChat = (chat: GowaChatInfo, contactName?: string) =>
    isExcludedFromUnifiedChats(chat.jid)
      ? null
      : applyChatDeviceStateToRemote(
          {...chat, name: chat.name?.trim() || contactName || chat.name},
          dev.id,
          displayName,
          dev.state,
          deviceStatesMap.get(`${dev.id}::${chat.jid}`),
        );

  if (isPhoneSearch) {
    const visibleHits = [...directHits.values()].map((chat) => mapVisibleChat(chat)).filter((chat) => chat !== null);
    if (visibleHits.length > 0) {
      if (visibleHits.some((chat) => !chat.name?.trim())) {
        const names = await fetchContactNames();
        for (const chat of visibleHits) {
          chat.name = chat.name?.trim() || names.get(chat.jid) || chat.name;
        }
      }
      return {chats: visibleHits, totalRemote: visibleHits.length, hasMore: false};
    }
  }

  const byJid = new Map(directHits);
  const contactNameByJid = await (pendingContactNames ?? fetchContactNames());

  const PAGE_LIMIT = 100;
  const MAX_SCAN_CHATS = 1000;
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
    const contactName = contactNameByJid.get(chat.jid);
    if (
      directHits.has(chat.jid) ||
      matchesUnifiedChatSearch(chat, displayName, query.rawSearch, contactName)
    ) {
      const mapped = mapVisibleChat(chat, contactName);
      if (mapped) chats.push(mapped);
    }
  }
  return {chats, totalRemote: chats.length, hasMore: false};
}

export async function fetchRemoteChatsForDevices(params: {
  targetDevices: GowaDevice[];
  aliases: Record<string, string>;
  query: ParsedUnifiedChatsQuery;
  deviceStatesMap?: Map<string, ChatDeviceState>;
}): Promise<{
  allChats: RemoteUnifiedChat[];
  totalRemoteChats: number;
  anyDeviceHasMore: boolean;
  deviceErrors: Array<{device_id: string; display_name: string; message: string}>;
}> {
  const {targetDevices, aliases, query} = params;
  const deviceStatesMap =
    params.deviceStatesMap ?? getChatDeviceStatesMap(targetDevices.map((d) => d.id));
  const allChats: RemoteUnifiedChat[] = [];
  const deviceErrors: Array<{device_id: string; display_name: string; message: string}> = [];
  let totalRemoteChats = 0;
  let anyDeviceHasMore = false;
  const remoteFetchOffset =
    query.requestedTab === 'closed' ||
    query.requestedTab === 'open' ||
    (query.requestedTab === 'me' && !query.hasMedia)
      ? 0
      : query.offset;

  await Promise.all(
    targetDevices.map(async (dev) => {
      const displayName = resolveAccountDisplayName(dev, aliases);
      if (dev.state !== 'logged_in' && dev.state !== 'connected') return;
      try {
        const res = await fetchSingleDeviceChats({
          dev,
          displayName,
          query,
          remoteFetchOffset,
          deviceStatesMap,
        });
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
    const pinDiff = (b.is_pinned ? 1 : 0) - (a.is_pinned ? 1 : 0);
    if (pinDiff !== 0) return pinDiff;
    if (a.is_pinned && b.is_pinned) {
      const pinTimeDiff = (b.pinned_at_ms ?? 0) - (a.pinned_at_ms ?? 0);
      if (pinTimeDiff !== 0) return pinTimeDiff;
    }
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
  userId?: number;
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
    userId,
    query,
  } = params;

  let dbClosedCount = 0;
  let dbMeOpenCount = 0;
  let dbAllOpenCount = 0;
  if (skipRemoteScan) {
    // Supervisors (null closed owner) count every closed row; agents count
    // only the chats they closed (closed_by_id).
    const stats = getAssignmentStatsForDevices(
      targetDeviceIds,
      effectiveMeOwnerId,
      query.isSupervisor ? null : (userId ?? effectiveMeOwnerId),
    );
    dbClosedCount = stats.closed;
    dbMeOpenCount = stats.meOpen;
    dbAllOpenCount = query.isSupervisor ? stats.allOpen : stats.meOpen;
  } else {
    for (const row of assignmentsMap.values()) {
      if (isExcludedFromUnifiedChats(row.chat_jid)) continue;
      if (row.status === 'closed') {
        // Closed rows have assigned_user_id NULL — filter on closed_by_id.
        if (query.isSupervisor || userId === undefined || row.closed_by_id === userId) {
          dbClosedCount += 1;
        }
      } else if (row.status === 'open' && row.assigned_user_id !== null) {
        if (query.isSupervisor || (userId !== undefined && row.assigned_user_id === userId) || effectiveMeOwnerId === null || row.assigned_user_id === effectiveMeOwnerId) {
          dbAllOpenCount += 1;
        }
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
      query.requestedTab === 'open' ||
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
      if (isExcludedFromUnifiedChats(row.chat_jid)) continue;
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
    open: dbAllOpenCount,
    pending: pendingCount,
    closed: dbClosedCount,
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

  const deviceStatesMap = getChatDeviceStatesMap(targetDeviceIds);

  const buildFromDbEntries = (
    status: 'closed' | 'open',
    ownerUserId?: number | null,
    dbLimit?: number,
    dbOffset?: number,
  ) => {
    const entries = listDbChatsByLifecycleStatus({
      deviceIds: targetDeviceIds,
      status,
      ownerUserId: ownerUserId ?? undefined,
      limit: dbLimit,
      offset: dbOffset,
    });
    const merged: RemoteUnifiedChat[] = [];
    for (const entry of entries) {
      const key = `${entry.device_id}::${entry.jid}`;
      const devState = deviceStatesMap.get(key);
      if (devState && devState.deleted_before_ms > 0) {
        const entryMs = parseTimestampMs(entry.last_message_time);
        if (entryMs <= devState.deleted_before_ms) continue;
      }
      const remote = remoteByKey.get(key);
      if (query.hasMedia && !remote) continue;

      const info = deviceInfoMap.get(entry.device_id);
      const displayName = info?.displayName ?? entry.device_id;
      const baseArchived =
        devState?.archived_override !== null && devState?.archived_override !== undefined
          ? devState.archived_override
          : remote
            ? Boolean(remote.archived)
            : false;
      const candidate: RemoteUnifiedChat = remote
        ? {
            ...remote,
            archived: baseArchived,
            name: remote.name?.trim() || entry.name,
            last_message_time: remote.last_message_time || entry.last_message_time,
            is_pinned: Boolean(devState?.is_pinned ?? remote.is_pinned),
            pinned_at_ms: devState?.pinned_at_ms ?? remote.pinned_at_ms ?? 0,
            is_blocked: Boolean(devState?.is_blocked ?? remote.is_blocked),
          }
        : {
            jid: entry.jid,
            name: entry.name,
            last_message_time: entry.last_message_time,
            ephemeral_expiration: 0,
            created_at: entry.assignment.assigned_at ?? entry.assignment.closed_at ?? '',
            updated_at: entry.last_message_time,
            archived: baseArchived,
            device_id: entry.device_id,
            device_display_name: displayName,
            device_state: info?.device.state ?? 'disconnected',
            is_pinned: Boolean(devState?.is_pinned),
            pinned_at_ms: devState?.pinned_at_ms ?? 0,
            is_blocked: Boolean(devState?.is_blocked),
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
    // Agents see only the chats they closed; supervisors see all.
    const closedOwnerId = query.isSupervisor ? null : userId;
    if (canDirectSqlPaginate) {
      const paged = buildFromDbEntries('closed', closedOwnerId, query.limit, query.offset);
      return {
        pagedChats: paged,
        totalAvailable: tabCounts.closed,
        hasMore: query.offset + paged.length < tabCounts.closed,
      };
    }
    const list = buildFromDbEntries('closed', closedOwnerId);
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

  if (query.requestedTab === 'open') {
    const openOwnerId = query.isSupervisor ? (query.assignedFilterUserId ?? null) : userId;
    if (canDirectSqlPaginate) {
      const paged = buildFromDbEntries('open', openOwnerId, query.limit, query.offset);
      const totalOpen = openOwnerId === null ? tabCounts.open : paged.length;
      return {
        pagedChats: paged,
        totalAvailable: openOwnerId === null ? tabCounts.open : totalOpen,
        hasMore: openOwnerId === null ? query.offset + paged.length < tabCounts.open : false,
      };
    }
    const list = buildFromDbEntries('open', openOwnerId);
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
          const {device_id: deviceId, chat_jid: chatJid} = changed;
          const ratings: GowaMessageInfo[] = [];
          const ordinary: GowaMessageInfo[] = [];
          let waitingForRating = hasPendingChatCloseRating(chatJid, deviceId);
          let latestCustomerMs = 0;
          const ordered = latest.data.map((msg) => ({msg, ms: parseTimestampMs(msg.timestamp)}))
            .sort((a, b) => a.ms - b.ms);
          for (const {msg, ms} of ordered) {
            if (msg.is_from_me) {
              ordinary.push(msg);
              continue;
            }
            const rating = captureChatCloseRating(deviceId, chatJid, {
              id: msg.id, text: msg.content ?? '', mediaType: msg.media_type,
              timestampMs: ms, contextMetadata: msg.context_metadata,
            });
            if (rating) {
              ratings.push(msg);
              if (rating === 'recorded') {
                waitingForRating = false;
                wsBridge.broadcast(buildCloseRatingUpdatedEvent(deviceId));
              }
              continue;
            }
            ordinary.push(msg);
            if (ms > changed.prev_last_message_ms && ms > latestCustomerMs) {
              latestCustomerMs = ms;
              if (waitingForRating) {
                const reopened = handleIncomingCustomerMessageLifecycle(deviceId, chatJid, ms);
                if (reopened) {
                  waitingForRating = false;
                  wsBridge.broadcast(reopened);
                }
              }
            }
          }
          upsertCachedMessages(deviceId, chatJid, ordinary, {
            markUnreadCandidate: true,
            minUnreadTimestampMs: changed.prev_last_message_ms,
          });
          if (ratings.length > 0) upsertCachedMessages(deviceId, chatJid, ratings);
          if (latestCustomerMs > 0) {
            const reopenEvent = handleIncomingCustomerMessageLifecycle(deviceId, chatJid, latestCustomerMs);
            if (reopenEvent) wsBridge.broadcast(reopenEvent);
          }
        } else {
          setChatMessagePresence(
            changed.device_id,
            changed.chat_jid,
            false,
            changed.new_last_message_ms
              ? new Date(changed.new_last_message_ms).toISOString()
              : undefined,
          );
        }
        clearChatCatchup(changed.device_id, changed.chat_jid);
      } catch {
        // Keep needs_catchup = 1 so the next poll automatically retries
      }
    }),
  );
}

export async function resolveMissingChatMessagePresence(params: {
  pagedChats: RemoteUnifiedChat[];
  devices: GowaDevice[];
  user: PublicUser;
}): Promise<void> {
  const {pagedChats, devices, user} = params;
  if (pagedChats.length === 0) return;

  const onlineDeviceSet = new Set(
    devices.filter((d) => d.state === 'logged_in' || d.state === 'connected').map((d) => d.id),
  );
  const chatKeys = pagedChats.map((c) => ({device_id: c.device_id, chat_jid: c.jid}));
  const presenceMap = getChatsMessagePresenceMap(chatKeys);

  const unknownChats = pagedChats.filter((chat) => {
    const key = `${chat.device_id}::${chat.jid}`;
    const known = presenceMap.get(key);
    if (typeof known === 'boolean') return false;
    if (parseTimestampMs(chat.last_message_time) <= 0) return false;
    return onlineDeviceSet.has(chat.device_id) && hasDeviceAccess(user, chat.device_id);
  });
  if (unknownChats.length === 0) return;

  const CONCURRENCY = 16;
  let cursor = 0;
  const workerCount = Math.min(CONCURRENCY, unknownChats.length);

  await Promise.all(
    Array.from({length: workerCount}, async () => {
      while (cursor < unknownChats.length) {
        const chat = unknownChats[cursor++];
        if (!chat) break;
        try {
          const probe = await gowaFetch<{data?: GowaMessageInfo[]; pagination?: GowaPagination}>(
            `/chat/${encodeURIComponent(chat.jid)}/messages`,
            {deviceId: chat.device_id, query: {limit: 1, offset: 0}, timeoutMs: 2_500},
          );
          const hasMessages =
            (probe?.data?.length ?? 0) > 0 || (probe?.pagination?.total ?? 0) > 0;
          setChatMessagePresence(chat.device_id, chat.jid, hasMessages, chat.last_message_time);
        } catch {
          // Leave unknown so next poll can retry without breaking chat listing
        }
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
  const uniqueDeviceIds = Array.from(new Set(pagedChats.map((c) => c.device_id).filter(Boolean)));
  const unreadByChat = getUnreadCountsForUser(user, chatKeys);
  const presenceByChat = getChatsMessagePresenceMap(chatKeys);
  const previewsByChat = getLastMessagePreviews(chatKeys);
  const deviceStatesMap = getChatDeviceStatesMap(uniqueDeviceIds);
  const userPrefsMap = getUserChatPreferencesMap(user.id, uniqueDeviceIds);
  const listMembershipsMap = getUserChatListMemberships(user.id, uniqueDeviceIds);

  const missingLifecycleKeys = chatKeys.filter(
    (k) => !assignmentsMap.has(`${k.device_id}::${k.chat_jid}`),
  );
  const lifecycleByChat: Map<string, ChatAssignmentInfo> =
    missingLifecycleKeys.length > 0 ? getChatLifecycleMap(missingLifecycleKeys) : new Map();

  let totalUnread = 0;
  const enrichedChats = pagedChats.map((chat) => {
    const key = `${chat.device_id}::${chat.jid}`;
    const unreadCount = unreadByChat.get(key) ?? 0;
    const knownPresence = presenceByChat.get(key);
    const hasMessages =
      parseTimestampMs(chat.last_message_time) <= 0
        ? false
        : typeof knownPresence === 'boolean'
          ? knownPresence
          : undefined;
    const assignment = lifecycleByChat.get(key) ?? assignmentsMap.get(key);
    const preview = previewsByChat.get(key);
    const devState = deviceStatesMap.get(key);
    const userPref = userPrefsMap.get(key);
    const listIds = listMembershipsMap.get(key) ?? [];
    const effectiveArchived =
      devState?.archived_override !== null && devState?.archived_override !== undefined
        ? devState.archived_override
        : Boolean(chat.archived);
    totalUnread += unreadCount;
    return {
      ...chat,
      ...(hasMessages !== undefined ? {has_messages: hasMessages} : {}),
      ...(preview
        ? {last_message_text: preview.text, last_message_type: preview.media_type}
        : {}),
      archived: effectiveArchived,
      is_pinned: Boolean(devState?.is_pinned ?? chat.is_pinned),
      pinned_at_ms: devState?.pinned_at_ms ?? chat.pinned_at_ms ?? 0,
      is_blocked: Boolean(devState?.is_blocked ?? chat.is_blocked),
      is_favourite: Boolean(userPref?.is_favourite),
      muted_until_ms: userPref?.muted_until_ms ?? 0,
      list_ids: listIds,
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
  const changed = syncAssignmentMetadataFromChats(
    allChats.map((c) => ({
      device_id: c.device_id,
      chat_jid: c.jid,
      name: c.name,
      last_message_time: c.last_message_time,
    })),
    assignmentsMap,
  );
  return changed ? listAssignmentsForDevices(targetDeviceIds) : assignmentsMap;
}
