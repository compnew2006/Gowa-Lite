import {infiniteQueryOptions} from '@tanstack/react-query';
import {getUnifiedChatMessages} from '@/api/requests/chats';
import type {ChatInfo, ChatRedactionReason, MessageInfo, Pagination} from '@/api/types';

export const PAGE_SIZE = 40;

export type MessagesPage = {
  data: MessageInfo[];
  pagination: Pagination;
  chat_info: ChatInfo;
  content_redacted?: boolean;
  redaction_reason?: ChatRedactionReason;
  reaction_webhook_configured?: boolean;
};

function computeNextMessagePageParam(
  lastPage: MessagesPage,
  allPages: MessagesPage[],
): number | undefined {
  if (typeof lastPage.pagination.next_offset === 'number') {
    const rawCount = lastPage.pagination.raw_count ?? lastPage.data.length;
    const liveTotal = lastPage.pagination.live_total;
    if (rawCount === 0 || lastPage.data.length === 0) return undefined;
    if (typeof liveTotal === 'number' && lastPage.pagination.next_offset >= liveTotal) {
      return undefined;
    }
    return lastPage.pagination.next_offset;
  }
  const loadedCount = allPages.reduce((sum, page) => sum + page.data.length, 0);
  const totalCount = lastPage.pagination.total ?? 0;
  if (lastPage.data.length === 0 || loadedCount >= totalCount) return undefined;
  return loadedCount;
}

export function messageHistoryOptions(deviceId: string, jid: string, search = '', mediaOnly = false) {
  return infiniteQueryOptions({
    queryKey: ['unified-messages', deviceId, jid, search, mediaOnly],
    initialPageParam: 0,
    queryFn: ({pageParam, signal}) =>
      getUnifiedChatMessages(deviceId, jid, {
        limit: PAGE_SIZE,
        offset: pageParam,
        search: search || undefined,
        media_only: mediaOnly || undefined,
      }, signal),
    getNextPageParam: computeNextMessagePageParam,
  });
}
