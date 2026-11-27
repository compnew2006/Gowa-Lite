import {http, results} from '@/lib/http';
import type {ImageUploadPayload} from '@/api/contracts/chats';
import type {
  AccountContact,
  AvatarResponse,
  BusinessProfileResponse,
  CheckResponse,
  PrivacyResponse,
  UserInfoResponse,
} from '@/api/contracts/profile';

const enc = encodeURIComponent;

// Account Profile & Lookups (Admin, per-device)
export async function getAccountPrivacy(deviceId: string): Promise<PrivacyResponse> {
  const res = await results<PrivacyResponse | null>(
    http.get(`/devices/${enc(deviceId)}/user/privacy`),
  );
  return res ?? {};
}

export async function listAccountContacts(deviceId: string): Promise<AccountContact[]> {
  const res = await results<AccountContact[] | null>(
    http.get(`/devices/${enc(deviceId)}/user/contacts`),
  );
  return res ?? [];
}

export async function changeAccountPushName(deviceId: string, pushName: string): Promise<void> {
  await http.post(`/devices/${enc(deviceId)}/user/pushname`, {push_name: pushName});
}

export async function changeAccountAvatar(
  deviceId: string,
  upload: ImageUploadPayload,
): Promise<void> {
  await http.post(`/devices/${enc(deviceId)}/user/avatar`, upload);
}

export function lookupUserAvatar(
  deviceId: string,
  phone: string,
  isPreview = false,
  isCommunity = false,
): Promise<AvatarResponse> {
  return results(
    http.get(`/devices/${enc(deviceId)}/user/avatar`, {
      params: {
        phone,
        is_preview: isPreview ? 'true' : undefined,
        is_community: isCommunity ? 'true' : undefined,
      },
    }),
  );
}

export function lookupUserInfo(deviceId: string, phone: string): Promise<UserInfoResponse> {
  return results(http.get(`/devices/${enc(deviceId)}/user/info`, {params: {phone}}));
}

export function lookupUserCheck(deviceId: string, phone: string): Promise<CheckResponse> {
  return results(http.get(`/devices/${enc(deviceId)}/user/check`, {params: {phone}}));
}

export function lookupBusinessProfile(
  deviceId: string,
  phone: string,
): Promise<BusinessProfileResponse> {
  return results(http.get(`/devices/${enc(deviceId)}/user/business-profile`, {params: {phone}}));
}
