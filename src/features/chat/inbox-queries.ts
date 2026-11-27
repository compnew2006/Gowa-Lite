import type {QueryClient, UseQueryOptions} from '@tanstack/react-query';
import {listUnifiedChats} from '@/api/client';
import type {UnifiedChatTab, UnifiedChatsResponse} from '@/api/types';
import {
  DEFAULT_UNIFIED_CHATS_QUERY_KEY,
  isDefaultUnifiedChatsQuery,
  unifiedChatsQueryKey,
  UNIFIED_CHATS_QUERY_PREFIX,
} from '@/features/chat/inbox-query-keys';
import {normalizeSearchInput} from '@/lib/phone';

type InboxQueryOverrides = Pick<
  UseQueryOptions<UnifiedChatsResponse>,
  'enabled' | 'refetchInterval' | 'refetchOnWindowFocus' | 'staleTime'
>;

export const UNIFIED_CHATS_PAGE_SIZE = 100;

export interface UnifiedChatsQueryFilters {
  deviceIds?: string[];
  search?: string;
  hasMedia?: boolean;
  tab?: UnifiedChatTab;
  assignedTo?: string | number;
}

export function createUnifiedChatsQueryOptions({
  filters = {},
  options = {},
}: {
  filters?: UnifiedChatsQueryFilters;
  options?: InboxQueryOverrides;
} = {}) {
  const deviceIds = filters.deviceIds ?? [];
  const normalizedSearch = normalizeSearchInput(filters.search ?? '');
  const hasMedia = filters.hasMedia ?? false;
  const resolvedTab = filters.tab ?? '';
  const resolvedAssignedTo =
    filters.assignedTo !== undefined && filters.assignedTo !== ''
      ? String(filters.assignedTo)
      : '';
  const keyFilters = {
    deviceIds,
    search: normalizedSearch,
    hasMedia,
    tab: resolvedTab,
    assignedTo: resolvedAssignedTo,
  };
  const isDefaultPage = isDefaultUnifiedChatsQuery(keyFilters);
  const queryKey = isDefaultPage
    ? DEFAULT_UNIFIED_CHATS_QUERY_KEY
    : unifiedChatsQueryKey(keyFilters);
  const params = isDefaultPage
    ? {}
    : {
        deviceIds: deviceIds.length > 0 ? deviceIds : undefined,
        search: normalizedSearch || undefined,
        has_media: hasMedia || undefined,
        tab: filters.tab,
        assignedTo: resolvedAssignedTo || undefined,
        limit: UNIFIED_CHATS_PAGE_SIZE,
        offset: 0,
      };

  return {
    queryKey,
    queryFn: () => listUnifiedChats(params),
    staleTime: isDefaultPage ? 25_000 : undefined,
    refetchInterval: isDefaultPage
      ? false
      : (query: {state: {error: unknown}}) => query.state.error ? false : 30_000,
    ...options,
  };
}

function patchPrivateChatReadResponse(
  old: UnifiedChatsResponse | undefined,
  deviceId: string,
  jid: string,
): UnifiedChatsResponse | undefined {
  if (!old) return old;

  let removed = 0;
  const nextData = old.data.map((item) => {
    if (
      item.device_id === deviceId &&
      item.jid === jid &&
      (item.unread_count ?? 0) > 0
    ) {
      removed += item.unread_count ?? 0;
      return {...item, unread_count: 0};
    }
    return item;
  });
  if (removed === 0) return old;

  const totalUnread =
    typeof old.total_unread === 'number'
      ? Math.max(0, old.total_unread - removed)
      : nextData.reduce((sum, item) => sum + (item.unread_count ?? 0), 0);
  return {...old, data: nextData, total_unread: totalUnread};
}

export function markPrivateChatReadInInboxCache(
  queryClient: Pick<QueryClient, 'setQueriesData'>,
  deviceId: string,
  jid: string,
): void {
  queryClient.setQueriesData<UnifiedChatsResponse>(
    {queryKey: UNIFIED_CHATS_QUERY_PREFIX},
    (old) => patchPrivateChatReadResponse(old, deviceId, jid),
  );
}
