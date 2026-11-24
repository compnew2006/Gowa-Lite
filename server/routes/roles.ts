import type {Router} from 'express';
import {createRole, deleteRole, getRoleById, listRoles, updateRole} from '../db.ts';
import {
  createApiRouter,
  handleRouteError,
  requireAnyPermission,
  requireAuth,
  requirePermission,
} from '../middleware/auth.ts';
import {
  PERMISSION_GROUPS,
  hasPermissionKey,
  isAdminSubject,
  normalizePermissionsInput,
} from '../rbac.ts';
import type {AuthedRequest} from '../types.ts';

export function registerRoleRoutes(): Router {
  const router = createApiRouter();

  router.get(
    '/api/permissions',
    requireAuth,
    requireAnyPermission(['roles:read', 'users:read', 'users:write']),
    (_req, res) => {
      res.json({code: 'SUCCESS', message: 'ok', results: PERMISSION_GROUPS});
    },
  );

  router.get(
    '/api/roles',
    requireAuth,
    requireAnyPermission(['roles:read', 'users:read', 'users:write']),
    (_req, res) => {
      res.json({code: 'SUCCESS', message: 'ok', results: listRoles()});
    },
  );

  router.post(
    '/api/roles',
    requireAuth,
    requirePermission('roles', 'write'),
    (req: AuthedRequest, res) => {
      const body = req.body as {
        name?: unknown;
        description?: unknown;
        permissions?: unknown;
        is_default?: unknown;
      };
      const name = typeof body.name === 'string' ? body.name : '';
      const description = typeof body.description === 'string' ? body.description : '';

      try {
        const normalizedPermissions = normalizePermissionsInput(body.permissions);
        if (!isAdminSubject(req.user!)) {
          const disallowed = normalizedPermissions.filter(
            (key) => !hasPermissionKey(req.user!, key),
          );
          if (disallowed.length > 0) {
            res.status(403).json({
              code: 'PRIVILEGE_ESCALATION_FORBIDDEN',
              message: 'لا يمكنك إنشاء دور بصلاحيات لا تملكها',
            });
            return;
          }
        }

        const created = createRole({
          name,
          description,
          permissions: normalizedPermissions,
          is_default: body.is_default === true,
        });
        res.status(201).json({
          code: 'SUCCESS',
          message: 'تم إنشاء الدور بنجاح',
          results: created,
        });
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.patch(
    '/api/roles/:id',
    requireAuth,
    requirePermission('roles', 'write'),
    (req: AuthedRequest, res) => {
      const roleId = Number(req.params.id);
      if (!Number.isInteger(roleId) || roleId <= 0) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف الدور غير صالح'});
        return;
      }

      const existing = getRoleById(roleId);
      if (!existing) {
        res.status(404).json({code: 'NOT_FOUND', message: 'الدور غير موجود'});
        return;
      }

      const body = req.body as {
        name?: unknown;
        description?: unknown;
        permissions?: unknown;
        is_default?: unknown;
      };

      try {
        let normalizedPermissions: string[] | undefined;
        if (body.permissions !== undefined) {
          normalizedPermissions = normalizePermissionsInput(body.permissions);
          if (!isAdminSubject(req.user!)) {
            const disallowed = normalizedPermissions.filter(
              (key) => !hasPermissionKey(req.user!, key),
            );
            if (disallowed.length > 0) {
              res.status(403).json({
                code: 'PRIVILEGE_ESCALATION_FORBIDDEN',
                message: 'لا يمكنك منح صلاحيات لا تملكها',
              });
              return;
            }
          }
        }

        const updated = updateRole(roleId, {
          name: typeof body.name === 'string' ? body.name : undefined,
          description: typeof body.description === 'string' ? body.description : undefined,
          permissions: normalizedPermissions,
          is_default: typeof body.is_default === 'boolean' ? body.is_default : undefined,
        });
        res.json({
          code: 'SUCCESS',
          message: 'تم تحديث الدور بنجاح',
          results: updated,
        });
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.delete(
    '/api/roles/:id',
    requireAuth,
    requirePermission('roles', 'delete'),
    (req, res) => {
      const roleId = Number(req.params.id);
      if (!Number.isInteger(roleId) || roleId <= 0) {
        res.status(400).json({code: 'VALIDATION_ERROR', message: 'معرّف الدور غير صالح'});
        return;
      }
      try {
        const deleted = deleteRole(roleId);
        if (!deleted) {
          res.status(404).json({code: 'NOT_FOUND', message: 'الدور غير موجود'});
          return;
        }
        res.json({code: 'SUCCESS', message: 'تم حذف الدور'});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  return router;
}
