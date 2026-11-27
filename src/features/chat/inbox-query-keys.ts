export const UNIFIED_CHATS_QUERY_PREFIX = ['unified-chats'] as const;
export const DEFAULT_UNIFIED_CHATS_QUERY_KEY = [
  ...UNIFIED_CHATS_QUERY_PREFIX,
  [],
  '',
  false,
] as const;

export interface UnifiedChatsKeyFilters {
  deviceIds: string[];
  search: string;
  hasMedia: boolean;
  tab: string;
  assignedTo: string;
}

export function isDefaultUnifiedChatsQuery(filters: UnifiedChatsKeyFilters): boolean {
  return filters.deviceIds.length === 0 && !filters.search && !filters.hasMedia &&
    (!filters.tab || filters.tab === 'all') && !filters.assignedTo;
}

export function unifiedChatsQueryKey(filters: UnifiedChatsKeyFilters) {
  if (isDefaultUnifiedChatsQuery(filters)) {
    return DEFAULT_UNIFIED_CHATS_QUERY_KEY;
  }

  return [
    ...UNIFIED_CHATS_QUERY_PREFIX,
    filters.deviceIds,
    filters.search,
    filters.hasMedia,
    filters.tab,
    filters.assignedTo,
  ] as const;
}
