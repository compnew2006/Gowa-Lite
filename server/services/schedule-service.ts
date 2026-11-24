import {parseTimestampMs} from '../db.ts';
import {GowaError, gowaFetch, type GowaPagination} from '../gowa-client.ts';
import type {GowaWsBridge} from '../ws-bridge.ts';
import {recipientMatchesChatJid} from './chat-sync.ts';

export type ScheduleRecurrence = 'once' | 'daily' | 'weekly' | 'monthly';
export type ScheduleAction = 'pause' | 'resume' | 'cancel';

const ALLOWED_RECURRENCES = new Set<ScheduleRecurrence>(['once', 'daily', 'weekly', 'monthly']);

export interface ScheduleInputBody {
  phone?: unknown;
  message?: unknown;
  scheduled_at?: unknown;
  timezone?: unknown;
  recurrence?: unknown;
  weekdays?: unknown;
  day_of_month?: unknown;
  end_at?: unknown;
  occurrence_limit?: unknown;
}

export function validateScheduleTimestamp(scheduledAtRaw: unknown, nowMs = Date.now()): {
  scheduledAt: string;
  scheduledMs: number;
} {
  const scheduledAt = typeof scheduledAtRaw === 'string' ? scheduledAtRaw.trim() : '';
  if (!scheduledAt) {
    throw new GowaError(400, 'VALIDATION_ERROR', 'موعد الإرسال مطلوب');
  }
  const scheduledMs = parseTimestampMs(scheduledAt);
  if (!scheduledMs || scheduledMs <= nowMs + 30_000) {
    throw new GowaError(400, 'VALIDATION_ERROR', 'يجب أن يكون موعد الإرسال في المستقبل');
  }
  return {scheduledAt, scheduledMs};
}

export function validateAndBuildSchedulePayload(
  body: ScheduleInputBody,
  options: {fixedPhone?: string; requirePhone?: boolean; nowMs?: number} = {},
): Record<string, unknown> {
  const phone =
    options.fixedPhone !== undefined
      ? options.fixedPhone.trim()
      : typeof body.phone === 'string'
        ? body.phone.trim()
        : '';
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  const scheduledAtRaw = typeof body.scheduled_at === 'string' ? body.scheduled_at.trim() : '';
  const timezone = typeof body.timezone === 'string' ? body.timezone.trim() : '';
  const recurrenceRaw =
    typeof body.recurrence === 'string' && body.recurrence.trim()
      ? body.recurrence.trim()
      : 'once';

  if (options.requirePhone && !phone) {
    throw new GowaError(400, 'VALIDATION_ERROR', 'الرقم ونص الرسالة وموعد الإرسال مطلوبون');
  }
  if (!message || !scheduledAtRaw) {
    throw new GowaError(
      400,
      'VALIDATION_ERROR',
      options.requirePhone ? 'الرقم ونص الرسالة وموعد الإرسال مطلوبون' : 'نص الرسالة وموعد الإرسال مطلوبان',
    );
  }

  const {scheduledAt, scheduledMs} = validateScheduleTimestamp(scheduledAtRaw, options.nowMs);

  if (!ALLOWED_RECURRENCES.has(recurrenceRaw as ScheduleRecurrence)) {
    throw new GowaError(400, 'VALIDATION_ERROR', 'نوع التكرار غير صالح');
  }

  const payload: Record<string, unknown> = {
    phone,
    message,
    scheduled_at: scheduledAt,
    recurrence: recurrenceRaw,
  };
  if (timezone) {
    payload.timezone = timezone;
  }

  if (Array.isArray(body.weekdays) && body.weekdays.length > 0) {
    const validWeekdays = Array.from(
      new Set(body.weekdays.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6)),
    );
    if (validWeekdays.length === 0) {
      throw new GowaError(400, 'VALIDATION_ERROR', 'أيام الأسبوع المحددة غير صالحة');
    }
    payload.weekdays = validWeekdays;
  }

  if (body.day_of_month !== undefined && body.day_of_month !== null && body.day_of_month !== '') {
    const day = Number(body.day_of_month);
    if (!Number.isInteger(day) || day < 1 || day > 31) {
      throw new GowaError(400, 'VALIDATION_ERROR', 'يوم الشهر يجب أن يكون بين 1 و 31');
    }
    payload.day_of_month = day;
  }

  if (typeof body.end_at === 'string' && body.end_at.trim()) {
    const endAt = body.end_at.trim();
    const endMs = parseTimestampMs(endAt);
    if (!endMs || endMs <= scheduledMs) {
      throw new GowaError(400, 'VALIDATION_ERROR', 'تاريخ انتهاء التكرار يجب أن يكون بعد موعد البدء');
    }
    payload.end_at = endAt;
  }

  if (
    body.occurrence_limit !== undefined &&
    body.occurrence_limit !== null &&
    body.occurrence_limit !== ''
  ) {
    const limit = Number(body.occurrence_limit);
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new GowaError(400, 'VALIDATION_ERROR', 'حد مرات الإرسال يجب أن يكون رقمًا صحيحًا موجبًا');
    }
    payload.occurrence_limit = limit;
  }

  return payload;
}

export async function createScheduleViaGowa(
  deviceId: string,
  payload: Record<string, unknown>,
  wsBridge?: GowaWsBridge,
  broadcastChatJid?: string,
): Promise<unknown> {
  const result = await gowaFetch('/send/message', {
    method: 'POST',
    deviceId,
    body: payload,
  });
  if (wsBridge && broadcastChatJid) {
    wsBridge.broadcast({
      code: 'SCHEDULE_UPDATED',
      message: 'created',
      device_id: deviceId,
      result: {chat_jid: broadcastChatJid},
    });
  }
  return result;
}

export async function rescheduleChatSchedule(
  deviceId: string,
  chatJid: string,
  scheduleId: string,
  input: {scheduled_at?: unknown; message?: unknown},
  wsBridge: GowaWsBridge,
): Promise<unknown> {
  const {scheduledAt} = validateScheduleTimestamp(input.scheduled_at);
  const message = typeof input.message === 'string' ? input.message.trim() : undefined;

  try {
    const patched = await gowaFetch(`/send/schedules/${encodeURIComponent(scheduleId)}`, {
      method: 'PATCH',
      deviceId,
      body: {
        scheduled_at: scheduledAt,
        ...(message ? {message} : {}),
      },
    });
    wsBridge.broadcast({
      code: 'SCHEDULE_UPDATED',
      message: 'updated',
      device_id: deviceId,
      result: {chat_jid: chatJid},
    });
    return patched;
  } catch (err) {
    if (!(err instanceof GowaError) || (err.status !== 404 && err.status !== 405)) {
      throw err;
    }
  }

  // Fallback: recreate text schedule then cancel previous one if GOWA lacks PATCH
  const at = chatJid.indexOf('@');
  const localPart = at === -1 ? chatJid : chatJid.slice(0, at);
  const searchKey = localPart.split(':')[0] || chatJid;
  let current: Record<string, unknown> | undefined;
  for (let pageOffset = 0; pageOffset < 500; pageOffset += 100) {
    const listRes = await gowaFetch<{
      data?: Array<Record<string, unknown>>;
      pagination?: GowaPagination;
    }>('/send/schedules', {
      deviceId,
      query: {search: searchKey, limit: 100, offset: pageOffset},
    });
    const items = listRes?.data ?? [];
    current = items.find(
      (item) =>
        String(item.id || '') === scheduleId &&
        recipientMatchesChatJid(String(item.recipient || ''), chatJid),
    );
    if (current) break;
    const total = listRes?.pagination?.total ?? 0;
    if (items.length < 100 || (total > 0 && pageOffset + items.length >= total)) {
      break;
    }
  }

  if (!current) {
    throw new GowaError(404, 'NOT_FOUND', 'الرسالة المجدولة غير موجودة');
  }

  const finalMessage = message || String(current.content || '').trim();
  if (String(current.message_type || 'text') !== 'text' || !finalMessage) {
    throw new GowaError(
      400,
      'RESCHEDULE_NOT_SUPPORTED',
      'تعذر تعديل موعد هذا النوع من الرسائل المجدولة مباشرة',
    );
  }

  const wasPaused = current.status === 'paused';
  const recreateBody: Record<string, unknown> = {
    phone: chatJid,
    message: finalMessage,
    scheduled_at: scheduledAt,
    recurrence: String(current.recurrence || 'once'),
  };
  if (typeof current.timezone === 'string' && current.timezone) {
    recreateBody.timezone = current.timezone;
  }
  if (Array.isArray(current.weekdays) && current.weekdays.length > 0) {
    recreateBody.weekdays = current.weekdays;
  }
  if (typeof current.day_of_month === 'number') {
    recreateBody.day_of_month = current.day_of_month;
  }
  if (typeof current.end_at === 'string' && current.end_at) {
    recreateBody.end_at = current.end_at;
  }
  if (typeof current.occurrence_limit === 'number' && current.occurrence_limit > 0) {
    recreateBody.occurrence_limit = current.occurrence_limit;
  }

  const created = await gowaFetch<{id?: string; schedule_id?: string}>('/send/message', {
    method: 'POST',
    deviceId,
    body: recreateBody,
  });
  const newScheduleId = String(created?.id || created?.schedule_id || '').trim();

  if (wasPaused && newScheduleId) {
    await gowaFetch(`/send/schedules/${encodeURIComponent(newScheduleId)}/pause`, {
      method: 'POST',
      deviceId,
    }).catch(() => undefined);
  }

  try {
    await gowaFetch(`/send/schedules/${encodeURIComponent(scheduleId)}/cancel`, {
      method: 'POST',
      deviceId,
    });
  } catch {
    if (newScheduleId) {
      await gowaFetch(`/send/schedules/${encodeURIComponent(newScheduleId)}/cancel`, {
        method: 'POST',
        deviceId,
      }).catch(() => undefined);
    }
    throw new GowaError(
      502,
      'RESCHEDULE_CANCEL_FAILED',
      'تعذر إلغاء الجدولة القديمة؛ تم التراجع عن التعديل لتجنب الإرسال المزدوج',
    );
  }

  wsBridge.broadcast({
    code: 'SCHEDULE_UPDATED',
    message: 'updated',
    device_id: deviceId,
    result: {chat_jid: chatJid},
  });
  return created;
}

export async function executeScheduleAction(
  deviceId: string,
  scheduleId: string,
  action: string,
  wsBridge?: GowaWsBridge,
  broadcastChatJid?: string,
): Promise<void> {
  if (action !== 'pause' && action !== 'resume' && action !== 'cancel') {
    throw new GowaError(400, 'VALIDATION_ERROR', 'إجراء غير صالح');
  }
  await gowaFetch(`/send/schedules/${encodeURIComponent(scheduleId)}/${action}`, {
    method: 'POST',
    deviceId,
  });
  if (wsBridge && broadcastChatJid) {
    wsBridge.broadcast({
      code: 'SCHEDULE_UPDATED',
      message: action,
      device_id: deviceId,
      result: {chat_jid: broadcastChatJid},
    });
  }
}
