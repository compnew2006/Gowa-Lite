import type {DeviceState} from '@/api/contracts/accounts';

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
  proxy_url: string;
  media_type?: string;
  file_path?: string;
  file_url?: string;
  filename?: string;
  mime_type?: string;
  file_size?: number;
}

export interface UnifiedStatusAccountSummary {
  id: string;
  display_name: string;
  phone_number?: string;
  state: DeviceState;
  status_count: number;
}

export interface UnifiedStatusItem {
  id: string;
  chat_jid: string;
  sender_jid: string;
  sender_display_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  media_type: string;
  filename: string;
  url: string;
  file_length: number;
  device_id: string;
  device_display_name: string;
  device_state: DeviceState;
}

export interface UnifiedStatusesResponse {
  data: UnifiedStatusItem[];
  accounts: UnifiedStatusAccountSummary[];
  device_errors: Array<{device_id: string; display_name: string; message: string}>;
}
