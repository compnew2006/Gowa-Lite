import type {Router} from 'express';
import {GowaError, gowaFetch} from '../gowa-client.ts';
import {recordChatActionEvent} from '../db/lifecycle-repo.ts';
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
  reschedulePageSchedule,
  validateAndBuildSchedulePayload,
  type ScheduleInputBody,
} from '../services/schedule-service.ts';
import type {GowaWsBridge} from '../ws-bridge.ts';
import {
  annotateScheduleListResults,
  canManageSchedule,
  deleteScheduleOwnership,
  getScheduleChatJid,
  recordCreatedScheduleOwnership,
} from '../services/schedule-ownership.ts';
import {normalizeWhatsAppJid} from '../../shared/whatsapp-identity.ts';
import type {AuthedRequest} from '../types.ts';

export function registerScheduleRoutes(wsBridge: GowaWsBridge): Router {
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
        // P2-11: same system line as a chat-drawer creation; the chat is
        // derived from the recipient phone (no chat in this URL).
        recordChatActionEvent({
          deviceId,
          chatJid: normalizeWhatsAppJid(String(payload.phone || '')),
          eventType: 'schedule_created',
          actorUserId: req.user!.id,
          actorName: req.user!.display_name,
        });
        res.status(201).json({code: 'SUCCESS', message: 'تمت جدولة الرسالة', results: result});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  // P2-9: edit a schedule from the Scheduled page (time, and text for text
  // schedules). Same reschedule service as the chat drawer (PATCH-first,
  // recreate-then-cancel fallback); the page URL carries no chat, so the
  // service resolves it from the ownership row / gateway record. Gated by
  // schedules:manage + the P0-2 ownership rule: an agent edits only their
  // own schedules (supervisors/admins manage all).
  router.patch(
    '/api/devices/:deviceId/schedules/:id',
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
        const body = req.body as {scheduled_at?: unknown; message?: unknown};
        const result = await reschedulePageSchedule(deviceId, scheduleId, body, wsBridge);
        res.json({code: 'SUCCESS', message: 'تم تحديث الجدولة', results: result});
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
        // P2-11: the chat comes from the ownership record (no chat in this
        // URL). Schedules created before the chat_jid column existed have
        // no known chat and record nothing.
        const scheduleActionEvent = {
          pause: 'schedule_paused',
          resume: 'schedule_resumed',
          cancel: 'schedule_cancelled',
        } as const;
        const actionEventType =
          scheduleActionEvent[req.params.action as keyof typeof scheduleActionEvent];
        const actionChatJid = actionEventType
          ? getScheduleChatJid(deviceId, scheduleId)
          : null;
        if (actionEventType && actionChatJid) {
          recordChatActionEvent({
            deviceId,
            chatJid: actionChatJid,
            eventType: actionEventType,
            actorUserId: req.user!.id,
            actorName: req.user!.display_name,
          });
        }
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
