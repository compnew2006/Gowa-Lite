import {http, results} from '@/lib/http';
import type {CallAutoRejectSettings} from '@/api/contracts/calls';

const enc = encodeURIComponent;

export async function getCallAutoRejectSettings(
  deviceId: string,
): Promise<CallAutoRejectSettings> {
  return results(http.get(`/devices/${enc(deviceId)}/call/auto-reject`));
}

export async function saveCallAutoRejectSettings(
  deviceId: string,
  payload: {enabled?: boolean; reply_message?: string; reset_message?: boolean},
): Promise<CallAutoRejectSettings> {
  return results(http.put(`/devices/${enc(deviceId)}/call/auto-reject`, payload));
}

export async function rejectCall(
  deviceId: string,
  payload: {caller_jid: string; call_id: string},
): Promise<void> {
  await http.post(`/devices/${enc(deviceId)}/call/reject`, payload);
}
