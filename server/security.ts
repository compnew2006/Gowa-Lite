import type {Request} from 'express';
import {GowaError} from './gowa-client.ts';

export const SESSION_COOKIE_NAME = 'gowa_session';

export function parseCookies(headerValue: string | undefined): Record<string, string> {
  if (!headerValue) return {};
  const cookies: Record<string, string> = {};
  for (const part of headerValue.split(';')) {
    const eqIndex = part.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = part.slice(0, eqIndex).trim();
    const rawVal = part.slice(eqIndex + 1).trim();
    if (!key) continue;
    try {
      cookies[key] = decodeURIComponent(rawVal);
    } catch {
      cookies[key] = rawVal;
    }
  }
  return cookies;
}

export function isHttpsRequest(req: Pick<Request, 'secure' | 'headers'>): boolean {
  if (req.secure) return true;
  const forwardedProto = req.headers['x-forwarded-proto'];
  if (typeof forwardedProto === 'string') {
    return forwardedProto.split(',')[0].trim().toLowerCase() === 'https';
  }
  return false;
}

export function isSafeCookieMutationRequest(req: Pick<Request, 'headers'>): boolean {
  const xRequestedWith = req.headers['x-requested-with'];
  if (typeof xRequestedWith === 'string' && xRequestedWith.trim().length > 0) {
    return true;
  }

  const origin = req.headers.origin;
  const rawHost = req.headers['x-forwarded-host'] || req.headers.host;
  const expectedHost = Array.isArray(rawHost) ? rawHost[0] : rawHost;
  if (typeof origin === 'string' && expectedHost) {
    try {
      const originHost = new URL(origin).host.toLowerCase();
      const targetHost = expectedHost.split(',')[0].trim().toLowerCase();
      if (originHost && targetHost && originHost === targetHost) {
        return true;
      }
    } catch {
      return false;
    }
  }
  return false;
}

export function hasSameOrigin(urlA: string, urlB: string): boolean {
  try {
    return new URL(urlA).origin === new URL(urlB).origin;
  } catch {
    return false;
  }
}

export function canReuseSavedGowaCredentials(requestedUrl: string, savedUrl: string): boolean {
  const cleanRequested = requestedUrl.trim();
  const cleanSaved = savedUrl.trim();
  if (!cleanRequested || !cleanSaved) return true;
  return hasSameOrigin(cleanRequested, cleanSaved);
}

export function decodeRouteParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new GowaError(400, 'VALIDATION_ERROR', 'معرّف المسار غير صالح');
  }
}

export function parseTrustProxySetting(rawValue: string | undefined): boolean | number | string {
  const clean = (rawValue ?? '').trim();
  if (!clean || clean.toLowerCase() === 'false') return false;
  if (clean.toLowerCase() === 'true') return true;
  if (/^\d+$/.test(clean)) return Number(clean);
  return clean;
}

export function getClientIp(req: Pick<Request, 'ip' | 'socket'>): string {
  if (typeof req.ip === 'string' && req.ip.trim()) {
    return req.ip.trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

const SAFE_INLINE_MEDIA_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/mp4',
  'audio/aac',
  'application/pdf',
]);

export function isSafeInlineMediaType(contentType: string): boolean {
  const baseMime = contentType.split(';')[0].trim().toLowerCase();
  return SAFE_INLINE_MEDIA_TYPES.has(baseMime);
}

export function buildSafeMediaHeaders(
  contentType: string,
  filename?: string,
): {disposition: string; csp?: string} {
  const safeInline = isSafeInlineMediaType(contentType);
  const sanitizedFilename = filename
    ? filename.replace(/["\r\n\\/]/g, '_')
    : undefined;
  const dispositionType = safeInline ? 'inline' : 'attachment';
  const disposition = sanitizedFilename
    ? `${dispositionType}; filename="${sanitizedFilename}"`
    : dispositionType;
  return safeInline
    ? {disposition}
    : {disposition, csp: "default-src 'none'; sandbox"};
}

interface RateBucket {
  failures: number[];
}

export class AuthRateLimiter {
  private readonly buckets = new Map<string, RateBucket>();
  private readonly windowMs: number;
  private readonly maxPerUserKey: number;
  private readonly maxPerIp: number;
  private readonly maxBuckets: number;
  private operationsSinceSweep = 0;

  constructor(options?: {
    windowMs?: number;
    maxPerUserKey?: number;
    maxPerIp?: number;
    maxBuckets?: number;
  }) {
    this.windowMs = options?.windowMs ?? 15 * 60_000;
    this.maxPerUserKey = options?.maxPerUserKey ?? 10;
    this.maxPerIp = options?.maxPerIp ?? 25;
    this.maxBuckets = Math.max(10, options?.maxBuckets ?? 10_000);
  }

  get bucketCount(): number {
    return this.buckets.size;
  }

  private sweepExpired(nowMs: number): void {
    const cutoff = nowMs - this.windowMs;
    for (const [key, bucket] of this.buckets.entries()) {
      const recent = bucket.failures.filter((ts) => ts > cutoff);
      if (recent.length === 0) {
        this.buckets.delete(key);
      } else {
        bucket.failures = recent;
      }
    }
  }

  private setBucketBounded(key: string, failures: number[], nowMs: number): void {
    if (this.buckets.has(key)) {
      this.buckets.delete(key);
    }
    this.operationsSinceSweep += 1;
    if (this.buckets.size >= this.maxBuckets || this.operationsSinceSweep >= 500) {
      this.operationsSinceSweep = 0;
      this.sweepExpired(nowMs);
    }
    while (this.buckets.size >= this.maxBuckets) {
      const oldestKey = this.buckets.keys().next().value;
      if (!oldestKey) break;
      this.buckets.delete(oldestKey);
    }
    this.buckets.set(key, {failures});
  }

  private prune(key: string, nowMs: number): number[] {
    const bucket = this.buckets.get(key);
    if (!bucket) return [];
    const cutoff = nowMs - this.windowMs;
    const recent = bucket.failures.filter((ts) => ts > cutoff);
    if (recent.length === 0) {
      this.buckets.delete(key);
      return [];
    }
    bucket.failures = recent;
    return recent;
  }

  check(ip: string, username?: string, nowMs = Date.now()): {
    allowed: boolean;
    retryAfterSec: number;
  } {
    const ipRecent = this.prune(`ip:${ip}`, nowMs);
    if (ipRecent.length >= this.maxPerIp) {
      const oldest = ipRecent[0] ?? nowMs;
      return {
        allowed: false,
        retryAfterSec: Math.max(1, Math.ceil((oldest + this.windowMs - nowMs) / 1000)),
      };
    }

    const cleanUser = username?.trim().toLowerCase();
    if (cleanUser) {
      const userRecent = this.prune(`user:${ip}:${cleanUser}`, nowMs);
      if (userRecent.length >= this.maxPerUserKey) {
        const oldest = userRecent[0] ?? nowMs;
        return {
          allowed: false,
          retryAfterSec: Math.max(1, Math.ceil((oldest + this.windowMs - nowMs) / 1000)),
        };
      }
    }

    return {allowed: true, retryAfterSec: 0};
  }

  recordFailure(ip: string, username?: string, nowMs = Date.now()): void {
    const ipList = this.prune(`ip:${ip}`, nowMs);
    ipList.push(nowMs);
    this.setBucketBounded(`ip:${ip}`, ipList, nowMs);

    const cleanUser = username?.trim().toLowerCase();
    if (cleanUser) {
      const userKey = `user:${ip}:${cleanUser}`;
      const userList = this.prune(userKey, nowMs);
      userList.push(nowMs);
      this.setBucketBounded(userKey, userList, nowMs);
    }
  }

  clearSuccess(ip: string, username?: string): void {
    const cleanUser = username?.trim().toLowerCase();
    if (cleanUser) {
      this.buckets.delete(`user:${ip}:${cleanUser}`);
    }
  }
}

