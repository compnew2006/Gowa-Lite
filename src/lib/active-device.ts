/**
 * Persistence for the operator's chosen WhatsApp account(s).
 *
 * P1-8: the active-device selector used to reset to the first logged-in
 * device on every navigation, and the chat list filter reset to "all
 * accounts". Both choices are now saved in localStorage and restored only
 * when the device(s) still exist (the active device additionally has to be
 * logged in — see useActiveDevice).
 *
 * All helpers are safe to call without a DOM (SSR / plain node tests):
 * storage access is guarded and any failure degrades to "nothing saved".
 */

export const ACTIVE_DEVICE_STORAGE_KEY = 'gowa-lite:active-device';
export const CHAT_DEVICE_FILTER_STORAGE_KEY = 'gowa-lite:chat-device-filter';

function readStorage(): Storage | null {
  try {
    if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') {
      return null;
    }
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readSavedActiveDeviceId(): string | null {
  const storage = readStorage();
  if (!storage) return null;
  try {
    const saved = storage.getItem(ACTIVE_DEVICE_STORAGE_KEY);
    return saved && saved.trim() ? saved.trim() : null;
  } catch {
    return null;
  }
}

export function saveActiveDeviceId(deviceId: string): void {
  const storage = readStorage();
  if (!storage) return;
  try {
    if (deviceId.trim()) {
      storage.setItem(ACTIVE_DEVICE_STORAGE_KEY, deviceId.trim());
    } else {
      storage.removeItem(ACTIVE_DEVICE_STORAGE_KEY);
    }
  } catch {
    // Storage full / unavailable: the selection just does not persist.
  }
}

export function readSavedChatDeviceIds(): string[] {
  const storage = readStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(CHAT_DEVICE_FILTER_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === 'string' && Boolean(id.trim()));
  } catch {
    return [];
  }
}

export function saveChatDeviceIds(deviceIds: string[]): void {
  const storage = readStorage();
  if (!storage) return;
  try {
    storage.setItem(CHAT_DEVICE_FILTER_STORAGE_KEY, JSON.stringify(deviceIds));
  } catch {
    // Storage full / unavailable: the filter just does not persist.
  }
}

/** Keep only the ids that still exist among the currently available devices. */
export function filterExistingDeviceIds(
  savedIds: string[],
  availableIds: string[],
): string[] {
  const available = new Set(availableIds);
  return savedIds.filter((id) => available.has(id));
}
