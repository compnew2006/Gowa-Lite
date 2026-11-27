import type {DeviceState} from '@/api/types';

export const accountStateToneClass: Record<DeviceState, string> = {
  logged_in: 'text-emerald-700 dark:text-emerald-400',
  connected: 'text-amber-700 dark:text-amber-400',
  connecting: 'text-amber-700 dark:text-amber-400',
  disconnected: 'text-destructive',
};

const ACCOUNT_DOT_TONES = [
  'bg-emerald-500',
  'bg-sky-500',
  'bg-amber-500',
  'bg-violet-500',
  'bg-teal-500',
];

export function accountDotTone(deviceId: string): string {
  let hash = 0;
  for (let i = 0; i < deviceId.length; i += 1) {
    hash = (hash * 31 + deviceId.charCodeAt(i)) | 0;
  }
  return ACCOUNT_DOT_TONES[Math.abs(hash) % ACCOUNT_DOT_TONES.length];
}

export function shortAccountWidgetLabel(displayName: string): string {
  const cleaned = displayName.replace(/@(s\.whatsapp\.net|c\.us|lid)$/i, '').trim();
  return cleaned || displayName;
}
