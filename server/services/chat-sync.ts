import path from 'node:path';
import {
  markCachedMessageRevoked,
  parseTimestampMs,
  syncChatWatermarks,
  upsertCachedMessages,
  type CachedMessagePayload,
} from '../db.ts';
import {GowaError, type GowaChatInfo, type GowaDevice} from '../gowa-client.ts';
import type {GowaUpstreamEvent} from '../ws-bridge.ts';
import {handleIncomingCallOffer, isCallOfferEventCode} from './call-auto-reject.ts';
import {buildCloseRatingUpdatedEvent, captureChatCloseRating} from './chat-close-rating.ts';
import {
  handleIncomingCustomerMessageLifecycle,
  type ChatLifecycleWsPayload,
} from './chat-lifecycle.ts';

import {
  isGroupJid,
  isNewsletterJid,
  isStatusBroadcastJid,
  matchesNormalizedSearch,
  normalizeWhatsAppJid,
  resolveIsFromMe,
} from '../../shared/whatsapp-identity.ts';
import {
  asRecord,
  extractGowaProtocolContext,
  firstNonEmptyString,
  readGowaPayloadChatJid,
  unwrapGowaPayload,
} from '../../shared/gowa-payload.ts';

export {
  isExcludedFromUnifiedChats,
  isGroupJid,
  isNewsletterJid,
  isStatusBroadcastJid,
  normalizeArabicDigits,
  normalizePhoneQueryForGowa,
  normalizeSearchQuery,
  normalizeWhatsAppJid,
} from '../../shared/whatsapp-identity.ts';

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

export function resolveAccountDisplayName(device: GowaDevice, aliases: Record<string, string>): string {
  return (
    aliases[device.id] ||
    device.display_name?.trim() ||
    device.phone_number?.trim() ||
    device.id
  );
}

export function matchesUnifiedChatSearch(
  chat: GowaChatInfo,
  deviceDisplayName: string,
  rawQuery: string,
  contactName?: string,
): boolean {
  const at = chat.jid.indexOf('@');
  const localJid = at === -1 ? chat.jid : chat.jid.slice(0, at);
  const phonePart = localJid.split(':')[0] ?? localJid;
  return matchesNormalizedSearch(
    [chat.name, contactName, phonePart, chat.jid, deviceDisplayName],
    rawQuery,
  );
}

export function readGowaEventChatJid(result: unknown, protocolKey?: Record<string, unknown> | null): string {
  const jid = readGowaPayloadChatJid(asRecord(result), unwrapGowaPayload(result), protocolKey);
  return jid ? normalizeWhatsAppJid(jid) || jid : '';
}

export function readGowaIncomingMessageId(result: unknown): string {
  const outer = asRecord(result);
  const payload = unwrapGowaPayload(result);
  return firstNonEmptyString(payload?.id, payload?.message_id, outer?.id, outer?.message_id);
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

export function handleUpstreamGowaEvent(
  deviceId: string,
  event: GowaUpstreamEvent,
  onLifecycleEvent?: (payload: ChatLifecycleWsPayload | Record<string, unknown>) => void,
  onRatingConsumed?: () => void,
  // The device's own JID (from the gateway `/devices` list, via
  // GowaWsBridge.getDeviceOwnJid). `is_from_me` is derived from
  // sender_jid == device JID (decision 19); without it the derivation
  // falls back to the gateway flag alone.
  deviceOwnJid?: string,
): ChatLifecycleWsPayload | null {
  if (!deviceId) return null;
  const code = (event.code || '').toUpperCase();
  if (isCallOfferEventCode(code)) {
    void handleIncomingCallOffer(deviceId, event.result, onLifecycleEvent);
    return null;
  }
  const resultObj = asRecord(event.result);
  const raw = unwrapGowaPayload(event.result);
  if (!raw) return null;

  const {protocolKey, isProtocolRevoke} = extractGowaProtocolContext(resultObj, raw);

  const revokedCodes = new Set([
    'MESSAGE_REVOKED',
    'MESSAGE.REVOKED',
    'MESSAGE_DELETED',
    'MESSAGE.DELETED',
    'MESSAGE_REVOKE',
    'MESSAGE.REVOKE',
  ]);
  const rawAction = firstNonEmptyString(raw.action, resultObj?.action).toLowerCase();
  const rawMediaType = firstNonEmptyString(raw.media_type, resultObj?.media_type).toLowerCase();
  const isRevokePayload =
    revokedCodes.has(code) ||
    Boolean(firstNonEmptyString(raw.revoked_message_id, resultObj?.revoked_message_id)) ||
    raw.is_revoked === true ||
    raw.revoked === true ||
    raw.retracted === true ||
    rawMediaType === 'revoked' ||
    rawAction === 'revoke' ||
    rawAction === 'delete' ||
    isProtocolRevoke;

  if (isRevokePayload) {
    const revokedId = firstNonEmptyString(
      raw.revoked_message_id,
      resultObj?.revoked_message_id,
      protocolKey?.id,
      raw.target_message_id,
      raw.deleted_message_id,
      raw.original_message_id,
      raw.message_id,
      resultObj?.message_id,
      raw.id,
      resultObj?.id,
    );
    const chatJid = readGowaEventChatJid(event.result, protocolKey);
    const rawRevokedBy = firstNonEmptyString(
      raw.sender_jid,
      protocolKey?.participant,
      raw.from,
      resultObj?.sender_jid,
      resultObj?.from,
    );
    const revokedBy = rawRevokedBy ? normalizeWhatsAppJid(rawRevokedBy) || rawRevokedBy : undefined;
    const revokedAt =
      firstNonEmptyString(raw.revoked_at, raw.timestamp, resultObj?.timestamp) ||
      new Date().toISOString();

    if (revokedId && chatJid && !isNewsletterJid(chatJid) && !isStatusBroadcastJid(chatJid)) {
      markCachedMessageRevoked(deviceId, revokedId, {chatJid, revokedBy, revokedAt});
      onLifecycleEvent?.({
        code: 'MESSAGE_REVOKED',
        message: 'revoked',
        device_id: deviceId,
        result: {
          device_id: deviceId,
          chat_jid: chatJid,
          revoked_message_id: revokedId,
          message_id: revokedId,
          revoked_by: revokedBy ?? null,
          revoked_at: revokedAt,
        },
      });
    }
    return null;
  }

  if (code === 'MESSAGE_RECEIVED' || code === 'MESSAGE') {
    const id = readGowaIncomingMessageId(event.result);
    const chatJid = readGowaEventChatJid(event.result);
    if (!id || !chatJid || isNewsletterJid(chatJid)) return null;

    const gatewayFlag = raw.is_from_me ?? raw.from_me;
    const isFromMe = resolveIsFromMe(
      String(raw.sender_jid || raw.from || ''),
      deviceOwnJid,
      typeof gatewayFlag === 'boolean' ? gatewayFlag : undefined,
    );

    const media = extractMediaFromWsPayload(raw);
    const timestamp =
      typeof raw.timestamp === 'string' && raw.timestamp.trim()
        ? raw.timestamp.trim()
        : new Date().toISOString();
    const repliedToId = firstNonEmptyString(raw.replied_to_id, raw.replied_id);
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

    const rating = !isFromMe && event.device_id === deviceId
      ? captureChatCloseRating(deviceId, chatJid, {
        id, text: msg.content, mediaType: msg.media_type,
        timestampMs: parseTimestampMs(timestamp), replyToId: repliedToId || undefined,
      })
      : undefined;
    upsertCachedMessages(deviceId, chatJid, [msg], {markUnreadCandidate: !rating});
    if (rating) {
      onRatingConsumed?.();
      if (rating === 'recorded') onLifecycleEvent?.(buildCloseRatingUpdatedEvent(deviceId));
      return null;
    }
    syncChatWatermarks([{device_id: deviceId, chat_jid: chatJid, last_message_time: timestamp}]);

    if (!isFromMe && !isStatusBroadcastJid(chatJid) && !isGroupJid(chatJid)) {
      const lifecyclePayload = handleIncomingCustomerMessageLifecycle(
        deviceId,
        chatJid,
        parseTimestampMs(timestamp),
      );
      if (lifecyclePayload) {
        onLifecycleEvent?.(lifecyclePayload);
        return lifecyclePayload;
      }
    }
    return null;
  }

  if (code === 'MESSAGE_EDITED' || code === 'MESSAGE.EDITED') {
    const id = String(raw.original_message_id || raw.message_id || raw.id || '').trim();
    const chatJid = readGowaEventChatJid(event.result);
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
      const editedGatewayFlag = raw.is_from_me ?? raw.from_me;
      const editedIsFromMe = resolveIsFromMe(
        String(raw.sender_jid || raw.from || ''),
        deviceOwnJid,
        typeof editedGatewayFlag === 'boolean' ? editedGatewayFlag : undefined,
      );

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
          is_from_me: editedIsFromMe,
          media_type: media.mediaType,
          context_metadata: contextMetadata,
          filename: media.filename,
          url: media.url,
          file_length: typeof raw.file_length === 'number' ? raw.file_length : 0,
        },
      ]);
    }
  }
  return null;
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
