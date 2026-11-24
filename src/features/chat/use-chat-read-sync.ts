import {useCallback, useEffect, useRef} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import {markUnifiedChatRead} from '@/api/client';
import type {UnifiedChat, UnifiedChatsResponse} from '@/api/types';
import {onWsEvent} from '@/lib/events';

export function useChatReadSync(chat: UnifiedChat): void {
  const queryClient = useQueryClient();
  const markingReadRef = useRef(false);
  const pendingMarkReadRef = useRef(false);
  const lastMarkedKeyRef = useRef('');

  useEffect(() => {
    lastMarkedKeyRef.current = '';
  }, [chat.device_id, chat.jid]);

  const markAsRead = useCallback(() => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    if (markingReadRef.current) {
      pendingMarkReadRef.current = true;
      return;
    }
    markingReadRef.current = true;
    pendingMarkReadRef.current = false;

    queryClient.setQueriesData<UnifiedChatsResponse>(
      {queryKey: ['unified-chats']},
      (old) => {
        if (!old) return old;
        let removed = 0;
        const nextData = old.data.map((item) => {
          if (item.device_id === chat.device_id && item.jid === chat.jid) {
            removed = item.unread_count ?? 0;
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
      },
    );

    void markUnifiedChatRead(chat.device_id, chat.jid)
      .then(() => {
        void queryClient.invalidateQueries({queryKey: ['unified-chats']});
      })
      .catch(() => {
        // Non-blocking: sidebar will resync on next fetch
      })
      .finally(() => {
        markingReadRef.current = false;
        if (pendingMarkReadRef.current) {
          pendingMarkReadRef.current = false;
          markAsRead();
        }
      });
  }, [chat.device_id, chat.jid, queryClient]);

  useEffect(() => {
    const signature = `${chat.device_id}:${chat.jid}:${chat.unread_count ?? 0}:${chat.last_message_time ?? ''}`;
    if (document.visibilityState === 'visible' && lastMarkedKeyRef.current !== signature) {
      if (lastMarkedKeyRef.current === '' || (chat.unread_count ?? 0) > 0) {
        lastMarkedKeyRef.current = signature;
        markAsRead();
      }
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible' && (chat.unread_count ?? 0) > 0) {
        markAsRead();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [chat.device_id, chat.jid, chat.unread_count, chat.last_message_time, markAsRead]);

  useEffect(() => {
    return onWsEvent((event) => {
      if (event.code !== 'MESSAGE_RECEIVED') return;
      if (event.device_id && event.device_id !== chat.device_id) return;
      const result = event.result as Record<string, unknown> | undefined;
      const eventChatJid =
        typeof result?.chat_id === 'string'
          ? result.chat_id
          : typeof result?.chat_jid === 'string'
            ? result.chat_jid
            : '';
      if (eventChatJid && eventChatJid === chat.jid && document.visibilityState === 'visible') {
        markAsRead();
      }
    });
  }, [chat.device_id, chat.jid, markAsRead]);
}
