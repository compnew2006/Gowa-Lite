import type {AccountSummary, DeviceState} from '@/api/contracts/accounts';

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  ephemeral_expiration: number;
  created_at: string;
  updated_at: string;
  archived: boolean;
}

export type ChatLifecycleStatus = 'pending' | 'open' | 'closed';

export type ChatRedactionReason = 'pending' | 'closed' | 'assigned_other';

export interface ChatAssignmentSummary {
  status: ChatLifecycleStatus;
  assigned_user_id: number | null;
  assigned_user_name: string | null;
  closed_by_id: number | null;
  closed_by_name: string | null;
  closed_at: string | null;
  close_reason: string;
}

export type MuteDuration = '8h' | '1w' | 'always' | 'unmute';

export interface ChatListSummary {
  id: number;
  name: string;
  chat_count: number;
  created_at: string;
  updated_at: string;
}

export interface UnifiedChat extends ChatInfo {
  device_id: string;
  device_display_name: string;
  device_state: DeviceState;
  has_messages?: boolean;
  unread_count?: number;
  lifecycle?: ChatAssignmentSummary;
  is_pinned?: boolean;
  pinned_at_ms?: number;
  is_blocked?: boolean;
  is_favourite?: boolean;
  muted_until_ms?: number;
  list_ids?: number[];
}

export interface UnifiedChatsPagination {
  limit: number;
  offset: number;
  total: number;
  has_more: boolean;
  next_offset?: number;
}

export type UnifiedChatTab = 'all' | 'me' | 'open' | 'pending' | 'closed';

export interface UnifiedTabCounts {
  all: number;
  me: number;
  open: number;
  pending: number;
  closed: number;
}

export interface UnifiedChatsResponse {
  data: UnifiedChat[];
  total: number;
  pagination?: UnifiedChatsPagination;
  tab_counts?: UnifiedTabCounts;
  total_unread?: number;
  muted_keys?: string[];
  chat_lists?: ChatListSummary[];
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
  is_revoked?: boolean;
  revoked_at?: string;
  revoked_by?: string;
}

export interface ConversationNote {
  id: number;
  device_id: string;
  chat_jid: string;
  created_by_id: number;
  created_by_name: string;
  content: string;
  is_pinned: boolean;
  created_at: string;
  updated_at: string;
}

export interface Pagination {
  limit: number;
  offset: number;
  total: number;
  live_total?: number;
  raw_count?: number;
  next_offset?: number;
}

export interface DownloadedMedia {
  proxy_url: string;
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
