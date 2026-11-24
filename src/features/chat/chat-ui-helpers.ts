import type {UnifiedChatTab} from '@/api/types';

export function formatSecondaryChatPhone(displayName: string, phone: string): string | null {
  const cleanPhone = phone.trim();
  if (!cleanPhone) return null;
  if (cleanPhone === displayName.trim()) return null;
  return cleanPhone;
}

export function shouldShowAccountFilter(
  accountsCount: number,
  selectedDeviceIdsCount: number,
): boolean {
  return accountsCount > 1 || selectedDeviceIdsCount > 0;
}

export function shouldShowRowAccountName(accountsCount: number): boolean {
  return accountsCount > 1;
}

export function shouldShowRowLifecycle(
  activeTab: UnifiedChatTab | undefined,
  status: string,
): boolean {
  if (activeTab === 'pending' && status === 'pending') return false;
  if (activeTab === 'closed' && status === 'closed') return false;
  return true;
}

export function shouldShowNavUnreadBadge(
  isOnChatsRoute: boolean,
  totalUnread: number,
): boolean {
  return !isOnChatsRoute && totalUnread > 0;
}

export function formatNavUnreadCount(totalUnread: number): string {
  if (!Number.isFinite(totalUnread) || totalUnread <= 0) return '0';
  return String(Math.floor(totalUnread));
}
