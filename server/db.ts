import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync, type SQLInputValue} from 'node:sqlite';
import dotenv from 'dotenv';
import {GowaError} from './errors.ts';
import {
  ALL_PERMISSION_KEYS,
  SYSTEM_ROLE_DEFINITIONS,
  normalizeDeviceIdsInput,
  normalizePermissionsInput,
} from './rbac.ts';

dotenv.config({quiet: true});

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

export interface GowaConfig {
  url: string;
  username: string;
  password: string;
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

const dbPath =
  process.env.GOWA_LITE_DB_PATH?.trim() || path.resolve(process.cwd(), 'gowa-lite.db');

export const db = new DatabaseSync(dbPath);

function queryAll<T extends object>(sql: string, ...params: SQLInputValue[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

function queryOne<T extends object>(sql: string, ...params: SQLInputValue[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

let userCacheVersion = 1;

export function getUserCacheVersion(): number {
  return userCacheVersion;
}

export function bumpUserCacheVersion(): void {
  userCacheVersion += 1;
}

let cachedSettingsKey: Buffer | null = null;
const SETTINGS_ENC_PREFIX = 'enc:v1:';

function getSettingsEncryptionKey(): Buffer {
  const envSecret = process.env.GOWA_SETTINGS_SECRET?.trim();
  if (envSecret) {
    return crypto.createHash('sha256').update(envSecret, 'utf8').digest();
  }
  if (cachedSettingsKey) return cachedSettingsKey;

  if (dbPath === ':memory:') {
    cachedSettingsKey = crypto.randomBytes(32);
    return cachedSettingsKey;
  }

  const keyFilePath = `${dbPath}.key`;
  try {
    if (fs.existsSync(keyFilePath)) {
      const rawHex = fs.readFileSync(keyFilePath, 'utf8').trim();
      const buf = Buffer.from(rawHex, 'hex');
      if (buf.length === 32) {
        cachedSettingsKey = buf;
        return cachedSettingsKey;
      }
    }
  } catch {
    // Regenerate key below if unreadable
  }

  const generated = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(keyFilePath), {recursive: true});
  fs.writeFileSync(keyFilePath, generated.toString('hex'), {encoding: 'utf8', mode: 0o600});
  try {
    fs.chmodSync(keyFilePath, 0o600);
  } catch {
    // Best-effort chmod on non-POSIX filesystems
  }
  cachedSettingsKey = generated;
  return cachedSettingsKey;
}

export function encryptSettingSecret(plainText: string): string {
  if (!plainText) return '';
  if (plainText.startsWith(SETTINGS_ENC_PREFIX)) return plainText;
  const key = getSettingsEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${SETTINGS_ENC_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

export function decryptSettingSecret(storedValue: string): {value: string; wasPlaintext: boolean} {
  if (!storedValue) return {value: '', wasPlaintext: false};
  if (!storedValue.startsWith(SETTINGS_ENC_PREFIX)) {
    return {value: storedValue, wasPlaintext: true};
  }
  const rest = storedValue.slice(SETTINGS_ENC_PREFIX.length);
  const parts = rest.split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted setting secret');
  }
  const [ivB64, tagB64, cipherB64] = parts;
  const key = getSettingsEncryptionKey();
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(ivB64, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(cipherB64, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  return {value: plain, wasPlaintext: false};
}

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA temp_store = MEMORY;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin', 'agent')),
    password_hash TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS user_preferences (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    theme TEXT NOT NULL DEFAULT 'system' CHECK(theme IN ('light', 'dark', 'system')),
    language TEXT NOT NULL DEFAULT 'ar' CHECK(language IN ('ar', 'en')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS contact_avatars (
    device_id TEXT NOT NULL,
    jid TEXT NOT NULL,
    avatar_url TEXT NOT NULL DEFAULT '',
    image_blob BLOB,
    content_type TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK(status IN ('ok', 'none')),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (device_id, jid)
  );

  CREATE TABLE IF NOT EXISTS message_reaction_changes (
    device_id TEXT NOT NULL,
    chat_jid TEXT NOT NULL,
    message_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    emoji TEXT NOT NULL,
    sender_jid TEXT NOT NULL,
    sender_display_name TEXT,
    is_from_me INTEGER NOT NULL,
    timestamp_ms INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    PRIMARY KEY (device_id, chat_jid, message_id, actor)
  );

  CREATE INDEX IF NOT EXISTS idx_message_reaction_changes_expiry
    ON message_reaction_changes (received_at) WHERE is_from_me = 0;

  CREATE TABLE IF NOT EXISTS cached_messages (
    device_id TEXT NOT NULL,
    chat_jid TEXT NOT NULL,
    id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    sender_jid TEXT NOT NULL DEFAULT '',
    sender_display_name TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    timestamp TEXT NOT NULL DEFAULT '',
    timestamp_ms INTEGER NOT NULL DEFAULT 0,
    is_from_me INTEGER NOT NULL DEFAULT 0,
    media_type TEXT NOT NULL DEFAULT '',
    reactions_json TEXT NOT NULL DEFAULT '[]',
    context_metadata TEXT NOT NULL DEFAULT '',
    filename TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    file_length INTEGER NOT NULL DEFAULT 0,
    is_revoked INTEGER NOT NULL DEFAULT 0,
    revoked_at TEXT,
    revoked_by TEXT,
    is_unread_candidate INTEGER NOT NULL DEFAULT 0,
    cached_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (device_id, chat_jid, id)
  );

  CREATE INDEX IF NOT EXISTS idx_cached_messages_chat_ts
    ON cached_messages(device_id, chat_jid, timestamp_ms DESC);
  CREATE INDEX IF NOT EXISTS idx_cached_messages_device_id
    ON cached_messages(device_id, id);
  CREATE INDEX IF NOT EXISTS idx_cached_messages_seq
    ON cached_messages(seq DESC);
  CREATE INDEX IF NOT EXISTS idx_cached_messages_unread_active
    ON cached_messages(device_id, chat_jid, seq, cached_at)
    WHERE is_from_me = 0 AND is_revoked = 0 AND is_unread_candidate = 1;

  CREATE TABLE IF NOT EXISTS chat_sync_state (
    device_id TEXT NOT NULL,
    chat_jid TEXT NOT NULL,
    last_message_time TEXT NOT NULL DEFAULT '',
    last_message_ms INTEGER NOT NULL DEFAULT 0,
    needs_catchup INTEGER NOT NULL DEFAULT 0,
    catchup_prev_ms INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (device_id, chat_jid)
  );

  CREATE TABLE IF NOT EXISTS user_chat_read_states (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    chat_jid TEXT NOT NULL,
    last_read_seq INTEGER NOT NULL DEFAULT 0,
    last_read_at TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, device_id, chat_jid)
  );

  CREATE INDEX IF NOT EXISTS idx_user_chat_read_states_user
    ON user_chat_read_states(user_id, device_id, chat_jid);

  CREATE TABLE IF NOT EXISTS conversation_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    chat_jid TEXT NOT NULL,
    created_by_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_by_name TEXT NOT NULL,
    content TEXT NOT NULL,
    is_pinned INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_conversation_notes_chat
    ON conversation_notes(device_id, chat_jid, is_pinned DESC, updated_at DESC);

  CREATE TABLE IF NOT EXISTS roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    description TEXT NOT NULL DEFAULT '',
    is_system INTEGER NOT NULL DEFAULT 0,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS role_permissions (
    role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_key TEXT NOT NULL,
    PRIMARY KEY (role_id, permission_key)
  );

  CREATE TABLE IF NOT EXISTS user_device_access (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    PRIMARY KEY (user_id, device_id)
  );

  CREATE INDEX IF NOT EXISTS idx_user_device_access_user
    ON user_device_access(user_id);

  CREATE TABLE IF NOT EXISTS chat_assignments (
    device_id TEXT NOT NULL,
    chat_jid TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'open', 'closed')),
    assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    assigned_at TEXT,
    claimed_at TEXT,
    closed_by_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    closed_at TEXT,
    close_reason TEXT NOT NULL DEFAULT '',
    cached_title TEXT NOT NULL DEFAULT '',
    last_activity_ms INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (device_id, chat_jid)
  );

  CREATE INDEX IF NOT EXISTS idx_chat_assignments_status_owner
    ON chat_assignments(status, assigned_user_id, last_activity_ms DESC);
  CREATE INDEX IF NOT EXISTS idx_chat_assignments_status_device_activity
    ON chat_assignments(status, device_id, last_activity_ms DESC);

  CREATE TABLE IF NOT EXISTS chat_lifecycle_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    chat_jid TEXT NOT NULL,
    event_type TEXT NOT NULL,
    actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    actor_name TEXT NOT NULL DEFAULT '',
    target_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    target_name TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_chat_lifecycle_events_chat
    ON chat_lifecycle_events(device_id, chat_jid, id ASC);

  CREATE TABLE IF NOT EXISTS chat_device_states (
    device_id TEXT NOT NULL,
    chat_jid TEXT NOT NULL,
    is_pinned INTEGER NOT NULL DEFAULT 0,
    pinned_at_ms INTEGER NOT NULL DEFAULT 0,
    archived_override INTEGER,
    is_blocked INTEGER NOT NULL DEFAULT 0,
    blocked_at_ms INTEGER NOT NULL DEFAULT 0,
    cleared_before_ms INTEGER NOT NULL DEFAULT 0,
    deleted_before_ms INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (device_id, chat_jid)
  );

  CREATE INDEX IF NOT EXISTS idx_chat_device_states_pinned
    ON chat_device_states(device_id, is_pinned DESC, pinned_at_ms DESC);

  CREATE TABLE IF NOT EXISTS user_chat_preferences (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    chat_jid TEXT NOT NULL,
    is_favourite INTEGER NOT NULL DEFAULT 0,
    muted_until_ms INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, device_id, chat_jid)
  );

  CREATE INDEX IF NOT EXISTS idx_user_chat_prefs_user
    ON user_chat_preferences(user_id, is_favourite, muted_until_ms);

  CREATE TABLE IF NOT EXISTS chat_lists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (user_id, name COLLATE NOCASE)
  );

  CREATE INDEX IF NOT EXISTS idx_chat_lists_user
    ON chat_lists(user_id, id ASC);

  CREATE TABLE IF NOT EXISTS chat_list_items (
    list_id INTEGER NOT NULL REFERENCES chat_lists(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    chat_jid TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (list_id, device_id, chat_jid)
  );

  CREATE INDEX IF NOT EXISTS idx_chat_list_items_chat
    ON chat_list_items(device_id, chat_jid);
`);

{
  const cols = queryAll<{name: string}>('PRAGMA table_info(user_preferences)');
  if (!cols.some((c) => c.name === 'language')) {
    db.exec(
      "ALTER TABLE user_preferences ADD COLUMN language TEXT NOT NULL DEFAULT 'ar' CHECK(language IN ('ar', 'en'))",
    );
  }
}

{
  const syncCols = queryAll<{name: string}>('PRAGMA table_info(chat_sync_state)');
  if (!syncCols.some((c) => c.name === 'needs_catchup')) {
    db.exec('ALTER TABLE chat_sync_state ADD COLUMN needs_catchup INTEGER NOT NULL DEFAULT 0');
  }
  if (!syncCols.some((c) => c.name === 'catchup_prev_ms')) {
    db.exec('ALTER TABLE chat_sync_state ADD COLUMN catchup_prev_ms INTEGER NOT NULL DEFAULT 0');
  }
}

{
  const userCols = queryAll<{name: string}>('PRAGMA table_info(users)');
  if (!userCols.some((c) => c.name === 'role_id')) {
    db.exec('ALTER TABLE users ADD COLUMN role_id INTEGER REFERENCES roles(id)');
  }
}

{
  const readCols = queryAll<{name: string}>('PRAGMA table_info(user_chat_read_states)');
  if (!readCols.some((c) => c.name === 'manual_unread')) {
    db.exec('ALTER TABLE user_chat_read_states ADD COLUMN manual_unread INTEGER NOT NULL DEFAULT 0');
  }
}

export function seedAndMigrateRbac(): void {
  const sp = 'gowa_rbac_seed';
  db.exec(`SAVEPOINT ${sp}`);
  try {
    const selectBySlug = db.prepare('SELECT id FROM roles WHERE slug = ?');
    const insertRole = db.prepare(
      `INSERT INTO roles (slug, name, description, is_system, is_default)
       VALUES (?, ?, ?, 1, 0)`,
    );
    const updateSystemRole = db.prepare(
      `UPDATE roles
       SET description = ?, is_system = 1
       WHERE id = ?`,
    );
    const clearRolePerms = db.prepare('DELETE FROM role_permissions WHERE role_id = ?');
    const insertRolePerm = db.prepare(
      'INSERT OR IGNORE INTO role_permissions (role_id, permission_key) VALUES (?, ?)',
    );

    const roleIdsBySlug = new Map<string, number>();

    for (const def of SYSTEM_ROLE_DEFINITIONS) {
      let existing = selectBySlug.get(def.slug) as {id: number} | undefined;
      if (!existing) {
        const info = insertRole.run(def.slug, def.name, def.description);
        existing = {id: Number(info.lastInsertRowid)};
      } else {
        updateSystemRole.run(def.description, existing.id);
      }
      roleIdsBySlug.set(def.slug, existing.id);
      clearRolePerms.run(existing.id);
      for (const permKey of def.permissions) {
        insertRolePerm.run(existing.id, permKey);
      }
    }

    const defaultRow = queryOne<{count: number}>(
      'SELECT COUNT(*) AS count FROM roles WHERE is_default = 1',
    );
    if ((defaultRow?.count ?? 0) === 0) {
      const agentId = roleIdsBySlug.get('agent');
      if (agentId) {
        db.prepare('UPDATE roles SET is_default = 1 WHERE id = ?').run(agentId);
      }
    }

    const adminId = roleIdsBySlug.get('admin');
    const agentId = roleIdsBySlug.get('agent');
    if (adminId) {
      db.prepare("UPDATE users SET role_id = ? WHERE role = 'admin' AND role_id IS NULL").run(
        adminId,
      );
    }
    if (agentId) {
      db.prepare("UPDATE users SET role_id = ? WHERE role != 'admin' AND role_id IS NULL").run(
        agentId,
      );
    }

    db.exec(`RELEASE SAVEPOINT ${sp}`);
  } catch (err) {
    db.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
    db.exec(`RELEASE SAVEPOINT ${sp}`);
    throw err;
  }
}

seedAndMigrateRbac();

function scryptAsync(password: string, salt: string, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${derived}`;
}

export async function hashPasswordAsync(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = (await scryptAsync(password, salt, 64)).toString('hex');
  return `scrypt:${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hexKey] = parts;
  if (!salt || !hexKey) return false;
  try {
    const expected = Buffer.from(hexKey, 'hex');
    const actual = crypto.scryptSync(password, salt, expected.length);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export async function verifyPasswordAsync(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hexKey] = parts;
  if (!salt || !hexKey) return false;
  try {
    const expected = Buffer.from(hexKey, 'hex');
    const actual = await scryptAsync(password, salt, expected.length);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
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
  const tokenHash = hashToken(rawToken);
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
  const tokenHash = hashToken(rawToken);
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
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(rawToken));
}

export function getSetting(key: string): string | null {
  const row = queryOne<{value: string}>('SELECT value FROM settings WHERE key = ?', key);
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).run(key, value);
}

export function getGowaConfig(): GowaConfig {
  const url = (getSetting('gowa_url') ?? process.env.GOWA_URL ?? '').trim().replace(/\/+$/, '');
  const username = (getSetting('gowa_username') ?? process.env.GOWA_USERNAME ?? '').trim();
  const storedPassword = getSetting('gowa_password');
  let password = process.env.GOWA_PASSWORD ?? '';
  if (storedPassword !== null) {
    try {
      const decoded = decryptSettingSecret(storedPassword);
      password = decoded.value;
      if (decoded.wasPlaintext && decoded.value) {
        setSetting('gowa_password', encryptSettingSecret(decoded.value));
      }
    } catch (err) {
      console.error('[db] failed to decrypt gowa_password setting', err);
      password = '';
    }
  }
  return {url, username, password};
}

export function setGowaConfig(config: {url: string; username: string; password?: string}): void {
  setSetting('gowa_url', config.url.trim().replace(/\/+$/, ''));
  setSetting('gowa_username', config.username.trim());
  if (config.password !== undefined) {
    setSetting('gowa_password', config.password ? encryptSettingSecret(config.password) : '');
  }
}

export function getAccountAliases(): Record<string, string> {
  const raw = getSetting('account_aliases');
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string' && v.trim()) out[k] = v.trim();
    }
    return out;
  } catch {
    return {};
  }
}

export function setAccountAlias(deviceId: string, alias: string): Record<string, string> {
  const current = getAccountAliases();
  const clean = alias.trim();
  if (clean) {
    current[deviceId] = clean;
  } else {
    delete current[deviceId];
  }
  setSetting('account_aliases', JSON.stringify(current));
  return current;
}

export function listKnownDeviceIds(): string[] {
  const seen = new Set<string>();
  for (const id of Object.keys(getAccountAliases())) {
    const clean = id.trim();
    if (clean) seen.add(clean);
  }
  const rows = queryAll<{device_id: string}>(
    `SELECT DISTINCT device_id FROM user_device_access
     UNION
     SELECT DISTINCT device_id FROM chat_assignments
     UNION
     SELECT DISTINCT device_id FROM chat_sync_state`,
  );
  for (const row of rows) {
    const clean = row.device_id?.trim();
    if (clean) seen.add(clean);
  }
  return Array.from(seen).sort();
}

export interface CachedAvatarRow {
  device_id: string;
  jid: string;
  avatar_url: string;
  image_blob: Uint8Array | null;
  content_type: string;
  status: 'ok' | 'none';
  updated_at: number;
}

export function getCachedAvatar(deviceId: string, jid: string): CachedAvatarRow | null {
  return (
    queryOne<CachedAvatarRow>(
      'SELECT device_id, jid, avatar_url, image_blob, content_type, status, updated_at FROM contact_avatars WHERE device_id = ? AND jid = ?',
      deviceId,
      jid,
    ) ?? null
  );
}

export function upsertCachedAvatar(entry: {
  deviceId: string;
  jid: string;
  avatarUrl: string;
  imageBlob: Buffer | null;
  contentType: string;
  status: 'ok' | 'none';
}): void {
  db.prepare(
    `INSERT INTO contact_avatars (device_id, jid, avatar_url, image_blob, content_type, status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(device_id, jid) DO UPDATE SET
       avatar_url = excluded.avatar_url,
       image_blob = excluded.image_blob,
       content_type = excluded.content_type,
       status = excluded.status,
       updated_at = excluded.updated_at`,
  ).run(
    entry.deviceId,
    entry.jid,
    entry.avatarUrl,
    entry.imageBlob,
    entry.contentType,
    entry.status,
    Date.now(),
  );
}

// =========================================================================
// Cached Messages, Revocation Preservation & Per-User Isolated Unread Counts
// =========================================================================
export interface CachedReactionLike {
  emoji: string;
  sender_jid: string;
  sender_display_name?: string;
  is_from_me: boolean;
  timestamp: string;
}

const REMOTE_REACTION_GRACE_MS = 30_000;

interface StoredReactionChange {
  message_id: string;
  emoji: string;
  sender_jid: string;
  sender_display_name: string | null;
  is_from_me: number;
  timestamp_ms: number;
}

function reactionActor(reaction: {sender_jid: string; is_from_me: boolean | number}): string {
  if (reaction.is_from_me) return 'me';
  return reaction.sender_jid.toLowerCase().replace(/:\d+(?=@)/, '').replace(/@c\.us$/, '@s.whatsapp.net');
}

export function storeMessageReaction(
  deviceId: string,
  chatJid: string,
  messageId: string,
  reaction: CachedReactionLike,
): boolean {
  const actor = reactionActor(reaction);
  const timestampMs = parseTimestampMs(reaction.timestamp);
  const cachedReactions = getCachedMessage(deviceId, chatJid, messageId)?.reactions;
  if (cachedReactions?.some((cached) =>
    reactionActor(cached) === actor && parseTimestampMs(cached.timestamp) > timestampMs,
  )) return false;

  const update = db.prepare(
    `INSERT INTO message_reaction_changes
       (device_id, chat_jid, message_id, actor, emoji, sender_jid,
        sender_display_name, is_from_me, timestamp_ms, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (device_id, chat_jid, message_id, actor) DO UPDATE SET
       emoji = excluded.emoji, sender_jid = excluded.sender_jid,
       sender_display_name = excluded.sender_display_name, is_from_me = excluded.is_from_me,
       timestamp_ms = excluded.timestamp_ms, received_at = excluded.received_at
     WHERE excluded.timestamp_ms > message_reaction_changes.timestamp_ms
        OR (excluded.timestamp_ms = message_reaction_changes.timestamp_ms
            AND excluded.emoji <> message_reaction_changes.emoji)`,
  ).run(
    deviceId, chatJid, messageId, actor, reaction.emoji, reaction.sender_jid,
    reaction.sender_display_name ?? null, Number(reaction.is_from_me),
    timestampMs, Date.now(),
  );
  return Number(update.changes) > 0;
}

function mergeMessageReactions(
  snapshot: CachedReactionLike[] | undefined,
  changes: StoredReactionChange[],
): CachedReactionLike[] {
  const reactions = new Map((snapshot ?? []).filter((reaction) => reaction.emoji)
    .map((reaction) => [reactionActor(reaction), reaction]));
  for (const change of changes) {
    const actor = reactionActor(change);
    const upstream = reactions.get(actor);
    if (upstream && parseTimestampMs(upstream.timestamp) > change.timestamp_ms) continue;
    if (!change.emoji) {
      reactions.delete(actor);
      continue;
    }
    reactions.set(actor, {
      emoji: change.emoji,
      sender_jid: change.sender_jid,
      sender_display_name: change.sender_display_name ?? upstream?.sender_display_name,
      is_from_me: Boolean(change.is_from_me),
      timestamp: new Date(change.timestamp_ms).toISOString(),
    });
  }
  return [...reactions.values()];
}

export interface CachedMessagePayload {
  id: string;
  chat_jid: string;
  sender_jid: string;
  sender_display_name?: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  media_type: string;
  reactions?: CachedReactionLike[];
  context_metadata?: string;
  filename: string;
  url: string;
  file_length: number;
  is_revoked?: boolean;
  revoked_at?: string;
  revoked_by?: string;
}

interface CachedMessageRow {
  device_id: string;
  chat_jid: string;
  id: string;
  seq: number;
  sender_jid: string;
  sender_display_name: string;
  content: string;
  timestamp: string;
  timestamp_ms: number;
  is_from_me: number;
  media_type: string;
  reactions_json: string;
  context_metadata: string;
  filename: string;
  url: string;
  file_length: number;
  is_revoked: number;
  revoked_at: string | null;
  revoked_by: string | null;
  is_unread_candidate: number;
  cached_at: number;
  updated_at: number;
}

export function parseTimestampMs(iso: string | null | undefined): number {
  if (!iso) return 0;
  const trimmed = iso.trim();
  if (!trimmed) return 0;
  const hasSpaceSep = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(trimmed);
  const hasTz = /(?:[Zz]|[+-]\d{2}:?\d{2})$/.test(trimmed);
  const normalized = hasSpaceSep
    ? `${trimmed.replace(' ', 'T')}${hasTz ? '' : 'Z'}`
    : trimmed;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

function nextMessageSeq(): number {
  const row = queryOne<{max_seq: number | null}>('SELECT MAX(seq) AS max_seq FROM cached_messages');
  return (row?.max_seq ?? 0) + 1;
}

function rowToMessagePayload(row: CachedMessageRow): CachedMessagePayload {
  let reactions: CachedReactionLike[] | undefined;
  try {
    const parsed = JSON.parse(row.reactions_json) as CachedReactionLike[];
    if (Array.isArray(parsed) && parsed.length > 0) {
      reactions = parsed;
    }
  } catch {
    reactions = undefined;
  }
  return {
    id: row.id,
    chat_jid: row.chat_jid,
    sender_jid: row.sender_jid,
    sender_display_name: row.sender_display_name || undefined,
    content: row.content,
    timestamp: row.timestamp,
    is_from_me: row.is_from_me === 1,
    media_type: row.media_type,
    reactions,
    context_metadata: row.context_metadata || undefined,
    filename: row.filename,
    url: row.url,
    file_length: row.file_length,
    is_revoked: row.is_revoked === 1 ? true : undefined,
    revoked_at: row.revoked_at || undefined,
    revoked_by: row.revoked_by || undefined,
  };
}

const CACHED_MESSAGE_COLUMNS = `
  device_id, chat_jid, id, seq,
  sender_jid, sender_display_name, content, timestamp, timestamp_ms,
  is_from_me, media_type, reactions_json, context_metadata,
  filename, url, file_length,
  is_revoked, revoked_at, revoked_by,
  is_unread_candidate, cached_at, updated_at
`;

export function getCachedMessage(
  deviceId: string,
  chatJid: string,
  messageId: string,
): CachedMessagePayload | null {
  if (!deviceId || !chatJid || !messageId) return null;
  const row = queryOne<CachedMessageRow>(
    `SELECT ${CACHED_MESSAGE_COLUMNS} FROM cached_messages WHERE device_id = ? AND chat_jid = ? AND id = ?`,
    deviceId,
    chatJid,
    messageId,
  );
  return row ? rowToMessagePayload(row) : null;
}

export function upsertCachedMessages(
  deviceId: string,
  chatJid: string,
  messages: CachedMessagePayload[],
  options?: {
    markUnreadCandidate?: boolean;
    minUnreadTimestampMs?: number;
  },
): void {
  if (!deviceId || !chatJid || messages.length === 0) return;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  let seqCursor = nextMessageSeq();

  const selectStmt = db.prepare(
    `SELECT ${CACHED_MESSAGE_COLUMNS} FROM cached_messages WHERE device_id = ? AND chat_jid = ? AND id = ?`,
  );
  const upsertStmt = db.prepare(`
    INSERT INTO cached_messages (
      device_id, chat_jid, id, seq,
      sender_jid, sender_display_name, content, timestamp, timestamp_ms,
      is_from_me, media_type, reactions_json, context_metadata,
      filename, url, file_length,
      is_revoked, revoked_at, revoked_by,
      is_unread_candidate, cached_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(device_id, chat_jid, id) DO UPDATE SET
      sender_jid = excluded.sender_jid,
      sender_display_name = excluded.sender_display_name,
      content = excluded.content,
      timestamp = excluded.timestamp,
      timestamp_ms = excluded.timestamp_ms,
      is_from_me = excluded.is_from_me,
      media_type = excluded.media_type,
      reactions_json = excluded.reactions_json,
      context_metadata = excluded.context_metadata,
      filename = excluded.filename,
      url = excluded.url,
      file_length = excluded.file_length,
      is_revoked = excluded.is_revoked,
      revoked_at = excluded.revoked_at,
      revoked_by = excluded.revoked_by,
      is_unread_candidate = excluded.is_unread_candidate,
      updated_at = excluded.updated_at
  `);

  db.exec('BEGIN');
  try {
    for (const msg of messages) {
      if (!msg.id) continue;
      const existing = selectStmt.get(deviceId, chatJid, msg.id) as CachedMessageRow | undefined;

      const ts = msg.timestamp || existing?.timestamp || nowIso;
      const tsMs = parseTimestampMs(ts) || existing?.timestamp_ms || nowMs;
      const incomingMediaType = msg.media_type === 'revoked' ? '' : msg.media_type || '';
      const incomingRevoked =
        Boolean(msg.is_revoked) || msg.media_type === 'revoked';

      const existingHasPayload = Boolean(
        existing &&
          (existing.content.trim() ||
            existing.media_type.trim() ||
            existing.url.trim() ||
            existing.filename.trim()),
      );
      const incomingHasPayload = Boolean(
        msg.content?.trim() || incomingMediaType.trim() || msg.url?.trim() || msg.filename?.trim(),
      );

      // If a previously populated message suddenly returns completely empty from GOWA,
      // treat it as revoked while preserving original content/media.
      const disappearedContentRevoked = Boolean(existing && existingHasPayload && !incomingHasPayload);
      const finalIsRevoked =
        existing?.is_revoked === 1 || incomingRevoked || disappearedContentRevoked ? 1 : 0;

      const finalContent =
        msg.content?.trim() ? msg.content : existing?.content ?? msg.content ?? '';
      const finalMediaType =
        incomingMediaType.trim() ? incomingMediaType : existing?.media_type ?? '';
      const finalFilename = msg.filename?.trim() ? msg.filename : existing?.filename ?? '';
      const finalUrl = msg.url?.trim() ? msg.url : existing?.url ?? '';
      const finalFileLength =
        typeof msg.file_length === 'number' && msg.file_length > 0
          ? msg.file_length
          : existing?.file_length ?? 0;
      const finalContextMeta =
        msg.context_metadata?.trim() ? msg.context_metadata : existing?.context_metadata ?? '';
      const finalSenderDisplay =
        msg.sender_display_name?.trim()
          ? msg.sender_display_name
          : existing?.sender_display_name ?? '';
      const finalSenderJid = msg.sender_jid?.trim() ? msg.sender_jid : existing?.sender_jid ?? '';
      const finalReactionsJson =
        msg.reactions !== undefined
          ? JSON.stringify(msg.reactions)
          : existing?.reactions_json ?? '[]';
      const finalRevokedAt = finalIsRevoked
        ? existing?.revoked_at || msg.revoked_at || nowIso
        : null;
      const finalRevokedBy = finalIsRevoked
        ? existing?.revoked_by || msg.revoked_by || null
        : null;

      const isFromMe = msg.is_from_me ? 1 : existing?.is_from_me ?? 0;
      const qualifiesUnreadByTs =
        options?.minUnreadTimestampMs === undefined || tsMs > options.minUnreadTimestampMs;
      const shouldMarkUnread =
        !isFromMe &&
        !finalIsRevoked &&
        Boolean(options?.markUnreadCandidate) &&
        qualifiesUnreadByTs;
      const finalUnreadCandidate = existing?.is_unread_candidate === 1 || shouldMarkUnread ? 1 : 0;

      const seq = existing?.seq ?? seqCursor++;
      const cachedAt = existing?.cached_at ?? nowMs;

      upsertStmt.run(
        deviceId,
        chatJid,
        msg.id,
        seq,
        finalSenderJid,
        finalSenderDisplay,
        finalContent,
        ts,
        tsMs,
        isFromMe,
        finalMediaType,
        finalReactionsJson,
        finalContextMeta,
        finalFilename,
        finalUrl,
        finalFileLength,
        finalIsRevoked,
        finalRevokedAt,
        finalRevokedBy,
        finalUnreadCandidate,
        cachedAt,
        nowMs,
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function markCachedMessageRevoked(
  deviceId: string,
  messageId: string,
  opts?: {chatJid?: string; revokedBy?: string; revokedAt?: string},
): {updated: number; chatJids: string[]} {
  if (!deviceId || !messageId) return {updated: 0, chatJids: []};
  const nowMs = Date.now();
  const revokedAt = opts?.revokedAt || new Date(nowMs).toISOString();
  const revokedBy = opts?.revokedBy || null;

  const exactAffected = opts?.chatJid
    ? queryAll<{chat_jid: string}>(
        'SELECT chat_jid FROM cached_messages WHERE device_id = ? AND chat_jid = ? AND id = ?',
        deviceId,
        opts.chatJid,
        messageId,
      )
    : [];

  const useExactChat = exactAffected.length > 0 && Boolean(opts?.chatJid);
  const affected = useExactChat
    ? exactAffected
    : queryAll<{chat_jid: string}>(
        'SELECT chat_jid FROM cached_messages WHERE device_id = ? AND id = ?',
        deviceId,
        messageId,
      );

  if (affected.length > 0) {
    const info = useExactChat
      ? db
          .prepare(
            `UPDATE cached_messages
             SET is_revoked = 1,
                 revoked_at = COALESCE(revoked_at, ?),
                 revoked_by = COALESCE(revoked_by, ?),
                 updated_at = ?
             WHERE device_id = ? AND chat_jid = ? AND id = ?`,
          )
          .run(revokedAt, revokedBy, nowMs, deviceId, opts!.chatJid!, messageId)
      : db
          .prepare(
            `UPDATE cached_messages
             SET is_revoked = 1,
                 revoked_at = COALESCE(revoked_at, ?),
                 revoked_by = COALESCE(revoked_by, ?),
                 updated_at = ?
             WHERE device_id = ? AND id = ?`,
          )
          .run(revokedAt, revokedBy, nowMs, deviceId, messageId);
    return {
      updated: Number(info.changes),
      chatJids: Array.from(new Set(affected.map((a) => a.chat_jid))),
    };
  }

  if (opts?.chatJid) {
    upsertCachedMessages(deviceId, opts.chatJid, [
      {
        id: messageId,
        chat_jid: opts.chatJid,
        sender_jid: opts.revokedBy || '',
        content: '',
        timestamp: revokedAt,
        is_from_me: false,
        media_type: '',
        filename: '',
        url: '',
        file_length: 0,
        is_revoked: true,
        revoked_at: revokedAt,
        revoked_by: opts.revokedBy,
      },
    ]);
    return {updated: 1, chatJids: [opts.chatJid]};
  }

  return {updated: 0, chatJids: []};
}

export function syncAndMergeChatMessages(
  deviceId: string,
  chatJid: string,
  liveMessages: CachedMessagePayload[],
  opts: {offset: number; limit?: number; search?: string; mediaOnly?: boolean},
): {messages: CachedMessagePayload[]; injectedCount: number; rawCount: number} {
  const deviceState = getChatDeviceState(deviceId, chatJid);
  const clearedBeforeMs = deviceState?.cleared_before_ms ?? 0;
  const effectiveLiveMessages =
    clearedBeforeMs > 0
      ? liveMessages.filter((m) => parseTimestampMs(m.timestamp) > clearedBeforeMs)
      : liveMessages;

  upsertCachedMessages(deviceId, chatJid, effectiveLiveMessages);

  const pageLimit = opts.limit ?? 40;
  const hasMoreOlderLivePages = liveMessages.length >= pageLimit;
  const liveIds = new Set(effectiveLiveMessages.map((m) => m.id));
  const timestamps = effectiveLiveMessages
    .map((m) => parseTimestampMs(m.timestamp))
    .filter((t) => t > 0);
  const minLiveTs = timestamps.length > 0 ? Math.min(...timestamps) : 0;
  const maxLiveTs = timestamps.length > 0 ? Math.max(...timestamps) : 0;

  // On the top page (offset === 0, unfiltered), any previously cached message that should
  // have appeared in this window (or anywhere when all live messages fit on page 0)
  // that disappeared from GOWA's response was deleted/revoked on WhatsApp.
  if (
    opts.offset === 0 &&
    !opts.search &&
    !opts.mediaOnly &&
    (minLiveTs > 0 || !hasMoreOlderLivePages)
  ) {
    const recentCached =
      hasMoreOlderLivePages && minLiveTs > 0
        ? queryAll<{id: string; is_revoked: number}>(
            `SELECT id, is_revoked FROM cached_messages
             WHERE device_id = ? AND chat_jid = ? AND timestamp_ms >= ? AND timestamp_ms > ?`,
            deviceId,
            chatJid,
            minLiveTs,
            clearedBeforeMs,
          )
        : queryAll<{id: string; is_revoked: number}>(
            `SELECT id, is_revoked FROM cached_messages
             WHERE device_id = ? AND chat_jid = ? AND timestamp_ms > ?`,
            deviceId,
            chatJid,
            clearedBeforeMs,
          );

    const nowIso = new Date().toISOString();
    const nowMs = Date.now();
    const markMissingStmt = db.prepare(
      `UPDATE cached_messages
       SET is_revoked = 1,
           revoked_at = COALESCE(revoked_at, ?),
           updated_at = ?
       WHERE device_id = ? AND chat_jid = ? AND id = ? AND is_revoked = 0`,
    );
    for (const row of recentCached) {
      if (!liveIds.has(row.id) && row.is_revoked === 0) {
        markMissingStmt.run(nowIso, nowMs, deviceId, chatJid, row.id);
      }
    }
  }

  // Enrich live messages with preserved cached data & is_revoked flag
  const cachedById = new Map<string, CachedMessageRow>();
  const reactionChangesById = new Map<string, StoredReactionChange[]>();
  if (effectiveLiveMessages.length > 0) {
    const ids = JSON.stringify([...liveIds]);
    const cachedPage = queryAll<CachedMessageRow>(
      `SELECT ${CACHED_MESSAGE_COLUMNS} FROM cached_messages
       WHERE device_id = ? AND chat_jid = ? AND timestamp_ms > ?
         AND id IN (SELECT value FROM json_each(?))`,
      deviceId,
      chatJid,
      clearedBeforeMs,
      ids,
    );
    for (const row of cachedPage) cachedById.set(row.id, row);
    const changes = queryAll<StoredReactionChange>(
      `SELECT message_id, emoji, sender_jid, sender_display_name, is_from_me, timestamp_ms
       FROM message_reaction_changes
       WHERE device_id = ? AND chat_jid = ?
         AND message_id IN (SELECT value FROM json_each(?))
         AND (is_from_me = 1 OR received_at >= ?)`,
      deviceId, chatJid, ids, Date.now() - REMOTE_REACTION_GRACE_MS,
    );
    for (const change of changes) {
      const existing = reactionChangesById.get(change.message_id);
      if (existing) existing.push(change);
      else reactionChangesById.set(change.message_id, [change]);
    }
  }

  const merged: CachedMessagePayload[] = effectiveLiveMessages.map((msg) => {
    const cached = cachedById.get(msg.id);
    if (!cached) return msg;
    const payload = rowToMessagePayload(cached);
    const reactionChanges = reactionChangesById.get(msg.id);
    return {
      ...msg,
      content: payload.content || msg.content,
      media_type: payload.media_type || msg.media_type,
      filename: payload.filename || msg.filename,
      url: payload.url || msg.url,
      file_length: payload.file_length || msg.file_length,
      context_metadata: payload.context_metadata || msg.context_metadata,
      sender_display_name: msg.sender_display_name || payload.sender_display_name,
      reactions: reactionChanges
        ? mergeMessageReactions(msg.reactions ?? payload.reactions, reactionChanges)
        : msg.reactions ?? payload.reactions,
      is_revoked: payload.is_revoked,
      revoked_at: payload.revoked_at,
      revoked_by: payload.revoked_by,
    };
  });

  // Inject locally preserved revoked messages that GOWA omitted from its list
  let injectedCount = 0;
  let missingRevokedRows: CachedMessageRow[] = [];
  if (opts.offset === 0 && !opts.search && !opts.mediaOnly) {
    missingRevokedRows =
      hasMoreOlderLivePages && minLiveTs > 0
        ? queryAll<CachedMessageRow>(
            `SELECT ${CACHED_MESSAGE_COLUMNS} FROM cached_messages
             WHERE device_id = ? AND chat_jid = ? AND is_revoked = 1 AND timestamp_ms >= ? AND timestamp_ms > ?`,
            deviceId,
            chatJid,
            minLiveTs,
            clearedBeforeMs,
          )
        : queryAll<CachedMessageRow>(
            `SELECT ${CACHED_MESSAGE_COLUMNS} FROM cached_messages
             WHERE device_id = ? AND chat_jid = ? AND is_revoked = 1 AND timestamp_ms > ?
             ORDER BY timestamp_ms DESC LIMIT 50`,
            deviceId,
            chatJid,
            clearedBeforeMs,
          );
  } else if (minLiveTs > 0 && maxLiveTs > 0) {
    missingRevokedRows = queryAll<CachedMessageRow>(
      `SELECT ${CACHED_MESSAGE_COLUMNS} FROM cached_messages
       WHERE device_id = ? AND chat_jid = ? AND is_revoked = 1
         AND timestamp_ms >= ? AND timestamp_ms <= ? AND timestamp_ms > ?`,
      deviceId,
      chatJid,
      minLiveTs,
      maxLiveTs,
      clearedBeforeMs,
    );
  }

  const normalizedSearch = opts.search?.trim().toLowerCase() || '';
  for (const row of missingRevokedRows) {
    if (liveIds.has(row.id)) continue;
    if (opts.mediaOnly && !row.media_type.trim()) continue;
    if (
      normalizedSearch &&
      !row.content.toLowerCase().includes(normalizedSearch) &&
      !row.filename.toLowerCase().includes(normalizedSearch)
    ) {
      continue;
    }
    merged.push(rowToMessagePayload(row));
    injectedCount += 1;
  }

  merged.sort((a, b) => parseTimestampMs(b.timestamp) - parseTimestampMs(a.timestamp));
  return {messages: merged, injectedCount, rawCount: liveMessages.length};
}

export interface PendingCatchupChat {
  device_id: string;
  chat_jid: string;
  prev_last_message_ms: number;
  new_last_message_ms: number;
}

export function syncChatWatermarks(
  chats: Array<{device_id: string; chat_jid: string; last_message_time: string}>,
  options?: {newChatCatchupWindowMs?: number},
): PendingCatchupChat[] {
  if (chats.length === 0) return [];
  const nowMs = Date.now();
  const newChatWindowMs = options?.newChatCatchupWindowMs ?? 10 * 60_000;
  const baselineRow = queryOne<{has_rows: number}>(
    'SELECT EXISTS (SELECT 1 FROM chat_sync_state LIMIT 1) AS has_rows',
  );
  const hasBaselineSync = (baselineRow?.has_rows ?? 0) > 0;

  const selectSync = db.prepare(
    'SELECT last_message_ms, needs_catchup, catchup_prev_ms FROM chat_sync_state WHERE device_id = ? AND chat_jid = ?',
  );
  const selectLatestCached = db.prepare(
    'SELECT COALESCE(MAX(timestamp_ms), 0) AS max_ts FROM cached_messages WHERE device_id = ? AND chat_jid = ?',
  );
  const upsertSync = db.prepare(`
    INSERT INTO chat_sync_state (
      device_id, chat_jid, last_message_time, last_message_ms, needs_catchup, catchup_prev_ms, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(device_id, chat_jid) DO UPDATE SET
      last_message_time = excluded.last_message_time,
      last_message_ms = excluded.last_message_ms,
      needs_catchup = excluded.needs_catchup,
      catchup_prev_ms = excluded.catchup_prev_ms,
      updated_at = excluded.updated_at
  `);

  db.exec('BEGIN');
  try {
    for (const chat of chats) {
      const nextMs = parseTimestampMs(chat.last_message_time);
      if (nextMs <= 0) continue;
      const existing = selectSync.get(chat.device_id, chat.chat_jid) as
        | {last_message_ms: number; needs_catchup: number; catchup_prev_ms: number}
        | undefined;

      if (!existing) {
        const isRecentNewChat = hasBaselineSync && nextMs >= nowMs - newChatWindowMs;
        const latestCached = isRecentNewChat
          ? (selectLatestCached.get(chat.device_id, chat.chat_jid) as {max_ts: number})
          : null;
        const shouldCatchupNew =
          isRecentNewChat && (latestCached?.max_ts ?? 0) < nextMs - 1000;
        upsertSync.run(
          chat.device_id,
          chat.chat_jid,
          chat.last_message_time,
          nextMs,
          shouldCatchupNew ? 1 : 0,
          shouldCatchupNew ? Math.max(0, nextMs - 1) : 0,
          nowMs,
        );
        continue;
      }

      if (nextMs > existing.last_message_ms + 500) {
        const latestCached = selectLatestCached.get(chat.device_id, chat.chat_jid) as {
          max_ts: number;
        };
        const missingLatest = (latestCached?.max_ts ?? 0) < nextMs - 1000;
        const nextNeedsCatchup = missingLatest || existing.needs_catchup === 1 ? 1 : 0;
        const nextPrevMs =
          existing.needs_catchup === 1 && existing.catchup_prev_ms > 0
            ? existing.catchup_prev_ms
            : missingLatest
              ? existing.last_message_ms
              : 0;

        upsertSync.run(
          chat.device_id,
          chat.chat_jid,
          chat.last_message_time,
          nextMs,
          nextNeedsCatchup,
          nextPrevMs,
          nowMs,
        );
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return listPendingCatchupChats();
}

export function listPendingCatchupChats(limit = 10): PendingCatchupChat[] {
  const safeLimit = Math.max(1, Math.min(limit, 50));
  return queryAll<PendingCatchupChat>(
    `SELECT device_id,
            chat_jid,
            catchup_prev_ms AS prev_last_message_ms,
            last_message_ms AS new_last_message_ms
     FROM chat_sync_state
     WHERE needs_catchup = 1
     ORDER BY last_message_ms DESC
     LIMIT ?`,
    safeLimit,
  );
}

export function clearChatCatchup(deviceId: string, chatJid: string): void {
  db.prepare(
    `UPDATE chat_sync_state
     SET needs_catchup = 0, catchup_prev_ms = 0, updated_at = ?
     WHERE device_id = ? AND chat_jid = ?`,
  ).run(Date.now(), deviceId, chatJid);
}

export function getUnreadCountsForUser(
  user: Pick<PublicUser, 'id' | 'created_at'>,
  chats: Array<{device_id: string; chat_jid: string}>,
): Map<string, number> {
  const result = new Map<string, number>();
  if (chats.length === 0) return result;

  const uniqueDeviceIds = Array.from(new Set(chats.map((c) => c.device_id).filter(Boolean)));
  const uniqueChatJids = Array.from(new Set(chats.map((c) => c.chat_jid).filter(Boolean)));
  if (uniqueDeviceIds.length === 0 || uniqueChatJids.length === 0) return result;

  const userCreatedAtMs = parseTimestampMs(user.created_at);
  const devicePlaceholders = uniqueDeviceIds.map(() => '?').join(', ');
  const useJidFilter = uniqueChatJids.length <= 500;
  const jidClause = useJidFilter
    ? `AND m.chat_jid IN (${uniqueChatJids.map(() => '?').join(', ')})`
    : '';
  const queryParams: SQLInputValue[] = [
    user.id,
    ...uniqueDeviceIds,
    ...(useJidFilter ? uniqueChatJids : []),
    userCreatedAtMs,
    userCreatedAtMs,
  ];

  const rows = queryAll<{
    device_id: string;
    chat_jid: string;
    unread_count: number;
  }>(
    `SELECT m.device_id,
            m.chat_jid,
            COUNT(*) AS unread_count
     FROM cached_messages m
     LEFT JOIN user_chat_read_states r
       ON r.user_id = ?
      AND r.device_id = m.device_id
      AND r.chat_jid = m.chat_jid
     WHERE m.is_from_me = 0
       AND m.is_revoked = 0
       AND m.is_unread_candidate = 1
       AND m.device_id IN (${devicePlaceholders})
       ${jidClause}
       AND m.seq > COALESCE(r.last_read_seq, 0)
       AND (
         r.last_read_seq IS NOT NULL
         OR ? <= 0
         OR m.cached_at >= ?
       )
     GROUP BY m.device_id, m.chat_jid`,
    ...queryParams,
  );

  const requestedKeys = new Set(chats.map((c) => `${c.device_id}::${c.chat_jid}`));
  for (const row of rows) {
    const key = `${row.device_id}::${row.chat_jid}`;
    if (requestedKeys.has(key) && row.unread_count > 0) {
      result.set(key, Number(row.unread_count));
    }
  }

  const manualUnreadRows = queryAll<{device_id: string; chat_jid: string}>(
    `SELECT device_id, chat_jid
     FROM user_chat_read_states
     WHERE user_id = ?
       AND manual_unread = 1
       AND device_id IN (${devicePlaceholders})`,
    user.id,
    ...uniqueDeviceIds,
  );
  for (const row of manualUnreadRows) {
    const key = `${row.device_id}::${row.chat_jid}`;
    if (requestedKeys.has(key)) {
      result.set(key, Math.max(1, result.get(key) ?? 0));
    }
  }

  return result;
}

export function getGroupUnreadSummaryForUser(
  user: Pick<PublicUser, 'id' | 'created_at'>,
  deviceIds?: string[],
): {totalUnread: number; byKey: Map<string, number>} {
  const byKey = new Map<string, number>();
  const cleanDeviceIds = deviceIds
    ? Array.from(new Set(deviceIds.map((id) => id.trim()).filter(Boolean)))
    : null;
  if (cleanDeviceIds !== null && cleanDeviceIds.length === 0) {
    return {totalUnread: 0, byKey};
  }

  const userCreatedAtMs = parseTimestampMs(user.created_at);
  const deviceClause =
    cleanDeviceIds !== null
      ? `AND m.device_id IN (${cleanDeviceIds.map(() => '?').join(', ')})`
      : '';
  const queryParams: SQLInputValue[] = [
    user.id,
    ...(cleanDeviceIds ?? []),
    userCreatedAtMs,
    userCreatedAtMs,
  ];

  const rows = queryAll<{
    device_id: string;
    chat_jid: string;
    unread_count: number;
  }>(
    `SELECT m.device_id,
            m.chat_jid,
            COUNT(*) AS unread_count
     FROM cached_messages m
     LEFT JOIN user_chat_read_states r
       ON r.user_id = ?
      AND r.device_id = m.device_id
      AND r.chat_jid = m.chat_jid
     WHERE m.is_from_me = 0
       AND m.is_revoked = 0
       AND m.is_unread_candidate = 1
       AND LOWER(m.chat_jid) LIKE '%@g.us'
       ${deviceClause}
       AND m.seq > COALESCE(r.last_read_seq, 0)
       AND (
         r.last_read_seq IS NOT NULL
         OR ? <= 0
         OR m.cached_at >= ?
       )
     GROUP BY m.device_id, m.chat_jid`,
    ...queryParams,
  );

  let totalUnread = 0;
  for (const row of rows) {
    const count = Number(row.unread_count) || 0;
    if (count > 0) {
      byKey.set(`${row.device_id}::${row.chat_jid}`, count);
      totalUnread += count;
    }
  }

  return {totalUnread, byKey};
}

export function markChatReadForUser(userId: number, deviceId: string, chatJid: string): number {
  const globalMaxRow = queryOne<{max_seq: number | null}>(
    'SELECT MAX(seq) AS max_seq FROM cached_messages',
  );
  const targetSeq = Math.max(0, globalMaxRow?.max_seq ?? 0);
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  db.prepare(`
    INSERT INTO user_chat_read_states (user_id, device_id, chat_jid, last_read_seq, last_read_at, manual_unread, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, ?)
    ON CONFLICT(user_id, device_id, chat_jid) DO UPDATE SET
      last_read_seq = MAX(user_chat_read_states.last_read_seq, excluded.last_read_seq),
      last_read_at = excluded.last_read_at,
      manual_unread = 0,
      updated_at = excluded.updated_at
  `).run(userId, deviceId, chatJid, targetSeq, nowIso, nowMs);

  return targetSeq;
}

export function markChatUnreadForUser(userId: number, deviceId: string, chatJid: string): void {
  const nowMs = Date.now();
  db.prepare(`
    INSERT INTO user_chat_read_states (user_id, device_id, chat_jid, last_read_seq, last_read_at, manual_unread, updated_at)
    VALUES (?, ?, ?, 0, '', 1, ?)
    ON CONFLICT(user_id, device_id, chat_jid) DO UPDATE SET
      manual_unread = 1,
      updated_at = excluded.updated_at
  `).run(userId, deviceId, chatJid, nowMs);
}

// =========================================================================
// Conversation Notes
// =========================================================================
export interface ConversationNote {
  id: number;
  device_id: string;
  chat_jid: string;
  created_by_id: number;
  created_by_name: string;
  content: string;
  is_pinned: boolean;
  created_at: string;
  updated_at: string;
}

interface ConversationNoteRow {
  id: number;
  device_id: string;
  chat_jid: string;
  created_by_id: number;
  created_by_name: string;
  content: string;
  is_pinned: number;
  created_at: string;
  updated_at: string;
}

function toPublicNote(row: ConversationNoteRow): ConversationNote {
  return {
    id: row.id,
    device_id: row.device_id,
    chat_jid: row.chat_jid,
    created_by_id: row.created_by_id,
    created_by_name: row.created_by_name,
    content: row.content,
    is_pinned: row.is_pinned === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listConversationNotes(deviceId: string, chatJid: string): ConversationNote[] {
  const rows = queryAll<ConversationNoteRow>(
    `SELECT id, device_id, chat_jid, created_by_id, created_by_name, content, is_pinned, created_at, updated_at
     FROM conversation_notes
     WHERE device_id = ? AND chat_jid = ?
     ORDER BY is_pinned DESC, updated_at DESC, id DESC`,
    deviceId,
    chatJid,
  );
  return rows.map(toPublicNote);
}

export function getConversationNoteById(
  noteId: number,
  deviceId: string,
  chatJid: string,
): ConversationNote | null {
  const row = queryOne<ConversationNoteRow>(
    `SELECT id, device_id, chat_jid, created_by_id, created_by_name, content, is_pinned, created_at, updated_at
     FROM conversation_notes
     WHERE id = ? AND device_id = ? AND chat_jid = ?`,
    noteId,
    deviceId,
    chatJid,
  );
  return row ? toPublicNote(row) : null;
}

export function createConversationNote(input: {
  deviceId: string;
  chatJid: string;
  createdById: number;
  createdByName: string;
  content: string;
  isPinned?: boolean;
}): ConversationNote {
  const nowIso = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO conversation_notes (
         device_id, chat_jid, created_by_id, created_by_name, content, is_pinned, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.deviceId,
      input.chatJid,
      input.createdById,
      input.createdByName,
      input.content,
      input.isPinned ? 1 : 0,
      nowIso,
      nowIso,
    );
  const created = getConversationNoteById(Number(info.lastInsertRowid), input.deviceId, input.chatJid);
  if (!created) {
    throw new Error('Failed to load newly created conversation note');
  }
  return created;
}

export function updateConversationNote(
  noteId: number,
  deviceId: string,
  chatJid: string,
  patch: {content?: string; is_pinned?: boolean},
): ConversationNote | null {
  const existing = getConversationNoteById(noteId, deviceId, chatJid);
  if (!existing) return null;

  const nextContent = patch.content !== undefined ? patch.content : existing.content;
  const nextPinned = patch.is_pinned !== undefined ? (patch.is_pinned ? 1 : 0) : existing.is_pinned ? 1 : 0;
  const nextUpdatedAt = patch.content !== undefined ? new Date().toISOString() : existing.updated_at;

  db.prepare(
    `UPDATE conversation_notes
     SET content = ?, is_pinned = ?, updated_at = ?
     WHERE id = ? AND device_id = ? AND chat_jid = ?`,
  ).run(nextContent, nextPinned, nextUpdatedAt, noteId, deviceId, chatJid);

  return getConversationNoteById(noteId, deviceId, chatJid);
}

export function deleteConversationNote(
  noteId: number,
  deviceId: string,
  chatJid: string,
): boolean {
  const info = db
    .prepare('DELETE FROM conversation_notes WHERE id = ? AND device_id = ? AND chat_jid = ?')
    .run(noteId, deviceId, chatJid);
  return info.changes > 0;
}

const DEFAULT_AVATAR_RETENTION_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

export function cleanupExpiredRecords(options?: {
  nowMs?: number;
  avatarMaxAgeMs?: number;
}): {deletedSessions: number; deletedAvatars: number} {
  const nowMs = options?.nowMs ?? Date.now();
  const avatarMaxAgeMs = options?.avatarMaxAgeMs ?? DEFAULT_AVATAR_RETENTION_MS;
  db.prepare('DELETE FROM message_reaction_changes WHERE is_from_me = 0 AND received_at < ?')
    .run(nowMs - REMOTE_REACTION_GRACE_MS);
  const expiredSessions = db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowMs);
  const staleAvatars = db
    .prepare('DELETE FROM contact_avatars WHERE updated_at < ?')
    .run(nowMs - avatarMaxAgeMs);

  return {
    deletedSessions: Number(expiredSessions.changes),
    deletedAvatars: Number(staleAvatars.changes),
  };
}

export function closeDatabaseSafely(): void {
  try {
    if (!db.isOpen) return;
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {
      // Ignore checkpoint failure if already closing
    }
    db.close();
  } catch {
    // Already closed
  }
}

// =========================================================================
// Chat Row Menu: Device States, User Preferences (Mute/Favourites) & Lists
// =========================================================================

export interface ChatDeviceState {
  device_id: string;
  chat_jid: string;
  is_pinned: boolean;
  pinned_at_ms: number;
  archived_override: boolean | null;
  is_blocked: boolean;
  blocked_at_ms: number;
  cleared_before_ms: number;
  deleted_before_ms: number;
  updated_at: number;
}

interface ChatDeviceStateRow {
  device_id: string;
  chat_jid: string;
  is_pinned: number;
  pinned_at_ms: number;
  archived_override: number | null;
  is_blocked: number;
  blocked_at_ms: number;
  cleared_before_ms: number;
  deleted_before_ms: number;
  updated_at: number;
}

function hydrateChatDeviceState(row: ChatDeviceStateRow): ChatDeviceState {
  return {
    device_id: row.device_id,
    chat_jid: row.chat_jid,
    is_pinned: row.is_pinned === 1,
    pinned_at_ms: Number(row.pinned_at_ms) || 0,
    archived_override:
      row.archived_override === null || row.archived_override === undefined
        ? null
        : row.archived_override === 1,
    is_blocked: row.is_blocked === 1,
    blocked_at_ms: Number(row.blocked_at_ms) || 0,
    cleared_before_ms: Number(row.cleared_before_ms) || 0,
    deleted_before_ms: Number(row.deleted_before_ms) || 0,
    updated_at: Number(row.updated_at) || 0,
  };
}

export function getChatDeviceState(deviceId: string, chatJid: string): ChatDeviceState | null {
  const row = queryOne<ChatDeviceStateRow>(
    `SELECT device_id, chat_jid, is_pinned, pinned_at_ms, archived_override,
            is_blocked, blocked_at_ms, cleared_before_ms, deleted_before_ms, updated_at
     FROM chat_device_states
     WHERE device_id = ? AND chat_jid = ?`,
    deviceId,
    chatJid,
  );
  return row ? hydrateChatDeviceState(row) : null;
}

export function getChatDeviceStatesMap(deviceIds: string[]): Map<string, ChatDeviceState> {
  const out = new Map<string, ChatDeviceState>();
  const cleanIds = Array.from(new Set(deviceIds.map((d) => d.trim()).filter(Boolean)));
  if (cleanIds.length === 0) return out;

  const placeholders = cleanIds.map(() => '?').join(', ');
  const rows = queryAll<ChatDeviceStateRow>(
    `SELECT device_id, chat_jid, is_pinned, pinned_at_ms, archived_override,
            is_blocked, blocked_at_ms, cleared_before_ms, deleted_before_ms, updated_at
     FROM chat_device_states
     WHERE device_id IN (${placeholders})`,
    ...cleanIds,
  );
  for (const row of rows) {
    out.set(`${row.device_id}::${row.chat_jid}`, hydrateChatDeviceState(row));
  }
  return out;
}

export function isChatBlocked(deviceId: string, chatJid: string): boolean {
  const row = queryOne<{is_blocked: number}>(
    'SELECT is_blocked FROM chat_device_states WHERE device_id = ? AND chat_jid = ?',
    deviceId,
    chatJid,
  );
  return row?.is_blocked === 1;
}

export function setChatPinState(
  deviceId: string,
  chatJid: string,
  pinned: boolean,
  nowMs = Date.now(),
): ChatDeviceState {
  db.prepare(`
    INSERT INTO chat_device_states (device_id, chat_jid, is_pinned, pinned_at_ms, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(device_id, chat_jid) DO UPDATE SET
      is_pinned = excluded.is_pinned,
      pinned_at_ms = CASE WHEN excluded.is_pinned = 1 THEN excluded.pinned_at_ms ELSE 0 END,
      updated_at = excluded.updated_at
  `).run(deviceId, chatJid, pinned ? 1 : 0, pinned ? nowMs : 0, nowMs);
  return getChatDeviceState(deviceId, chatJid)!;
}

export function setChatArchiveOverride(
  deviceId: string,
  chatJid: string,
  archived: boolean,
  nowMs = Date.now(),
): ChatDeviceState {
  db.prepare(`
    INSERT INTO chat_device_states (device_id, chat_jid, archived_override, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(device_id, chat_jid) DO UPDATE SET
      archived_override = excluded.archived_override,
      updated_at = excluded.updated_at
  `).run(deviceId, chatJid, archived ? 1 : 0, nowMs);
  return getChatDeviceState(deviceId, chatJid)!;
}

export function setChatBlockedState(
  deviceId: string,
  chatJid: string,
  blocked: boolean,
  nowMs = Date.now(),
): ChatDeviceState {
  db.prepare(`
    INSERT INTO chat_device_states (device_id, chat_jid, is_blocked, blocked_at_ms, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(device_id, chat_jid) DO UPDATE SET
      is_blocked = excluded.is_blocked,
      blocked_at_ms = CASE WHEN excluded.is_blocked = 1 THEN excluded.blocked_at_ms ELSE 0 END,
      updated_at = excluded.updated_at
  `).run(deviceId, chatJid, blocked ? 1 : 0, blocked ? nowMs : 0, nowMs);
  return getChatDeviceState(deviceId, chatJid)!;
}

export function clearChatHistoryInDb(
  deviceId: string,
  chatJid: string,
  nowMs = Date.now(),
): {clearedBeforeMs: number; deletedMessages: number} {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      INSERT INTO chat_device_states (device_id, chat_jid, cleared_before_ms, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(device_id, chat_jid) DO UPDATE SET
        cleared_before_ms = MAX(chat_device_states.cleared_before_ms, excluded.cleared_before_ms),
        updated_at = excluded.updated_at
    `).run(deviceId, chatJid, nowMs, nowMs);

    const deleted = db
      .prepare('DELETE FROM cached_messages WHERE device_id = ? AND chat_jid = ?')
      .run(deviceId, chatJid);
    db.prepare('DELETE FROM message_reaction_changes WHERE device_id = ? AND chat_jid = ?')
      .run(deviceId, chatJid);

    db.prepare(
      `UPDATE user_chat_read_states
       SET manual_unread = 0, updated_at = ?
       WHERE device_id = ? AND chat_jid = ?`,
    ).run(nowMs, deviceId, chatJid);

    db.exec('COMMIT');
    return {
      clearedBeforeMs: nowMs,
      deletedMessages: Number(deleted.changes),
    };
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    throw err;
  }
}

export function deleteChatInDb(
  deviceId: string,
  chatJid: string,
  nowMs = Date.now(),
): {deletedBeforeMs: number} {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      INSERT INTO chat_device_states (
        device_id, chat_jid, is_pinned, pinned_at_ms, archived_override,
        cleared_before_ms, deleted_before_ms, updated_at
      )
      VALUES (?, ?, 0, 0, NULL, ?, ?, ?)
      ON CONFLICT(device_id, chat_jid) DO UPDATE SET
        is_pinned = 0,
        pinned_at_ms = 0,
        archived_override = NULL,
        cleared_before_ms = MAX(chat_device_states.cleared_before_ms, excluded.cleared_before_ms),
        deleted_before_ms = MAX(chat_device_states.deleted_before_ms, excluded.deleted_before_ms),
        updated_at = excluded.updated_at
    `).run(deviceId, chatJid, nowMs, nowMs, nowMs);

    db.prepare('DELETE FROM cached_messages WHERE device_id = ? AND chat_jid = ?').run(
      deviceId,
      chatJid,
    );
    db.prepare('DELETE FROM message_reaction_changes WHERE device_id = ? AND chat_jid = ?')
      .run(deviceId, chatJid);
    db.prepare('DELETE FROM chat_assignments WHERE device_id = ? AND chat_jid = ?').run(
      deviceId,
      chatJid,
    );
    db.prepare('DELETE FROM chat_lifecycle_events WHERE device_id = ? AND chat_jid = ?').run(
      deviceId,
      chatJid,
    );
    db.prepare('DELETE FROM chat_sync_state WHERE device_id = ? AND chat_jid = ?').run(
      deviceId,
      chatJid,
    );
    db.prepare('DELETE FROM user_chat_read_states WHERE device_id = ? AND chat_jid = ?').run(
      deviceId,
      chatJid,
    );
    db.prepare('DELETE FROM user_chat_preferences WHERE device_id = ? AND chat_jid = ?').run(
      deviceId,
      chatJid,
    );
    db.prepare('DELETE FROM chat_list_items WHERE device_id = ? AND chat_jid = ?').run(
      deviceId,
      chatJid,
    );

    db.exec('COMMIT');
    return {deletedBeforeMs: nowMs};
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    throw err;
  }
}

export interface UserChatPreference {
  is_favourite: boolean;
  muted_until_ms: number;
}

export type MuteDuration = '8h' | '1w' | 'always' | 'unmute';

export function computeMutedUntilMs(duration: MuteDuration, nowMs = Date.now()): number {
  if (duration === 'unmute') return 0;
  if (duration === 'always') return -1;
  if (duration === '8h') return nowMs + 8 * 60 * 60 * 1000;
  return nowMs + 7 * 24 * 60 * 60 * 1000;
}

export function normalizeActiveMutedUntil(rawMutedUntilMs: number, nowMs = Date.now()): number {
  if (rawMutedUntilMs === -1) return -1;
  if (rawMutedUntilMs > nowMs) return rawMutedUntilMs;
  return 0;
}

export function getUserChatPreferencesMap(
  userId: number,
  deviceIds: string[],
  nowMs = Date.now(),
): Map<string, UserChatPreference> {
  const out = new Map<string, UserChatPreference>();
  const cleanIds = Array.from(new Set(deviceIds.map((d) => d.trim()).filter(Boolean)));
  if (cleanIds.length === 0) return out;

  const placeholders = cleanIds.map(() => '?').join(', ');
  const rows = queryAll<{
    device_id: string;
    chat_jid: string;
    is_favourite: number;
    muted_until_ms: number;
  }>(
    `SELECT device_id, chat_jid, is_favourite, muted_until_ms
     FROM user_chat_preferences
     WHERE user_id = ? AND device_id IN (${placeholders})`,
    userId,
    ...cleanIds,
  );
  for (const row of rows) {
    out.set(`${row.device_id}::${row.chat_jid}`, {
      is_favourite: row.is_favourite === 1,
      muted_until_ms: normalizeActiveMutedUntil(Number(row.muted_until_ms) || 0, nowMs),
    });
  }
  return out;
}

export function getUserMutedChatKeys(userId: number, nowMs = Date.now()): string[] {
  const rows = queryAll<{device_id: string; chat_jid: string}>(
    `SELECT device_id, chat_jid
     FROM user_chat_preferences
     WHERE user_id = ? AND (muted_until_ms = -1 OR muted_until_ms > ?)`,
    userId,
    nowMs,
  );
  return rows.map((r) => `${r.device_id}::${r.chat_jid}`);
}

export function setUserChatMute(
  userId: number,
  deviceId: string,
  chatJid: string,
  duration: MuteDuration,
  nowMs = Date.now(),
): number {
  const mutedUntilMs = computeMutedUntilMs(duration, nowMs);
  db.prepare(`
    INSERT INTO user_chat_preferences (user_id, device_id, chat_jid, muted_until_ms, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, device_id, chat_jid) DO UPDATE SET
      muted_until_ms = excluded.muted_until_ms,
      updated_at = excluded.updated_at
  `).run(userId, deviceId, chatJid, mutedUntilMs, nowMs);
  return mutedUntilMs;
}

export function setUserChatFavourite(
  userId: number,
  deviceId: string,
  chatJid: string,
  favourite: boolean,
  nowMs = Date.now(),
): boolean {
  db.prepare(`
    INSERT INTO user_chat_preferences (user_id, device_id, chat_jid, is_favourite, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, device_id, chat_jid) DO UPDATE SET
      is_favourite = excluded.is_favourite,
      updated_at = excluded.updated_at
  `).run(userId, deviceId, chatJid, favourite ? 1 : 0, nowMs);
  return favourite;
}

export interface ChatListSummary {
  id: number;
  name: string;
  chat_count: number;
  created_at: string;
  updated_at: string;
}

export function listChatListsForUser(userId: number): ChatListSummary[] {
  return queryAll<ChatListSummary>(
    `SELECT l.id,
            l.name,
            COUNT(i.chat_jid) AS chat_count,
            l.created_at,
            l.updated_at
     FROM chat_lists l
     LEFT JOIN chat_list_items i ON i.list_id = l.id
     WHERE l.user_id = ?
     GROUP BY l.id
     ORDER BY l.id ASC`,
    userId,
  ).map((r) => ({
    ...r,
    chat_count: Number(r.chat_count) || 0,
  }));
}

export function createChatListForUser(userId: number, rawName: string): ChatListSummary {
  const name = rawName.trim();
  if (!name) {
    throw new GowaError(400, 'VALIDATION_ERROR', 'اسم القائمة مطلوب');
  }
  const existing = queryOne<{id: number}>(
    'SELECT id FROM chat_lists WHERE user_id = ? AND name = ? COLLATE NOCASE',
    userId,
    name,
  );
  if (existing) {
    throw new GowaError(409, 'DUPLICATE_LIST_NAME', 'توجد قائمة بهذا الاسم بالفعل');
  }
  const countRow = queryOne<{total: number}>(
    'SELECT COUNT(*) AS total FROM chat_lists WHERE user_id = ?',
    userId,
  );
  if ((countRow?.total ?? 0) >= 50) {
    throw new GowaError(400, 'LIST_LIMIT_REACHED', 'تم الوصول للحد الأقصى لعدد القوائم (50)');
  }

  const nowIso = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO chat_lists (user_id, name, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(userId, name, nowIso, nowIso);
  return {
    id: Number(info.lastInsertRowid),
    name,
    chat_count: 0,
    created_at: nowIso,
    updated_at: nowIso,
  };
}

export function deleteChatListForUser(userId: number, listId: number): boolean {
  const info = db
    .prepare('DELETE FROM chat_lists WHERE id = ? AND user_id = ?')
    .run(listId, userId);
  return info.changes > 0;
}

export function getUserChatListMemberships(
  userId: number,
  deviceIds: string[],
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const cleanIds = Array.from(new Set(deviceIds.map((d) => d.trim()).filter(Boolean)));
  if (cleanIds.length === 0) return out;

  const placeholders = cleanIds.map(() => '?').join(', ');
  const rows = queryAll<{list_id: number; device_id: string; chat_jid: string}>(
    `SELECT i.list_id, i.device_id, i.chat_jid
     FROM chat_list_items i
     INNER JOIN chat_lists l ON l.id = i.list_id
     WHERE l.user_id = ? AND i.device_id IN (${placeholders})
     ORDER BY i.list_id ASC`,
    userId,
    ...cleanIds,
  );
  for (const row of rows) {
    const key = `${row.device_id}::${row.chat_jid}`;
    const existing = out.get(key);
    if (existing) existing.push(row.list_id);
    else out.set(key, [row.list_id]);
  }
  return out;
}

export function setChatListMembership(
  userId: number,
  deviceId: string,
  chatJid: string,
  listIds: number[],
): number[] {
  const uniqueIds = Array.from(new Set(listIds.filter((id) => Number.isInteger(id) && id > 0)));
  const ownedRows = queryAll<{id: number}>('SELECT id FROM chat_lists WHERE user_id = ?', userId);
  const ownedSet = new Set(ownedRows.map((r) => r.id));

  for (const id of uniqueIds) {
    if (!ownedSet.has(id)) {
      throw new GowaError(404, 'LIST_NOT_FOUND', 'إحدى القوائم المحددة غير موجودة');
    }
  }

  const nowMs = Date.now();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `DELETE FROM chat_list_items
       WHERE device_id = ? AND chat_jid = ?
         AND list_id IN (SELECT id FROM chat_lists WHERE user_id = ?)`,
    ).run(deviceId, chatJid, userId);

    const insertStmt = db.prepare(
      `INSERT INTO chat_list_items (list_id, device_id, chat_jid, added_at)
       VALUES (?, ?, ?, ?)`,
    );
    for (const id of uniqueIds) {
      insertStmt.run(id, deviceId, chatJid, nowMs);
    }
    db.exec('COMMIT');
    return uniqueIds;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    throw err;
  }
}



