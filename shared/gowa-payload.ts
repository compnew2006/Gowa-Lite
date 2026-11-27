export function asRecord(val: unknown): Record<string, unknown> | null {
  return val && typeof val === 'object' && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : null;
}

export function firstNonEmptyString(...values: unknown[]): string {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) {
      return v.trim();
    }
  }
  return '';
}

export function unwrapGowaPayload(result: unknown): Record<string, unknown> | null {
  const obj = asRecord(result);
  if (!obj) return null;
  const payload = asRecord(obj.payload);
  if (payload) return payload;
  const message = asRecord(obj.message);
  if (message) return message;
  return obj;
}

export function extractGowaProtocolContext(
  resultObj: Record<string, unknown> | null,
  payload: Record<string, unknown> | null,
): {
  protocolMsg: Record<string, unknown> | null;
  protocolKey: Record<string, unknown> | null;
  isProtocolRevoke: boolean;
} {
  const nestedMessage = asRecord(payload?.message) ?? asRecord(resultObj?.message);
  const protocolMsg =
    asRecord(payload?.protocol_message) ??
    asRecord(payload?.protocolMessage) ??
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
  return {protocolMsg, protocolKey, isProtocolRevoke};
}

export function readGowaPayloadChatJid(
  outer: Record<string, unknown> | null,
  payload: Record<string, unknown> | null,
  protocolKey = extractGowaProtocolContext(outer, payload).protocolKey,
): string {
  const message = asRecord(payload?.message);
  return firstNonEmptyString(
    payload?.chat_jid, payload?.chat_id, payload?.remote_jid, payload?.remoteJid, payload?.revoked_chat,
    protocolKey?.remote_jid, protocolKey?.remoteJid,
    message?.chat_jid, message?.chat_id, message?.remote_jid, message?.remoteJid,
    outer?.chat_jid, outer?.chat_id, outer?.remote_jid, outer?.remoteJid,
    payload?.jid, message?.jid, outer?.jid, payload?.from, message?.from, outer?.from,
  );
}

export function extractGowaArray<T = unknown>(raw: unknown, ...keys: string[]): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    for (const key of keys) {
      if (Array.isArray(obj[key])) return obj[key] as T[];
    }
    if (Array.isArray(obj.data)) return obj.data as T[];
    if (Array.isArray(obj.results)) return obj.results as T[];
    if (Array.isArray(obj.messages)) return obj.messages as T[];
    if (Array.isArray(obj.items)) return obj.items as T[];
  }
  return [];
}
