import crypto from 'node:crypto';
import type {Router} from 'express';
import {
  authenticateUserAsync,
  countActiveAdmins,
  createSession,
  createUser,
  createUserAsync,
  db,
  deleteSession,
  deleteUser,
  getGowaConfig,
  getSessionUser,
  getUserById,
  hasAnyUsers,
  hashPasswordAsync,
  listUsers,
  setGowaConfig,
  setUserPreferences,
  updateUserAsync,
  type LanguagePreference,
  type ThemePreference,
  type UserRole,
} from '../db.ts';
import {probeGowa, validateGowaUrl} from '../gowa-client.ts';
import {
  clearSessionCookie,
  createApiRouter,
  extractAuthToken,
  handleRouteError,
  requireAdmin,
  requireAuth,
  safeComparePasscode,
  setSessionCookie,
} from '../middleware/auth.ts';
import {AuthRateLimiter, canReuseSavedGowaCredentials, getClientIp} from '../security.ts';
import type {AuthedRequest} from '../types.ts';
import {issueWsTicket, type GowaWsBridge} from '../ws-bridge.ts';

export function registerAuthRoutes(wsBridge: GowaWsBridge): Router {
  const router = createApiRouter();
  const authRateLimiter = new AuthRateLimiter();

  router.get('/api/auth/status', (req: AuthedRequest, res) => {
    const envPasscode = (process.env.ADMIN_PASSCODE || '').trim();
    const initialized = hasAnyUsers() || envPasscode.length > 0;
    const {token, source} = extractAuthToken(req);
    const user = token ? getSessionUser(token) : null;
    if (token && !user && source === 'cookie') {
      clearSessionCookie(req, res);
    }
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

  router.post('/api/auth/setup', async (req, res) => {
    const clientIp = getClientIp(req);
    const limitStatus = authRateLimiter.check(clientIp);
    if (!limitStatus.allowed) {
      res.setHeader('Retry-After', String(limitStatus.retryAfterSec));
      res.status(429).json({
        code: 'RATE_LIMITED',
        message: 'تم تجاوز عدد المحاولات المسموح به، يرجى المحاولة لاحقًا',
      });
      return;
    }

    const envPasscode = (process.env.ADMIN_PASSCODE || '').trim();
    if (envPasscode.length > 0) {
      authRateLimiter.recordFailure(clientIp);
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

    const passwordHashOverride = await hashPasswordAsync(password);

    try {
      db.exec('BEGIN IMMEDIATE');
      if (hasAnyUsers()) {
        db.exec('ROLLBACK');
        authRateLimiter.recordFailure(clientIp);
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
        passwordHashOverride,
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
      authRateLimiter.clearSuccess(clientIp, username);
      setSessionCookie(req, res, token);

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

  router.post('/api/auth/login', async (req, res) => {
    const body = req.body as {username?: unknown; password?: unknown};
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const clientIp = getClientIp(req);

    const limitStatus = authRateLimiter.check(clientIp, username);
    if (!limitStatus.allowed) {
      res.setHeader('Retry-After', String(limitStatus.retryAfterSec));
      res.status(429).json({
        code: 'RATE_LIMITED',
        message: 'محاولات دخول فاشلة متكررة، يرجى الانتظار والمحاولة لاحقًا',
      });
      return;
    }

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
        admin = await createUserAsync({
          username: 'admin',
          display_name: 'المسؤول',
          role: 'admin',
          password: crypto.randomBytes(24).toString('hex'),
        });
      }
      const token = createSession(admin.id);
      authRateLimiter.clearSuccess(clientIp, username);
      setSessionCookie(req, res, token);
      res.json({code: 'SUCCESS', message: 'تم تسجيل الدخول بنجاح', results: {token, user: admin}});
      return;
    }

    const user = await authenticateUserAsync(username, password);
    if (!user) {
      authRateLimiter.recordFailure(clientIp, username);
      res.status(401).json({code: 'INVALID_CREDENTIALS', message: 'اسم الدخول أو كلمة المرور غير صحيحة'});
      return;
    }

    const token = createSession(user.id);
    authRateLimiter.clearSuccess(clientIp, username);
    setSessionCookie(req, res, token);
    res.json({code: 'SUCCESS', message: 'تم تسجيل الدخول بنجاح', results: {token, user}});
  });

  router.post('/api/auth/logout', requireAuth, (req: AuthedRequest, res) => {
    if (req.authToken) {
      deleteSession(req.authToken);
    }
    clearSessionCookie(req, res);
    res.json({code: 'SUCCESS', message: 'تم تسجيل الخروج'});
  });

  router.get('/api/auth/me', requireAuth, (req: AuthedRequest, res) => {
    res.json({code: 'SUCCESS', message: 'ok', results: req.user});
  });

  router.put('/api/me/preferences', requireAuth, (req: AuthedRequest, res) => {
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

  router.post('/api/auth/ws-ticket', requireAuth, (req: AuthedRequest, res) => {
    const ticket = issueWsTicket(req.user!);
    res.json({code: 'SUCCESS', message: 'ok', results: {ticket}});
  });

  router.get('/api/users', requireAuth, requireAdmin, (_req, res) => {
    res.json({code: 'SUCCESS', message: 'ok', results: listUsers()});
  });

  router.post('/api/users', requireAuth, requireAdmin, async (req, res) => {
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
      const created = await createUserAsync({username, display_name: displayName, role, password});
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

  router.patch('/api/users/:id', requireAuth, requireAdmin, async (req: AuthedRequest, res) => {
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

    const updated = await updateUserAsync(targetId, {
      display_name: displayName,
      role: nextRole,
      is_active: nextActive,
      password,
    });
    res.json({code: 'SUCCESS', message: 'تم تحديث بيانات المستخدم', results: updated});
  });

  router.delete('/api/users/:id', requireAuth, requireAdmin, (req: AuthedRequest, res) => {
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

  router.get('/api/settings/gowa', requireAuth, requireAdmin, (_req, res) => {
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

  router.put('/api/settings/gowa', requireAuth, requireAdmin, (req, res) => {
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

  router.post('/api/settings/gowa/test', requireAuth, requireAdmin, async (req, res) => {
    const body = req.body as {
      gowa_url?: unknown;
      gowa_username?: unknown;
      gowa_password?: unknown;
    };
    const saved = getGowaConfig();
    const url =
      typeof body.gowa_url === 'string' && body.gowa_url.trim()
        ? body.gowa_url.trim()
        : saved.url;
    const canReuseCreds = canReuseSavedGowaCredentials(url, saved.url);
    const username =
      typeof body.gowa_username === 'string'
        ? body.gowa_username.trim()
        : canReuseCreds
          ? saved.username
          : '';
    const password =
      typeof body.gowa_password === 'string' && body.gowa_password.length > 0
        ? body.gowa_password
        : canReuseCreds
          ? saved.password
          : '';

    const result = await probeGowa({url, username, password});
    res.json({
      code: result.ok ? 'SUCCESS' : result.code || 'FAILED',
      message: result.ok
        ? `تم الاتصال بنجاح (${result.devicesCount} حساب)`
        : result.error || 'فشل الاتصال',
      results: result,
    });
  });

  return router;
}
