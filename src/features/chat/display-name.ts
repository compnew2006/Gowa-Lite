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

export function chatDisplayName(chat: ChatIdentity): string {
  const name = chat.name?.trim();
  return name || formatJidPhone(chat.jid);
}

export function senderDisplayName(message: SenderIdentity): string {
  const name = message.sender_display_name?.trim();
  return name || formatJidPhone(message.sender_jid);
}
