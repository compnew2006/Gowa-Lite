import type express from 'express';
import type {Router} from 'express';
import {
  assertDeviceAccess,
  createApiRouter,
  handleRouteError,
  requireAnyPermission,
  requireAuth,
  requirePermission,
} from '../middleware/auth.ts';
import {decodeRouteParam} from '../security.ts';
import {sendChatCloseRatingPrompt} from '../services/chat-close-rating.ts';
import {
  assignChat,
  buildLifecycleWsPayload,
  bulkChatLifecycle,
  claimChat,
  closeChat,
  getChatContentAccessState,
  getChatLifecycleState,
  getInboxPolicy,
  listAssignableAgents,
  listChatLifecycleEvents,
  releaseChat,
  reopenChat,
  updateInboxPolicy,
} from '../services/chat-lifecycle.ts';
import type {AuthedRequest} from '../types.ts';
import {lifecycleActionBodySchema, parseSchema} from '../validation/schemas.ts';
import type {GowaWsBridge} from '../ws-bridge.ts';

export function registerChatLifecycleRoutes(wsBridge: GowaWsBridge): Router {
  const router = createApiRouter();

  const requireDeviceParamAccess: express.RequestHandler = (req: AuthedRequest, res, next) => {
    try {
      const deviceId = decodeRouteParam(req.params.deviceId);
      assertDeviceAccess(req.user, deviceId);
      next();
    } catch (err) {
      handleRouteError(res, err);
    }
  };

  router.get(
    '/api/settings/inbox-policy',
    requireAuth,
    requireAnyPermission(['chats:read', 'settings:read', 'settings:write']),
    (_req, res) => {
      res.json({code: 'SUCCESS', message: 'ok', results: getInboxPolicy()});
    },
  );

  router.put(
    '/api/settings/inbox-policy',
    requireAuth,
    requirePermission('settings', 'write'),
    (req, res) => {
      try {
        const body = req.body as {
          unassigned_reply_policy?: unknown;
          closed_reply_policy?: unknown;
        };
        const updated = updateInboxPolicy({
          unassigned_reply_policy: body.unassigned_reply_policy,
          closed_reply_policy: body.closed_reply_policy,
        });
        wsBridge.broadcast({
          code: 'INBOX_POLICY_UPDATED',
          message: 'updated',
          result: updated,
        });
        res.json({code: 'SUCCESS', message: 'تم تحديث سياسة الصندوق بنجاح', results: updated});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.get(
    '/api/unified/assignable-agents',
    requireAuth,
    requirePermission('chats', 'assign'),
    (req: AuthedRequest, res) => {
      try {
        const deviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId.trim() : '';
        if (!deviceId) {
          res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف الحساب مطلوب'});
          return;
        }
        assertDeviceAccess(req.user, deviceId);
        const agents = listAssignableAgents(deviceId);
        res.json({code: 'SUCCESS', message: 'ok', results: agents});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.post(
    '/api/unified/chats/bulk-lifecycle',
    requireAuth,
    (req: AuthedRequest, res) => {
      try {
        const body = req.body as {
          items?: unknown;
          action?: unknown;
          assigned_user_id?: unknown;
          note?: unknown;
          reason?: unknown;
        };
        let assignedUserId: number | null | undefined;
        if (body.action === 'assign') {
          if (body.assigned_user_id === null || body.assigned_user_id === undefined) {
            assignedUserId = null;
          } else {
            const parsed = Number(body.assigned_user_id);
            if (!Number.isInteger(parsed) || parsed <= 0) {
              res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف الوكيل غير صالح'});
              return;
            }
            assignedUserId = parsed;
          }
        }

        const outcome = bulkChatLifecycle(req.user!, body.items, body.action, {
          assignedUserId,
          note: typeof body.note === 'string' ? body.note : undefined,
          reason: typeof body.reason === 'string' ? body.reason : undefined,
        });

        for (const item of outcome.succeeded) {
          if (item.wsPayload) {
            wsBridge.broadcast(item.wsPayload);
          }
        }
        // Keep large bulk closes responsive while delivering prompts sequentially.
        if (body.action === 'close') {
          void (async () => {
            for (const item of outcome.succeeded) {
              const event = item.wsPayload?.result.event;
              if (event) await sendChatCloseRatingPrompt(event.id);
            }
          })().catch((error) => console.error('[close-rating] bulk delivery failed', error));
        }

        res.json({
          code: 'SUCCESS',
          message: 'تمت معالجة الإجراء الجماعي',
          results: {
            succeeded: outcome.succeeded.map((s) => s.assignment),
            failed: outcome.failed,
          },
        });
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.get(
    '/api/unified/chats/:deviceId/:jid/lifecycle',
    requireAuth,
    requirePermission('chats', 'read'),
    requireDeviceParamAccess,
    (req: AuthedRequest, res) => {
      try {
        const deviceId = decodeRouteParam(req.params.deviceId);
        const chatJid = decodeRouteParam(req.params.jid);
        const assignment = getChatLifecycleState(deviceId, chatJid);
        const access = getChatContentAccessState(req.user!, deviceId, chatJid);
        const rawEvents = listChatLifecycleEvents(deviceId, chatJid);
        const events = access.allowed ? rawEvents : rawEvents.map((ev) => ({...ev, note: ''}));
        res.json({
          code: 'SUCCESS',
          message: 'ok',
          results: {assignment, events},
        });
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.post(
    '/api/unified/chats/:deviceId/:jid/claim',
    requireAuth,
    requirePermission('chats', 'assign'),
    requireDeviceParamAccess,
    (req: AuthedRequest, res) => {
      try {
        const deviceId = decodeRouteParam(req.params.deviceId);
        const chatJid = decodeRouteParam(req.params.jid);
        const body = parseSchema(lifecycleActionBodySchema, req.body ?? {});
        const result = claimChat(req.user!, deviceId, chatJid, {
          cachedTitle: body.cached_title,
        });
        wsBridge.broadcast(buildLifecycleWsPayload(result.assignment, result.event));
        res.json({
          code: 'SUCCESS',
          message: 'تم استلام المحادثة بنجاح',
          results: result,
        });
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.post(
    '/api/unified/chats/:deviceId/:jid/assign',
    requireAuth,
    requirePermission('chats', 'assign'),
    requireDeviceParamAccess,
    (req: AuthedRequest, res) => {
      try {
        const deviceId = decodeRouteParam(req.params.deviceId);
        const chatJid = decodeRouteParam(req.params.jid);
        const body = parseSchema(lifecycleActionBodySchema, req.body ?? {});

        let assignedUserId: number | null;
        if (body.assigned_user_id === null || body.assigned_user_id === undefined) {
          assignedUserId = null;
        } else {
          const parsed = Number(body.assigned_user_id);
          if (!Number.isInteger(parsed) || parsed <= 0) {
            res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف الوكيل غير صالح'});
            return;
          }
          assignedUserId = parsed;
        }

        const result = assignChat(req.user!, deviceId, chatJid, assignedUserId, {
          note: body.note,
          cachedTitle: body.cached_title,
        });
        if (result.event) {
          wsBridge.broadcast(buildLifecycleWsPayload(result.assignment, result.event));
        }
        res.json({
          code: 'SUCCESS',
          message: assignedUserId === null ? 'تم إلغاء التعيين وإعادة المحادثة للانتظار' : 'تم تعيين المحادثة بنجاح',
          results: result,
        });
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.post(
    '/api/unified/chats/:deviceId/:jid/release',
    requireAuth,
    requirePermission('chats', 'assign'),
    requireDeviceParamAccess,
    (req: AuthedRequest, res) => {
      try {
        const deviceId = decodeRouteParam(req.params.deviceId);
        const chatJid = decodeRouteParam(req.params.jid);
        const body = parseSchema(lifecycleActionBodySchema, req.body ?? {});
        const result = releaseChat(req.user!, deviceId, chatJid, {
          note: body.note,
          cachedTitle: body.cached_title,
        });
        if (result.event) {
          wsBridge.broadcast(buildLifecycleWsPayload(result.assignment, result.event));
        }
        res.json({
          code: 'SUCCESS',
          message: 'تمت إعادة المحادثة لقائمة الانتظار',
          results: result,
        });
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.post(
    '/api/unified/chats/:deviceId/:jid/close',
    requireAuth,
    requirePermission('chats', 'close'),
    requireDeviceParamAccess,
    async (req: AuthedRequest, res) => {
      try {
        const deviceId = decodeRouteParam(req.params.deviceId);
        const chatJid = decodeRouteParam(req.params.jid);
        const body = parseSchema(lifecycleActionBodySchema, req.body ?? {});
        const result = closeChat(req.user!, deviceId, chatJid, {
          reason: body.reason,
          cachedTitle: body.cached_title,
        });
        if (result.event) {
          wsBridge.broadcast(buildLifecycleWsPayload(result.assignment, result.event));
        }
        const ratingPrompt = result.event ? await sendChatCloseRatingPrompt(result.event.id) : undefined;
        res.json({
          code: 'SUCCESS',
          message: 'تم إغلاق المحادثة',
          results: {
            ...result,
            ...(ratingPrompt ? {
              assignment: getChatLifecycleState(deviceId, chatJid),
              rating_prompt: ratingPrompt,
            } : {}),
          },
        });
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.post(
    '/api/unified/chats/:deviceId/:jid/reopen',
    requireAuth,
    requirePermission('chats', 'close'),
    requireDeviceParamAccess,
    (req: AuthedRequest, res) => {
      try {
        const deviceId = decodeRouteParam(req.params.deviceId);
        const chatJid = decodeRouteParam(req.params.jid);
        const body = parseSchema(lifecycleActionBodySchema, req.body ?? {});
        const result = reopenChat(req.user!, deviceId, chatJid, {
          assignToSelf: body.assign_to_self === true,
          note: body.note,
          cachedTitle: body.cached_title,
        });
        if (result.event) {
          wsBridge.broadcast(buildLifecycleWsPayload(result.assignment, result.event));
        }
        res.json({
          code: 'SUCCESS',
          message: 'تمت إعادة فتح المحادثة',
          results: result,
        });
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  return router;
}
