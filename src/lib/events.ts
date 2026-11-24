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
  | 'CHAT_UPDATED'
  | string;

export interface WsEvent {
  code: WsEventCode;
  message: string;
  result: unknown;
  device_id?: string;
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
