import {normalizeArabicDigits} from '../../shared/whatsapp-identity.ts';
import {
  claimQueuedRating,
  deleteSetting,
  expireChatCloseRatings,
  failRatingPrompt,
  getAccountRatingRows,
  getUserRatingRows,
  hasPendingChatCloseRating,
  hasRecordedRatingReply,
  insertQueuedRating,
  listQueuedRatingEvents,
  listUsersCloseRatingSummaries,
  markRatingPromptSent,
  recordPendingRating,
  getAccountAliases,
  getSetting,
  getUserById,
  isChatBlocked,
  setSetting,
  upsertCachedMessages,
} from '../db.ts';
import {GowaError, gowaFetch} from '../gowa-client.ts';
import {recordChatActionEvent} from '../db/lifecycle-repo.ts';

const RATING_WINDOW_MS = 48 * 60 * 60 * 1000;
export const DEFAULT_RATING_PROMPT =
  'شكرًا لتواصلك معنا. قيّم الخدمة بإرسال رقم من 1 إلى 5 (5 = ممتاز).\nThanks for contacting us. Rate our service from 1 to 5 (5 = excellent).';

function ratingSettingKey(deviceId: string): string {
  return `close_rating_enabled:${deviceId}`;
}

function ratingPromptKey(deviceId: string): string {
  return `close_rating_prompt:${deviceId}`;
}

export function getRatingPrompt(deviceId: string): {prompt: string; isCustom: boolean} {
  const stored = (getSetting(ratingPromptKey(deviceId)) ?? '').trim();
  if (stored && stored !== DEFAULT_RATING_PROMPT) {
    return {prompt: stored, isCustom: true};
  }
  return {prompt: DEFAULT_RATING_PROMPT, isCustom: false};
}

export function getAccountCloseRatings(deviceId: string) {
  const {summary, recent, byUser} = getAccountRatingRows(deviceId);

  const {prompt, isCustom} = getRatingPrompt(deviceId);

  return {
    enabled: getSetting(ratingSettingKey(deviceId)) === 'true',
    webhook_configured: Boolean(process.env.GOWA_WEBHOOK_SECRET?.trim()),
    prompt_message: prompt,
    default_prompt: DEFAULT_RATING_PROMPT,
    is_custom_prompt: isCustom,
    ...summary,
    by_user: byUser,
    recent,
  };
}

export function updateAccountCloseRatingSettings(
  deviceId: string,
  patch: {enabled?: boolean; prompt_message?: string},
) {
  if (patch.enabled !== undefined) {
    setSetting(ratingSettingKey(deviceId), String(patch.enabled));
  }
  if (patch.prompt_message !== undefined) {
    const clean = patch.prompt_message.trim();
    if (!clean || clean === DEFAULT_RATING_PROMPT) {
      deleteSetting(ratingPromptKey(deviceId));
    } else {
      setSetting(ratingPromptKey(deviceId), clean);
    }
  }
  return getAccountCloseRatings(deviceId);
}

export function setAccountCloseRatingEnabled(deviceId: string, enabled: boolean) {
  return updateAccountCloseRatingSettings(deviceId, {enabled});
}

export {listUsersCloseRatingSummaries};

export function getUserCloseRatings(userId: number) {
  const user = getUserById(userId);
  if (!user) {
    throw new GowaError(404, 'NOT_FOUND', 'المستخدم غير موجود');
  }
  const aliases = getAccountAliases();
  const {summary, recentRows, byAccountRows} = getUserRatingRows(userId);

  return {
    user_id: user.id,
    display_name: user.display_name,
    count: summary.count,
    average: summary.average,
    by_account: byAccountRows.map((row) => ({
      ...row,
      device_name: aliases[row.device_id] || row.device_id,
    })),
    recent: recentRows.map((row) => ({
      ...row,
      device_name: aliases[row.device_id] || row.device_id,
    })),
  };
}

export {expireChatCloseRatings};

export function queueChatCloseRating(
  deviceId: string,
  chatJid: string,
  closedEventId: number,
  nowMs: number,
  attribution?: {
    ratedUserId?: number | null;
    ratedUserName?: string;
    closedByUserId?: number | null;
  },
): void {
  if (!/@(s\.whatsapp\.net|lid)$/.test(chatJid) ||
      getSetting(ratingSettingKey(deviceId)) !== 'true' ||
      isChatBlocked(deviceId, chatJid)) return;

  expireChatCloseRatings(deviceId, chatJid);
  insertQueuedRating(deviceId, chatJid, closedEventId, nowMs + RATING_WINDOW_MS, attribution);
}

export async function sendChatCloseRatingPrompt(closedEventId: number): Promise<'sent' | 'failed' | undefined> {
  const target = claimQueuedRating(closedEventId, Date.now());
  if (!target) return;
  const {device_id: deviceId, chat_jid: chatJid} = target;
  if (getSetting(ratingSettingKey(deviceId)) !== 'true' || isChatBlocked(deviceId, chatJid)) {
    expireChatCloseRatings(deviceId, chatJid);
    return;
  }
  const {prompt} = getRatingPrompt(deviceId);
  const sentAt = Date.now();
  let messageId: string;

  try {
    const sent = await gowaFetch<{message_id: string}>('/send/message', {
      method: 'POST',
      deviceId,
      timeoutMs: 5_000,
      body: {phone: chatJid, message: prompt},
    });
    if (!sent?.message_id) throw new Error('Missing gateway message ID');
    messageId = sent.message_id;
  } catch {
    failRatingPrompt(closedEventId);
    return 'failed';
  }
  markRatingPromptSent(closedEventId, messageId, sentAt, Date.now() + RATING_WINDOW_MS);

  upsertCachedMessages(deviceId, chatJid, [{
    id: messageId,
    chat_jid: chatJid,
    sender_jid: 'me',
    content: prompt,
    timestamp: new Date(sentAt).toISOString(),
    is_from_me: true,
    media_type: '',
    filename: '',
    url: '',
    file_length: 0,
  }]);
  return 'sent';
}

export async function resumeQueuedChatCloseRatings(): Promise<void> {
  const rows = listQueuedRatingEvents(Date.now());
  for (const {closed_event_id: eventId} of rows) await sendChatCloseRatingPrompt(eventId);
}

export {hasPendingChatCloseRating};

interface RatingMessage {
  id: string;
  text: string;
  mediaType: string;
  timestampMs: number;
  replyToId?: string;
  contextMetadata?: string;
}

function quotedMessageId(message: RatingMessage): string | undefined {
  if (message.replyToId || !message.contextMetadata) return message.replyToId;
  try {
    const context = JSON.parse(message.contextMetadata) as {replied_to_id?: unknown} | null;
    return typeof context?.replied_to_id === 'string' ? context.replied_to_id : undefined;
  } catch {
    return undefined;
  }
}

export function captureChatCloseRating(
  deviceId: string,
  chatJid: string,
  message: RatingMessage,
  actorName?: string,
): 'recorded' | 'duplicate' | undefined {
  if (!message.id || message.mediaType) return;
  const number = /^([1-5])(?:\s*\/\s*5)?$/u.exec(normalizeArabicDigits(message.text.trim()))?.[1];
  if (!number) return;
  const score = Number(number);

  if (hasRecordedRatingReply(deviceId, chatJid, message.id)) return 'duplicate';

  if (!message.timestampMs || isChatBlocked(deviceId, chatJid)) return;
  const now = Date.now();
  const quote = quotedMessageId(message) ?? null;
  const recorded = recordPendingRating({
    score, messageId: message.id, deviceId, chatJid, now, timestampMs: message.timestampMs, quote,
  });
  if (!recorded) return undefined;
  // P2-11: the submitted rating shows as a system line in the chat
  // timeline. The score travels in the event note; the line text renders
  // it as "5/5" and the note sub-line stays hidden for this type.
  recordChatActionEvent({
    deviceId,
    chatJid,
    eventType: 'rating_submitted',
    actorUserId: null,
    actorName: (actorName ?? '').trim(),
    note: String(score),
  });
  return 'recorded';
}

export function buildCloseRatingUpdatedEvent(deviceId: string) {
  return {
    code: 'CHAT_CLOSE_RATING_UPDATED',
    message: 'updated',
    device_id: deviceId,
    result: {device_id: deviceId},
  };
}
