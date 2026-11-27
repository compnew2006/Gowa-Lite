import type {AccountSummary, UnifiedChat} from '../../api/types.ts';
import {formatJidPhone} from './display-name.ts';

export function chatUniqueKey(chat: Pick<UnifiedChat, 'device_id' | 'jid'>): string {
  return `${chat.device_id}::${chat.jid}`;
}

export function buildFallbackUnifiedChat(
  deviceId: string,
  jid: string,
  accounts: AccountSummary[],
): UnifiedChat {
  const account = accounts.find((a) => a.id === deviceId);
  return {
    jid,
    name: formatJidPhone(jid) || jid,
    last_message_time: '',
    ephemeral_expiration: 0,
    created_at: '',
    updated_at: '',
    archived: false,
    device_id: deviceId,
    device_display_name: account?.display_name || deviceId,
    device_state: account?.state || 'disconnected',
    unread_count: 0,
  };
}

export function resolveSelectedUnifiedChat(params: {
  selectedKey: string | null;
  chats: UnifiedChat[];
  retainedChat: UnifiedChat | null;
  adHocChat: {deviceId: string; jid: string} | null;
  accounts: AccountSummary[];
}): UnifiedChat | null {
  const {selectedKey, chats, retainedChat, adHocChat, accounts} = params;
  if (!selectedKey) return null;

  const match = chats.find((chat) => chatUniqueKey(chat) === selectedKey);
  if (match) return match;

  if (retainedChat && chatUniqueKey(retainedChat) === selectedKey) {
    const account = accounts.find((a) => a.id === retainedChat.device_id);
    if (!account) return retainedChat;
    if (
      account.display_name === retainedChat.device_display_name &&
      account.state === retainedChat.device_state
    ) {
      return retainedChat;
    }
    return {
      ...retainedChat,
      device_display_name: account.display_name || retainedChat.device_display_name,
      device_state: account.state,
    };
  }

  if (adHocChat && chatUniqueKey({device_id: adHocChat.deviceId, jid: adHocChat.jid}) === selectedKey) {
    return buildFallbackUnifiedChat(adHocChat.deviceId, adHocChat.jid, accounts);
  }

  return null;
}
