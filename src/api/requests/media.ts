import {http, results} from '@/lib/http';
import type {DownloadedMedia} from '@/api/contracts/chats';

export async function fetchAuthorizedBlobUrl(urlPath: string): Promise<string> {
  const response = await http.get<Blob>(urlPath, {
    baseURL: '',
    responseType: 'blob',
  });
  return URL.createObjectURL(response.data);
}

export async function fetchContactAvatarBlob(deviceId: string, jid: string): Promise<Blob | null> {
  const response = await http.get<Blob>('/unified/avatar', {
    params: {deviceId, jid},
    responseType: 'blob',
  });
  if (response.status === 204 || !response.data || response.data.size === 0) {
    return null;
  }
  return response.data;
}

export function downloadUnifiedMedia(
  deviceId: string,
  messageId: string,
  phone: string,
  signal?: AbortSignal,
): Promise<DownloadedMedia> {
  return results(
    http.get('/unified/media/download', {
      params: {
        deviceId,
        messageId,
        phone,
      },
      signal,
    }),
  );
}

export async function downloadUnifiedMediaThumbnail(
  deviceId: string,
  messageId: string,
  phone: string,
  signal?: AbortSignal,
): Promise<{bytes: Uint8Array<ArrayBuffer>; contentType: string}> {
  const params = new URLSearchParams({deviceId, messageId, phone});
  return fetchAuthorizedMediaBytes(`/api/unified/media/thumbnail?${params}`, signal);
}

export async function fetchAuthorizedMediaBytes(
  urlPath: string,
  signal?: AbortSignal,
): Promise<{bytes: Uint8Array<ArrayBuffer>; contentType: string}> {
  const response = await http.get<ArrayBuffer>(urlPath, {
    baseURL: '',
    responseType: 'arraybuffer',
    signal,
  });
  const contentTypeHeader = response.headers['content-type'];
  const contentType =
    typeof contentTypeHeader === 'string'
      ? contentTypeHeader.split(';')[0].trim().toLowerCase()
      : 'application/octet-stream';
  return {
    bytes: new Uint8Array(response.data),
    contentType,
  };
}
