import {db, queryAll, queryOne} from './connection.ts';
import {decryptSettingSecret, encryptSettingSecret} from './crypto.ts';
import {REMOTE_REACTION_GRACE_MS} from './messages-repo.ts';

export interface GowaConfig {
  url: string;
  username: string;
  password: string;
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

export function deleteSetting(key: string): void {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

export function deleteCachedAvatars(deviceId: string, jid?: string): void {
  if (jid === undefined) {
    db.prepare('DELETE FROM contact_avatars WHERE device_id = ?').run(deviceId);
  } else {
    db.prepare('DELETE FROM contact_avatars WHERE device_id = ? AND jid = ?').run(deviceId, jid);
  }
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
