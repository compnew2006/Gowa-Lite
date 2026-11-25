import {db, getSetting, isChatBlocked, setSetting, upsertCachedMessages} from '../db.ts';
import {gowaFetch} from '../gowa-client.ts';

const RATING_WINDOW_MS = 48 * 60 * 60 * 1000;
const RATING_PROMPT = 'شكرًا لتواصلك معنا. قيّم الخدمة بإرسال رقم من ١ إلى ٥ (٥ = ممتاز).\nThanks for contacting us. Rate our service from 1 to 5 (5 = excellent).';

type RatingTarget = {device_id: string; chat_jid: string};

function ratingSettingKey(deviceId: string): string {
  return `close_rating_enabled:${deviceId}`;
}

export function getAccountCloseRatings(deviceId: string) {
  const summary = db.prepare(
    `SELECT COUNT(score) AS count, AVG(score) AS average
     FROM chat_close_ratings WHERE device_id = ? AND status = 'rated'`,
  ).get(deviceId) as {count: number; average: number | null};
  const recent = db.prepare(
    `SELECT closed_event_id AS id, score, rated_at
     FROM chat_close_ratings WHERE device_id = ? AND status = 'rated'
     ORDER BY rated_at DESC, closed_event_id DESC LIMIT 10`,
  ).all(deviceId) as {id: number; score: number; rated_at: string}[];
  return {
    enabled: getSetting(ratingSettingKey(deviceId)) === 'true',
    webhook_configured: Boolean(process.env.GOWA_WEBHOOK_SECRET?.trim()),
    ...summary,
    recent,
  };
}

export function setAccountCloseRatingEnabled(deviceId: string, enabled: boolean) {
  setSetting(ratingSettingKey(deviceId), String(enabled));
  return getAccountCloseRatings(deviceId);
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
): void {
  if (!/@(s\.whatsapp\.net|lid)$/.test(chatJid) ||
      getSetting(ratingSettingKey(deviceId)) !== 'true' ||
      isChatBlocked(deviceId, chatJid)) return;

  expireChatCloseRatings(deviceId, chatJid);
  db.prepare(
    `INSERT INTO chat_close_ratings (closed_event_id, device_id, chat_jid, status, expires_at)
     VALUES (?, ?, ?, 'queued', ?)`,
  ).run(closedEventId, deviceId, chatJid, nowMs + RATING_WINDOW_MS);
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
  const sentAt = Date.now();
  let messageId: string;

  try {
    const sent = await gowaFetch<{message_id: string}>('/send/message', {
      method: 'POST',
      deviceId,
      timeoutMs: 5_000,
      body: {phone: chatJid, message: RATING_PROMPT},
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
    content: RATING_PROMPT,
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
  const number = /^([1-5١-٥۱-۵])(?:\s*\/\s*[5٥۵])?$/u.exec(message.text.trim())?.[1];
  if (!number) return;
  const digits = ['12345', '١٢٣٤٥', '۱۲۳۴۵'];
  const digitSet = digits.find((set) => set.includes(number));
  if (!digitSet) return;
  const score = digitSet.indexOf(number) + 1;

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
