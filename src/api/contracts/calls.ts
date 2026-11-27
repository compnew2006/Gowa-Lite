export type CallRejectStatus = 'pending' | 'rejected' | 'already_rejected' | 'failed';
export type CallReplyStatus = 'pending' | 'sent' | 'failed' | 'no_message' | 'skipped';

export interface CallAutoRejectLog {
  device_id: string;
  call_id: string;
  caller_jid: string;
  caller_name: string;
  reject_status: CallRejectStatus;
  reply_status: CallReplyStatus;
  reply_message: string;
  created_at: string;
}

export interface CallAutoRejectSettings {
  device_id: string;
  enabled: boolean;
  webhook_configured: boolean;
  reply_message: string;
  default_message: string;
  is_custom_message: boolean;
  recent: CallAutoRejectLog[];
}
