import crypto from 'node:crypto';
import {GowaError} from '../errors.ts';
import {
  ALL_PERMISSION_KEYS,
  normalizeDeviceIdsInput,
  normalizePermissionsInput,
} from '../rbac.ts';
import {db, queryAll, queryOne} from './connection.ts';
import {
  hashPassword,
  hashPasswordAsync,
  hashSessionToken,
  verifyPassword,
  verifyPasswordAsync,
} from './crypto.ts';

export type UserRole = 'admin' | 'agent';
export type ThemePreference = 'light' | 'dark' | 'system';
export type LanguagePreference = 'ar' | 'en';

export interface PublicUser {
  id: number;
  username: string;
  display_name: string;
  role: UserRole;
  role_id: number | null;
  role_slug: string;
  role_name: string;
  permissions: string[];
  allowed_device_ids: string[];
  is_active: boolean;
  created_at: string;
  theme: ThemePreference;
  language: LanguagePreference;
}

export interface RoleRecord {
  id: number;
  slug: string;
  name: string;
  description: string;
  is_system: boolean;
  is_default: boolean;
  permissions: string[];
  user_count: number;
  created_at: string;
  updated_at: string;
}

interface UserRow {
  id: number;
  username: string;
  display_name: string;
  role: UserRole;
  role_id: number | null;
  password_hash: string;
  is_active: number;
  created_at: string;
}

interface RoleRow {
  id: number;
  slug: string;
  name: string;
  description: string;
  is_system: number;
  is_default: number;
  created_at: string;
  updated_at: string;
}

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

let userCacheVersion = 1;

export function getUserCacheVersion(): number {
  return userCacheVersion;
}

export function bumpUserCacheVersion(): void {
  userCacheVersion += 1;
}

export function hasAnyUsers(): boolean {
  const row = queryOne<{count: number}>('SELECT COUNT(*) AS count FROM users');
  return (row?.count ?? 0) > 0;
}

export function countActiveAdmins(): number {
  const row = queryOne<{count: number}>(
    `SELECT COUNT(*) AS count
     FROM users u
     LEFT JOIN roles r ON r.id = u.role_id
     WHERE u.is_active = 1
       AND (r.slug = 'admin' OR (u.role_id IS NULL AND u.role = 'admin'))`,
  );
  return row?.count ?? 0;
}

function getRolePermissions(roleId: number | null): string[] {
  if (!roleId) return [];
  const rows = queryAll<{permission_key: string}>(
    'SELECT permission_key FROM role_permissions WHERE role_id = ?',
    roleId,
  );
  const set = new Set(rows.map((r) => r.permission_key));
  return ALL_PERMISSION_KEYS.filter((key) => set.has(key));
}

function getUserAllowedDeviceIds(userId: number): string[] {
  const rows = queryAll<{device_id: string}>(
    'SELECT device_id FROM user_device_access WHERE user_id = ? ORDER BY device_id ASC',
    userId,
  );
  return rows.map((r) => r.device_id);
}

function loadRolePermissionsMap(): Map<number, string[]> {
  const rows = queryAll<{role_id: number; permission_key: string}>(
    'SELECT role_id, permission_key FROM role_permissions',
  );
  const byRole = new Map<number, Set<string>>();
  for (const row of rows) {
    let set = byRole.get(row.role_id);
    if (!set) {
      set = new Set<string>();
      byRole.set(row.role_id, set);
    }
    set.add(row.permission_key);
  }
  const ordered = new Map<number, string[]>();
  for (const [roleId, set] of byRole.entries()) {
    ordered.set(
      roleId,
      ALL_PERMISSION_KEYS.filter((key) => set.has(key)),
    );
  }
  return ordered;
}

function loadUserDevicesMap(): Map<number, string[]> {
  const rows = queryAll<{user_id: number; device_id: string}>(
    'SELECT user_id, device_id FROM user_device_access ORDER BY device_id ASC',
  );
  const byUser = new Map<number, string[]>();
  for (const row of rows) {
    let list = byUser.get(row.user_id);
    if (!list) {
      list = [];
      byUser.set(row.user_id, list);
    }
    list.push(row.device_id);
  }
  return byUser;
}

type HydratedUserRow = UserRow & {
  theme: ThemePreference;
  language: LanguagePreference;
  role_slug: string | null;
  role_name: string | null;
};

function toPublicUser(
  row: HydratedUserRow,
  permissions?: string[],
  allowedDeviceIds?: string[],
): PublicUser {
  const roleSlug = row.role_slug || (row.role === 'admin' ? 'admin' : 'agent');
  const roleName =
    row.role_name || (roleSlug === 'admin' ? 'مسؤول النظام' : 'وكيل خدمة');
  const resolvedPermissions =
    roleSlug === 'admin'
      ? [...ALL_PERMISSION_KEYS]
      : (permissions ?? getRolePermissions(row.role_id));
  const resolvedDevices = allowedDeviceIds ?? getUserAllowedDeviceIds(row.id);

  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    role: roleSlug === 'admin' ? 'admin' : 'agent',
    role_id: row.role_id,
    role_slug: roleSlug,
    role_name: roleName,
    permissions: resolvedPermissions,
    allowed_device_ids: resolvedDevices,
    is_active: row.is_active === 1,
    created_at: row.created_at,
    theme: row.theme,
    language: row.language,
  };
}

export function getUserPreferences(userId: number): {
  theme: ThemePreference;
  language: LanguagePreference;
} {
  const row = queryOne<{theme: ThemePreference; language: LanguagePreference}>(
    'SELECT theme, language FROM user_preferences WHERE user_id = ?',
    userId,
  );
  return {
    theme: row?.theme ?? 'system',
    language: row?.language ?? 'ar',
  };
}

export function setUserPreferences(
  userId: number,
  patch: {theme?: ThemePreference; language?: LanguagePreference},
): void {
  const current = getUserPreferences(userId);
  const nextTheme = patch.theme ?? current.theme;
  const nextLanguage = patch.language ?? current.language;
  db.prepare(
    `INSERT INTO user_preferences (user_id, theme, language, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET
       theme = excluded.theme,
       language = excluded.language,
       updated_at = datetime('now')`,
  ).run(userId, nextTheme, nextLanguage);
  bumpUserCacheVersion();
}

export function setUserTheme(userId: number, theme: ThemePreference): void {
  setUserPreferences(userId, {theme});
}

function getRoleRowById(id: number): RoleRow | undefined {
  return queryOne<RoleRow>(
    'SELECT id, slug, name, description, is_system, is_default, created_at, updated_at FROM roles WHERE id = ?',
    id,
  );
}

function getRoleRowBySlug(slug: string): RoleRow | undefined {
  return queryOne<RoleRow>(
    'SELECT id, slug, name, description, is_system, is_default, created_at, updated_at FROM roles WHERE slug = ?',
    slug,
  );
}

function getDefaultRoleRow(): RoleRow | undefined {
  return (
    queryOne<RoleRow>(
      'SELECT id, slug, name, description, is_system, is_default, created_at, updated_at FROM roles WHERE is_default = 1 ORDER BY id ASC LIMIT 1',
    ) ?? getRoleRowBySlug('agent')
  );
}

function toRoleRecord(
  row: RoleRow,
  permissions?: string[],
  userCount?: number,
): RoleRecord {
  const count =
    userCount ??
    (queryOne<{count: number}>('SELECT COUNT(*) AS count FROM users WHERE role_id = ?', row.id)
      ?.count ?? 0);
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    is_system: row.is_system === 1,
    is_default: row.is_default === 1,
    permissions: permissions ?? getRolePermissions(row.id),
    user_count: Number(count),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listRoles(): RoleRecord[] {
  const rows = queryAll<RoleRow & {user_count: number}>(
    `SELECT r.id, r.slug, r.name, r.description, r.is_system, r.is_default, r.created_at, r.updated_at,
            COUNT(u.id) AS user_count
     FROM roles r
     LEFT JOIN users u ON u.role_id = r.id
     GROUP BY r.id
     ORDER BY r.is_system DESC, r.id ASC`,
  );
  const permsMap = loadRolePermissionsMap();
  return rows.map((row) => toRoleRecord(row, permsMap.get(row.id) ?? [], row.user_count));
}

export function getRoleById(id: number): RoleRecord | null {
  const row = getRoleRowById(id);
  return row ? toRoleRecord(row) : null;
}

export function getRoleBySlug(slug: string): RoleRecord | null {
  const row = getRoleRowBySlug(slug);
  return row ? toRoleRecord(row) : null;
}

function generateCustomRoleSlug(name: string): string {
  const ascii = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  const base = ascii ? `custom-${ascii}` : `role-${crypto.randomBytes(3).toString('hex')}`;
  let candidate = base;
  let counter = 2;
  while (getRoleRowBySlug(candidate)) {
    candidate = `${base}-${counter++}`;
  }
  return candidate;
}

export function createRole(input: {
  name: string;
  description?: string;
  permissions: unknown;
  is_default?: boolean;
}): RoleRecord {
  const cleanName = input.name.trim();
  const cleanDescription = (input.description ?? '').trim();
  if (cleanName.length < 2 || cleanName.length > 60) {
    throw new GowaError(400, 'VALIDATION_ERROR', 'اسم الدور يجب أن يكون بين 2 و 60 حرفًا');
  }
  if (cleanDescription.length > 250) {
    throw new GowaError(400, 'VALIDATION_ERROR', 'وصف الدور يجب ألا يتجاوز 250 حرفًا');
  }

  const normalizedPermissions = normalizePermissionsInput(input.permissions);
  const duplicate = queryOne<{id: number}>('SELECT id FROM roles WHERE name = ?', cleanName);
  if (duplicate) {
    throw new GowaError(409, 'ROLE_NAME_TAKEN', 'يوجد دور آخر بنفس الاسم بالفعل');
  }

  const slug = generateCustomRoleSlug(cleanName);
  const isDefault = input.is_default === true;
  const sp = 'gowa_create_role';
  db.exec(`SAVEPOINT ${sp}`);
  try {
    if (isDefault) {
      db.prepare('UPDATE roles SET is_default = 0').run();
    }
    const info = db
      .prepare(
        `INSERT INTO roles (slug, name, description, is_system, is_default)
         VALUES (?, ?, ?, 0, ?)`,
      )
      .run(slug, cleanName, cleanDescription, isDefault ? 1 : 0);
    const roleId = Number(info.lastInsertRowid);
    const insertPerm = db.prepare(
      'INSERT INTO role_permissions (role_id, permission_key) VALUES (?, ?)',
    );
    for (const permKey of normalizedPermissions) {
      insertPerm.run(roleId, permKey);
    }
    db.exec(`RELEASE SAVEPOINT ${sp}`);
    const created = getRoleById(roleId);
    if (!created) throw new Error('Failed to load newly created role');
    return created;
  } catch (err) {
    db.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
    db.exec(`RELEASE SAVEPOINT ${sp}`);
    throw err;
  }
}

export function updateRole(
  id: number,
  patch: {
    name?: string;
    description?: string;
    permissions?: unknown;
    is_default?: boolean;
  },
): RoleRecord | null {
  const existing = getRoleRowById(id);
  if (!existing) return null;
  if (existing.is_system === 1) {
    throw new GowaError(
      403,
      'SYSTEM_ROLE_PROTECTED',
      'لا يمكن تعديل الأدوار النظامية الأساسية، يمكنك استنساخ الدور إلى دور مخصص',
    );
  }

  let nextName = existing.name;
  if (patch.name !== undefined) {
    const cleanName = patch.name.trim();
    if (cleanName.length < 2 || cleanName.length > 60) {
      throw new GowaError(400, 'VALIDATION_ERROR', 'اسم الدور يجب أن يكون بين 2 و 60 حرفًا');
    }
    const duplicate = queryOne<{id: number}>(
      'SELECT id FROM roles WHERE name = ? AND id != ?',
      cleanName,
      id,
    );
    if (duplicate) {
      throw new GowaError(409, 'ROLE_NAME_TAKEN', 'يوجد دور آخر بنفس الاسم بالفعل');
    }
    nextName = cleanName;
  }

  let nextDescription = existing.description;
  if (patch.description !== undefined) {
    const cleanDesc = patch.description.trim();
    if (cleanDesc.length > 250) {
      throw new GowaError(400, 'VALIDATION_ERROR', 'وصف الدور يجب ألا يتجاوز 250 حرفًا');
    }
    nextDescription = cleanDesc;
  }

  const nextPermissions =
    patch.permissions !== undefined ? normalizePermissionsInput(patch.permissions) : undefined;

  const nextDefault =
    patch.is_default === undefined ? existing.is_default === 1 : patch.is_default;

  const sp = 'gowa_update_role';
  db.exec(`SAVEPOINT ${sp}`);
  try {
    if (patch.is_default === true) {
      db.prepare('UPDATE roles SET is_default = 0 WHERE id != ?').run(id);
    } else if (patch.is_default === false && existing.is_default === 1) {
      const agentRole = getRoleRowBySlug('agent');
      if (agentRole && agentRole.id !== id) {
        db.prepare('UPDATE roles SET is_default = 1 WHERE id = ?').run(agentRole.id);
      }
    }

    db.prepare(
      `UPDATE roles
       SET name = ?, description = ?, is_default = ?, updated_at = datetime('now')
       WHERE id = ?`,
    ).run(nextName, nextDescription, nextDefault ? 1 : 0, id);

    if (nextPermissions) {
      db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(id);
      const insertPerm = db.prepare(
        'INSERT INTO role_permissions (role_id, permission_key) VALUES (?, ?)',
      );
      for (const permKey of nextPermissions) {
        insertPerm.run(id, permKey);
      }
    }

    db.exec(`RELEASE SAVEPOINT ${sp}`);
    bumpUserCacheVersion();
    return getRoleById(id);
  } catch (err) {
    db.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
    db.exec(`RELEASE SAVEPOINT ${sp}`);
    throw err;
  }
}

export function deleteRole(id: number): boolean {
  const existing = getRoleRowById(id);
  if (!existing) return false;
  if (existing.is_system === 1) {
    throw new GowaError(403, 'SYSTEM_ROLE_PROTECTED', 'لا يمكن حذف الأدوار النظامية الأساسية');
  }
  const usage = queryOne<{count: number}>(
    'SELECT COUNT(*) AS count FROM users WHERE role_id = ?',
    id,
  );
  if ((usage?.count ?? 0) > 0) {
    throw new GowaError(409, 'ROLE_IN_USE', 'لا يمكن حذف دور مرتبط بمستخدمين حاليين');
  }

  const sp = 'gowa_delete_role';
  db.exec(`SAVEPOINT ${sp}`);
  try {
    if (existing.is_default === 1) {
      const agentRole = getRoleRowBySlug('agent');
      if (agentRole && agentRole.id !== id) {
        db.prepare('UPDATE roles SET is_default = 1 WHERE id = ?').run(agentRole.id);
      }
    }
    const result = db.prepare('DELETE FROM roles WHERE id = ?').run(id);
    db.exec(`RELEASE SAVEPOINT ${sp}`);
    if (result.changes > 0) bumpUserCacheVersion();
    return result.changes > 0;
  } catch (err) {
    db.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
    db.exec(`RELEASE SAVEPOINT ${sp}`);
    throw err;
  }
}

const USER_SELECT_BASE = `
  SELECT u.id, u.username, u.display_name, u.role, u.role_id, u.password_hash, u.is_active, u.created_at,
         COALESCE(p.theme, 'system') AS theme,
         COALESCE(p.language, 'ar') AS language,
         r.slug AS role_slug,
         r.name AS role_name
  FROM users u
  LEFT JOIN user_preferences p ON p.user_id = u.id
  LEFT JOIN roles r ON r.id = u.role_id
`;

export function listUsers(): PublicUser[] {
  const rows = queryAll<HydratedUserRow>(`${USER_SELECT_BASE} ORDER BY u.id ASC`);
  const permsMap = loadRolePermissionsMap();
  const devicesMap = loadUserDevicesMap();
  return rows.map((row) =>
    toPublicUser(
      row,
      row.role_id ? (permsMap.get(row.role_id) ?? []) : undefined,
      devicesMap.get(row.id) ?? [],
    ),
  );
}

export function getUserById(id: number): PublicUser | null {
  const row = queryOne<HydratedUserRow>(`${USER_SELECT_BASE} WHERE u.id = ?`, id);
  return row ? toPublicUser(row) : null;
}

function resolveRoleForUserWrite(roleId?: number, legacyRole?: UserRole): RoleRow {
  if (roleId !== undefined) {
    const found = getRoleRowById(roleId);
    if (!found) {
      throw new GowaError(400, 'INVALID_ROLE', 'الدور المحدد غير موجود');
    }
    return found;
  }
  if (legacyRole === 'admin') {
    const admin = getRoleRowBySlug('admin');
    if (admin) return admin;
  }
  if (legacyRole === 'agent') {
    const agent = getRoleRowBySlug('agent');
    if (agent) return agent;
  }
  const def = getDefaultRoleRow();
  if (!def) {
    throw new Error('Default RBAC role is missing');
  }
  return def;
}

export function createUser(input: {
  username: string;
  display_name: string;
  role?: UserRole;
  role_id?: number;
  allowed_device_ids?: unknown;
  password: string;
  passwordHashOverride?: string;
}): PublicUser {
  const resolvedRole = resolveRoleForUserWrite(input.role_id, input.role);
  const legacyRole: UserRole = resolvedRole.slug === 'admin' ? 'admin' : 'agent';
  const deviceIds =
    input.allowed_device_ids !== undefined
      ? normalizeDeviceIdsInput(input.allowed_device_ids)
      : [];
  const passwordHash = input.passwordHashOverride ?? hashPassword(input.password);

  const sp = 'gowa_create_user';
  db.exec(`SAVEPOINT ${sp}`);
  try {
    const info = db
      .prepare(
        `INSERT INTO users (username, display_name, role, role_id, password_hash, is_active)
         VALUES (?, ?, ?, ?, ?, 1)`,
      )
      .run(
        input.username.trim(),
        input.display_name.trim(),
        legacyRole,
        resolvedRole.id,
        passwordHash,
      );
    const userId = Number(info.lastInsertRowid);
    setUserTheme(userId, 'system');

    if (deviceIds.length > 0) {
      const insertDevice = db.prepare(
        'INSERT OR IGNORE INTO user_device_access (user_id, device_id) VALUES (?, ?)',
      );
      for (const deviceId of deviceIds) {
        insertDevice.run(userId, deviceId);
      }
    }

    db.exec(`RELEASE SAVEPOINT ${sp}`);
    bumpUserCacheVersion();
    const created = getUserById(userId);
    if (!created) {
      throw new Error('Failed to load newly created user');
    }
    return created;
  } catch (err) {
    db.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
    db.exec(`RELEASE SAVEPOINT ${sp}`);
    throw err;
  }
}

export async function createUserAsync(input: {
  username: string;
  display_name: string;
  role?: UserRole;
  role_id?: number;
  allowed_device_ids?: unknown;
  password: string;
}): Promise<PublicUser> {
  const passwordHashOverride = await hashPasswordAsync(input.password);
  return createUser({...input, passwordHashOverride});
}

export function updateUser(
  id: number,
  patch: {
    display_name?: string;
    role?: UserRole;
    role_id?: number;
    allowed_device_ids?: unknown;
    is_active?: boolean;
    password?: string;
    passwordHashOverride?: string;
  },
): PublicUser | null {
  const existing = queryOne<UserRow>(
    'SELECT id, username, display_name, role, role_id, password_hash, is_active, created_at FROM users WHERE id = ?',
    id,
  );
  if (!existing) return null;

  const nextDisplayName = patch.display_name?.trim() || existing.display_name;
  let nextRoleId = existing.role_id;
  let nextRole: UserRole = existing.role;

  if (patch.role_id !== undefined) {
    const targetRole = resolveRoleForUserWrite(patch.role_id);
    nextRoleId = targetRole.id;
    nextRole = targetRole.slug === 'admin' ? 'admin' : 'agent';
  } else if (patch.role !== undefined && (patch.role !== existing.role || nextRoleId === null)) {
    const targetRole = resolveRoleForUserWrite(undefined, patch.role);
    nextRoleId = targetRole.id;
    nextRole = targetRole.slug === 'admin' ? 'admin' : 'agent';
  }

  const nextDeviceIds =
    patch.allowed_device_ids !== undefined
      ? normalizeDeviceIdsInput(patch.allowed_device_ids)
      : undefined;

  const nextActive = patch.is_active === undefined ? existing.is_active : patch.is_active ? 1 : 0;
  const nextPasswordHash = patch.passwordHashOverride
    ? patch.passwordHashOverride
    : patch.password
      ? hashPassword(patch.password)
      : existing.password_hash;

  const sp = 'gowa_update_user';
  db.exec(`SAVEPOINT ${sp}`);
  try {
    db.prepare(
      `UPDATE users
       SET display_name = ?, role = ?, role_id = ?, is_active = ?, password_hash = ?
       WHERE id = ?`,
    ).run(nextDisplayName, nextRole, nextRoleId, nextActive, nextPasswordHash, id);

    if (nextDeviceIds !== undefined) {
      db.prepare('DELETE FROM user_device_access WHERE user_id = ?').run(id);
      const insertDevice = db.prepare(
        'INSERT OR IGNORE INTO user_device_access (user_id, device_id) VALUES (?, ?)',
      );
      for (const deviceId of nextDeviceIds) {
        insertDevice.run(id, deviceId);
      }
    }

    if (nextActive === 0) {
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    }

    db.exec(`RELEASE SAVEPOINT ${sp}`);
    bumpUserCacheVersion();
    return getUserById(id);
  } catch (err) {
    db.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
    db.exec(`RELEASE SAVEPOINT ${sp}`);
    throw err;
  }
}

export async function updateUserAsync(
  id: number,
  patch: {
    display_name?: string;
    role?: UserRole;
    role_id?: number;
    allowed_device_ids?: unknown;
    is_active?: boolean;
    password?: string;
  },
): Promise<PublicUser | null> {
  const passwordHashOverride = patch.password ? await hashPasswordAsync(patch.password) : undefined;
  return updateUser(id, {...patch, passwordHashOverride});
}

export function deleteUser(id: number): boolean {
  const sp = 'gowa_delete_user';
  db.exec(`SAVEPOINT ${sp}`);
  try {
    db.prepare(
      `UPDATE chat_assignments
       SET status = 'pending', assigned_user_id = NULL, assigned_at = NULL, claimed_at = NULL, updated_at = ?
       WHERE assigned_user_id = ? AND status = 'open'`,
    ).run(Date.now(), id);
    const result = db.prepare('DELETE FROM users WHERE id = ?').run(id);
    db.exec(`RELEASE SAVEPOINT ${sp}`);
    if (result.changes > 0) bumpUserCacheVersion();
    return result.changes > 0;
  } catch (err) {
    db.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
    db.exec(`RELEASE SAVEPOINT ${sp}`);
    throw err;
  }
}

export function authenticateUser(username: string, password: string): PublicUser | null {
  const row = queryOne<HydratedUserRow>(
    `${USER_SELECT_BASE} WHERE u.username = ?`,
    username.trim(),
  );
  if (!row || row.is_active !== 1) return null;
  if (!verifyPassword(password, row.password_hash)) return null;
  return toPublicUser(row);
}

export async function authenticateUserAsync(
  username: string,
  password: string,
): Promise<PublicUser | null> {
  const row = queryOne<HydratedUserRow>(
    `${USER_SELECT_BASE} WHERE u.username = ?`,
    username.trim(),
  );
  if (!row || row.is_active !== 1) return null;
  if (!(await verifyPasswordAsync(password, row.password_hash))) return null;
  return toPublicUser(row);
}

export function createSession(userId: number): string {
  const now = Date.now();
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashSessionToken(rawToken);
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(
    tokenHash,
    userId,
    now + SESSION_TTL_MS,
    now,
  );
  return rawToken;
}

export function getSessionUser(rawToken: string): PublicUser | null {
  if (!rawToken) return null;
  const tokenHash = hashSessionToken(rawToken);
  const now = Date.now();
  const row = queryOne<HydratedUserRow & {expires_at: number}>(
    `SELECT u.id, u.username, u.display_name, u.role, u.role_id, u.password_hash, u.is_active, u.created_at,
            s.expires_at,
            COALESCE(p.theme, 'system') AS theme,
            COALESCE(p.language, 'ar') AS language,
            r.slug AS role_slug,
            r.name AS role_name
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN user_preferences p ON p.user_id = u.id
     LEFT JOIN roles r ON r.id = u.role_id
     WHERE s.token_hash = ?`,
    tokenHash,
  );

  if (!row) return null;
  if (row.expires_at <= now || row.is_active !== 1) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    return null;
  }
  return toPublicUser(row);
}

export function deleteSession(rawToken: string): void {
  if (!rawToken) return;
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashSessionToken(rawToken));
}

export function hasActiveSession(sessionHash: string, userId: number): boolean {
  return Boolean(
    queryOne(
      'SELECT 1 FROM sessions WHERE token_hash = ? AND user_id = ? AND expires_at > ?',
      sessionHash,
      userId,
      Date.now(),
    ),
  );
}
