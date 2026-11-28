// Pure helpers for the chat-list last-message preview (P2-2).
//
// The server attaches `last_message_text` / `last_message_type` to every
// chat in the list response; this module turns those two fields into what
// the row renders: the text itself, or — for a media message with no text —
// a media-type icon + short label, never a blank line.
//
// Call rows are the exception to "text wins": the gateway stores incoming
// calls as synthetic messages whose content is the raw English string
// "Incoming call" (media_type "call"). Showing that verbatim would leak an
// unlocalized label, so call rows render the localized call label instead
// (P2-2a).

export type ChatPreview =
  | {kind: 'text'; text: string}
  | {kind: 'media'; mediaType: string; label: string};

export interface ChatPreviewSource {
  last_message_text?: string | null;
  last_message_type?: string | null;
}

/** Collapse a message body to a single preview line. */
export function normalizePreviewText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The gateway's raw text for an incoming-call row (upstream
 * `CreateIncomingCallRecord`: content "Incoming call", media_type "call").
 * Matched against the whole normalized text only, so an ordinary message
 * that merely mentions a call keeps its own text.
 */
const GATEWAY_CALL_TEXT = 'incoming call';

/**
 * Whether a message is an incoming-call record. The gateway only records
 * incoming calls (media_type "call", never from-me), so the incoming-call
 * label is always the right one — there is no outgoing-call row to tell
 * apart. The raw-text match covers rows cached before media_type was
 * populated. Shared by the chat-list preview (P2-2a) and the open
 * conversation view, where a call message must show the localized call
 * label instead of the gateway's raw English text.
 */
export function isCallMessage(
  content: string | null | undefined,
  mediaType: string | null | undefined,
): boolean {
  if ((mediaType ?? '').trim().toLowerCase() === 'call') return true;
  return normalizePreviewText(content ?? '').toLowerCase() === GATEWAY_CALL_TEXT;
}

export function resolveChatPreview(
  chat: ChatPreviewSource,
  mediaLabels: Record<string, string>,
): ChatPreview | null {
  const text = normalizePreviewText(chat.last_message_text ?? '');
  const mediaType = (chat.last_message_type ?? '').trim();
  if (isCallMessage(text, mediaType)) {
    return {kind: 'media', mediaType: 'call', label: mediaLabels.call ?? 'call'};
  }
  if (text) return {kind: 'text', text};
  if (!mediaType) return null;
  return {kind: 'media', mediaType, label: mediaLabels[mediaType] ?? mediaType};
}
