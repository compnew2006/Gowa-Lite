import express, {type Router} from 'express';
import {
  getCachedMessage,
  markCachedMessageRevoked,
  markChatReadForUser,
  setChatMessagePresence,
  syncAndMergeChatMessages,
  upsertCachedMessages,
} from '../db.ts';
import {
  GowaError,
  gowaFetch,
  gowaFetchBinary,
  type GowaChatInfo,
  type GowaDownloadedMedia,
  type GowaMessageInfo,
  type GowaPagination,
} from '../gowa-client.ts';
import {
  assertDeviceAccess,
  handleRouteError,
  requireAnyPermission,
  requireAuth,
  requireDeviceParamAccess,
  requirePermission,
} from '../middleware/auth.ts';
import {hasChatReadPermission} from '../rbac.ts';
import {decodeRouteParam} from '../security.ts';
import {
  assertChatContentAccess,
  enforceInboxPolicyBeforeSend,
  getChatContentAccessState,
} from '../services/chat-lifecycle.ts';
import {
  inferForwardMimeType,
  isNewsletterJid,
  MAX_MEDIA_UPLOAD_BYTES,
  normalizeSearchQuery,
  normalizeWhatsAppJid,
  resolveGowaMediaTarget,
} from '../services/chat-sync.ts';
import {assertChatNotBlocked, assertDeviceConnected} from '../services/gowa-guards.ts';
import {recordMessageReaction} from '../services/message-reactions.ts';
import type {AuthedRequest} from '../types.ts';
import {parseSchema, reactionBodySchema, sendTextMessageSchema} from '../validation/schemas.ts';
import type {GowaWsBridge} from '../ws-bridge.ts';

export function registerInboxMessageRoutes(router: Router, wsBridge: GowaWsBridge): void {
  router.get(
    '/api/unified/chats/:deviceId/:jid/messages',
    requireAuth,
    requireAnyPermission(['chats:read', 'groups:read']),
    requireDeviceParamAccess,
    async (req: AuthedRequest, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const chatJid = decodeRouteParam(req.params.jid);
      if (!hasChatReadPermission(req.user!, chatJid)) {
        res.status(403).json({code: 'FORBIDDEN', message: 'ليس لديك صلاحية تنفيذ هذا الإجراء'});
        return;
      }
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
      const offset = Math.max(Number(req.query.offset) || 0, 0);
      const rawSearch = typeof req.query.search === 'string' ? req.query.search : '';
      const search = normalizeSearchQuery(rawSearch);
      const mediaOnly = req.query.media_only === 'true';

      try {
        const access = getChatContentAccessState(req.user!, deviceId, chatJid);
        if (!access.allowed) {
          let safeChatInfo: GowaChatInfo = {
            jid: chatJid,
            name: access.assignment.cached_title || '',
            last_message_time: '',
            ephemeral_expiration: 0,
            created_at: '',
            updated_at: '',
            archived: false,
          };
          try {
            const probe = await gowaFetch<{
              data: GowaMessageInfo[];
              pagination: GowaPagination;
              chat_info: GowaChatInfo;
            }>(`/chat/${encodeURIComponent(chatJid)}/messages`, {
              deviceId,
              query: {limit: 1, offset: 0},
            });
            if (probe?.chat_info) {
              safeChatInfo = {
                ...safeChatInfo,
                jid: probe.chat_info.jid || chatJid,
                name: probe.chat_info.name || safeChatInfo.name,
              };
            }
          } catch {
            // Keep safe identity fallback when upstream probe fails
          }
          res.json({
            code: 'SUCCESS',
            message: 'ok',
            results: {
              data: [],
              pagination: {limit, offset, total: 0, raw_count: 0},
              chat_info: safeChatInfo,
              content_redacted: true,
              redaction_reason: access.reason,
            },
          });
          return;
        }

        const data = await gowaFetch<{
          data: GowaMessageInfo[];
          pagination: GowaPagination;
          chat_info: GowaChatInfo;
        }>(`/chat/${encodeURIComponent(chatJid)}/messages`, {
          deviceId,
          query: {
            limit,
            offset,
            search: search || undefined,
            media_only: mediaOnly ? true : undefined,
          },
        });
        // GOWA omits the reactions field when the last reaction is removed.
        const snapshot = (data?.data ?? []).map((message) => ({
          ...message,
          reactions: message.reactions ?? [],
        }));
        const merged = syncAndMergeChatMessages(deviceId, chatJid, snapshot, {
          offset,
          limit,
          search: search || undefined,
          mediaOnly,
        });
        const liveTotal = data?.pagination?.total;
        if (offset === 0 && !search && !mediaOnly) {
          setChatMessagePresence(
            deviceId,
            chatJid,
            merged.messages.length > 0 || (liveTotal ?? 0) > 0,
            data?.chat_info?.last_message_time,
          );
        }
        res.json({
          code: 'SUCCESS',
          message: 'ok',
          results: {
            ...data,
            data: merged.messages,
            reaction_webhook_configured: Boolean(process.env.GOWA_WEBHOOK_SECRET?.trim()),
            pagination: {
              ...(data?.pagination ?? {limit, offset, total: merged.messages.length}),
              total: (liveTotal ?? merged.messages.length) + merged.injectedCount,
              live_total: liveTotal,
              raw_count: merged.rawCount,
              next_offset: offset + merged.rawCount,
            },
          },
        });
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.post(
    '/api/unified/chats/:deviceId/:jid/history',
    requireAuth,
    requireAnyPermission(['chats:read', 'groups:read']),
    requireDeviceParamAccess,
    async (req: AuthedRequest, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const chatJid = decodeRouteParam(req.params.jid);
      if (!hasChatReadPermission(req.user!, chatJid)) {
        res.status(403).json({code: 'FORBIDDEN', message: 'ليس لديك صلاحية تنفيذ هذا الإجراء'});
        return;
      }
      const body = req.body as {count?: unknown};
      const count = Math.min(Math.max(Number(body.count) || 50, 1), 200);
      try {
        assertChatContentAccess(req.user!, deviceId, chatJid);
        const result = await gowaFetch(`/chat/${encodeURIComponent(chatJid)}/history`, {
          method: 'POST',
          deviceId,
          body: {count},
        });
        res.json({code: 'SUCCESS', message: 'تم طلب الرسائل الأقدم من الهاتف', results: result});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.post(
    '/api/unified/chats/:deviceId/:jid/send',
    requireAuth,
    requirePermission('chats', 'write'),
    requireDeviceParamAccess,
    async (req: AuthedRequest, res) => {
      try {
        const deviceId = decodeRouteParam(req.params.deviceId);
        const chatJid = decodeRouteParam(req.params.jid);
        const parsed = parseSchema(sendTextMessageSchema, req.body ?? {});
        const message = parsed.message;
        const replyMessageId = parsed.reply_message_id || undefined;
        assertChatNotBlocked(deviceId, chatJid);
        await assertDeviceConnected(deviceId);

        const policyResult = enforceInboxPolicyBeforeSend(req.user!, deviceId, chatJid);
        if (policyResult.lifecycleEvent) wsBridge.broadcast(policyResult.lifecycleEvent);

        const payload: Record<string, unknown> = {
          phone: chatJid,
          message,
        };
        if (replyMessageId) {
          payload.reply_message_id = replyMessageId;
        }

        const sent = await gowaFetch<{message_id: string; status: string}>('/send/message', {
          method: 'POST',
          deviceId,
          body: payload,
        });

        if (sent?.message_id) {
          upsertCachedMessages(deviceId, chatJid, [
            {
              id: sent.message_id,
              chat_jid: chatJid,
              sender_jid: 'me',
              content: message,
              timestamp: new Date().toISOString(),
              is_from_me: true,
              media_type: '',
              context_metadata: replyMessageId
                ? JSON.stringify({replied_to_id: replyMessageId})
                : undefined,
              filename: '',
              url: '',
              file_length: 0,
            },
          ]);
        }
        if (req.user) {
          markChatReadForUser(req.user.id, deviceId, chatJid);
        }

        res.json({
          code: 'SUCCESS',
          message: 'تم إرسال الرسالة',
          results: sent,
        });
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.post(
    '/api/unified/chats/:deviceId/:jid/send-media',
    requireAuth,
    requirePermission('chats', 'write'),
    requireDeviceParamAccess,
    express.raw({type: 'application/octet-stream', limit: MAX_MEDIA_UPLOAD_BYTES}),
    async (req: AuthedRequest, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const chatJid = decodeRouteParam(req.params.jid);
      const rawFilename = typeof req.query.filename === 'string' ? req.query.filename : '';
      const rawMimeType = typeof req.query.mimeType === 'string' ? req.query.mimeType : '';
      const caption = typeof req.query.caption === 'string' ? req.query.caption.trim() : '';

      if (!deviceId || !chatJid || isNewsletterJid(chatJid)) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف الحساب أو المحادثة غير صالح'});
        return;
      }

      if (!Buffer.isBuffer(req.body) || req.body.byteLength === 0) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'محتوى الملف مطلوب'});
        return;
      }

      if (req.body.byteLength > MAX_MEDIA_UPLOAD_BYTES) {
        res.status(413).json({
          code: 'PAYLOAD_TOO_LARGE',
          message: 'حجم الملف يتجاوز الحد الأقصى المسموح به (20 ميجابايت)',
        });
        return;
      }

      if (caption.length > 4096) {
        res.status(400).json({
          code: 'VALIDATION_ERROR',
          message: 'التعليق المرفق طويل جدًا (الحد الأقصى 4096 حرفًا)',
        });
        return;
      }

      try {
        assertChatNotBlocked(deviceId, chatJid);
        const target = resolveGowaMediaTarget(rawMimeType, rawFilename);
        await assertDeviceConnected(deviceId);

        const policyResult = enforceInboxPolicyBeforeSend(req.user!, deviceId, chatJid);
        if (policyResult.lifecycleEvent) wsBridge.broadcast(policyResult.lifecycleEvent);

        const formData = new FormData();
        formData.set('phone', chatJid);
        if (target.supportsCaption && caption) {
          formData.set('caption', caption);
        }
        const fileBytes = new Uint8Array(req.body);
        formData.set(
          target.fieldName,
          new Blob([fileBytes], {type: target.mimeType}),
          target.filename,
        );

        const sent = await gowaFetch<{message_id: string; status: string}>(target.endpoint, {
          method: 'POST',
          deviceId,
          formData,
          timeoutMs: 45_000,
        });

        if (sent?.message_id) {
          upsertCachedMessages(deviceId, chatJid, [
            {
              id: sent.message_id,
              chat_jid: chatJid,
              sender_jid: 'me',
              content: target.supportsCaption ? caption : '',
              timestamp: new Date().toISOString(),
              is_from_me: true,
              media_type: target.mediaType,
              filename: target.filename,
              url: '',
              file_length: req.body.byteLength,
            },
          ]);
        }
        if (req.user) {
          markChatReadForUser(req.user.id, deviceId, chatJid);
        }

        res.json({
          code: 'SUCCESS',
          message: 'تم إرسال المرفق',
          results: sent,
        });
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.post(
    '/api/unified/chats/:deviceId/:jid/messages/:messageId/reaction',
    requireAuth,
    requirePermission('chats', 'write'),
    requireDeviceParamAccess,
    async (req: AuthedRequest, res) => {
      try {
        const deviceId = decodeRouteParam(req.params.deviceId);
        const chatJid = decodeRouteParam(req.params.jid);
        const messageId = decodeRouteParam(req.params.messageId);
        const {emoji} = parseSchema(reactionBodySchema, req.body ?? {});

        if (!messageId) {
          res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف الرسالة مطلوب'});
          return;
        }
        assertChatContentAccess(req.user!, deviceId, chatJid);
        await assertDeviceConnected(
          deviceId,
          'هذا الحساب غير متصل حاليًا بواتساب. يرجى إعادة ربط الحساب قبل التفاعل.',
        );

        const timestamp = new Date().toISOString();
        const result = await gowaFetch(`/message/${encodeURIComponent(messageId)}/reaction`, {
          method: 'POST',
          deviceId,
          body: {
            phone: chatJid,
            emoji,
          },
        });

        const event = recordMessageReaction(deviceId, chatJid, messageId, {
          emoji,
          sender_jid: deviceId,
          is_from_me: true,
          timestamp,
        });
        if (event) wsBridge.broadcast(event);

        res.json({
          code: 'SUCCESS',
          message: emoji ? 'تم إرسال التفاعل' : 'تمت إزالة التفاعل',
          results: result,
        });
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.post(
    '/api/unified/chats/:deviceId/:jid/messages/:messageId/revoke',
    requireAuth,
    requirePermission('chats', 'revoke'),
    requireDeviceParamAccess,
    async (req: AuthedRequest, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const chatJid = decodeRouteParam(req.params.jid);
      const messageId = decodeRouteParam(req.params.messageId);

      if (!deviceId || !chatJid || !messageId || isNewsletterJid(chatJid)) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'معلمات الرسالة غير صالحة'});
        return;
      }

      try {
        assertChatContentAccess(req.user!, deviceId, chatJid);
        await assertDeviceConnected(
          deviceId,
          'هذا الحساب غير متصل حاليًا بواتساب. يرجى إعادة ربط الحساب قبل حذف الرسالة.',
        );

        const result = await gowaFetch(`/message/${encodeURIComponent(messageId)}/revoke`, {
          method: 'POST',
          deviceId,
          body: {phone: chatJid},
        });

        markCachedMessageRevoked(deviceId, messageId, {chatJid, revokedBy: 'me'});
        wsBridge.broadcast({
          code: 'MESSAGE_REVOKED',
          message: 'revoked',
          device_id: deviceId,
          result: {chat_jid: chatJid, revoked_message_id: messageId},
        });

        res.json({
          code: 'SUCCESS',
          message: 'تم حذف الرسالة لدى الجميع',
          results: result,
        });
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.post(
    '/api/unified/chats/:deviceId/:jid/messages/:messageId/forward',
    requireAuth,
    requirePermission('chats', 'write'),
    requireDeviceParamAccess,
    async (req: AuthedRequest, res) => {
      const sourceDeviceId = decodeRouteParam(req.params.deviceId);
      const sourceChatJid = decodeRouteParam(req.params.jid);
      const messageId = decodeRouteParam(req.params.messageId);
      const body = req.body as {
        target_device_id?: unknown;
        target_jid?: unknown;
        content?: unknown;
        media_type?: unknown;
        filename?: unknown;
      };

      const targetDeviceId =
        typeof body.target_device_id === 'string' && body.target_device_id.trim()
          ? body.target_device_id.trim()
          : sourceDeviceId;
      const rawTargetJid = typeof body.target_jid === 'string' ? body.target_jid.trim() : '';
      const targetJid = normalizeWhatsAppJid(rawTargetJid);

      if (!sourceDeviceId || !sourceChatJid || !messageId || isNewsletterJid(sourceChatJid)) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'بيانات الرسالة المصدر غير صالحة'});
        return;
      }
      if (!targetDeviceId || !targetJid || isNewsletterJid(targetJid)) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'الحساب أو المستلم الهدف غير صالح'});
        return;
      }

      try {
        assertDeviceAccess(req.user, targetDeviceId);
        if (!hasChatReadPermission(req.user!, sourceChatJid)) {
          throw new GowaError(403, 'FORBIDDEN', 'ليس لديك صلاحية الوصول إلى الرسالة المصدر');
        }
        assertChatContentAccess(req.user!, sourceDeviceId, sourceChatJid);
        const cached = getCachedMessage(sourceDeviceId, sourceChatJid, messageId);
        if (cached?.is_revoked) {
          res.status(400).json({code: 'MESSAGE_REVOKED', message: 'لا يمكن إعادة توجيه رسالة محذوفة'});
          return;
        }

        const content = (
          cached?.content || (typeof body.content === 'string' ? body.content : '')
        ).trim();
        const mediaType = (
          cached?.media_type || (typeof body.media_type === 'string' ? body.media_type : '')
        ).trim();
        const filename = (
          cached?.filename || (typeof body.filename === 'string' ? body.filename : '')
        ).trim();
        const fallbackUrl = cached?.url?.trim() ?? '';

        if (!content && !mediaType) {
          res.status(400).json({code: 'VALIDATION_ERROR', message: 'محتوى الرسالة غير متوفر لإعادة التوجيه'});
          return;
        }

        await assertDeviceConnected(
          targetDeviceId,
          'الحساب الهدف غير متصل حاليًا بواتساب. يرجى اختيار حساب متصل.',
        );

        let sent: {message_id: string; status: string} | undefined;
        let resolvedFilename = filename;
        let resolvedMediaType = mediaType;
        let resolvedLength = cached?.file_length ?? 0;

        if (mediaType) {
          let downloaded: GowaDownloadedMedia | null = null;
          try {
            const dl = await gowaFetch<GowaDownloadedMedia | null>(
              `/message/${encodeURIComponent(messageId)}/download`,
              {
                deviceId: sourceDeviceId,
                query: {phone: sourceChatJid},
                timeoutMs: 25_000,
              },
            );
            if (dl && (dl.file_path || dl.file_url)) {
              downloaded = dl;
            }
          } catch (err) {
            if (!fallbackUrl || fallbackUrl.includes('mmg.whatsapp.net')) {
              throw err;
            }
          }

          if (!downloaded && fallbackUrl && !fallbackUrl.includes('mmg.whatsapp.net')) {
            downloaded = {
              message_id: messageId,
              media_type: mediaType,
              filename,
              file_path: fallbackUrl,
              file_size: 0,
            };
          }

          const assetPath = downloaded?.file_path || downloaded?.file_url || '';
          if (!assetPath) {
            res.status(404).json({
              code: 'MEDIA_NOT_AVAILABLE',
              message: 'ملف الوسائط غير متوفر على الخادم لإعادة توجيهه',
            });
            return;
          }

          const asset = await gowaFetchBinary(assetPath, {deviceId: sourceDeviceId});
          const candidateName =
            filename || downloaded?.filename || asset.filename || 'forwarded-file';
          const mimeType = inferForwardMimeType(mediaType, candidateName, asset.contentType);
          const target = resolveGowaMediaTarget(mimeType, candidateName);

          const formData = new FormData();
          formData.set('phone', targetJid);
          formData.set('is_forwarded', 'true');
          if (target.supportsCaption && content) {
            formData.set('caption', content);
          }
          formData.set(
            target.fieldName,
            new Blob([new Uint8Array(asset.buffer)], {type: target.mimeType}),
            target.filename,
          );

          sent = await gowaFetch<{message_id: string; status: string}>(target.endpoint, {
            method: 'POST',
            deviceId: targetDeviceId,
            formData,
            timeoutMs: 45_000,
          });
          resolvedFilename = target.filename;
          resolvedMediaType = target.mediaType;
          resolvedLength = asset.buffer.byteLength;
        } else {
          sent = await gowaFetch<{message_id: string; status: string}>('/send/message', {
            method: 'POST',
            deviceId: targetDeviceId,
            body: {
              phone: targetJid,
              message: content,
              is_forwarded: true,
            },
          });
        }

        if (sent?.message_id) {
          upsertCachedMessages(targetDeviceId, targetJid, [
            {
              id: sent.message_id,
              chat_jid: targetJid,
              sender_jid: 'me',
              content: mediaType && resolvedMediaType === 'audio' ? '' : content,
              timestamp: new Date().toISOString(),
              is_from_me: true,
              media_type: resolvedMediaType,
              filename: resolvedFilename,
              url: '',
              file_length: resolvedLength,
            },
          ]);
        }
        if (req.user) {
          markChatReadForUser(req.user.id, targetDeviceId, targetJid);
        }
        wsBridge.broadcast({
          code: 'CHAT_UPDATED',
          message: 'forwarded',
          device_id: targetDeviceId,
          result: {chat_jid: targetJid, message_id: sent?.message_id},
        });

        res.json({
          code: 'SUCCESS',
          message: 'تمت إعادة توجيه الرسالة',
          results: {
            ...(sent ?? {}),
            target_device_id: targetDeviceId,
            target_jid: targetJid,
          },
        });
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );
}
