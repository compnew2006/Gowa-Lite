import {useCallback, useEffect, useRef} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import {markUnifiedChatRead, markUnifiedGroupRead} from '@/api/client';
import type {UnifiedChat, UnifiedGroupsResponse} from '@/api/types';
import {markPrivateChatReadInInboxCache} from '@/features/chat/inbox-queries';
import {extractWsEventTarget, onWsEvent} from '@/lib/events';
import {toWhatsAppJid} from '@/lib/phone';

export function useChatReadSync(chat: UnifiedChat, isContentRedacted = false): void {
  const queryClient = useQueryClient();
  const markingReadRef = useRef(false);
  const pendingMarkReadRef = useRef(false);
  const lastMarkedKeyRef = useRef('');
  const isGroup = chat.jid.trim().toLowerCase().endsWith('@g.us');

  useEffect(() => {
    lastMarkedKeyRef.current = '';
  }, [chat.device_id, chat.jid]);

  const markAsRead = useCallback(() => {
    if (isContentRedacted) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    if (markingReadRef.current) {
      pendingMarkReadRef.current = true;
      return;
    }
    markingReadRef.current = true;
    pendingMarkReadRef.current = false;

    if (isGroup) {
      let cleared = 0;
      queryClient.setQueriesData<UnifiedGroupsResponse>(
        {queryKey: ['unified-groups']},
        (old) => {
          if (!old) return old;
          let changed = false;
          const nextItems = old.items.map((item) => {
            if (
              item.kind === 'group' &&
              item.device_id === chat.device_id &&
              item.jid === chat.jid &&
              (item.unread_count ?? 0) > 0
            ) {
              cleared = item.unread_count ?? 0;
              changed = true;
              return {...item, unread_count: 0};
            }
            return item;
          });
          if (!changed) return old;
          return {
            ...old,
            items: nextItems,
            total_unread: Math.max(0, (old.total_unread ?? 0) - cleared),
          };
        },
      );
      if (cleared > 0) {
        queryClient.setQueryData<{total_unread: number}>(['unified-groups-unread'], (old) =>
          old ? {total_unread: Math.max(0, old.total_unread - cleared)} : old,
        );
      }

      void markUnifiedGroupRead(chat.device_id, chat.jid)
        .then(() => {
          void queryClient.invalidateQueries({queryKey: ['unified-groups']});
          void queryClient.invalidateQueries({queryKey: ['unified-groups-unread']});
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
      return;
    }

    markPrivateChatReadInInboxCache(queryClient, chat.device_id, chat.jid);

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
  }, [chat.device_id, chat.jid, isContentRedacted, isGroup, queryClient]);

  useEffect(() => {
    if (isContentRedacted) return;
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
  }, [chat.device_id, chat.jid, chat.unread_count, chat.last_message_time, isContentRedacted, markAsRead]);

  useEffect(() => {
    if (isContentRedacted) return;
    const canonicalChatJid = toWhatsAppJid(chat.jid) || chat.jid;
    return onWsEvent((event) => {
      const code = (event.code || '').toUpperCase();
      if (code !== 'MESSAGE_RECEIVED' && code !== 'MESSAGE') return;
      const target = extractWsEventTarget(event);
      if (target.deviceId && target.deviceId !== chat.device_id) return;
      const canonicalTargetJid = target.chatJid ? toWhatsAppJid(target.chatJid) || target.chatJid : '';
      if (canonicalTargetJid && canonicalTargetJid === canonicalChatJid && document.visibilityState === 'visible') {
        markAsRead();
      }
    });
  }, [chat.device_id, chat.jid, isContentRedacted, markAsRead]);
}
