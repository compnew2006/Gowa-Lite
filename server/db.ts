import crypto from 'node:crypto';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';

export type UserRole = 'admin' | 'agent';
export type ThemePreference = 'light' | 'dark' | 'system';
export type LanguagePreference = 'ar' | 'en';

export interface PublicUser {
  id: number;
  username: string;
  display_name: string;
  role: UserRole;
  is_active: boolean;
  created_at: string;
  theme: ThemePreference;
  language: LanguagePreference;
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
  password_hash: string;
  is_active: number;
  created_at: string;
}

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

const dbPath =
  process.env.GOWA_LITE_DB_PATH?.trim() || path.resolve(process.cwd(), 'gowa-lite.db');

export const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

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
`);

{
  const cols = db.prepare('PRAGMA table_info(user_preferences)').all() as Array<{name: string}>;
  if (!cols.some((c) => c.name === 'language')) {
    db.exec(
      "ALTER TABLE user_preferences ADD COLUMN language TEXT NOT NULL DEFAULT 'ar' CHECK(language IN ('ar', 'en'))",
    );
  }
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
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

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function hasAnyUsers(): boolean {
  const row = db.prepare('SELECT COUNT(*) AS count FROM users').get() as {count: number};
  return row.count > 0;
}

export function countActiveAdmins(): number {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND is_active = 1")
    .get() as {count: number};
  return row.count;
}

function toPublicUser(
  row: UserRow,
  theme?: ThemePreference,
  language?: LanguagePreference,
): PublicUser {
  const prefs = theme && language ? {theme, language} : getUserPreferences(row.id);
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    role: row.role,
    is_active: row.is_active === 1,
    created_at: row.created_at,
    theme: theme ?? prefs.theme,
    language: language ?? prefs.language,
  };
}

export function getUserPreferences(userId: number): {
  theme: ThemePreference;
  language: LanguagePreference;
} {
  const row = db
    .prepare('SELECT theme, language FROM user_preferences WHERE user_id = ?')
    .get(userId) as {theme: ThemePreference; language: LanguagePreference} | undefined;
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
}

export function setUserTheme(userId: number, theme: ThemePreference): void {
  setUserPreferences(userId, {theme});
}

export function listUsers(): PublicUser[] {
  const rows = db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.role, u.password_hash, u.is_active, u.created_at,
              COALESCE(p.theme, 'system') AS theme,
              COALESCE(p.language, 'ar') AS language
       FROM users u
       LEFT JOIN user_preferences p ON p.user_id = u.id
       ORDER BY u.id ASC`,
    )
    .all() as unknown as Array<
    UserRow & {theme: ThemePreference; language: LanguagePreference}
  >;
  return rows.map((row) => toPublicUser(row, row.theme, row.language));
}

export function getUserById(id: number): PublicUser | null {
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.role, u.password_hash, u.is_active, u.created_at,
              COALESCE(p.theme, 'system') AS theme,
              COALESCE(p.language, 'ar') AS language
       FROM users u
       LEFT JOIN user_preferences p ON p.user_id = u.id
       WHERE u.id = ?`,
    )
    .get(id) as (UserRow & {theme: ThemePreference; language: LanguagePreference}) | undefined;
  return row ? toPublicUser(row, row.theme, row.language) : null;
}

export function createUser(input: {
  username: string;
  display_name: string;
  role: UserRole;
  password: string;
}): PublicUser {
  const passwordHash = hashPassword(input.password);
  const info = db
    .prepare(
      `INSERT INTO users (username, display_name, role, password_hash, is_active)
       VALUES (?, ?, ?, ?, 1)`,
    )
    .run(input.username.trim(), input.display_name.trim(), input.role, passwordHash);
  const userId = Number(info.lastInsertRowid);
  setUserTheme(userId, 'system');
  const created = getUserById(userId);
  if (!created) {
    throw new Error('Failed to load newly created user');
  }
  return created;
}

export function updateUser(
  id: number,
  patch: {
    display_name?: string;
    role?: UserRole;
    is_active?: boolean;
    password?: string;
  },
): PublicUser | null {
  const existing = db
    .prepare('SELECT id, username, display_name, role, password_hash, is_active, created_at FROM users WHERE id = ?')
    .get(id) as UserRow | undefined;
  if (!existing) return null;

  const nextDisplayName = patch.display_name?.trim() || existing.display_name;
  const nextRole = patch.role ?? existing.role;
  const nextActive = patch.is_active === undefined ? existing.is_active : patch.is_active ? 1 : 0;
  const nextPasswordHash = patch.password ? hashPassword(patch.password) : existing.password_hash;

  db.prepare(
    `UPDATE users
     SET display_name = ?, role = ?, is_active = ?, password_hash = ?
     WHERE id = ?`,
  ).run(nextDisplayName, nextRole, nextActive, nextPasswordHash, id);

  if (nextActive === 0) {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  }

  return getUserById(id);
}

export function deleteUser(id: number): boolean {
  const result = db.prepare('DELETE FROM users WHERE id = ?').run(id);
  return result.changes > 0;
}

export function authenticateUser(username: string, password: string): PublicUser | null {
  const row = db
    .prepare('SELECT id, username, display_name, role, password_hash, is_active, created_at FROM users WHERE username = ?')
    .get(username.trim()) as UserRow | undefined;
  if (!row || row.is_active !== 1) return null;
  if (!verifyPassword(password, row.password_hash)) return null;
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
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.role, u.password_hash, u.is_active, u.created_at,
              s.expires_at, COALESCE(p.theme, 'system') AS theme,
              COALESCE(p.language, 'ar') AS language
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN user_preferences p ON p.user_id = u.id
       WHERE s.token_hash = ?`,
    )
    .get(tokenHash) as
    | (UserRow & {expires_at: number; theme: ThemePreference; language: LanguagePreference})
    | undefined;

  if (!row) return null;
  if (row.expires_at <= now || row.is_active !== 1) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    return null;
  }
  return toPublicUser(row, row.theme, row.language);
}

export function deleteSession(rawToken: string): void {
  if (!rawToken) return;
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(rawToken));
}

export function getSetting(key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | {value: string}
    | undefined;
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
  const password = getSetting('gowa_password') ?? process.env.GOWA_PASSWORD ?? '';
  return {url, username, password};
}

export function setGowaConfig(config: {url: string; username: string; password?: string}): void {
  setSetting('gowa_url', config.url.trim().replace(/\/+$/, ''));
  setSetting('gowa_username', config.username.trim());
  if (config.password !== undefined) {
    setSetting('gowa_password', config.password);
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
  const row = db
    .prepare(
      'SELECT device_id, jid, avatar_url, image_blob, content_type, status, updated_at FROM contact_avatars WHERE device_id = ? AND jid = ?',
    )
    .get(deviceId, jid) as CachedAvatarRow | undefined;
  return row ?? null;
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

