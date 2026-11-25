import crypto from 'node:crypto';
import path from 'node:path';
import express, {type NextFunction, type Request, type Response, type Router} from 'express';
import {getSessionUser, type PublicUser} from '../db.ts';
import {GowaError} from '../errors.ts';
import {
  hasAnyPermission,
  hasDeviceAccess,
  hasPermission,
  isAdminSubject,
  type PermissionResource,
} from '../rbac.ts';
import {
  SESSION_COOKIE_NAME,
  decodeRouteParam,
  isHttpsRequest,
  isSafeCookieMutationRequest,
  parseCookies,
} from '../security.ts';
import type {AuthedRequest} from '../types.ts';

const SESSION_COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 7;
const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const VALIDATED_ROUTE_PARAMS = ['id', 'deviceId', 'jid', 'messageId'] as const;

export function createApiRouter(): Router {
  const router = express.Router();
  for (const paramName of VALIDATED_ROUTE_PARAMS) {
    router.param(paramName, (_req, res, next, value) => {
      try {
        decodeRouteParam(String(value));
        next();
      } catch (err) {
        handleRouteError(res, err);
      }
    });
  }
  return router;
}

export function extractAuthToken(req: Request): {
  token: string;
  source: 'bearer' | 'cookie' | 'none';
} {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    const token = header.slice('Bearer '.length).trim();
    if (token) return {token, source: 'bearer'};
  }
  const cookies = parseCookies(req.headers.cookie);
  const cookieToken = cookies[SESSION_COOKIE_NAME]?.trim() || '';
  if (cookieToken) {
    return {token: cookieToken, source: 'cookie'};
  }
  return {token: '', source: 'none'};
}

export function setSessionCookie(req: Request, res: Response, token: string): void {
  const baseParts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    `Max-Age=${SESSION_COOKIE_MAX_AGE_SEC}`,
    'HttpOnly',
  ];
  if (isHttpsRequest(req)) {
    baseParts.push('Secure', 'SameSite=None', 'Partitioned');
  } else {
    baseParts.push('SameSite=Lax');
  }
  res.append('Set-Cookie', baseParts.join('; '));
}

export function clearSessionCookie(req: Request, res: Response): void {
  const baseParts = [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
  ];
  if (isHttpsRequest(req)) {
    baseParts.push('Secure', 'SameSite=None', 'Partitioned');
  } else {
    baseParts.push('SameSite=Lax');
  }
  res.append('Set-Cookie', baseParts.join('; '));
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const {token, source} = extractAuthToken(req);
  if (!token) {
    res.status(401).json({code: 'UNAUTHORIZED', message: 'يرجى تسجيل الدخول للمتابعة'});
    return;
  }
  if (source === 'cookie' && MUTATION_METHODS.has(req.method.toUpperCase())) {
    if (!isSafeCookieMutationRequest(req)) {
      res.status(403).json({code: 'CSRF_CHECK_FAILED', message: 'تم رفض الطلب لأسباب أمنية'});
      return;
    }
  }
  const user = getSessionUser(token);
  if (!user) {
    if (source === 'cookie') {
      clearSessionCookie(req, res);
    }
    res.status(401).json({code: 'SESSION_EXPIRED', message: 'انتهت الجلسة، يرجى تسجيل الدخول مجددًا'});
    return;
  }
  req.user = user;
  req.authToken = token;
  next();
}

export function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({code: 'UNAUTHORIZED', message: 'يرجى تسجيل الدخول للمتابعة'});
    return;
  }
  if (!isAdminSubject(req.user)) {
    res.status(403).json({code: 'FORBIDDEN', message: 'هذه الصلاحية مخصصة للمسؤولين فقط'});
    return;
  }
  next();
}

export function requirePermission(resource: PermissionResource, action: string) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({code: 'UNAUTHORIZED', message: 'يرجى تسجيل الدخول للمتابعة'});
      return;
    }
    if (!hasPermission(req.user, resource, action)) {
      res.status(403).json({
        code: 'FORBIDDEN',
        message: 'ليس لديك الصلاحية الكافية لتنفيذ هذا الإجراء',
      });
      return;
    }
    next();
  };
}

export function requireAnyPermission(keys: string[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({code: 'UNAUTHORIZED', message: 'يرجى تسجيل الدخول للمتابعة'});
      return;
    }
    if (!hasAnyPermission(req.user, keys)) {
      res.status(403).json({
        code: 'FORBIDDEN',
        message: 'ليس لديك الصلاحية الكافية للوصول إلى هذا المورد',
      });
      return;
    }
    next();
  };
}

export function requireDeviceParamAccess(req: AuthedRequest, res: Response, next: NextFunction): void {
  try {
    assertDeviceAccess(req.user, decodeRouteParam(req.params.deviceId));
    next();
  } catch (err) {
    handleRouteError(res, err);
  }
}

export function assertDeviceAccess(user: PublicUser | undefined, deviceId: string): void {
  if (!user) {
    throw new GowaError(401, 'UNAUTHORIZED', 'يرجى تسجيل الدخول للمتابعة');
  }
  if (!hasDeviceAccess(user, deviceId)) {
    throw new GowaError(403, 'DEVICE_FORBIDDEN', 'غير مصرح لك بالوصول إلى حساب واتساب هذا');
  }
}

export function safeComparePasscode(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function handleRouteError(res: Response, err: unknown): void {
  if (err instanceof GowaError) {
    res.status(err.status).json({
      code: err.code,
      message: err.message,
      ...(err.details !== undefined ? {results: err.details} : {}),
    });
    return;
  }
  console.error('[server error]', err);
  res.status(500).json({code: 'INTERNAL_ERROR', message: 'حدث خطأ داخلي في الخادم'});
}

export function decodeImageUpload(
  filenameRaw: unknown,
  mimeTypeRaw: unknown,
  dataBase64Raw: unknown,
): {filename: string; blob: Blob} {
  const allowedMimes = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif']);
  const mimeType = typeof mimeTypeRaw === 'string' ? mimeTypeRaw.trim().toLowerCase() : '';
  const dataBase64 = typeof dataBase64Raw === 'string' ? dataBase64Raw.trim() : '';
  const filename =
    typeof filenameRaw === 'string' && filenameRaw.trim()
      ? path.basename(filenameRaw.trim()).replace(/[^a-zA-Z0-9._-]/g, '_')
      : 'upload.png';

  if (!allowedMimes.has(mimeType) || !dataBase64) {
    throw new GowaError(400, 'VALIDATION_ERROR', 'صيغة الصورة غير مدعومة (PNG / JPG / WEBP فقط)');
  }
  const buffer = Buffer.from(dataBase64, 'base64');
  if (buffer.length === 0 || buffer.length > 5 * 1024 * 1024) {
    throw new GowaError(400, 'VALIDATION_ERROR', 'حجم الصورة يجب ألا يتجاوز 5 ميجابايت');
  }
  return {filename, blob: new Blob([buffer], {type: mimeType})};
}
