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
  getRoleById,
  getRoleBySlug,
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
  requireAuth,
  requirePermission,
  safeComparePasscode,
  setSessionCookie,
} from '../middleware/auth.ts';
import {
  hasDeviceAccess,
  hasPermission,
  hasPermissionKey,
  isAdminSubject,
  normalizeDeviceIdsInput,
} from '../rbac.ts';
import {AuthRateLimiter, canReuseSavedGowaCredentials, getClientIp} from '../security.ts';
import type {AuthedRequest} from '../types.ts';
import {
  createUserSchema,
  loginAuthSchema,
  parsePositiveIntId,
  parseSchema,
  setupAuthSchema,
  testGowaSettingsSchema,
  updateGowaSettingsSchema,
  updatePreferencesSchema,
  updateUserSchema,
} from '../validation/schemas.ts';
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

    let parsedSetup;
    try {
      parsedSetup = parseSchema(setupAuthSchema, req.body ?? {});
      if (parsedSetup.gowa_url) {
        validateGowaUrl(parsedSetup.gowa_url);
      }
    } catch (err) {
      handleRouteError(res, err);
      return;
    }

    const {
      display_name: displayName,
      username,
      password,
      gowa_url: gowaUrl,
      gowa_username: gowaUsername,
      gowa_password: gowaPassword,
    } = parsedSetup;

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
    const rawBody = (req.body ?? {}) as {username?: unknown};
    const rawUsername = typeof rawBody.username === 'string' ? rawBody.username.trim() : '';
    const clientIp = getClientIp(req);

    const limitStatus = authRateLimiter.check(clientIp, rawUsername);
    if (!limitStatus.allowed) {
      res.setHeader('Retry-After', String(limitStatus.retryAfterSec));
      res.status(429).json({
        code: 'RATE_LIMITED',
        message: 'محاولات دخول فاشلة متكررة، يرجى الانتظار والمحاولة لاحقًا',
      });
      return;
    }

    let username: string;
    let password: string;
    try {
      const parsed = parseSchema(loginAuthSchema, req.body ?? {});
      username = parsed.username;
      password = parsed.password;
    } catch (err) {
      handleRouteError(res, err);
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
      wsBridge.disconnectSession(req.authToken);
    }
    clearSessionCookie(req, res);
    res.json({code: 'SUCCESS', message: 'تم تسجيل الخروج'});
  });

  router.get('/api/auth/me', requireAuth, (req: AuthedRequest, res) => {
    res.json({code: 'SUCCESS', message: 'ok', results: req.user});
  });

  router.put('/api/me/preferences', requireAuth, (req: AuthedRequest, res) => {
    try {
      const parsed = parseSchema(updatePreferencesSchema, req.body ?? {});
      const patch: {theme?: ThemePreference; language?: LanguagePreference} = {};
      if (parsed.theme !== undefined) patch.theme = parsed.theme;
      if (parsed.language !== undefined) patch.language = parsed.language;

      setUserPreferences(req.user!.id, patch);
      const updated = getUserById(req.user!.id);
      res.json({code: 'SUCCESS', message: 'تم حفظ التفضيلات', results: updated});
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  router.post('/api/auth/ws-ticket', requireAuth, (req: AuthedRequest, res) => {
    const ticket = issueWsTicket(req.user!, req.authToken!);
    res.json({code: 'SUCCESS', message: 'ok', results: {ticket}});
  });

  router.get('/api/users', requireAuth, requirePermission('users', 'read'), (_req, res) => {
    res.json({code: 'SUCCESS', message: 'ok', results: listUsers()});
  });

  router.post(
    '/api/users',
    requireAuth,
    requirePermission('users', 'write'),
    async (req: AuthedRequest, res) => {
      let body;
      try {
        body = parseSchema(createUserSchema, req.body ?? {});
      } catch (err) {
        handleRouteError(res, err);
        return;
      }
      const {username, display_name: displayName, password} = body;

      let targetRoleId: number | undefined;
      if (body.role_id !== undefined) {
        const parsedId = Number(body.role_id);
        if (!Number.isInteger(parsedId) || parsedId <= 0) {
          res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف الدور غير صالح'});
          return;
        }
        targetRoleId = parsedId;
      }
      const legacyRole: UserRole = body.role === 'admin' ? 'admin' : 'agent';
      const targetRole =
        targetRoleId !== undefined
          ? getRoleById(targetRoleId)
          : getRoleBySlug(legacyRole);
      if (!targetRole) {
        res.status(400).json({code: 'INVALID_ROLE', message: 'الدور المحدد غير موجود'});
        return;
      }

      let allowedDeviceIds: string[] = [];
      if (body.allowed_device_ids !== undefined) {
        try {
          allowedDeviceIds = normalizeDeviceIdsInput(body.allowed_device_ids);
        } catch (err) {
          handleRouteError(res, err);
          return;
        }
      }

      if (allowedDeviceIds.length > 0 && !hasPermission(req.user!, 'accounts', 'assign')) {
        res.status(403).json({
          code: 'FORBIDDEN',
          message: 'ليس لديك صلاحية تخصيص حسابات واتساب للمستخدمين',
        });
        return;
      }

      if (!isAdminSubject(req.user!)) {
        if (
          targetRole.slug === 'admin' ||
          targetRole.permissions.some((key) => !hasPermissionKey(req.user!, key))
        ) {
          res.status(403).json({
            code: 'PRIVILEGE_ESCALATION_FORBIDDEN',
            message: 'لا يمكنك تعيين دور يحتوي على صلاحيات لا تملكها',
          });
          return;
        }
        if (req.user!.allowed_device_ids.length > 0) {
          if (
            allowedDeviceIds.length === 0 ||
            allowedDeviceIds.some((id) => !hasDeviceAccess(req.user!, id))
          ) {
            res.status(403).json({
              code: 'DEVICE_FORBIDDEN',
              message: 'لا يمكنك منح وصول لحسابات واتساب غير مصرح لك بها',
            });
            return;
          }
        }
      }

      try {
        const created = await createUserAsync({
          username,
          display_name: displayName,
          role_id: targetRole.id,
          allowed_device_ids: allowedDeviceIds,
          password,
        });
        res.status(201).json({code: 'SUCCESS', message: 'تم إضافة المستخدم بنجاح', results: created});
      } catch (err) {
        const msg = err instanceof Error ? err.message : '';
        if (msg.includes('UNIQUE')) {
          res.status(409).json({code: 'USERNAME_TAKEN', message: 'اسم الدخول مستخدم بالفعل'});
          return;
        }
        handleRouteError(res, err);
      }
    },
  );

  router.patch(
    '/api/users/:id',
    requireAuth,
    requirePermission('users', 'write'),
    async (req: AuthedRequest, res) => {
      let targetId: number;
      let body;
      try {
        targetId = parsePositiveIntId(req.params.id, 'معرّف المستخدم');
        body = parseSchema(updateUserSchema, req.body ?? {});
      } catch (err) {
        handleRouteError(res, err);
        return;
      }
      const existing = getUserById(targetId);
      if (!existing) {
        res.status(404).json({code: 'NOT_FOUND', message: 'المستخدم غير موجود'});
        return;
      }

      if (!isAdminSubject(req.user!) && existing.role_slug === 'admin') {
        res.status(403).json({
          code: 'PRIVILEGE_ESCALATION_FORBIDDEN',
          message: 'لا يمكنك تعديل حساب مسؤول النظام',
        });
        return;
      }

      let nextRoleId: number | undefined;
      let nextRoleSlug = existing.role_slug;
      if (body.role_id !== undefined) {
        const parsedId = Number(body.role_id);
        if (!Number.isInteger(parsedId) || parsedId <= 0) {
          res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف الدور غير صالح'});
          return;
        }
        const targetRole = getRoleById(parsedId);
        if (!targetRole) {
          res.status(400).json({code: 'INVALID_ROLE', message: 'الدور المحدد غير موجود'});
          return;
        }
        if (
          !isAdminSubject(req.user!) &&
          (targetRole.slug === 'admin' ||
            targetRole.permissions.some((key) => !hasPermissionKey(req.user!, key)))
        ) {
          res.status(403).json({
            code: 'PRIVILEGE_ESCALATION_FORBIDDEN',
            message: 'لا يمكنك تعيين دور يحتوي على صلاحيات لا تملكها',
          });
          return;
        }
        nextRoleId = targetRole.id;
        nextRoleSlug = targetRole.slug;
      } else if (body.role === 'admin' || body.role === 'agent') {
        const targetRole = getRoleBySlug(body.role);
        if (targetRole) {
          if (
            !isAdminSubject(req.user!) &&
            (targetRole.slug === 'admin' ||
              targetRole.permissions.some((key) => !hasPermissionKey(req.user!, key)))
          ) {
            res.status(403).json({
              code: 'PRIVILEGE_ESCALATION_FORBIDDEN',
              message: 'لا يمكنك تعيين دور يحتوي على صلاحيات لا تملكها',
            });
            return;
          }
          nextRoleId = targetRole.id;
          nextRoleSlug = targetRole.slug;
        }
      }

      let nextAllowedDeviceIds: string[] | undefined;
      if (body.allowed_device_ids !== undefined) {
        if (!hasPermission(req.user!, 'accounts', 'assign')) {
          res.status(403).json({
            code: 'FORBIDDEN',
            message: 'ليس لديك صلاحية تعديل حسابات واتساب المسموحة للمستخدمين',
          });
          return;
        }
        try {
          nextAllowedDeviceIds = normalizeDeviceIdsInput(body.allowed_device_ids);
        } catch (err) {
          handleRouteError(res, err);
          return;
        }
        if (!isAdminSubject(req.user!) && req.user!.allowed_device_ids.length > 0) {
          if (
            nextAllowedDeviceIds.length === 0 ||
            nextAllowedDeviceIds.some((id) => !hasDeviceAccess(req.user!, id))
          ) {
            res.status(403).json({
              code: 'DEVICE_FORBIDDEN',
              message: 'لا يمكنك منح وصول لحسابات واتساب غير مصرح لك بها',
            });
            return;
          }
        }
      }

      const nextActive =
        typeof body.is_active === 'boolean' ? body.is_active : existing.is_active;

      if (
        existing.role_slug === 'admin' &&
        existing.is_active &&
        (nextRoleSlug !== 'admin' || !nextActive) &&
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

      let displayName: string | undefined;
      if (body.display_name !== undefined) {
        if (typeof body.display_name !== 'string' || body.display_name.trim().length < 2) {
          res.status(400).json({code: 'VALIDATION_ERROR', message: 'الاسم الكامل مطلوب'});
          return;
        }
        displayName = body.display_name.trim();
      }

      const updated = await updateUserAsync(targetId, {
        display_name: displayName,
        role_id: nextRoleId,
        allowed_device_ids: nextAllowedDeviceIds,
        is_active: nextActive,
        password,
      });
      if (updated) {
        wsBridge.sendToUser(targetId, {
          code: 'USER_ACCESS_UPDATED',
          message: 'updated',
          result: {user: updated},
        });
      }
      res.json({code: 'SUCCESS', message: 'تم تحديث بيانات المستخدم', results: updated});
    },
  );

  router.delete(
    '/api/users/:id',
    requireAuth,
    requirePermission('users', 'delete'),
    (req: AuthedRequest, res) => {
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
      if (!isAdminSubject(req.user!) && existing.role_slug === 'admin') {
        res.status(403).json({
          code: 'PRIVILEGE_ESCALATION_FORBIDDEN',
          message: 'لا يمكنك حذف حساب مسؤول النظام',
        });
        return;
      }
      if (existing.role_slug === 'admin' && existing.is_active && countActiveAdmins() <= 1) {
        res.status(400).json({
          code: 'LAST_ADMIN_PROTECTED',
          message: 'لا يمكن حذف آخر مسؤول نشط في النظام',
        });
        return;
      }
      deleteUser(targetId);
      res.json({code: 'SUCCESS', message: 'تم حذف المستخدم'});
    },
  );

  router.get('/api/settings/gowa', requireAuth, requirePermission('settings', 'read'), (_req, res) => {
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

  router.put('/api/settings/gowa', requireAuth, requirePermission('settings', 'write'), (req, res) => {
    try {
      const body = parseSchema(updateGowaSettingsSchema, req.body ?? {});
      const rawUrl = body.gowa_url;
      const username = body.gowa_username;
      const clearPassword = body.clear_password === true;
      const password =
        clearPassword
          ? ''
          : typeof body.gowa_password === 'string' && body.gowa_password.length > 0
            ? body.gowa_password
            : undefined;

      if (rawUrl) {
        validateGowaUrl(rawUrl);
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
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  router.post(
    '/api/settings/gowa/test',
    requireAuth,
    requirePermission('settings', 'write'),
    async (req, res) => {
      try {
        const body = parseSchema(testGowaSettingsSchema, req.body ?? {});
        const saved = getGowaConfig();
        const url = body.gowa_url && body.gowa_url.length > 0 ? body.gowa_url : saved.url;
        const canReuseCreds = canReuseSavedGowaCredentials(url, saved.url);
        const username =
          body.gowa_username !== undefined
            ? body.gowa_username
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
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  return router;
}
