import {db} from './connection.ts';

export type CallRejectStatus = 'pending' | 'rejected' | 'already_rejected' | 'failed';
export type CallReplyStatus = 'pending' | 'sent' | 'failed' | 'no_message' | 'skipped';

export interface CallAutoRejectLogEntry {
  device_id: string;
  call_id: string;
  caller_jid: string;
  caller_name: string;
  reject_status: CallRejectStatus;
  reply_status: CallReplyStatus;
  reply_message: string;
  created_at: string;
}

export function listRecentCallRejections(deviceId: string): CallAutoRejectLogEntry[] {
  const rows = db
    .prepare(
      `SELECT device_id, call_id, caller_jid, caller_name, reject_status, reply_status, reply_message, created_at
       FROM call_auto_reject_logs
       WHERE device_id = ?
       ORDER BY created_at_ms DESC
       LIMIT 15`,
    )
    .all(deviceId);

  return rows.map((row) => ({
    device_id: String(row.device_id ?? ''),
    call_id: String(row.call_id ?? ''),
    caller_jid: String(row.caller_jid ?? ''),
    caller_name: String(row.caller_name ?? ''),
    reject_status: String(row.reject_status ?? 'pending') as CallRejectStatus,
    reply_status: String(row.reply_status ?? 'pending') as CallReplyStatus,
    reply_message: String(row.reply_message ?? ''),
    created_at: String(row.created_at ?? ''),
  }));

}

export function beginCallRejection(
  deviceId: string,
  details: {callId: string; callerJid: string; callerName: string},
  createdAt: string,
  nowMs: number,
): boolean {
  const insertResult = db
    .prepare(
      `INSERT OR IGNORE INTO call_auto_reject_logs (
         device_id, call_id, caller_jid, caller_name,
         reject_status, reply_status, reply_message,
         created_at, created_at_ms
       )
       VALUES (?, ?, ?, ?, 'pending', 'pending', '', ?, ?)`,
    )
    .run(deviceId, details.callId, details.callerJid, details.callerName, createdAt, nowMs);

  return insertResult.changes > 0;
}

export function completeCallRejection(entry: CallAutoRejectLogEntry): void {
  db.prepare(
    `UPDATE call_auto_reject_logs
     SET reject_status = ?, reply_status = ?, reply_message = ?
     WHERE device_id = ? AND call_id = ?`,
  ).run(entry.reject_status, entry.reply_status, entry.reply_message, entry.device_id, entry.call_id);
}
