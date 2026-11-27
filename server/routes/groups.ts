import type {Router} from 'express';
import {
  deleteCachedAvatars,
  getAccountAliases,
  getGroupUnreadSummaryForUser,
  markChatReadForUser,
} from '../db.ts';
import {GowaError, gowaFetch, gowaFetchRaw, type GowaDevice} from '../gowa-client.ts';
import {
  assertDeviceAccess,
  createApiRouter,
  decodeImageUpload,
  handleRouteError,
  requireAuth,
  requirePermission,
} from '../middleware/auth.ts';
import {filterAllowedDevices, hasPermission, isAdminSubject} from '../rbac.ts';
import {decodeRouteParam} from '../security.ts';
import {
  isGroupJid,
  normalizeWhatsAppJid,
  resolveAccountDisplayName,
} from '../services/chat-sync.ts';
import {extractGowaArray} from '../../shared/gowa-payload.ts';
import {
  deduplicateUnifiedDirectoryItems,
  hydrateGroupsFromCache,
  invalidateGroupMetaCache,
  normalizeDirectoryJid,
  resolveGroupMemberCount,
  scheduleBackgroundGroupEnrichment,
  type RawGowaGroup,
  type RawGowaNewsletter,
  type UnifiedDirectoryAccountRef,
  type UnifiedDirectoryEntry,
} from '../services/group-directory.ts';
import type {AuthedRequest} from '../types.ts';

export {
  deduplicateUnifiedDirectoryItems,
  normalizeDirectoryJid,
  resolveGroupMemberCount,
  type RawGowaGroup,
  type RawGowaNewsletter,
  type UnifiedDirectoryAccountRef,
  type UnifiedDirectoryEntry,
};

export function registerGroupRoutes(): Router {
  const router = createApiRouter();

  router.get(
    '/api/unified/groups',
    requireAuth,
    requirePermission('groups', 'read'),
    async (req: AuthedRequest, res) => {
      const filterDeviceIdsRaw =
        typeof req.query.deviceIds === 'string' ? req.query.deviceIds.trim() : '';
      const selectedDeviceSet = new Set<string>();
      if (filterDeviceIdsRaw) {
        for (const part of filterDeviceIdsRaw.split(',')) {
          const clean = part.trim();
          if (clean) selectedDeviceSet.add(clean);
        }
      }

      try {
        for (const requestedId of selectedDeviceSet) {
          assertDeviceAccess(req.user, requestedId);
        }
        const aliases = getAccountAliases();
        const allDevices = (await gowaFetch<GowaDevice[]>('/devices', {timeoutMs: 10_000})) ?? [];
        const devices = filterAllowedDevices(req.user!, allDevices);
        const targetDevices =
          selectedDeviceSet.size > 0
            ? devices.filter((d) => selectedDeviceSet.has(d.id))
            : devices;

      const deviceErrors: Array<{device_id: string; display_name: string; message: string}> = [];
      const rawItems: UnifiedDirectoryEntry[] = [];

      await Promise.all(
        targetDevices.map(async (dev) => {
          const displayName = resolveAccountDisplayName(dev, aliases);
          if (dev.state !== 'logged_in' && dev.state !== 'connected') {
            return;
          }

          const [groupsResult, newslettersResult, liveUpdatesResult] = await Promise.all([
            gowaFetch<unknown>('/user/my/groups', {deviceId: dev.id, timeoutMs: 10_000})
              .then((res) => ({ok: true as const, data: extractGowaArray<RawGowaGroup>(res, 'groups', 'data')}))
              .catch((err) => ({ok: false as const, err})),
            gowaFetch<unknown>('/user/my/newsletters', {deviceId: dev.id, timeoutMs: 10_000})
              .then((res) => ({
                ok: true as const,
                data: extractGowaArray<RawGowaNewsletter>(res, 'newsletters', 'data'),
              }))
              .catch((err) => ({ok: false as const, err})),
            gowaFetch<unknown>('/newsletter/live-updates', {deviceId: dev.id, timeoutMs: 6_000})
              .then((res) => extractGowaArray<{jid: string}>(res, 'data'))
              .catch(() => [] as Array<{jid: string}>),
          ]);

          if (!groupsResult.ok) {
            const msg =
              groupsResult.err instanceof GowaError
                ? groupsResult.err.message
                : 'تعذر جلب المجموعات';
            deviceErrors.push({
              device_id: dev.id,
              display_name: displayName,
              message: msg,
            });
          } else {
            const {groups: cachedGroups, missing} = hydrateGroupsFromCache(dev.id, groupsResult.data);
            scheduleBackgroundGroupEnrichment(dev.id, missing);
            for (const g of cachedGroups) {
              if (!g?.JID) continue;
              const memberCount = resolveGroupMemberCount(g);
              rawItems.push({
                kind: 'group',
                device_id: dev.id,
                device_display_name: displayName,
                device_state: dev.state,
                jid: g.JID,
                name: g.Name?.trim() || g.JID,
                participant_count: memberCount,
                group: {...g, ParticipantCount: memberCount},
              });
            }
          }

          if (!newslettersResult.ok) {
            if (groupsResult.ok) {
              const msg =
                newslettersResult.err instanceof GowaError
                  ? newslettersResult.err.message
                  : 'تعذر جلب القنوات';
              deviceErrors.push({
                device_id: dev.id,
                display_name: displayName,
                message: msg,
              });
            }
          } else {
            const liveSet = new Set(liveUpdatesResult.map((l) => l.jid));
            for (const nl of newslettersResult.data) {
              if (!nl?.id) continue;
              const subs = nl.thread_metadata?.subscribers_count ?? 0;
              rawItems.push({
                kind: 'newsletter',
                device_id: dev.id,
                device_display_name: displayName,
                device_state: dev.state,
                jid: nl.id,
                name: nl.thread_metadata?.name?.text?.trim() || nl.id,
                subscribers_count: subs,
                live_active: liveSet.has(nl.id),
                newsletter: nl,
              });
            }
          }
        }),
      );

      const unreadSummary = getGroupUnreadSummaryForUser(
        req.user!,
        targetDevices.map((d) => d.id),
      );
      for (const item of rawItems) {
        if (item.kind === 'group') {
          const canonicalJid = normalizeDirectoryJid(item.jid);
          item.unread_count =
            unreadSummary.byKey.get(`${item.device_id}::${canonicalJid}`) ??
            unreadSummary.byKey.get(`${item.device_id}::${item.jid}`) ??
            0;
        }
      }

      const items = deduplicateUnifiedDirectoryItems(rawItems);
      items.sort((a, b) => a.name.localeCompare(b.name, 'ar'));

      const groupsCount = items.filter((item) => item.kind === 'group').length;
      const newslettersCount = items.filter((item) => item.kind === 'newsletter').length;

      res.json({
        code: 'SUCCESS',
        message: 'ok',
        results: {
          items,
          groups_count: groupsCount,
          newsletters_count: newslettersCount,
          total_unread: unreadSummary.totalUnread,
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

  router.get(
    '/api/unified/groups/unread',
    requireAuth,
    requirePermission('groups', 'read'),
    (req: AuthedRequest, res) => {
      try {
        const user = req.user!;
        const deviceIds =
          !isAdminSubject(user) && user.allowed_device_ids.length > 0
            ? user.allowed_device_ids
            : undefined;
        const summary = getGroupUnreadSummaryForUser(user, deviceIds);
        res.json({
          code: 'SUCCESS',
          message: 'ok',
          results: {
            total_unread: summary.totalUnread,
          },
        });
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.post(
    '/api/unified/groups/:deviceId/:jid/read',
    requireAuth,
    requirePermission('groups', 'read'),
    (req: AuthedRequest, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const rawJid = decodeRouteParam(req.params.jid);
      const groupJid = normalizeWhatsAppJid(rawJid) || rawJid;
      try {
        assertDeviceAccess(req.user, deviceId);
        if (!groupJid || !isGroupJid(groupJid)) {
          res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف المجموعة غير صالح'});
          return;
        }
        const lastReadSeq = markChatReadForUser(req.user!.id, deviceId, groupJid);
        res.json({
          code: 'SUCCESS',
          message: 'ok',
          results: {chat_jid: groupJid, last_read_seq: lastReadSeq},
        });
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.get(
    '/api/devices/:deviceId/groups',
    requireAuth,
    requirePermission('groups', 'read'),
    async (req: AuthedRequest, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      try {
        assertDeviceAccess(req.user, deviceId);
        const data = await gowaFetch<{data?: RawGowaGroup[]; groups?: RawGowaGroup[]} | RawGowaGroup[] | null>(
          '/user/my/groups',
          {deviceId, timeoutMs: 10_000},
        );
        const {groups: enriched, missing} = hydrateGroupsFromCache(
          deviceId,
          extractGowaArray<RawGowaGroup>(data, 'groups'),
        );
        scheduleBackgroundGroupEnrichment(deviceId, missing);
        res.json({code: 'SUCCESS', message: 'ok', results: enriched});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.post(
    '/api/devices/:deviceId/groups',
    requireAuth,
    requirePermission('groups', 'write'),
    async (req: AuthedRequest, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const body = req.body as {title?: unknown; participants?: unknown};
      const title = typeof body.title === 'string' ? body.title.trim() : '';
      const participants = Array.isArray(body.participants)
        ? body.participants.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
        : [];
      if (!title) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'اسم المجموعة مطلوب'});
        return;
      }
      try {
        assertDeviceAccess(req.user, deviceId);
        const result = await gowaFetch('/group', {
          method: 'POST',
          deviceId,
          body: {title, participants},
        });
        invalidateGroupMetaCache(deviceId);
        res.status(201).json({code: 'SUCCESS', message: 'تم إنشاء المجموعة', results: result});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.post(
    '/api/devices/:deviceId/groups/join-with-link',
    requireAuth,
    requirePermission('groups', 'write'),
    async (req: AuthedRequest, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const body = req.body as {link?: unknown};
      const link = typeof body.link === 'string' ? body.link.trim() : '';
      if (!link) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'رابط الدعوة مطلوب'});
        return;
      }
      try {
        assertDeviceAccess(req.user, deviceId);
        const result = await gowaFetch('/group/join-with-link', {
          method: 'POST',
          deviceId,
          body: {link},
        });
        invalidateGroupMetaCache(deviceId);
        res.json({code: 'SUCCESS', message: 'تم الانضمام للمجموعة', results: result});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.get(
    '/api/devices/:deviceId/groups/info-from-link',
    requireAuth,
    requirePermission('groups', 'read'),
    async (req: AuthedRequest, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const link = typeof req.query.link === 'string' ? req.query.link.trim() : '';
      if (!link) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'رابط الدعوة مطلوب'});
        return;
      }
      try {
        assertDeviceAccess(req.user, deviceId);
        const result = await gowaFetch('/group/info-from-link', {
          deviceId,
          query: {link},
        });
        res.json({code: 'SUCCESS', message: 'ok', results: result});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.get(
    '/api/devices/:deviceId/groups/info',
    requireAuth,
    requirePermission('groups', 'read'),
    async (req: AuthedRequest, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const groupId = typeof req.query.group_id === 'string' ? req.query.group_id.trim() : '';
      if (!groupId) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف المجموعة مطلوب'});
        return;
      }
      try {
        assertDeviceAccess(req.user, deviceId);
        const result = await gowaFetch('/group/info', {
          deviceId,
          query: {group_id: groupId},
        });
        res.json({code: 'SUCCESS', message: 'ok', results: result});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.post(
    '/api/devices/:deviceId/groups/leave',
    requireAuth,
    requirePermission('groups', 'manage'),
    async (req: AuthedRequest, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const body = req.body as {group_id?: unknown};
      const groupId = typeof body.group_id === 'string' ? body.group_id.trim() : '';
      if (!groupId) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف المجموعة مطلوب'});
        return;
      }
      try {
        assertDeviceAccess(req.user, deviceId);
        await gowaFetch('/group/leave', {
          method: 'POST',
          deviceId,
          body: {group_id: groupId},
        });
        invalidateGroupMetaCache(deviceId, groupId);
        res.json({code: 'SUCCESS', message: 'تمت مغادرة المجموعة'});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.get(
    '/api/devices/:deviceId/groups/participants',
    requireAuth,
    requirePermission('groups', 'read'),
    async (req: AuthedRequest, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const groupId = typeof req.query.group_id === 'string' ? req.query.group_id.trim() : '';
      if (!groupId) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف المجموعة مطلوب'});
        return;
      }
      try {
        assertDeviceAccess(req.user, deviceId);
        const result = await gowaFetch('/group/participants', {
          deviceId,
          query: {group_id: groupId},
        });
        res.json({code: 'SUCCESS', message: 'ok', results: result});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.get(
    '/api/devices/:deviceId/groups/participants/export',
    requireAuth,
    requirePermission('groups', 'read'),
    async (req: AuthedRequest, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const groupId = typeof req.query.group_id === 'string' ? req.query.group_id.trim() : '';
      if (!groupId) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف المجموعة مطلوب'});
        return;
      }
      try {
        assertDeviceAccess(req.user, deviceId);
        const asset = await gowaFetchRaw('/group/participants/export', {
          deviceId,
          query: {group_id: groupId},
        });
        res.setHeader('Content-Type', asset.contentType || 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="participants.csv"');
        res.send(asset.buffer);
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.post(
    '/api/devices/:deviceId/groups/participants/:action',
    requireAuth,
    requirePermission('groups', 'manage'),
    async (req: AuthedRequest, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const action = req.params.action;
      const pathMap: Record<string, string> = {
        add: '/group/participants',
        remove: '/group/participants/remove',
        promote: '/group/participants/promote',
        demote: '/group/participants/demote',
      };
      const upstream = pathMap[action];
      if (!upstream) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'إجراء المشاركين غير صالح'});
        return;
      }
      const body = req.body as {group_id?: unknown; participants?: unknown};
      const groupId = typeof body.group_id === 'string' ? body.group_id.trim() : '';
      const participants = Array.isArray(body.participants)
        ? body.participants.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
        : [];
      if (!groupId || participants.length === 0) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'بيانات المجموعة والأعضاء مطلوبة'});
        return;
      }
      try {
        assertDeviceAccess(req.user, deviceId);
        const result = await gowaFetch(upstream, {
          method: 'POST',
          deviceId,
          body: {group_id: groupId, participants},
        });
        invalidateGroupMetaCache(deviceId, groupId);
        res.json({code: 'SUCCESS', message: 'تم تنفيذ الإجراء', results: result});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.get(
    '/api/devices/:deviceId/groups/participant-requests',
    requireAuth,
    requirePermission('groups', 'read'),
    async (req: AuthedRequest, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const groupId = typeof req.query.group_id === 'string' ? req.query.group_id.trim() : '';
      if (!groupId) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف المجموعة مطلوب'});
        return;
      }
      try {
        assertDeviceAccess(req.user, deviceId);
        const result = await gowaFetch('/group/participant-requests', {
          deviceId,
          query: {group_id: groupId},
        });
        res.json({code: 'SUCCESS', message: 'ok', results: result ?? []});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.post(
    '/api/devices/:deviceId/groups/participant-requests/:decision',
    requireAuth,
    requirePermission('groups', 'manage'),
    async (req: AuthedRequest, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const decision = req.params.decision;
      if (decision !== 'approve' && decision !== 'reject') {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'قرار غير صالح'});
        return;
      }
      const body = req.body as {group_id?: unknown; participants?: unknown};
      const groupId = typeof body.group_id === 'string' ? body.group_id.trim() : '';
      const participants = Array.isArray(body.participants)
        ? body.participants.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
        : [];
      if (!groupId || participants.length === 0) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'بيانات الطلب غير مكتملة'});
        return;
      }
      try {
        assertDeviceAccess(req.user, deviceId);
        const result = await gowaFetch(`/group/participant-requests/${decision}`, {
          method: 'POST',
          deviceId,
          body: {group_id: groupId, participants},
        });
        invalidateGroupMetaCache(deviceId, groupId);
        res.json({code: 'SUCCESS', message: 'تم تنفيذ الطلب', results: result});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.post(
    '/api/devices/:deviceId/groups/name',
    requireAuth,
    requirePermission('groups', 'manage'),
    async (req: AuthedRequest, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const body = req.body as {group_id?: unknown; name?: unknown};
      const groupId = typeof body.group_id === 'string' ? body.group_id.trim() : '';
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!groupId || !name) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف المجموعة والاسم مطلوبان'});
        return;
      }
      try {
        assertDeviceAccess(req.user, deviceId);
        const result = await gowaFetch('/group/name', {
          method: 'POST',
          deviceId,
          body: {group_id: groupId, name},
        });
        invalidateGroupMetaCache(deviceId, groupId);
        res.json({code: 'SUCCESS', message: 'تم تحديث اسم المجموعة', results: result});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.post(
    '/api/devices/:deviceId/groups/topic',
    requireAuth,
    requirePermission('groups', 'manage'),
    async (req: AuthedRequest, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const body = req.body as {group_id?: unknown; topic?: unknown};
      const groupId = typeof body.group_id === 'string' ? body.group_id.trim() : '';
      const topic = typeof body.topic === 'string' ? body.topic : '';
      if (!groupId) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف المجموعة مطلوب'});
        return;
      }
      try {
        assertDeviceAccess(req.user, deviceId);
        const result = await gowaFetch('/group/topic', {
          method: 'POST',
          deviceId,
          body: {group_id: groupId, topic},
        });
        invalidateGroupMetaCache(deviceId, groupId);
        res.json({code: 'SUCCESS', message: 'تم تحديث وصف المجموعة', results: result});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.post(
    '/api/devices/:deviceId/groups/locked',
    requireAuth,
    requirePermission('groups', 'manage'),
    async (req: AuthedRequest, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const body = req.body as {group_id?: unknown; locked?: unknown};
      const groupId = typeof body.group_id === 'string' ? body.group_id.trim() : '';
      if (!groupId || typeof body.locked !== 'boolean') {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'بيانات القفل غير مكتملة'});
        return;
      }
      try {
        assertDeviceAccess(req.user, deviceId);
        const result = await gowaFetch('/group/locked', {
          method: 'POST',
          deviceId,
          body: {group_id: groupId, locked: body.locked},
        });
        invalidateGroupMetaCache(deviceId, groupId);
        res.json({code: 'SUCCESS', message: 'تم تحديث إعداد القفل', results: result});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.post(
    '/api/devices/:deviceId/groups/announce',
    requireAuth,
    requirePermission('groups', 'manage'),
    async (req: AuthedRequest, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const body = req.body as {group_id?: unknown; announce?: unknown};
      const groupId = typeof body.group_id === 'string' ? body.group_id.trim() : '';
      if (!groupId || typeof body.announce !== 'boolean') {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'بيانات وضع الإعلانات غير مكتملة'});
        return;
      }
      try {
        assertDeviceAccess(req.user, deviceId);
        const result = await gowaFetch('/group/announce', {
          method: 'POST',
          deviceId,
          body: {group_id: groupId, announce: body.announce},
        });
        invalidateGroupMetaCache(deviceId, groupId);
        res.json({code: 'SUCCESS', message: 'تم تحديث وضع الإعلانات', results: result});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.get(
    '/api/devices/:deviceId/groups/invite-link',
    requireAuth,
    requirePermission('groups', 'read'),
    async (req: AuthedRequest, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const groupId = typeof req.query.group_id === 'string' ? req.query.group_id.trim() : '';
      const reset = req.query.reset === 'true';
      if (!groupId) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف المجموعة مطلوب'});
        return;
      }
      if (reset && !hasPermission(req.user!, 'groups', 'manage')) {
        res.status(403).json({
          code: 'FORBIDDEN',
          message: 'ليس لديك صلاحية إعادة تعيين رابط دعوة المجموعة',
        });
        return;
      }
      try {
        assertDeviceAccess(req.user, deviceId);
        const result = await gowaFetch('/group/invite-link', {
          deviceId,
          query: {group_id: groupId, reset: reset ? true : undefined},
        });
        res.json({code: 'SUCCESS', message: 'ok', results: result});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.post(
    '/api/devices/:deviceId/groups/photo',
    requireAuth,
    requirePermission('groups', 'manage'),
    async (req: AuthedRequest, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const body = req.body as {
        group_id?: unknown;
        filename?: unknown;
        mimeType?: unknown;
        dataBase64?: unknown;
      };
      const groupId = typeof body.group_id === 'string' ? body.group_id.trim() : '';
      if (!groupId) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف المجموعة مطلوب'});
        return;
      }
      try {
        assertDeviceAccess(req.user, deviceId);
        const form = new FormData();
        form.append('group_id', groupId);
        if (body.dataBase64) {
          const {filename, blob} = decodeImageUpload(body.filename, body.mimeType, body.dataBase64);
          form.append('photo', blob, filename);
        }
        const result = await gowaFetch('/group/photo', {
          method: 'POST',
          deviceId,
          formData: form,
        });
        deleteCachedAvatars(deviceId, groupId);
        res.json({code: 'SUCCESS', message: 'تم تحديث صورة المجموعة', results: result});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  return router;
}
