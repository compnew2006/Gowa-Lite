// Pure helpers for the chat-list last-message preview (P2-2).
//
// The server attaches `last_message_text` / `last_message_type` to every
// chat in the list response; this module turns those two fields into what
// the row renders: the text itself, or — for a media message with no text —
// a media-type icon + short label, never a blank line.

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

export function resolveChatPreview(
  chat: ChatPreviewSource,
  mediaLabels: Record<string, string>,
): ChatPreview | null {
  const text = normalizePreviewText(chat.last_message_text ?? '');
  if (text) return {kind: 'text', text};
  const mediaType = (chat.last_message_type ?? '').trim();
  if (!mediaType) return null;
  return {kind: 'media', mediaType, label: mediaLabels[mediaType] ?? mediaType};
}
