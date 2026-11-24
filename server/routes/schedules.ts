import type {Router} from 'express';
import {gowaFetch} from '../gowa-client.ts';
import {createApiRouter, handleRouteError, requireAdmin, requireAuth} from '../middleware/auth.ts';
import {decodeRouteParam} from '../security.ts';
import {normalizePhoneQueryForGowa} from '../services/chat-sync.ts';
import {
  createScheduleViaGowa,
  executeScheduleAction,
  validateAndBuildSchedulePayload,
  type ScheduleInputBody,
} from '../services/schedule-service.ts';

export function registerScheduleRoutes(): Router {
  const router = createApiRouter();

  router.get('/api/devices/:deviceId/schedules', requireAuth, requireAdmin, async (req, res) => {
    const deviceId = decodeRouteParam(req.params.deviceId);
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

  router.post('/api/devices/:deviceId/schedules', requireAuth, requireAdmin, async (req, res) => {
    try {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const payload = validateAndBuildSchedulePayload(req.body as ScheduleInputBody, {
        requirePhone: true,
      });
      const result = await createScheduleViaGowa(deviceId, payload);
      res.status(201).json({code: 'SUCCESS', message: 'تمت جدولة الرسالة', results: result});
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  router.post(
    '/api/devices/:deviceId/schedules/:id/:action',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const deviceId = decodeRouteParam(req.params.deviceId);
        const scheduleId = decodeRouteParam(req.params.id);
        await executeScheduleAction(deviceId, scheduleId, req.params.action);
        res.json({code: 'SUCCESS', message: 'تم تحديث الجدولة'});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  return router;
}
