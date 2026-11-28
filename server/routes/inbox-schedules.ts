import type {Router} from 'express';
import express from 'express';
import multer, {type MulterError} from 'multer';
import {getAccountAliases, parseTimestampMs} from '../db.ts';
import {GowaError, gowaFetch, type GowaDevice, type GowaPagination} from '../gowa-client.ts';
import {
  handleRouteError,
  requireAuth,
  requireDeviceParamAccess,
  requirePermission,
} from '../middleware/auth.ts';
import {filterAllowedDevices} from '../rbac.ts';
import {decodeRouteParam} from '../security.ts';
import {assertChatContentAccess, getChatContentAccessState} from '../services/chat-lifecycle.ts';
import {
  MAX_MEDIA_UPLOAD_BYTES,
  normalizePhoneQueryForGowa,
  recipientMatchesChatJid,
  resolveAccountDisplayName,
} from '../services/chat-sync.ts';
import {
  createMediaScheduleViaGowa,
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

/**
 * P1-1 (decision 9): the drawer shows the chat's schedules from ALL of the
 * user's allowed devices, not just the chat's own device. The gateway stores
 * a schedule under whichever device created it, so a single-device query
 * hides the rest. The scan is capped so one drawer open cannot fan out
 * across an unbounded device list.
 */
const MAX_ALL_DEVICES_SCHEDULE_SCAN = 10;

type ChatScheduleRow = Record<string, unknown> & {
  id: string;
  device_id: string;
  device_name?: string;
  can_manage: boolean;
};

async function fetchDeviceChatSchedules(
  deviceId: string,
  deviceName: string | undefined,
  chatJid: string,
  searchKey: string,
  status: string | undefined,
): Promise<Array<Record<string, unknown> & {id: string}>> {
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
  // Live gateway records carry the recipient in `phone` (Schedule.phone) and
  // no `recipient` field at all — match on the same fallback the UI uses.
  return (raw?.data ?? [])
    .filter((item) =>
      recipientMatchesChatJid(
        String(item.recipient || item.phone || item.to || ''),
        chatJid,
      ),
    )
    .map((item) => ({
      ...item,
      id: String(item.id || ''),
      device_id: deviceId,
      ...(deviceName ? {device_name: deviceName} : {}),
    }));
}

export function registerInboxScheduleRoutes(router: Router, wsBridge: GowaWsBridge): void {
  // Multipart upload for a scheduled media send: the client posts the file
  // as FormData (field `file`) plus the schedule fields as text. Same
  // memory storage + 20 MB cap as the /send-media route.
  const scheduleMediaUpload = multer({
    storage: multer.memoryStorage(),
    limits: {fileSize: MAX_MEDIA_UPLOAD_BYTES},
  });

  // Returns false when the upload itself was rejected (response already
  // sent); the handler must stop in that case.
  function parseScheduleUpload(
    req: AuthedRequest,
    res: express.Response,
  ): Promise<boolean> {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.startsWith('multipart/form-data')) return Promise.resolve(true);
    return new Promise((resolve) => {
      scheduleMediaUpload.single('file')(req, res, (err: unknown) => {
        if (!err) {
          resolve(true);
          return;
        }
        if ((err as MulterError).code === 'LIMIT_FILE_SIZE') {
          res.status(413).json({
            code: 'PAYLOAD_TOO_LARGE',
            message: 'حجم الملف يتجاوز الحد الأقصى المسموح به (20 ميجابايت)',
          });
          resolve(false);
          return;
        }
        res.status(400).json({
          code: 'VALIDATION_ERROR',
          message: err instanceof Error ? err.message : 'تعذر قراءة المرفق',
        });
        resolve(false);
      });
    });
  }

  // Multipart text fields arrive as strings; the weekday list arrives as
  // the JSON array the client built (`"[1,3]"`). Normalize before the
  // shared payload validator runs.
  function normalizeScheduleBody(
    body: Record<string, unknown>,
  ): Record<string, unknown> {
    const normalized: Record<string, unknown> = {...body};
    const weekdays = normalized.weekdays;
    if (typeof weekdays === 'string') {
      try {
        const parsed: unknown = JSON.parse(weekdays);
        normalized.weekdays = Array.isArray(parsed) ? parsed : [];
      } catch {
        normalized.weekdays = weekdays
          .split(',')
          .map((part) => Number(part.trim()))
          .filter((day) => Number.isInteger(day));
      }
    }
    return normalized;
  }

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
      const scanAllDevices = req.query.all_devices === '1' || req.query.all_devices === 'true';

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
        let items: ChatScheduleRow[];
        if (!scanAllDevices) {
          const rows = await fetchDeviceChatSchedules(
            deviceId,
            undefined,
            chatJid,
            searchKey,
            status,
          );
          items = annotateSchedulesWithCanManage(req.user!, deviceId, rows) as ChatScheduleRow[];
        } else {
          // Allowed devices only, current device first, capped. A device
          // that fails (offline gateway entry, timeout) is skipped rather
          // than failing the whole drawer.
          let allowedDevices: GowaDevice[] = [];
          try {
            const allDevices = (await gowaFetch<GowaDevice[]>('/devices')) ?? [];
            allowedDevices = filterAllowedDevices(req.user!, allDevices);
          } catch {
            allowedDevices = [];
          }
          const aliases = getAccountAliases();
          const byId = new Map(allowedDevices.map((dev) => [dev.id, dev]));
          const orderedIds = [deviceId, ...allowedDevices.map((dev) => dev.id)].filter(
            (id, index, list) => id && list.indexOf(id) === index,
          );
          const scannedIds = orderedIds.slice(0, MAX_ALL_DEVICES_SCHEDULE_SCAN);
          const perDevice = await Promise.allSettled(
            scannedIds.map(async (id) => {
              const device = byId.get(id);
              const rows = await fetchDeviceChatSchedules(
                id,
                device ? resolveAccountDisplayName(device, aliases) : undefined,
                chatJid,
                searchKey,
                status,
              );
              return annotateSchedulesWithCanManage(
                req.user!,
                id,
                rows,
              ) as ChatScheduleRow[];
            }),
          );
          const merged: ChatScheduleRow[] = [];
          const seen = new Set<string>();
          for (const result of perDevice) {
            if (result.status !== 'fulfilled') continue;
            for (const row of result.value) {
              const key = `${row.device_id}:${row.id}`;
              if (seen.has(key)) continue;
              seen.add(key);
              merged.push(row);
            }
          }
          items = merged;
        }
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
            data: items,
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
        if (!(await parseScheduleUpload(req, res))) return;
        const uploaded = req.file;
        const body = normalizeScheduleBody(
          (req.body ?? {}) as Record<string, unknown>,
        );
        const payload = validateAndBuildSchedulePayload(body as ScheduleInputBody, {
          fixedPhone: chatJid,
          allowEmptyMessage: Boolean(uploaded),
        });
        const result = uploaded
          ? await createMediaScheduleViaGowa(
              deviceId,
              chatJid,
              payload,
              {
                buffer: uploaded.buffer,
                filename: uploaded.originalname || 'attachment',
                mimeType: uploaded.mimetype || 'application/octet-stream',
              },
              wsBridge,
              chatJid,
            )
          : await createScheduleViaGowa(deviceId, payload, wsBridge, chatJid);
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
