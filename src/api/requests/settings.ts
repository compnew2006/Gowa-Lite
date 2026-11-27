import {http, results} from '@/lib/http';
import type {GowaProbeResult, GowaSettings} from '@/api/contracts/accounts';
import type {InboxPolicy} from '@/api/contracts/workflow';

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
