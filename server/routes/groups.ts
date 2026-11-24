import type {Router} from 'express';
import {db} from '../db.ts';
import {gowaFetch, gowaFetchRaw} from '../gowa-client.ts';
import {
  createApiRouter,
  decodeImageUpload,
  handleRouteError,
  requireAdmin,
  requireAuth,
} from '../middleware/auth.ts';
import {decodeRouteParam} from '../security.ts';

export function registerGroupRoutes(): Router {
  const router = createApiRouter();

  router.get('/api/devices/:deviceId/groups', requireAuth, requireAdmin, async (req, res) => {
    const deviceId = decodeRouteParam(req.params.deviceId);
    try {
      const data = await gowaFetch<{data?: unknown[]} | null>('/user/my/groups', {deviceId});
      res.json({code: 'SUCCESS', message: 'ok', results: data?.data ?? []});
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
