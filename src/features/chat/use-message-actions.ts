import {useCallback, useRef} from 'react';
import {useMutation, useQueryClient, type InfiniteData} from '@tanstack/react-query';
import {toast} from 'sonner';
import {useNavigate} from 'react-router-dom';
import {revokeUnifiedMessage, sendUnifiedMediaMessage, sendUnifiedMessageReaction, sendUnifiedTextMessage} from '@/api/requests/chats';
import type {MessageInfo, UnifiedChat} from '@/api/types';
import type {MessagesPage} from '@/features/chat/message-history-query';
import {messageQueryKeys} from '@/features/chat/message-query-keys';
import {UNIFIED_CHATS_QUERY_PREFIX} from '@/features/chat/inbox-query-keys';
import {applyMessageReaction, applyRevokeToMessagePages, updateMessageReactions} from '@/features/chat/message-reactions';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';
import {toastWithView} from '@/lib/toast-with-view';
import {buildConversationDeepLink} from '@/lib/deep-links';

export function useMessageActions({
  chat, isDeviceReady, invalidateLifecycleScope, onSent, onRevoked,
}: {
  chat: UnifiedChat;
  isDeviceReady: boolean;
  invalidateLifecycleScope: () => void;
  onSent: (hasAttachment: boolean) => void;
  onRevoked: () => void;
}) {
  const queryClient = useQueryClient();
  const {t} = useI18n();
  const navigate = useNavigate();
  const pendingReactions = useRef(new Set<string>());

  const handleSendError = (error: unknown) => {
    toast.error(toApiError(error).message);
    invalidateLifecycleScope();
    void queryClient.invalidateQueries({queryKey: ['inbox-policy']});
  };

  const sendMutation = useMutation({
    mutationFn: ({text, replyMessageId}: {text: string; replyMessageId?: string}) =>
      sendUnifiedTextMessage(chat.device_id, chat.jid, text, replyMessageId),
    onSuccess: () => {
      onSent(false);
      invalidateLifecycleScope();
    },
    onError: handleSendError,
  });

  const sendMediaMutation = useMutation({
    mutationFn: ({file, caption}: {file: File; caption?: string}) =>
      sendUnifiedMediaMessage(chat.device_id, chat.jid, {file, caption}),
    onSuccess: () => {
      onSent(true);
      invalidateLifecycleScope();
    },
    onError: handleSendError,
  });

  const reactionMutation = useMutation({
    mutationFn: ({deviceId, chatJid, messageId, emoji}: {
      deviceId: string;
      chatJid: string;
      messageId: string;
      emoji: string;
      pendingKey: string;
    }) => sendUnifiedMessageReaction(deviceId, chatJid, messageId, emoji),
    onMutate: async ({deviceId, chatJid, messageId, emoji}) => {
      const queryKey = messageQueryKeys.chat(deviceId, chatJid);
      await queryClient.cancelQueries({queryKey});
      const previous = queryClient.getQueriesData<InfiniteData<MessagesPage>>({queryKey});
      const optimistic = {emoji, sender_jid: deviceId, is_from_me: true, timestamp: new Date().toISOString()};
      queryClient.setQueriesData<InfiniteData<MessagesPage>>({queryKey}, (data) =>
        updateMessageReactions(data, messageId, (reactions) =>
          applyMessageReaction(reactions, optimistic),
        ),
      );
      return {previous, optimistic};
    },
    onError: (err, {messageId}, context) => {
      if (context) {
        const {optimistic, previous} = context;
        for (const [key, data] of previous) {
          const original = data?.pages.flatMap((page) => page.data)
            .find((message) => message.id === messageId)?.reactions?.find((reaction) => reaction.is_from_me);
          queryClient.setQueryData<InfiniteData<MessagesPage>>(key, (current) =>
            updateMessageReactions(current, messageId, (reactions) => {
              const own = reactions?.find((reaction) => reaction.is_from_me);
              if (own ? own.timestamp !== optimistic.timestamp : optimistic.emoji) return reactions;
              return applyMessageReaction(reactions, original ?? {...optimistic, emoji: ''});
            }),
          );
        }
      }
      toast.error(toApiError(err).message);
    },
    onSettled: (_data, _err, {pendingKey}) => {
      pendingReactions.current.delete(pendingKey);
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (messageId: string) => revokeUnifiedMessage(chat.device_id, chat.jid, messageId),
    onMutate: async (messageId) => {
      const queryKey = messageQueryKeys.chat(chat.device_id, chat.jid);
      await queryClient.cancelQueries({queryKey});
      const previous = queryClient.getQueriesData<InfiniteData<MessagesPage>>({queryKey});
      const revokedAt = new Date().toISOString();
      queryClient.setQueriesData<InfiniteData<MessagesPage>>({queryKey}, (data) =>
        applyRevokeToMessagePages(data, {messageId, revokedAt}),
      );
      return {previous, revokedAt};
    },
    onSuccess: () => {
      toastWithView(t.chats.revokedToast, {
        label: t.scheduled.viewAction,
        to: buildConversationDeepLink(chat.device_id, chat.jid),
        navigate,
      });
      onRevoked();
    },
    onError: (err, messageId, context) => {
      for (const [key, previous] of context?.previous ?? []) {
        const original = previous?.pages.flatMap((page) => page.data).find((msg) => msg.id === messageId);
        if (!original || original.is_revoked) continue;
        queryClient.setQueryData<InfiniteData<MessagesPage>>(key, (current) => current && ({
          ...current,
          pages: current.pages.map((page) => page.content_redacted ? page : ({
            ...page,
            data: page.data.map((msg) =>
              msg.id === messageId && msg.revoked_at === context?.revokedAt && !msg.revoked_by
                ? {...msg, is_revoked: original.is_revoked, revoked_at: original.revoked_at}
                : msg,
            ),
          })),
        }));
      }
      toast.error(toApiError(err).message);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: messageQueryKeys.chat(chat.device_id, chat.jid),
      });
      void queryClient.invalidateQueries({queryKey: UNIFIED_CHATS_QUERY_PREFIX});
    },
  });

  const reactToMessage = reactionMutation.mutate;
  const handleReact = useCallback(
    (message: MessageInfo, emoji: string) => {
      if (!isDeviceReady) return;
      const pendingKey = JSON.stringify([chat.device_id, chat.jid, message.id]);
      if (pendingReactions.current.has(pendingKey)) return;
      pendingReactions.current.add(pendingKey);
      const myExisting = message.reactions?.find((r) => r.is_from_me && r.emoji === emoji);
      reactToMessage({
        deviceId: chat.device_id, chatJid: chat.jid, messageId: message.id,
        emoji: myExisting ? '' : emoji, pendingKey,
      });
    },
    [chat.device_id, chat.jid, isDeviceReady, reactToMessage],
  );

  return {sendMutation, sendMediaMutation, handleReact, revokeMutation};
}
