import {http, results} from '@/lib/http';
import type {PermissionGroup, RoleRecord} from '@/api/contracts/auth';

export function listPermissions(): Promise<PermissionGroup[]> {
  return results(http.get('/permissions'));
}

export function listRoles(): Promise<RoleRecord[]> {
  return results(http.get('/roles'));
}

export function createRole(payload: {
  name: string;
  description?: string;
  permissions: string[];
  is_default?: boolean;
}): Promise<RoleRecord> {
  return results(http.post('/roles', payload));
}

export function updateRole(
  id: number,
  payload: {
    name?: string;
    description?: string;
    permissions?: string[];
    is_default?: boolean;
  },
): Promise<RoleRecord> {
  return results(http.patch(`/roles/${id}`, payload));
}

export async function deleteRole(id: number): Promise<void> {
  await http.delete(`/roles/${id}`);
}

// Settings (Admin)
