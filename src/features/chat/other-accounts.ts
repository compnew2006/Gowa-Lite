import type {UnifiedChat} from '@/api/types';

export interface OtherAccountRef {
  device_id: string;
  device_display_name: string;
}

export function normalizeSharedChatJid(jid: string): string {
  const clean = jid.trim().toLowerCase();
  if (!clean || clean === 'status@broadcast' || clean.endsWith('@newsletter')) {
    return '';
  }
  if (clean.endsWith('@c.us')) {
    return `${clean.slice(0, -5)}@s.whatsapp.net`;
  }
  return clean;
}

export function buildJidAccountsMap(
  chats: ReadonlyArray<Pick<UnifiedChat, 'device_id' | 'device_display_name' | 'jid'>>,
): Map<string, OtherAccountRef[]> {
  const map = new Map<string, Map<string, OtherAccountRef>>();
  for (const chat of chats) {
    const normalizedJid = normalizeSharedChatJid(chat.jid);
    if (!normalizedJid || !chat.device_id) continue;
    let byDevice = map.get(normalizedJid);
    if (!byDevice) {
      byDevice = new Map<string, OtherAccountRef>();
      map.set(normalizedJid, byDevice);
    }
    if (!byDevice.has(chat.device_id)) {
      byDevice.set(chat.device_id, {
        device_id: chat.device_id,
        device_display_name: chat.device_display_name || chat.device_id,
      });
    }
  }

  const out = new Map<string, OtherAccountRef[]>();
  for (const [jid, byDevice] of map.entries()) {
    if (byDevice.size < 2) continue;
    const list = Array.from(byDevice.values()).sort((a, b) =>
      a.device_display_name.localeCompare(b.device_display_name),
    );
    out.set(jid, list);
  }
  return out;
}

export function getOtherAccountsForChat(
  jidAccountsMap: Map<string, OtherAccountRef[]>,
  deviceId: string,
  jid: string,
): OtherAccountRef[] {
  const normalizedJid = normalizeSharedChatJid(jid);
  if (!normalizedJid) return [];
  const all = jidAccountsMap.get(normalizedJid);
  if (!all || all.length < 2) return [];
  return all.filter((acc) => acc.device_id !== deviceId);
}
