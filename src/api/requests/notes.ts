import {http, results} from '@/lib/http';
import type {ChatRedactionReason, ConversationNote} from '@/api/contracts/chats';

const enc = encodeURIComponent;

// Conversation Notes (per chat)
export async function listUnifiedChatNotes(
  deviceId: string,
  chatJid: string,
): Promise<{
  notes: ConversationNote[];
  total: number;
  content_redacted?: boolean;
  redaction_reason?: ChatRedactionReason;
}> {
  const res = await results<{
    notes: ConversationNote[];
    total: number;
    content_redacted?: boolean;
    redaction_reason?: ChatRedactionReason;
  } | null>(http.get(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/notes`));
  return {
    notes: res?.notes ?? [],
    total: res?.total ?? 0,
    content_redacted: res?.content_redacted,
    redaction_reason: res?.redaction_reason,
  };
}

export function createUnifiedChatNote(
  deviceId: string,
  chatJid: string,
  payload: {content: string; is_pinned?: boolean},
): Promise<ConversationNote> {
  return results(http.post(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/notes`, payload));
}

export function updateUnifiedChatNote(
  deviceId: string,
  chatJid: string,
  noteId: number,
  payload: {content?: string; is_pinned?: boolean},
): Promise<ConversationNote> {
  return results(
    http.patch(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/notes/${noteId}`, payload),
  );
}

export async function deleteUnifiedChatNote(
  deviceId: string,
  chatJid: string,
  noteId: number,
): Promise<void> {
  await http.delete(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/notes/${noteId}`);
}
