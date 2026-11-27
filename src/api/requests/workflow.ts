import {http, results} from '@/lib/http';
import type {
  AssignableAgent,
  BulkLifecycleResponse,
  ChatAssignmentInfo,
  ChatLifecycleEvent,
  ChatLifecycleResponse,
} from '@/api/contracts/workflow';

const enc = encodeURIComponent;

// Chat Lifecycle & Assignment
export async function listAssignableAgents(deviceId: string): Promise<AssignableAgent[]> {
  const res = await results<AssignableAgent[] | null>(
    http.get('/unified/assignable-agents', {params: {deviceId}}),
  );
  return res ?? [];
}

export function getChatLifecycle(deviceId: string, chatJid: string): Promise<ChatLifecycleResponse> {
  return results(http.get(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/lifecycle`));
}

export function claimUnifiedChat(
  deviceId: string,
  chatJid: string,
  cachedTitle?: string,
): Promise<{assignment: ChatAssignmentInfo; event: ChatLifecycleEvent}> {
  return results(
    http.post(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/claim`, {
      ...(cachedTitle ? {cached_title: cachedTitle} : {}),
    }),
  );
}

export function assignUnifiedChat(
  deviceId: string,
  chatJid: string,
  payload: {assigned_user_id: number | null; note?: string; cached_title?: string},
): Promise<{assignment: ChatAssignmentInfo; event?: ChatLifecycleEvent}> {
  return results(http.post(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/assign`, payload));
}

export function releaseUnifiedChat(
  deviceId: string,
  chatJid: string,
  payload?: {note?: string; cached_title?: string},
): Promise<{assignment: ChatAssignmentInfo; event?: ChatLifecycleEvent}> {
  return results(
    http.post(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/release`, payload ?? {}),
  );
}

export function closeUnifiedChat(
  deviceId: string,
  chatJid: string,
  payload?: {reason?: string; cached_title?: string},
): Promise<{assignment: ChatAssignmentInfo; event?: ChatLifecycleEvent; rating_prompt?: 'sent' | 'failed'}> {
  return results(
    http.post(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/close`, payload ?? {}),
  );
}

export function reopenUnifiedChat(
  deviceId: string,
  chatJid: string,
  payload?: {assign_to_self?: boolean; note?: string; cached_title?: string},
): Promise<{assignment: ChatAssignmentInfo; event?: ChatLifecycleEvent}> {
  return results(
    http.post(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/reopen`, payload ?? {}),
  );
}

export function bulkUnifiedChatsLifecycle(payload: {
  items: Array<{device_id: string; chat_jid: string; cached_title?: string}>;
  action: 'close' | 'release' | 'assign' | 'reopen';
  assigned_user_id?: number | null;
  note?: string;
  reason?: string;
}): Promise<BulkLifecycleResponse> {
  return results(http.post('/unified/chats/bulk-lifecycle', payload));
}
