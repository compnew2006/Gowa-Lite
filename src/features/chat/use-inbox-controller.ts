import {useCallback, useEffect, useMemo, useState} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import {toast} from 'sonner';
import {bulkUnifiedChatsLifecycle} from '@/api/requests/workflow';
import type {UnifiedChat, UnifiedChatTab} from '@/api/types';
import {chatLifecycleQueryKeys} from '@/features/chat/message-query-keys';
import {chatDisplayName} from '@/features/chat/display-name';
import {markPrivateChatReadInInboxCache} from '@/features/chat/inbox-queries';
import {UNIFIED_CHATS_QUERY_PREFIX} from '@/features/chat/inbox-query-keys';
import {messageHistoryOptions} from '@/features/chat/message-history-query';
import {chatUniqueKey, resolveSelectedUnifiedChat} from '@/features/chat/selected-chat';
import {usePaginatedChats} from '@/features/chat/use-paginated-chats';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';
import {useAuthStore} from '@/stores/auth';

function isChatRedactedForUser(
  chat: UnifiedChat,
  userId: number | undefined,
  canViewAll: boolean,
): boolean {
  if (canViewAll) return false;
  if (chat.jid.endsWith('@newsletter') || chat.jid === 'status@broadcast') return false;
  const st = chat.lifecycle?.status ?? 'pending';
  if (st === 'pending' || st === 'closed') return true;
  return st === 'open' && chat.lifecycle?.assigned_user_id !== userId;
}

export type BulkLifecycleAction = 'close' | 'release' | 'reopen' | 'assign';

/**
 * Builds the POST /api/unified/chats/bulk-lifecycle payload for the selected
 * chats. P1-5: a bulk claim (`assign`) always targets the current user —
 * assigning the selection to anyone else is P2-8 (phase 5) and is not built
 * here. Fail closed: without a signed-in user id there is no safe assignee
 * (the server would read a missing id as "release to pending"), so throw
 * instead of sending the request.
 */
export function buildBulkLifecycleRequest(
  action: BulkLifecycleAction,
  selectedChats: UnifiedChat[],
  currentUserId?: number,
): {
  action: BulkLifecycleAction;
  assigned_user_id?: number;
  items: Array<{device_id: string; chat_jid: string; cached_title?: string}>;
} {
  if (action === 'assign' && currentUserId === undefined) {
    throw new Error('Bulk claim requires a signed-in user');
  }
  return {
    action,
    ...(action === 'assign' ? {assigned_user_id: currentUserId} : {}),
    items: selectedChats.map((c) => ({
      device_id: c.device_id,
      chat_jid: c.jid,
      cached_title: chatDisplayName(c),
    })),
  };
}

export function useInboxController(deviceIds: string[], canViewAll: boolean) {
  const queryClient = useQueryClient();
  const {t} = useI18n();
  const userId = useAuthStore((s) => s.user?.id);
  const allowedDeviceIds = useAuthStore((s) => s.user?.allowed_device_ids);
  const [search, setSearch] = useState('');
  const [hasMedia, setHasMedia] = useState(false);
  const [activeTab, setActiveTab] = useState<UnifiedChatTab>(() =>
    canViewAll ? 'all' : 'pending',
  );
  const [assignedToFilter, setAssignedToFilter] = useState<'all' | 'me'>('all');
  const [isBulkPending, setIsBulkPending] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [chatOpenNonce, setChatOpenNonce] = useState(0);
  const [retainedChat, setRetainedChat] = useState<UnifiedChat | null>(null);
  const [adHocChat, setAdHocChat] = useState<{deviceId: string; jid: string} | null>(null);

  useEffect(() => {
    if (!canViewAll && activeTab === 'all') {
      setActiveTab('pending');
    }
  }, [activeTab, canViewAll]);

  const effectiveAssignedTo =
    activeTab === 'me'
      ? 'me'
      : activeTab === 'open' && canViewAll
        ? assignedToFilter
        : undefined;

  const paginated = usePaginatedChats({
    deviceIds,
    search,
    hasMedia,
    tab: activeTab,
    assignedTo: effectiveAssignedTo,
  });
  const {query, chats, accounts, deviceErrors} = paginated;
  const apiErr = query.isError ? toApiError(query.error) : null;

  const handleBulkLifecycle = useCallback(
    async (action: BulkLifecycleAction, selectedChats: UnifiedChat[]) => {
      setIsBulkPending(true);
      try {
        // The 100-chat-per-batch cap is enforced server-side
        // (bulkChatLifecycle rejects larger batches); the UI sends the
        // selection as-is and surfaces the server's partial results.
        const res = await bulkUnifiedChatsLifecycle(
          buildBulkLifecycleRequest(action, selectedChats, userId),
        );
        const okCount = res.succeeded.length;
        const failCount = res.failed.length;
        if (failCount === 0) {
          toast.success(t.chats.bulkResultToast(okCount));
        } else if (okCount > 0) {
          toast.warning(t.chats.bulkPartialToast(okCount, okCount + failCount));
        } else {
          toast.error(res.failed[0]?.message || t.chats.bulkPartialToast(0, failCount));
        }
        await queryClient.invalidateQueries({queryKey: UNIFIED_CHATS_QUERY_PREFIX});
        void queryClient.invalidateQueries({queryKey: chatLifecycleQueryKeys.all});
      } catch (err) {
        toast.error(toApiError(err).message);
      } finally {
        setIsBulkPending(false);
      }
    },
    [queryClient, t.chats, userId],
  );

  useEffect(() => {
    if (!selectedKey) {
      setRetainedChat(null);
      return;
    }
    const match = chats.find((c) => chatUniqueKey(c) === selectedKey);
    if (match) {
      setRetainedChat(match);
    }
  }, [chats, selectedKey]);

  const selectedChat = useMemo(() => {
      const chat = resolveSelectedUnifiedChat({
        selectedKey,
        chats,
        retainedChat,
        adHocChat,
        accounts,
      });
      if (chat && allowedDeviceIds?.length && !allowedDeviceIds.includes(chat.device_id)) return null;
      return chat;
    }, [adHocChat, allowedDeviceIds, chats, accounts, retainedChat, selectedKey]);

  function selectChat(chat: UnifiedChat) {
    const redacted = isChatRedactedForUser(chat, userId, canViewAll);
    if (!redacted) {
      void queryClient.prefetchInfiniteQuery(messageHistoryOptions(chat.device_id, chat.jid));
      paginated.markExtraChatRead(chat.device_id, chat.jid);
      markPrivateChatReadInInboxCache(queryClient, chat.device_id, chat.jid);
    }
    setAdHocChat(null);
    setRetainedChat(redacted ? chat : {...chat, unread_count: 0});
    setSelectedKey(chatUniqueKey(chat));
    setChatOpenNonce((n) => n + 1);
  }

  const openChat = useCallback((deviceId: string, jid: string) => {
    if (allowedDeviceIds?.length && !allowedDeviceIds.includes(deviceId)) return false;
    void queryClient.prefetchInfiniteQuery(messageHistoryOptions(deviceId, jid));
    setAdHocChat({deviceId, jid});
    setSelectedKey(chatUniqueKey({device_id: deviceId, jid}));
    setChatOpenNonce((n) => n + 1);
    return true;
  }, [allowedDeviceIds, queryClient]);

  const clearSelection = useCallback(() => {
    setSelectedKey(null);
    setRetainedChat(null);
    setAdHocChat(null);
  }, []);

  function forgetChat(chat: UnifiedChat): boolean {
    if (selectedKey !== chatUniqueKey(chat)) return false;
    clearSelection();
    return true;
  }

  return {
    search, setSearch, hasMedia, setHasMedia, activeTab, setActiveTab,
    assignedToFilter, setAssignedToFilter, isBulkPending, selectedKey, chatOpenNonce,
    paginated, query, chats, accounts, deviceErrors, apiErr, selectedChat,
    handleBulkLifecycle, selectChat, openChat, clearSelection, forgetChat,
  };
}
