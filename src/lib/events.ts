import {toWhatsAppJid} from '@/lib/phone';
import type {MessageInfo, ReactionInfo} from '@/api/types';
import {
  asRecord,
  extractGowaProtocolContext,
  firstNonEmptyString,
  readGowaPayloadChatJid,
  unwrapGowaPayload,
} from '../../shared/gowa-payload.ts';

export type WsEventCode =
  | 'BRIDGE_STATUS'
  | 'WS_BATCH'
  | 'LOGIN_SUCCESS'
  | 'LIST_DEVICES'
  | 'DEVICE_REMOVED'
  | 'DEVICE_LOGGED_OUT'
  | 'DEVICE_STREAM_REPLACED'
  | 'DEVICE_TEMPORARY_BAN'
  | 'DEVICE_REACHOUT_TIMELOCK'
  | 'MESSAGE_RECEIVED'
  | 'MESSAGE_REVOKED'
  | 'MESSAGE.REVOKED'
  | 'MESSAGE_DELETED'
  | 'MESSAGE.DELETED'
  | 'MESSAGE_REVOKE'
  | 'MESSAGE.REVOKE'
  | 'MESSAGE_REACTION'
  | 'MESSAGE_UPDATED'
  | 'MESSAGE_EDITED'
  | 'MESSAGE.EDITED'
  | 'CONVERSATION_NOTE_UPDATED'
  | 'CHAT_LIFECYCLE_UPDATED'
  | 'CHAT_VIEWERS'
  | 'CHAT_DAILY_RESET'
  | 'CALL_AUTO_REJECTED'
  | 'INBOX_POLICY_UPDATED'
  | 'SCHEDULE_UPDATED'
  | 'USER_ACCESS_UPDATED'
  | 'CHAT_UPDATED'
  | string;

export interface WsEvent {
  code: WsEventCode;
  message: string;
  result: unknown;
  device_id?: string;
}

export interface WsRevokeTarget {
  deviceId?: string;
  chatJid?: string;
  messageId: string;
  revokedBy?: string;
  revokedAt?: string;
}

export function extractWsReaction(event: WsEvent): {deviceId: string; chatJid: string; messageId: string; reaction: ReactionInfo} | null {
  if (event.code !== 'MESSAGE_REACTION') return null;
  const result = asRecord(event.result);
  if (!result || result.content_redacted === true || !event.device_id ||
      typeof result.chat_jid !== 'string' || typeof result.message_id !== 'string' ||
      typeof result.emoji !== 'string' || typeof result.sender_jid !== 'string' ||
      typeof result.is_from_me !== 'boolean' || typeof result.timestamp !== 'string') return null;
  return {
    deviceId: event.device_id,
    chatJid: result.chat_jid,
    messageId: result.message_id,
    reaction: {
      emoji: result.emoji,
      sender_jid: result.sender_jid,
      sender_display_name: firstNonEmptyString(result.sender_display_name) || undefined,
      is_from_me: result.is_from_me,
      timestamp: result.timestamp,
    },
  };
}

export function extractWsEventTarget(event: WsEvent): {deviceId?: string; chatJid?: string} {
  const resultObj = asRecord(event.result);
  const payload = unwrapGowaPayload(event.result);
  const rawDeviceId = firstNonEmptyString(
    event.device_id,
    payload?.device_id,
    resultObj?.device_id,
  );

  const rawChat = readGowaPayloadChatJid(resultObj, payload);
  const chatJid = rawChat ? toWhatsAppJid(rawChat) || rawChat : '';

  return {
    deviceId: rawDeviceId || undefined,
    chatJid: chatJid || undefined,
  };
}

const REVOKED_WS_CODES = new Set([
  'MESSAGE_REVOKED',
  'MESSAGE.REVOKED',
  'MESSAGE_DELETED',
  'MESSAGE.DELETED',
  'MESSAGE_REVOKE',
  'MESSAGE.REVOKE',
]);

export interface ChatViewersFrame {
  deviceId: string;
  chatJid: string;
  viewers: Array<{userId: number; displayName: string}>;
}

// P2-1 presence: {code: 'CHAT_VIEWERS', device_id, result: {device_id,
// chat_jid, viewers: [{user_id, display_name}]}}. Returns null for any other
// code or a malformed viewer list — the caller never trusts a partial frame.
// The list is the full set including the receiving user; the badge filters
// the current user out (see MessageViewHeader).
export function extractChatViewers(event: WsEvent): ChatViewersFrame | null {
  if (event.code !== 'CHAT_VIEWERS') return null;
  const resultObj = asRecord(event.result);
  if (!resultObj) return null;
  const deviceId = firstNonEmptyString(event.device_id, resultObj.device_id);
  const chatJid = firstNonEmptyString(resultObj.chat_jid);
  if (!deviceId || !chatJid) return null;
  const rawViewers = resultObj.viewers;
  if (!Array.isArray(rawViewers)) return null;
  const viewers: Array<{userId: number; displayName: string}> = [];
  for (const entry of rawViewers) {
    const record = asRecord(entry);
    if (
      !record ||
      typeof record.user_id !== 'number' ||
      typeof record.display_name !== 'string'
    ) {
      return null;
    }
    viewers.push({userId: record.user_id, displayName: record.display_name});
  }
  return {deviceId, chatJid, viewers};
}

export function extractWsRevokeTarget(event: WsEvent): WsRevokeTarget | null {
  const code = (event.code || '').toUpperCase();
  const resultObj = asRecord(event.result);
  const payload = unwrapGowaPayload(event.result);
  if (!payload) return null;

  const {protocolKey, isProtocolRevoke} = extractGowaProtocolContext(resultObj, payload);

  const rawAction = firstNonEmptyString(payload.action, resultObj?.action).toLowerCase();
  const rawMediaType = firstNonEmptyString(payload.media_type, resultObj?.media_type).toLowerCase();

  const isRevoke =
    REVOKED_WS_CODES.has(code) ||
    Boolean(firstNonEmptyString(payload.revoked_message_id, resultObj?.revoked_message_id)) ||
    payload.is_revoked === true ||
    payload.revoked === true ||
    payload.retracted === true ||
    rawMediaType === 'revoked' ||
    rawAction === 'revoke' ||
    rawAction === 'delete' ||
    isProtocolRevoke;

  if (!isRevoke) return null;

  const messageId = firstNonEmptyString(
    payload.revoked_message_id,
    resultObj?.revoked_message_id,
    protocolKey?.id,
    payload.target_message_id,
    payload.deleted_message_id,
    payload.original_message_id,
    payload.message_id,
    resultObj?.message_id,
    payload.id,
    resultObj?.id,
  );
  if (!messageId) return null;

  const target = extractWsEventTarget(event);
  const rawRevokedBy = firstNonEmptyString(
    payload.revoked_by,
    resultObj?.revoked_by,
    payload.sender_jid,
    protocolKey?.participant,
    payload.from,
    resultObj?.from,
  );
  const revokedBy = rawRevokedBy ? toWhatsAppJid(rawRevokedBy) || rawRevokedBy : undefined;
  const revokedAt = firstNonEmptyString(
    payload.revoked_at,
    resultObj?.revoked_at,
    payload.timestamp,
    resultObj?.timestamp,
  );

  return {
    deviceId: target.deviceId,
    chatJid: target.chatJid,
    messageId,
    revokedBy: revokedBy || undefined,
    revokedAt: revokedAt || undefined,
  };
}

export function extractWsIncomingMessage(
  event: WsEvent,
): {deviceId: string; chatJid: string; message: MessageInfo} | null {
  const code = (event.code || '').toUpperCase();
  if (code !== 'MESSAGE_RECEIVED' && code !== 'MESSAGE') return null;

  const target = extractWsEventTarget(event);
  if (!target.deviceId || !target.chatJid) return null;

  const resultObj = asRecord(event.result);
  const payload = unwrapGowaPayload(event.result);
  const source = payload ?? resultObj;
  if (!source || source.content_redacted === true || resultObj?.content_redacted === true) {
    return null;
  }

  const id = firstNonEmptyString(
    source.id,
    source.message_id,
    resultObj?.id,
    resultObj?.message_id,
  );
  if (!id) return null;

  const hasNormalizedBody =
    typeof source.content === 'string' || typeof source.media_type === 'string';
  if (!hasNormalizedBody) return null;

  const repliedTo = firstNonEmptyString(source.replied_to_id, source.replied_id);
  const contextMetadata =
    typeof source.context_metadata === 'string'
      ? source.context_metadata
      : repliedTo
        ? JSON.stringify({replied_to_id: repliedTo})
        : undefined;

  const message: MessageInfo = {
    id,
    chat_jid: target.chatJid,
    sender_jid: firstNonEmptyString(source.sender_jid, source.from, resultObj?.from),
    sender_display_name:
      firstNonEmptyString(source.sender_display_name, source.pushname) || undefined,
    content: typeof source.content === 'string' ? source.content : '',
    timestamp: firstNonEmptyString(source.timestamp) || new Date().toISOString(),
    is_from_me: Boolean(source.is_from_me ?? source.from_me),
    media_type: typeof source.media_type === 'string' ? source.media_type : '',
    ...(contextMetadata ? {context_metadata: contextMetadata} : {}),
    filename: typeof source.filename === 'string' ? source.filename : '',
    url: typeof source.url === 'string' ? source.url : '',
    file_length: typeof source.file_length === 'number' ? source.file_length : 0,
  };

  return {
    deviceId: target.deviceId,
    chatJid: target.chatJid,
    message,
  };
}

type Handler = (event: WsEvent) => void;
type BatchHandler = (events: WsEvent[]) => void;

const handlers = new Set<Handler>();
const batchHandlers = new Set<BatchHandler>();

export function onWsEvent(handler: Handler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

export function onWsBatch(handler: BatchHandler): () => void {
  batchHandlers.add(handler);
  return () => {
    batchHandlers.delete(handler);
  };
}

export function emitWsEvent(event: WsEvent): void {
  for (const handler of handlers) {
    handler(event);
  }
}

export function emitWsBatch(events: WsEvent[]): void {
  for (const handler of batchHandlers) {
    handler(events);
  }
}

// Batch frame format agreed with server/ws-bridge.ts (P2):
//   {code: 'WS_BATCH', message: '', result: {events: [<WsEvent>, ...]}}
// Expands a batch frame into its events in arrival order; plain frames pass
// through unchanged. A malformed batch (no events array) is returned as-is so
// nothing is silently dropped.
export function expandWsBatchFrame(frame: WsEvent): WsEvent[] {
  if (frame.code !== 'WS_BATCH') return [frame];
  const result = asRecord(frame.result);
  const events = result?.events;
  if (!Array.isArray(events)) return [frame];
  return events.filter(
    (entry): entry is WsEvent =>
      typeof entry === 'object' && entry !== null &&
      typeof (entry as {code?: unknown}).code === 'string',
  );
}

export function emitWsFrame(frame: WsEvent): void {
  // Every frame is delivered as a batch (size 1 for plain frames) so the
  // batch-aware consumer can coalesce cache work; per-event consumers still
  // receive each event individually, in order.
  const events = expandWsBatchFrame(frame);
  emitWsBatch(events);
  for (const event of events) {
    emitWsEvent(event);
  }
}
