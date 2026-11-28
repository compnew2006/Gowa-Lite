import type {ChatAssignmentSummary} from '@/api/contracts/chats';

export type UnassignedReplyPolicy = 'auto_claim' | 'allow_without_claim' | 'require_claim';
export type ClosedReplyPolicy = 'block' | 'reopen_and_claim';

export interface InboxPolicy {
  unassigned_reply_policy: UnassignedReplyPolicy;
  closed_reply_policy: ClosedReplyPolicy;
}

export interface AccountCloseRatings {
  enabled: boolean;
  webhook_configured: boolean;
  prompt_message: string;
  default_prompt: string;
  is_custom_prompt: boolean;
  count: number;
  average: number | null;
  by_user: {
    user_id: number | null;
    user_name: string;
    count: number;
    average: number;
  }[];
  recent: {
    id: number;
    score: number;
    rated_at: string;
    chat_jid: string;
    user_id: number | null;
    user_name: string;
  }[];
}

export interface UserRatingSummary {
  user_id: number;
  count: number;
  average: number | null;
}

export interface UserCloseRatings {
  user_id: number;
  display_name: string;
  count: number;
  average: number | null;
  by_account: {
    device_id: string;
    device_name: string;
    count: number;
    average: number;
  }[];
  recent: {
    id: number;
    score: number;
    rated_at: string;
    device_id: string;
    device_name: string;
    chat_jid: string;
  }[];
}

export interface AccountDailyResetSettings {
  device_id: string;
  enabled: boolean;
  reset_hour: number;
  timezone: string;
  last_run_date: string;
  last_run_at: string | null;
  last_reset_count: number;
  updated_at: string | null;
}

export interface DailyResetRunResult {
  device_id: string;
  reset_count: number;
  chat_jids: string[];
  run_at: string;
  run_date: string;
  trigger: 'schedule' | 'manual';
}

export type ChatLifecycleEventType =
  | 'claimed'
  | 'auto_claimed'
  | 'assigned'
  | 'transferred'
  | 'released'
  | 'closed'
  | 'reopened'
  | 'reopened_by_customer'
  // P2-11: action system lines (recorded server-side at the action).
  | 'note_added'
  | 'note_edited'
  | 'note_deleted'
  | 'schedule_created'
  | 'schedule_paused'
  | 'schedule_resumed'
  | 'schedule_cancelled'
  | 'message_revoked'
  | 'message_edited'
  | 'rating_submitted';

export interface ChatAssignmentInfo extends ChatAssignmentSummary {
  device_id: string;
  chat_jid: string;
  assigned_at: string | null;
  claimed_at: string | null;
  cached_title: string;
  last_activity_ms: number;
  updated_at: number;
}

export interface ChatLifecycleEvent {
  id: number;
  device_id: string;
  chat_jid: string;
  event_type: ChatLifecycleEventType;
  actor_user_id: number | null;
  actor_name: string;
  target_user_id: number | null;
  target_name: string;
  note: string;
  created_at: string;
  created_at_ms: number;
}

export interface ChatLifecycleResponse {
  assignment: ChatAssignmentInfo;
  events: ChatLifecycleEvent[];
}

export interface AssignableAgent {
  id: number;
  username: string;
  display_name: string;
  role_slug: string;
  role_name: string;
  open_chat_count: number;
}

export interface BulkLifecycleResponse {
  succeeded: ChatAssignmentInfo[];
  failed: Array<{device_id: string; chat_jid: string; code: string; message: string}>;
}
