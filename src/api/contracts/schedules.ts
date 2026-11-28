import type {ChatRedactionReason, Pagination} from '@/api/contracts/chats';

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
  phone?: string;
  to?: string;
  content?: string;
  message?: string;
  summary?: string;
  caption?: string;
  filename?: string;
  can_manage?: boolean;
  device_id?: string;
  device_name?: string;
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
  content_redacted?: boolean;
  redaction_reason?: ChatRedactionReason;
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
