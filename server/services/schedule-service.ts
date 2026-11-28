import {parseTimestampMs} from '../db.ts';
import {GowaError, gowaFetch, type GowaPagination} from '../gowa-client.ts';
import type {GowaWsBridge} from '../ws-bridge.ts';
import {normalizeWhatsAppJid} from '../../shared/whatsapp-identity.ts';
import {recipientMatchesChatJid, resolveGowaMediaTarget} from './chat-sync.ts';
import {
  getScheduleChatJid,
  resolveCreatedScheduleId,
  transferScheduleOwnership,
} from './schedule-ownership.ts';

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
  options: {fixedPhone?: string; requirePhone?: boolean; nowMs?: number; allowEmptyMessage?: boolean} = {},
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
  // A media schedule may carry an empty caption (audio/sticker have none);
  // the file itself is the message. Text schedules still require a message.
  if ((!message && !options.allowEmptyMessage) || !scheduledAtRaw) {
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

  // P1-21 (decision 6): a recurrence must end — either an end date or an
  // occurrence limit is required. No default limit is imposed, and
  // already-created open-ended recurrences keep working untouched.
  if (recurrenceRaw !== 'once' && !payload.end_at && !payload.occurrence_limit) {
    throw new GowaError(
      400,
      'VALIDATION_ERROR',
      'التكرار يتطلب تاريخ انتهاء أو حد مرات — أدخل أحدهما',
    );
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

export interface MediaScheduleFileInput {
  buffer: Buffer;
  filename: string;
  mimeType: string;
}

export interface MediaScheduleInput {
  file: MediaScheduleFileInput;
  caption: string;
  scheduledAt: string;
  timezone?: string;
  recurrence: string;
  weekdays?: number[];
  dayOfMonth?: number;
  endAt?: string;
  occurrenceLimit?: number;
}

/**
 * Build the multipart body for a scheduled media send. The gateway's media
 * endpoints (verified in 9.10.0: `ScheduleOptions` is embedded in every
 * `BaseRequest`, and the scheduled-send interceptor persists the asset when
 * `scheduled_at` is set) accept the same schedule fields as the JSON text
 * path, plus the file under the media endpoint's field name.
 */
export function buildMediaScheduleFormData(
  phone: string,
  input: MediaScheduleInput,
): {endpoint: string; formData: FormData} {
  const target = resolveGowaMediaTarget(input.file.mimeType, input.file.filename);
  const formData = new FormData();
  formData.set('phone', phone);
  if (target.supportsCaption && input.caption) {
    formData.set('caption', input.caption);
  }
  formData.set('scheduled_at', input.scheduledAt);
  if (input.timezone) {
    formData.set('timezone', input.timezone);
  }
  formData.set('recurrence', input.recurrence);
  if (input.weekdays && input.weekdays.length > 0) {
    for (const day of input.weekdays) {
      formData.append('weekdays', String(day));
    }
  }
  if (input.dayOfMonth !== undefined) {
    formData.set('day_of_month', String(input.dayOfMonth));
  }
  if (input.endAt) {
    formData.set('end_at', input.endAt);
  }
  if (input.occurrenceLimit !== undefined) {
    formData.set('occurrence_limit', String(input.occurrenceLimit));
  }
  formData.set(
    target.fieldName,
    new Blob([new Uint8Array(input.file.buffer)], {type: target.mimeType}),
    target.filename,
  );
  return {endpoint: target.endpoint, formData};
}

export async function createMediaScheduleViaGowa(
  deviceId: string,
  phone: string,
  payload: Record<string, unknown>,
  file: MediaScheduleFileInput,
  wsBridge?: GowaWsBridge,
  broadcastChatJid?: string,
): Promise<unknown> {
  const {endpoint, formData} = buildMediaScheduleFormData(phone, {
    file,
    caption: typeof payload.message === 'string' ? payload.message : '',
    scheduledAt: String(payload.scheduled_at || ''),
    timezone: typeof payload.timezone === 'string' ? payload.timezone : undefined,
    recurrence: String(payload.recurrence || 'once'),
    weekdays: Array.isArray(payload.weekdays) ? (payload.weekdays as number[]) : undefined,
    dayOfMonth: typeof payload.day_of_month === 'number' ? payload.day_of_month : undefined,
    endAt: typeof payload.end_at === 'string' ? payload.end_at : undefined,
    occurrenceLimit:
      typeof payload.occurrence_limit === 'number' ? payload.occurrence_limit : undefined,
  });
  const result = await gowaFetch(endpoint, {
    method: 'POST',
    deviceId,
    formData,
    timeoutMs: 45_000,
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
  input: {scheduled_at?: unknown; message?: unknown; forceRecreate?: boolean},
  wsBridge: GowaWsBridge,
): Promise<unknown> {
  const {scheduledAt} = validateScheduleTimestamp(input.scheduled_at);
  const message = typeof input.message === 'string' ? input.message.trim() : undefined;

  // P2-9: a text change must actually change the text. A gateway PATCH may
  // silently ignore an unsupported `message` field while returning 200, so
  // when the caller asks for a recreate (text edits from the Scheduled
  // page), skip PATCH entirely and take the recreate path below, where the
  // new text is part of the created schedule.
  if (!input.forceRecreate) {
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

  // Resolve the recreated schedule's id for the pause/rollback steps below.
  // If the create response carries no id, fall back to unambiguous list
  // matching; on ambiguity the id stays unknown and the new schedule stays
  // admin-only — never guess.
  let resolvedNewId = newScheduleId;
  if (!resolvedNewId) {
    resolvedNewId =
      (await resolveCreatedScheduleId(
        deviceId,
        {phone: chatJid, message: finalMessage, scheduled_at: scheduledAt},
        created,
      )) ?? '';
  }

  if (wasPaused && resolvedNewId) {
    await gowaFetch(`/send/schedules/${encodeURIComponent(resolvedNewId)}/pause`, {
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
    // P2-9: the old schedule could not be cancelled, so roll the new one
    // back — otherwise the old and the new would both be active and the
    // message would send twice. If the rollback itself fails (or the new
    // id was never resolved, so there is nothing to roll back), say so
    // explicitly with both ids: the previous code threw the same
    // "rolled back" message either way, hiding a live double-send.
    let rollbackOk = Boolean(resolvedNewId);
    if (resolvedNewId) {
      try {
        await gowaFetch(`/send/schedules/${encodeURIComponent(resolvedNewId)}/cancel`, {
          method: 'POST',
          deviceId,
        });
      } catch {
        rollbackOk = false;
      }
    }
    if (!rollbackOk) {
      throw new GowaError(
        502,
        'RESCHEDULE_ROLLBACK_FAILED',
        'تعذر إلغاء الجدولة القديمة، وتعذر أيضاً التراجع عن الجدولة الجديدة — قد تكون الجدولتان نشطتين الآن؛ ألغِ إحداهما يدوياً من صفحة المجدولة',
        {old_schedule_id: scheduleId, new_schedule_id: resolvedNewId || null},
      );
    }
    throw new GowaError(
      502,
      'RESCHEDULE_CANCEL_FAILED',
      'تعذر إلغاء الجدولة القديمة؛ تم التراجع عن التعديل لتجنب الإرسال المزدوج',
      {old_schedule_id: scheduleId, new_schedule_id: resolvedNewId || null},
    );
  }

  // Ownership follows the schedule, transferred only once the recreate is
  // fully committed (old schedule cancelled): the mapping moves to the new id
  // with the same owner and the old row is dropped.
  if (resolvedNewId) {
    transferScheduleOwnership(deviceId, scheduleId, resolvedNewId);
  }

  wsBridge.broadcast({
    code: 'SCHEDULE_UPDATED',
    message: 'updated',
    device_id: deviceId,
    result: {chat_jid: chatJid},
  });
  return created;
}

/**
 * P2-9: find a schedule's recipient chat by scanning the gateway list for
 * its id. Used only when the ownership row has no chat (schedules created
 * before the chat_jid column existed, or created outside Lite). Bounded
 * like the reschedule fallback scan below (500 records).
 */
async function findScheduleChatJidById(
  deviceId: string,
  scheduleId: string,
): Promise<string | null> {
  for (let pageOffset = 0; pageOffset < 500; pageOffset += 100) {
    let listRes: {data?: Array<Record<string, unknown>>; pagination?: GowaPagination};
    try {
      listRes = await gowaFetch<{data?: Array<Record<string, unknown>>; pagination?: GowaPagination}>(
        '/send/schedules',
        {deviceId, query: {limit: 100, offset: pageOffset}},
      );
    } catch {
      return null;
    }
    const items = listRes?.data ?? [];
    const match = items.find((item) => String(item.id || '') === scheduleId);
    if (match) {
      const recipient = String(match.recipient || match.phone || match.to || '').trim();
      if (!recipient) return null;
      return normalizeWhatsAppJid(recipient);
    }
    const total = listRes?.pagination?.total ?? 0;
    if (items.length < 100 || (total > 0 && pageOffset + items.length >= total)) {
      break;
    }
  }
  return null;
}

/**
 * P2-9: reschedule a schedule from the Scheduled page, which carries no
 * chat in its URL. The recipient chat is resolved from the ownership row
 * first (recorded at creation), else from the gateway record itself; without
 * a chat the drawer's reschedule cannot run its fallback search, so it
 * fails with 404 instead of guessing.
 *
 * Text edits always take the recreate path (`forceRecreate`): a gateway
 * PATCH may silently ignore an unsupported `message` field while returning
 * 200, and the recreate path is the only one that provably carries the new
 * text. Time-only edits keep the PATCH-first behaviour the drawer uses.
 * Non-text schedules therefore expose time-only editing in the UI — the
 * recreate path rejects them (RESCHEDULE_NOT_SUPPORTED) when PATCH is
 * unavailable.
 */
export async function reschedulePageSchedule(
  deviceId: string,
  scheduleId: string,
  input: {scheduled_at?: unknown; message?: unknown},
  wsBridge: GowaWsBridge,
): Promise<unknown> {
  const chatJid =
    getScheduleChatJid(deviceId, scheduleId) ??
    (await findScheduleChatJidById(deviceId, scheduleId));
  if (!chatJid) {
    throw new GowaError(404, 'NOT_FOUND', 'تعذر تحديد محادثة الجدولة المطلوبة');
  }
  const message = typeof input.message === 'string' ? input.message.trim() : undefined;
  return rescheduleChatSchedule(deviceId, chatJid, scheduleId, {
    scheduled_at: input.scheduled_at,
    ...(message ? {message} : {}),
    forceRecreate: Boolean(message),
  }, wsBridge);
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
