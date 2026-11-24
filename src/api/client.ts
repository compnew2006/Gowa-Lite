import {http, results} from '@/lib/http';
import type {
  AccountContact,
  AccountSummary,
  AuthStatus,
  AvatarResponse,
  BusinessProfileResponse,
  ChatInfo,
  CheckResponse,
  ConversationNote,
  CreateSchedulePayload,
  DeviceStatus,
  DirectoryResponse,
  DownloadedMedia,
  GowaProbeResult,
  GowaSettings,
  GroupInfoFromLink,
  GroupInviteLink,
  GroupParticipantsResult,
  ImageUploadPayload,
  LanguagePreference,
  LiveUpdatesSubscription,
  LoginQr,
  MessageInfo,
  MyGroup,
  NewsletterMedia,
  NewsletterMessage,
  NewsletterMetadata,
  Pagination,
  PairCode,
  ParticipantRequestEntry,
  ParticipantStatus,
  PrivacyResponse,
  RegistryDevice,
  ScheduleList,
  ThemePreference,
  UnifiedChatsResponse,
  User,
  UserInfoResponse,
  UserRole,
} from '@/api/types';

const enc = encodeURIComponent;

export async function fileToImageUpload(file: File): Promise<ImageUploadPayload> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return {
    filename: file.name || 'image.png',
    mimeType: file.type || 'image/png',
    dataBase64: btoa(binary),
  };
}

// Auth & Setup
export function getAuthStatus(): Promise<AuthStatus> {
  return results(http.get('/auth/status'));
}

export function submitInitialSetup(payload: {
  display_name: string;
  username: string;
  password: string;
  gowa_url?: string;
  gowa_username?: string;
  gowa_password?: string;
}): Promise<{token: string; user: User}> {
  return results(http.post('/auth/setup', payload));
}

export function loginUser(payload: {
  username: string;
  password: string;
}): Promise<{token: string; user: User}> {
  return results(http.post('/auth/login', payload));
}

export async function logoutUser(): Promise<void> {
  await http.post('/auth/logout');
}

export function updateMyPreferences(payload: {
  theme?: ThemePreference;
  language?: LanguagePreference;
}): Promise<User> {
  return results(http.put('/me/preferences', payload));
}

export function updateMyTheme(theme: ThemePreference): Promise<User> {
  return updateMyPreferences({theme});
}

// Users (Admin)
export function listUsers(): Promise<User[]> {
  return results(http.get('/users'));
}

export function createUser(payload: {
  display_name: string;
  username: string;
  password: string;
  role: UserRole;
}): Promise<User> {
  return results(http.post('/users', payload));
}

export function updateUser(
  id: number,
  payload: {
    display_name?: string;
    role?: UserRole;
    is_active?: boolean;
    password?: string;
  },
): Promise<User> {
  return results(http.patch(`/users/${id}`, payload));
}

export async function deleteUser(id: number): Promise<void> {
  await http.delete(`/users/${id}`);
}

// Settings (Admin)
export function getGowaSettings(): Promise<GowaSettings> {
  return results(http.get('/settings/gowa'));
}

export function saveGowaSettings(payload: {
  gowa_url: string;
  gowa_username: string;
  gowa_password?: string;
  clear_password?: boolean;
}): Promise<GowaSettings> {
  return results(http.put('/settings/gowa', payload));
}

export function testGowaSettings(payload?: {
  gowa_url?: string;
  gowa_username?: string;
  gowa_password?: string;
}): Promise<GowaProbeResult> {
  return results(http.post('/settings/gowa/test', payload ?? {}));
}

// Accounts / Devices
export function listUnifiedAccounts(): Promise<AccountSummary[]> {
  return results(http.get('/unified/accounts'));
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

export async function fetchAuthorizedBlobUrl(urlPath: string): Promise<string> {
  const response = await http.get<Blob>(urlPath, {
    baseURL: '',
    responseType: 'blob',
  });
  return URL.createObjectURL(response.data);
}

export async function fetchContactAvatarBlob(deviceId: string, jid: string): Promise<Blob | null> {
  const response = await http.get<Blob>('/unified/avatar', {
    params: {deviceId, jid},
    responseType: 'blob',
  });
  if (response.status === 204 || !response.data || response.data.size === 0) {
    return null;
  }
  return response.data;
}

// Unified Inbox
export function listUnifiedChats(params: {
  deviceIds?: string[];
  search?: string;
  has_media?: boolean;
}): Promise<UnifiedChatsResponse> {
  return results(
    http.get('/unified/chats', {
      params: {
        deviceIds: params.deviceIds && params.deviceIds.length > 0 ? params.deviceIds.join(',') : undefined,
        search: params.search || undefined,
        has_media: params.has_media ? 'true' : undefined,
      },
    }),
  );
}

export function getUnifiedChatMessages(
  deviceId: string,
  chatJid: string,
  params: {limit?: number; offset?: number; search?: string; media_only?: boolean},
): Promise<{data: MessageInfo[]; pagination: Pagination; chat_info: ChatInfo}> {
  return results(
    http.get(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/messages`, {
      params: {
        limit: params.limit,
        offset: params.offset,
        search: params.search || undefined,
        media_only: params.media_only ? 'true' : undefined,
      },
    }),
  );
}

export function requestUnifiedChatHistory(
  deviceId: string,
  chatJid: string,
  count = 50,
): Promise<unknown> {
  return results(http.post(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/history`, {count}));
}

export function sendUnifiedTextMessage(
  deviceId: string,
  chatJid: string,
  message: string,
  replyMessageId?: string,
): Promise<{message_id: string; status: string}> {
  return results(
    http.post(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/send`, {
      message,
      ...(replyMessageId ? {reply_message_id: replyMessageId} : {}),
    }),
  );
}

export function sendUnifiedMessageReaction(
  deviceId: string,
  chatJid: string,
  messageId: string,
  emoji: string,
): Promise<unknown> {
  return results(
    http.post(
      `/unified/chats/${enc(deviceId)}/${enc(chatJid)}/messages/${enc(messageId)}/reaction`,
      {emoji},
    ),
  );
}

export function markUnifiedChatRead(
  deviceId: string,
  chatJid: string,
): Promise<{chat_jid: string; last_read_seq: number}> {
  return results(http.post(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/read`));
}

// Conversation Notes (per chat)
export async function listUnifiedChatNotes(
  deviceId: string,
  chatJid: string,
): Promise<{notes: ConversationNote[]; total: number}> {
  const res = await results<{notes: ConversationNote[]; total: number} | null>(
    http.get(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/notes`),
  );
  return {
    notes: res?.notes ?? [],
    total: res?.total ?? 0,
  };
}

export function createUnifiedChatNote(
  deviceId: string,
  chatJid: string,
  payload: {content: string; is_pinned?: boolean},
): Promise<ConversationNote> {
  return results(http.post(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/notes`, payload));
}

export function updateUnifiedChatNote(
  deviceId: string,
  chatJid: string,
  noteId: number,
  payload: {content?: string; is_pinned?: boolean},
): Promise<ConversationNote> {
  return results(
    http.patch(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/notes/${noteId}`, payload),
  );
}

export async function deleteUnifiedChatNote(
  deviceId: string,
  chatJid: string,
  noteId: number,
): Promise<void> {
  await http.delete(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/notes/${noteId}`);
}

// In-Chat Scheduled Messages
export async function listUnifiedChatSchedules(
  deviceId: string,
  chatJid: string,
  status?: string,
): Promise<ScheduleList> {
  const res = await results<ScheduleList | null>(
    http.get(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/schedules`, {
      params: {status: status && status !== 'all' ? status : undefined},
    }),
  );
  return {
    data: res?.data ?? [],
    pagination: res?.pagination ?? {limit: 100, offset: 0, total: 0},
  };
}

export function createUnifiedChatSchedule(
  deviceId: string,
  chatJid: string,
  payload: Omit<CreateSchedulePayload, 'phone'>,
): Promise<unknown> {
  return results(http.post(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/schedules`, payload));
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

export function downloadUnifiedMedia(
  deviceId: string,
  messageId: string,
  phone: string,
  fallbackUrl?: string,
): Promise<DownloadedMedia> {
  return results(
    http.get('/unified/media/download', {
      params: {
        deviceId,
        messageId,
        phone,
        fallbackUrl: fallbackUrl || undefined,
      },
    }),
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

// Groups (Admin, per-device)
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

// Misc: Newsletters (Channels) & Calls (Admin, per-device)
export async function listDeviceNewsletters(deviceId: string): Promise<NewsletterMetadata[]> {
  const res = await results<NewsletterMetadata[] | null>(
    http.get(`/devices/${enc(deviceId)}/newsletters`),
  );
  return res ?? [];
}

export async function followNewsletter(deviceId: string, newsletterId: string): Promise<void> {
  await http.post(`/devices/${enc(deviceId)}/newsletters/follow`, {newsletter_id: newsletterId});
}

export async function unfollowNewsletter(deviceId: string, newsletterId: string): Promise<void> {
  await http.post(`/devices/${enc(deviceId)}/newsletters/unfollow`, {newsletter_id: newsletterId});
}

export function getNewsletterInfo(
  deviceId: string,
  params: {newsletter_id?: string; invite?: string},
): Promise<NewsletterMetadata> {
  return results(http.get(`/devices/${enc(deviceId)}/newsletters/info`, {params}));
}

export async function searchNewsletterDirectory(
  deviceId: string,
  params: {
    view?: string;
    search_text?: string;
    country_codes?: string;
    categories?: string;
    cursor?: string;
    limit?: number;
  },
): Promise<DirectoryResponse> {
  const res = await results<DirectoryResponse | null>(
    http.get(`/devices/${enc(deviceId)}/newsletters/directory`, {params}),
  );
  return {
    data: res?.data ?? [],
    page_info: res?.page_info,
  };
}

export async function getNewsletterMessages(
  deviceId: string,
  newsletterId: string,
  count = 20,
  before?: number,
): Promise<NewsletterMessage[]> {
  const res = await results<NewsletterMessage[] | null>(
    http.get(`/devices/${enc(deviceId)}/newsletters/messages`, {
      params: {newsletter_id: newsletterId, count, before},
    }),
  );
  return res ?? [];
}

export async function getNewsletterMessageUpdates(
  deviceId: string,
  newsletterId: string,
  after = 1,
  count = 100,
): Promise<NewsletterMessage[]> {
  const res = await results<NewsletterMessage[] | null>(
    http.get(`/devices/${enc(deviceId)}/newsletters/message-updates`, {
      params: {newsletter_id: newsletterId, after, count},
    }),
  );
  return res ?? [];
}

export function downloadNewsletterMedia(
  deviceId: string,
  newsletterId: string,
  serverId: number,
): Promise<NewsletterMedia> {
  return results(
    http.get(`/devices/${enc(deviceId)}/newsletters/messages/${serverId}/download`, {
      params: {newsletter_id: newsletterId},
    }),
  );
}

export async function listNewsletterLiveUpdates(
  deviceId: string,
): Promise<LiveUpdatesSubscription[]> {
  const res = await results<LiveUpdatesSubscription[] | null>(
    http.get(`/devices/${enc(deviceId)}/newsletters/live-updates`),
  );
  return res ?? [];
}

export function subscribeNewsletterLiveUpdates(
  deviceId: string,
  newsletterId: string,
): Promise<LiveUpdatesSubscription> {
  return results(
    http.post(`/devices/${enc(deviceId)}/newsletters/live-updates`, {
      newsletter_id: newsletterId,
    }),
  );
}

export async function unsubscribeNewsletterLiveUpdates(
  deviceId: string,
  newsletterId: string,
): Promise<void> {
  await http.delete(`/devices/${enc(deviceId)}/newsletters/live-updates`, {
    params: {newsletter_id: newsletterId},
  });
}

export async function rejectCall(
  deviceId: string,
  payload: {caller_jid: string; call_id: string},
): Promise<void> {
  await http.post(`/devices/${enc(deviceId)}/call/reject`, payload);
}
