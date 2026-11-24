import type {Router} from 'express';
import {getAccountAliases, setAccountAlias} from '../db.ts';
import {
  gowaFetch,
  gowaFetchBinary,
  type GowaDevice,
  type GowaDeviceStatus,
  type GowaLoginQr,
  type GowaPairCode,
} from '../gowa-client.ts';
import {createApiRouter, handleRouteError, requireAdmin, requireAuth} from '../middleware/auth.ts';
import {decodeRouteParam} from '../security.ts';
import {resolveAccountDisplayName} from '../services/chat-sync.ts';
import type {GowaWsBridge} from '../ws-bridge.ts';

export function registerDeviceRoutes(wsBridge: GowaWsBridge): Router {
  const router = createApiRouter();

  router.get('/api/unified/accounts', requireAuth, async (_req, res) => {
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

  router.get('/api/devices', requireAuth, requireAdmin, async (_req, res) => {
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

  router.post('/api/devices', requireAuth, requireAdmin, async (req, res) => {
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

  router.patch('/api/devices/:id/alias', requireAuth, requireAdmin, (req, res) => {
    try {
      const deviceId = decodeRouteParam(req.params.id);
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
  });

  router.delete('/api/devices/:id', requireAuth, requireAdmin, async (req, res) => {
    try {
      const deviceId = decodeRouteParam(req.params.id);
      await gowaFetch(`/devices/${encodeURIComponent(deviceId)}`, {method: 'DELETE'});
      setAccountAlias(deviceId, '');
      wsBridge.resetAndReconnect();
      res.json({code: 'SUCCESS', message: 'تم حذف الحساب'});
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  router.get('/api/devices/:id/login', requireAuth, requireAdmin, async (req, res) => {
    try {
      const deviceId = decodeRouteParam(req.params.id);
      const qr = await gowaFetch<GowaLoginQr>(`/devices/${encodeURIComponent(deviceId)}/login`);
      res.json({code: 'SUCCESS', message: 'ok', results: qr});
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  router.post('/api/devices/:id/login/code', requireAuth, requireAdmin, async (req, res) => {
    try {
      const deviceId = decodeRouteParam(req.params.id);
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
  });

  router.post('/api/devices/:id/logout', requireAuth, requireAdmin, async (req, res) => {
    try {
      const deviceId = decodeRouteParam(req.params.id);
      await gowaFetch(`/devices/${encodeURIComponent(deviceId)}/logout`, {method: 'POST'});
      res.json({code: 'SUCCESS', message: 'تم تسجيل خروج الحساب'});
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  router.post('/api/devices/:id/reconnect', requireAuth, requireAdmin, async (req, res) => {
    try {
      const deviceId = decodeRouteParam(req.params.id);
      await gowaFetch(`/devices/${encodeURIComponent(deviceId)}/reconnect`, {method: 'POST'});
      res.json({code: 'SUCCESS', message: 'تم إرسال طلب إعادة الاتصال'});
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  router.get('/api/devices/:id/status', requireAuth, requireAdmin, async (req, res) => {
    try {
      const deviceId = decodeRouteParam(req.params.id);
      const status = await gowaFetch<GowaDeviceStatus>(
        `/devices/${encodeURIComponent(deviceId)}/status`,
      );
      res.json({code: 'SUCCESS', message: 'ok', results: status});
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  router.get('/api/devices/:id/qr-image', requireAuth, requireAdmin, async (req, res) => {
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

  return router;
}
