type ChatIdentity = {
  jid: string;
  name?: string | null;
};

type SenderIdentity = {
  sender_jid: string;
  sender_display_name?: string | null;
};

export function formatJidPhone(jid: string): string {
  const at = jid.indexOf('@');
  const local = at === -1 ? jid : jid.slice(0, at);
  const colon = local.indexOf(':');
  return colon === -1 ? local : local.slice(0, colon);
}

const PHONE_JID_SUFFIXES = ['@s.whatsapp.net', '@c.us'] as const;

// A phone number may only be derived from a JID whose suffix is a personal
// WhatsApp identity. An @lid JID is a linked identity, not a phone number,
// and must never be displayed as one (Phase 3 P1-12, decision 13).
export function phoneFromJid(jid: string | null | undefined): string {
  if (!jid) return '';
  const lower = jid.toLowerCase();
  if (!PHONE_JID_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return '';
  return formatJidPhone(jid);
}

export function chatDisplayName(chat: ChatIdentity): string {
  const name = chat.name?.trim();
  return name || formatJidPhone(chat.jid);
}

export function senderDisplayName(message: SenderIdentity): string {
  const name = message.sender_display_name?.trim();
  return name || formatJidPhone(message.sender_jid);
}
