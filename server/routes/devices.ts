import type {Router} from 'express';
import {getAccountAliases, listKnownDeviceIds, setAccountAlias} from '../db.ts';
import {
  GowaError,
  gowaFetch,
  gowaFetchBinary,
  type GowaDevice,
  type GowaDeviceStatus,
  type GowaLoginQr,
  type GowaPairCode,
} from '../gowa-client.ts';
import {
  assertDeviceAccess,
  createApiRouter,
  handleRouteError,
  requireAnyPermission,
  requireAuth,
  requirePermission,
} from '../middleware/auth.ts';
import {filterAllowedDevices} from '../rbac.ts';
import {buildSafeMediaHeaders, decodeRouteParam} from '../security.ts';
import {resolveAccountDisplayName} from '../services/chat-sync.ts';
import type {AuthedRequest} from '../types.ts';
import type {GowaWsBridge} from '../ws-bridge.ts';

export function registerDeviceRoutes(wsBridge: GowaWsBridge): Router {
  const router = createApiRouter();

  router.get(
    '/api/unified/accounts',
    requireAuth,
    requireAnyPermission([
      'accounts:read',
      'accounts:assign',
      'chats:read',
      'schedules:read',
      'groups:read',
      'misc:status.read',
      'misc:channels.manage',
      'misc:calls.reject',
      'users:read',
      'users:write',
    ]),
    async (req: AuthedRequest, res) => {
      const aliases = getAccountAliases();
      try {
        const allDevices = (await gowaFetch<GowaDevice[]>('/devices')) ?? [];
        const devices = filterAllowedDevices(req.user!, allDevices);
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
    },
  );

  router.get(
    '/api/users/assignable-accounts',
    requireAuth,
    requireAnyPermission(['users:read', 'users:write', 'accounts:assign']),
    async (req: AuthedRequest, res) => {
      const aliases = getAccountAliases();
      const knownIds = listKnownDeviceIds();
      let liveDevices: GowaDevice[] = [];
      let gowaReachable = false;
      let errorMessage: string | undefined;

      try {
        liveDevices = (await gowaFetch<GowaDevice[]>('/devices', {timeoutMs: 5_000})) ?? [];
        gowaReachable = true;
      } catch (err) {
        errorMessage =
          err instanceof GowaError ? err.message : 'تعذر الاتصال بخادم gowa حاليًا';
      }

      const byId = new Map<
        string,
        {
          id: string;
          display_name: string;
          phone_number: string | null;
          state: GowaDevice['state'];
          jid: string | null;
          source: 'live' | 'cached';
        }
      >();

      for (const dev of liveDevices) {
        byId.set(dev.id, {
          id: dev.id,
          display_name: resolveAccountDisplayName(dev, aliases),
          phone_number: dev.phone_number ?? null,
          state: dev.state,
          jid: dev.jid ?? null,
          source: 'live',
        });
      }

      for (const id of knownIds) {
        if (!byId.has(id)) {
          byId.set(id, {
            id,
            display_name: aliases[id] ?? id,
            phone_number: null,
            state: 'disconnected',
            jid: null,
            source: 'cached',
          });
        }
      }

      const accounts = filterAllowedDevices(req.user!, Array.from(byId.values()));
      res.json({
        code: 'SUCCESS',
        message: 'ok',
        results: {
          gowa_reachable: gowaReachable,
          error_message: errorMessage,
          accounts,
        },
      });
    },
  );

  router.get(
    '/api/devices',
    requireAuth,
    requirePermission('accounts', 'read'),
    async (req: AuthedRequest, res) => {
      try {
        const aliases = getAccountAliases();
        const allDevices = (await gowaFetch<GowaDevice[]>('/devices')) ?? [];
        const devices = filterAllowedDevices(req.user!, allDevices);
        const enriched = devices.map((device) => ({
          ...device,
          alias: aliases[device.id] ?? '',
          resolved_name: resolveAccountDisplayName(device, aliases),
        }));
        res.json({code: 'SUCCESS', message: 'ok', results: enriched});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.post(
    '/api/devices',
    requireAuth,
    requirePermission('accounts', 'write'),
    async (req: AuthedRequest, res) => {
      if (req.user!.allowed_device_ids.length > 0) {
        res.status(403).json({
          code: 'DEVICE_FORBIDDEN',
          message: 'الحسابات المقيدة بأجهزة محددة لا يمكنها إنشاء حسابات جديدة',
        });
        return;
      }
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
    },
  );

  router.patch(
    '/api/devices/:id/alias',
    requireAuth,
    requirePermission('accounts', 'write'),
    (req: AuthedRequest, res) => {
      try {
        const deviceId = decodeRouteParam(req.params.id);
        assertDeviceAccess(req.user, deviceId);
        const body = req.body as {alias?: unknown};
        const alias = typeof body.alias === 'string' ? body.alias.trim() : '';
        const aliases = setAccountAlias(deviceId, alias);
        res.json({
          code: 'SUCCESS',
          message: 'تم تحديث اسم عرض الحساب',
          results: {device_id: deviceId, alias: aliases[deviceId] ?? ''},
        });
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.delete(
    '/api/devices/:id',
    requireAuth,
    requirePermission('accounts', 'write'),
    async (req: AuthedRequest, res) => {
      try {
        const deviceId = decodeRouteParam(req.params.id);
        assertDeviceAccess(req.user, deviceId);
        await gowaFetch(`/devices/${encodeURIComponent(deviceId)}`, {method: 'DELETE'});
        setAccountAlias(deviceId, '');
        wsBridge.resetAndReconnect();
        res.json({code: 'SUCCESS', message: 'تم حذف الحساب'});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.get(
    '/api/devices/:id/login',
    requireAuth,
    requirePermission('accounts', 'write'),
    async (req: AuthedRequest, res) => {
      try {
        const deviceId = decodeRouteParam(req.params.id);
        assertDeviceAccess(req.user, deviceId);
        const qr = await gowaFetch<GowaLoginQr>(`/devices/${encodeURIComponent(deviceId)}/login`);
        res.json({code: 'SUCCESS', message: 'ok', results: qr});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.post(
    '/api/devices/:id/login/code',
    requireAuth,
    requirePermission('accounts', 'write'),
    async (req: AuthedRequest, res) => {
      try {
        const deviceId = decodeRouteParam(req.params.id);
        assertDeviceAccess(req.user, deviceId);
        const body = req.body as {phone?: unknown};
        const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
        if (!phone) {
          res.status(400).json({code: 'VALIDATION_ERROR', message: 'رقم الهاتف مطلوب'});
          return;
        }
        const code = await gowaFetch<GowaPairCode>(
          `/devices/${encodeURIComponent(deviceId)}/login/code`,
          {method: 'POST', query: {phone}},
        );
        res.json({code: 'SUCCESS', message: 'ok', results: code});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.post(
    '/api/devices/:id/logout',
    requireAuth,
    requirePermission('accounts', 'write'),
    async (req: AuthedRequest, res) => {
      try {
        const deviceId = decodeRouteParam(req.params.id);
        assertDeviceAccess(req.user, deviceId);
        await gowaFetch(`/devices/${encodeURIComponent(deviceId)}/logout`, {method: 'POST'});
        res.json({code: 'SUCCESS', message: 'تم تسجيل خروج الحساب'});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.post(
    '/api/devices/:id/reconnect',
    requireAuth,
    requirePermission('accounts', 'write'),
    async (req: AuthedRequest, res) => {
      try {
        const deviceId = decodeRouteParam(req.params.id);
        assertDeviceAccess(req.user, deviceId);
        await gowaFetch(`/devices/${encodeURIComponent(deviceId)}/reconnect`, {method: 'POST'});
        res.json({code: 'SUCCESS', message: 'تم إرسال طلب إعادة الاتصال'});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.get(
    '/api/devices/:id/status',
    requireAuth,
    requirePermission('accounts', 'read'),
    async (req: AuthedRequest, res) => {
      try {
        const deviceId = decodeRouteParam(req.params.id);
        assertDeviceAccess(req.user, deviceId);
        const status = await gowaFetch<GowaDeviceStatus>(
          `/devices/${encodeURIComponent(deviceId)}/status`,
        );
        res.json({code: 'SUCCESS', message: 'ok', results: status});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.get(
    '/api/devices/:id/qr-image',
    requireAuth,
    requireAnyPermission(['accounts:read', 'accounts:write']),
    async (req: AuthedRequest, res) => {
      const qrPath = typeof req.query.path === 'string' ? req.query.path : '';
      try {
        const deviceId = decodeRouteParam(req.params.id);
        assertDeviceAccess(req.user, deviceId);
        const asset = await gowaFetchBinary(qrPath);
        const safeHeaders = buildSafeMediaHeaders(asset.contentType, asset.filename);
        res.setHeader('Content-Type', asset.contentType);
        res.setHeader('Content-Disposition', safeHeaders.disposition);
        if (safeHeaders.csp) {
          res.setHeader('Content-Security-Policy', safeHeaders.csp);
        }
        res.setHeader('Cache-Control', 'no-store');
        res.send(asset.buffer);
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  return router;
}
