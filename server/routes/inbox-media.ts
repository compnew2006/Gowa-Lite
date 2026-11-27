import type {Router} from 'express';
import {GowaError} from '../gowa-client.ts';
import {buildGowaAssetUrl, GOWA_MEDIA_ROUTE, sendGowaAsset} from '../media-access.ts';
import {
  assertDeviceAccess,
  handleRouteError,
  requireAnyPermission,
  requireAuth,
} from '../middleware/auth.ts';
import {hasChatReadPermission, hasDeviceAccess} from '../rbac.ts';
import {assertChatContentAccess} from '../services/chat-lifecycle.ts';
import {resolveAndCacheAvatar, resolveChatMediaDownload} from '../services/inbox-media.ts';
import type {AuthedRequest} from '../types.ts';

export function registerInboxMediaRoutes(router: Router): void {
  router.get(
    '/api/unified/media/download',
    requireAuth,
    requireAnyPermission(['chats:read', 'misc:status.read', 'groups:read']),
    async (req: AuthedRequest, res) => {
      const deviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId.trim() : '';
      const messageId = typeof req.query.messageId === 'string' ? req.query.messageId.trim() : '';
      const phone = typeof req.query.phone === 'string' ? req.query.phone.trim() : '';
      if (!deviceId || !messageId || !phone) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'معلمات الوسائط غير مكتملة'});
        return;
      }

      try {
        assertDeviceAccess(req.user, deviceId);
        if (!hasChatReadPermission(req.user!, phone)) {
          throw new GowaError(403, 'FORBIDDEN', 'ليس لديك صلاحية الوصول إلى هذه الوسائط');
        }
        assertChatContentAccess(req.user!, deviceId, phone);

        const resolved = await resolveChatMediaDownload(deviceId, phone, messageId);
        res.json({
          code: 'SUCCESS',
          message: 'ok',
          results: {
            message_id: messageId,
            media_type: resolved.mediaType,
            filename: resolved.filename,
            file_size: resolved.fileSize,
            ...resolved.downloaded,
            file_path: resolved.filePath,
            proxy_url: buildGowaAssetUrl(GOWA_MEDIA_ROUTE, deviceId, phone, resolved.filePath),
          },
        });
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.get(
    GOWA_MEDIA_ROUTE,
    requireAuth,
    requireAnyPermission(['chats:read', 'misc:status.read', 'misc:channels.manage', 'groups:read']),
    async (req: AuthedRequest, res) => {
      const deviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId.trim() : '';
      const chatJid = typeof req.query.chatJid === 'string' ? req.query.chatJid.trim() : '';
      try {
        if (!deviceId) {
          throw new GowaError(400, 'VALIDATION_ERROR', 'معرّف الحساب مطلوب');
        }
        assertDeviceAccess(req.user, deviceId);
        if (!chatJid || !hasChatReadPermission(req.user!, chatJid)) {
          throw new GowaError(403, 'FORBIDDEN', 'ليس لديك صلاحية الوصول إلى هذه الوسائط');
        }
        assertChatContentAccess(req.user!, deviceId, chatJid);
        await sendGowaAsset(req, res, GOWA_MEDIA_ROUTE, deviceId, chatJid);
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.get(
    '/api/unified/avatar',
    requireAuth,
    requireAnyPermission(['chats:read', 'groups:read', 'accounts:read', 'misc:status.read']),
    async (req: AuthedRequest, res) => {
      const deviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId.trim() : '';
      const jid = typeof req.query.jid === 'string' ? req.query.jid.trim() : '';
      const force = req.query.force === 'true';

      if (!deviceId || !jid) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف الحساب والمستلم مطلوبان'});
        return;
      }
      if (!hasDeviceAccess(req.user!, deviceId)) {
        res.status(403).json({
          code: 'DEVICE_FORBIDDEN',
          message: 'غير مصرح لك بالوصول إلى حساب واتساب هذا',
        });
        return;
      }
      if (jid === 'status@broadcast') {
        res.status(204).end();
        return;
      }

      const resolved = await resolveAndCacheAvatar(deviceId, jid, force);
      if (resolved && resolved.status === 'ok' && resolved.image_blob && resolved.image_blob.byteLength > 0) {
        res.setHeader('Content-Type', resolved.content_type || 'image/jpeg');
        res.setHeader('Cache-Control', 'private, max-age=3600');
        res.send(Buffer.from(resolved.image_blob));
        return;
      }
      res.status(204).end();
    },
  );
}
