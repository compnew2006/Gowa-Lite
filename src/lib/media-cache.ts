import {fetchAuthorizedMediaBytes} from '@/api/client';
import {normalizeDownloadedMime} from '@/lib/media-download';

export interface CachedMediaEntry {
  objectUrl: string;
  contentType: string;
  byteLength: number;
}

export type MediaByteFetcher = (
  urlPath: string,
  signal?: AbortSignal,
) => Promise<{bytes: Uint8Array<ArrayBuffer>; contentType: string}>;

const MAX_MEDIA_CACHE_ENTRIES = 120;
const MAX_CONCURRENT_MEDIA = 4;

const mediaCache = new Map<string, CachedMediaEntry>();
const inflightMedia = new Map<string, Promise<CachedMediaEntry>>();
const pendingQueue: Array<() => void> = [];
let activeFetches = 0;

function runQueued<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = () => {
      activeFetches += 1;
      void task()
        .then(resolve, reject)
        .finally(() => {
          activeFetches = Math.max(0, activeFetches - 1);
          const next = pendingQueue.shift();
          if (next) next();
        });
    };

    if (activeFetches < MAX_CONCURRENT_MEDIA) {
      start();
    } else {
      pendingQueue.push(start);
    }
  });
}

function safeCreateObjectUrl(bytes: Uint8Array<ArrayBuffer>, contentType: string): string {
  const blob = new Blob([bytes], {type: normalizeDownloadedMime(contentType)});
  return URL.createObjectURL(blob);
}

function safeRevokeObjectUrl(url: string): void {
  try {
    URL.revokeObjectURL(url);
  } catch {
    // Ignore revoke errors in non-DOM test environments
  }
}

export function getCachedMedia(key: string): CachedMediaEntry | null {
  const existing = mediaCache.get(key);
  if (!existing) return null;
  // Touch LRU order
  mediaCache.delete(key);
  mediaCache.set(key, existing);
  return existing;
}

export function setCachedMedia(
  key: string,
  entry: CachedMediaEntry,
  maxEntries = MAX_MEDIA_CACHE_ENTRIES,
): void {
  const prev = mediaCache.get(key);
  if (prev) {
    mediaCache.delete(key);
    if (prev.objectUrl !== entry.objectUrl) {
      safeRevokeObjectUrl(prev.objectUrl);
    }
  }
  while (mediaCache.size >= maxEntries) {
    const oldestKey = mediaCache.keys().next().value;
    if (!oldestKey) break;
    const evicted = mediaCache.get(oldestKey);
    mediaCache.delete(oldestKey);
    if (evicted) safeRevokeObjectUrl(evicted.objectUrl);
  }
  mediaCache.set(key, entry);
}

export function getOrFetchCachedMedia(
  key: string,
  urlPath: string,
  fetcher: MediaByteFetcher = fetchAuthorizedMediaBytes,
  maxEntries = MAX_MEDIA_CACHE_ENTRIES,
): Promise<CachedMediaEntry> {
  const cached = getCachedMedia(key);
  if (cached) return Promise.resolve(cached);

  const pending = inflightMedia.get(key);
  if (pending) return pending;

  const promise = runQueued(async () => {
    const again = getCachedMedia(key);
    if (again) return again;
    const {bytes, contentType} = await fetcher(urlPath);
    const objectUrl = safeCreateObjectUrl(bytes, contentType);
    const entry: CachedMediaEntry = {
      objectUrl,
      contentType,
      byteLength: bytes.byteLength,
    };
    setCachedMedia(key, entry, maxEntries);
    return entry;
  }).finally(() => {
    inflightMedia.delete(key);
  });

  inflightMedia.set(key, promise);
  return promise;
}

export function clearMediaCache(): void {
  for (const entry of mediaCache.values()) {
    safeRevokeObjectUrl(entry.objectUrl);
  }
  mediaCache.clear();
}
