import {createHmac, randomBytes, timingSafeEqual} from 'node:crypto';
import type {Request, Response} from 'express';
import {GowaError, gowaFetchBinary} from './gowa-client.ts';
import {buildSafeMediaHeaders} from './security.ts';

export const GOWA_MEDIA_ROUTE = '/api/unified/media/file';
const signingKey = randomBytes(32);
const MEDIA_LINK_TTL_MS = 30 * 60_000;

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

  const asset = await gowaFetchBinary(path, {deviceId});
  const safeHeaders = buildSafeMediaHeaders(asset.contentType, asset.filename);
  res.setHeader('Content-Type', asset.contentType);
  res.setHeader('Content-Disposition', safeHeaders.disposition);
  if (safeHeaders.csp) res.setHeader('Content-Security-Policy', safeHeaders.csp);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(asset.buffer);
}
