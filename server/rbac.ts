import {isGroupJid, isNewsletterJid, isStatusBroadcastJid} from '../shared/whatsapp-identity.ts';

import {GowaError} from './errors.ts';

export type PermissionResource =
  | 'chats'
  | 'notes'
  | 'schedules'
  | 'groups'
  | 'accounts'
  | 'misc'
  | 'users'
  | 'roles'
  | 'settings';

export interface PermissionDefinition {
  key: string;
  resource: PermissionResource;
  action: string;
}

export interface PermissionGroupDefinition {
  resource: PermissionResource;
  permissions: PermissionDefinition[];
}

export interface SystemRoleDefinition {
  slug: 'admin' | 'manager' | 'agent';
  name: string;
  description: string;
  isDefault: boolean;
  permissions: string[];
}

export const PERMISSION_GROUPS: PermissionGroupDefinition[] = [
  {
    resource: 'chats',
    permissions: [
      {key: 'chats:read', resource: 'chats', action: 'read'},
      {key: 'chats:write', resource: 'chats', action: 'write'},
      {key: 'chats:revoke', resource: 'chats', action: 'revoke'},
      {key: 'chats:revoke_own', resource: 'chats', action: 'revoke_own'},
      {key: 'chats:view_all', resource: 'chats', action: 'view_all'},
      {key: 'chats:assign', resource: 'chats', action: 'assign'},
      {key: 'chats:close', resource: 'chats', action: 'close'},
    ],
  },
  {
    resource: 'notes',
    permissions: [
      {key: 'notes:read', resource: 'notes', action: 'read'},
      {key: 'notes:write', resource: 'notes', action: 'write'},
      {key: 'notes:delete', resource: 'notes', action: 'delete'},
    ],
  },
  {
    resource: 'schedules',
    permissions: [
      {key: 'schedules:read', resource: 'schedules', action: 'read'},
      {key: 'schedules:write', resource: 'schedules', action: 'write'},
      {key: 'schedules:manage', resource: 'schedules', action: 'manage'},
    ],
  },
  {
    resource: 'groups',
    permissions: [
      {key: 'groups:read', resource: 'groups', action: 'read'},
      {key: 'groups:write', resource: 'groups', action: 'write'},
      {key: 'groups:manage', resource: 'groups', action: 'manage'},
    ],
  },
  {
    resource: 'accounts',
    permissions: [
      {key: 'accounts:read', resource: 'accounts', action: 'read'},
      {key: 'accounts:write', resource: 'accounts', action: 'write'},
      {key: 'accounts:assign', resource: 'accounts', action: 'assign'},
    ],
  },
  {
    resource: 'misc',
    permissions: [
      {key: 'misc:status.read', resource: 'misc', action: 'status.read'},
      {key: 'misc:channels.manage', resource: 'misc', action: 'channels.manage'},
      {key: 'misc:calls.reject', resource: 'misc', action: 'calls.reject'},
    ],
  },
  {
    resource: 'users',
    permissions: [
      {key: 'users:read', resource: 'users', action: 'read'},
      {key: 'users:write', resource: 'users', action: 'write'},
      {key: 'users:delete', resource: 'users', action: 'delete'},
    ],
  },
  {
    resource: 'roles',
    permissions: [
      {key: 'roles:read', resource: 'roles', action: 'read'},
      {key: 'roles:write', resource: 'roles', action: 'write'},
      {key: 'roles:delete', resource: 'roles', action: 'delete'},
    ],
  },
  {
    resource: 'settings',
    permissions: [
      {key: 'settings:read', resource: 'settings', action: 'read'},
      {key: 'settings:write', resource: 'settings', action: 'write'},
    ],
  },
];

export const ALL_PERMISSION_KEYS: string[] = PERMISSION_GROUPS.flatMap((group) =>
  group.permissions.map((perm) => perm.key),
);

export const PERMISSION_SET = new Set<string>(ALL_PERMISSION_KEYS);

export const SYSTEM_ROLE_DEFINITIONS: SystemRoleDefinition[] = [
  {
    slug: 'admin',
    name: 'مسؤول النظام',
    description: 'صلاحيات كاملة لإدارة النظام والأدوار والمستخدمين والحسابات',
    isDefault: false,
    permissions: [...ALL_PERMISSION_KEYS],
  },
  {
    slug: 'manager',
    name: 'مشرف الفريق',
    description: 'إدارة المحادثات والمجموعات والجدولة والحسابات ومراقبة الفريق',
    isDefault: false,
    permissions: [
      'chats:read',
      'chats:write',
      'chats:revoke',
      'chats:view_all',
      'chats:assign',
      'chats:close',
      'notes:read',
      'notes:write',
      'notes:delete',
      'schedules:read',
      'schedules:write',
      'schedules:manage',
      'groups:read',
      'groups:write',
      'groups:manage',
      'accounts:read',
      'accounts:write',
      'accounts:assign',
      'misc:status.read',
      'misc:channels.manage',
      'misc:calls.reject',
      'users:read',
      'roles:read',
      'settings:read',
    ],
  },
  {
    slug: 'agent',
    name: 'وكيل خدمة',
    description: 'الرد على المحادثات وإضافة الملاحظات والجدولة وقراءة الحسابات المصرح بها',
    isDefault: true,
    permissions: [
      'chats:read',
      'chats:write',
      'chats:revoke_own',
      'chats:assign',
      'chats:close',
      'notes:read',
      'notes:write',
      'schedules:read',
      'schedules:write',
      'schedules:manage',
      'accounts:read',
    ],
  },
];

export interface RbacSubject {
  role: 'admin' | 'agent';
  role_slug?: string;
  permissions: string[];
  allowed_device_ids: string[];
}

export function isValidPermissionKey(key: string): boolean {
  return PERMISSION_SET.has(key);
}

export function normalizePermissionsInput(keys: unknown): string[] {
  if (!Array.isArray(keys)) {
    throw new GowaError(400, 'VALIDATION_ERROR', 'قائمة الصلاحيات يجب أن تكون مصفوفة صالحة');
  }
  const seen = new Set<string>();
  for (const raw of keys) {
    if (typeof raw !== 'string') {
      throw new GowaError(400, 'INVALID_PERMISSION', 'معرّف الصلاحية يجب أن يكون نصًا');
    }
    const clean = raw.trim();
    if (!PERMISSION_SET.has(clean)) {
      throw new GowaError(400, 'INVALID_PERMISSION', `صلاحية غير معروفة: ${clean}`);
    }
    seen.add(clean);
  }
  if (seen.size === 0) {
    throw new GowaError(400, 'VALIDATION_ERROR', 'يجب تحديد صلاحية واحدة على الأقل للدور');
  }
  return ALL_PERMISSION_KEYS.filter((key) => seen.has(key));
}

export function normalizeDeviceIdsInput(ids: unknown): string[] {
  if (!Array.isArray(ids)) {
    throw new GowaError(400, 'VALIDATION_ERROR', 'قائمة الحسابات المسموحة يجب أن تكون مصفوفة صالحة');
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    if (typeof raw !== 'string') {
      throw new GowaError(400, 'VALIDATION_ERROR', 'معرّف الحساب يجب أن يكون نصًا');
    }
    const clean = raw.trim();
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return out;
}

export function isAdminSubject(user: Pick<RbacSubject, 'role' | 'role_slug'>): boolean {
  return user.role_slug === 'admin' || (!user.role_slug && user.role === 'admin');
}

export function hasPermissionKey(user: RbacSubject, key: string): boolean {
  if (isAdminSubject(user)) return true;
  return user.permissions.includes(key);
}

export function hasPermission(
  user: RbacSubject,
  resource: PermissionResource,
  action: string,
): boolean {
  return hasPermissionKey(user, `${resource}:${action}`);
}

export function hasChatReadPermission(user: RbacSubject, chatJid: string): boolean {
  if (isStatusBroadcastJid(chatJid)) return hasPermission(user, 'misc', 'status.read');
  if (isNewsletterJid(chatJid)) return hasPermission(user, 'misc', 'channels.manage');
  return hasPermission(user, isGroupJid(chatJid) ? 'groups' : 'chats', 'read');
}

export function hasAnyPermission(user: RbacSubject, keys: string[]): boolean {
  if (isAdminSubject(user)) return true;
  return keys.some((key) => user.permissions.includes(key));
}

export function hasDeviceAccess(
  user: Pick<RbacSubject, 'allowed_device_ids'>,
  deviceId: string,
): boolean {
  if (!deviceId) return false;
  if (user.allowed_device_ids.length === 0) return true;
  return user.allowed_device_ids.includes(deviceId);
}

export function filterAllowedDevices<T extends {id: string}>(
  user: Pick<RbacSubject, 'allowed_device_ids'>,
  devices: T[],
): T[] {
  if (user.allowed_device_ids.length === 0) return devices;
  const allowed = new Set(user.allowed_device_ids);
  return devices.filter((dev) => allowed.has(dev.id));
}
