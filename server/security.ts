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

export function getClientIp(req: Pick<Request, 'headers' | 'socket'>): string {
  const forwardedFor = req.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

interface RateBucket {
  failures: number[];
}

export class AuthRateLimiter {
  private readonly buckets = new Map<string, RateBucket>();
  private readonly windowMs: number;
  private readonly maxPerUserKey: number;
  private readonly maxPerIp: number;

  constructor(options?: {
    windowMs?: number;
    maxPerUserKey?: number;
    maxPerIp?: number;
  }) {
    this.windowMs = options?.windowMs ?? 15 * 60_000;
    this.maxPerUserKey = options?.maxPerUserKey ?? 10;
    this.maxPerIp = options?.maxPerIp ?? 25;
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
    this.buckets.set(`ip:${ip}`, {failures: ipList});

    const cleanUser = username?.trim().toLowerCase();
    if (cleanUser) {
      const userKey = `user:${ip}:${cleanUser}`;
      const userList = this.prune(userKey, nowMs);
      userList.push(nowMs);
      this.buckets.set(userKey, {failures: userList});
    }
  }

  clearSuccess(ip: string, username?: string): void {
    const cleanUser = username?.trim().toLowerCase();
    if (cleanUser) {
      this.buckets.delete(`user:${ip}:${cleanUser}`);
    }
  }
}
