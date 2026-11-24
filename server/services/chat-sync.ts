import {
  markCachedMessageRevoked,
  syncChatWatermarks,
  upsertCachedMessages,
  type CachedMessagePayload,
} from '../db.ts';
import type {GowaChatInfo, GowaDevice} from '../gowa-client.ts';
import type {GowaUpstreamEvent} from '../ws-bridge.ts';

export function resolveAccountDisplayName(device: GowaDevice, aliases: Record<string, string>): string {
  return (
    aliases[device.id] ||
    device.display_name?.trim() ||
    device.phone_number?.trim() ||
    device.id
  );
}

export function normalizeArabicDigits(value: string): string {
  return value
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

export function normalizeSearchQuery(raw: string): string {
  const ascii = normalizeArabicDigits(raw);
  const trimmed = ascii.trim();
  if (!trimmed) return '';
  if (/^[\d\s+().-]+$/.test(trimmed)) {
    return trimmed.replace(/[\s+().-]/g, '');
  }
  return trimmed;
}

export function normalizePhoneQueryForGowa(raw: string): string {
  const normalized = normalizeSearchQuery(raw);
  if (/^0\d+$/.test(normalized)) {
    const stripped = normalized.replace(/^0+/, '');
    if (stripped.length >= 3) {
      return stripped;
    }
  }
  return normalized;
}

export function matchesUnifiedChatSearch(
  chat: GowaChatInfo,
  deviceDisplayName: string,
  rawQuery: string,
  contactName?: string,
): boolean {
  const normalized = normalizeSearchQuery(rawQuery).toLowerCase();
  if (!normalized) return true;

  const isDigitsOnly = /^\d+$/.test(normalized);
  const strippedLeadingZero = isDigitsOnly ? normalized.replace(/^0+/, '') : '';
  const at = chat.jid.indexOf('@');
  const localJid = at === -1 ? chat.jid : chat.jid.slice(0, at);
  const phonePart = localJid.split(':')[0] ?? localJid;

  const candidates = [chat.name, contactName, phonePart, chat.jid, deviceDisplayName];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const lowered = normalizeArabicDigits(candidate).toLowerCase();
    if (lowered.includes(normalized)) return true;
    if (isDigitsOnly) {
      const compactDigits = lowered.replace(/[^\d]/g, '');
      if (compactDigits.includes(normalized)) return true;
      if (strippedLeadingZero.length >= 3 && compactDigits.includes(strippedLeadingZero)) {
        return true;
      }
    }
  }
  return false;
}

function unwrapEventPayload(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const obj = result as Record<string, unknown>;
  if (obj.payload && typeof obj.payload === 'object' && !Array.isArray(obj.payload)) {
    return obj.payload as Record<string, unknown>;
  }
  if (obj.message && typeof obj.message === 'object' && !Array.isArray(obj.message)) {
    return obj.message as Record<string, unknown>;
  }
  return obj;
}

function extractMediaFromWsPayload(raw: Record<string, unknown>): {
  mediaType: string;
  content: string;
  filename: string;
  url: string;
} {
  const directMediaType = typeof raw.media_type === 'string' ? raw.media_type.trim() : '';
  let content =
    typeof raw.content === 'string'
      ? raw.content
      : typeof raw.body === 'string'
        ? raw.body
        : typeof raw.text === 'string'
          ? raw.text
          : '';
  let filename = typeof raw.filename === 'string' ? raw.filename : '';
  let url = typeof raw.url === 'string' ? raw.url : '';

  const mediaKeys = ['image', 'video', 'audio', 'document', 'sticker'] as const;
  let detectedType = directMediaType;
  for (const key of mediaKeys) {
    const val = raw[key];
    if (!val) continue;
    if (!detectedType) detectedType = key;
    if (typeof val === 'string') {
      if (!url) url = val;
    } else if (typeof val === 'object' && !Array.isArray(val)) {
      const obj = val as Record<string, unknown>;
      if (!url && typeof obj.url === 'string') url = obj.url;
      if (!url && typeof obj.path === 'string') url = obj.path;
      if (!content && typeof obj.caption === 'string') content = obj.caption;
      if (!filename && typeof obj.filename === 'string') filename = obj.filename;
    }
  }

  return {mediaType: detectedType, content, filename, url};
}

export function handleUpstreamGowaEvent(deviceId: string, event: GowaUpstreamEvent): void {
  if (!deviceId) return;
  const code = (event.code || '').toUpperCase();
  const raw = unwrapEventPayload(event.result);
  if (!raw) return;

  const revokedCodes = new Set([
    'MESSAGE_REVOKED',
    'MESSAGE.REVOKED',
    'MESSAGE_DELETED',
    'MESSAGE.DELETED',
    'MESSAGE_REVOKE',
  ]);

  if (revokedCodes.has(code) || raw.revoked_message_id) {
    const revokedId = String(raw.revoked_message_id || raw.message_id || raw.id || '').trim();
    const chatJid =
      typeof raw.chat_jid === 'string'
        ? raw.chat_jid.trim()
        : typeof raw.chat_id === 'string'
          ? raw.chat_id.trim()
          : undefined;
    const revokedBy =
      typeof raw.from === 'string'
        ? raw.from.trim()
        : typeof raw.sender_jid === 'string'
          ? raw.sender_jid.trim()
          : undefined;
    if (revokedId) {
      markCachedMessageRevoked(deviceId, revokedId, {chatJid, revokedBy});
    }
    return;
  }

  if (code === 'MESSAGE_RECEIVED' || code === 'MESSAGE') {
    const id = String(raw.id || raw.message_id || '').trim();
    const rawChatJid = String(raw.chat_jid || raw.chat_id || raw.from || '').trim();
    const chatJid =
      rawChatJid && !rawChatJid.includes('@') && /^\+?\d{5,}$/.test(rawChatJid)
        ? `${rawChatJid.replace(/^\+/, '')}@s.whatsapp.net`
        : rawChatJid;
    if (!id || !chatJid) return;

    const isFromMe = Boolean(raw.is_from_me ?? raw.from_me);
    if (raw.is_revoked === true || raw.revoked === true || raw.media_type === 'revoked') {
      const revokedBy =
        typeof raw.from === 'string'
          ? raw.from.trim()
          : typeof raw.sender_jid === 'string'
            ? raw.sender_jid.trim()
            : undefined;
      markCachedMessageRevoked(deviceId, id, {chatJid, revokedBy});
      return;
    }

    const media = extractMediaFromWsPayload(raw);
    const timestamp =
      typeof raw.timestamp === 'string' && raw.timestamp.trim()
        ? raw.timestamp.trim()
        : new Date().toISOString();
    const repliedToId =
      typeof raw.replied_to_id === 'string' && raw.replied_to_id.trim()
        ? raw.replied_to_id.trim()
        : '';
    const contextMetadata =
      typeof raw.context_metadata === 'string'
        ? raw.context_metadata
        : repliedToId
          ? JSON.stringify({replied_to_id: repliedToId})
          : '';

    const msg: CachedMessagePayload = {
      id,
      chat_jid: chatJid,
      sender_jid: String(raw.sender_jid || raw.from || ''),
      sender_display_name:
        typeof raw.sender_display_name === 'string'
          ? raw.sender_display_name
          : typeof raw.pushname === 'string'
            ? raw.pushname
            : undefined,
      content: media.content,
      timestamp,
      is_from_me: isFromMe,
      media_type: media.mediaType,
      context_metadata: contextMetadata || undefined,
      filename: media.filename,
      url: media.url,
      file_length: typeof raw.file_length === 'number' ? raw.file_length : 0,
    };

    upsertCachedMessages(deviceId, chatJid, [msg], {markUnreadCandidate: true});
    syncChatWatermarks([{device_id: deviceId, chat_jid: chatJid, last_message_time: timestamp}]);
    return;
  }

  if (code === 'MESSAGE_EDITED' || code === 'MESSAGE.EDITED') {
    const id = String(raw.original_message_id || raw.message_id || raw.id || '').trim();
    const chatJid = String(raw.chat_jid || raw.chat_id || '').trim();
    const newBody = typeof raw.body === 'string' ? raw.body : typeof raw.content === 'string' ? raw.content : '';
    if (id && chatJid && newBody.trim()) {
      upsertCachedMessages(deviceId, chatJid, [
        {
          id,
          chat_jid: chatJid,
          sender_jid: String(raw.sender_jid || raw.from || ''),
          content: newBody,
          timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : new Date().toISOString(),
          is_from_me: Boolean(raw.is_from_me),
          media_type: '',
          filename: '',
          url: '',
          file_length: 0,
        },
      ]);
    }
  }
}

export function recipientMatchesChatJid(recipient: string, chatJid: string): boolean {
  const norm = (val: string) => {
    const clean = val.trim().toLowerCase();
    if (!clean) return '';
    if (clean.endsWith('@g.us') || clean.endsWith('@newsletter')) return clean;
    const at = clean.indexOf('@');
    const local = at === -1 ? clean : clean.slice(0, at);
    return local.split(':')[0].replace(/^\+/, '');
  };
  const a = norm(recipient);
  const b = norm(chatJid);
  return Boolean(a && b && a === b);
}
