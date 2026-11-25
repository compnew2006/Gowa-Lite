import type {Router} from 'express';
import {db} from '../db.ts';
import {gowaFetch} from '../gowa-client.ts';
import {
  assertDeviceAccess,
  createApiRouter,
  decodeImageUpload,
  handleRouteError,
  requireAuth,
  requirePermission,
} from '../middleware/auth.ts';
import {decodeRouteParam} from '../security.ts';
import {getAccountCloseRatings, setAccountCloseRatingEnabled} from '../services/chat-close-rating.ts';
import {normalizeSearchQuery} from '../services/chat-sync.ts';
import type {AuthedRequest} from '../types.ts';
import {closeRatingSettingsSchema, parseSchema} from '../validation/schemas.ts';

export function registerAccountRoutes(): Router {
  const router = createApiRouter();

  router.get(
    '/api/devices/:deviceId/close-ratings',
    requireAuth,
    requirePermission('accounts', 'read'),
    (req: AuthedRequest, res) => {
      try {
        const deviceId = decodeRouteParam(req.params.deviceId);
        assertDeviceAccess(req.user, deviceId);
        res.json({code: 'SUCCESS', message: 'ok', results: getAccountCloseRatings(deviceId)});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.put(
    '/api/devices/:deviceId/close-ratings',
    requireAuth,
    requirePermission('accounts', 'write'),
    (req: AuthedRequest, res) => {
      try {
        const deviceId = decodeRouteParam(req.params.deviceId);
        assertDeviceAccess(req.user, deviceId);
        const {enabled} = parseSchema(closeRatingSettingsSchema, req.body ?? {});
        res.json({code: 'SUCCESS', message: 'ok', results: setAccountCloseRatingEnabled(deviceId, enabled)});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.get(
    '/api/devices/:deviceId/user/privacy',
    requireAuth,
    requirePermission('accounts', 'read'),
    async (req: AuthedRequest, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      try {
        assertDeviceAccess(req.user, deviceId);
        const data = await gowaFetch('/user/my/privacy', {deviceId});
        res.json({code: 'SUCCESS', message: 'ok', results: data});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.get(
    '/api/devices/:deviceId/user/contacts',
    requireAuth,
    requirePermission('accounts', 'read'),
    async (req: AuthedRequest, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      try {
        assertDeviceAccess(req.user, deviceId);
        const data = await gowaFetch<{data?: unknown[]} | null>('/user/my/contacts', {deviceId});
        res.json({code: 'SUCCESS', message: 'ok', results: data?.data ?? []});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.post(
    '/api/devices/:deviceId/user/pushname',
    requireAuth,
    requirePermission('accounts', 'write'),
    async (req: AuthedRequest, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const body = req.body as {push_name?: unknown};
      const pushName = typeof body.push_name === 'string' ? body.push_name.trim() : '';
      if (!pushName) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'الاسم مطلوب'});
        return;
      }
      try {
        assertDeviceAccess(req.user, deviceId);
        await gowaFetch('/user/pushname', {
          method: 'POST',
          deviceId,
          body: {push_name: pushName},
        });
        res.json({code: 'SUCCESS', message: 'تم تحديث اسم الحساب'});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.post(
    '/api/devices/:deviceId/user/avatar',
    requireAuth,
    requirePermission('accounts', 'write'),
    async (req: AuthedRequest, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const body = req.body as {filename?: unknown; mimeType?: unknown; dataBase64?: unknown};
      try {
        assertDeviceAccess(req.user, deviceId);
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
    },
  );

  router.get(
    '/api/devices/:deviceId/user/avatar',
    requireAuth,
    requirePermission('accounts', 'read'),
    async (req: AuthedRequest, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const rawPhone = typeof req.query.phone === 'string' ? req.query.phone : '';
      const phone = normalizeSearchQuery(rawPhone);
      const isPreview = req.query.is_preview === 'true';
      const isCommunity = req.query.is_community === 'true';
      if (!phone) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'الرقم أو المعرّف مطلوب'});
        return;
      }
      try {
        assertDeviceAccess(req.user, deviceId);
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
    },
  );

  router.get(
    '/api/devices/:deviceId/user/info',
    requireAuth,
    requirePermission('accounts', 'read'),
    async (req: AuthedRequest, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const rawPhone = typeof req.query.phone === 'string' ? req.query.phone : '';
      const phone = normalizeSearchQuery(rawPhone);
      if (!phone) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'الرقم أو المعرّف مطلوب'});
        return;
      }
      try {
        assertDeviceAccess(req.user, deviceId);
        const result = await gowaFetch('/user/info', {deviceId, query: {phone}});
        res.json({code: 'SUCCESS', message: 'ok', results: result});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.get(
    '/api/devices/:deviceId/user/check',
    requireAuth,
    requirePermission('accounts', 'read'),
    async (req: AuthedRequest, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const rawPhone = typeof req.query.phone === 'string' ? req.query.phone : '';
      const phone = normalizeSearchQuery(rawPhone);
      if (!phone) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'الرقم مطلوب'});
        return;
      }
      try {
        assertDeviceAccess(req.user, deviceId);
        const result = await gowaFetch('/user/check', {deviceId, query: {phone}});
        res.json({code: 'SUCCESS', message: 'ok', results: result});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.get(
    '/api/devices/:deviceId/user/business-profile',
    requireAuth,
    requirePermission('accounts', 'read'),
    async (req: AuthedRequest, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const rawPhone = typeof req.query.phone === 'string' ? req.query.phone : '';
      const phone = normalizeSearchQuery(rawPhone);
      if (!phone) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'الرقم مطلوب'});
        return;
      }
      try {
        assertDeviceAccess(req.user, deviceId);
        const result = await gowaFetch('/user/business-profile', {deviceId, query: {phone}});
        res.json({code: 'SUCCESS', message: 'ok', results: result});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  return router;
}
