import {http, results} from '@/lib/http';
import type {
  DirectoryResponse,
  LiveUpdatesSubscription,
  NewsletterMedia,
  NewsletterMessage,
  NewsletterMetadata,
} from '@/api/contracts/misc';

const enc = encodeURIComponent;

// Misc: Newsletters (Channels) & Calls (Admin, per-device)
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
