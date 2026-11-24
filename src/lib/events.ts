import {toWhatsAppJid} from '@/lib/phone';

export type WsEventCode =
  | 'BRIDGE_STATUS'
  | 'LOGIN_SUCCESS'
  | 'LIST_DEVICES'
  | 'DEVICE_REMOVED'
  | 'DEVICE_LOGGED_OUT'
  | 'DEVICE_STREAM_REPLACED'
  | 'DEVICE_TEMPORARY_BAN'
  | 'DEVICE_REACHOUT_TIMELOCK'
  | 'MESSAGE_RECEIVED'
  | 'MESSAGE_REVOKED'
  | 'MESSAGE.REVOKED'
  | 'MESSAGE_DELETED'
  | 'MESSAGE.DELETED'
  | 'MESSAGE_REACTION'
  | 'MESSAGE_UPDATED'
  | 'MESSAGE_EDITED'
  | 'MESSAGE.EDITED'
  | 'CONVERSATION_NOTE_UPDATED'
  | 'CHAT_LIFECYCLE_UPDATED'
  | 'INBOX_POLICY_UPDATED'
  | 'SCHEDULE_UPDATED'
  | 'CHAT_UPDATED'
  | string;

export interface WsEvent {
  code: WsEventCode;
  message: string;
  result: unknown;
  device_id?: string;
}

function unwrapWsObject(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const obj = result as Record<string, unknown>;
  if (obj.payload && typeof obj.payload === 'object' && !Array.isArray(obj.payload)) {
    return obj.payload as Record<string, unknown>;
  }
  if (obj.message && typeof obj.message === 'object' && !Array.isArray(obj.message)) {
    return obj.message as Record<string, unknown>;
  }
  return obj;
}

export function extractWsEventTarget(event: WsEvent): {deviceId?: string; chatJid?: string} {
  const payload = unwrapWsObject(event.result);
  const rawDeviceId =
    (typeof event.device_id === 'string' && event.device_id.trim()) ||
    (payload && typeof payload.device_id === 'string' && payload.device_id.trim()) ||
    '';

  let chatJid = '';
  if (payload) {
    const rawChat =
      (typeof payload.chat_jid === 'string' && payload.chat_jid.trim()) ||
      (typeof payload.chat_id === 'string' && payload.chat_id.trim()) ||
      (typeof payload.jid === 'string' && payload.jid.trim()) ||
      (typeof payload.from === 'string' && payload.from.trim()) ||
      '';
    if (rawChat) {
      chatJid = toWhatsAppJid(rawChat) || rawChat;
    }
  }

  return {
    deviceId: rawDeviceId || undefined,
    chatJid: chatJid || undefined,
  };
}

type Handler = (event: WsEvent) => void;

const handlers = new Set<Handler>();

export function onWsEvent(handler: Handler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

export function emitWsEvent(event: WsEvent): void {
  for (const handler of handlers) {
    handler(event);
  }
}
