import type {Router} from 'express';
import {
  clearChatCatchup,
  createConversationNote,
  deleteConversationNote,
  getAccountAliases,
  getCachedAvatar,
  getConversationNoteById,
  getUnreadCountsForUser,
  listConversationNotes,
  markChatReadForUser,
  parseTimestampMs,
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
import {createApiRouter, handleRouteError, requireAuth} from '../middleware/auth.ts';
import {decodeRouteParam} from '../security.ts';
import {
  matchesUnifiedChatSearch,
  normalizePhoneQueryForGowa,
  normalizeSearchQuery,
  recipientMatchesChatJid,
  resolveAccountDisplayName,
} from '../services/chat-sync.ts';
import {
  createScheduleViaGowa,
  executeScheduleAction,
  rescheduleChatSchedule,
  validateAndBuildSchedulePayload,
  type ScheduleInputBody,
} from '../services/schedule-service.ts';
import type {AuthedRequest} from '../types.ts';
import type {GowaWsBridge} from '../ws-bridge.ts';

const AVATAR_OK_TTL_MS = 1000 * 60 * 60 * 24;
const AVATAR_NONE_TTL_MS = 1000 * 60 * 60;
const avatarInflight = new Map<string, Promise<CachedAvatarRow | null>>();

export function registerUnifiedInboxRoutes(wsBridge: GowaWsBridge): Router {
  const router = createApiRouter();

  router.get('/api/unified/chats', requireAuth, async (req: AuthedRequest, res) => {
    const filterDeviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId.trim() : '';
    const filterDeviceIdsRaw =
      typeof req.query.deviceIds === 'string' ? req.query.deviceIds.trim() : '';
    const rawSearch = typeof req.query.search === 'string' ? req.query.search : '';
    const search = normalizePhoneQueryForGowa(rawSearch);
    const hasMedia = req.query.has_media === 'true';

    const selectedDeviceSet = new Set<string>();
    if (filterDeviceIdsRaw) {
      for (const part of filterDeviceIdsRaw.split(',')) {
        const clean = part.trim();
        if (clean) selectedDeviceSet.add(clean);
      }
    }
    if (filterDeviceId) {
      selectedDeviceSet.add(filterDeviceId);
    }

    try {
      const aliases = getAccountAliases();
      const devices = (await gowaFetch<GowaDevice[]>('/devices')) ?? [];
      const accountMap = new Map<string, {device: GowaDevice; displayName: string}>();
      for (const dev of devices) {
        accountMap.set(dev.id, {
          device: dev,
          displayName: resolveAccountDisplayName(dev, aliases),
        });
      }

      const targetDevices =
        selectedDeviceSet.size > 0
          ? devices.filter((d) => selectedDeviceSet.has(d.id))
          : devices;

      const deviceErrors: Array<{device_id: string; display_name: string; message: string}> = [];
      const allChats: Array<
        GowaChatInfo & {
          device_id: string;
          device_display_name: string;
          device_state: GowaDevice['state'];
        }
      > = [];

      await Promise.all(
        targetDevices.map(async (dev) => {
          const displayName = resolveAccountDisplayName(dev, aliases);
          if (dev.state !== 'logged_in' && dev.state !== 'connected') {
            return;
          }
          try {
            if (!rawSearch.trim()) {
              const response = await gowaFetch<{data: GowaChatInfo[]; pagination: GowaPagination}>(
                '/chats',
                {
                  deviceId: dev.id,
                  query: {
                    limit: 100,
                    offset: 0,
                    has_media: hasMedia ? true : undefined,
                  },
                },
              );
              const items = response?.data ?? [];
              for (const chat of items) {
                allChats.push({
                  ...chat,
                  device_id: dev.id,
                  device_display_name: displayName,
                  device_state: dev.state,
                });
              }
              return;
            }

            const byJid = new Map<string, GowaChatInfo>();
            const directHitJids = new Set<string>();
            const PAGE_LIMIT = 100;
            const MAX_SCAN_CHATS = 1000;

            const [directSearchRes, contactsRes] = await Promise.all([
              search
                ? gowaFetch<{data: GowaChatInfo[]; pagination: GowaPagination}>('/chats', {
                    deviceId: dev.id,
                    query: {
                      limit: 100,
                      offset: 0,
                      search,
                      has_media: hasMedia ? true : undefined,
                    },
                  }).catch(() => null)
                : Promise.resolve(null),
              gowaFetch<{data?: Array<{jid?: string; name?: string}>} | null>('/user/my/contacts', {
                deviceId: dev.id,
                timeoutMs: 4_000,
              }).catch(() => null),
            ]);

            for (const chat of directSearchRes?.data ?? []) {
              byJid.set(chat.jid, chat);
              directHitJids.add(chat.jid);
            }

            const contactNameByJid = new Map<string, string>();
            for (const c of contactsRes?.data ?? []) {
              if (c.jid && c.name) {
                contactNameByJid.set(c.jid, c.name);
              }
            }

            for (let offset = 0; offset < MAX_SCAN_CHATS; offset += PAGE_LIMIT) {
              const page = await gowaFetch<{data: GowaChatInfo[]; pagination: GowaPagination}>(
                '/chats',
                {
                  deviceId: dev.id,
                  query: {
                    limit: PAGE_LIMIT,
                    offset,
                    has_media: hasMedia ? true : undefined,
                  },
                },
              );
              const items = page?.data ?? [];
              for (const chat of items) {
                if (!byJid.has(chat.jid)) {
                  byJid.set(chat.jid, chat);
                }
              }
              const total = page?.pagination?.total ?? 0;
              if (items.length < PAGE_LIMIT || (total > 0 && offset + items.length >= total)) {
                break;
              }
            }

            for (const chat of byJid.values()) {
              const contactName = contactNameByJid.get(chat.jid);
              if (
                directHitJids.has(chat.jid) ||
                matchesUnifiedChatSearch(chat, displayName, rawSearch, contactName)
              ) {
                allChats.push({
                  ...chat,
                  name: chat.name?.trim() || contactName || chat.name,
                  device_id: dev.id,
                  device_display_name: displayName,
                  device_state: dev.state,
                });
              }
            }
          } catch (err) {
            const msg = err instanceof GowaError ? err.message : 'تعذر جلب المحادثات';
            deviceErrors.push({
              device_id: dev.id,
              display_name: displayName,
              message: msg,
            });
          }
        }),
      );

      allChats.sort((a, b) => {
        const ta = new Date(a.last_message_time).getTime();
        const tb = new Date(b.last_message_time).getTime();
        const validA = Number.isNaN(ta) || ta <= 0 ? 0 : ta;
        const validB = Number.isNaN(tb) || tb <= 0 ? 0 : tb;
        return validB - validA;
      });

      const pendingCatchups = syncChatWatermarks(
        allChats.map((c) => ({
          device_id: c.device_id,
          chat_jid: c.jid,
          last_message_time: c.last_message_time,
        })),
      );
      if (pendingCatchups.length > 0) {
        const onlineDeviceSet = new Set(
          devices
            .filter((d) => d.state === 'logged_in' || d.state === 'connected')
            .map((d) => d.id),
        );
        const targetCatchups = pendingCatchups
          .filter((item) => onlineDeviceSet.has(item.device_id))
          .slice(0, 10);

        await Promise.all(
          targetCatchups.map(async (changed) => {
            try {
              const latest = await gowaFetch<{data: GowaMessageInfo[]}>(
                `/chat/${encodeURIComponent(changed.chat_jid)}/messages`,
                {
                  deviceId: changed.device_id,
                  query: {limit: 15, offset: 0},
                  timeoutMs: 3_500,
                },
              );
              if (latest?.data?.length) {
                upsertCachedMessages(changed.device_id, changed.chat_jid, latest.data, {
                  markUnreadCandidate: true,
                  minUnreadTimestampMs: changed.prev_last_message_ms,
                });
              }
              clearChatCatchup(changed.device_id, changed.chat_jid);
            } catch {
              // Keep needs_catchup = 1 so the next poll automatically retries
            }
          }),
        );
      }

      const unreadByChat = getUnreadCountsForUser(
        req.user!,
        allChats.map((c) => ({device_id: c.device_id, chat_jid: c.jid})),
      );

      let totalUnread = 0;
      const enrichedChats = allChats.map((chat) => {
        const unreadCount = unreadByChat.get(`${chat.device_id}::${chat.jid}`) ?? 0;
        totalUnread += unreadCount;
        return {
          ...chat,
          unread_count: unreadCount,
        };
      });

      res.json({
        code: 'SUCCESS',
        message: 'ok',
        results: {
          data: enrichedChats,
          total: enrichedChats.length,
          total_unread: totalUnread,
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
  });

  router.post('/api/unified/chats/:deviceId/:jid/read', requireAuth, (req: AuthedRequest, res) => {
    const deviceId = decodeRouteParam(req.params.deviceId);
    const chatJid = decodeRouteParam(req.params.jid);
    try {
      const lastReadSeq = markChatReadForUser(req.user!.id, deviceId, chatJid);
      res.json({
        code: 'SUCCESS',
        message: 'ok',
        results: {chat_jid: chatJid, last_read_seq: lastReadSeq},
      });
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  router.get('/api/unified/chats/:deviceId/:jid/messages', requireAuth, async (req, res) => {
    const deviceId = decodeRouteParam(req.params.deviceId);
    const chatJid = decodeRouteParam(req.params.jid);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const rawSearch = typeof req.query.search === 'string' ? req.query.search : '';
    const search = normalizeSearchQuery(rawSearch);
    const mediaOnly = req.query.media_only === 'true';

    try {
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
  });

  router.post('/api/unified/chats/:deviceId/:jid/history', requireAuth, async (req, res) => {
    const deviceId = decodeRouteParam(req.params.deviceId);
    const chatJid = decodeRouteParam(req.params.jid);
    const body = req.body as {count?: unknown};
    const count = Math.min(Math.max(Number(body.count) || 50, 1), 200);
    try {
      const result = await gowaFetch(`/chat/${encodeURIComponent(chatJid)}/history`, {
        method: 'POST',
        deviceId,
        body: {count},
      });
      res.json({code: 'SUCCESS', message: 'تم طلب الرسائل الأقدم من الهاتف', results: result});
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  router.post(
    '/api/unified/chats/:deviceId/:jid/send',
    requireAuth,
    async (req: AuthedRequest, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const chatJid = decodeRouteParam(req.params.jid);
      const body = req.body as {message?: unknown; reply_message_id?: unknown};
      const message = typeof body.message === 'string' ? body.message.trim() : '';
      const replyMessageId =
        typeof body.reply_message_id === 'string' && body.reply_message_id.trim()
          ? body.reply_message_id.trim()
          : undefined;

      if (!message) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'نص الرسالة مطلوب'});
        return;
      }

      try {
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
    '/api/unified/chats/:deviceId/:jid/messages/:messageId/reaction',
    requireAuth,
    async (req, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const chatJid = decodeRouteParam(req.params.jid);
      const messageId = decodeRouteParam(req.params.messageId);
      const body = req.body as {emoji?: unknown};
      const emoji = typeof body.emoji === 'string' ? body.emoji.trim() : '';

      if (!messageId) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف الرسالة مطلوب'});
        return;
      }

      try {
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

  // Conversation Notes
  router.get('/api/unified/chats/:deviceId/:jid/notes', requireAuth, (req, res) => {
    const deviceId = decodeRouteParam(req.params.deviceId);
    const chatJid = decodeRouteParam(req.params.jid);
    try {
      const notes = listConversationNotes(deviceId, chatJid);
      res.json({
        code: 'SUCCESS',
        message: 'ok',
        results: {notes, total: notes.length},
      });
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  router.post(
    '/api/unified/chats/:deviceId/:jid/notes',
    requireAuth,
    (req: AuthedRequest, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const chatJid = decodeRouteParam(req.params.jid);
      const body = req.body as {content?: unknown; is_pinned?: unknown};
      const content = typeof body.content === 'string' ? body.content.trim() : '';
      const isPinned = body.is_pinned === true;

      if (!content) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'نص الملاحظة مطلوب'});
        return;
      }
      if (content.length > 4000) {
        res
          .status(400)
          .json({code: 'VALIDATION_ERROR', message: 'الملاحظة طويلة جدًا (الحد الأقصى 4000 حرف)'});
        return;
      }

      try {
        const note = createConversationNote({
          deviceId,
          chatJid,
          createdById: req.user!.id,
          createdByName: req.user!.display_name,
          content,
          isPinned,
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
    (req: AuthedRequest, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const chatJid = decodeRouteParam(req.params.jid);
      const noteId = Number(req.params.noteId);
      if (!Number.isInteger(noteId) || noteId <= 0) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف الملاحظة غير صالح'});
        return;
      }

      const existing = getConversationNoteById(noteId, deviceId, chatJid);
      if (!existing) {
        res.status(404).json({code: 'NOT_FOUND', message: 'الملاحظة غير موجودة'});
        return;
      }

      const body = req.body as {content?: unknown; is_pinned?: unknown};
      const hasContent = body.content !== undefined;
      const hasPin = typeof body.is_pinned === 'boolean';
      if (!hasContent && !hasPin) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'لا توجد تعديلات لحفظها'});
        return;
      }

      if (hasContent && existing.created_by_id !== req.user!.id && req.user!.role !== 'admin') {
        res.status(403).json({code: 'FORBIDDEN', message: 'يمكنك تعديل ملاحظاتك فقط'});
        return;
      }

      let nextContent: string | undefined;
      if (hasContent) {
        nextContent = typeof body.content === 'string' ? body.content.trim() : '';
        if (!nextContent) {
          res.status(400).json({code: 'VALIDATION_ERROR', message: 'نص الملاحظة مطلوب'});
          return;
        }
        if (nextContent.length > 4000) {
          res
            .status(400)
            .json({code: 'VALIDATION_ERROR', message: 'الملاحظة طويلة جدًا (الحد الأقصى 4000 حرف)'});
          return;
        }
      }

      try {
        const updated = updateConversationNote(noteId, deviceId, chatJid, {
          content: nextContent,
          is_pinned: hasPin ? Boolean(body.is_pinned) : undefined,
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
    (req: AuthedRequest, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const chatJid = decodeRouteParam(req.params.jid);
      const noteId = Number(req.params.noteId);
      if (!Number.isInteger(noteId) || noteId <= 0) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف الملاحظة غير صالح'});
        return;
      }

      const existing = getConversationNoteById(noteId, deviceId, chatJid);
      if (!existing) {
        res.status(404).json({code: 'NOT_FOUND', message: 'الملاحظة غير موجودة'});
        return;
      }
      if (existing.created_by_id !== req.user!.id && req.user!.role !== 'admin') {
        res.status(403).json({code: 'FORBIDDEN', message: 'يمكنك حذف ملاحظاتك فقط'});
        return;
      }

      try {
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
  router.get('/api/unified/chats/:deviceId/:jid/schedules', requireAuth, async (req, res) => {
    const deviceId = decodeRouteParam(req.params.deviceId);
    const chatJid = decodeRouteParam(req.params.jid);
    const status = typeof req.query.status === 'string' ? req.query.status.trim() : undefined;
    const at = chatJid.indexOf('@');
    const localPart = at === -1 ? chatJid : chatJid.slice(0, at);
    const searchKey = localPart.split(':')[0] || chatJid;

    try {
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
  });

  router.post('/api/unified/chats/:deviceId/:jid/schedules', requireAuth, async (req, res) => {
    try {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const chatJid = decodeRouteParam(req.params.jid);
      const payload = validateAndBuildSchedulePayload(req.body as ScheduleInputBody, {
        fixedPhone: chatJid,
      });
      const result = await createScheduleViaGowa(deviceId, payload, wsBridge, chatJid);
      res.status(201).json({code: 'SUCCESS', message: 'تمت جدولة الرسالة', results: result});
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  router.patch(
    '/api/unified/chats/:deviceId/:jid/schedules/:id',
    requireAuth,
    async (req, res) => {
      try {
        const deviceId = decodeRouteParam(req.params.deviceId);
        const chatJid = decodeRouteParam(req.params.jid);
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
    async (req, res) => {
      try {
        const deviceId = decodeRouteParam(req.params.deviceId);
        const chatJid = decodeRouteParam(req.params.jid);
        const scheduleId = decodeRouteParam(req.params.id);
        await executeScheduleAction(deviceId, scheduleId, req.params.action, wsBridge, chatJid);
        res.json({code: 'SUCCESS', message: 'تم تحديث الجدولة'});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  // Media & Avatars
  router.get('/api/unified/media/download', requireAuth, async (req, res) => {
    const deviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId.trim() : '';
    const messageId = typeof req.query.messageId === 'string' ? req.query.messageId.trim() : '';
    const phone = typeof req.query.phone === 'string' ? req.query.phone.trim() : '';
    const fallbackUrl =
      typeof req.query.fallbackUrl === 'string' ? req.query.fallbackUrl.trim() : '';
    if (!deviceId || !messageId || !phone) {
      res.status(400).json({code: 'VALIDATION_ERROR', message: 'معلمات الوسائط غير مكتملة'});
      return;
    }

    try {
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

  router.get('/api/unified/media/file', requireAuth, async (req, res) => {
    const filePath = typeof req.query.path === 'string' ? req.query.path : '';
    try {
      const asset = await gowaFetchBinary(filePath);
      res.setHeader('Content-Type', asset.contentType);
      if (asset.filename) {
        res.setHeader(
          'Content-Disposition',
          `inline; filename="${asset.filename.replace(/["\r\n]/g, '')}"`,
        );
      }
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.send(asset.buffer);
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  router.get('/api/unified/avatar', requireAuth, async (req, res) => {
    const deviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId.trim() : '';
    const jid = typeof req.query.jid === 'string' ? req.query.jid.trim() : '';
    const force = req.query.force === 'true';

    if (!deviceId || !jid) {
      res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف الحساب والمستلم مطلوبان'});
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

  return router;
}
