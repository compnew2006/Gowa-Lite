import {http, results} from '@/lib/http';
import type {CreateSchedulePayload, ScheduleList} from '@/api/contracts/schedules';

const enc = encodeURIComponent;

// In-Chat Scheduled Messages
export async function listUnifiedChatSchedules(
  deviceId: string,
  chatJid: string,
  status?: string,
): Promise<ScheduleList> {
  const res = await results<ScheduleList | null>(
    http.get(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/schedules`, {
      // P1-1 (decision 9): the drawer shows this chat's schedules from all
      // of the user's allowed devices — a schedule is stored under whichever
      // device created it, and the single-device query hid the rest.
      params: {
        status: status && status !== 'all' ? status : undefined,
        all_devices: 1,
      },
    }),
  );
  return {
    data: res?.data ?? [],
    pagination: res?.pagination ?? {limit: 100, offset: 0, total: 0},
    content_redacted: res?.content_redacted,
    redaction_reason: res?.redaction_reason,
  };
}

export function createUnifiedChatSchedule(
  deviceId: string,
  chatJid: string,
  payload: Omit<CreateSchedulePayload, 'phone'>,
): Promise<unknown> {
  return results(http.post(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/schedules`, payload));
}

export function createUnifiedChatScheduleWithMedia(
  deviceId: string,
  chatJid: string,
  form: FormData,
): Promise<unknown> {
  return results(http.post(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/schedules`, form));
}

export function updateUnifiedChatSchedule(
  deviceId: string,
  chatJid: string,
  scheduleId: string,
  payload: {scheduled_at: string; message?: string},
): Promise<unknown> {
  return results(
    http.patch(
      `/unified/chats/${enc(deviceId)}/${enc(chatJid)}/schedules/${enc(scheduleId)}`,
      payload,
    ),
  );
}

export async function actionUnifiedChatSchedule(
  deviceId: string,
  chatJid: string,
  scheduleId: string,
  action: 'pause' | 'resume' | 'cancel',
): Promise<void> {
  await http.post(
    `/unified/chats/${enc(deviceId)}/${enc(chatJid)}/schedules/${enc(scheduleId)}/${action}`,
  );
}

// Scheduled Sends (Admin, per-device)
export async function listSchedules(
  deviceId: string,
  params: {status?: string; search?: string; message_type?: string; limit?: number; offset?: number},
): Promise<ScheduleList> {
  const res = await results<ScheduleList | null>(
    http.get(`/devices/${enc(deviceId)}/schedules`, {
      params: {
        status: params.status && params.status !== 'all' ? params.status : undefined,
        search: params.search || undefined,
        message_type:
          params.message_type && params.message_type !== 'all' ? params.message_type : undefined,
        limit: params.limit ?? 25,
        offset: params.offset ?? 0,
      },
    }),
  );
  return {
    data: res?.data ?? [],
    pagination: res?.pagination ?? {limit: params.limit ?? 25, offset: params.offset ?? 0, total: 0},
  };
}

export function createSchedule(deviceId: string, payload: CreateSchedulePayload): Promise<unknown> {
  return results(http.post(`/devices/${enc(deviceId)}/schedules`, payload));
}

export async function actionSchedule(
  deviceId: string,
  scheduleId: string,
  action: 'pause' | 'resume' | 'cancel',
): Promise<void> {
  await http.post(`/devices/${enc(deviceId)}/schedules/${enc(scheduleId)}/${action}`);
}

// P2-9: edit a schedule from the Scheduled page (time, and text for text
// schedules — text edits take the recreate path server-side).
export function rescheduleSchedule(
  deviceId: string,
  scheduleId: string,
  payload: {scheduled_at: string; message?: string},
): Promise<unknown> {
  return results(
    http.patch(`/devices/${enc(deviceId)}/schedules/${enc(scheduleId)}`, payload),
  );
}
