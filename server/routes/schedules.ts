import type {Router} from 'express';
import {GowaError, gowaFetch} from '../gowa-client.ts';
import {
  assertDeviceAccess,
  createApiRouter,
  handleRouteError,
  requireAuth,
  requirePermission,
} from '../middleware/auth.ts';
import {decodeRouteParam} from '../security.ts';
import {normalizePhoneQueryForGowa} from '../services/chat-sync.ts';
import {
  createScheduleViaGowa,
  executeScheduleAction,
  validateAndBuildSchedulePayload,
  type ScheduleInputBody,
} from '../services/schedule-service.ts';
import {
  annotateScheduleListResults,
  canManageSchedule,
  deleteScheduleOwnership,
  recordCreatedScheduleOwnership,
} from '../services/schedule-ownership.ts';
import type {AuthedRequest} from '../types.ts';

export function registerScheduleRoutes(): Router {
  const router = createApiRouter();

  router.get(
    '/api/devices/:deviceId/schedules',
    requireAuth,
    requirePermission('schedules', 'read'),
    async (req: AuthedRequest, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const status = typeof req.query.status === 'string' ? req.query.status.trim() : undefined;
      const rawSearch = typeof req.query.search === 'string' ? req.query.search : '';
      const search = normalizePhoneQueryForGowa(rawSearch) || undefined;
      const messageType =
        typeof req.query.message_type === 'string' ? req.query.message_type.trim() : undefined;
      const limit = req.query.limit ? Number(req.query.limit) : 25;
      const offset = req.query.offset ? Number(req.query.offset) : 0;

      try {
        assertDeviceAccess(req.user, deviceId);
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
        res.json({
          code: 'SUCCESS',
          message: 'ok',
          results: annotateScheduleListResults(req.user!, deviceId, data),
        });
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.post(
    '/api/devices/:deviceId/schedules',
    requireAuth,
    requirePermission('schedules', 'write'),
    async (req: AuthedRequest, res) => {
      try {
        const deviceId = decodeRouteParam(req.params.deviceId);
        assertDeviceAccess(req.user, deviceId);
        const payload = validateAndBuildSchedulePayload(req.body as ScheduleInputBody, {
          requirePhone: true,
        });
        const result = await createScheduleViaGowa(deviceId, payload);
        await recordCreatedScheduleOwnership(
          deviceId,
          {
            phone: String(payload.phone || ''),
            message: String(payload.message || ''),
            scheduled_at: String(payload.scheduled_at || ''),
          },
          result,
          req.user!,
        );
        res.status(201).json({code: 'SUCCESS', message: 'تمت جدولة الرسالة', results: result});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.post(
    '/api/devices/:deviceId/schedules/:id/:action',
    requireAuth,
    requirePermission('schedules', 'manage'),
    async (req: AuthedRequest, res) => {
      try {
        const deviceId = decodeRouteParam(req.params.deviceId);
        assertDeviceAccess(req.user, deviceId);
        const scheduleId = decodeRouteParam(req.params.id);
        if (!canManageSchedule(req.user!, deviceId, scheduleId)) {
          throw new GowaError(403, 'FORBIDDEN', 'ليس لديك صلاحية إدارة هذه الجدولة');
        }
        await executeScheduleAction(deviceId, scheduleId, req.params.action);
        if (req.params.action === 'cancel') {
          deleteScheduleOwnership(scheduleId);
        }
        res.json({code: 'SUCCESS', message: 'تم تحديث الجدولة'});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  return router;
}
