import {fetchAuthorizedMediaBytes} from '@/api/client';
import {normalizeDownloadedMime} from '@/lib/media-download';
import {hasSameAccessScope, useAuthStore} from '@/stores/auth';

export interface MediaDimensions {
  width: number;
  height: number;
}

export interface CachedMediaEntry {
  objectUrl: string;
  contentType: string;
  byteLength: number;
  dimensions?: MediaDimensions;
}

export type MediaByteFetcher = (
  urlPath: string,
  signal?: AbortSignal,
) => Promise<{bytes: Uint8Array<ArrayBuffer>; contentType: string}>;

const MAX_MEDIA_CACHE_ENTRIES = 120;
const MAX_DIMENSION_CACHE_ENTRIES = 500;
const MAX_CONCURRENT_MEDIA = 4;

const mediaCache = new Map<string, CachedMediaEntry>();
const mediaDimensionsCache = new Map<string, MediaDimensions>();
const decodedMediaKeys = new Set<string>();
const inflightMedia = new Map<string, Promise<CachedMediaEntry>>();
const pendingQueue: Array<() => void> = [];
let activeFetches = 0;
let cacheGeneration = 0;

export function isMediaDecoded(key: string): boolean {
  return decodedMediaKeys.has(key);
}

export function markMediaDecoded(key: string): void {
  if (decodedMediaKeys.size >= MAX_DIMENSION_CACHE_ENTRIES) {
    const oldest = decodedMediaKeys.values().next().value;
    if (oldest) decodedMediaKeys.delete(oldest);
  }
  decodedMediaKeys.add(key);
}

function isValidDimensions(dimensions: MediaDimensions | undefined): dimensions is MediaDimensions {
  return Boolean(
    dimensions &&
      Number.isFinite(dimensions.width) &&
      Number.isFinite(dimensions.height) &&
      dimensions.width > 0 &&
      dimensions.height > 0,
  );
}

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

export function getCachedMediaDimensions(key: string): MediaDimensions | null {
  const cachedEntry = mediaCache.get(key);
  if (cachedEntry?.dimensions) return cachedEntry.dimensions;
  return mediaDimensionsCache.get(key) ?? null;
}

export function updateCachedMediaDimensions(key: string, dimensions: MediaDimensions): void {
  if (!isValidDimensions(dimensions)) return;
  const normalized: MediaDimensions = {
    width: Math.round(dimensions.width),
    height: Math.round(dimensions.height),
  };
  if (mediaDimensionsCache.has(key)) {
    mediaDimensionsCache.delete(key);
  }
  while (mediaDimensionsCache.size >= MAX_DIMENSION_CACHE_ENTRIES) {
    const oldest = mediaDimensionsCache.keys().next().value;
    if (!oldest) break;
    mediaDimensionsCache.delete(oldest);
  }
  mediaDimensionsCache.set(key, normalized);

  const existing = mediaCache.get(key);
  if (existing) {
    existing.dimensions = normalized;
  }
}

export function getCachedMedia(key: string): CachedMediaEntry | null {
  const existing = mediaCache.get(key);
  if (!existing) return null;
  // Touch LRU order
  mediaCache.delete(key);
  mediaCache.set(key, existing);
  if (!existing.dimensions) {
    const knownDims = mediaDimensionsCache.get(key);
    if (knownDims) existing.dimensions = knownDims;
  }
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
  const resolvedDimensions = isValidDimensions(entry.dimensions)
    ? entry.dimensions
    : (prev?.dimensions ?? mediaDimensionsCache.get(key));
  const storedEntry: CachedMediaEntry = resolvedDimensions
    ? {...entry, dimensions: resolvedDimensions}
    : {...entry};
  if (resolvedDimensions) {
    updateCachedMediaDimensions(key, resolvedDimensions);
  }

  while (mediaCache.size >= maxEntries) {
    const oldestKey = mediaCache.keys().next().value;
    if (!oldestKey) break;
    const evicted = mediaCache.get(oldestKey);
    mediaCache.delete(oldestKey);
    if (evicted) safeRevokeObjectUrl(evicted.objectUrl);
  }
  mediaCache.set(key, storedEntry);
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

  const generation = cacheGeneration;
  const assertCurrentScope = () => {
    if (generation !== cacheGeneration) throw new DOMException('Media access changed', 'AbortError');
  };
  const promise = runQueued(async () => {
    assertCurrentScope();
    const again = getCachedMedia(key);
    if (again) return again;
    const {bytes, contentType} = await fetcher(urlPath);
    assertCurrentScope();
    const objectUrl = safeCreateObjectUrl(bytes, contentType);
    const knownDims = mediaDimensionsCache.get(key);
    const entry: CachedMediaEntry = {
      objectUrl,
      contentType,
      byteLength: bytes.byteLength,
      ...(knownDims ? {dimensions: knownDims} : {}),
    };
    setCachedMedia(key, entry, maxEntries);
    return entry;
  }).finally(() => {
    if (inflightMedia.get(key) === promise) inflightMedia.delete(key);
  });

  inflightMedia.set(key, promise);
  return promise;
}

export function clearMediaCache(): void {
  cacheGeneration += 1;
  inflightMedia.clear();
  mediaDimensionsCache.clear();
  decodedMediaKeys.clear();
  for (const entry of mediaCache.values()) {
    safeRevokeObjectUrl(entry.objectUrl);
  }
  mediaCache.clear();
}

useAuthStore.subscribe((current, previous) => {
  if (!hasSameAccessScope(previous.user, current.user)) clearMediaCache();
});
