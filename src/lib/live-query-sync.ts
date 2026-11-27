import type {Query, QueryClient, QueryFilters} from '@tanstack/react-query';
import type {MessageInfo} from '@/api/types';
import {
  applyMessageReaction,
  patchRevokedMessage,
  updateMessageReactions,
  upsertIncomingMessageInPages,
  type InfiniteMessagePagesShape,
} from '@/features/chat/message-reactions';
import {chatLifecycleQueryKeys, messageQueryKeys} from '@/features/chat/message-query-keys';
import {UNIFIED_CHATS_QUERY_PREFIX} from '@/features/chat/inbox-query-keys';
import {
  extractWsEventTarget,
  extractWsIncomingMessage,
  extractWsReaction,
  extractWsRevokeTarget,
  type WsEvent,
} from '@/lib/events';
import {toWhatsAppJid} from '@/lib/phone';
import {invalidateChatQueries} from '@/lib/query-client';

const MESSAGE_EVENTS = new Set([
  'MESSAGE_RECEIVED', 'MESSAGE', 'MESSAGE_UPDATED', 'MESSAGE_EDITED', 'MESSAGE.EDITED',
  'MESSAGE_REVOKED', 'MESSAGE.REVOKED', 'MESSAGE_DELETED', 'MESSAGE.DELETED',
  'MESSAGE_REVOKE', 'MESSAGE.REVOKE', 'CHAT_UPDATED',
]);
const DEVICE_EVENTS = new Set(['LOGIN_SUCCESS', 'DEVICE_LOGGED_OUT', 'DEVICE_REMOVED', 'LIST_DEVICES']);

function isUnfilteredPatchableMessageQuery(query: Query): boolean {
  const [, , , search, mediaOnly] = query.queryKey;
  if (typeof search === 'string' && search !== '') return false;
  if (mediaOnly === true) return false;
  const data = query.state.data as
    | InfiniteMessagePagesShape<{data: MessageInfo[]; content_redacted?: boolean}>
    | undefined;
  return Boolean(
    data &&
      Array.isArray(data.pages) &&
      data.pages.length > 0 &&
      data.pages[0] &&
      Array.isArray(data.pages[0].data) &&
      !data.pages[0].content_redacted,
  );
}

function invalidateInbox(client: QueryClient, deviceId: string | undefined): void {
  void client.invalidateQueries({
    queryKey: UNIFIED_CHATS_QUERY_PREFIX,
    predicate: ({queryKey: [, devices]}) =>
      !deviceId || !Array.isArray(devices) || devices.length === 0 || devices.includes(deviceId),
  });
}

function patchReaction(client: QueryClient, event: WsEvent): void {
  const change = extractWsReaction(event);
  if (!change) return;
  const filters: QueryFilters = {
    queryKey: messageQueryKeys.device(change.deviceId),
    predicate: ({queryKey: [, , jid], state}) =>
      typeof jid === 'string' && (toWhatsAppJid(jid) || jid) === change.chatJid &&
      Boolean((state.data as InfiniteMessagePagesShape | undefined)?.pages.some((page) =>
        page.data.some((message) => message.id === change.messageId),
      )),
  };
  void client.cancelQueries(filters, {revert: false});
  client.setQueriesData<InfiniteMessagePagesShape>(filters, (data) =>
    updateMessageReactions(data, change.messageId, (reactions) =>
      applyMessageReaction(reactions, change.reaction),
    ),
  );
}

export function syncLiveQueryCache(client: QueryClient, event: WsEvent): void {
  const code = event.code.toUpperCase();
  if (code === 'MESSAGE_REACTION') {
    patchReaction(client, event);
    return;
  }

  const target = extractWsEventTarget(event);
  const jid = target.chatJid?.toLowerCase();
  const invalidate = (...roots: string[]) => {
    for (const root of roots) void client.invalidateQueries({queryKey: [root]});
  };
  const invalidateChat = (...roots: string[]) => {
    for (const root of roots) invalidateChatQueries(client, root, target);
  };

  if (DEVICE_EVENTS.has(code)) {
    invalidateInbox(client, target.deviceId);
    invalidateChat(messageQueryKeys.all[0]);
    invalidate('devices', 'unified-accounts', 'unified-accounts-assign',
      'unified-groups', 'unified-groups-unread', 'misc-statuses');
    return;
  }

  if (jid === 'status@broadcast') {
    invalidate('misc-statuses');
    return;
  }

  const revoke = extractWsRevokeTarget(event);
  if (revoke) patchRevokedMessage(client, revoke);

  if (revoke || MESSAGE_EVENTS.has(code)) {
    if (!jid || jid.endsWith('@g.us')) invalidate('unified-groups', 'unified-groups-unread');
    if (!jid?.endsWith('@g.us')) invalidateInbox(client, target.deviceId);

    const incoming = !revoke ? extractWsIncomingMessage(event) : null;
    if (incoming) {
      const normalizedChatJid = toWhatsAppJid(incoming.chatJid) || incoming.chatJid;
      const patchFilters: QueryFilters = {
        queryKey: messageQueryKeys.device(incoming.deviceId),
        predicate: (query) => {
          const rawJid = query.queryKey[2];
          return (
            typeof rawJid === 'string' &&
            (toWhatsAppJid(rawJid) || rawJid) === normalizedChatJid &&
            isUnfilteredPatchableMessageQuery(query)
          );
        },
      };
      client.setQueriesData<InfiniteMessagePagesShape>(patchFilters, (data) =>
        upsertIncomingMessageInPages(data, incoming.message),
      );
      void client.invalidateQueries({
        queryKey: messageQueryKeys.device(incoming.deviceId),
        predicate: (query) => {
          const rawJid = query.queryKey[2];
          return (
            typeof rawJid === 'string' &&
            (toWhatsAppJid(rawJid) || rawJid) === normalizedChatJid &&
            !isUnfilteredPatchableMessageQuery(query)
          );
        },
      });
    } else {
      invalidateChat(messageQueryKeys.all[0]);
    }
  } else if (code === 'CONVERSATION_NOTE_UPDATED') {
    invalidateChat('unified-chat-notes');
  } else if (code === 'SCHEDULE_UPDATED') {
    invalidateChat('unified-chat-schedules');
    invalidate('schedules');
  } else if (code === 'CHAT_LIFECYCLE_UPDATED' || code === 'CHAT_DAILY_RESET') {
    invalidateInbox(client, target.deviceId);
    invalidateChat(
      chatLifecycleQueryKeys.all[0],
      messageQueryKeys.all[0],
      'unified-chat-notes',
      'unified-chat-schedules',
    );
    invalidateChatQueries(client, 'assignable-agents', {deviceId: target.deviceId});
    if (code === 'CHAT_DAILY_RESET') invalidateChatQueries(client, 'account-daily-reset', {deviceId: target.deviceId});
  } else if (code === 'INBOX_POLICY_UPDATED') {
    invalidate('inbox-policy');
  } else if (code === 'CHAT_CLOSE_RATING_UPDATED') {
    invalidateChatQueries(client, 'account-close-ratings', {deviceId: target.deviceId});
    invalidate('users-ratings', 'user-ratings-detail');
  } else if (code === 'CALL_AUTO_REJECTED' && target.deviceId) {
    invalidateChatQueries(client, 'call-auto-reject', {deviceId: target.deviceId});
  } else if (code === 'ROLE_UPDATED') {
    invalidate('roles', 'users');
  } else if (code === 'USERS_UPDATED') {
    invalidate('users', 'roles', 'users-ratings');
  }
}
