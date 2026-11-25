import {parseTimestampMs, storeMessageReaction, type CachedReactionLike} from '../db.ts';
import {normalizeWhatsAppJid} from './chat-sync.ts';

export function isGowaReactionEvent(code: string): boolean {
  return code.toUpperCase().replace('.', '_') === 'MESSAGE_REACTION';
}

export function asReactionRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
}

function readString(...values: unknown[]): string {
  return values.find((value): value is string => typeof value === 'string' && Boolean(value.trim()))?.trim() ?? '';
}

export function readGowaReaction(result: unknown) {
  const envelope = asReactionRecord(result);
  const payload = asReactionRecord(envelope?.payload) ?? envelope;
  if (!payload) return null;
  const chatJid = normalizeWhatsAppJid(readString(payload.chat_id, payload.chat_jid));
  const messageId = readString(payload.reacted_message_id, payload.target_message_id, payload.message_id);
  const emoji = payload.reaction ?? payload.emoji;
  const isFromMe = payload.is_from_me === true || payload.from_me === true;
  const senderJid = normalizeWhatsAppJid(readString(payload.from, payload.sender_jid));
  const timestamp = readString(payload.timestamp);
  if (!chatJid || !messageId || typeof emoji !== 'string' || emoji.length > 32 ||
      (!senderJid && !isFromMe) || !parseTimestampMs(timestamp)) return null;
  return {
    chatJid,
    messageId,
    reaction: {
      emoji,
      sender_jid: senderJid,
      sender_display_name: readString(payload.sender_display_name, payload.from_name) || undefined,
      is_from_me: isFromMe,
      timestamp,
    },
  };
}

export function recordMessageReaction(
  deviceId: string,
  chatJid: string,
  messageId: string,
  reaction: CachedReactionLike,
) {
  chatJid = normalizeWhatsAppJid(chatJid) || chatJid;
  if (!storeMessageReaction(deviceId, chatJid, messageId, reaction)) return null;
  return {
    code: 'MESSAGE_REACTION',
    message: 'reaction',
    device_id: deviceId,
    result: {chat_jid: chatJid, message_id: messageId, ...reaction},
  };
}
