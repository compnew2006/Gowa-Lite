import {create} from 'zustand';
import {extractWsEventTarget, type WsEvent} from '@/lib/events';

const SOUND_STORAGE_KEY = 'gowa-lite:notify-sound';
const BROWSER_STORAGE_KEY = 'gowa-lite:notify-browser';

function readBoolStorage(key: string): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeBoolStorage(key: string, value: boolean): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, value ? '1' : '0');
    }
  } catch {
    // Ignore storage errors in restricted environments
  }
}

interface NotificationPrefsState {
  soundEnabled: boolean;
  browserEnabled: boolean;
  setSoundEnabled: (enabled: boolean) => void;
  setBrowserEnabled: (enabled: boolean) => void;
}

export const useNotificationPrefsStore = create<NotificationPrefsState>((set) => ({
  soundEnabled: readBoolStorage(SOUND_STORAGE_KEY),
  browserEnabled: readBoolStorage(BROWSER_STORAGE_KEY),
  setSoundEnabled: (enabled) => {
    writeBoolStorage(SOUND_STORAGE_KEY, enabled);
    set({soundEnabled: enabled});
  },
  setBrowserEnabled: (enabled) => {
    writeBoolStorage(BROWSER_STORAGE_KEY, enabled);
    set({browserEnabled: enabled});
  },
}));

export function formatUnreadTabTitle(totalUnread: number, baseTitle: string): string {
  if (totalUnread <= 0) return baseTitle;
  const badge = totalUnread > 99 ? '99+' : String(totalUnread);
  return `(${badge}) ${baseTitle}`;
}

export interface IncomingAlertPayload {
  messageId: string;
  deviceId: string;
  chatJid: string;
  senderName: string;
  body: string;
  mediaType: string;
}

function unwrapPayload(result: unknown): Record<string, unknown> | null {
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

export function extractIncomingAlertData(event: WsEvent): IncomingAlertPayload | null {
  const code = (event.code || '').toUpperCase();
  if (code !== 'MESSAGE_RECEIVED' && code !== 'MESSAGE') return null;

  const raw = unwrapPayload(event.result);
  if (!raw) return null;

  if (Boolean(raw.is_from_me ?? raw.from_me)) return null;
  if (raw.is_revoked === true || raw.revoked === true || raw.media_type === 'revoked') return null;

  const target = extractWsEventTarget(event);
  const deviceId = target.deviceId || '';
  const chatJid = target.chatJid || '';
  const lowerJid = chatJid.toLowerCase();
  if (!deviceId || !chatJid || lowerJid.endsWith('@newsletter') || lowerJid === 'status@broadcast') {
    return null;
  }

  const messageId = String(raw.id || raw.message_id || '').trim();
  if (!messageId) return null;

  let mediaType = typeof raw.media_type === 'string' ? raw.media_type.trim() : '';
  const mediaKeys = ['image', 'video', 'audio', 'document', 'sticker'] as const;
  if (!mediaType) {
    for (const key of mediaKeys) {
      if (raw[key]) {
        mediaType = key;
        break;
      }
    }
  }

  let body =
    typeof raw.content === 'string'
      ? raw.content
      : typeof raw.body === 'string'
        ? raw.body
        : typeof raw.text === 'string'
          ? raw.text
          : typeof raw.caption === 'string'
            ? raw.caption
            : '';

  if (!body && mediaType) {
    const nested = raw[mediaType];
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const cap = (nested as Record<string, unknown>).caption;
      if (typeof cap === 'string') body = cap;
    }
  }

  const rawSender =
    (typeof raw.sender_display_name === 'string' && raw.sender_display_name.trim()) ||
    (typeof raw.pushname === 'string' && raw.pushname.trim()) ||
    chatJid.split('@')[0].split(':')[0];

  return {
    messageId,
    deviceId,
    chatJid,
    senderName: rawSender,
    body: body.trim(),
    mediaType,
  };
}

let sharedAudioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor =
    window.AudioContext ||
    (window as Window & {webkitAudioContext?: typeof AudioContext}).webkitAudioContext;
  if (!Ctor) return null;
  if (!sharedAudioCtx) {
    sharedAudioCtx = new Ctor();
  }
  return sharedAudioCtx;
}

export function playIncomingMessageChime(): void {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => {});
    }
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.exponentialRampToValueAtTime(0.08, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.24);
    gain.connect(ctx.destination);

    const osc1 = ctx.createOscillator();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(587.33, now);
    osc1.frequency.setValueAtTime(880, now + 0.09);
    osc1.connect(gain);
    osc1.start(now);
    osc1.stop(now + 0.25);
  } catch {
    // Audio playback can be blocked prior to user gesture
  }
}

export function getBrowserNotificationPermission(): NotificationPermission | 'unsupported' {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') {
    return 'unsupported';
  }
  return Notification.permission;
}
