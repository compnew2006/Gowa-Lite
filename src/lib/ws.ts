import {create} from 'zustand';
import {http, results} from '@/lib/http';
import {backoffDelay} from '@/lib/backoff';
import {emitWsFrame, type WsEvent} from '@/lib/events';
import {useAuthStore} from '@/stores/auth';

export type WsStatus = 'disconnected' | 'connecting' | 'connected';

export const useWsStore = create<{status: WsStatus}>(() => ({status: 'disconnected'}));

class WsClient {
  private socket: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private attempt = 0;
  private desired = false;

  sync(): void {
    const authStatus = useAuthStore.getState().status;
    if (authStatus !== 'authenticated') {
      this.stop();
      return;
    }
    if (this.desired && (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.desired = true;
    this.attempt = 0;
    void this.reopen();
  }

  stop(): void {
    this.desired = false;
    this.clearTimer();
    this.closeSocket();
    useWsStore.setState({status: 'disconnected'});
  }

  /**
   * P2-1 presence (first client→server channel): announce viewing /
   * heartbeat / leaving for one chat. Best-effort — returns false when the
   * socket is not open (reconnect re-announces via useChatPresence).
   * The server ignores anything it cannot attribute to a signed-in user
   * with access to the device and the chat.
   */
  sendPresenceMessage(
    code: 'CHAT_VIEWING' | 'CHAT_VIEWING_HEARTBEAT' | 'CHAT_LEAVING',
    deviceId: string,
    chatJid: string,
  ): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    try {
      this.socket.send(JSON.stringify({code, device_id: deviceId, chat_jid: chatJid}));
      return true;
    } catch {
      return false;
    }
  }

  private async reopen(): Promise<void> {
    this.clearTimer();
    this.closeSocket();
    if (!this.desired) return;
    if (useAuthStore.getState().status !== 'authenticated') {
      this.stop();
      return;
    }

    useWsStore.setState({status: 'connecting'});
    let ticket = '';
    try {
      const res = await results<{ticket: string}>(http.post('/auth/ws-ticket'));
      ticket = res.ticket;
    } catch {
      if (this.desired) this.scheduleReconnect();
      return;
    }

    if (!this.desired || !ticket) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/ws?ticket=${encodeURIComponent(ticket)}`;
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.onopen = () => {
      if (socket !== this.socket) return;
      this.attempt = 0;
      useWsStore.setState({status: 'connected'});
    };

    socket.onmessage = (message: MessageEvent<string>) => {
      try {
        const frame = JSON.parse(message.data) as WsEvent;
        if (frame && typeof frame.code === 'string') {
          // WS_BATCH frames expand into their events in order; plain frames
          // pass through unchanged (see expandWsBatchFrame).
          emitWsFrame(frame);
        }
      } catch {
        // ignore non-JSON frames
      }
    };

    socket.onclose = () => {
      if (socket !== this.socket) return;
      this.socket = null;
      if (!this.desired) return;
      useWsStore.setState({status: 'connecting'});
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    this.clearTimer();
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.reopen();
    }, backoffDelay(this.attempt++));
  }

  private clearTimer(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private closeSocket(): void {
    if (this.socket) {
      const socket = this.socket;
      this.socket = null;
      socket.onopen = socket.onmessage = socket.onclose = null;
      socket.close();
    }
  }
}

export const wsClient = new WsClient();
