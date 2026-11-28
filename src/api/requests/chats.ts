import {http, results} from '@/lib/http';
import type {
  ChatInfo,
  ChatListSummary,
  ChatRedactionReason,
  MessageInfo,
  MuteDuration,
  Pagination,
  UnifiedChatTab,
  UnifiedChatsResponse,
} from '@/api/contracts/chats';

const enc = encodeURIComponent;

// Unified Inbox
export {DEFAULT_UNIFIED_CHATS_QUERY_KEY} from '@/features/chat/inbox-query-keys';

export function listUnifiedChats(params: {
  deviceIds?: string[];
  search?: string;
  has_media?: boolean;
  tab?: UnifiedChatTab;
  assignedTo?: string | number;
  limit?: number;
  offset?: number;
}): Promise<UnifiedChatsResponse> {
  return results(
    http.get('/unified/chats', {
      params: {
        deviceIds: params.deviceIds && params.deviceIds.length > 0 ? params.deviceIds.join(',') : undefined,
        search: params.search || undefined,
        has_media: params.has_media ? 'true' : undefined,
        tab: params.tab || undefined,
        assignedTo:
          params.assignedTo !== undefined && params.assignedTo !== ''
            ? String(params.assignedTo)
            : undefined,
        limit: params.limit,
        offset: params.offset,
      },
    }),
  );
}

export function getUnifiedChatMessages(
  deviceId: string,
  chatJid: string,
  params: {limit?: number; offset?: number; search?: string; media_only?: boolean},
  signal?: AbortSignal,
): Promise<{
  data: MessageInfo[];
  pagination: Pagination;
  chat_info: ChatInfo;
  content_redacted?: boolean;
  redaction_reason?: ChatRedactionReason;
  reaction_webhook_configured?: boolean;
}> {
  return results(
    http.get(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/messages`, {
      signal,
      params: {
        limit: params.limit,
        offset: params.offset,
        search: params.search || undefined,
        media_only: params.media_only ? 'true' : undefined,
      },
    }),
  );
}

export function requestUnifiedChatHistory(
  deviceId: string,
  chatJid: string,
  count = 50,
): Promise<unknown> {
  return results(http.post(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/history`, {count}));
}

export function sendUnifiedTextMessage(
  deviceId: string,
  chatJid: string,
  message: string,
  replyMessageId?: string,
): Promise<{message_id: string; status: string}> {
  return results(
    http.post(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/send`, {
      message,
      ...(replyMessageId ? {reply_message_id: replyMessageId} : {}),
    }),
  );
}

export async function sendUnifiedMediaMessage(
  deviceId: string,
  chatJid: string,
  payload: {file: File; caption?: string},
): Promise<{message_id: string; status: string}> {
  // Multipart upload: the File goes straight into FormData (field `file`) so
  // the browser streams it without copying the whole file into an
  // ArrayBuffer first. Axios sets the multipart boundary automatically.
  const form = new FormData();
  form.append('file', payload.file, payload.file.name || 'attachment');
  const caption = payload.caption?.trim();
  if (caption) {
    form.append('caption', caption);
  }
  return results(
    http.post(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/send-media`, form, {
      timeout: 60_000,
    }),
  );
}

export function sendUnifiedMessageReaction(
  deviceId: string,
  chatJid: string,
  messageId: string,
  emoji: string,
): Promise<unknown> {
  return results(
    http.post(
      `/unified/chats/${enc(deviceId)}/${enc(chatJid)}/messages/${enc(messageId)}/reaction`,
      {emoji},
    ),
  );
}

export function revokeUnifiedMessage(
  deviceId: string,
  chatJid: string,
  messageId: string,
): Promise<unknown> {
  return results(
    http.post(
      `/unified/chats/${enc(deviceId)}/${enc(chatJid)}/messages/${enc(messageId)}/revoke`,
    ),
  );
}

export function forwardUnifiedMessage(
  deviceId: string,
  chatJid: string,
  messageId: string,
  payload: {
    target_device_id: string;
    target_jid: string;
    content?: string;
    media_type?: string;
    filename?: string;
    url?: string;
  },
): Promise<{message_id?: string; target_device_id: string; target_jid: string}> {
  return results(
    http.post(
      `/unified/chats/${enc(deviceId)}/${enc(chatJid)}/messages/${enc(messageId)}/forward`,
      payload,
    ),
  );
}

export function markUnifiedChatRead(
  deviceId: string,
  chatJid: string,
): Promise<{chat_jid: string; last_read_seq: number}> {
  return results(http.post(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/read`));
}

// Chat Row Menu Actions & Custom Lists
export function archiveUnifiedChat(
  deviceId: string,
  chatJid: string,
  archived: boolean,
): Promise<{chat_jid: string; archived: boolean; synced_remote: boolean}> {
  return results(http.post(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/archive`, {archived}));
}

export function pinUnifiedChat(
  deviceId: string,
  chatJid: string,
  pinned: boolean,
): Promise<{chat_jid: string; is_pinned: boolean; pinned_at_ms: number; synced_remote: boolean}> {
  return results(http.post(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/pin`, {pinned}));
}

export function muteUnifiedChat(
  deviceId: string,
  chatJid: string,
  duration: MuteDuration,
): Promise<{chat_jid: string; muted_until_ms: number}> {
  return results(http.post(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/mute`, {duration}));
}

export function setUnifiedChatUnread(
  deviceId: string,
  chatJid: string,
  unread: boolean,
): Promise<{chat_jid: string; unread: boolean}> {
  return results(http.post(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/unread`, {unread}));
}

export function favouriteUnifiedChat(
  deviceId: string,
  chatJid: string,
  favourite: boolean,
): Promise<{chat_jid: string; is_favourite: boolean}> {
  return results(
    http.post(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/favourite`, {favourite}),
  );
}

export function blockUnifiedChat(
  deviceId: string,
  chatJid: string,
  blocked: boolean,
): Promise<{chat_jid: string; is_blocked: boolean}> {
  return results(http.post(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/block`, {blocked}));
}

export function clearUnifiedChat(
  deviceId: string,
  chatJid: string,
): Promise<{chat_jid: string; cleared_before_ms: number; deleted_messages: number}> {
  return results(http.post(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/clear`));
}

export function deleteUnifiedChat(
  deviceId: string,
  chatJid: string,
): Promise<{chat_jid: string; deleted_before_ms: number}> {
  return results(http.post(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/delete`));
}

export async function listChatLists(): Promise<ChatListSummary[]> {
  const res = await results<ChatListSummary[] | null>(http.get('/unified/chat-lists'));
  return res ?? [];
}

export function createChatList(name: string): Promise<ChatListSummary> {
  return results(http.post('/unified/chat-lists', {name}));
}

export async function deleteChatList(listId: number): Promise<void> {
  await http.delete(`/unified/chat-lists/${listId}`);
}

export function assignUnifiedChatLists(
  deviceId: string,
  chatJid: string,
  listIds: number[],
): Promise<{chat_jid: string; list_ids: number[]}> {
  return results(
    http.put(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/lists`, {list_ids: listIds}),
  );
}
