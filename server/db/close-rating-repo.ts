import {db} from './connection.ts';

type RatingTarget = {device_id: string; chat_jid: string};

export function getAccountRatingRows(deviceId: string) {
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

  return {summary, recent, byUser};
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

export function getUserRatingRows(userId: number) {
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

  return {summary, recentRows, byAccountRows};
}

export function expireChatCloseRatings(deviceId: string, chatJid: string): void {
  db.prepare(
    `UPDATE chat_close_ratings SET status = 'expired'
     WHERE device_id = ? AND chat_jid = ? AND status IN ('queued', 'sending', 'pending')`,
  ).run(deviceId, chatJid);
}

export function insertQueuedRating(
  deviceId: string,
  chatJid: string,
  closedEventId: number,
  expiresAt: number,
  attribution?: {
    ratedUserId?: number | null;
    ratedUserName?: string;
    closedByUserId?: number | null;
  },
): void {
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
    expiresAt,
  );
}

export function claimQueuedRating(closedEventId: number, nowMs: number): RatingTarget | undefined {
  return db.prepare(
    `UPDATE chat_close_ratings SET status = 'sending'
     WHERE closed_event_id = ? AND status = 'queued' AND expires_at > ?
       AND EXISTS (
         SELECT 1 FROM chat_assignments a WHERE a.device_id = chat_close_ratings.device_id
           AND a.chat_jid = chat_close_ratings.chat_jid AND a.status = 'closed'
       )
     RETURNING device_id, chat_jid`,
  ).get(closedEventId, nowMs) as RatingTarget | undefined;
}

export function failRatingPrompt(closedEventId: number): void {
  db.prepare(
    `UPDATE chat_close_ratings SET status = 'failed'
     WHERE closed_event_id = ? AND status = 'sending'`,
  ).run(closedEventId);
}

export function markRatingPromptSent(closedEventId: number, messageId: string, sentAt: number, expiresAt: number): void {
  db.prepare(
    `UPDATE chat_close_ratings
     SET status = 'pending', prompt_message_id = ?, sent_at = ?, expires_at = ?
     WHERE closed_event_id = ? AND status = 'sending'`,
  ).run(messageId, sentAt, expiresAt, closedEventId);
}

export function listQueuedRatingEvents(nowMs: number): {closed_event_id: number}[] {
  return db.prepare(
    `SELECT closed_event_id FROM chat_close_ratings
     WHERE status = 'queued' AND expires_at > ? ORDER BY closed_event_id`,
  ).all(nowMs) as {closed_event_id: number}[];
}

export function hasPendingChatCloseRating(chatJid: string, deviceId?: string): boolean {
  return Boolean(db.prepare(
    `SELECT 1 FROM chat_close_ratings r
     JOIN chat_assignments a ON a.device_id = r.device_id AND a.chat_jid = r.chat_jid
     WHERE r.chat_jid = ? AND r.status = 'pending' AND r.expires_at > ?
       AND a.status = 'closed' AND (? IS NULL OR r.device_id = ?) LIMIT 1`,
  ).get(chatJid, Date.now(), deviceId ?? null, deviceId ?? null));
}

export function hasRecordedRatingReply(deviceId: string, chatJid: string, messageId: string): boolean {
  return Boolean(db.prepare(
    `SELECT 1 FROM chat_close_ratings WHERE device_id = ? AND chat_jid = ? AND reply_message_id = ?`,
  ).get(deviceId, chatJid, messageId));
}

export function recordPendingRating(options: {
  score: number;
  messageId: string;
  deviceId: string;
  chatJid: string;
  now: number;
  timestampMs: number;
  quote: string | null;
}): boolean {
  const {score, messageId, deviceId, chatJid, now, timestampMs, quote} = options;
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
    score, messageId, new Date(now).toISOString(),
    deviceId, chatJid, now, timestampMs, timestampMs,
    quote, quote,
  );
  return Number(update.changes) > 0;
}
