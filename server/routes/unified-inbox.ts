import express, {type Router} from 'express';
import {
  clearChatCatchup,
  clearChatHistoryInDb,
  createChatListForUser,
  createConversationNote,
  deleteChatInDb,
  deleteChatListForUser,
  deleteConversationNote,
  getAccountAliases,
  getCachedAvatar,
  getCachedMessage,
  getConversationNoteById,
  getUnreadCountsForUser,
  getUserMutedChatKeys,
  isChatBlocked,
  listChatListsForUser,
  listConversationNotes,
  markCachedMessageRevoked,
  markChatReadForUser,
  markChatUnreadForUser,
  parseTimestampMs,
  setChatArchiveOverride,
  setChatBlockedState,
  setChatListMembership,
  setChatPinState,
  setUserChatFavourite,
  setUserChatMute,
  syncAndMergeChatMessages,
  syncChatWatermarks,
  updateConversationNote,
  upsertCachedAvatar,
  upsertCachedMessages,
  type CachedAvatarRow,
} from '../db.ts';
import {
  fetchPublicAvatarImage,
  GowaError,
  gowaFetch,
  gowaFetchBinary,
  type GowaAvatarInfo,
  type GowaChatInfo,
  type GowaDevice,
  type GowaDeviceStatus,
  type GowaDownloadedMedia,
  type GowaMessageInfo,
  type GowaPagination,
} from '../gowa-client.ts';
import {
  assertDeviceAccess,
  createApiRouter,
  handleRouteError,
  requireAnyPermission,
  requireAuth,
  requirePermission,
} from '../middleware/auth.ts';
import {
  filterAllowedDevices,
  hasDeviceAccess,
  hasPermission,
  isAdminSubject,
} from '../rbac.ts';
import {buildSafeMediaHeaders, decodeRouteParam} from '../security.ts';
import {
  inferForwardMimeType,
  isGroupJid,
  isNewsletterJid,
  MAX_MEDIA_UPLOAD_BYTES,
  normalizePhoneQueryForGowa,
  normalizeSearchQuery,
  normalizeWhatsAppJid,
  recipientMatchesChatJid,
  resolveAccountDisplayName,
  resolveGowaMediaTarget,
} from '../services/chat-sync.ts';
import {
  createScheduleViaGowa,
  executeScheduleAction,
  rescheduleChatSchedule,
  validateAndBuildSchedulePayload,
  type ScheduleInputBody,
} from '../services/schedule-service.ts';
import {
  assertChatContentAccess,
  enforceInboxPolicyBeforeSend,
  getChatContentAccessState,
  listAssignmentsForDevices,
  type ChatAssignmentInfo,
} from '../services/chat-lifecycle.ts';
import {
  computeUnifiedTabCounts,
  enrichUnifiedChatsWithUnreadAndLifecycle,
  fetchRemoteChatsForDevices,
  paginateUnifiedChats,
  parseUnifiedChatsQuery,
  refreshAssignmentsAfterRemoteFetch,
  runInitialUnreadCatchup,
  type RemoteUnifiedChat,
} from '../services/unified-chats-service.ts';
import type {AuthedRequest} from '../types.ts';
import {
  chatArchiveBodySchema,
  chatBlockBodySchema,
  chatFavouriteBodySchema,
  chatListCreateSchema,
  chatListsAssignSchema,
  chatMuteBodySchema,
  chatPinBodySchema,
  chatUnreadBodySchema,
  conversationNoteCreateSchema,
  conversationNotePatchSchema,
  parsePositiveIntId,
  parseSchema,
  reactionBodySchema,
  sendTextMessageSchema,
} from '../validation/schemas.ts';
import type {GowaWsBridge} from '../ws-bridge.ts';

const AVATAR_OK_TTL_MS = 1000 * 60 * 60 * 24;
const AVATAR_NONE_TTL_MS = 1000 * 60 * 60;
const avatarInflight = new Map<string, Promise<CachedAvatarRow | null>>();

export function registerUnifiedInboxRoutes(wsBridge: GowaWsBridge): Router {
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
    '/api/unified/chats',
    requireAuth,
    requirePermission('chats', 'read'),
    async (req: AuthedRequest, res) => {
      try {
        const query = parseUnifiedChatsQuery(req.query as Record<string, unknown>, req.user!);
        const aliases = getAccountAliases();
        const allDevices = (await gowaFetch<GowaDevice[]>('/devices', {timeoutMs: 10_000})) ?? [];
        const devices = filterAllowedDevices(req.user!, allDevices);
        const deviceInfoMap = new Map<string, {device: GowaDevice; displayName: string}>();
        for (const dev of devices) {
          deviceInfoMap.set(dev.id, {device: dev, displayName: resolveAccountDisplayName(dev, aliases)});
        }

        const targetDevices =
          query.selectedDeviceSet.size > 0
            ? devices.filter((d) => query.selectedDeviceSet.has(d.id))
            : devices;
        const targetDeviceIds = targetDevices.map((d) => d.id);

        const skipRemoteScan =
          query.offset > 0 &&
          !query.isSearchMode &&
          !query.hasMedia &&
          (query.requestedTab === 'closed' || query.requestedTab === 'me');

        let assignmentsMap: Map<string, ChatAssignmentInfo> = skipRemoteScan
          ? new Map()
          : listAssignmentsForDevices(targetDeviceIds);

        let allChats: RemoteUnifiedChat[] = [];
        let totalRemoteChats = 0;
        let anyDeviceHasMore = false;
        let deviceErrors: Array<{device_id: string; display_name: string; message: string}> = [];

        if (!skipRemoteScan) {
          const remote = await fetchRemoteChatsForDevices({targetDevices, aliases, query});
          allChats = remote.allChats;
          totalRemoteChats = remote.totalRemoteChats;
          anyDeviceHasMore = remote.anyDeviceHasMore;
          deviceErrors = remote.deviceErrors;
          assignmentsMap = refreshAssignmentsAfterRemoteFetch(
            allChats,
            assignmentsMap,
            targetDeviceIds,
          );
        }

        const remoteByKey = new Map<string, RemoteUnifiedChat>();
        for (const chat of allChats) {
          remoteByKey.set(`${chat.device_id}::${chat.jid}`, chat);
        }

        const effectiveMeOwnerId = query.isSupervisor
          ? query.assignedFilterUserId === req.user!.id || typeof query.assignedFilterUserId === 'number'
            ? query.assignedFilterUserId
            : null
          : req.user!.id;

        const tabCounts = computeUnifiedTabCounts({
          targetDeviceIds,
          allChats,
          assignmentsMap,
          remoteByKey,
          totalRemoteChats,
          anyDeviceHasMore,
          skipRemoteScan,
          effectiveMeOwnerId,
          query,
        });

        const {pagedChats, totalAvailable, hasMore} = paginateUnifiedChats({
          query,
          userId: req.user!.id,
          targetDeviceIds,
          deviceInfoMap,
          allChats,
          remoteByKey,
          assignmentsMap,
          tabCounts,
          totalRemoteChats,
          anyDeviceHasMore,
          effectiveMeOwnerId,
        });

        if (query.offset === 0 && query.requestedTab !== 'closed' && pagedChats.length > 0) {
          await runInitialUnreadCatchup({pagedChats, devices, user: req.user!, wsBridge});
        }

        const {enrichedChats, totalUnread} = enrichUnifiedChatsWithUnreadAndLifecycle({
          user: req.user!,
          pagedChats,
          assignmentsMap,
        });

        res.json({
          code: 'SUCCESS',
          message: 'ok',
          results: {
            data: enrichedChats,
            total: enrichedChats.length,
            pagination: {
              limit: query.limit,
              offset: query.offset,
              total: totalAvailable,
              has_more: hasMore,
              next_offset: query.offset + query.limit,
            },
            tab_counts: tabCounts,
            total_unread: totalUnread,
            muted_keys: getUserMutedChatKeys(req.user!.id),
            chat_lists: listChatListsForUser(req.user!.id),
            accounts: devices.map((d) => ({
              id: d.id,
              display_name: resolveAccountDisplayName(d, aliases),
              phone_number: d.phone_number ?? null,
              state: d.state,
            })),
            device_errors: deviceErrors,
          },
        });
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.post(
    '/api/unified/chats/:deviceId/:jid/read',
    requireAuth,
    requirePermission('chats', 'read'),
    requireDeviceParamAccess,
    (req: AuthedRequest, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const chatJid = decodeRouteParam(req.params.jid);
      try {
        const access = getChatContentAccessState(req.user!, deviceId, chatJid);
        if (!access.allowed) {
          res.json({
            code: 'SUCCESS',
            message: 'ok',
            results: {
              chat_jid: chatJid,
              last_read_seq: 0,
              content_redacted: true,
              redaction_reason: access.reason,
            },
          });
          return;
        }
        const lastReadSeq = markChatReadForUser(req.user!.id, deviceId, chatJid);
        res.json({
          code: 'SUCCESS',
          message: 'ok',
          results: {chat_jid: chatJid, last_read_seq: lastReadSeq},
        });
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.get(
    '/api/unified/chats/:deviceId/:jid/messages',
    requireAuth,
    requireAnyPermission(['chats:read', 'groups:read']),
    requireDeviceParamAccess,
    async (req: AuthedRequest, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const chatJid = decodeRouteParam(req.params.jid);
      if (!hasPermission(req.user!, 'chats', 'read') && !isGroupJid(chatJid)) {
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
        const merged = syncAndMergeChatMessages(deviceId, chatJid, data?.data ?? [], {
          offset,
          limit,
          search: search || undefined,
          mediaOnly,
        });
        const liveTotal = data?.pagination?.total;
        res.json({
          code: 'SUCCESS',
          message: 'ok',
          results: {
            ...data,
            data: merged.messages,
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
      if (!hasPermission(req.user!, 'chats', 'read') && !isGroupJid(chatJid)) {
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
        if (isChatBlocked(deviceId, chatJid)) {
          res.status(403).json({
            code: 'CHAT_BLOCKED',
            message: 'تم حظر هذه المحادثة؛ قم بإلغاء الحظر أولًا لإرسال الرسائل.',
          });
          return;
        }
        const status = await gowaFetch<GowaDeviceStatus>(
          `/devices/${encodeURIComponent(deviceId)}/status`,
        );
        if (!status?.is_logged_in) {
          res.status(409).json({
            code: 'DEVICE_NOT_CONNECTED',
            message: 'هذا الحساب غير متصل حاليًا بواتساب. يرجى إعادة ربط الحساب قبل الإرسال.',
          });
          return;
        }

        const policyResult = enforceInboxPolicyBeforeSend(req.user!, deviceId, chatJid);

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
        if (policyResult.lifecycleEvent) {
          wsBridge.broadcast(policyResult.lifecycleEvent);
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
        if (isChatBlocked(deviceId, chatJid)) {
          res.status(403).json({
            code: 'CHAT_BLOCKED',
            message: 'تم حظر هذه المحادثة؛ قم بإلغاء الحظر أولًا لإرسال الرسائل.',
          });
          return;
        }
        const target = resolveGowaMediaTarget(rawMimeType, rawFilename);

        const status = await gowaFetch<GowaDeviceStatus>(
          `/devices/${encodeURIComponent(deviceId)}/status`,
        );
        if (!status?.is_logged_in) {
          res.status(409).json({
            code: 'DEVICE_NOT_CONNECTED',
            message: 'هذا الحساب غير متصل حاليًا بواتساب. يرجى إعادة ربط الحساب قبل الإرسال.',
          });
          return;
        }

        const policyResult = enforceInboxPolicyBeforeSend(req.user!, deviceId, chatJid);

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
        if (policyResult.lifecycleEvent) {
          wsBridge.broadcast(policyResult.lifecycleEvent);
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
        const status = await gowaFetch<GowaDeviceStatus>(
          `/devices/${encodeURIComponent(deviceId)}/status`,
        );
        if (!status?.is_logged_in) {
          res.status(409).json({
            code: 'DEVICE_NOT_CONNECTED',
            message: 'هذا الحساب غير متصل حاليًا بواتساب. يرجى إعادة ربط الحساب قبل التفاعل.',
          });
          return;
        }

        const result = await gowaFetch(`/message/${encodeURIComponent(messageId)}/reaction`, {
          method: 'POST',
          deviceId,
          body: {
            phone: chatJid,
            emoji,
          },
        });

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
        const status = await gowaFetch<GowaDeviceStatus>(
          `/devices/${encodeURIComponent(deviceId)}/status`,
        );
        if (!status?.is_logged_in) {
          res.status(409).json({
            code: 'DEVICE_NOT_CONNECTED',
            message: 'هذا الحساب غير متصل حاليًا بواتساب. يرجى إعادة ربط الحساب قبل حذف الرسالة.',
          });
          return;
        }

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
        url?: unknown;
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
        const fallbackUrl = (
          cached?.url || (typeof body.url === 'string' ? body.url : '')
        ).trim();

        if (!content && !mediaType) {
          res.status(400).json({code: 'VALIDATION_ERROR', message: 'محتوى الرسالة غير متوفر لإعادة التوجيه'});
          return;
        }

        const status = await gowaFetch<GowaDeviceStatus>(
          `/devices/${encodeURIComponent(targetDeviceId)}/status`,
        );
        if (!status?.is_logged_in) {
          res.status(409).json({
            code: 'DEVICE_NOT_CONNECTED',
            message: 'الحساب الهدف غير متصل حاليًا بواتساب. يرجى اختيار حساب متصل.',
          });
          return;
        }

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

          const asset = await gowaFetchBinary(assetPath);
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

  // Conversation Notes
  router.get(
    '/api/unified/chats/:deviceId/:jid/notes',
    requireAuth,
    requirePermission('notes', 'read'),
    requireDeviceParamAccess,
    (req: AuthedRequest, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const chatJid = decodeRouteParam(req.params.jid);
      try {
        const access = getChatContentAccessState(req.user!, deviceId, chatJid);
        if (!access.allowed) {
          res.json({
            code: 'SUCCESS',
            message: 'ok',
            results: {
              notes: [],
              total: 0,
              content_redacted: true,
              redaction_reason: access.reason,
            },
          });
          return;
        }
        const notes = listConversationNotes(deviceId, chatJid);
        res.json({
          code: 'SUCCESS',
          message: 'ok',
          results: {notes, total: notes.length},
        });
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.post(
    '/api/unified/chats/:deviceId/:jid/notes',
    requireAuth,
    requirePermission('notes', 'write'),
    requireDeviceParamAccess,
    (req: AuthedRequest, res) => {
      try {
        const deviceId = decodeRouteParam(req.params.deviceId);
        const chatJid = decodeRouteParam(req.params.jid);
        assertChatContentAccess(req.user!, deviceId, chatJid);
        const parsed = parseSchema(conversationNoteCreateSchema, req.body ?? {});
        const note = createConversationNote({
          deviceId,
          chatJid,
          createdById: req.user!.id,
          createdByName: req.user!.display_name,
          content: parsed.content,
          isPinned: parsed.is_pinned === true,
        });
        wsBridge.broadcast({
          code: 'CONVERSATION_NOTE_UPDATED',
          message: 'created',
          device_id: deviceId,
          result: {chat_jid: chatJid, note_id: note.id},
        });
        res.status(201).json({code: 'SUCCESS', message: 'تمت إضافة الملاحظة', results: note});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.patch(
    '/api/unified/chats/:deviceId/:jid/notes/:noteId',
    requireAuth,
    requirePermission('notes', 'write'),
    requireDeviceParamAccess,
    (req: AuthedRequest, res) => {
      try {
        const deviceId = decodeRouteParam(req.params.deviceId);
        const chatJid = decodeRouteParam(req.params.jid);
        assertChatContentAccess(req.user!, deviceId, chatJid);
        const noteId = parsePositiveIntId(req.params.noteId, 'معرّف الملاحظة');

        const existing = getConversationNoteById(noteId, deviceId, chatJid);
        if (!existing) {
          res.status(404).json({code: 'NOT_FOUND', message: 'الملاحظة غير موجودة'});
          return;
        }

        const parsed = parseSchema(conversationNotePatchSchema, req.body ?? {});
        const hasContent = parsed.content !== undefined;
        const hasPin = typeof parsed.is_pinned === 'boolean';

        const canModerateNotes =
          isAdminSubject(req.user!) || hasPermission(req.user!, 'notes', 'delete');
        if (hasContent && existing.created_by_id !== req.user!.id && !canModerateNotes) {
          res.status(403).json({code: 'FORBIDDEN', message: 'يمكنك تعديل ملاحظاتك فقط'});
          return;
        }

        const updated = updateConversationNote(noteId, deviceId, chatJid, {
          content: parsed.content,
          is_pinned: hasPin ? Boolean(parsed.is_pinned) : undefined,
        });
        wsBridge.broadcast({
          code: 'CONVERSATION_NOTE_UPDATED',
          message: 'updated',
          device_id: deviceId,
          result: {chat_jid: chatJid, note_id: noteId},
        });
        res.json({code: 'SUCCESS', message: 'تم تحديث الملاحظة', results: updated});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.delete(
    '/api/unified/chats/:deviceId/:jid/notes/:noteId',
    requireAuth,
    requireAnyPermission(['notes:write', 'notes:delete']),
    requireDeviceParamAccess,
    (req: AuthedRequest, res) => {
      try {
        const deviceId = decodeRouteParam(req.params.deviceId);
        const chatJid = decodeRouteParam(req.params.jid);
        assertChatContentAccess(req.user!, deviceId, chatJid);
        const noteId = parsePositiveIntId(req.params.noteId, 'معرّف الملاحظة');

      const existing = getConversationNoteById(noteId, deviceId, chatJid);
      if (!existing) {
        res.status(404).json({code: 'NOT_FOUND', message: 'الملاحظة غير موجودة'});
        return;
      }
      const canDeleteOthers =
        isAdminSubject(req.user!) || hasPermission(req.user!, 'notes', 'delete');
      if (existing.created_by_id !== req.user!.id && !canDeleteOthers) {
        res.status(403).json({code: 'FORBIDDEN', message: 'يمكنك حذف ملاحظاتك فقط'});
        return;
      }

      deleteConversationNote(noteId, deviceId, chatJid);
      wsBridge.broadcast({
        code: 'CONVERSATION_NOTE_UPDATED',
        message: 'deleted',
        device_id: deviceId,
        result: {chat_jid: chatJid, note_id: noteId},
      });
      res.json({code: 'SUCCESS', message: 'تم حذف الملاحظة'});
    } catch (err) {
      handleRouteError(res, err);
    }
  },
);

  // In-Chat Scheduled Messages
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
        const payload = validateAndBuildSchedulePayload(req.body as ScheduleInputBody, {
          fixedPhone: chatJid,
        });
        const result = await createScheduleViaGowa(deviceId, payload, wsBridge, chatJid);
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
        await executeScheduleAction(deviceId, scheduleId, req.params.action, wsBridge, chatJid);
        res.json({code: 'SUCCESS', message: 'تم تحديث الجدولة'});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  // Media & Avatars
  router.get(
    '/api/unified/media/download',
    requireAuth,
    requireAnyPermission(['chats:read', 'misc:status.read', 'groups:read']),
    async (req: AuthedRequest, res) => {
      const deviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId.trim() : '';
      const messageId = typeof req.query.messageId === 'string' ? req.query.messageId.trim() : '';
      const phone = typeof req.query.phone === 'string' ? req.query.phone.trim() : '';
      const fallbackUrl =
        typeof req.query.fallbackUrl === 'string' ? req.query.fallbackUrl.trim() : '';
      if (!deviceId || !messageId || !phone) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'معلمات الوسائط غير مكتملة'});
        return;
      }
      if (
        !hasPermission(req.user!, 'chats', 'read') &&
        !hasPermission(req.user!, 'misc', 'status.read') &&
        !isGroupJid(phone)
      ) {
        res.status(403).json({code: 'FORBIDDEN', message: 'ليس لديك صلاحية تنفيذ هذا الإجراء'});
        return;
      }
      if (!hasDeviceAccess(req.user!, deviceId)) {
        res.status(403).json({
          code: 'DEVICE_FORBIDDEN',
          message: 'غير مصرح لك بالوصول إلى حساب واتساب هذا',
        });
        return;
      }

    try {
      assertChatContentAccess(req.user!, deviceId, phone);
      let downloaded: GowaDownloadedMedia | null = null;
      try {
        const result = await gowaFetch<GowaDownloadedMedia | null>(
          `/message/${encodeURIComponent(messageId)}/download`,
          {
            deviceId,
            query: {phone},
            timeoutMs: 25_000,
          },
        );
        if (result && (result.file_path || result.file_url)) {
          downloaded = result;
        }
      } catch (err) {
        if (!fallbackUrl) throw err;
      }

      if (!downloaded && fallbackUrl && !fallbackUrl.includes('mmg.whatsapp.net')) {
        downloaded = {
          message_id: messageId,
          media_type: '',
          filename: fallbackUrl.split('/').pop()?.split('?')[0] || '',
          file_path: fallbackUrl,
          file_size: 0,
        };
      }

      if (!downloaded || (!downloaded.file_path && !downloaded.file_url)) {
        res.status(404).json({
          code: 'MEDIA_NOT_AVAILABLE',
          message: 'ملف الوسائط غير متوفر على الخادم حاليًا',
        });
        return;
      }

      res.json({code: 'SUCCESS', message: 'ok', results: downloaded});
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  router.get(
    '/api/unified/media/file',
    requireAuth,
    requireAnyPermission(['chats:read', 'misc:status.read', 'misc:channels.manage', 'groups:read']),
    async (req: AuthedRequest, res) => {
      const filePath = typeof req.query.path === 'string' ? req.query.path : '';
      const deviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId.trim() : '';
      const chatJid = typeof req.query.chatJid === 'string' ? req.query.chatJid.trim() : '';
      try {
        if (!deviceId) {
          res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف الحساب مطلوب'});
          return;
        }
        assertDeviceAccess(req.user, deviceId);
        if (chatJid) {
          assertChatContentAccess(req.user!, deviceId, chatJid);
        }
        const asset = await gowaFetchBinary(filePath);
        const safeHeaders = buildSafeMediaHeaders(asset.contentType, asset.filename);
        res.setHeader('Content-Type', asset.contentType);
        res.setHeader('Content-Disposition', safeHeaders.disposition);
        if (safeHeaders.csp) {
          res.setHeader('Content-Security-Policy', safeHeaders.csp);
        }
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.send(asset.buffer);
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

    const cached = getCachedAvatar(deviceId, jid);
    if (!force && cached) {
      const age = Date.now() - cached.updated_at;
      if (cached.status === 'ok' && cached.image_blob && cached.image_blob.byteLength > 0 && age < AVATAR_OK_TTL_MS) {
        res.setHeader('Content-Type', cached.content_type || 'image/jpeg');
        res.setHeader('Cache-Control', 'private, max-age=3600');
        res.send(Buffer.from(cached.image_blob));
        return;
      }
      if (cached.status === 'none' && age < AVATAR_NONE_TTL_MS) {
        res.status(204).end();
        return;
      }
    }

    const inflightKey = `${deviceId}::${jid}`;
    let pending = avatarInflight.get(inflightKey);
    if (!pending) {
      pending = (async (): Promise<CachedAvatarRow | null> => {
        try {
          const targetPhone = normalizeSearchQuery(jid) || jid;
          const info = await gowaFetch<GowaAvatarInfo | null>('/user/avatar', {
            deviceId,
            query: {phone: targetPhone, is_preview: true},
            timeoutMs: 7_000,
          });
          const avatarUrl = info?.url?.trim() || '';
          if (!avatarUrl) {
            upsertCachedAvatar({
              deviceId,
              jid,
              avatarUrl: '',
              imageBlob: null,
              contentType: '',
              status: 'none',
            });
            return null;
          }

          const downloaded = await fetchPublicAvatarImage(avatarUrl);
          upsertCachedAvatar({
            deviceId,
            jid,
            avatarUrl,
            imageBlob: downloaded.buffer,
            contentType: downloaded.contentType,
            status: 'ok',
          });
          return {
            device_id: deviceId,
            jid,
            avatar_url: avatarUrl,
            image_blob: downloaded.buffer,
            content_type: downloaded.contentType,
            status: 'ok',
            updated_at: Date.now(),
          };
        } catch (err) {
          if (err instanceof GowaError && (err.status === 400 || err.status === 404 || err.code.startsWith('AVATAR_'))) {
            upsertCachedAvatar({
              deviceId,
              jid,
              avatarUrl: '',
              imageBlob: null,
              contentType: '',
              status: 'none',
            });
            return null;
          }
          if (cached?.status === 'ok' && cached.image_blob && cached.image_blob.byteLength > 0) {
            return cached;
          }
          return null;
        } finally {
          avatarInflight.delete(inflightKey);
        }
      })();
      avatarInflight.set(inflightKey, pending);
    }

    const resolved = await pending;
    if (resolved && resolved.status === 'ok' && resolved.image_blob && resolved.image_blob.byteLength > 0) {
      res.setHeader('Content-Type', resolved.content_type || 'image/jpeg');
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.send(Buffer.from(resolved.image_blob));
      return;
    }
      res.status(204).end();
    });

  // Chat Row Menu Actions & Custom Lists
  router.post(
    '/api/unified/chats/:deviceId/:jid/archive',
    requireAuth,
    requirePermission('chats', 'write'),
    requireDeviceParamAccess,
    async (req: AuthedRequest, res) => {
      try {
        const deviceId = decodeRouteParam(req.params.deviceId);
        const chatJid = decodeRouteParam(req.params.jid);
        const {archived} = parseSchema(chatArchiveBodySchema, req.body ?? {});

        let syncedRemote = false;
        try {
          const status = await gowaFetch<GowaDeviceStatus>(
            `/devices/${encodeURIComponent(deviceId)}/status`,
          );
          if (status?.is_logged_in) {
            await gowaFetch(`/chat/${encodeURIComponent(chatJid)}/archive`, {
              method: 'POST',
              deviceId,
              body: {archived},
            });
            syncedRemote = true;
          }
        } catch (err) {
          if (
            !(err instanceof GowaError) ||
            (err.code !== 'GOWA_NOT_CONFIGURED' && err.status !== 502 && err.status !== 503)
          ) {
            throw err;
          }
        }

        const state = setChatArchiveOverride(deviceId, chatJid, archived);
        wsBridge.broadcast({
          code: 'CHAT_UPDATED',
          message: archived ? 'archived' : 'unarchived',
          device_id: deviceId,
          result: {chat_jid: chatJid},
        });
        res.json({
          code: 'SUCCESS',
          message: archived ? 'تمت أرشفة المحادثة' : 'تم إلغاء أرشفة المحادثة',
          results: {
            chat_jid: chatJid,
            archived: Boolean(state.archived_override),
            synced_remote: syncedRemote,
          },
        });
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.post(
    '/api/unified/chats/:deviceId/:jid/pin',
    requireAuth,
    requirePermission('chats', 'write'),
    requireDeviceParamAccess,
    async (req: AuthedRequest, res) => {
      try {
        const deviceId = decodeRouteParam(req.params.deviceId);
        const chatJid = decodeRouteParam(req.params.jid);
        const {pinned} = parseSchema(chatPinBodySchema, req.body ?? {});

        let syncedRemote = false;
        try {
          const status = await gowaFetch<GowaDeviceStatus>(
            `/devices/${encodeURIComponent(deviceId)}/status`,
          );
          if (status?.is_logged_in) {
            await gowaFetch(`/chat/${encodeURIComponent(chatJid)}/pin`, {
              method: 'POST',
              deviceId,
              body: {pinned},
            });
            syncedRemote = true;
          }
        } catch (err) {
          if (
            !(err instanceof GowaError) ||
            (err.code !== 'GOWA_NOT_CONFIGURED' && err.status !== 502 && err.status !== 503)
          ) {
            throw err;
          }
        }

        const state = setChatPinState(deviceId, chatJid, pinned);
        wsBridge.broadcast({
          code: 'CHAT_UPDATED',
          message: pinned ? 'pinned' : 'unpinned',
          device_id: deviceId,
          result: {chat_jid: chatJid},
        });
        res.json({
          code: 'SUCCESS',
          message: pinned ? 'تم تثبيت المحادثة' : 'تم إلغاء تثبيت المحادثة',
          results: {
            chat_jid: chatJid,
            is_pinned: state.is_pinned,
            pinned_at_ms: state.pinned_at_ms,
            synced_remote: syncedRemote,
          },
        });
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.post(
    '/api/unified/chats/:deviceId/:jid/mute',
    requireAuth,
    requirePermission('chats', 'read'),
    requireDeviceParamAccess,
    (req: AuthedRequest, res) => {
      try {
        const deviceId = decodeRouteParam(req.params.deviceId);
        const chatJid = decodeRouteParam(req.params.jid);
        const {duration} = parseSchema(chatMuteBodySchema, req.body ?? {});
        const mutedUntilMs = setUserChatMute(req.user!.id, deviceId, chatJid, duration);
        res.json({
          code: 'SUCCESS',
          message: duration === 'unmute' ? 'تم إلغاء كتم الإشعارات' : 'تم كتم إشعارات المحادثة',
          results: {chat_jid: chatJid, muted_until_ms: mutedUntilMs},
        });
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.post(
    '/api/unified/chats/:deviceId/:jid/unread',
    requireAuth,
    requirePermission('chats', 'read'),
    requireDeviceParamAccess,
    (req: AuthedRequest, res) => {
      try {
        const deviceId = decodeRouteParam(req.params.deviceId);
        const chatJid = decodeRouteParam(req.params.jid);
        const {unread} = parseSchema(chatUnreadBodySchema, req.body ?? {});
        if (unread) {
          markChatUnreadForUser(req.user!.id, deviceId, chatJid);
        } else {
          markChatReadForUser(req.user!.id, deviceId, chatJid);
        }
        res.json({
          code: 'SUCCESS',
          message: unread ? 'تم التحديد كغير مقروءة' : 'تم التحديد كمقروءة',
          results: {chat_jid: chatJid, unread},
        });
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.post(
    '/api/unified/chats/:deviceId/:jid/favourite',
    requireAuth,
    requirePermission('chats', 'read'),
    requireDeviceParamAccess,
    (req: AuthedRequest, res) => {
      try {
        const deviceId = decodeRouteParam(req.params.deviceId);
        const chatJid = decodeRouteParam(req.params.jid);
        const {favourite} = parseSchema(chatFavouriteBodySchema, req.body ?? {});
        setUserChatFavourite(req.user!.id, deviceId, chatJid, favourite);
        res.json({
          code: 'SUCCESS',
          message: favourite ? 'تمت الإضافة إلى المفضلة' : 'تمت الإزالة من المفضلة',
          results: {chat_jid: chatJid, is_favourite: favourite},
        });
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.post(
    '/api/unified/chats/:deviceId/:jid/block',
    requireAuth,
    requirePermission('chats', 'write'),
    requireDeviceParamAccess,
    (req: AuthedRequest, res) => {
      try {
        const deviceId = decodeRouteParam(req.params.deviceId);
        const chatJid = decodeRouteParam(req.params.jid);
        const {blocked} = parseSchema(chatBlockBodySchema, req.body ?? {});
        const state = setChatBlockedState(deviceId, chatJid, blocked);
        wsBridge.broadcast({
          code: 'CHAT_UPDATED',
          message: blocked ? 'blocked' : 'unblocked',
          device_id: deviceId,
          result: {chat_jid: chatJid},
        });
        res.json({
          code: 'SUCCESS',
          message: blocked ? 'تم حظر المحادثة داخل النظام' : 'تم إلغاء حظر المحادثة',
          results: {chat_jid: chatJid, is_blocked: state.is_blocked},
        });
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.post(
    '/api/unified/chats/:deviceId/:jid/clear',
    requireAuth,
    requirePermission('chats', 'revoke'),
    requireDeviceParamAccess,
    (req: AuthedRequest, res) => {
      try {
        const deviceId = decodeRouteParam(req.params.deviceId);
        const chatJid = decodeRouteParam(req.params.jid);
        const result = clearChatHistoryInDb(deviceId, chatJid);
        wsBridge.broadcast({
          code: 'CHAT_UPDATED',
          message: 'cleared',
          device_id: deviceId,
          result: {chat_jid: chatJid},
        });
        res.json({
          code: 'SUCCESS',
          message: 'تم مسح سجل رسائل المحادثة داخل النظام',
          results: {
            chat_jid: chatJid,
            cleared_before_ms: result.clearedBeforeMs,
            deleted_messages: result.deletedMessages,
          },
        });
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.post(
    '/api/unified/chats/:deviceId/:jid/delete',
    requireAuth,
    requirePermission('chats', 'revoke'),
    requireDeviceParamAccess,
    (req: AuthedRequest, res) => {
      try {
        const deviceId = decodeRouteParam(req.params.deviceId);
        const chatJid = decodeRouteParam(req.params.jid);
        const result = deleteChatInDb(deviceId, chatJid);
        wsBridge.broadcast({
          code: 'CHAT_UPDATED',
          message: 'deleted',
          device_id: deviceId,
          result: {chat_jid: chatJid},
        });
        res.json({
          code: 'SUCCESS',
          message: 'تم حذف المحادثة من النظام',
          results: {
            chat_jid: chatJid,
            deleted_before_ms: result.deletedBeforeMs,
          },
        });
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

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

  return router;
}
