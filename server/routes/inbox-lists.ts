import type {Router} from 'express';
import {
  createChatListForUser,
  deleteChatListForUser,
  listChatListsForUser,
  setChatListMembership,
} from '../db.ts';
import {
  handleRouteError,
  requireAuth,
  requireDeviceParamAccess,
  requirePermission,
} from '../middleware/auth.ts';
import {decodeRouteParam} from '../security.ts';
import type {AuthedRequest} from '../types.ts';
import {
  chatListCreateSchema,
  chatListsAssignSchema,
  parsePositiveIntId,
  parseSchema,
} from '../validation/schemas.ts';

export function registerInboxListRoutes(router: Router): void {
  router.get(
    '/api/unified/chat-lists',
    requireAuth,
    requirePermission('chats', 'read'),
    (req: AuthedRequest, res) => {
      try {
        const lists = listChatListsForUser(req.user!.id);
        res.json({code: 'SUCCESS', message: 'ok', results: lists});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.post(
    '/api/unified/chat-lists',
    requireAuth,
    requirePermission('chats', 'read'),
    (req: AuthedRequest, res) => {
      try {
        const {name} = parseSchema(chatListCreateSchema, req.body ?? {});
        const created = createChatListForUser(req.user!.id, name);
        res.status(201).json({
          code: 'SUCCESS',
          message: 'تم إنشاء القائمة',
          results: created,
        });
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.delete(
    '/api/unified/chat-lists/:listId',
    requireAuth,
    requirePermission('chats', 'read'),
    (req: AuthedRequest, res) => {
      try {
        const listId = parsePositiveIntId(req.params.listId, 'معرّف القائمة');
        const deleted = deleteChatListForUser(req.user!.id, listId);
        if (!deleted) {
          res.status(404).json({code: 'NOT_FOUND', message: 'القائمة غير موجودة'});
          return;
        }
        res.json({code: 'SUCCESS', message: 'تم حذف القائمة'});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.put(
    '/api/unified/chats/:deviceId/:jid/lists',
    requireAuth,
    requirePermission('chats', 'read'),
    requireDeviceParamAccess,
    (req: AuthedRequest, res) => {
      try {
        const deviceId = decodeRouteParam(req.params.deviceId);
        const chatJid = decodeRouteParam(req.params.jid);
        const {list_ids} = parseSchema(chatListsAssignSchema, req.body ?? {});
        const saved = setChatListMembership(req.user!.id, deviceId, chatJid, list_ids);
        res.json({
          code: 'SUCCESS',
          message: 'تم تحديث قوائم المحادثة',
          results: {chat_jid: chatJid, list_ids: saved},
        });
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );
}
