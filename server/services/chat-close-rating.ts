import {normalizeArabicDigits} from '../../shared/whatsapp-identity.ts';
import {
  db,
  getAccountAliases,
  getSetting,
  getUserById,
  isChatBlocked,
  setSetting,
  upsertCachedMessages,
} from '../db.ts';
import {GowaError, gowaFetch} from '../gowa-client.ts';

const RATING_WINDOW_MS = 48 * 60 * 60 * 1000;
export const DEFAULT_RATING_PROMPT =
  'شكرًا لتواصلك معنا. قيّم الخدمة بإرسال رقم من ١ إلى ٥ (٥ = ممتاز).\nThanks for contacting us. Rate our service from 1 to 5 (5 = excellent).';

type RatingTarget = {device_id: string; chat_jid: string};

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
  const summary = db.prepare(
    `SELECT COUNT(score) AS count, AVG(score) AS average
     FROM chat_close_ratings WHERE device_id = ? AND status = 'rated'`,
  ).get(deviceId) as {count: number; average: number | null};

  const recent = db.prepare(
    `SELECT r.closed_event_id AS id,
            r.score,
            r.rated_at,
            r.chat_jid,
            r.rated_user_id AS user_id,
            COALESCE(u.display_name, NULLIF(r.rated_user_name, ''), '') AS user_name
     FROM chat_close_ratings r
     LEFT JOIN users u ON u.id = r.rated_user_id
     WHERE r.device_id = ? AND r.status = 'rated'
     ORDER BY r.rated_at DESC, r.closed_event_id DESC LIMIT 10`,
  ).all(deviceId) as {
    id: number;
    score: number;
    rated_at: string;
    chat_jid: string;
    user_id: number | null;
    user_name: string;
  }[];

  const byUser = db.prepare(
    `SELECT r.rated_user_id AS user_id,
            COALESCE(u.display_name, NULLIF(r.rated_user_name, ''), '') AS user_name,
            COUNT(r.score) AS count,
            AVG(r.score) AS average
     FROM chat_close_ratings r
     LEFT JOIN users u ON u.id = r.rated_user_id
     WHERE r.device_id = ? AND r.status = 'rated'
     GROUP BY r.rated_user_id, user_name
     ORDER BY count DESC, average DESC`,
  ).all(deviceId) as {
    user_id: number | null;
    user_name: string;
    count: number;
    average: number;
  }[];

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
      db.prepare('DELETE FROM settings WHERE key = ?').run(ratingPromptKey(deviceId));
    } else {
      setSetting(ratingPromptKey(deviceId), clean);
    }
  }
  return getAccountCloseRatings(deviceId);
}

export function setAccountCloseRatingEnabled(deviceId: string, enabled: boolean) {
  return updateAccountCloseRatingSettings(deviceId, {enabled});
}

export function listUsersCloseRatingSummaries(): Array<{
  user_id: number;
  count: number;
  average: number | null;
}> {
  return db.prepare(
    `SELECT rated_user_id AS user_id,
            COUNT(score) AS count,
            AVG(score) AS average
     FROM chat_close_ratings
     WHERE status = 'rated' AND rated_user_id IS NOT NULL
     GROUP BY rated_user_id`,
  ).all() as Array<{user_id: number; count: number; average: number | null}>;
}

export function getUserCloseRatings(userId: number) {
  const user = getUserById(userId);
  if (!user) {
    throw new GowaError(404, 'NOT_FOUND', 'المستخدم غير موجود');
  }
  const aliases = getAccountAliases();
  const summary = db.prepare(
    `SELECT COUNT(score) AS count, AVG(score) AS average
     FROM chat_close_ratings
     WHERE rated_user_id = ? AND status = 'rated'`,
  ).get(userId) as {count: number; average: number | null};

  const recentRows = db.prepare(
    `SELECT closed_event_id AS id, score, rated_at, device_id, chat_jid
     FROM chat_close_ratings
     WHERE rated_user_id = ? AND status = 'rated'
     ORDER BY rated_at DESC, closed_event_id DESC LIMIT 20`,
  ).all(userId) as Array<{
    id: number;
    score: number;
    rated_at: string;
    device_id: string;
    chat_jid: string;
  }>;

  const byAccountRows = db.prepare(
    `SELECT device_id, COUNT(score) AS count, AVG(score) AS average
     FROM chat_close_ratings
     WHERE rated_user_id = ? AND status = 'rated'
     GROUP BY device_id
     ORDER BY count DESC, average DESC`,
  ).all(userId) as Array<{device_id: string; count: number; average: number}>;

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

export function expireChatCloseRatings(deviceId: string, chatJid: string): void {
  db.prepare(
    `UPDATE chat_close_ratings SET status = 'expired'
     WHERE device_id = ? AND chat_jid = ? AND status IN ('queued', 'sending', 'pending')`,
  ).run(deviceId, chatJid);
}

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
  db.prepare(
    `INSERT INTO chat_close_ratings (
       closed_event_id, device_id, chat_jid,
       rated_user_id, rated_user_name, closed_by_user_id,
       status, expires_at
     )
     VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`,
  ).run(
    closedEventId,
    deviceId,
    chatJid,
    attribution?.ratedUserId ?? null,
    (attribution?.ratedUserName ?? '').trim(),
    attribution?.closedByUserId ?? null,
    nowMs + RATING_WINDOW_MS,
  );
}

export async function sendChatCloseRatingPrompt(closedEventId: number): Promise<'sent' | 'failed' | undefined> {
  const target = db.prepare(
    `UPDATE chat_close_ratings SET status = 'sending'
     WHERE closed_event_id = ? AND status = 'queued' AND expires_at > ?
       AND EXISTS (
         SELECT 1 FROM chat_assignments a WHERE a.device_id = chat_close_ratings.device_id
           AND a.chat_jid = chat_close_ratings.chat_jid AND a.status = 'closed'
       )
     RETURNING device_id, chat_jid`,
  ).get(closedEventId, Date.now()) as RatingTarget | undefined;
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
    db.prepare(
      `UPDATE chat_close_ratings SET status = 'failed'
       WHERE closed_event_id = ? AND status = 'sending'`,
    ).run(closedEventId);
    return 'failed';
  }
  db.prepare(
    `UPDATE chat_close_ratings
     SET status = 'pending', prompt_message_id = ?, sent_at = ?, expires_at = ?
     WHERE closed_event_id = ? AND status = 'sending'`,
  ).run(messageId, sentAt, Date.now() + RATING_WINDOW_MS, closedEventId);

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
  const rows = db.prepare(
    `SELECT closed_event_id FROM chat_close_ratings
     WHERE status = 'queued' AND expires_at > ? ORDER BY closed_event_id`,
  ).all(Date.now()) as {closed_event_id: number}[];
  for (const {closed_event_id: eventId} of rows) await sendChatCloseRatingPrompt(eventId);
}

export function hasPendingChatCloseRating(chatJid: string, deviceId?: string): boolean {
  return Boolean(db.prepare(
    `SELECT 1 FROM chat_close_ratings r
     JOIN chat_assignments a ON a.device_id = r.device_id AND a.chat_jid = r.chat_jid
     WHERE r.chat_jid = ? AND r.status = 'pending' AND r.expires_at > ?
       AND a.status = 'closed' AND (? IS NULL OR r.device_id = ?) LIMIT 1`,
  ).get(chatJid, Date.now(), deviceId ?? null, deviceId ?? null));
}

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
): 'recorded' | 'duplicate' | undefined {
  if (!message.id || message.mediaType) return;
  const number = /^([1-5])(?:\s*\/\s*5)?$/u.exec(normalizeArabicDigits(message.text.trim()))?.[1];
  if (!number) return;
  const score = Number(number);

  if (db.prepare(
    `SELECT 1 FROM chat_close_ratings WHERE device_id = ? AND chat_jid = ? AND reply_message_id = ?`,
  ).get(deviceId, chatJid, message.id)) return 'duplicate';

  if (!message.timestampMs || isChatBlocked(deviceId, chatJid)) return;
  const now = Date.now();
  const quote = quotedMessageId(message) ?? null;
  const update = db.prepare(
    `UPDATE chat_close_ratings
     SET status = 'rated', score = ?, reply_message_id = ?, rated_at = ?
     WHERE device_id = ? AND chat_jid = ?
       AND status = 'pending' AND expires_at > ?
       AND sent_at - (sent_at % 1000) <= ? AND ? <= expires_at
       AND EXISTS (
         SELECT 1 FROM chat_assignments a WHERE a.device_id = chat_close_ratings.device_id
           AND a.chat_jid = chat_close_ratings.chat_jid AND a.status = 'closed'
       )
       AND (? IS NULL OR prompt_message_id = ?)`,
  ).run(
    score, message.id, new Date(now).toISOString(),
    deviceId, chatJid, now, message.timestampMs, message.timestampMs,
    quote, quote,
  );
  return Number(update.changes) ? 'recorded' : undefined;
}

export function buildCloseRatingUpdatedEvent(deviceId: string) {
  return {
    code: 'CHAT_CLOSE_RATING_UPDATED',
    message: 'updated',
    device_id: deviceId,
    result: {device_id: deviceId},
  };
}
