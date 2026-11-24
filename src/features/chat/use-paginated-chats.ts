import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {listUnifiedChats} from '@/api/client';
import type {UnifiedChat, UnifiedChatTab} from '@/api/types';
import {normalizeSearchInput} from '@/lib/phone';

const CHATS_PAGE_SIZE = 100;

export function mergePaginatedChats(
  firstPageChats: UnifiedChat[],
  extraChats: UnifiedChat[],
): UnifiedChat[] {
  if (extraChats.length === 0) return firstPageChats;
  const byKey = new Map<string, UnifiedChat>();
  for (const chat of extraChats) {
    byKey.set(`${chat.device_id}::${chat.jid}`, chat);
  }
  // Page 0 items overwrite stale duplicates with freshest server state
  for (const chat of firstPageChats) {
    byKey.set(`${chat.device_id}::${chat.jid}`, chat);
  }
  const merged = Array.from(byKey.values());
  merged.sort((a, b) => {
    const ta = new Date(a.last_message_time).getTime();
    const tb = new Date(b.last_message_time).getTime();
    const validA = Number.isNaN(ta) || ta <= 0 ? 0 : ta;
    const validB = Number.isNaN(tb) || tb <= 0 ? 0 : tb;
    return validB - validA;
  });
  return merged;
}

export function usePaginatedChats({
  deviceIds,
  search,
  hasMedia,
  tab,
  assignedTo,
}: {
  deviceIds: string[];
  search: string;
  hasMedia: boolean;
  tab?: UnifiedChatTab;
  assignedTo?: string | number;
}) {
  const normalizedSearch = normalizeSearchInput(search);
  const resolvedTab = tab ?? '';
  const resolvedAssignedTo = assignedTo !== undefined && assignedTo !== '' ? String(assignedTo) : '';
  const filterSignature = `${deviceIds.join(',')}::${normalizedSearch}::${hasMedia ? '1' : '0'}::${resolvedTab}::${resolvedAssignedTo}`;

  const [extraState, setExtraState] = useState<{
    signature: string;
    chats: UnifiedChat[];
    hasMoreOverride?: boolean;
    nextOffsetOverride?: number;
    totalOverride?: number;
  }>({
    signature: filterSignature,
    chats: [],
  });
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);

  useEffect(() => {
    loadingMoreRef.current = false;
    setIsLoadingMore(false);
    setExtraState({signature: filterSignature, chats: []});
  }, [filterSignature]);

  const query = useQuery({
    queryKey: ['unified-chats', deviceIds, normalizedSearch, hasMedia, resolvedTab, resolvedAssignedTo],
    queryFn: () =>
      listUnifiedChats({
        deviceIds: deviceIds.length > 0 ? deviceIds : undefined,
        search: normalizedSearch || undefined,
        has_media: hasMedia || undefined,
        tab,
        assignedTo: resolvedAssignedTo || undefined,
        limit: CHATS_PAGE_SIZE,
        offset: 0,
      }),
    refetchInterval: (q) => (q.state.error ? false : 30_000),
  });

  const activeExtra = extraState.signature === filterSignature ? extraState : null;
  const pageZeroChats = query.data?.data ?? [];
  const mergedChats = useMemo(
    () => mergePaginatedChats(pageZeroChats, activeExtra?.chats ?? []),
    [activeExtra?.chats, pageZeroChats],
  );

  const pageZeroPagination = query.data?.pagination;
  const hasMore =
    activeExtra?.hasMoreOverride !== undefined
      ? activeExtra.hasMoreOverride
      : Boolean(pageZeroPagination?.has_more);
  const nextOffset =
    activeExtra?.nextOffsetOverride !== undefined
      ? activeExtra.nextOffsetOverride
      : pageZeroPagination?.next_offset ?? CHATS_PAGE_SIZE;
  const totalCount =
    activeExtra?.totalOverride !== undefined
      ? Math.max(activeExtra.totalOverride, mergedChats.length)
      : Math.max(pageZeroPagination?.total ?? mergedChats.length, mergedChats.length);

  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || !hasMore) return;
    const requestedSignature = filterSignature;
    loadingMoreRef.current = true;
    setIsLoadingMore(true);
    try {
      const res = await listUnifiedChats({
        deviceIds: deviceIds.length > 0 ? deviceIds : undefined,
        search: normalizedSearch || undefined,
        has_media: hasMedia || undefined,
        tab,
        assignedTo: resolvedAssignedTo || undefined,
        limit: CHATS_PAGE_SIZE,
        offset: nextOffset,
      });
      const fetched = res.data ?? [];
      const resPagination = res.pagination;
      setExtraState((prev) => {
        if (prev.signature !== requestedSignature) return prev;
        const combinedExtra = mergePaginatedChats(fetched, prev.chats);
        const computedNextOffset = resPagination?.next_offset ?? nextOffset + CHATS_PAGE_SIZE;
        const computedHasMore =
          resPagination !== undefined
            ? Boolean(resPagination.has_more) && fetched.length > 0
            : fetched.length >= CHATS_PAGE_SIZE;
        return {
          signature: requestedSignature,
          chats: combinedExtra,
          hasMoreOverride: computedHasMore,
          nextOffsetOverride: computedNextOffset,
          totalOverride: resPagination?.total,
        };
      });
    } finally {
      loadingMoreRef.current = false;
      setIsLoadingMore(false);
    }
  }, [deviceIds, filterSignature, hasMedia, hasMore, nextOffset, normalizedSearch, resolvedAssignedTo, tab]);

  const refresh = useCallback(() => {
    setExtraState({signature: filterSignature, chats: []});
    return query.refetch();
  }, [filterSignature, query]);

  const markExtraChatRead = useCallback((deviceId: string, jid: string) => {
    setExtraState((prev) => {
      if (prev.chats.length === 0) return prev;
      let changed = false;
      const nextChats = prev.chats.map((c) => {
        if (c.device_id === deviceId && c.jid === jid && (c.unread_count ?? 0) > 0) {
          changed = true;
          return {...c, unread_count: 0};
        }
        return c;
      });
      return changed ? {...prev, chats: nextChats} : prev;
    });
  }, []);

  return {
    query,
    chats: mergedChats,
    accounts: query.data?.accounts ?? [],
    deviceErrors: query.data?.device_errors ?? [],
    tabCounts: query.data?.tab_counts,
    totalUnread: query.data?.total_unread,
    totalCount,
    hasMore,
    isLoadingMore,
    loadMore,
    refresh,
    markExtraChatRead,
  };
}
