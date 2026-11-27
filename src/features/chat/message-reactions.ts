import type {MessageInfo, ReactionInfo} from '@/api/types';
import type {QueryClient} from '@tanstack/react-query';
import {formatJidPhone} from '@/features/chat/display-name';
import type {WsRevokeTarget} from '@/lib/events';
import {toWhatsAppJid} from '@/lib/phone';
import {messageQueryKeys} from '@/features/chat/message-query-keys';

export const QUICK_REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

export interface GroupedReaction {
  emoji: string;
  count: number;
  hasMe: boolean;
  senders: string[];
}

export function sortMessagesChronologically(messages: MessageInfo[]): MessageInfo[] {
  return [...messages].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
}

export function dayKey(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function repliedToId(message: MessageInfo): string | undefined {
  if (!message.context_metadata) return undefined;
  try {
    const parsed = JSON.parse(message.context_metadata) as {replied_to_id?: string};
    return parsed.replied_to_id || undefined;
  } catch {
    return undefined;
  }
}

export function groupReactions(reactions: ReactionInfo[]): GroupedReaction[] {
  const map = new Map<string, GroupedReaction>();
  for (const reaction of reactions) {
    if (!reaction.emoji) continue;
    const senderLabel =
      reaction.sender_display_name || formatJidPhone(reaction.sender_jid) || '';
    const existing = map.get(reaction.emoji);
    if (existing) {
      existing.count += 1;
      if (reaction.is_from_me) existing.hasMe = true;
      if (senderLabel && !existing.senders.includes(senderLabel)) {
        existing.senders.push(senderLabel);
      }
    } else {
      map.set(reaction.emoji, {
        emoji: reaction.emoji,
        count: 1,
        hasMe: Boolean(reaction.is_from_me),
        senders: senderLabel ? [senderLabel] : [],
      });
    }
  }
  return Array.from(map.values());
}

export function applyMessageReaction(
  reactions: ReactionInfo[] | undefined,
  change: ReactionInfo,
): ReactionInfo[] {
  const sender = toWhatsAppJid(change.sender_jid) || change.sender_jid;
  const filtered = (reactions ?? []).filter((reaction) =>
    change.is_from_me
      ? !reaction.is_from_me
      : reaction.is_from_me || (toWhatsAppJid(reaction.sender_jid) || reaction.sender_jid) !== sender,
  );
  if (change.emoji) filtered.push(change);
  return filtered;
}

export interface InfiniteMessagePagesShape<TPage extends {data: MessageInfo[]} = {data: MessageInfo[]}> {
  pages: TPage[];
  pageParams: unknown[];
}

export function updateMessageReactions<TPage extends {data: MessageInfo[]; content_redacted?: boolean}>(
  oldData: InfiniteMessagePagesShape<TPage> | undefined,
  messageId: string,
  update: (reactions: ReactionInfo[] | undefined) => ReactionInfo[] | undefined,
): InfiniteMessagePagesShape<TPage> | undefined {
  if (!oldData) return oldData;
  let changed = false;
  const pages = oldData.pages.map((page) => {
    if (page.content_redacted) return page;
    const index = page.data.findIndex((message) => message.id === messageId && !message.is_revoked);
    if (index < 0) return page;
    const message = page.data[index];
    const reactions = update(message.reactions);
    if (reactions === message.reactions) return page;
    changed = true;
    const data = [...page.data];
    data[index] = {...message, reactions};
    return {...page, data};
  });
  return changed ? {...oldData, pages} : oldData;
}

export function applyRevokeToMessagePages<TPage extends {data: MessageInfo[]}>(
  oldData: InfiniteMessagePagesShape<TPage> | undefined,
  revoke: {messageId: string; revokedBy?: string; revokedAt?: string},
): InfiniteMessagePagesShape<TPage> | undefined {
  if (!oldData || !Array.isArray(oldData.pages) || !revoke.messageId) {
    return oldData;
  }

  let changedAnyPage = false;
  const nextPages = oldData.pages.map((page) => {
    if (!Array.isArray(page.data)) return page;
    let changedPage = false;
    const nextMessages = page.data.map((msg) => {
      if (msg.id !== revoke.messageId) return msg;
      const nextRevokedAt = msg.revoked_at || revoke.revokedAt || new Date().toISOString();
      const nextRevokedBy = msg.revoked_by || revoke.revokedBy;
      if (msg.is_revoked && msg.revoked_at === nextRevokedAt && msg.revoked_by === nextRevokedBy) {
        return msg;
      }
      changedPage = true;
      changedAnyPage = true;
      return {
        ...msg,
        is_revoked: true,
        revoked_at: nextRevokedAt,
        ...(nextRevokedBy ? {revoked_by: nextRevokedBy} : {}),
      };
    });
    return changedPage ? {...page, data: nextMessages} : page;
  });

  if (!changedAnyPage) return oldData;
  return {...oldData, pages: nextPages};
}

export function patchRevokedMessage(client: QueryClient, revoke: WsRevokeTarget): void {
  if (!revoke.deviceId || !revoke.chatJid) return;
  const chatJid = toWhatsAppJid(revoke.chatJid) || revoke.chatJid;
  client.setQueriesData<InfiniteMessagePagesShape>({
    queryKey: messageQueryKeys.device(revoke.deviceId),
    predicate: ({queryKey: [, , rawJid]}) =>
      typeof rawJid === 'string' && (toWhatsAppJid(rawJid) || rawJid) === chatJid,
  }, (data) => applyRevokeToMessagePages(data, revoke));
}
