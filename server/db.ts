import crypto from 'node:crypto';
import path from 'node:path';
import {DatabaseSync, type SQLInputValue} from 'node:sqlite';

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

function queryAll<T>(sql: string, ...params: SQLInputValue[]): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

function queryOne<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
  return db.prepare(sql).get(...params) as unknown as T | undefined;
}

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
    "SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND is_active = 1",
  );
  return row?.count ?? 0;
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
}

export function setUserTheme(userId: number, theme: ThemePreference): void {
  setUserPreferences(userId, {theme});
}

type UserWithPrefsRow = UserRow & {theme: ThemePreference; language: LanguagePreference};

export function listUsers(): PublicUser[] {
  const rows = queryAll<UserWithPrefsRow>(
    `SELECT u.id, u.username, u.display_name, u.role, u.password_hash, u.is_active, u.created_at,
            COALESCE(p.theme, 'system') AS theme,
            COALESCE(p.language, 'ar') AS language
     FROM users u
     LEFT JOIN user_preferences p ON p.user_id = u.id
     ORDER BY u.id ASC`,
  );
  return rows.map((row) => toPublicUser(row, row.theme, row.language));
}

export function getUserById(id: number): PublicUser | null {
  const row = queryOne<UserWithPrefsRow>(
    `SELECT u.id, u.username, u.display_name, u.role, u.password_hash, u.is_active, u.created_at,
            COALESCE(p.theme, 'system') AS theme,
            COALESCE(p.language, 'ar') AS language
     FROM users u
     LEFT JOIN user_preferences p ON p.user_id = u.id
     WHERE u.id = ?`,
    id,
  );
  return row ? toPublicUser(row, row.theme, row.language) : null;
}

export function createUser(input: {
  username: string;
  display_name: string;
  role: UserRole;
  password: string;
  passwordHashOverride?: string;
}): PublicUser {
  const passwordHash = input.passwordHashOverride ?? hashPassword(input.password);
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

export async function createUserAsync(input: {
  username: string;
  display_name: string;
  role: UserRole;
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
    is_active?: boolean;
    password?: string;
    passwordHashOverride?: string;
  },
): PublicUser | null {
  const existing = queryOne<UserRow>(
    'SELECT id, username, display_name, role, password_hash, is_active, created_at FROM users WHERE id = ?',
    id,
  );
  if (!existing) return null;

  const nextDisplayName = patch.display_name?.trim() || existing.display_name;
  const nextRole = patch.role ?? existing.role;
  const nextActive = patch.is_active === undefined ? existing.is_active : patch.is_active ? 1 : 0;
  const nextPasswordHash = patch.passwordHashOverride
    ? patch.passwordHashOverride
    : patch.password
      ? hashPassword(patch.password)
      : existing.password_hash;

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

export async function updateUserAsync(
  id: number,
  patch: {
    display_name?: string;
    role?: UserRole;
    is_active?: boolean;
    password?: string;
  },
): Promise<PublicUser | null> {
  const passwordHashOverride = patch.password ? await hashPasswordAsync(patch.password) : undefined;
  return updateUser(id, {...patch, passwordHashOverride});
}

export function deleteUser(id: number): boolean {
  const result = db.prepare('DELETE FROM users WHERE id = ?').run(id);
  return result.changes > 0;
}

export function authenticateUser(username: string, password: string): PublicUser | null {
  const row = queryOne<UserRow>(
    'SELECT id, username, display_name, role, password_hash, is_active, created_at FROM users WHERE username = ?',
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
  const row = queryOne<UserRow>(
    'SELECT id, username, display_name, role, password_hash, is_active, created_at FROM users WHERE username = ?',
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
  const row = queryOne<UserWithPrefsRow & {expires_at: number}>(
    `SELECT u.id, u.username, u.display_name, u.role, u.password_hash, u.is_active, u.created_at,
            s.expires_at, COALESCE(p.theme, 'system') AS theme,
            COALESCE(p.language, 'ar') AS language
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN user_preferences p ON p.user_id = u.id
     WHERE s.token_hash = ?`,
    tokenHash,
  );

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
  const row = queryOne<{max_seq: number}>('SELECT COALESCE(MAX(seq), 0) AS max_seq FROM cached_messages');
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
    'SELECT * FROM cached_messages WHERE device_id = ? AND chat_jid = ? AND id = ?',
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

  const affected = opts?.chatJid
    ? queryAll<{chat_jid: string}>(
        'SELECT chat_jid FROM cached_messages WHERE device_id = ? AND chat_jid = ? AND id = ?',
        deviceId,
        opts.chatJid,
        messageId,
      )
    : queryAll<{chat_jid: string}>(
        'SELECT chat_jid FROM cached_messages WHERE device_id = ? AND id = ?',
        deviceId,
        messageId,
      );

  if (affected.length > 0) {
    const info = opts?.chatJid
      ? db
          .prepare(
            `UPDATE cached_messages
             SET is_revoked = 1,
                 revoked_at = COALESCE(revoked_at, ?),
                 revoked_by = COALESCE(revoked_by, ?),
                 updated_at = ?
             WHERE device_id = ? AND chat_jid = ? AND id = ?`,
          )
          .run(revokedAt, revokedBy, nowMs, deviceId, opts.chatJid, messageId)
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
  upsertCachedMessages(deviceId, chatJid, liveMessages);

  const pageLimit = opts.limit ?? 40;
  const hasMoreOlderLivePages = liveMessages.length >= pageLimit;
  const liveIds = new Set(liveMessages.map((m) => m.id));
  const timestamps = liveMessages
    .map((m) => parseTimestampMs(m.timestamp))
    .filter((t) => t > 0);
  const minLiveTs = timestamps.length > 0 ? Math.min(...timestamps) : 0;
  const maxLiveTs = timestamps.length > 0 ? Math.max(...timestamps) : 0;

  // On the top page (offset === 0, unfiltered), any previously cached message that should
  // have appeared in this window (or anywhere when all live messages fit on page 0)
  // that disappeared from GOWA's response was deleted/revoked on WhatsApp.
  if (opts.offset === 0 && !opts.search && !opts.mediaOnly && (minLiveTs > 0 || !hasMoreOlderLivePages)) {
    const recentCached =
      hasMoreOlderLivePages && minLiveTs > 0
        ? queryAll<{id: string; is_revoked: number}>(
            `SELECT id, is_revoked FROM cached_messages
             WHERE device_id = ? AND chat_jid = ? AND timestamp_ms >= ?`,
            deviceId,
            chatJid,
            minLiveTs,
          )
        : queryAll<{id: string; is_revoked: number}>(
            `SELECT id, is_revoked FROM cached_messages
             WHERE device_id = ? AND chat_jid = ?`,
            deviceId,
            chatJid,
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
  if (liveMessages.length > 0) {
    const allForChat = queryAll<CachedMessageRow>(
      'SELECT * FROM cached_messages WHERE device_id = ? AND chat_jid = ?',
      deviceId,
      chatJid,
    );
    for (const row of allForChat) {
      cachedById.set(row.id, row);
    }
  }

  const merged: CachedMessagePayload[] = liveMessages.map((msg) => {
    const cached = cachedById.get(msg.id);
    if (!cached) return msg;
    const payload = rowToMessagePayload(cached);
    return {
      ...msg,
      content: payload.content || msg.content,
      media_type: payload.media_type || msg.media_type,
      filename: payload.filename || msg.filename,
      url: payload.url || msg.url,
      file_length: payload.file_length || msg.file_length,
      context_metadata: payload.context_metadata || msg.context_metadata,
      sender_display_name: msg.sender_display_name || payload.sender_display_name,
      reactions: msg.reactions ?? payload.reactions,
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
            `SELECT * FROM cached_messages
             WHERE device_id = ? AND chat_jid = ? AND is_revoked = 1 AND timestamp_ms >= ?`,
            deviceId,
            chatJid,
            minLiveTs,
          )
        : queryAll<CachedMessageRow>(
            `SELECT * FROM cached_messages
             WHERE device_id = ? AND chat_jid = ? AND is_revoked = 1
             ORDER BY timestamp_ms DESC LIMIT 50`,
            deviceId,
            chatJid,
          );
  } else if (minLiveTs > 0 && maxLiveTs > 0) {
    missingRevokedRows = queryAll<CachedMessageRow>(
      `SELECT * FROM cached_messages
       WHERE device_id = ? AND chat_jid = ? AND is_revoked = 1
         AND timestamp_ms >= ? AND timestamp_ms <= ?`,
      deviceId,
      chatJid,
      minLiveTs,
      maxLiveTs,
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
  const baselineRow = queryOne<{total: number}>('SELECT COUNT(*) AS total FROM chat_sync_state');
  const hasBaselineSync = (baselineRow?.total ?? 0) > 0;

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

  const userCreatedAtMs = parseTimestampMs(user.created_at);
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
       AND m.seq > COALESCE(r.last_read_seq, 0)
       AND (
         r.last_read_seq IS NOT NULL
         OR ? <= 0
         OR m.cached_at >= ?
       )
     GROUP BY m.device_id, m.chat_jid`,
    user.id,
    userCreatedAtMs,
    userCreatedAtMs,
  );

  const requestedKeys = new Set(chats.map((c) => `${c.device_id}::${c.chat_jid}`));
  for (const row of rows) {
    const key = `${row.device_id}::${row.chat_jid}`;
    if (requestedKeys.has(key) && row.unread_count > 0) {
      result.set(key, Number(row.unread_count));
    }
  }

  return result;
}

export function markChatReadForUser(userId: number, deviceId: string, chatJid: string): number {
  const maxRow = queryOne<{max_seq: number}>(
    'SELECT COALESCE(MAX(seq), 0) AS max_seq FROM cached_messages WHERE device_id = ? AND chat_jid = ?',
    deviceId,
    chatJid,
  );
  const globalMaxRow = queryOne<{max_seq: number}>(
    'SELECT COALESCE(MAX(seq), 0) AS max_seq FROM cached_messages',
  );
  const targetSeq = Math.max(maxRow?.max_seq ?? 0, globalMaxRow?.max_seq ?? 0);
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  db.prepare(`
    INSERT INTO user_chat_read_states (user_id, device_id, chat_jid, last_read_seq, last_read_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, device_id, chat_jid) DO UPDATE SET
      last_read_seq = MAX(user_chat_read_states.last_read_seq, excluded.last_read_seq),
      last_read_at = excluded.last_read_at,
      updated_at = excluded.updated_at
  `).run(userId, deviceId, chatJid, targetSeq, nowIso, nowMs);

  return targetSeq;
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


