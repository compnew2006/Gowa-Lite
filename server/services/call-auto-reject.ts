import {normalizeWhatsAppJid} from '../../shared/whatsapp-identity.ts';
import {
  beginCallRejection,
  completeCallRejection,
  deleteSetting,
  listRecentCallRejections,
  type CallAutoRejectLogEntry,
  type CallRejectStatus,
  type CallReplyStatus,
  getSetting,
  isChatBlocked,
  setSetting,
  upsertCachedMessages,
} from '../db.ts';
import {gowaFetch} from '../gowa-client.ts';

export const DEFAULT_CALL_AUTO_REJECT_MESSAGE =
  'مرحبًا، هذا الحساب لا يستقبل المكالمات الصوتية أو المرئية. يرجى إرسال رسالتك نصيًا وسنقوم بالرد عليك في أقرب وقت.';

export type {CallAutoRejectLogEntry, CallRejectStatus, CallReplyStatus};

export interface CallAutoRejectSettings {
  device_id: string;
  enabled: boolean;
  webhook_configured: boolean;
  reply_message: string;
  default_message: string;
  is_custom_message: boolean;
  recent: CallAutoRejectLogEntry[];
}

function enabledSettingKey(deviceId: string): string {
  return `call_auto_reject_enabled:${deviceId}`;
}

function messageSettingKey(deviceId: string): string {
  return `call_auto_reject_message:${deviceId}`;
}

export function isCallAutoRejectEnabled(deviceId: string): boolean {
  return getSetting(enabledSettingKey(deviceId)) === 'true';
}

export function getCallAutoRejectMessage(deviceId: string): {
  replyMessage: string;
  isCustom: boolean;
} {
  const stored = getSetting(messageSettingKey(deviceId));
  if (stored === null) {
    return {replyMessage: DEFAULT_CALL_AUTO_REJECT_MESSAGE, isCustom: false};
  }
  const clean = stored.trim();
  if (clean === DEFAULT_CALL_AUTO_REJECT_MESSAGE) {
    return {replyMessage: DEFAULT_CALL_AUTO_REJECT_MESSAGE, isCustom: false};
  }
  return {replyMessage: clean, isCustom: true};
}

export function getCallAutoRejectSettings(deviceId: string): CallAutoRejectSettings {
  const {replyMessage, isCustom} = getCallAutoRejectMessage(deviceId);
  return {
    device_id: deviceId,
    enabled: isCallAutoRejectEnabled(deviceId),
    webhook_configured: Boolean(process.env.GOWA_WEBHOOK_SECRET?.trim()),
    reply_message: replyMessage,
    default_message: DEFAULT_CALL_AUTO_REJECT_MESSAGE,
    is_custom_message: isCustom,
    recent: listRecentCallRejections(deviceId),
  };
}

export function updateCallAutoRejectSettings(
  deviceId: string,
  patch: {enabled?: boolean; reply_message?: string; reset_message?: boolean},
): CallAutoRejectSettings {
  if (patch.enabled !== undefined) {
    setSetting(enabledSettingKey(deviceId), String(patch.enabled));
  }
  if (patch.reset_message === true) {
    deleteSetting(messageSettingKey(deviceId));
  } else if (patch.reply_message !== undefined) {
    const clean = patch.reply_message.trim();
    if (clean === DEFAULT_CALL_AUTO_REJECT_MESSAGE) {
      deleteSetting(messageSettingKey(deviceId));
    } else {
      setSetting(messageSettingKey(deviceId), clean);
    }
  }
  return getCallAutoRejectSettings(deviceId);
}

const CALL_OFFER_CODES = new Set([
  'CALL.OFFER',
  'CALL_OFFER',
  'CALL',
  'CALL.RECEIVED',
  'CALL_RECEIVED',
]);

export function isCallOfferEventCode(code: string): boolean {
  return CALL_OFFER_CODES.has(code.trim().toUpperCase());
}

function asRecord(val: unknown): Record<string, unknown> | null {
  return val && typeof val === 'object' && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : null;
}

function firstNonEmptyString(...values: unknown[]): string {
  for (const val of values) {
    if (typeof val === 'string' && val.trim()) return val.trim();
  }
  return '';
}

function extractCallOfferDetails(rawPayload: unknown): {
  callId: string;
  rawCaller: string;
  callerJid: string;
  callerName: string;
  autoRejected: boolean;
  isFromMe: boolean;
} | null {
  const outer = asRecord(rawPayload);
  if (!outer) return null;
  const inner = asRecord(outer.payload) ?? asRecord(outer.call) ?? outer;

  const isFromMe = Boolean(
    inner.is_from_me ?? inner.from_me ?? outer.is_from_me ?? outer.from_me,
  );
  const callId = firstNonEmptyString(
    inner.call_id,
    inner.id,
    outer.call_id,
    outer.id,
  );
  const rawCaller = firstNonEmptyString(
    inner.caller_jid,
    inner.from,
    inner.sender_jid,
    inner.chat_id,
    inner.chat_jid,
    outer.caller_jid,
    outer.from,
    outer.sender_jid,
    outer.chat_id,
    outer.chat_jid,
  );
  const callerJid = normalizeWhatsAppJid(rawCaller) || rawCaller;
  const callerName = firstNonEmptyString(
    inner.sender_display_name,
    inner.caller_name,
    inner.from_name,
    inner.pushname,
    outer.sender_display_name,
    outer.caller_name,
    outer.from_name,
  );
  const autoRejected = Boolean(inner.auto_rejected ?? outer.auto_rejected);

  if (!callId || !callerJid) return null;
  return {
    callId,
    rawCaller,
    callerJid,
    callerName,
    autoRejected,
    isFromMe,
  };
}

export async function handleIncomingCallOffer(
  deviceId: string,
  rawPayload: unknown,
  onBroadcast?: (event: {
    code: string;
    message: string;
    device_id: string;
    result: unknown;
  }) => void,
): Promise<CallAutoRejectLogEntry | null> {
  if (!deviceId || !isCallAutoRejectEnabled(deviceId)) {
    return null;
  }

  const details = extractCallOfferDetails(rawPayload);
  if (!details || details.isFromMe) {
    return null;
  }

  const nowMs = Date.now();
  const createdAt = new Date(nowMs).toISOString();

  // Atomic idempotency across Webhook + WebSocket replays
  if (!beginCallRejection(deviceId, details, createdAt, nowMs)) return null;

  let rejectStatus: CallRejectStatus = details.autoRejected ? 'already_rejected' : 'pending';
  if (!details.autoRejected) {
    const gatewayCallerJid = details.rawCaller.includes('@')
      ? details.rawCaller
      : details.callerJid;
    try {
      await gowaFetch('/call/reject', {
        method: 'POST',
        deviceId,
        timeoutMs: 5_000,
        body: {
          caller_jid: gatewayCallerJid,
          call_id: details.callId,
        },
      });
      rejectStatus = 'rejected';
    } catch {
      rejectStatus = 'failed';
    }
  }

  const {replyMessage} = getCallAutoRejectMessage(deviceId);
  const canReplyToCaller =
    /@(s\.whatsapp\.net|lid)$/.test(details.callerJid) &&
    !isChatBlocked(deviceId, details.callerJid);

  let replyStatus: CallReplyStatus = 'no_message';
  let sentMessageText = '';

  if (replyMessage.trim()) {
    if (!canReplyToCaller) {
      replyStatus = 'skipped';
    } else {
      sentMessageText = replyMessage.trim();
      try {
        const sent = await gowaFetch<{message_id?: string}>('/send/message', {
          method: 'POST',
          deviceId,
          timeoutMs: 5_000,
          body: {
            phone: details.callerJid,
            message: sentMessageText,
          },
        });
        const messageId =
          typeof sent?.message_id === 'string' && sent.message_id.trim()
            ? sent.message_id.trim()
            : `call-reply-${details.callId}`;
        const sentAtIso = new Date().toISOString();
        upsertCachedMessages(deviceId, details.callerJid, [
          {
            id: messageId,
            chat_jid: details.callerJid,
            sender_jid: 'me',
            content: sentMessageText,
            timestamp: sentAtIso,
            is_from_me: true,
            media_type: '',
            filename: '',
            url: '',
            file_length: 0,
          },
        ]);
        replyStatus = 'sent';
      } catch {
        replyStatus = 'failed';
      }
    }
  }

  const entry: CallAutoRejectLogEntry = {
    device_id: deviceId,
    call_id: details.callId,
    caller_jid: details.callerJid,
    caller_name: details.callerName,
    reject_status: rejectStatus,
    reply_status: replyStatus,
    reply_message: sentMessageText,
    created_at: createdAt,
  };

  completeCallRejection(entry);

  onBroadcast?.({
    code: 'CALL_AUTO_REJECTED',
    message: 'call_auto_rejected',
    device_id: deviceId,
    result: entry,
  });

  return entry;
}
