import {http, results} from '@/lib/http';
import type {
  AccountSummary,
  AssignableAccountsCatalog,
  DeviceStatus,
  LoginQr,
  PairCode,
  RegistryDevice,
} from '@/api/contracts/accounts';
import type {AccountCloseRatings, AccountDailyResetSettings, DailyResetRunResult} from '@/api/contracts/workflow';

const enc = encodeURIComponent;

export function getAccountCloseRatings(deviceId: string): Promise<AccountCloseRatings> {
  return results(http.get(`/devices/${enc(deviceId)}/close-ratings`));
}

export function saveAccountCloseRatings(
  deviceId: string,
  payload: {enabled?: boolean; prompt_message?: string},
): Promise<AccountCloseRatings> {
  return results(http.put(`/devices/${enc(deviceId)}/close-ratings`, payload));
}

export function getAccountDailyReset(deviceId: string): Promise<AccountDailyResetSettings> {
  return results(http.get(`/devices/${enc(deviceId)}/daily-reset`));
}

export function saveAccountDailyReset(
  deviceId: string,
  payload: {enabled: boolean; reset_hour: number; timezone: string},
): Promise<AccountDailyResetSettings> {
  return results(http.put(`/devices/${enc(deviceId)}/daily-reset`, payload));
}

export function runAccountDailyResetNow(deviceId: string): Promise<DailyResetRunResult> {
  return results(http.post(`/devices/${enc(deviceId)}/daily-reset/run`));
}

export function listUnifiedAccounts(): Promise<AccountSummary[]> {
  return results(http.get('/unified/accounts'));
}

export function listAssignableAccounts(): Promise<AssignableAccountsCatalog> {
  return results(http.get('/users/assignable-accounts'));
}

export function listDevices(): Promise<RegistryDevice[]> {
  return results(http.get('/devices'));
}

export function createDevice(payload: {
  device_id?: string;
  display_name?: string;
}): Promise<RegistryDevice> {
  return results(http.post('/devices', payload));
}

export function updateDeviceAlias(
  deviceId: string,
  alias: string,
): Promise<{device_id: string; alias: string}> {
  return results(http.patch(`/devices/${enc(deviceId)}/alias`, {alias}));
}

export async function deleteDevice(deviceId: string): Promise<void> {
  await http.delete(`/devices/${enc(deviceId)}`);
}

export function loginDeviceQr(deviceId: string): Promise<LoginQr> {
  return results(http.get(`/devices/${enc(deviceId)}/login`));
}

export function loginDeviceCode(deviceId: string, phone: string): Promise<PairCode> {
  return results(http.post(`/devices/${enc(deviceId)}/login/code`, {phone}));
}

export async function logoutDevice(deviceId: string): Promise<void> {
  await http.post(`/devices/${enc(deviceId)}/logout`);
}

export async function reconnectDevice(deviceId: string): Promise<void> {
  await http.post(`/devices/${enc(deviceId)}/reconnect`);
}

export function getDeviceStatus(deviceId: string): Promise<DeviceStatus> {
  return results(http.get(`/devices/${enc(deviceId)}/status`));
}
