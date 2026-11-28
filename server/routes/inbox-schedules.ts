import type {Router} from 'express';
import {parseTimestampMs} from '../db.ts';
import {GowaError, gowaFetch, type GowaPagination} from '../gowa-client.ts';
import {
  handleRouteError,
  requireAuth,
  requireDeviceParamAccess,
  requirePermission,
} from '../middleware/auth.ts';
import {decodeRouteParam} from '../security.ts';
import {assertChatContentAccess, getChatContentAccessState} from '../services/chat-lifecycle.ts';
import {normalizePhoneQueryForGowa, recipientMatchesChatJid} from '../services/chat-sync.ts';
import {
  createScheduleViaGowa,
  executeScheduleAction,
  rescheduleChatSchedule,
  validateAndBuildSchedulePayload,
  type ScheduleInputBody,
} from '../services/schedule-service.ts';
import {
  annotateSchedulesWithCanManage,
  canManageSchedule,
  deleteScheduleOwnership,
  recordCreatedScheduleOwnership,
} from '../services/schedule-ownership.ts';
import type {AuthedRequest} from '../types.ts';
import type {GowaWsBridge} from '../ws-bridge.ts';

export function registerInboxScheduleRoutes(router: Router, wsBridge: GowaWsBridge): void {
  router.get(
    '/api/unified/chats/:deviceId/:jid/schedules',
    requireAuth,
    requirePermission('schedules', 'read'),
    requireDeviceParamAccess,
    async (req: AuthedRequest, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const chatJid = decodeRouteParam(req.params.jid);
      const status = typeof req.query.status === 'string' ? req.query.status.trim() : undefined;
      const at = chatJid.indexOf('@');
      const localPart = at === -1 ? chatJid : chatJid.slice(0, at);
      const searchKey = localPart.split(':')[0] || chatJid;

      try {
        const access = getChatContentAccessState(req.user!, deviceId, chatJid);
        if (!access.allowed) {
          res.json({
            code: 'SUCCESS',
            message: 'ok',
            results: {
              data: [],
              pagination: {limit: 100, offset: 0, total: 0},
              content_redacted: true,
              redaction_reason: access.reason,
            },
          });
          return;
        }
        const raw = await gowaFetch<{
          data?: Array<Record<string, unknown>>;
          pagination?: GowaPagination;
        }>('/send/schedules', {
          deviceId,
          query: {
            status: status && status !== 'all' ? status : undefined,
            search: normalizePhoneQueryForGowa(searchKey) || searchKey,
            limit: 100,
            offset: 0,
          },
        });
        const items = (raw?.data ?? []).filter((item) =>
          recipientMatchesChatJid(String(item.recipient || ''), chatJid),
        );
        const priority = (st: unknown) => {
          if (st === 'active' || st === 'running') return 0;
          if (st === 'paused') return 1;
          return 2;
        };
        items.sort((a, b) => {
          const pa = priority(a.status);
          const pb = priority(b.status);
          if (pa !== pb) return pa - pb;
          const ta = parseTimestampMs(String(a.next_run_at || a.scheduled_at || ''));
          const tb = parseTimestampMs(String(b.next_run_at || b.scheduled_at || ''));
          return pa < 2 ? ta - tb : tb - ta;
        });
        res.json({
          code: 'SUCCESS',
          message: 'ok',
          results: {
            data: annotateSchedulesWithCanManage(
              req.user!,
              deviceId,
              items.map((item) => ({...item, id: String(item.id || '')})),
            ),
            pagination: {limit: 100, offset: 0, total: items.length},
          },
        });
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.post(
    '/api/unified/chats/:deviceId/:jid/schedules',
    requireAuth,
    requirePermission('schedules', 'write'),
    requireDeviceParamAccess,
    async (req: AuthedRequest, res) => {
      try {
        const deviceId = decodeRouteParam(req.params.deviceId);
        const chatJid = decodeRouteParam(req.params.jid);
        assertChatContentAccess(req.user!, deviceId, chatJid);
        const payload = validateAndBuildSchedulePayload(req.body as ScheduleInputBody, {
          fixedPhone: chatJid,
        });
        const result = await createScheduleViaGowa(deviceId, payload, wsBridge, chatJid);
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

  router.patch(
    '/api/unified/chats/:deviceId/:jid/schedules/:id',
    requireAuth,
    requirePermission('schedules', 'manage'),
    requireDeviceParamAccess,
    async (req: AuthedRequest, res) => {
      try {
        const deviceId = decodeRouteParam(req.params.deviceId);
        const chatJid = decodeRouteParam(req.params.jid);
        assertChatContentAccess(req.user!, deviceId, chatJid);
        const scheduleId = decodeRouteParam(req.params.id);
        if (!canManageSchedule(req.user!, deviceId, scheduleId)) {
          throw new GowaError(403, 'FORBIDDEN', 'ليس لديك صلاحية إدارة هذه الجدولة');
        }
        const body = req.body as {scheduled_at?: unknown; message?: unknown};
        const result = await rescheduleChatSchedule(deviceId, chatJid, scheduleId, body, wsBridge);
        res.json({code: 'SUCCESS', message: 'تم تحديث موعد الجدولة', results: result});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.post(
    '/api/unified/chats/:deviceId/:jid/schedules/:id/:action',
    requireAuth,
    requirePermission('schedules', 'manage'),
    requireDeviceParamAccess,
    async (req: AuthedRequest, res) => {
      try {
        const deviceId = decodeRouteParam(req.params.deviceId);
        const chatJid = decodeRouteParam(req.params.jid);
        assertChatContentAccess(req.user!, deviceId, chatJid);
        const scheduleId = decodeRouteParam(req.params.id);
        if (!canManageSchedule(req.user!, deviceId, scheduleId)) {
          throw new GowaError(403, 'FORBIDDEN', 'ليس لديك صلاحية إدارة هذه الجدولة');
        }
        await executeScheduleAction(deviceId, scheduleId, req.params.action, wsBridge, chatJid);
        if (req.params.action === 'cancel') {
          deleteScheduleOwnership(scheduleId);
        }
        res.json({code: 'SUCCESS', message: 'تم تحديث الجدولة'});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );
}
