import path from 'node:path';
import {
  markCachedMessageRevoked,
  syncChatWatermarks,
  upsertCachedMessages,
  type CachedMessagePayload,
} from '../db.ts';
import {GowaError, type GowaChatInfo, type GowaDevice} from '../gowa-client.ts';
import type {GowaUpstreamEvent} from '../ws-bridge.ts';

export const MAX_MEDIA_UPLOAD_BYTES = 20 * 1024 * 1024;

const DANGEROUS_UPLOAD_EXTENSIONS = new Set([
  '.exe',
  '.bat',
  '.cmd',
  '.com',
  '.msi',
  '.ps1',
  '.vbs',
  '.scr',
  '.sh',
  '.dll',
  '.pif',
  '.jar',
  '.hta',
  '.cpl',
  '.lnk',
]);

export interface GowaMediaTarget {
  endpoint: '/send/image' | '/send/video' | '/send/audio' | '/send/file';
  fieldName: 'image' | 'video' | 'audio' | 'file';
  mediaType: 'image' | 'video' | 'audio' | 'document';
  supportsCaption: boolean;
  filename: string;
  mimeType: string;
}

function defaultUploadFilename(mimeType: string): string {
  if (mimeType === 'image/png') return 'image.png';
  if (mimeType === 'image/webp') return 'image.webp';
  if (mimeType === 'image/gif') return 'image.gif';
  if (mimeType.startsWith('image/')) return 'image.jpg';
  if (mimeType.startsWith('video/')) return 'video.mp4';
  if (mimeType === 'audio/mpeg') return 'audio.mp3';
  if (mimeType.startsWith('audio/')) return 'audio.ogg';
  if (mimeType === 'application/pdf') return 'document.pdf';
  return 'attachment.bin';
}

export function sanitizeMediaUploadFilename(rawFilename: string, mimeType: string): string {
  const normalizedSlashes = rawFilename.replace(/\\/g, '/').trim();
  const base = path.posix.basename(normalizedSlashes);
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*/\\]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');

  const ext = path.posix.extname(cleaned).toLowerCase();
  if (ext && DANGEROUS_UPLOAD_EXTENSIONS.has(ext)) {
    throw new GowaError(
      400,
      'BLOCKED_FILE_TYPE',
      'هذا النوع من الملفات التنفيذية غير مسموح بإرساله لأسباب أمنية',
    );
  }

  if (!cleaned) {
    return defaultUploadFilename(mimeType);
  }

  if (cleaned.length <= 180) return cleaned;
  if (ext && ext.length < 24) {
    const stem = cleaned.slice(0, 180 - ext.length).trimEnd();
    return `${stem || 'file'}${ext}`;
  }
  return cleaned.slice(0, 180);
}

export function resolveGowaMediaTarget(mimeTypeRaw: string, filenameRaw: string): GowaMediaTarget {
  const mimeType =
    mimeTypeRaw.split(';')[0].trim().toLowerCase() || 'application/octet-stream';
  const filename = sanitizeMediaUploadFilename(filenameRaw, mimeType);

  if (mimeType.startsWith('image/') && mimeType !== 'image/svg+xml') {
    return {
      endpoint: '/send/image',
      fieldName: 'image',
      mediaType: 'image',
      supportsCaption: true,
      filename,
      mimeType,
    };
  }
  if (mimeType.startsWith('video/')) {
    return {
      endpoint: '/send/video',
      fieldName: 'video',
      mediaType: 'video',
      supportsCaption: true,
      filename,
      mimeType,
    };
  }
  if (mimeType.startsWith('audio/')) {
    return {
      endpoint: '/send/audio',
      fieldName: 'audio',
      mediaType: 'audio',
      supportsCaption: false,
      filename,
      mimeType,
    };
  }
  return {
    endpoint: '/send/file',
    fieldName: 'file',
    mediaType: 'document',
    supportsCaption: true,
    filename,
    mimeType,
  };
}

const EXT_MIME_MAP: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
};

export function inferForwardMimeType(
  mediaType: string,
  filename: string,
  detectedContentType?: string,
): string {
  const cleanDetected = detectedContentType?.split(';')[0].trim().toLowerCase() || '';
  if (cleanDetected && cleanDetected !== 'application/octet-stream') {
    return cleanDetected;
  }
  const ext = path.posix.extname(filename.trim().toLowerCase());
  if (ext && EXT_MIME_MAP[ext]) {
    return EXT_MIME_MAP[ext];
  }
  const kind = mediaType.trim().toLowerCase();
  if (kind === 'image' || kind === 'sticker') return 'image/jpeg';
  if (kind === 'video') return 'video/mp4';
  if (kind === 'audio' || kind === 'ptt') return 'audio/ogg';
  return 'application/octet-stream';
}

export function isNewsletterJid(jid: string): boolean {
  return jid.trim().toLowerCase().endsWith('@newsletter');
}

export function isStatusBroadcastJid(jid: string): boolean {
  return jid.trim().toLowerCase() === 'status@broadcast';
}

export function normalizeWhatsAppJid(raw: string): string {
  const ascii = normalizeArabicDigits(raw).trim();
  if (!ascii) return '';

  if (ascii.includes('@')) {
    const compact = ascii.replace(/\s+/g, '');
    const match = /^([^@\s]+)@([a-z0-9.-]+)$/i.exec(compact);
    if (!match) return '';
    return `${match[1]}@${match[2].toLowerCase()}`;
  }

  const digits = ascii.replace(/[\s+().-]/g, '');
  if (/^\d{5,}$/.test(digits)) {
    return `${digits}@s.whatsapp.net`;
  }
  return '';
}

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
          : typeof raw.caption === 'string'
            ? raw.caption
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
    if (!id || !chatJid || isNewsletterJid(chatJid)) return;

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
    const rawChatJid = String(raw.chat_jid || raw.chat_id || raw.from || '').trim();
    const chatJid = normalizeWhatsAppJid(rawChatJid) || rawChatJid;
    const media = extractMediaFromWsPayload(raw);
    const editedBody = media.content;
    if (id && chatJid && !isNewsletterJid(chatJid) && editedBody.trim()) {
      const repliedToId =
        typeof raw.replied_to_id === 'string' && raw.replied_to_id.trim()
          ? raw.replied_to_id.trim()
          : '';
      const contextMetadata =
        typeof raw.context_metadata === 'string' && raw.context_metadata.trim()
          ? raw.context_metadata
          : repliedToId
            ? JSON.stringify({replied_to_id: repliedToId})
            : undefined;
      const timestamp =
        typeof raw.timestamp === 'string' && raw.timestamp.trim() ? raw.timestamp.trim() : '';

      upsertCachedMessages(deviceId, chatJid, [
        {
          id,
          chat_jid: chatJid,
          sender_jid: String(raw.sender_jid || raw.from || ''),
          sender_display_name:
            typeof raw.sender_display_name === 'string'
              ? raw.sender_display_name
              : typeof raw.pushname === 'string'
                ? raw.pushname
                : undefined,
          content: editedBody,
          timestamp,
          is_from_me: Boolean(raw.is_from_me ?? raw.from_me),
          media_type: media.mediaType,
          context_metadata: contextMetadata,
          filename: media.filename,
          url: media.url,
          file_length: typeof raw.file_length === 'number' ? raw.file_length : 0,
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
