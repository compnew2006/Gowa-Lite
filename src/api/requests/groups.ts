import {http, results} from '@/lib/http';
import type {ImageUploadPayload} from '@/api/contracts/chats';
import type {
  GroupInfoFromLink,
  GroupInviteLink,
  GroupParticipantsResult,
  MyGroup,
  ParticipantRequestEntry,
  ParticipantStatus,
  UnifiedGroupsResponse,
} from '@/api/contracts/groups';

const enc = encodeURIComponent;

// Groups & Newsletters (Admin, unified + per-device)
export function listUnifiedGroups(params?: {deviceIds?: string[]}): Promise<UnifiedGroupsResponse> {
  return results(
    http.get('/unified/groups', {
      params: {
        deviceIds:
          params?.deviceIds && params.deviceIds.length > 0 ? params.deviceIds.join(',') : undefined,
      },
    }),
  );
}

export function getUnifiedGroupsUnread(): Promise<{total_unread: number}> {
  return results(http.get('/unified/groups/unread'));
}

export function markUnifiedGroupRead(
  deviceId: string,
  groupJid: string,
): Promise<{chat_jid: string; last_read_seq: number}> {
  return results(http.post(`/unified/groups/${enc(deviceId)}/${enc(groupJid)}/read`));
}

export async function listGroups(deviceId: string): Promise<MyGroup[]> {
  const res = await results<MyGroup[] | null>(http.get(`/devices/${enc(deviceId)}/groups`));
  return res ?? [];
}

export function createGroup(
  deviceId: string,
  payload: {title: string; participants: string[]},
): Promise<{group_id?: string}> {
  return results(http.post(`/devices/${enc(deviceId)}/groups`, payload));
}

export function joinGroupWithLink(deviceId: string, link: string): Promise<{group_id?: string}> {
  return results(http.post(`/devices/${enc(deviceId)}/groups/join-with-link`, {link}));
}

export function getGroupInfoFromLink(deviceId: string, link: string): Promise<GroupInfoFromLink> {
  return results(
    http.get(`/devices/${enc(deviceId)}/groups/info-from-link`, {params: {link}}),
  );
}

export function getGroupInfo(deviceId: string, groupId: string): Promise<MyGroup> {
  return results(
    http.get(`/devices/${enc(deviceId)}/groups/info`, {params: {group_id: groupId}}),
  );
}

export async function leaveGroup(deviceId: string, groupId: string): Promise<void> {
  await http.post(`/devices/${enc(deviceId)}/groups/leave`, {group_id: groupId});
}

export async function listGroupParticipants(
  deviceId: string,
  groupId: string,
): Promise<GroupParticipantsResult> {
  const res = await results<GroupParticipantsResult | null>(
    http.get(`/devices/${enc(deviceId)}/groups/participants`, {params: {group_id: groupId}}),
  );
  return {
    group_id: res?.group_id ?? groupId,
    name: res?.name ?? '',
    participants: res?.participants ?? [],
  };
}

export async function exportGroupParticipantsCsv(
  deviceId: string,
  groupId: string,
): Promise<Blob> {
  const response = await http.get<Blob>(`/devices/${enc(deviceId)}/groups/participants/export`, {
    params: {group_id: groupId},
    responseType: 'blob',
  });
  return response.data;
}

export async function actOnGroupParticipants(
  deviceId: string,
  action: 'add' | 'remove' | 'promote' | 'demote',
  payload: {group_id: string; participants: string[]},
): Promise<ParticipantStatus[]> {
  const res = await results<ParticipantStatus[] | null>(
    http.post(`/devices/${enc(deviceId)}/groups/participants/${action}`, payload),
  );
  return res ?? [];
}

export async function listGroupParticipantRequests(
  deviceId: string,
  groupId: string,
): Promise<ParticipantRequestEntry[]> {
  const res = await results<ParticipantRequestEntry[] | null>(
    http.get(`/devices/${enc(deviceId)}/groups/participant-requests`, {
      params: {group_id: groupId},
    }),
  );
  return res ?? [];
}

export async function decideGroupParticipantRequests(
  deviceId: string,
  decision: 'approve' | 'reject',
  payload: {group_id: string; participants: string[]},
): Promise<unknown> {
  return results(
    http.post(`/devices/${enc(deviceId)}/groups/participant-requests/${decision}`, payload),
  );
}

export function setGroupName(deviceId: string, groupId: string, name: string): Promise<unknown> {
  return results(http.post(`/devices/${enc(deviceId)}/groups/name`, {group_id: groupId, name}));
}

export function setGroupTopic(deviceId: string, groupId: string, topic: string): Promise<unknown> {
  return results(http.post(`/devices/${enc(deviceId)}/groups/topic`, {group_id: groupId, topic}));
}

export function setGroupLocked(
  deviceId: string,
  groupId: string,
  locked: boolean,
): Promise<unknown> {
  return results(http.post(`/devices/${enc(deviceId)}/groups/locked`, {group_id: groupId, locked}));
}

export function setGroupAnnounce(
  deviceId: string,
  groupId: string,
  announce: boolean,
): Promise<unknown> {
  return results(
    http.post(`/devices/${enc(deviceId)}/groups/announce`, {group_id: groupId, announce}),
  );
}

export function getGroupInviteLink(
  deviceId: string,
  groupId: string,
  reset = false,
): Promise<GroupInviteLink> {
  return results(
    http.get(`/devices/${enc(deviceId)}/groups/invite-link`, {
      params: {group_id: groupId, reset: reset ? 'true' : undefined},
    }),
  );
}

export function setGroupPhoto(
  deviceId: string,
  groupId: string,
  upload?: ImageUploadPayload,
): Promise<unknown> {
  return results(
    http.post(`/devices/${enc(deviceId)}/groups/photo`, {
      group_id: groupId,
      ...(upload ?? {}),
    }),
  );
}
