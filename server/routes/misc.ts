import type {Router} from 'express';
import {getAccountAliases, parseTimestampMs} from '../db.ts';
import {
  GowaError,
  gowaFetch,
  type GowaDevice,
  type GowaMessageInfo,
  type GowaPagination,
} from '../gowa-client.ts';
import {createApiRouter, handleRouteError, requireAdmin, requireAuth} from '../middleware/auth.ts';
import {decodeRouteParam} from '../security.ts';
import {normalizeWhatsAppJid, resolveAccountDisplayName} from '../services/chat-sync.ts';

export function registerMiscRoutes(): Router {
  const router = createApiRouter();

  router.get('/api/misc/statuses', requireAuth, requireAdmin, async (req, res) => {
    const rawDeviceIds =
      typeof req.query.deviceIds === 'string' ? req.query.deviceIds : '';
    const selectedDeviceSet = new Set(
      rawDeviceIds
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    );

    try {
      const aliases = getAccountAliases();
      const devices = (await gowaFetch<GowaDevice[]>('/devices')) ?? [];
      const targetDevices =
        selectedDeviceSet.size > 0
          ? devices.filter((d) => selectedDeviceSet.has(d.id))
          : devices;

      const statusCounts = new Map<string, number>();
      const deviceErrors: Array<{device_id: string; display_name: string; message: string}> = [];
      const items: Array<
        GowaMessageInfo & {
          device_id: string;
          device_display_name: string;
          device_state: GowaDevice['state'];
          sender_display_name: string;
        }
      > = [];

      await Promise.all(
        targetDevices.map(async (dev) => {
          const displayName = resolveAccountDisplayName(dev, aliases);
          statusCounts.set(dev.id, 0);
          if (dev.state !== 'logged_in' && dev.state !== 'connected') {
            return;
          }
          try {
            const [msgRes, contactsRes] = await Promise.all([
              gowaFetch<{data?: GowaMessageInfo[]; pagination?: GowaPagination} | null>(
                '/chat/status@broadcast/messages',
                {
                  deviceId: dev.id,
                  query: {limit: 50, offset: 0},
                  timeoutMs: 12_000,
                },
              ).catch((err) => {
                if (err instanceof GowaError && err.status === 404) {
                  return null;
                }
                throw err;
              }),
              gowaFetch<{data?: Array<{jid?: string; name?: string}>} | null>(
                '/user/my/contacts',
                {
                  deviceId: dev.id,
                  timeoutMs: 3_500,
                },
              ).catch(() => null),
            ]);

            const contactNames = new Map<string, string>();
            for (const c of contactsRes?.data ?? []) {
              if (c.jid && c.name?.trim()) {
                contactNames.set(c.jid.trim().toLowerCase(), c.name.trim());
                const norm = normalizeWhatsAppJid(c.jid);
                if (norm) contactNames.set(norm, c.name.trim());
              }
            }

            const rawMessages = msgRes?.data ?? [];
            let count = 0;
            for (const msg of rawMessages) {
              if (!msg || !msg.id) continue;
              if (msg.is_revoked || msg.media_type === 'revoked') continue;
              const senderJid = (msg.sender_jid || '').trim();
              const normalizedSender = normalizeWhatsAppJid(senderJid) || senderJid.toLowerCase();
              const resolvedSenderName =
                msg.sender_display_name?.trim() ||
                contactNames.get(senderJid.toLowerCase()) ||
                contactNames.get(normalizedSender) ||
                senderJid.split('@')[0].split(':')[0] ||
                displayName;

              count += 1;
              items.push({
                ...msg,
                chat_jid: 'status@broadcast',
                sender_jid: normalizedSender || senderJid,
                sender_display_name: resolvedSenderName,
                device_id: dev.id,
                device_display_name: displayName,
                device_state: dev.state,
              });
            }
            statusCounts.set(dev.id, count);
          } catch (err) {
            const msg = err instanceof GowaError ? err.message : 'تعذر جلب الحالات';
            deviceErrors.push({
              device_id: dev.id,
              display_name: displayName,
              message: msg,
            });
          }
        }),
      );

      items.sort((a, b) => parseTimestampMs(b.timestamp) - parseTimestampMs(a.timestamp));

      const accounts = devices.map((dev) => ({
        id: dev.id,
        display_name: resolveAccountDisplayName(dev, aliases),
        phone_number: dev.phone_number,
        state: dev.state,
        status_count: statusCounts.get(dev.id) ?? 0,
      }));

      res.json({
        code: 'SUCCESS',
        message: 'ok',
        results: {
          data: items,
          accounts,
          device_errors: deviceErrors,
        },
      });
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  router.get('/api/devices/:deviceId/newsletters', requireAuth, requireAdmin, async (req, res) => {
    const deviceId = decodeRouteParam(req.params.deviceId);
    try {
      const data = await gowaFetch<{data?: unknown[]} | null>('/user/my/newsletters', {deviceId});
      res.json({code: 'SUCCESS', message: 'ok', results: data?.data ?? []});
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  router.post(
    '/api/devices/:deviceId/newsletters/follow',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const body = req.body as {newsletter_id?: unknown};
      const newsletterId = typeof body.newsletter_id === 'string' ? body.newsletter_id.trim() : '';
      if (!newsletterId) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف القناة مطلوب'});
        return;
      }
      try {
        await gowaFetch('/newsletter/follow', {
          method: 'POST',
          deviceId,
          body: {newsletter_id: newsletterId},
        });
        res.json({code: 'SUCCESS', message: 'تمت متابعة القناة'});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.post(
    '/api/devices/:deviceId/newsletters/unfollow',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const body = req.body as {newsletter_id?: unknown};
      const newsletterId = typeof body.newsletter_id === 'string' ? body.newsletter_id.trim() : '';
      if (!newsletterId) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف القناة مطلوب'});
        return;
      }
      try {
        await gowaFetch('/newsletter/unfollow', {
          method: 'POST',
          deviceId,
          body: {newsletter_id: newsletterId},
        });
        res.json({code: 'SUCCESS', message: 'تم إلغاء متابعة القناة'});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.get(
    '/api/devices/:deviceId/newsletters/info',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const newsletterId =
        typeof req.query.newsletter_id === 'string' ? req.query.newsletter_id.trim() : undefined;
      const invite = typeof req.query.invite === 'string' ? req.query.invite.trim() : undefined;
      if (!newsletterId && !invite) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'أدخل معرّف القناة أو رابط الدعوة'});
        return;
      }
      try {
        const result = await gowaFetch('/newsletter/info', {
          deviceId,
          query: {newsletter_id: newsletterId, invite},
        });
        res.json({code: 'SUCCESS', message: 'ok', results: result});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.get(
    '/api/devices/:deviceId/newsletters/directory',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const view = typeof req.query.view === 'string' ? req.query.view.trim() : undefined;
      const searchText =
        typeof req.query.search_text === 'string' ? req.query.search_text.trim() : undefined;
      const countryCodes =
        typeof req.query.country_codes === 'string' ? req.query.country_codes.trim() : undefined;
      const categories =
        typeof req.query.categories === 'string' ? req.query.categories.trim() : undefined;
      const cursor = typeof req.query.cursor === 'string' ? req.query.cursor.trim() : undefined;
      const limit = req.query.limit ? Number(req.query.limit) : 20;

      try {
        const result = await gowaFetch('/newsletter/directory', {
          deviceId,
          query: {
            view,
            search_text: searchText,
            country_codes: countryCodes,
            categories,
            cursor,
            limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 50) : 20,
          },
        });
        res.json({code: 'SUCCESS', message: 'ok', results: result});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.get(
    '/api/devices/:deviceId/newsletters/messages',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const newsletterId =
        typeof req.query.newsletter_id === 'string' ? req.query.newsletter_id.trim() : '';
      const count = req.query.count ? Number(req.query.count) : 20;
      const before = req.query.before ? Number(req.query.before) : undefined;
      if (!newsletterId) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف القناة مطلوب'});
        return;
      }
      try {
        const result = await gowaFetch('/newsletter/messages', {
          deviceId,
          query: {
            newsletter_id: newsletterId,
            count: Number.isFinite(count) ? Math.min(Math.max(count, 1), 100) : 20,
            before: Number.isFinite(before) ? before : undefined,
          },
        });
        res.json({code: 'SUCCESS', message: 'ok', results: result});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.get(
    '/api/devices/:deviceId/newsletters/message-updates',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const newsletterId =
        typeof req.query.newsletter_id === 'string' ? req.query.newsletter_id.trim() : '';
      const after = req.query.after ? Number(req.query.after) : 1;
      const count = req.query.count ? Number(req.query.count) : 100;
      if (!newsletterId) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف القناة مطلوب'});
        return;
      }
      try {
        const result = await gowaFetch('/newsletter/message-updates', {
          deviceId,
          query: {
            newsletter_id: newsletterId,
            after: Number.isFinite(after) ? after : 1,
            count: Number.isFinite(count) ? count : 100,
          },
        });
        res.json({code: 'SUCCESS', message: 'ok', results: result});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.get(
    '/api/devices/:deviceId/newsletters/messages/:serverId/download',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const serverId = Number(req.params.serverId);
      const newsletterId =
        typeof req.query.newsletter_id === 'string' ? req.query.newsletter_id.trim() : '';
      if (!newsletterId || !Number.isInteger(serverId) || serverId <= 0) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'معلمات الوسائط غير صالحة'});
        return;
      }
      try {
        const result = await gowaFetch(`/newsletter/messages/${serverId}/download`, {
          deviceId,
          query: {newsletter_id: newsletterId},
        });
        res.json({code: 'SUCCESS', message: 'ok', results: result});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.get(
    '/api/devices/:deviceId/newsletters/live-updates',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      try {
        const data = await gowaFetch<{data?: unknown[]} | null>('/newsletter/live-updates', {
          deviceId,
        });
        res.json({code: 'SUCCESS', message: 'ok', results: data?.data ?? []});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.post(
    '/api/devices/:deviceId/newsletters/live-updates',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const body = req.body as {newsletter_id?: unknown};
      const newsletterId = typeof body.newsletter_id === 'string' ? body.newsletter_id.trim() : '';
      if (!newsletterId) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف القناة مطلوب'});
        return;
      }
      try {
        const result = await gowaFetch('/newsletter/live-updates', {
          method: 'POST',
          deviceId,
          body: {newsletter_id: newsletterId},
        });
        res.json({code: 'SUCCESS', message: 'تم تفعيل التحديث المباشر', results: result});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.delete(
    '/api/devices/:deviceId/newsletters/live-updates',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const newsletterId =
        typeof req.query.newsletter_id === 'string' ? req.query.newsletter_id.trim() : '';
      if (!newsletterId) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف القناة مطلوب'});
        return;
      }
      try {
        await gowaFetch('/newsletter/live-updates', {
          method: 'DELETE',
          deviceId,
          query: {newsletter_id: newsletterId},
        });
        res.json({code: 'SUCCESS', message: 'تم إيقاف التحديث المباشر'});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.post('/api/devices/:deviceId/call/reject', requireAuth, requireAdmin, async (req, res) => {
    const deviceId = decodeRouteParam(req.params.deviceId);
    const body = req.body as {caller_jid?: unknown; call_id?: unknown};
    const callerJid = typeof body.caller_jid === 'string' ? body.caller_jid.trim() : '';
    const callId = typeof body.call_id === 'string' ? body.call_id.trim() : '';
    if (!callerJid || !callId) {
      res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف المتصل ومعرّف المكالمة مطلوبان'});
      return;
    }
    try {
      const result = await gowaFetch('/call/reject', {
        method: 'POST',
        deviceId,
        body: {caller_jid: callerJid, call_id: callId},
      });
      res.json({code: 'SUCCESS', message: 'تم رفض المكالمة', results: result});
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  return router;
}
