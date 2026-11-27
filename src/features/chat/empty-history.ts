export type EmptyHistoryStatus = 'idle' | 'loading' | 'empty' | 'error';

export function isNoHistoryOnPhoneError(status: number, message: string): boolean {
  if (status !== 400 && status !== 404) return false;
  return /no stored messages|nothing to anchor|no history|not found|لا يوجد سجل/i.test(message);
}

export function shouldTriggerAutoHistoryFetch(params: {
  isSuccess: boolean;
  isFetching: boolean;
  isContentRedacted: boolean;
  hasSearchOrMediaFilter: boolean;
  isDeviceReady: boolean;
  messageCount: number;
  currentTriggerKey: string;
  lastTriggeredKey: string | null;
}): boolean {
  if (!params.isSuccess || params.isFetching) return false;
  if (params.isContentRedacted) return false;
  if (params.hasSearchOrMediaFilter) return false;
  if (!params.isDeviceReady) return false;
  if (params.messageCount > 0) return false;
  return params.currentTriggerKey !== params.lastTriggeredKey;
}
