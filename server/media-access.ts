import {createHmac, randomBytes, timingSafeEqual} from 'node:crypto';
import type {Request, Response} from 'express';
import {GowaError, gowaFetchBinary} from './gowa-client.ts';
import {buildSafeMediaHeaders} from './security.ts';

type GowaBinaryAsset = Awaited<ReturnType<typeof gowaFetchBinary>>;

export const GOWA_MEDIA_ROUTE = '/api/unified/media/file';
const signingKey = randomBytes(32);
const MEDIA_LINK_TTL_MS = 30 * 60_000;

const ASSET_CACHE_TTL_MS = 10 * 60_000;
const MAX_ASSET_CACHE_ENTRIES = 64;
const MAX_ASSET_CACHE_ITEM_BYTES = 16 * 1024 * 1024;
const MAX_ASSET_CACHE_TOTAL_BYTES = 96 * 1024 * 1024;

interface CachedAssetEntry {
  asset: GowaBinaryAsset;
  expiresAt: number;
}

const assetCache = new Map<string, CachedAssetEntry>();
const assetInflight = new Map<string, Promise<GowaBinaryAsset>>();
let assetCacheTotalBytes = 0;

function evictAssetEntry(key: string): void {
  const existing = assetCache.get(key);
  if (!existing) return;
  assetCacheTotalBytes = Math.max(0, assetCacheTotalBytes - existing.asset.buffer.byteLength);
  assetCache.delete(key);
}

function getCachedAsset(key: string): GowaBinaryAsset | null {
  const entry = assetCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    evictAssetEntry(key);
    return null;
  }
  assetCache.delete(key);
  assetCache.set(key, entry);
  return entry.asset;
}

function setCachedAsset(key: string, asset: GowaBinaryAsset): void {
  const size = asset.buffer.byteLength;
  if (size <= 0 || size > MAX_ASSET_CACHE_ITEM_BYTES) return;
  if (assetCache.has(key)) evictAssetEntry(key);
  while (
    assetCache.size >= MAX_ASSET_CACHE_ENTRIES ||
    assetCacheTotalBytes + size > MAX_ASSET_CACHE_TOTAL_BYTES
  ) {
    const oldestKey = assetCache.keys().next().value;
    if (!oldestKey) break;
    evictAssetEntry(oldestKey);
  }
  assetCache.set(key, {asset, expiresAt: Date.now() + ASSET_CACHE_TTL_MS});
  assetCacheTotalBytes += size;
}

async function fetchGowaAssetCached(deviceId: string, path: string): Promise<GowaBinaryAsset> {
  const cacheKey = `${deviceId}::${path}`;
  const cached = getCachedAsset(cacheKey);
  if (cached) return cached;

  let pending = assetInflight.get(cacheKey);
  if (!pending) {
    pending = gowaFetchBinary(path, {deviceId})
      .then((asset) => {
        setCachedAsset(cacheKey, asset);
        return asset;
      })
      .finally(() => {
        assetInflight.delete(cacheKey);
      });
    assetInflight.set(cacheKey, pending);
  }
  return pending;
}

function parseByteRange(rangeHeader: string, totalLength: number): {start: number; end: number} | 'invalid' | null {
  if (!rangeHeader.startsWith('bytes=') || totalLength <= 0) return null;
  const spec = rangeHeader.slice(6).split(',')[0]?.trim();
  if (!spec) return null;
  const dashIdx = spec.indexOf('-');
  if (dashIdx === -1) return 'invalid';

  const startStr = spec.slice(0, dashIdx).trim();
  const endStr = spec.slice(dashIdx + 1).trim();

  if (!startStr && !endStr) return 'invalid';
  if (!startStr) {
    const suffix = Number(endStr);
    if (!Number.isInteger(suffix) || suffix <= 0) return 'invalid';
    const start = Math.max(0, totalLength - suffix);
    return {start, end: totalLength - 1};
  }

  const start = Number(startStr);
  const end = endStr ? Number(endStr) : totalLength - 1;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    start >= totalLength ||
    end < start
  ) {
    return 'invalid';
  }
  return {start, end: Math.min(end, totalLength - 1)};
}

function signAsset(route: string, deviceId: string, chatJid: string, path: string, expiresAt: number): Buffer {
  return createHmac('sha256', signingKey)
    .update(JSON.stringify([route, deviceId, chatJid, path, expiresAt]))
    .digest();
}

export function buildGowaAssetUrl(
  route: string, deviceId: string, chatJid: string, path: string, ttlMs = MEDIA_LINK_TTL_MS,
): string {
  if (!path) return '';
  const expiresAt = Date.now() + ttlMs;
  const signature = signAsset(route, deviceId, chatJid, path, expiresAt).toString('hex');
  const query = new URLSearchParams({deviceId, chatJid, path, expires: String(expiresAt), signature});
  return `${route}?${query}`;
}

export async function sendGowaAsset(
  req: Request, res: Response, route: string, deviceId: string, chatJid: string,
): Promise<void> {
  const {path, expires, signature} = req.query;
  const expiresAt = typeof expires === 'string' ? Number(expires) : NaN;
  if (typeof path !== 'string' || !path || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() ||
      typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature) ||
      !timingSafeEqual(Buffer.from(signature, 'hex'), signAsset(route, deviceId, chatJid, path, expiresAt))) {
    throw new GowaError(403, 'ASSET_FORBIDDEN', 'رابط الملف غير مصرح به أو انتهت صلاحيته');
  }

  const asset = await fetchGowaAssetCached(deviceId, path);
  const safeHeaders = buildSafeMediaHeaders(asset.contentType, asset.filename);
  const totalLength = asset.buffer.byteLength;
  res.setHeader('Content-Type', asset.contentType);
  res.setHeader('Content-Disposition', safeHeaders.disposition);
  if (safeHeaders.csp) res.setHeader('Content-Security-Policy', safeHeaders.csp);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('Accept-Ranges', 'bytes');

  const rawRange = typeof req.headers.range === 'string' ? req.headers.range.trim() : '';
  if (rawRange) {
    const parsedRange = parseByteRange(rawRange, totalLength);
    if (parsedRange === 'invalid') {
      res.status(416);
      res.setHeader('Content-Range', `bytes */${totalLength}`);
      res.end();
      return;
    }
    if (parsedRange) {
      const slice = asset.buffer.subarray(parsedRange.start, parsedRange.end + 1);
      res.status(206);
      res.setHeader('Content-Range', `bytes ${parsedRange.start}-${parsedRange.end}/${totalLength}`);
      res.setHeader('Content-Length', String(slice.byteLength));
      res.send(slice);
      return;
    }
  }

  res.setHeader('Content-Length', String(totalLength));
  res.send(asset.buffer);
}
