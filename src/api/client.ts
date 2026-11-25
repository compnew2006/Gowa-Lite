import {http, results} from '@/lib/http';
import type {
  AccountCloseRatings,
  AccountContact,
  AccountSummary,
  AssignableAccountSummary,
  AssignableAccountsCatalog,
  AssignableAgent,
  AuthStatus,
  AvatarResponse,
  BulkLifecycleResponse,
  BusinessProfileResponse,
  ChatAssignmentInfo,
  ChatInfo,
  ChatLifecycleEvent,
  ChatLifecycleResponse,
  ChatListSummary,
  ChatRedactionReason,
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
  InboxPolicy,
  LanguagePreference,
  LiveUpdatesSubscription,
  LoginQr,
  MessageInfo,
  MuteDuration,
  MyGroup,
  NewsletterMedia,
  NewsletterMessage,
  NewsletterMetadata,
  Pagination,
  PairCode,
  ParticipantRequestEntry,
  ParticipantStatus,
  PermissionGroup,
  PrivacyResponse,
  RegistryDevice,
  RoleRecord,
  ScheduleList,
  ThemePreference,
  UnifiedChatTab,
  UnifiedChatsResponse,
  UnifiedGroupsResponse,
  UnifiedStatusesResponse,
  User,
  UserCreatePayload,
  UserInfoResponse,
  UserUpdatePayload,
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

// Users & RBAC Roles
export function listUsers(): Promise<User[]> {
  return results(http.get('/users'));
}

export function createUser(payload: UserCreatePayload): Promise<User> {
  return results(http.post('/users', payload));
}

export function updateUser(id: number, payload: UserUpdatePayload): Promise<User> {
  return results(http.patch(`/users/${id}`, payload));
}

export async function deleteUser(id: number): Promise<void> {
  await http.delete(`/users/${id}`);
}

export function listPermissions(): Promise<PermissionGroup[]> {
  return results(http.get('/permissions'));
}

export function listRoles(): Promise<RoleRecord[]> {
  return results(http.get('/roles'));
}

export function createRole(payload: {
  name: string;
  description?: string;
  permissions: string[];
  is_default?: boolean;
}): Promise<RoleRecord> {
  return results(http.post('/roles', payload));
}

export function updateRole(
  id: number,
  payload: {
    name?: string;
    description?: string;
    permissions?: string[];
    is_default?: boolean;
  },
): Promise<RoleRecord> {
  return results(http.patch(`/roles/${id}`, payload));
}

export async function deleteRole(id: number): Promise<void> {
  await http.delete(`/roles/${id}`);
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

export function getInboxPolicy(): Promise<InboxPolicy> {
  return results(http.get('/settings/inbox-policy'));
}

export function saveInboxPolicy(payload: Partial<InboxPolicy>): Promise<InboxPolicy> {
  return results(http.put('/settings/inbox-policy', payload));
}

// Accounts / Devices
export function getAccountCloseRatings(deviceId: string): Promise<AccountCloseRatings> {
  return results(http.get(`/devices/${enc(deviceId)}/close-ratings`));
}

export function saveAccountCloseRatings(deviceId: string, enabled: boolean): Promise<AccountCloseRatings> {
  return results(http.put(`/devices/${enc(deviceId)}/close-ratings`, {enabled}));
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
export const DEFAULT_UNIFIED_CHATS_QUERY_KEY = ['unified-chats', [], '', false] as const;

export function listUnifiedChats(params: {
  deviceIds?: string[];
  search?: string;
  has_media?: boolean;
  tab?: UnifiedChatTab;
  assignedTo?: string | number;
  limit?: number;
  offset?: number;
}): Promise<UnifiedChatsResponse> {
  return results(
    http.get('/unified/chats', {
      params: {
        deviceIds: params.deviceIds && params.deviceIds.length > 0 ? params.deviceIds.join(',') : undefined,
        search: params.search || undefined,
        has_media: params.has_media ? 'true' : undefined,
        tab: params.tab || undefined,
        assignedTo:
          params.assignedTo !== undefined && params.assignedTo !== ''
            ? String(params.assignedTo)
            : undefined,
        limit: params.limit,
        offset: params.offset,
      },
    }),
  );
}

export function getUnifiedChatMessages(
  deviceId: string,
  chatJid: string,
  params: {limit?: number; offset?: number; search?: string; media_only?: boolean},
  signal?: AbortSignal,
): Promise<{
  data: MessageInfo[];
  pagination: Pagination;
  chat_info: ChatInfo;
  content_redacted?: boolean;
  redaction_reason?: ChatRedactionReason;
  reaction_webhook_configured?: boolean;
}> {
  return results(
    http.get(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/messages`, {
      signal,
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

export async function sendUnifiedMediaMessage(
  deviceId: string,
  chatJid: string,
  payload: {file: File; caption?: string},
): Promise<{message_id: string; status: string}> {
  const buffer = await payload.file.arrayBuffer();
  const caption = payload.caption?.trim();
  return results(
    http.post(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/send-media`, buffer, {
      timeout: 60_000,
      headers: {
        'Content-Type': 'application/octet-stream',
      },
      params: {
        filename: payload.file.name || 'attachment',
        mimeType: payload.file.type || 'application/octet-stream',
        ...(caption ? {caption} : {}),
      },
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

export function revokeUnifiedMessage(
  deviceId: string,
  chatJid: string,
  messageId: string,
): Promise<unknown> {
  return results(
    http.post(
      `/unified/chats/${enc(deviceId)}/${enc(chatJid)}/messages/${enc(messageId)}/revoke`,
    ),
  );
}

export function forwardUnifiedMessage(
  deviceId: string,
  chatJid: string,
  messageId: string,
  payload: {
    target_device_id: string;
    target_jid: string;
    content?: string;
    media_type?: string;
    filename?: string;
    url?: string;
  },
): Promise<{message_id?: string; target_device_id: string; target_jid: string}> {
  return results(
    http.post(
      `/unified/chats/${enc(deviceId)}/${enc(chatJid)}/messages/${enc(messageId)}/forward`,
      payload,
    ),
  );
}

export function markUnifiedChatRead(
  deviceId: string,
  chatJid: string,
): Promise<{chat_jid: string; last_read_seq: number}> {
  return results(http.post(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/read`));
}

// Chat Row Menu Actions & Custom Lists
export function archiveUnifiedChat(
  deviceId: string,
  chatJid: string,
  archived: boolean,
): Promise<{chat_jid: string; archived: boolean; synced_remote: boolean}> {
  return results(http.post(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/archive`, {archived}));
}

export function pinUnifiedChat(
  deviceId: string,
  chatJid: string,
  pinned: boolean,
): Promise<{chat_jid: string; is_pinned: boolean; pinned_at_ms: number; synced_remote: boolean}> {
  return results(http.post(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/pin`, {pinned}));
}

export function muteUnifiedChat(
  deviceId: string,
  chatJid: string,
  duration: MuteDuration,
): Promise<{chat_jid: string; muted_until_ms: number}> {
  return results(http.post(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/mute`, {duration}));
}

export function setUnifiedChatUnread(
  deviceId: string,
  chatJid: string,
  unread: boolean,
): Promise<{chat_jid: string; unread: boolean}> {
  return results(http.post(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/unread`, {unread}));
}

export function favouriteUnifiedChat(
  deviceId: string,
  chatJid: string,
  favourite: boolean,
): Promise<{chat_jid: string; is_favourite: boolean}> {
  return results(
    http.post(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/favourite`, {favourite}),
  );
}

export function blockUnifiedChat(
  deviceId: string,
  chatJid: string,
  blocked: boolean,
): Promise<{chat_jid: string; is_blocked: boolean}> {
  return results(http.post(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/block`, {blocked}));
}

export function clearUnifiedChat(
  deviceId: string,
  chatJid: string,
): Promise<{chat_jid: string; cleared_before_ms: number; deleted_messages: number}> {
  return results(http.post(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/clear`));
}

export function deleteUnifiedChat(
  deviceId: string,
  chatJid: string,
): Promise<{chat_jid: string; deleted_before_ms: number}> {
  return results(http.post(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/delete`));
}

export async function listChatLists(): Promise<ChatListSummary[]> {
  const res = await results<ChatListSummary[] | null>(http.get('/unified/chat-lists'));
  return res ?? [];
}

export function createChatList(name: string): Promise<ChatListSummary> {
  return results(http.post('/unified/chat-lists', {name}));
}

export async function deleteChatList(listId: number): Promise<void> {
  await http.delete(`/unified/chat-lists/${listId}`);
}

export function assignUnifiedChatLists(
  deviceId: string,
  chatJid: string,
  listIds: number[],
): Promise<{chat_jid: string; list_ids: number[]}> {
  return results(
    http.put(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/lists`, {list_ids: listIds}),
  );
}

// Chat Lifecycle & Assignment
export async function listAssignableAgents(deviceId: string): Promise<AssignableAgent[]> {
  const res = await results<AssignableAgent[] | null>(
    http.get('/unified/assignable-agents', {params: {deviceId}}),
  );
  return res ?? [];
}

export function getChatLifecycle(deviceId: string, chatJid: string): Promise<ChatLifecycleResponse> {
  return results(http.get(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/lifecycle`));
}

export function claimUnifiedChat(
  deviceId: string,
  chatJid: string,
  cachedTitle?: string,
): Promise<{assignment: ChatAssignmentInfo; event: ChatLifecycleEvent}> {
  return results(
    http.post(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/claim`, {
      ...(cachedTitle ? {cached_title: cachedTitle} : {}),
    }),
  );
}

export function assignUnifiedChat(
  deviceId: string,
  chatJid: string,
  payload: {assigned_user_id: number | null; note?: string; cached_title?: string},
): Promise<{assignment: ChatAssignmentInfo; event?: ChatLifecycleEvent}> {
  return results(http.post(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/assign`, payload));
}

export function releaseUnifiedChat(
  deviceId: string,
  chatJid: string,
  payload?: {note?: string; cached_title?: string},
): Promise<{assignment: ChatAssignmentInfo; event?: ChatLifecycleEvent}> {
  return results(
    http.post(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/release`, payload ?? {}),
  );
}

export function closeUnifiedChat(
  deviceId: string,
  chatJid: string,
  payload?: {reason?: string; cached_title?: string},
): Promise<{assignment: ChatAssignmentInfo; event?: ChatLifecycleEvent; rating_prompt?: 'sent' | 'failed'}> {
  return results(
    http.post(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/close`, payload ?? {}),
  );
}

export function reopenUnifiedChat(
  deviceId: string,
  chatJid: string,
  payload?: {assign_to_self?: boolean; note?: string; cached_title?: string},
): Promise<{assignment: ChatAssignmentInfo; event?: ChatLifecycleEvent}> {
  return results(
    http.post(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/reopen`, payload ?? {}),
  );
}

export function bulkUnifiedChatsLifecycle(payload: {
  items: Array<{device_id: string; chat_jid: string; cached_title?: string}>;
  action: 'close' | 'release' | 'assign' | 'reopen';
  assigned_user_id?: number | null;
  note?: string;
  reason?: string;
}): Promise<BulkLifecycleResponse> {
  return results(http.post('/unified/chats/bulk-lifecycle', payload));
}

// Conversation Notes (per chat)
export async function listUnifiedChatNotes(
  deviceId: string,
  chatJid: string,
): Promise<{
  notes: ConversationNote[];
  total: number;
  content_redacted?: boolean;
  redaction_reason?: ChatRedactionReason;
}> {
  const res = await results<{
    notes: ConversationNote[];
    total: number;
    content_redacted?: boolean;
    redaction_reason?: ChatRedactionReason;
  } | null>(http.get(`/unified/chats/${enc(deviceId)}/${enc(chatJid)}/notes`));
  return {
    notes: res?.notes ?? [],
    total: res?.total ?? 0,
    content_redacted: res?.content_redacted,
    redaction_reason: res?.redaction_reason,
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
  signal?: AbortSignal,
): Promise<DownloadedMedia> {
  return results(
    http.get('/unified/media/download', {
      params: {
        deviceId,
        messageId,
        phone,
        fallbackUrl: fallbackUrl || undefined,
      },
      signal,
    }),
  );
}

export async function fetchAuthorizedMediaBytes(
  urlPath: string,
  signal?: AbortSignal,
): Promise<{bytes: Uint8Array<ArrayBuffer>; contentType: string}> {
  const response = await http.get<ArrayBuffer>(urlPath, {
    baseURL: '',
    responseType: 'arraybuffer',
    signal,
  });
  const contentTypeHeader = response.headers['content-type'];
  const contentType =
    typeof contentTypeHeader === 'string'
      ? contentTypeHeader.split(';')[0].trim().toLowerCase()
      : 'application/octet-stream';
  return {
    bytes: new Uint8Array(response.data),
    contentType,
  };
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

function unwrapArrayPayload<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === 'object') {
    const obj = raw as {data?: unknown; messages?: unknown; items?: unknown};
    if (Array.isArray(obj.data)) return obj.data as T[];
    if (Array.isArray(obj.messages)) return obj.messages as T[];
    if (Array.isArray(obj.items)) return obj.items as T[];
  }
  return [];
}

// Misc: Newsletters (Channels) & Calls (Admin, per-device)
export async function listDeviceNewsletters(deviceId: string): Promise<NewsletterMetadata[]> {
  const res = await results<unknown>(http.get(`/devices/${enc(deviceId)}/newsletters`));
  return unwrapArrayPayload<NewsletterMetadata>(res);
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
  const res = await results<unknown>(
    http.get(`/devices/${enc(deviceId)}/newsletters/messages`, {
      params: {newsletter_id: newsletterId, count, before},
    }),
  );
  return unwrapArrayPayload<NewsletterMessage>(res);
}

export async function getNewsletterMessageUpdates(
  deviceId: string,
  newsletterId: string,
  after = 1,
  count = 100,
): Promise<NewsletterMessage[]> {
  const res = await results<unknown>(
    http.get(`/devices/${enc(deviceId)}/newsletters/message-updates`, {
      params: {newsletter_id: newsletterId, after, count},
    }),
  );
  return unwrapArrayPayload<NewsletterMessage>(res);
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
  const res = await results<unknown>(
    http.get(`/devices/${enc(deviceId)}/newsletters/live-updates`),
  );
  return unwrapArrayPayload<LiveUpdatesSubscription>(res);
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

export async function listMiscStatuses(deviceIds?: string[]): Promise<UnifiedStatusesResponse> {
  const res = await results<UnifiedStatusesResponse | null>(
    http.get('/misc/statuses', {
      params:
        deviceIds && deviceIds.length > 0 ? {deviceIds: deviceIds.join(',')} : undefined,
    }),
  );
  return (
    res ?? {
      data: [],
      accounts: [],
      device_errors: [],
    }
  );
}
