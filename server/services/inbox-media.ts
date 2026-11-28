import sharp from 'sharp';
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
import {fetchGowaAssetCached} from '../media-access.ts';
import {normalizeSearchQuery, normalizeWhatsAppJid} from './chat-sync.ts';

const MEDIA_RESOLVE_TTL_MS = 5 * 60_000;
const MAX_MEDIA_RESOLVE_ENTRIES = 500;
const AVATAR_OK_TTL_MS = 1000 * 60 * 60 * 24;
const AVATAR_NONE_TTL_MS = 1000 * 60 * 60;

// Thumbnails: the chat bubble shows a small preview first for large images and
// only fetches the full bytes when the user opens the preview, so opening a
// chat with many large photos no longer pulls megabytes up front.
const THUMBNAIL_MAX_DIMENSION = 320;
const THUMBNAIL_JPEG_QUALITY = 72;
const THUMBNAIL_TTL_MS = 10 * 60_000;
const MAX_THUMBNAIL_CACHE_ENTRIES = 200;
const MAX_THUMBNAIL_CACHE_TOTAL_BYTES = 24 * 1024 * 1024;

const SUPPORTED_THUMBNAIL_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'image/bmp',
]);

export interface ImageThumbnail {
  buffer: Buffer;
  contentType: string;
  width: number;
  height: number;
}

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

export async function createImageThumbnail(
  input: Buffer,
  contentType: string,
): Promise<ImageThumbnail> {
  const normalized = (contentType || '').split(';')[0].trim().toLowerCase();
  if (!SUPPORTED_THUMBNAIL_TYPES.has(normalized)) {
    throw new GowaError(415, 'THUMBNAIL_UNSUPPORTED', 'لا يمكن إنشاء مصغّر لهذا النوع من الملفات');
  }
  // Animated images (e.g. GIF stickers) collapse to their first frame, which is
  // all a bubble preview needs; the full media still loads on tap.
  const {data, info} = await sharp(input)
    .rotate()
    .resize({
      width: THUMBNAIL_MAX_DIMENSION,
      height: THUMBNAIL_MAX_DIMENSION,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({quality: THUMBNAIL_JPEG_QUALITY, mozjpeg: true})
    .toBuffer({resolveWithObject: true});
  return {buffer: data, contentType: 'image/jpeg', width: info.width, height: info.height};
}

interface CachedThumbnailEntry extends ImageThumbnail {
  expiresAt: number;
}

const thumbnailCache = new Map<string, CachedThumbnailEntry>();
const thumbnailInflight = new Map<string, Promise<ImageThumbnail>>();
let thumbnailCacheTotalBytes = 0;

function readCachedThumbnail(key: string): ImageThumbnail | null {
  const entry = thumbnailCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    thumbnailCacheTotalBytes = Math.max(0, thumbnailCacheTotalBytes - entry.buffer.byteLength);
    thumbnailCache.delete(key);
    return null;
  }
  thumbnailCache.delete(key);
  thumbnailCache.set(key, entry);
  return entry;
}

function writeCachedThumbnail(key: string, thumbnail: ImageThumbnail): void {
  const existing = thumbnailCache.get(key);
  if (existing) {
    thumbnailCacheTotalBytes = Math.max(0, thumbnailCacheTotalBytes - existing.buffer.byteLength);
    thumbnailCache.delete(key);
  }
  while (
    (thumbnailCache.size >= MAX_THUMBNAIL_CACHE_ENTRIES ||
      thumbnailCacheTotalBytes + thumbnail.buffer.byteLength > MAX_THUMBNAIL_CACHE_TOTAL_BYTES) &&
    thumbnailCache.size > 0
  ) {
    const oldestKey = thumbnailCache.keys().next().value;
    if (!oldestKey) break;
    const evicted = thumbnailCache.get(oldestKey);
    thumbnailCache.delete(oldestKey);
    if (evicted) {
      thumbnailCacheTotalBytes = Math.max(0, thumbnailCacheTotalBytes - evicted.buffer.byteLength);
    }
  }
  thumbnailCache.set(key, {...thumbnail, expiresAt: Date.now() + THUMBNAIL_TTL_MS});
  thumbnailCacheTotalBytes += thumbnail.buffer.byteLength;
}

export async function resolveChatMediaThumbnail(
  deviceId: string,
  phone: string,
  messageId: string,
): Promise<ImageThumbnail> {
  // Reuses the download resolution (same gateway call, same 404 when the media
  // is gone) and the shared gateway asset cache, so a thumbnail never fetches
  // bytes the file route has not already fetched.
  const resolved = await resolveChatMediaDownload(deviceId, phone, messageId);
  const cacheKey = `${deviceId}::${normalizeWhatsAppJid(phone) || phone}::${messageId}`;
  const cached = readCachedThumbnail(cacheKey);
  if (cached) return cached;

  let pending = thumbnailInflight.get(cacheKey);
  if (!pending) {
    pending = (async () => {
      const asset = await fetchGowaAssetCached(deviceId, resolved.filePath);
      const thumbnail = await createImageThumbnail(asset.buffer, asset.contentType);
      writeCachedThumbnail(cacheKey, thumbnail);
      return thumbnail;
    })().finally(() => {
      thumbnailInflight.delete(cacheKey);
    });
    thumbnailInflight.set(cacheKey, pending);
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
