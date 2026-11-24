import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express, {type NextFunction, type Request, type Response} from 'express';
import {createServer as createViteServer} from 'vite';
import {
  authenticateUser,
  countActiveAdmins,
  createSession,
  createUser,
  db,
  deleteSession,
  deleteUser,
  getAccountAliases,
  getCachedAvatar,
  getGowaConfig,
  getSessionUser,
  getUserById,
  hasAnyUsers,
  listUsers,
  setAccountAlias,
  setGowaConfig,
  setUserPreferences,
  updateUser,
  upsertCachedAvatar,
  type CachedAvatarRow,
  type LanguagePreference,
  type PublicUser,
  type ThemePreference,
  type UserRole,
} from './server/db.ts';
import {
  fetchPublicAvatarImage,
  GowaError,
  gowaFetch,
  gowaFetchBinary,
  gowaFetchRaw,
  probeGowa,
  validateGowaUrl,
  type GowaAvatarInfo,
  type GowaChatInfo,
  type GowaDevice,
  type GowaDeviceStatus,
  type GowaDownloadedMedia,
  type GowaLoginQr,
  type GowaMessageInfo,
  type GowaPagination,
  type GowaPairCode,
} from './server/gowa-client.ts';
import {GowaWsBridge, issueWsTicket} from './server/ws-bridge.ts';

interface AuthedRequest extends Request {
  user?: PublicUser;
  authToken?: string;
}

function extractBearerToken(req: Request): string {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return '';
  return header.slice('Bearer '.length).trim();
}

function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const token = extractBearerToken(req);
  if (!token) {
    res.status(401).json({code: 'UNAUTHORIZED', message: 'يرجى تسجيل الدخول للمتابعة'});
    return;
  }
  const user = getSessionUser(token);
  if (!user) {
    res.status(401).json({code: 'SESSION_EXPIRED', message: 'انتهت الجلسة، يرجى تسجيل الدخول مجددًا'});
    return;
  }
  req.user = user;
  req.authToken = token;
  next();
}

function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({code: 'UNAUTHORIZED', message: 'يرجى تسجيل الدخول للمتابعة'});
    return;
  }
  if (req.user.role !== 'admin') {
    res.status(403).json({code: 'FORBIDDEN', message: 'هذه الصلاحية مخصصة للمسؤولين فقط'});
    return;
  }
  next();
}

function safeComparePasscode(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function handleRouteError(res: Response, err: unknown): void {
  if (err instanceof GowaError) {
    res.status(err.status).json({code: err.code, message: err.message});
    return;
  }
  console.error('[server error]', err);
  res.status(500).json({code: 'INTERNAL_ERROR', message: 'حدث خطأ داخلي في الخادم'});
}

function resolveAccountDisplayName(device: GowaDevice, aliases: Record<string, string>): string {
  return (
    aliases[device.id] ||
    device.display_name?.trim() ||
    device.phone_number?.trim() ||
    device.id
  );
}

function normalizeArabicDigits(value: string): string {
  return value
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

function normalizeSearchQuery(raw: string): string {
  const ascii = normalizeArabicDigits(raw);
  const trimmed = ascii.trim();
  if (!trimmed) return '';
  if (/^[\d\s+().-]+$/.test(trimmed)) {
    return trimmed.replace(/[\s+().-]/g, '');
  }
  return trimmed;
}

function normalizePhoneQueryForGowa(raw: string): string {
  const normalized = normalizeSearchQuery(raw);
  if (/^0\d+$/.test(normalized)) {
    const stripped = normalized.replace(/^0+/, '');
    if (stripped.length >= 3) {
      return stripped;
    }
  }
  return normalized;
}

function matchesUnifiedChatSearch(
  chat: GowaChatInfo,
  deviceDisplayName: string,
  rawQuery: string,
  contactName?: string,
): boolean {
  const normalized = normalizeSearchQuery(rawQuery).toLowerCase();
  if (!normalized) return true;

  const isDigitsOnly = /^\d+$/.test(normalized);
  const strippedLeadingZero = isDigitsOnly ? normalized.replace(/^0+/, '') : '';
  const at = chat.jid.indexOf('@');
  const localJid = at === -1 ? chat.jid : chat.jid.slice(0, at);
  const phonePart = localJid.split(':')[0] ?? localJid;

  const candidates = [chat.name, contactName, phonePart, chat.jid, deviceDisplayName];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const lowered = normalizeArabicDigits(candidate).toLowerCase();
    if (lowered.includes(normalized)) return true;
    if (isDigitsOnly) {
      const compactDigits = lowered.replace(/[^\d]/g, '');
      if (compactDigits.includes(normalized)) return true;
      if (strippedLeadingZero.length >= 3 && compactDigits.includes(strippedLeadingZero)) {
        return true;
      }
    }
  }
  return false;
}

const AVATAR_OK_TTL_MS = 1000 * 60 * 60 * 24;
const AVATAR_NONE_TTL_MS = 1000 * 60 * 60;
const avatarInflight = new Map<string, Promise<CachedAvatarRow | null>>();

function decodeImageUpload(
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

async function createApp(): Promise<void> {
  const app = express();
  const server = http.createServer(app);
  const wsBridge = new GowaWsBridge(server);

  app.disable('x-powered-by');
  app.use(express.json({limit: '8mb'}));
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  // =========================================================================
  // Auth & Setup
  // =========================================================================
  app.get('/api/auth/status', (req: AuthedRequest, res) => {
    const envPasscode = (process.env.ADMIN_PASSCODE || '').trim();
    const initialized = hasAnyUsers() || envPasscode.length > 0;
    const token = extractBearerToken(req);
    const user = token ? getSessionUser(token) : null;
    const gowa = getGowaConfig();
    res.json({
      code: 'SUCCESS',
      message: 'ok',
      results: {
        initialized,
        authenticated: Boolean(user),
        user,
        gowaConfigured: Boolean(gowa.url),
      },
    });
  });

  app.post('/api/auth/setup', (req, res) => {
    const envPasscode = (process.env.ADMIN_PASSCODE || '').trim();
    if (envPasscode.length > 0) {
      res.status(403).json({
        code: 'SETUP_LOCKED',
        message: 'تم تعطيل الإعداد الأولي لأن رمز المسؤول محدد في إعدادات البيئة',
      });
      return;
    }

    const body = req.body as {
      display_name?: unknown;
      username?: unknown;
      password?: unknown;
      gowa_url?: unknown;
      gowa_username?: unknown;
      gowa_password?: unknown;
    };

    const displayName = typeof body.display_name === 'string' ? body.display_name.trim() : '';
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const gowaUrl = typeof body.gowa_url === 'string' ? body.gowa_url.trim() : '';
    const gowaUsername = typeof body.gowa_username === 'string' ? body.gowa_username.trim() : '';
    const gowaPassword = typeof body.gowa_password === 'string' ? body.gowa_password : '';

    if (displayName.length < 2) {
      res.status(400).json({code: 'VALIDATION_ERROR', message: 'يرجى إدخال اسم المسؤول الكامل'});
      return;
    }
    if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
      res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: 'اسم الدخول يجب أن يكون بين 3 و 32 حرفًا إنجليزيًا أو رقمًا',
      });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: 'كلمة المرور يجب أن لا تقل عن 8 أحرف',
      });
      return;
    }

    if (gowaUrl) {
      try {
        validateGowaUrl(gowaUrl);
      } catch (err) {
        handleRouteError(res, err);
        return;
      }
    }

    try {
      db.exec('BEGIN IMMEDIATE');
      if (hasAnyUsers()) {
        db.exec('ROLLBACK');
        res.status(409).json({
          code: 'ALREADY_INITIALIZED',
          message: 'تم إعداد النظام مسبقًا، يرجى تسجيل الدخول',
        });
        return;
      }

      const adminUser = createUser({
        username,
        display_name: displayName,
        role: 'admin',
        password,
      });

      if (gowaUrl) {
        setGowaConfig({
          url: gowaUrl,
          username: gowaUsername,
          password: gowaPassword,
        });
      }

      const token = createSession(adminUser.id);
      db.exec('COMMIT');

      if (gowaUrl) {
        wsBridge.resetAndReconnect();
      }

      res.status(201).json({
        code: 'SUCCESS',
        message: 'تم إنشاء حساب المسؤول الأول بنجاح',
        results: {token, user: adminUser},
      });
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // ignore
      }
      handleRouteError(res, err);
    }
  });

  app.post('/api/auth/login', (req, res) => {
    const body = req.body as {username?: unknown; password?: unknown};
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (!username || !password) {
      res.status(400).json({code: 'VALIDATION_ERROR', message: 'يرجى إدخال اسم الدخول وكلمة المرور'});
      return;
    }

    const envPasscode = (process.env.ADMIN_PASSCODE || '').trim();
    if (
      envPasscode.length > 0 &&
      username.toLowerCase() === 'admin' &&
      safeComparePasscode(password, envPasscode)
    ) {
      const existingUsers = listUsers();
      let admin = existingUsers.find((u) => u.role === 'admin' && u.is_active);
      if (!admin) {
        admin = createUser({
          username: 'admin',
          display_name: 'المسؤول',
          role: 'admin',
          password: crypto.randomBytes(24).toString('hex'),
        });
      }
      const token = createSession(admin.id);
      res.json({code: 'SUCCESS', message: 'تم تسجيل الدخول بنجاح', results: {token, user: admin}});
      return;
    }

    const user = authenticateUser(username, password);
    if (!user) {
      res.status(401).json({code: 'INVALID_CREDENTIALS', message: 'اسم الدخول أو كلمة المرور غير صحيحة'});
      return;
    }

    const token = createSession(user.id);
    res.json({code: 'SUCCESS', message: 'تم تسجيل الدخول بنجاح', results: {token, user}});
  });

  app.post('/api/auth/logout', requireAuth, (req: AuthedRequest, res) => {
    if (req.authToken) {
      deleteSession(req.authToken);
    }
    res.json({code: 'SUCCESS', message: 'تم تسجيل الخروج'});
  });

  app.get('/api/auth/me', requireAuth, (req: AuthedRequest, res) => {
    res.json({code: 'SUCCESS', message: 'ok', results: req.user});
  });

  app.put('/api/me/preferences', requireAuth, (req: AuthedRequest, res) => {
    const body = req.body as {theme?: unknown; language?: unknown};
    const patch: {theme?: ThemePreference; language?: LanguagePreference} = {};

    if (body.theme !== undefined) {
      if (body.theme !== 'light' && body.theme !== 'dark' && body.theme !== 'system') {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'قيمة السمة غير صالحة'});
        return;
      }
      patch.theme = body.theme;
    }

    if (body.language !== undefined) {
      if (body.language !== 'ar' && body.language !== 'en') {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'قيمة اللغة غير صالحة'});
        return;
      }
      patch.language = body.language;
    }

    if (patch.theme === undefined && patch.language === undefined) {
      res.status(400).json({code: 'VALIDATION_ERROR', message: 'يرجى تحديد تفضيل للتحديث'});
      return;
    }

    setUserPreferences(req.user!.id, patch);
    const updated = getUserById(req.user!.id);
    res.json({code: 'SUCCESS', message: 'تم حفظ التفضيلات', results: updated});
  });

  app.post('/api/auth/ws-ticket', requireAuth, (req: AuthedRequest, res) => {
    const ticket = issueWsTicket(req.user!);
    res.json({code: 'SUCCESS', message: 'ok', results: {ticket}});
  });

  // =========================================================================
  // Users / Agents Management (Admin only)
  // =========================================================================
  app.get('/api/users', requireAuth, requireAdmin, (_req, res) => {
    res.json({code: 'SUCCESS', message: 'ok', results: listUsers()});
  });

  app.post('/api/users', requireAuth, requireAdmin, (req, res) => {
    const body = req.body as {
      username?: unknown;
      display_name?: unknown;
      password?: unknown;
      role?: unknown;
    };
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const displayName = typeof body.display_name === 'string' ? body.display_name.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const role: UserRole = body.role === 'admin' ? 'admin' : 'agent';

    if (displayName.length < 2) {
      res.status(400).json({code: 'VALIDATION_ERROR', message: 'الاسم الكامل مطلوب'});
      return;
    }
    if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
      res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: 'اسم الدخول يجب أن يكون بين 3 و 32 حرفًا إنجليزيًا أو رقمًا',
      });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: 'كلمة المرور يجب أن لا تقل عن 8 أحرف',
      });
      return;
    }

    try {
      const created = createUser({username, display_name: displayName, role, password});
      res.status(201).json({code: 'SUCCESS', message: 'تم إضافة المستخدم بنجاح', results: created});
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (msg.includes('UNIQUE')) {
        res.status(409).json({code: 'USERNAME_TAKEN', message: 'اسم الدخول مستخدم بالفعل'});
        return;
      }
      handleRouteError(res, err);
    }
  });

  app.patch('/api/users/:id', requireAuth, requireAdmin, (req: AuthedRequest, res) => {
    const targetId = Number(req.params.id);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف المستخدم غير صالح'});
      return;
    }
    const existing = getUserById(targetId);
    if (!existing) {
      res.status(404).json({code: 'NOT_FOUND', message: 'المستخدم غير موجود'});
      return;
    }

    const body = req.body as {
      display_name?: unknown;
      role?: unknown;
      is_active?: unknown;
      password?: unknown;
    };

    const nextRole =
      body.role === 'admin' || body.role === 'agent' ? (body.role as UserRole) : existing.role;
    const nextActive =
      typeof body.is_active === 'boolean' ? body.is_active : existing.is_active;

    if (
      existing.role === 'admin' &&
      existing.is_active &&
      (nextRole !== 'admin' || !nextActive) &&
      countActiveAdmins() <= 1
    ) {
      res.status(400).json({
        code: 'LAST_ADMIN_PROTECTED',
        message: 'لا يمكن تعطيل أو تخفيض صلاحية آخر مسؤول نشط في النظام',
      });
      return;
    }

    const password =
      typeof body.password === 'string' && body.password.length > 0 ? body.password : undefined;
    if (password !== undefined && password.length < 8) {
      res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: 'كلمة المرور الجديدة يجب أن لا تقل عن 8 أحرف',
      });
      return;
    }

    const displayName =
      typeof body.display_name === 'string' && body.display_name.trim().length >= 2
        ? body.display_name.trim()
        : undefined;

    const updated = updateUser(targetId, {
      display_name: displayName,
      role: nextRole,
      is_active: nextActive,
      password,
    });
    res.json({code: 'SUCCESS', message: 'تم تحديث بيانات المستخدم', results: updated});
  });

  app.delete('/api/users/:id', requireAuth, requireAdmin, (req: AuthedRequest, res) => {
    const targetId = Number(req.params.id);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف المستخدم غير صالح'});
      return;
    }
    if (targetId === req.user!.id) {
      res.status(400).json({code: 'CANNOT_DELETE_SELF', message: 'لا يمكنك حذف حسابك الحالي'});
      return;
    }
    const existing = getUserById(targetId);
    if (!existing) {
      res.status(404).json({code: 'NOT_FOUND', message: 'المستخدم غير موجود'});
      return;
    }
    if (existing.role === 'admin' && existing.is_active && countActiveAdmins() <= 1) {
      res.status(400).json({
        code: 'LAST_ADMIN_PROTECTED',
        message: 'لا يمكن حذف آخر مسؤول نشط في النظام',
      });
      return;
    }
    deleteUser(targetId);
    res.json({code: 'SUCCESS', message: 'تم حذف المستخدم'});
  });

  // =========================================================================
  // gowa Settings (Admin only)
  // =========================================================================
  app.get('/api/settings/gowa', requireAuth, requireAdmin, (_req, res) => {
    const config = getGowaConfig();
    res.json({
      code: 'SUCCESS',
      message: 'ok',
      results: {
        gowa_url: config.url,
        gowa_username: config.username,
        has_password: Boolean(config.password),
      },
    });
  });

  app.put('/api/settings/gowa', requireAuth, requireAdmin, (req, res) => {
    const body = req.body as {
      gowa_url?: unknown;
      gowa_username?: unknown;
      gowa_password?: unknown;
      clear_password?: unknown;
    };
    const rawUrl = typeof body.gowa_url === 'string' ? body.gowa_url.trim() : '';
    const username = typeof body.gowa_username === 'string' ? body.gowa_username.trim() : '';
    const clearPassword = body.clear_password === true;
    const password =
      clearPassword
        ? ''
        : typeof body.gowa_password === 'string' && body.gowa_password.length > 0
          ? body.gowa_password
          : undefined;

    if (rawUrl) {
      try {
        validateGowaUrl(rawUrl);
      } catch (err) {
        handleRouteError(res, err);
        return;
      }
    }

    setGowaConfig({
      url: rawUrl,
      username,
      password,
    });
    wsBridge.resetAndReconnect();

    const updated = getGowaConfig();
    res.json({
      code: 'SUCCESS',
      message: 'تم حفظ إعدادات خادم gowa',
      results: {
        gowa_url: updated.url,
        gowa_username: updated.username,
        has_password: Boolean(updated.password),
      },
    });
  });

  app.post('/api/settings/gowa/test', requireAuth, requireAdmin, async (req, res) => {
    const body = req.body as {
      gowa_url?: unknown;
      gowa_username?: unknown;
      gowa_password?: unknown;
    };
    const saved = getGowaConfig();
    const url = typeof body.gowa_url === 'string' ? body.gowa_url.trim() : saved.url;
    const username =
      typeof body.gowa_username === 'string' ? body.gowa_username.trim() : saved.username;
    const password =
      typeof body.gowa_password === 'string' && body.gowa_password.length > 0
        ? body.gowa_password
        : saved.password;

    const result = await probeGowa({url, username, password});
    res.json({
      code: result.ok ? 'SUCCESS' : result.code || 'FAILED',
      message: result.ok
        ? `تم الاتصال بنجاح (${result.devicesCount} حساب)`
        : result.error || 'فشل الاتصال',
      results: result,
    });
  });

  // =========================================================================
  // Accounts / Devices (Admin-only management; lightweight summary for Agents)
  // =========================================================================
  app.get('/api/unified/accounts', requireAuth, async (_req, res) => {
    const aliases = getAccountAliases();
    try {
      const devices = (await gowaFetch<GowaDevice[]>('/devices')) ?? [];
      const summary = devices.map((device) => ({
        id: device.id,
        display_name: resolveAccountDisplayName(device, aliases),
        phone_number: device.phone_number ?? null,
        state: device.state,
        jid: device.jid ?? null,
      }));
      res.json({code: 'SUCCESS', message: 'ok', results: summary});
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  app.get('/api/devices', requireAuth, requireAdmin, async (_req, res) => {
    try {
      const aliases = getAccountAliases();
      const devices = (await gowaFetch<GowaDevice[]>('/devices')) ?? [];
      const enriched = devices.map((device) => ({
        ...device,
        alias: aliases[device.id] ?? '',
        resolved_name: resolveAccountDisplayName(device, aliases),
      }));
      res.json({code: 'SUCCESS', message: 'ok', results: enriched});
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  app.post('/api/devices', requireAuth, requireAdmin, async (req, res) => {
    const body = req.body as {device_id?: unknown; display_name?: unknown};
    const deviceId = typeof body.device_id === 'string' ? body.device_id.trim() : '';
    const displayName = typeof body.display_name === 'string' ? body.display_name.trim() : '';
    try {
      const created = await gowaFetch<GowaDevice>('/devices', {
        method: 'POST',
        body: deviceId ? {device_id: deviceId} : {},
      });
      if (displayName && created?.id) {
        setAccountAlias(created.id, displayName);
      }
      wsBridge.resetAndReconnect();
      res.status(201).json({
        code: 'SUCCESS',
        message: 'تم إضافة الحساب بنجاح',
        results: {
          ...created,
          alias: displayName,
          resolved_name: displayName || created?.display_name || created?.id,
        },
      });
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  app.patch('/api/devices/:id/alias', requireAuth, requireAdmin, (req, res) => {
    const deviceId = decodeURIComponent(req.params.id);
    const body = req.body as {alias?: unknown};
    const alias = typeof body.alias === 'string' ? body.alias.trim() : '';
    const aliases = setAccountAlias(deviceId, alias);
    res.json({
      code: 'SUCCESS',
      message: 'تم تحديث اسم عرض الحساب',
      results: {device_id: deviceId, alias: aliases[deviceId] ?? ''},
    });
  });

  app.delete('/api/devices/:id', requireAuth, requireAdmin, async (req, res) => {
    const deviceId = decodeURIComponent(req.params.id);
    try {
      await gowaFetch(`/devices/${encodeURIComponent(deviceId)}`, {method: 'DELETE'});
      setAccountAlias(deviceId, '');
      wsBridge.resetAndReconnect();
      res.json({code: 'SUCCESS', message: 'تم حذف الحساب'});
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  app.get('/api/devices/:id/login', requireAuth, requireAdmin, async (req, res) => {
    const deviceId = decodeURIComponent(req.params.id);
    try {
      const qr = await gowaFetch<GowaLoginQr>(`/devices/${encodeURIComponent(deviceId)}/login`);
      res.json({code: 'SUCCESS', message: 'ok', results: qr});
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  app.post('/api/devices/:id/login/code', requireAuth, requireAdmin, async (req, res) => {
    const deviceId = decodeURIComponent(req.params.id);
    const body = req.body as {phone?: unknown};
    const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
    if (!phone) {
      res.status(400).json({code: 'VALIDATION_ERROR', message: 'رقم الهاتف مطلوب'});
      return;
    }
    try {
      const code = await gowaFetch<GowaPairCode>(
        `/devices/${encodeURIComponent(deviceId)}/login/code`,
        {method: 'POST', query: {phone}},
      );
      res.json({code: 'SUCCESS', message: 'ok', results: code});
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  app.post('/api/devices/:id/logout', requireAuth, requireAdmin, async (req, res) => {
    const deviceId = decodeURIComponent(req.params.id);
    try {
      await gowaFetch(`/devices/${encodeURIComponent(deviceId)}/logout`, {method: 'POST'});
      res.json({code: 'SUCCESS', message: 'تم تسجيل خروج الحساب'});
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  app.post('/api/devices/:id/reconnect', requireAuth, requireAdmin, async (req, res) => {
    const deviceId = decodeURIComponent(req.params.id);
    try {
      await gowaFetch(`/devices/${encodeURIComponent(deviceId)}/reconnect`, {method: 'POST'});
      res.json({code: 'SUCCESS', message: 'تم إرسال طلب إعادة الاتصال'});
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  app.get('/api/devices/:id/status', requireAuth, requireAdmin, async (req, res) => {
    const deviceId = decodeURIComponent(req.params.id);
    try {
      const status = await gowaFetch<GowaDeviceStatus>(
        `/devices/${encodeURIComponent(deviceId)}/status`,
      );
      res.json({code: 'SUCCESS', message: 'ok', results: status});
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  app.get('/api/devices/:id/qr-image', requireAuth, requireAdmin, async (req, res) => {
    const qrPath = typeof req.query.path === 'string' ? req.query.path : '';
    try {
      const asset = await gowaFetchBinary(qrPath);
      res.setHeader('Content-Type', asset.contentType);
      res.setHeader('Cache-Control', 'no-store');
      res.send(asset.buffer);
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  // =========================================================================
  // Unified Chat Inbox (Admin + Agent)
  // =========================================================================
  app.get('/api/unified/chats', requireAuth, async (req, res) => {
    const filterDeviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId.trim() : '';
    const filterDeviceIdsRaw =
      typeof req.query.deviceIds === 'string' ? req.query.deviceIds.trim() : '';
    const rawSearch = typeof req.query.search === 'string' ? req.query.search : '';
    const search = normalizePhoneQueryForGowa(rawSearch);
    const hasMedia = req.query.has_media === 'true';

    const selectedDeviceSet = new Set<string>();
    if (filterDeviceIdsRaw) {
      for (const part of filterDeviceIdsRaw.split(',')) {
        const clean = part.trim();
        if (clean) selectedDeviceSet.add(clean);
      }
    }
    if (filterDeviceId) {
      selectedDeviceSet.add(filterDeviceId);
    }

    try {
      const aliases = getAccountAliases();
      const devices = (await gowaFetch<GowaDevice[]>('/devices')) ?? [];
      const accountMap = new Map<string, {device: GowaDevice; displayName: string}>();
      for (const dev of devices) {
        accountMap.set(dev.id, {
          device: dev,
          displayName: resolveAccountDisplayName(dev, aliases),
        });
      }

      const targetDevices =
        selectedDeviceSet.size > 0
          ? devices.filter((d) => selectedDeviceSet.has(d.id))
          : devices;

      const deviceErrors: Array<{device_id: string; display_name: string; message: string}> = [];
      const allChats: Array<
        GowaChatInfo & {
          device_id: string;
          device_display_name: string;
          device_state: GowaDevice['state'];
        }
      > = [];

      await Promise.all(
        targetDevices.map(async (dev) => {
          const displayName = resolveAccountDisplayName(dev, aliases);
          if (dev.state !== 'logged_in' && dev.state !== 'connected') {
            deviceErrors.push({
              device_id: dev.id,
              display_name: displayName,
              message: 'الحساب غير متصل حاليًا',
            });
            return;
          }
          try {
            if (!rawSearch.trim()) {
              const response = await gowaFetch<{data: GowaChatInfo[]; pagination: GowaPagination}>(
                '/chats',
                {
                  deviceId: dev.id,
                  query: {
                    limit: 100,
                    offset: 0,
                    has_media: hasMedia ? true : undefined,
                  },
                },
              );
              const items = response?.data ?? [];
              for (const chat of items) {
                allChats.push({
                  ...chat,
                  device_id: dev.id,
                  device_display_name: displayName,
                  device_state: dev.state,
                });
              }
              return;
            }

            const byJid = new Map<string, GowaChatInfo>();
            const directHitJids = new Set<string>();
            const PAGE_LIMIT = 100;
            const MAX_SCAN_CHATS = 1000;

            const [directSearchRes, contactsRes] = await Promise.all([
              search
                ? gowaFetch<{data: GowaChatInfo[]; pagination: GowaPagination}>('/chats', {
                    deviceId: dev.id,
                    query: {
                      limit: 100,
                      offset: 0,
                      search,
                      has_media: hasMedia ? true : undefined,
                    },
                  }).catch(() => null)
                : Promise.resolve(null),
              gowaFetch<{data?: Array<{jid?: string; name?: string}>} | null>('/user/my/contacts', {
                deviceId: dev.id,
                timeoutMs: 4_000,
              }).catch(() => null),
            ]);

            for (const chat of directSearchRes?.data ?? []) {
              byJid.set(chat.jid, chat);
              directHitJids.add(chat.jid);
            }

            const contactNameByJid = new Map<string, string>();
            for (const c of contactsRes?.data ?? []) {
              if (c.jid && c.name) {
                contactNameByJid.set(c.jid, c.name);
              }
            }

            for (let offset = 0; offset < MAX_SCAN_CHATS; offset += PAGE_LIMIT) {
              const page = await gowaFetch<{data: GowaChatInfo[]; pagination: GowaPagination}>(
                '/chats',
                {
                  deviceId: dev.id,
                  query: {
                    limit: PAGE_LIMIT,
                    offset,
                    has_media: hasMedia ? true : undefined,
                  },
                },
              );
              const items = page?.data ?? [];
              for (const chat of items) {
                if (!byJid.has(chat.jid)) {
                  byJid.set(chat.jid, chat);
                }
              }
              const total = page?.pagination?.total ?? 0;
              if (items.length < PAGE_LIMIT || (total > 0 && offset + items.length >= total)) {
                break;
              }
            }

            for (const chat of byJid.values()) {
              const contactName = contactNameByJid.get(chat.jid);
              if (
                directHitJids.has(chat.jid) ||
                matchesUnifiedChatSearch(chat, displayName, rawSearch, contactName)
              ) {
                allChats.push({
                  ...chat,
                  name: chat.name?.trim() || contactName || chat.name,
                  device_id: dev.id,
                  device_display_name: displayName,
                  device_state: dev.state,
                });
              }
            }
          } catch (err) {
            const msg = err instanceof GowaError ? err.message : 'تعذر جلب المحادثات';
            deviceErrors.push({
              device_id: dev.id,
              display_name: displayName,
              message: msg,
            });
          }
        }),
      );

      allChats.sort((a, b) => {
        const ta = new Date(a.last_message_time).getTime();
        const tb = new Date(b.last_message_time).getTime();
        const validA = Number.isNaN(ta) || ta <= 0 ? 0 : ta;
        const validB = Number.isNaN(tb) || tb <= 0 ? 0 : tb;
        return validB - validA;
      });

      res.json({
        code: 'SUCCESS',
        message: 'ok',
        results: {
          data: allChats,
          total: allChats.length,
          accounts: devices.map((d) => ({
            id: d.id,
            display_name: resolveAccountDisplayName(d, aliases),
            phone_number: d.phone_number ?? null,
            state: d.state,
          })),
          device_errors: deviceErrors,
        },
      });
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  app.get('/api/unified/chats/:deviceId/:jid/messages', requireAuth, async (req, res) => {
    const deviceId = decodeURIComponent(req.params.deviceId);
    const chatJid = decodeURIComponent(req.params.jid);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const rawSearch = typeof req.query.search === 'string' ? req.query.search : '';
    const search = normalizeSearchQuery(rawSearch);
    const mediaOnly = req.query.media_only === 'true';

    try {
      const data = await gowaFetch<{
        data: GowaMessageInfo[];
        pagination: GowaPagination;
        chat_info: GowaChatInfo;
      }>(`/chat/${encodeURIComponent(chatJid)}/messages`, {
        deviceId,
        query: {
          limit,
          offset,
          search: search || undefined,
          media_only: mediaOnly ? true : undefined,
        },
      });
      res.json({code: 'SUCCESS', message: 'ok', results: data});
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  app.post('/api/unified/chats/:deviceId/:jid/history', requireAuth, async (req, res) => {
    const deviceId = decodeURIComponent(req.params.deviceId);
    const chatJid = decodeURIComponent(req.params.jid);
    const body = req.body as {count?: unknown};
    const count = Math.min(Math.max(Number(body.count) || 50, 1), 200);
    try {
      const result = await gowaFetch(`/chat/${encodeURIComponent(chatJid)}/history`, {
        method: 'POST',
        deviceId,
        body: {count},
      });
      res.json({code: 'SUCCESS', message: 'تم طلب الرسائل الأقدم من الهاتف', results: result});
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  app.post('/api/unified/chats/:deviceId/:jid/send', requireAuth, async (req, res) => {
    const deviceId = decodeURIComponent(req.params.deviceId);
    const chatJid = decodeURIComponent(req.params.jid);
    const body = req.body as {message?: unknown; reply_message_id?: unknown};
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    const replyMessageId =
      typeof body.reply_message_id === 'string' && body.reply_message_id.trim()
        ? body.reply_message_id.trim()
        : undefined;

    if (!message) {
      res.status(400).json({code: 'VALIDATION_ERROR', message: 'نص الرسالة مطلوب'});
      return;
    }

    try {
      // Verify the receiving account is connected and logged in before sending.
      const status = await gowaFetch<GowaDeviceStatus>(
        `/devices/${encodeURIComponent(deviceId)}/status`,
      );
      if (!status?.is_logged_in) {
        res.status(409).json({
          code: 'DEVICE_NOT_CONNECTED',
          message: 'هذا الحساب غير متصل حاليًا بواتساب. يرجى إعادة ربط الحساب قبل الإرسال.',
        });
        return;
      }

      const payload: Record<string, unknown> = {
        phone: chatJid,
        message,
      };
      if (replyMessageId) {
        payload.reply_message_id = replyMessageId;
      }

      const sent = await gowaFetch<{message_id: string; status: string}>('/send/message', {
        method: 'POST',
        deviceId,
        body: payload,
      });

      res.json({
        code: 'SUCCESS',
        message: 'تم إرسال الرسالة',
        results: sent,
      });
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  app.get('/api/unified/media/download', requireAuth, async (req, res) => {
    const deviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId.trim() : '';
    const messageId = typeof req.query.messageId === 'string' ? req.query.messageId.trim() : '';
    const phone = typeof req.query.phone === 'string' ? req.query.phone.trim() : '';
    const fallbackUrl =
      typeof req.query.fallbackUrl === 'string' ? req.query.fallbackUrl.trim() : '';
    if (!deviceId || !messageId || !phone) {
      res.status(400).json({code: 'VALIDATION_ERROR', message: 'معلمات الوسائط غير مكتملة'});
      return;
    }

    try {
      let downloaded: GowaDownloadedMedia | null = null;
      try {
        const result = await gowaFetch<GowaDownloadedMedia | null>(
          `/message/${encodeURIComponent(messageId)}/download`,
          {
            deviceId,
            query: {phone},
            timeoutMs: 25_000,
          },
        );
        if (result && (result.file_path || result.file_url)) {
          downloaded = result;
        }
      } catch (err) {
        if (!fallbackUrl) throw err;
      }

      if (!downloaded && fallbackUrl && !fallbackUrl.includes('mmg.whatsapp.net')) {
        downloaded = {
          message_id: messageId,
          media_type: '',
          filename: fallbackUrl.split('/').pop()?.split('?')[0] || '',
          file_path: fallbackUrl,
          file_size: 0,
        };
      }

      if (!downloaded || (!downloaded.file_path && !downloaded.file_url)) {
        res.status(404).json({
          code: 'MEDIA_NOT_AVAILABLE',
          message: 'ملف الوسائط غير متوفر على الخادم حاليًا',
        });
        return;
      }

      res.json({code: 'SUCCESS', message: 'ok', results: downloaded});
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  app.get('/api/unified/media/file', requireAuth, async (req, res) => {
    const filePath = typeof req.query.path === 'string' ? req.query.path : '';
    try {
      const asset = await gowaFetchBinary(filePath);
      res.setHeader('Content-Type', asset.contentType);
      if (asset.filename) {
        res.setHeader(
          'Content-Disposition',
          `inline; filename="${asset.filename.replace(/["\r\n]/g, '')}"`,
        );
      }
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.send(asset.buffer);
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  app.get('/api/unified/avatar', requireAuth, async (req, res) => {
    const deviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId.trim() : '';
    const jid = typeof req.query.jid === 'string' ? req.query.jid.trim() : '';
    const force = req.query.force === 'true';

    if (!deviceId || !jid) {
      res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف الحساب والمستلم مطلوبان'});
      return;
    }
    if (jid === 'status@broadcast') {
      res.status(204).end();
      return;
    }

    const cached = getCachedAvatar(deviceId, jid);
    if (!force && cached) {
      const age = Date.now() - cached.updated_at;
      if (cached.status === 'ok' && cached.image_blob && cached.image_blob.byteLength > 0 && age < AVATAR_OK_TTL_MS) {
        res.setHeader('Content-Type', cached.content_type || 'image/jpeg');
        res.setHeader('Cache-Control', 'private, max-age=3600');
        res.send(Buffer.from(cached.image_blob));
        return;
      }
      if (cached.status === 'none' && age < AVATAR_NONE_TTL_MS) {
        res.status(204).end();
        return;
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
          if (err instanceof GowaError && (err.status === 400 || err.status === 404 || err.code.startsWith('AVATAR_'))) {
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

    const resolved = await pending;
    if (resolved && resolved.status === 'ok' && resolved.image_blob && resolved.image_blob.byteLength > 0) {
      res.setHeader('Content-Type', resolved.content_type || 'image/jpeg');
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.send(Buffer.from(resolved.image_blob));
      return;
    }
    res.status(204).end();
  });

  // =========================================================================
  // Scheduled Messages (Admin only, per-device)
  // =========================================================================
  app.get('/api/devices/:deviceId/schedules', requireAuth, requireAdmin, async (req, res) => {
    const deviceId = decodeURIComponent(req.params.deviceId);
    const status = typeof req.query.status === 'string' ? req.query.status.trim() : undefined;
    const rawSearch = typeof req.query.search === 'string' ? req.query.search : '';
    const search = normalizePhoneQueryForGowa(rawSearch) || undefined;
    const messageType =
      typeof req.query.message_type === 'string' ? req.query.message_type.trim() : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : 25;
    const offset = req.query.offset ? Number(req.query.offset) : 0;

    try {
      const data = await gowaFetch('/send/schedules', {
        deviceId,
        query: {
          status: status && status !== 'all' ? status : undefined,
          search: search || undefined,
          message_type: messageType && messageType !== 'all' ? messageType : undefined,
          limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 100) : 25,
          offset: Number.isFinite(offset) ? Math.max(offset, 0) : 0,
        },
      });
      res.json({code: 'SUCCESS', message: 'ok', results: data});
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  app.post('/api/devices/:deviceId/schedules', requireAuth, requireAdmin, async (req, res) => {
    const deviceId = decodeURIComponent(req.params.deviceId);
    const body = req.body as {
      phone?: unknown;
      message?: unknown;
      scheduled_at?: unknown;
      timezone?: unknown;
      recurrence?: unknown;
      weekdays?: unknown;
      day_of_month?: unknown;
      end_at?: unknown;
      occurrence_limit?: unknown;
    };
    const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    const scheduledAt = typeof body.scheduled_at === 'string' ? body.scheduled_at.trim() : '';
    const timezone = typeof body.timezone === 'string' ? body.timezone.trim() : '';
    const recurrence = typeof body.recurrence === 'string' ? body.recurrence.trim() : 'once';

    if (!phone || !message || !scheduledAt) {
      res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: 'الرقم ونص الرسالة وموعد الإرسال مطلوبون',
      });
      return;
    }

    const payload: Record<string, unknown> = {
      phone,
      message,
      scheduled_at: scheduledAt,
      recurrence,
    };
    if (timezone) payload.timezone = timezone;
    if (Array.isArray(body.weekdays) && body.weekdays.length > 0) {
      payload.weekdays = body.weekdays.filter((d) => Number.isInteger(d));
    }
    if (typeof body.day_of_month === 'number' && Number.isInteger(body.day_of_month)) {
      payload.day_of_month = body.day_of_month;
    }
    if (typeof body.end_at === 'string' && body.end_at.trim()) {
      payload.end_at = body.end_at.trim();
    }
    if (typeof body.occurrence_limit === 'number' && body.occurrence_limit > 0) {
      payload.occurrence_limit = body.occurrence_limit;
    }

    try {
      const result = await gowaFetch('/send/message', {
        method: 'POST',
        deviceId,
        body: payload,
      });
      res.status(201).json({code: 'SUCCESS', message: 'تمت جدولة الرسالة', results: result});
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  app.post(
    '/api/devices/:deviceId/schedules/:id/:action',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const deviceId = decodeURIComponent(req.params.deviceId);
      const scheduleId = decodeURIComponent(req.params.id);
      const action = req.params.action;
      if (action !== 'pause' && action !== 'resume' && action !== 'cancel') {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'إجراء غير صالح'});
        return;
      }
      try {
        await gowaFetch(`/send/schedules/${encodeURIComponent(scheduleId)}/${action}`, {
          method: 'POST',
          deviceId,
        });
        res.json({code: 'SUCCESS', message: 'تم تحديث الجدولة'});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  // =========================================================================
  // Groups Management (Admin only, per-device)
  // =========================================================================
  app.get('/api/devices/:deviceId/groups', requireAuth, requireAdmin, async (req, res) => {
    const deviceId = decodeURIComponent(req.params.deviceId);
    try {
      const data = await gowaFetch<{data?: unknown[]} | null>('/user/my/groups', {deviceId});
      res.json({code: 'SUCCESS', message: 'ok', results: data?.data ?? []});
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  app.post('/api/devices/:deviceId/groups', requireAuth, requireAdmin, async (req, res) => {
    const deviceId = decodeURIComponent(req.params.deviceId);
    const body = req.body as {title?: unknown; participants?: unknown};
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const participants = Array.isArray(body.participants)
      ? body.participants.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
      : [];
    if (!title) {
      res.status(400).json({code: 'VALIDATION_ERROR', message: 'اسم المجموعة مطلوب'});
      return;
    }
    try {
      const result = await gowaFetch('/group', {
        method: 'POST',
        deviceId,
        body: {title, participants},
      });
      res.status(201).json({code: 'SUCCESS', message: 'تم إنشاء المجموعة', results: result});
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  app.post(
    '/api/devices/:deviceId/groups/join-with-link',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const deviceId = decodeURIComponent(req.params.deviceId);
      const body = req.body as {link?: unknown};
      const link = typeof body.link === 'string' ? body.link.trim() : '';
      if (!link) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'رابط الدعوة مطلوب'});
        return;
      }
      try {
        const result = await gowaFetch('/group/join-with-link', {
          method: 'POST',
          deviceId,
          body: {link},
        });
        res.json({code: 'SUCCESS', message: 'تم الانضمام للمجموعة', results: result});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  app.get(
    '/api/devices/:deviceId/groups/info-from-link',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const deviceId = decodeURIComponent(req.params.deviceId);
      const link = typeof req.query.link === 'string' ? req.query.link.trim() : '';
      if (!link) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'رابط الدعوة مطلوب'});
        return;
      }
      try {
        const result = await gowaFetch('/group/info-from-link', {
          deviceId,
          query: {link},
        });
        res.json({code: 'SUCCESS', message: 'ok', results: result});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  app.get('/api/devices/:deviceId/groups/info', requireAuth, requireAdmin, async (req, res) => {
    const deviceId = decodeURIComponent(req.params.deviceId);
    const groupId = typeof req.query.group_id === 'string' ? req.query.group_id.trim() : '';
    if (!groupId) {
      res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف المجموعة مطلوب'});
      return;
    }
    try {
      const result = await gowaFetch('/group/info', {
        deviceId,
        query: {group_id: groupId},
      });
      res.json({code: 'SUCCESS', message: 'ok', results: result});
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  app.post('/api/devices/:deviceId/groups/leave', requireAuth, requireAdmin, async (req, res) => {
    const deviceId = decodeURIComponent(req.params.deviceId);
    const body = req.body as {group_id?: unknown};
    const groupId = typeof body.group_id === 'string' ? body.group_id.trim() : '';
    if (!groupId) {
      res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف المجموعة مطلوب'});
      return;
    }
    try {
      await gowaFetch('/group/leave', {
        method: 'POST',
        deviceId,
        body: {group_id: groupId},
      });
      res.json({code: 'SUCCESS', message: 'تمت مغادرة المجموعة'});
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  app.get(
    '/api/devices/:deviceId/groups/participants',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const deviceId = decodeURIComponent(req.params.deviceId);
      const groupId = typeof req.query.group_id === 'string' ? req.query.group_id.trim() : '';
      if (!groupId) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف المجموعة مطلوب'});
        return;
      }
      try {
        const result = await gowaFetch('/group/participants', {
          deviceId,
          query: {group_id: groupId},
        });
        res.json({code: 'SUCCESS', message: 'ok', results: result});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  app.get(
    '/api/devices/:deviceId/groups/participants/export',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const deviceId = decodeURIComponent(req.params.deviceId);
      const groupId = typeof req.query.group_id === 'string' ? req.query.group_id.trim() : '';
      if (!groupId) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف المجموعة مطلوب'});
        return;
      }
      try {
        const asset = await gowaFetchRaw('/group/participants/export', {
          deviceId,
          query: {group_id: groupId},
        });
        res.setHeader('Content-Type', asset.contentType || 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="participants.csv"');
        res.send(asset.buffer);
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  app.post(
    '/api/devices/:deviceId/groups/participants/:action',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const deviceId = decodeURIComponent(req.params.deviceId);
      const action = req.params.action;
      const pathMap: Record<string, string> = {
        add: '/group/participants',
        remove: '/group/participants/remove',
        promote: '/group/participants/promote',
        demote: '/group/participants/demote',
      };
      const upstream = pathMap[action];
      if (!upstream) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'إجراء المشاركين غير صالح'});
        return;
      }
      const body = req.body as {group_id?: unknown; participants?: unknown};
      const groupId = typeof body.group_id === 'string' ? body.group_id.trim() : '';
      const participants = Array.isArray(body.participants)
        ? body.participants.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
        : [];
      if (!groupId || participants.length === 0) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'بيانات المجموعة والأعضاء مطلوبة'});
        return;
      }
      try {
        const result = await gowaFetch(upstream, {
          method: 'POST',
          deviceId,
          body: {group_id: groupId, participants},
        });
        res.json({code: 'SUCCESS', message: 'تم تنفيذ الإجراء', results: result});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  app.get(
    '/api/devices/:deviceId/groups/participant-requests',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const deviceId = decodeURIComponent(req.params.deviceId);
      const groupId = typeof req.query.group_id === 'string' ? req.query.group_id.trim() : '';
      if (!groupId) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف المجموعة مطلوب'});
        return;
      }
      try {
        const result = await gowaFetch('/group/participant-requests', {
          deviceId,
          query: {group_id: groupId},
        });
        res.json({code: 'SUCCESS', message: 'ok', results: result ?? []});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  app.post(
    '/api/devices/:deviceId/groups/participant-requests/:decision',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const deviceId = decodeURIComponent(req.params.deviceId);
      const decision = req.params.decision;
      if (decision !== 'approve' && decision !== 'reject') {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'قرار غير صالح'});
        return;
      }
      const body = req.body as {group_id?: unknown; participants?: unknown};
      const groupId = typeof body.group_id === 'string' ? body.group_id.trim() : '';
      const participants = Array.isArray(body.participants)
        ? body.participants.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
        : [];
      if (!groupId || participants.length === 0) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'بيانات الطلب غير مكتملة'});
        return;
      }
      try {
        const result = await gowaFetch(`/group/participant-requests/${decision}`, {
          method: 'POST',
          deviceId,
          body: {group_id: groupId, participants},
        });
        res.json({code: 'SUCCESS', message: 'تم تنفيذ الطلب', results: result});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  app.post('/api/devices/:deviceId/groups/name', requireAuth, requireAdmin, async (req, res) => {
    const deviceId = decodeURIComponent(req.params.deviceId);
    const body = req.body as {group_id?: unknown; name?: unknown};
    const groupId = typeof body.group_id === 'string' ? body.group_id.trim() : '';
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!groupId || !name) {
      res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف المجموعة والاسم مطلوبان'});
      return;
    }
    try {
      const result = await gowaFetch('/group/name', {
        method: 'POST',
        deviceId,
        body: {group_id: groupId, name},
      });
      res.json({code: 'SUCCESS', message: 'تم تحديث اسم المجموعة', results: result});
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  app.post('/api/devices/:deviceId/groups/topic', requireAuth, requireAdmin, async (req, res) => {
    const deviceId = decodeURIComponent(req.params.deviceId);
    const body = req.body as {group_id?: unknown; topic?: unknown};
    const groupId = typeof body.group_id === 'string' ? body.group_id.trim() : '';
    const topic = typeof body.topic === 'string' ? body.topic : '';
    if (!groupId) {
      res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف المجموعة مطلوب'});
      return;
    }
    try {
      const result = await gowaFetch('/group/topic', {
        method: 'POST',
        deviceId,
        body: {group_id: groupId, topic},
      });
      res.json({code: 'SUCCESS', message: 'تم تحديث وصف المجموعة', results: result});
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  app.post('/api/devices/:deviceId/groups/locked', requireAuth, requireAdmin, async (req, res) => {
    const deviceId = decodeURIComponent(req.params.deviceId);
    const body = req.body as {group_id?: unknown; locked?: unknown};
    const groupId = typeof body.group_id === 'string' ? body.group_id.trim() : '';
    if (!groupId || typeof body.locked !== 'boolean') {
      res.status(400).json({code: 'VALIDATION_ERROR', message: 'بيانات القفل غير مكتملة'});
      return;
    }
    try {
      const result = await gowaFetch('/group/locked', {
        method: 'POST',
        deviceId,
        body: {group_id: groupId, locked: body.locked},
      });
      res.json({code: 'SUCCESS', message: 'تم تحديث إعداد القفل', results: result});
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  app.post('/api/devices/:deviceId/groups/announce', requireAuth, requireAdmin, async (req, res) => {
    const deviceId = decodeURIComponent(req.params.deviceId);
    const body = req.body as {group_id?: unknown; announce?: unknown};
    const groupId = typeof body.group_id === 'string' ? body.group_id.trim() : '';
    if (!groupId || typeof body.announce !== 'boolean') {
      res.status(400).json({code: 'VALIDATION_ERROR', message: 'بيانات وضع الإعلانات غير مكتملة'});
      return;
    }
    try {
      const result = await gowaFetch('/group/announce', {
        method: 'POST',
        deviceId,
        body: {group_id: groupId, announce: body.announce},
      });
      res.json({code: 'SUCCESS', message: 'تم تحديث وضع الإعلانات', results: result});
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  app.get(
    '/api/devices/:deviceId/groups/invite-link',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const deviceId = decodeURIComponent(req.params.deviceId);
      const groupId = typeof req.query.group_id === 'string' ? req.query.group_id.trim() : '';
      const reset = req.query.reset === 'true';
      if (!groupId) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف المجموعة مطلوب'});
        return;
      }
      try {
        const result = await gowaFetch('/group/invite-link', {
          deviceId,
          query: {group_id: groupId, reset: reset ? true : undefined},
        });
        res.json({code: 'SUCCESS', message: 'ok', results: result});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  app.post('/api/devices/:deviceId/groups/photo', requireAuth, requireAdmin, async (req, res) => {
    const deviceId = decodeURIComponent(req.params.deviceId);
    const body = req.body as {
      group_id?: unknown;
      filename?: unknown;
      mimeType?: unknown;
      dataBase64?: unknown;
    };
    const groupId = typeof body.group_id === 'string' ? body.group_id.trim() : '';
    if (!groupId) {
      res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف المجموعة مطلوب'});
      return;
    }
    try {
      const form = new FormData();
      form.append('group_id', groupId);
      if (body.dataBase64) {
        const {filename, blob} = decodeImageUpload(body.filename, body.mimeType, body.dataBase64);
        form.append('photo', blob, filename);
      }
      const result = await gowaFetch('/group/photo', {
        method: 'POST',
        deviceId,
        formData: form,
      });
      db.prepare('DELETE FROM contact_avatars WHERE device_id = ? AND jid = ?').run(deviceId, groupId);
      res.json({code: 'SUCCESS', message: 'تم تحديث صورة المجموعة', results: result});
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  // =========================================================================
  // Account Profile, Privacy, Contacts & Lookups (Admin only, per-device)
  // =========================================================================
  app.get('/api/devices/:deviceId/user/privacy', requireAuth, requireAdmin, async (req, res) => {
    const deviceId = decodeURIComponent(req.params.deviceId);
    try {
      const data = await gowaFetch('/user/my/privacy', {deviceId});
      res.json({code: 'SUCCESS', message: 'ok', results: data});
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  app.get('/api/devices/:deviceId/user/contacts', requireAuth, requireAdmin, async (req, res) => {
    const deviceId = decodeURIComponent(req.params.deviceId);
    try {
      const data = await gowaFetch<{data?: unknown[]} | null>('/user/my/contacts', {deviceId});
      res.json({code: 'SUCCESS', message: 'ok', results: data?.data ?? []});
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  app.post('/api/devices/:deviceId/user/pushname', requireAuth, requireAdmin, async (req, res) => {
    const deviceId = decodeURIComponent(req.params.deviceId);
    const body = req.body as {push_name?: unknown};
    const pushName = typeof body.push_name === 'string' ? body.push_name.trim() : '';
    if (!pushName) {
      res.status(400).json({code: 'VALIDATION_ERROR', message: 'الاسم مطلوب'});
      return;
    }
    try {
      await gowaFetch('/user/pushname', {
        method: 'POST',
        deviceId,
        body: {push_name: pushName},
      });
      res.json({code: 'SUCCESS', message: 'تم تحديث اسم الحساب'});
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  app.post('/api/devices/:deviceId/user/avatar', requireAuth, requireAdmin, async (req, res) => {
    const deviceId = decodeURIComponent(req.params.deviceId);
    const body = req.body as {filename?: unknown; mimeType?: unknown; dataBase64?: unknown};
    try {
      const {filename, blob} = decodeImageUpload(body.filename, body.mimeType, body.dataBase64);
      const form = new FormData();
      form.append('avatar', blob, filename);
      await gowaFetch('/user/avatar', {
        method: 'POST',
        deviceId,
        formData: form,
      });
      db.prepare('DELETE FROM contact_avatars WHERE device_id = ?').run(deviceId);
      res.json({code: 'SUCCESS', message: 'تم تحديث الصورة الشخصية'});
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  app.get('/api/devices/:deviceId/user/avatar', requireAuth, requireAdmin, async (req, res) => {
    const deviceId = decodeURIComponent(req.params.deviceId);
    const rawPhone = typeof req.query.phone === 'string' ? req.query.phone : '';
    const phone = normalizeSearchQuery(rawPhone);
    const isPreview = req.query.is_preview === 'true';
    const isCommunity = req.query.is_community === 'true';
    if (!phone) {
      res.status(400).json({code: 'VALIDATION_ERROR', message: 'الرقم أو المعرّف مطلوب'});
      return;
    }
    try {
      const result = await gowaFetch('/user/avatar', {
        deviceId,
        query: {
          phone,
          is_preview: isPreview ? true : undefined,
          is_community: isCommunity ? true : undefined,
        },
      });
      res.json({code: 'SUCCESS', message: 'ok', results: result});
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  app.get('/api/devices/:deviceId/user/info', requireAuth, requireAdmin, async (req, res) => {
    const deviceId = decodeURIComponent(req.params.deviceId);
    const rawPhone = typeof req.query.phone === 'string' ? req.query.phone : '';
    const phone = normalizeSearchQuery(rawPhone);
    if (!phone) {
      res.status(400).json({code: 'VALIDATION_ERROR', message: 'الرقم أو المعرّف مطلوب'});
      return;
    }
    try {
      const result = await gowaFetch('/user/info', {deviceId, query: {phone}});
      res.json({code: 'SUCCESS', message: 'ok', results: result});
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  app.get('/api/devices/:deviceId/user/check', requireAuth, requireAdmin, async (req, res) => {
    const deviceId = decodeURIComponent(req.params.deviceId);
    const rawPhone = typeof req.query.phone === 'string' ? req.query.phone : '';
    const phone = normalizeSearchQuery(rawPhone);
    if (!phone) {
      res.status(400).json({code: 'VALIDATION_ERROR', message: 'الرقم مطلوب'});
      return;
    }
    try {
      const result = await gowaFetch('/user/check', {deviceId, query: {phone}});
      res.json({code: 'SUCCESS', message: 'ok', results: result});
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  app.get(
    '/api/devices/:deviceId/user/business-profile',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const deviceId = decodeURIComponent(req.params.deviceId);
      const rawPhone = typeof req.query.phone === 'string' ? req.query.phone : '';
      const phone = normalizeSearchQuery(rawPhone);
      if (!phone) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'الرقم مطلوب'});
        return;
      }
      try {
        const result = await gowaFetch('/user/business-profile', {deviceId, query: {phone}});
        res.json({code: 'SUCCESS', message: 'ok', results: result});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  // =========================================================================
  // Misc: Channels (Newsletters) & Calls (Admin only, per-device)
  // =========================================================================
  app.get('/api/devices/:deviceId/newsletters', requireAuth, requireAdmin, async (req, res) => {
    const deviceId = decodeURIComponent(req.params.deviceId);
    try {
      const data = await gowaFetch<{data?: unknown[]} | null>('/user/my/newsletters', {deviceId});
      res.json({code: 'SUCCESS', message: 'ok', results: data?.data ?? []});
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  app.post(
    '/api/devices/:deviceId/newsletters/follow',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const deviceId = decodeURIComponent(req.params.deviceId);
      const body = req.body as {newsletter_id?: unknown};
      const newsletterId = typeof body.newsletter_id === 'string' ? body.newsletter_id.trim() : '';
      if (!newsletterId) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف القناة مطلوب'});
        return;
      }
      try {
        await gowaFetch('/newsletter/follow', {
          method: 'POST',
          deviceId,
          body: {newsletter_id: newsletterId},
        });
        res.json({code: 'SUCCESS', message: 'تمت متابعة القناة'});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  app.post(
    '/api/devices/:deviceId/newsletters/unfollow',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const deviceId = decodeURIComponent(req.params.deviceId);
      const body = req.body as {newsletter_id?: unknown};
      const newsletterId = typeof body.newsletter_id === 'string' ? body.newsletter_id.trim() : '';
      if (!newsletterId) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف القناة مطلوب'});
        return;
      }
      try {
        await gowaFetch('/newsletter/unfollow', {
          method: 'POST',
          deviceId,
          body: {newsletter_id: newsletterId},
        });
        res.json({code: 'SUCCESS', message: 'تم إلغاء متابعة القناة'});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  app.get(
    '/api/devices/:deviceId/newsletters/info',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const deviceId = decodeURIComponent(req.params.deviceId);
      const newsletterId =
        typeof req.query.newsletter_id === 'string' ? req.query.newsletter_id.trim() : undefined;
      const invite = typeof req.query.invite === 'string' ? req.query.invite.trim() : undefined;
      if (!newsletterId && !invite) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'أدخل معرّف القناة أو رابط الدعوة'});
        return;
      }
      try {
        const result = await gowaFetch('/newsletter/info', {
          deviceId,
          query: {newsletter_id: newsletterId, invite},
        });
        res.json({code: 'SUCCESS', message: 'ok', results: result});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  app.get(
    '/api/devices/:deviceId/newsletters/directory',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const deviceId = decodeURIComponent(req.params.deviceId);
      const view = typeof req.query.view === 'string' ? req.query.view.trim() : undefined;
      const searchText =
        typeof req.query.search_text === 'string' ? req.query.search_text.trim() : undefined;
      const countryCodes =
        typeof req.query.country_codes === 'string' ? req.query.country_codes.trim() : undefined;
      const categories =
        typeof req.query.categories === 'string' ? req.query.categories.trim() : undefined;
      const cursor = typeof req.query.cursor === 'string' ? req.query.cursor.trim() : undefined;
      const limit = req.query.limit ? Number(req.query.limit) : 20;

      try {
        const result = await gowaFetch('/newsletter/directory', {
          deviceId,
          query: {
            view,
            search_text: searchText,
            country_codes: countryCodes,
            categories,
            cursor,
            limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 50) : 20,
          },
        });
        res.json({code: 'SUCCESS', message: 'ok', results: result});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  app.get(
    '/api/devices/:deviceId/newsletters/messages',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const deviceId = decodeURIComponent(req.params.deviceId);
      const newsletterId =
        typeof req.query.newsletter_id === 'string' ? req.query.newsletter_id.trim() : '';
      const count = req.query.count ? Number(req.query.count) : 20;
      const before = req.query.before ? Number(req.query.before) : undefined;
      if (!newsletterId) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف القناة مطلوب'});
        return;
      }
      try {
        const result = await gowaFetch('/newsletter/messages', {
          deviceId,
          query: {
            newsletter_id: newsletterId,
            count: Number.isFinite(count) ? Math.min(Math.max(count, 1), 100) : 20,
            before: Number.isFinite(before) ? before : undefined,
          },
        });
        res.json({code: 'SUCCESS', message: 'ok', results: result});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  app.get(
    '/api/devices/:deviceId/newsletters/message-updates',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const deviceId = decodeURIComponent(req.params.deviceId);
      const newsletterId =
        typeof req.query.newsletter_id === 'string' ? req.query.newsletter_id.trim() : '';
      const after = req.query.after ? Number(req.query.after) : 1;
      const count = req.query.count ? Number(req.query.count) : 100;
      if (!newsletterId) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف القناة مطلوب'});
        return;
      }
      try {
        const result = await gowaFetch('/newsletter/message-updates', {
          deviceId,
          query: {
            newsletter_id: newsletterId,
            after: Number.isFinite(after) ? after : 1,
            count: Number.isFinite(count) ? count : 100,
          },
        });
        res.json({code: 'SUCCESS', message: 'ok', results: result});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  app.get(
    '/api/devices/:deviceId/newsletters/messages/:serverId/download',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const deviceId = decodeURIComponent(req.params.deviceId);
      const serverId = Number(req.params.serverId);
      const newsletterId =
        typeof req.query.newsletter_id === 'string' ? req.query.newsletter_id.trim() : '';
      if (!newsletterId || !Number.isInteger(serverId) || serverId <= 0) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'معلمات الوسائط غير صالحة'});
        return;
      }
      try {
        const result = await gowaFetch(`/newsletter/messages/${serverId}/download`, {
          deviceId,
          query: {newsletter_id: newsletterId},
        });
        res.json({code: 'SUCCESS', message: 'ok', results: result});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  app.get(
    '/api/devices/:deviceId/newsletters/live-updates',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const deviceId = decodeURIComponent(req.params.deviceId);
      try {
        const data = await gowaFetch<{data?: unknown[]} | null>('/newsletter/live-updates', {
          deviceId,
        });
        res.json({code: 'SUCCESS', message: 'ok', results: data?.data ?? []});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  app.post(
    '/api/devices/:deviceId/newsletters/live-updates',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const deviceId = decodeURIComponent(req.params.deviceId);
      const body = req.body as {newsletter_id?: unknown};
      const newsletterId = typeof body.newsletter_id === 'string' ? body.newsletter_id.trim() : '';
      if (!newsletterId) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف القناة مطلوب'});
        return;
      }
      try {
        const result = await gowaFetch('/newsletter/live-updates', {
          method: 'POST',
          deviceId,
          body: {newsletter_id: newsletterId},
        });
        res.json({code: 'SUCCESS', message: 'تم تفعيل التحديث المباشر', results: result});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  app.delete(
    '/api/devices/:deviceId/newsletters/live-updates',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const deviceId = decodeURIComponent(req.params.deviceId);
      const newsletterId =
        typeof req.query.newsletter_id === 'string' ? req.query.newsletter_id.trim() : '';
      if (!newsletterId) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف القناة مطلوب'});
        return;
      }
      try {
        await gowaFetch('/newsletter/live-updates', {
          method: 'DELETE',
          deviceId,
          query: {newsletter_id: newsletterId},
        });
        res.json({code: 'SUCCESS', message: 'تم إيقاف التحديث المباشر'});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  app.post('/api/devices/:deviceId/call/reject', requireAuth, requireAdmin, async (req, res) => {
    const deviceId = decodeURIComponent(req.params.deviceId);
    const body = req.body as {caller_jid?: unknown; call_id?: unknown};
    const callerJid = typeof body.caller_jid === 'string' ? body.caller_jid.trim() : '';
    const callId = typeof body.call_id === 'string' ? body.call_id.trim() : '';
    if (!callerJid || !callId) {
      res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف المتصل ومعرّف المكالمة مطلوبان'});
      return;
    }
    try {
      const result = await gowaFetch('/call/reject', {
        method: 'POST',
        deviceId,
        body: {caller_jid: callerJid, call_id: callId},
      });
      res.json({code: 'SUCCESS', message: 'تم رفض المكالمة', results: result});
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  // =========================================================================
  // Frontend Serving (Vite Dev Middleware or Built dist/)
  // =========================================================================
  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const vite = await createViteServer({
      server: {middlewareMode: true},
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/') || req.path === '/ws') {
        next();
        return;
      }
      const indexFile = path.join(distDir, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send('Not built');
      }
    });
  }

  const port = Number(process.env.PORT || 3000);
  server.listen(port, '0.0.0.0', () => {
    console.log(`gowa-lite listening on http://0.0.0.0:${port}`);
  });

  process.on('SIGTERM', () => {
    wsBridge.shutdown();
    server.close();
  });
}

void createApp();
