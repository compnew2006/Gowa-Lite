export interface ResponseData<T> {
  code: string;
  message: string;
  results?: T;
}

export interface ApiError {
  status: number;
  code: string;
  message: string;
}

export type UserRole = 'admin' | 'agent';
export type ThemePreference = 'light' | 'dark' | 'system';
export type LanguagePreference = 'ar' | 'en';

export interface User {
  id: number;
  username: string;
  display_name: string;
  role: UserRole;
  is_active: boolean;
  created_at: string;
  theme: ThemePreference;
  language: LanguagePreference;
}

export interface AuthStatus {
  initialized: boolean;
  authenticated: boolean;
  user: User | null;
  gowaConfigured: boolean;
}

export type DeviceState = 'disconnected' | 'connecting' | 'connected' | 'logged_in';

export interface RegistryDevice {
  id: string;
  phone_number?: string;
  display_name?: string;
  alias?: string;
  resolved_name?: string;
  state: DeviceState;
  jid?: string;
  created_at: string;
}

export interface AccountSummary {
  id: string;
  display_name: string;
  phone_number: string | null;
  state: DeviceState;
}

export interface LoginQr {
  device_id: string;
  qr_link: string;
  qr_duration: number;
}

export interface PairCode {
  device_id: string;
  pair_code: string;
}

export interface DeviceStatus {
  device_id: string;
  is_connected: boolean;
  is_logged_in: boolean;
}

export interface GowaSettings {
  gowa_url: string;
  gowa_username: string;
  has_password: boolean;
}

export interface GowaProbeResult {
  ok: boolean;
  devicesCount: number;
  error?: string;
  code?: string;
  info?: {
    version: string;
    os: string;
    base_path: string;
    max_file_size: number;
    max_video_size: number;
    max_image_size: number;
  };
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  ephemeral_expiration: number;
  created_at: string;
  updated_at: string;
  archived: boolean;
}

export interface UnifiedChat extends ChatInfo {
  device_id: string;
  device_display_name: string;
  device_state: DeviceState;
}

export interface UnifiedChatsResponse {
  data: UnifiedChat[];
  total: number;
  accounts: AccountSummary[];
  device_errors: Array<{
    device_id: string;
    display_name: string;
    message: string;
  }>;
}

export interface ReactionInfo {
  emoji: string;
  sender_jid: string;
  sender_display_name?: string;
  is_from_me: boolean;
  timestamp: string;
}

export interface MessageInfo {
  id: string;
  chat_jid: string;
  sender_jid: string;
  sender_display_name?: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  media_type: string;
  reactions?: ReactionInfo[];
  context_metadata?: string;
  filename: string;
  url: string;
  file_length: number;
}

export interface Pagination {
  limit: number;
  offset: number;
  total: number;
}

export interface DownloadedMedia {
  message_id: string;
  media_type: string;
  filename: string;
  file_path: string;
  file_url?: string;
  file_size: number;
}

export interface ImageUploadPayload {
  filename: string;
  mimeType: string;
  dataBase64: string;
}

// Scheduled Sends
export type ScheduleStatus =
  | 'active'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ScheduleRecurrence = 'once' | 'daily' | 'weekly' | 'monthly';

export interface ScheduledSend {
  id: string;
  message_type: string;
  recipient: string;
  content?: string;
  caption?: string;
  filename?: string;
  scheduled_at: string;
  timezone: string;
  recurrence: ScheduleRecurrence | string;
  weekdays?: number[];
  day_of_month?: number;
  end_at?: string;
  occurrence_limit?: number;
  occurrence_count: number;
  status: ScheduleStatus;
  next_run_at?: string;
  last_run_at?: string;
  last_error?: string;
  created_at: string;
  updated_at: string;
}

export interface ScheduleList {
  data: ScheduledSend[];
  pagination: Pagination;
}

export interface CreateSchedulePayload {
  phone: string;
  message: string;
  scheduled_at: string;
  timezone?: string;
  recurrence: ScheduleRecurrence;
  weekdays?: number[];
  day_of_month?: number;
  end_at?: string;
  occurrence_limit?: number;
}

// Groups
export interface GroupParticipant {
  JID: string;
  PhoneNumber?: string;
  LID?: string;
  DisplayName?: string;
  IsAdmin: boolean;
  IsSuperAdmin: boolean;
}

export interface MyGroup {
  JID: string;
  OwnerJID?: string;
  Name: string;
  Topic?: string;
  IsLocked?: boolean;
  IsAnnounce?: boolean;
  IsEphemeral?: boolean;
  IsJoinApprovalRequired?: boolean;
  GroupCreated?: string;
  ParticipantCount?: number;
  Participants?: GroupParticipant[];
}

export interface GroupParticipantsResult {
  group_id: string;
  name: string;
  participants: Array<{
    jid: string;
    phone_number: string;
    display_name: string;
    is_admin: boolean;
    is_super_admin: boolean;
  }>;
}

export interface ParticipantRequestEntry {
  jid: string;
  phone_number: string;
  display_name: string;
  requested_at: string;
}

export interface ParticipantStatus {
  participant: string;
  status: string;
  message: string;
}

export interface GroupInfoFromLink {
  group_id: string;
  name: string;
  topic?: string;
  created_at?: string;
  participant_count: number;
  is_locked: boolean;
  is_announce: boolean;
  is_ephemeral?: boolean;
  description?: string;
}

export interface GroupInviteLink {
  invite_link: string;
  group_id: string;
}

// Account Profile & Lookups
export type PrivacyResponse = Record<string, string | undefined>;

export interface AccountContact {
  jid: string;
  name: string;
}

export interface UserInfoResponse {
  verified_name?: string;
  status?: string;
  picture_id?: string;
  devices?: Array<{
    Device: string;
    DeviceID: number;
    DomainType?: number;
    Index?: number;
  }>;
}

export interface AvatarResponse {
  url: string;
  id: string;
  type: string;
}

export interface CheckResponse {
  is_on_whatsapp: boolean;
}

export interface BusinessProfileResponse {
  jid: string;
  email?: string;
  address?: string;
  categories?: Array<{id: string; name: string}>;
  profile_options?: Record<string, string>;
  business_hours_timezone?: string;
  business_hours?: Array<{
    day_of_week: string;
    mode: string;
    open_time: string;
    close_time: string;
  }>;
}

// Misc: Newsletters (Channels) & Calls
export interface NewsletterMetadata {
  id: string;
  state?: {type: string};
  thread_metadata?: {
    creation_time?: string;
    invite?: string;
    name?: {text?: string; id?: string; update_time?: string};
    description?: {text?: string; id?: string; update_time?: string};
    subscribers_count?: number;
    verification?: string;
    picture?: {url?: string; direct_path?: string; id?: string; type?: string};
    preview?: {url?: string; direct_path?: string; id?: string; type?: string};
  };
  viewer_metadata?: {
    mute?: string;
    role?: string;
  };
}

export interface NewsletterMessage {
  message_server_id: number;
  message_id: string;
  type: string;
  timestamp: string;
  views_count: number;
  reaction_counts?: Record<string, number>;
  message?: Record<string, unknown>;
}

export interface DirectoryResponse {
  data: NewsletterMetadata[];
  page_info?: {
    has_next_page: boolean;
    end_cursor: string;
  };
}

export interface LiveUpdatesSubscription {
  jid: string;
  expires_at: string;
  is_active?: boolean;
}

export interface NewsletterMedia {
  media_type?: string;
  file_path?: string;
  file_url?: string;
  filename?: string;
  mime_type?: string;
  file_size?: number;
}

