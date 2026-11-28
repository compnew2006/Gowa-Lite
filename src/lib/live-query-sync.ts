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
  syncLiveQueryCacheInternal(client, event);
}

// Batched sync (P2): apply a whole WS_BATCH frame as one unit. Cache patches
// (reactions, incoming messages, revokes) still run per event in arrival
// order, but invalidations are collected and executed once at the end — the
// unified inbox is invalidated at most once per batch (per device scope)
// instead of once per event, so a burst triggers one inbox refetch.
export function syncLiveQueryBatch(client: QueryClient, events: WsEvent[]): void {
  const deferred = newDeferredInvalidations();
  for (const event of events) syncLiveQueryCacheInternal(client, event, deferred);
  flushDeferredInvalidations(client, deferred);
}

interface DeferredInvalidations {
  inboxDevices: Set<string | undefined>;
  roots: Set<string>;
  chatTargets: Map<string, {root: string; target: {deviceId?: string; chatJid?: string}}>;
  messageDevices: Map<string, {deviceId: string; chatJid: string}>;
}

function newDeferredInvalidations(): DeferredInvalidations {
  return {inboxDevices: new Set(), roots: new Set(), chatTargets: new Map(), messageDevices: new Map()};
}

function flushDeferredInvalidations(client: QueryClient, deferred: DeferredInvalidations): void {
  for (const deviceId of deferred.inboxDevices) invalidateInbox(client, deviceId);
  for (const root of deferred.roots) void client.invalidateQueries({queryKey: [root]});
  for (const {root, target} of deferred.chatTargets.values()) {
    invalidateChatQueries(client, root, target);
  }
  for (const {deviceId, chatJid} of deferred.messageDevices.values()) {
    void client.invalidateQueries({
      queryKey: messageQueryKeys.device(deviceId),
      predicate: (query) => {
        const rawJid = query.queryKey[2];
        return (
          typeof rawJid === 'string' &&
          (toWhatsAppJid(rawJid) || rawJid) === chatJid &&
          !isUnfilteredPatchableMessageQuery(query)
        );
      },
    });
  }
}

function syncLiveQueryCacheInternal(
  client: QueryClient,
  event: WsEvent,
  deferred?: DeferredInvalidations,
): void {
  const code = event.code.toUpperCase();
  if (code === 'MESSAGE_REACTION') {
    patchReaction(client, event);
    return;
  }

  const target = extractWsEventTarget(event);
  const jid = target.chatJid?.toLowerCase();
  const invalidate = (...roots: string[]) => {
    if (deferred) {
      for (const root of roots) deferred.roots.add(root);
      return;
    }
    for (const root of roots) void client.invalidateQueries({queryKey: [root]});
  };
  const invalidateChat = (...roots: string[]) => {
    if (deferred) {
      for (const root of roots) {
        deferred.chatTargets.set(
          JSON.stringify([root, target.deviceId ?? null, target.chatJid ?? null]),
          {root, target},
        );
      }
      return;
    }
    for (const root of roots) invalidateChatQueries(client, root, target);
  };
  const invalidateInboxDeferred = (deviceId: string | undefined) => {
    if (deferred) {
      deferred.inboxDevices.add(deviceId);
      return;
    }
    invalidateInbox(client, deviceId);
  };
  const invalidateNonPatchableMessages = (deviceId: string, chatJid: string) => {
    if (deferred) {
      deferred.messageDevices.set(`${deviceId}::${chatJid}`, {deviceId, chatJid});
      return;
    }
    void client.invalidateQueries({
      queryKey: messageQueryKeys.device(deviceId),
      predicate: (query) => {
        const rawJid = query.queryKey[2];
        return (
          typeof rawJid === 'string' &&
          (toWhatsAppJid(rawJid) || rawJid) === chatJid &&
          !isUnfilteredPatchableMessageQuery(query)
        );
      },
    });
  };

  if (DEVICE_EVENTS.has(code)) {
    invalidateInboxDeferred(target.deviceId);
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
    if (!jid?.endsWith('@g.us')) invalidateInboxDeferred(target.deviceId);

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
      // A message sent from this device can be a fired schedule: the
      // gateway executed it, so the "scheduled" bubble must leave the
      // timeline and the sent message takes its place. Refetch this
      // chat's schedules; other people's messages never fire a schedule.
      if (incoming.message.is_from_me) {
        invalidateChat('unified-chat-schedules');
      }
      invalidateNonPatchableMessages(incoming.deviceId, normalizedChatJid);
    } else {
      invalidateChat(messageQueryKeys.all[0]);
    }
  } else if (code === 'CONVERSATION_NOTE_UPDATED') {
    invalidateChat('unified-chat-notes');
  } else if (code === 'SCHEDULE_UPDATED') {
    invalidateChat('unified-chat-schedules');
    invalidate('schedules');
  } else if (code === 'CHAT_LIFECYCLE_UPDATED' || code === 'CHAT_DAILY_RESET') {
    invalidateInboxDeferred(target.deviceId);
    invalidateChat(
      chatLifecycleQueryKeys.all[0],
      messageQueryKeys.all[0],
      'unified-chat-notes',
      'unified-chat-schedules',
    );
    invalidateChat('assignable-agents');
    if (code === 'CHAT_DAILY_RESET') invalidateChat('account-daily-reset');
  } else if (code === 'INBOX_POLICY_UPDATED') {
    invalidate('inbox-policy');
  } else if (code === 'CHAT_CLOSE_RATING_UPDATED') {
    invalidateChat('account-close-ratings');
    invalidate('users-ratings', 'user-ratings-detail');
  } else if (code === 'CALL_AUTO_REJECTED' && target.deviceId) {
    invalidateChat('call-auto-reject');
  } else if (code === 'ROLE_UPDATED') {
    invalidate('roles', 'users');
  } else if (code === 'USERS_UPDATED') {
    invalidate('users', 'roles', 'users-ratings');
  }
}
