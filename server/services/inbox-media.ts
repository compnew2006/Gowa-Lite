import {
  getCachedAvatar,
  getCachedMessage,
  upsertCachedAvatar,
  type CachedAvatarRow,
} from '../db.ts';
import {
  fetchPublicAvatarImage,
  GowaError,
  gowaFetch,
  type GowaAvatarInfo,
  type GowaDownloadedMedia,
  type GowaMessageInfo,
} from '../gowa-client.ts';
import {normalizeSearchQuery, normalizeWhatsAppJid} from './chat-sync.ts';

const MEDIA_RESOLVE_TTL_MS = 5 * 60_000;
const MAX_MEDIA_RESOLVE_ENTRIES = 500;
const AVATAR_OK_TTL_MS = 1000 * 60 * 60 * 24;
const AVATAR_NONE_TTL_MS = 1000 * 60 * 60;

export interface CachedMediaResolution {
  filePath: string;
  mediaType: string;
  filename: string;
  fileSize: number;
  downloaded: GowaDownloadedMedia | null;
  expiresAt: number;
}

const mediaResolveCache = new Map<string, CachedMediaResolution>();
const mediaResolveInflight = new Map<string, Promise<CachedMediaResolution>>();
const avatarInflight = new Map<string, Promise<CachedAvatarRow | null>>();

function readCachedMediaResolution(key: string): CachedMediaResolution | null {
  const entry = mediaResolveCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    mediaResolveCache.delete(key);
    return null;
  }
  mediaResolveCache.delete(key);
  mediaResolveCache.set(key, entry);
  return entry;
}

function writeCachedMediaResolution(key: string, entry: CachedMediaResolution): void {
  if (mediaResolveCache.has(key)) mediaResolveCache.delete(key);
  while (mediaResolveCache.size >= MAX_MEDIA_RESOLVE_ENTRIES) {
    const oldestKey = mediaResolveCache.keys().next().value;
    if (!oldestKey) break;
    mediaResolveCache.delete(oldestKey);
  }
  mediaResolveCache.set(key, entry);
}

export async function resolveChatMediaDownload(
  deviceId: string,
  phone: string,
  messageId: string,
): Promise<CachedMediaResolution> {
  const normalizedChatJid = normalizeWhatsAppJid(phone) || phone;
  const cached = getCachedMessage(deviceId, normalizedChatJid, messageId);
  if (cached?.is_revoked) {
    throw new GowaError(404, 'MEDIA_NOT_AVAILABLE', 'ملف الوسائط غير متوفر على الخادم حاليًا');
  }

  const cacheKey = `${deviceId}::${normalizedChatJid}::${messageId}`;
  const existing = readCachedMediaResolution(cacheKey);
  if (existing) {
    return existing;
  }

  let pending = mediaResolveInflight.get(cacheKey);
  if (!pending) {
    pending = (async () => {
      let fallbackUrl = cached?.url || '';
      const downloaded = await gowaFetch<GowaDownloadedMedia | null>(
        `/message/${encodeURIComponent(messageId)}/download`,
        {deviceId, query: {phone}, timeoutMs: 25_000},
      ).catch(async (err) => {
        if (!fallbackUrl && phone.toLowerCase() === 'status@broadcast') {
          const recent = await gowaFetch<{data?: GowaMessageInfo[]}>('/chat/status@broadcast/messages', {
            deviceId,
            query: {limit: 50, offset: 0},
          });
          fallbackUrl = recent?.data?.find((item) => item.id === messageId && !item.is_revoked)?.url || '';
        }
        if (!fallbackUrl) throw err;
        return null;
      });
      const filePath =
        downloaded?.file_path ||
        downloaded?.file_url ||
        (fallbackUrl.includes('mmg.whatsapp.net') ? '' : fallbackUrl);
      if (!filePath) {
        throw new GowaError(404, 'MEDIA_NOT_AVAILABLE', 'ملف الوسائط غير متوفر على الخادم حاليًا');
      }
      const entry: CachedMediaResolution = {
        filePath,
        mediaType: cached?.media_type || '',
        filename: cached?.filename || '',
        fileSize: cached?.file_length || 0,
        downloaded,
        expiresAt: Date.now() + MEDIA_RESOLVE_TTL_MS,
      };
      writeCachedMediaResolution(cacheKey, entry);
      return entry;
    })().finally(() => {
      mediaResolveInflight.delete(cacheKey);
    });
    mediaResolveInflight.set(cacheKey, pending);
  }
  return pending;
}

export async function resolveAndCacheAvatar(
  deviceId: string,
  jid: string,
  force: boolean,
): Promise<CachedAvatarRow | null> {
  const cached = getCachedAvatar(deviceId, jid);
  if (!force && cached) {
    const age = Date.now() - cached.updated_at;
    if (
      cached.status === 'ok' &&
      cached.image_blob &&
      cached.image_blob.byteLength > 0 &&
      age < AVATAR_OK_TTL_MS
    ) {
      return cached;
    }
    if (cached.status === 'none' && age < AVATAR_NONE_TTL_MS) {
      return null;
    }
  }

  const inflightKey = `${deviceId}::${jid}`;
  let pending = avatarInflight.get(inflightKey);
  if (!pending) {
    pending = (async (): Promise<CachedAvatarRow | null> => {
      try {
        const targetPhone = normalizeSearchQuery(jid) || jid;
        const info = await gowaFetch<GowaAvatarInfo | null>('/user/avatar', {
          deviceId,
          query: {phone: targetPhone, is_preview: true},
          timeoutMs: 7_000,
        });
        const avatarUrl = info?.url?.trim() || '';
        if (!avatarUrl) {
          upsertCachedAvatar({
            deviceId,
            jid,
            avatarUrl: '',
            imageBlob: null,
            contentType: '',
            status: 'none',
          });
          return null;
        }

        const downloaded = await fetchPublicAvatarImage(avatarUrl);
        upsertCachedAvatar({
          deviceId,
          jid,
          avatarUrl,
          imageBlob: downloaded.buffer,
          contentType: downloaded.contentType,
          status: 'ok',
        });
        return {
          device_id: deviceId,
          jid,
          avatar_url: avatarUrl,
          image_blob: downloaded.buffer,
          content_type: downloaded.contentType,
          status: 'ok',
          updated_at: Date.now(),
        };
      } catch (err) {
        if (
          err instanceof GowaError &&
          (err.status === 400 || err.status === 404 || err.code.startsWith('AVATAR_'))
        ) {
          upsertCachedAvatar({
            deviceId,
            jid,
            avatarUrl: '',
            imageBlob: null,
            contentType: '',
            status: 'none',
          });
          return null;
        }
        if (cached?.status === 'ok' && cached.image_blob && cached.image_blob.byteLength > 0) {
          return cached;
        }
        return null;
      } finally {
        avatarInflight.delete(inflightKey);
      }
    })();
    avatarInflight.set(inflightKey, pending);
  }

  return pending;
}
