import type {Router} from 'express';
import {db, getAccountAliases} from '../db.ts';
import {GowaError, gowaFetch, gowaFetchRaw, type GowaDevice} from '../gowa-client.ts';
import {
  createApiRouter,
  decodeImageUpload,
  handleRouteError,
  requireAdmin,
  requireAuth,
} from '../middleware/auth.ts';
import {decodeRouteParam} from '../security.ts';
import {resolveAccountDisplayName} from '../services/chat-sync.ts';

export interface RawGowaGroup {
  JID: string;
  OwnerJID?: string;
  Name?: string;
  Topic?: string;
  IsLocked?: boolean;
  IsAnnounce?: boolean;
  IsEphemeral?: boolean;
  IsJoinApprovalRequired?: boolean;
  GroupCreated?: string;
  ParticipantCount?: number;
  participant_count?: number;
  Participants?: unknown[];
  participants?: unknown[];
}

export interface RawGowaNewsletter {
  id: string;
  state?: {type?: string};
  thread_metadata?: {
    creation_time?: string;
    invite?: string;
    name?: {text?: string; id?: string; update_time?: string};
    description?: {text?: string; id?: string; update_time?: string};
    subscribers_count?: number;
    verification?: string;
    picture?: {url?: string; direct_path?: string; id?: string; type?: string};
    preview?: {url?: string; direct_path?: string; id?: string; type?: string};
  };
  viewer_metadata?: {
    mute?: string;
    role?: string;
  };
}

export function resolveGroupMemberCount(group: Partial<RawGowaGroup>): number {
  const explicitCount = Number(group.ParticipantCount ?? group.participant_count ?? 0);
  const safeExplicit = Number.isFinite(explicitCount) && explicitCount > 0 ? explicitCount : 0;
  const upperLen = Array.isArray(group.Participants) ? group.Participants.length : 0;
  const lowerLen = Array.isArray(group.participants) ? group.participants.length : 0;
  return Math.max(safeExplicit, upperLen, lowerLen);
}

interface CachedGroupMeta {
  count: number;
  patch?: Partial<RawGowaGroup>;
  expiresAt: number;
}

const GROUP_META_TTL_MS = 60_000;
const groupMetaCache = new Map<string, CachedGroupMeta>();

function invalidateGroupMetaCache(deviceId: string, groupId?: string): void {
  if (groupId) {
    groupMetaCache.delete(`${deviceId}::${groupId}`);
    return;
  }
  const prefix = `${deviceId}::`;
  for (const key of groupMetaCache.keys()) {
    if (key.startsWith(prefix)) groupMetaCache.delete(key);
  }
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let index = 0;
  const runners = Array.from({length: Math.min(limit, items.length)}, async () => {
    while (index < items.length) {
      const current = items[index++];
      await worker(current);
    }
  });
  await Promise.all(runners);
}

async function enrichGroupsWithCounts(
  deviceId: string,
  rawGroups: RawGowaGroup[],
): Promise<RawGowaGroup[]> {
  const now = Date.now();
  const normalized = rawGroups.map((g) => ({
    ...g,
    ParticipantCount: resolveGroupMemberCount(g),
  }));

  const missing = normalized.filter((g) => {
    if ((g.ParticipantCount ?? 0) > 0) return false;
    const cached = groupMetaCache.get(`${deviceId}::${g.JID}`);
    if (cached && cached.expiresAt > now) {
      return false;
    }
    return true;
  });

  await runWithConcurrency(missing, 5, async (g) => {
    const cacheKey = `${deviceId}::${g.JID}`;
    try {
      const info = await gowaFetch<RawGowaGroup | null>('/group/info', {
        deviceId,
        query: {group_id: g.JID},
        timeoutMs: 4_000,
      });
      let count = info ? resolveGroupMemberCount(info) : 0;
      if (count === 0) {
        const partRes = await gowaFetch<{participants?: unknown[]} | null>('/group/participants', {
          deviceId,
          query: {group_id: g.JID},
          timeoutMs: 4_000,
        }).catch(() => null);
        if (Array.isArray(partRes?.participants)) {
          count = partRes.participants.length;
        }
      }
      groupMetaCache.set(cacheKey, {
        count,
        patch: info
          ? {
              OwnerJID: info.OwnerJID ?? g.OwnerJID,
              Topic: info.Topic ?? g.Topic,
              IsLocked: info.IsLocked ?? g.IsLocked,
              IsAnnounce: info.IsAnnounce ?? g.IsAnnounce,
            }
          : undefined,
        expiresAt: Date.now() + GROUP_META_TTL_MS,
      });
    } catch {
      groupMetaCache.set(cacheKey, {
        count: 0,
        expiresAt: Date.now() + 15_000,
      });
    }
  });

  const resolvedNow = Date.now();
  return normalized.map((g) => {
    if ((g.ParticipantCount ?? 0) > 0) return g;
    const cached = groupMetaCache.get(`${deviceId}::${g.JID}`);
    if (cached && cached.expiresAt > resolvedNow) {
      return {
        ...g,
        ...cached.patch,
        ParticipantCount: cached.count,
      };
    }
    return g;
  });
}

export function registerGroupRoutes(): Router {
  const router = createApiRouter();

  router.get('/api/unified/groups', requireAuth, requireAdmin, async (req, res) => {
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
      const aliases = getAccountAliases();
      const devices = (await gowaFetch<GowaDevice[]>('/devices')) ?? [];
      const targetDevices =
        selectedDeviceSet.size > 0
          ? devices.filter((d) => selectedDeviceSet.has(d.id))
          : devices;

      const deviceErrors: Array<{device_id: string; display_name: string; message: string}> = [];
      const items: Array<
        | {
            kind: 'group';
            device_id: string;
            device_display_name: string;
            device_state: GowaDevice['state'];
            jid: string;
            name: string;
            participant_count: number;
            group: RawGowaGroup;
          }
        | {
            kind: 'newsletter';
            device_id: string;
            device_display_name: string;
            device_state: GowaDevice['state'];
            jid: string;
            name: string;
            subscribers_count: number;
            live_active: boolean;
            newsletter: RawGowaNewsletter;
          }
      > = [];

      let groupsCount = 0;
      let newslettersCount = 0;

      await Promise.all(
        targetDevices.map(async (dev) => {
          const displayName = resolveAccountDisplayName(dev, aliases);
          if (dev.state !== 'logged_in' && dev.state !== 'connected') {
            return;
          }

          const [groupsResult, newslettersResult, liveUpdatesResult] = await Promise.all([
            gowaFetch<{data?: RawGowaGroup[]} | null>('/user/my/groups', {deviceId: dev.id})
              .then((res) => ({ok: true as const, data: res?.data ?? []}))
              .catch((err) => ({ok: false as const, err})),
            gowaFetch<{data?: RawGowaNewsletter[]} | null>('/user/my/newsletters', {
              deviceId: dev.id,
            })
              .then((res) => res?.data ?? [])
              .catch(() => [] as RawGowaNewsletter[]),
            gowaFetch<{data?: Array<{jid: string}>} | null>('/newsletter/live-updates', {
              deviceId: dev.id,
            })
              .then((res) => res?.data ?? [])
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
            const enrichedGroups = await enrichGroupsWithCounts(dev.id, groupsResult.data);
            for (const g of enrichedGroups) {
              const memberCount = resolveGroupMemberCount(g);
              groupsCount += 1;
              items.push({
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

          const liveSet = new Set(liveUpdatesResult.map((l) => l.jid));
          for (const nl of newslettersResult) {
            if (!nl?.id) continue;
            const subs = nl.thread_metadata?.subscribers_count ?? 0;
            newslettersCount += 1;
            items.push({
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
        }),
      );

      items.sort((a, b) => a.name.localeCompare(b.name, 'ar'));

      res.json({
        code: 'SUCCESS',
        message: 'ok',
        results: {
          items,
          groups_count: groupsCount,
          newsletters_count: newslettersCount,
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

  router.get('/api/devices/:deviceId/groups', requireAuth, requireAdmin, async (req, res) => {
    const deviceId = decodeRouteParam(req.params.deviceId);
    try {
      const data = await gowaFetch<{data?: RawGowaGroup[]} | null>('/user/my/groups', {deviceId});
      const enriched = await enrichGroupsWithCounts(deviceId, data?.data ?? []);
      res.json({code: 'SUCCESS', message: 'ok', results: enriched});
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  router.post('/api/devices/:deviceId/groups', requireAuth, requireAdmin, async (req, res) => {
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
  });

  router.post(
    '/api/devices/:deviceId/groups/join-with-link',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const body = req.body as {link?: unknown};
      const link = typeof body.link === 'string' ? body.link.trim() : '';
      if (!link) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'رابط الدعوة مطلوب'});
        return;
      }
      try {
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
    requireAdmin,
    async (req, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const link = typeof req.query.link === 'string' ? req.query.link.trim() : '';
      if (!link) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'رابط الدعوة مطلوب'});
        return;
      }
      try {
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

  router.get('/api/devices/:deviceId/groups/info', requireAuth, requireAdmin, async (req, res) => {
    const deviceId = decodeRouteParam(req.params.deviceId);
    const groupId = typeof req.query.group_id === 'string' ? req.query.group_id.trim() : '';
    if (!groupId) {
      res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف المجموعة مطلوب'});
      return;
    }
    try {
      const result = await gowaFetch('/group/info', {
        deviceId,
        query: {group_id: groupId},
      });
      res.json({code: 'SUCCESS', message: 'ok', results: result});
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  router.post('/api/devices/:deviceId/groups/leave', requireAuth, requireAdmin, async (req, res) => {
    const deviceId = decodeRouteParam(req.params.deviceId);
    const body = req.body as {group_id?: unknown};
    const groupId = typeof body.group_id === 'string' ? body.group_id.trim() : '';
    if (!groupId) {
      res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف المجموعة مطلوب'});
      return;
    }
    try {
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
  });

  router.get(
    '/api/devices/:deviceId/groups/participants',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const groupId = typeof req.query.group_id === 'string' ? req.query.group_id.trim() : '';
      if (!groupId) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف المجموعة مطلوب'});
        return;
      }
      try {
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
    requireAdmin,
    async (req, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const groupId = typeof req.query.group_id === 'string' ? req.query.group_id.trim() : '';
      if (!groupId) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف المجموعة مطلوب'});
        return;
      }
      try {
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
    requireAdmin,
    async (req, res) => {
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
    requireAdmin,
    async (req, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const groupId = typeof req.query.group_id === 'string' ? req.query.group_id.trim() : '';
      if (!groupId) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف المجموعة مطلوب'});
        return;
      }
      try {
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
    requireAdmin,
    async (req, res) => {
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

  router.post('/api/devices/:deviceId/groups/name', requireAuth, requireAdmin, async (req, res) => {
    const deviceId = decodeRouteParam(req.params.deviceId);
    const body = req.body as {group_id?: unknown; name?: unknown};
    const groupId = typeof body.group_id === 'string' ? body.group_id.trim() : '';
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!groupId || !name) {
      res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف المجموعة والاسم مطلوبان'});
      return;
    }
    try {
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
  });

  router.post('/api/devices/:deviceId/groups/topic', requireAuth, requireAdmin, async (req, res) => {
    const deviceId = decodeRouteParam(req.params.deviceId);
    const body = req.body as {group_id?: unknown; topic?: unknown};
    const groupId = typeof body.group_id === 'string' ? body.group_id.trim() : '';
    const topic = typeof body.topic === 'string' ? body.topic : '';
    if (!groupId) {
      res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف المجموعة مطلوب'});
      return;
    }
    try {
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
  });

  router.post('/api/devices/:deviceId/groups/locked', requireAuth, requireAdmin, async (req, res) => {
    const deviceId = decodeRouteParam(req.params.deviceId);
    const body = req.body as {group_id?: unknown; locked?: unknown};
    const groupId = typeof body.group_id === 'string' ? body.group_id.trim() : '';
    if (!groupId || typeof body.locked !== 'boolean') {
      res.status(400).json({code: 'VALIDATION_ERROR', message: 'بيانات القفل غير مكتملة'});
      return;
    }
    try {
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
  });

  router.post('/api/devices/:deviceId/groups/announce', requireAuth, requireAdmin, async (req, res) => {
    const deviceId = decodeRouteParam(req.params.deviceId);
    const body = req.body as {group_id?: unknown; announce?: unknown};
    const groupId = typeof body.group_id === 'string' ? body.group_id.trim() : '';
    if (!groupId || typeof body.announce !== 'boolean') {
      res.status(400).json({code: 'VALIDATION_ERROR', message: 'بيانات وضع الإعلانات غير مكتملة'});
      return;
    }
    try {
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
  });

  router.get(
    '/api/devices/:deviceId/groups/invite-link',
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const groupId = typeof req.query.group_id === 'string' ? req.query.group_id.trim() : '';
      const reset = req.query.reset === 'true';
      if (!groupId) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف المجموعة مطلوب'});
        return;
      }
      try {
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

  router.post('/api/devices/:deviceId/groups/photo', requireAuth, requireAdmin, async (req, res) => {
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
      db.prepare('DELETE FROM contact_avatars WHERE device_id = ? AND jid = ?').run(deviceId, groupId);
      res.json({code: 'SUCCESS', message: 'تم تحديث صورة المجموعة', results: result});
    } catch (err) {
      handleRouteError(res, err);
    }
  });

  return router;
}
