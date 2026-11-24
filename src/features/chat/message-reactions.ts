import type {MessageInfo, ReactionInfo} from '@/api/types';
import {formatJidPhone} from '@/features/chat/display-name';

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

export function applyOptimisticReaction(
  reactions: ReactionInfo[] | undefined,
  emoji: string,
): ReactionInfo[] {
  const filtered = (reactions ?? []).filter((r) => !r.is_from_me);
  if (!emoji) return filtered;
  return [
    ...filtered,
    {
      emoji,
      sender_jid: 'me',
      is_from_me: true,
      timestamp: new Date().toISOString(),
    },
  ];
}

export interface InfiniteMessagePagesShape<TPage extends {data: MessageInfo[]} = {data: MessageInfo[]}> {
  pages: TPage[];
  pageParams: unknown[];
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
