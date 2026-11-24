import {toWhatsAppJid} from '@/lib/phone';

export type WsEventCode =
  | 'BRIDGE_STATUS'
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

function asRecord(val: unknown): Record<string, unknown> | null {
  return val && typeof val === 'object' && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : null;
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) {
      return v.trim();
    }
  }
  return '';
}

function unwrapWsObject(result: unknown): Record<string, unknown> | null {
  const obj = asRecord(result);
  if (!obj) return null;
  const payload = asRecord(obj.payload);
  if (payload) return payload;
  const message = asRecord(obj.message);
  if (message) return message;
  return obj;
}

export function extractWsEventTarget(event: WsEvent): {deviceId?: string; chatJid?: string} {
  const resultObj = asRecord(event.result);
  const payload = unwrapWsObject(event.result);
  const nestedMessage = asRecord(payload?.message) ?? asRecord(resultObj?.message);
  const protocolMsg =
    asRecord(payload?.protocol_message) ??
    asRecord(payload?.protocolMessage) ??
    asRecord(nestedMessage?.protocolMessage) ??
    asRecord(nestedMessage?.protocol_message) ??
    asRecord(resultObj?.protocol_message) ??
    asRecord(resultObj?.protocolMessage);
  const protocolKey = asRecord(protocolMsg?.key);

  const rawDeviceId = firstNonEmptyString(
    event.device_id,
    payload?.device_id,
    resultObj?.device_id,
  );

  const rawChat = firstNonEmptyString(
    payload?.chat_jid,
    payload?.chat_id,
    payload?.remote_jid,
    payload?.remoteJid,
    protocolKey?.remote_jid,
    protocolKey?.remoteJid,
    resultObj?.chat_jid,
    resultObj?.chat_id,
    payload?.jid,
    resultObj?.jid,
    payload?.from,
    resultObj?.from,
  );
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

export function extractWsRevokeTarget(event: WsEvent): WsRevokeTarget | null {
  const code = (event.code || '').toUpperCase();
  const resultObj = asRecord(event.result);
  const payload = unwrapWsObject(event.result);
  if (!payload) return null;

  const nestedMessage = asRecord(payload.message) ?? asRecord(resultObj?.message);
  const protocolMsg =
    asRecord(payload.protocol_message) ??
    asRecord(payload.protocolMessage) ??
    asRecord(nestedMessage?.protocolMessage) ??
    asRecord(nestedMessage?.protocol_message) ??
    asRecord(resultObj?.protocol_message) ??
    asRecord(resultObj?.protocolMessage);
  const protocolKey = asRecord(protocolMsg?.key);
  const protocolType = protocolMsg?.type;
  const isProtocolRevoke =
    protocolMsg !== null &&
    (protocolType === 0 ||
      String(protocolType || '').toUpperCase() === 'REVOKE' ||
      String(protocolType || '').toUpperCase() === 'MESSAGE_REVOKE');

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

type Handler = (event: WsEvent) => void;

const handlers = new Set<Handler>();

export function onWsEvent(handler: Handler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

export function emitWsEvent(event: WsEvent): void {
  for (const handler of handlers) {
    handler(event);
  }
}
