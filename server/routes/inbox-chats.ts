import type {Router} from 'express';
import {
  clearChatHistoryInDb,
  deleteChatInDb,
  getAccountAliases,
  getUserMutedChatKeys,
  listChatListsForUser,
  markChatReadForUser,
  markChatUnreadForUser,
  setChatArchiveOverride,
  setChatBlockedState,
  setChatPinState,
  setUserChatFavourite,
  setUserChatMute,
} from '../db.ts';
import {gowaFetch, type GowaDevice} from '../gowa-client.ts';
import {
  handleRouteError,
  requireAuth,
  requireDeviceParamAccess,
  requirePermission,
} from '../middleware/auth.ts';
import {filterAllowedDevices} from '../rbac.ts';
import {decodeRouteParam} from '../security.ts';
import {getChatContentAccessState, listAssignmentsForDevices, type ChatAssignmentInfo} from '../services/chat-lifecycle.ts';
import {resolveAccountDisplayName} from '../services/chat-sync.ts';
import {trySyncRemoteChatState} from '../services/gowa-guards.ts';
import {
  computeUnifiedTabCounts,
  enrichUnifiedChatsWithUnreadAndLifecycle,
  fetchRemoteChatsForDevices,
  paginateUnifiedChats,
  parseUnifiedChatsQuery,
  refreshAssignmentsAfterRemoteFetch,
  resolveMissingChatMessagePresence,
  runInitialUnreadCatchup,
  type RemoteUnifiedChat,
} from '../services/unified-chats-service.ts';
import type {AuthedRequest} from '../types.ts';
import {
  chatArchiveBodySchema,
  chatBlockBodySchema,
  chatFavouriteBodySchema,
  chatMuteBodySchema,
  chatPinBodySchema,
  chatUnreadBodySchema,
  parseSchema,
} from '../validation/schemas.ts';
import type {GowaWsBridge} from '../ws-bridge.ts';

export function registerInboxChatRoutes(router: Router, wsBridge: GowaWsBridge): void {
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
          (query.requestedTab === 'closed' ||
            query.requestedTab === 'me' ||
            query.requestedTab === 'open');

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
          ? query.assignedFilterUserId !== undefined
            ? query.assignedFilterUserId
            : req.user!.id
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
          userId: req.user!.id,
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
        if (query.requestedTab !== 'closed' && pagedChats.length > 0) {
          await resolveMissingChatMessagePresence({pagedChats, devices, user: req.user!});
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

        const syncedRemote = await trySyncRemoteChatState(
          deviceId,
          `/chat/${encodeURIComponent(chatJid)}/archive`,
          {archived},
        );

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

        const syncedRemote = await trySyncRemoteChatState(
          deviceId,
          `/chat/${encodeURIComponent(chatJid)}/pin`,
          {pinned},
        );

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
}
