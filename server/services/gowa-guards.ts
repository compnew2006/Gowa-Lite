import {isChatBlocked} from '../db.ts';
import {GowaError, gowaFetch, type GowaDeviceStatus} from '../gowa-client.ts';

export async function assertDeviceConnected(
  deviceId: string,
  disconnectedMessage = 'هذا الحساب غير متصل حاليًا بواتساب. يرجى إعادة ربط الحساب قبل الإرسال.',
): Promise<void> {
  const status = await gowaFetch<GowaDeviceStatus>(
    `/devices/${encodeURIComponent(deviceId)}/status`,
  );
  if (!status?.is_logged_in) {
    throw new GowaError(409, 'DEVICE_NOT_CONNECTED', disconnectedMessage);
  }
}

export function assertChatNotBlocked(deviceId: string, chatJid: string): void {
  if (isChatBlocked(deviceId, chatJid)) {
    throw new GowaError(
      403,
      'CHAT_BLOCKED',
      'تم حظر هذه المحادثة؛ قم بإلغاء الحظر أولًا لإرسال الرسائل.',
    );
  }
}

export async function trySyncRemoteChatState(
  deviceId: string,
  path: string,
  body: Record<string, unknown>,
): Promise<boolean> {
  try {
    const status = await gowaFetch<GowaDeviceStatus>(
      `/devices/${encodeURIComponent(deviceId)}/status`,
    );
    if (status?.is_logged_in) {
      await gowaFetch(path, {
        method: 'POST',
        deviceId,
        body,
      });
      return true;
    }
    return false;
  } catch (err) {
    if (
      !(err instanceof GowaError) ||
      (err.code !== 'GOWA_NOT_CONFIGURED' && err.status !== 502 && err.status !== 503)
    ) {
      throw err;
    }
    return false;
  }
}
