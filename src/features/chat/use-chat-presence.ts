import {useEffect, useState} from 'react';
import {extractChatViewers, onWsEvent} from '@/lib/events';
import {useWsStore, wsClient} from '@/lib/ws';
import {PRESENCE_HEARTBEAT_MS} from '../../../shared/presence.ts';
import {useAuthStore} from '@/stores/auth';

export interface ChatPresenceViewer {
  userId: number;
  displayName: string;
}

export {PRESENCE_HEARTBEAT_MS};

/**
 * P2-1 presence (warning only, decision 7).
 *
 * While the hook is mounted for one open chat it announces CHAT_VIEWING to
 * the server, refreshes it with CHAT_VIEWING_HEARTBEAT every 15s, and sends
 * CHAT_LEAVING on unmount / chat change. The server also drops the viewer
 * when the socket closes or the heartbeat stops, so no ghost viewers.
 *
 * Returns the chat's current viewers as broadcast by the server
 * (CHAT_VIEWERS) — the full list, including the current user; the header
 * filters the current user out of the badge. The list is re-announced
 * whenever the WS reconnects (wsStatus dep), because a fresh socket has no
 * presence registered server-side.
 */
export function useChatPresence({
  deviceId,
  chatJid,
  enabled = true,
}: {
  deviceId: string;
  chatJid: string;
  enabled?: boolean;
}): ChatPresenceViewer[] {
  const userId = useAuthStore((s) => s.user?.id);
  const wsStatus = useWsStore((s) => s.status);
  const [viewers, setViewers] = useState<ChatPresenceViewer[]>([]);

  useEffect(() => {
    setViewers([]);
  }, [deviceId, chatJid]);

  useEffect(() => {
    if (!enabled || !deviceId || !chatJid || userId === undefined) return undefined;
    const send = (code: 'CHAT_VIEWING' | 'CHAT_VIEWING_HEARTBEAT' | 'CHAT_LEAVING') =>
      wsClient.sendPresenceMessage(code, deviceId, chatJid);
    send('CHAT_VIEWING');
    const timer = window.setInterval(
      () => send('CHAT_VIEWING_HEARTBEAT'),
      PRESENCE_HEARTBEAT_MS,
    );
    const off = onWsEvent((event) => {
      const parsed = extractChatViewers(event);
      if (!parsed) return;
      if (parsed.deviceId !== deviceId) return;
      if (parsed.chatJid.toLowerCase() !== chatJid.toLowerCase()) return;
      setViewers(parsed.viewers);
    });
    return () => {
      window.clearInterval(timer);
      off();
      send('CHAT_LEAVING');
    };
  }, [deviceId, chatJid, enabled, userId, wsStatus]);

  return viewers;
}
