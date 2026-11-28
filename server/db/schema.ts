import {SYSTEM_ROLE_DEFINITIONS} from '../rbac.ts';
import {db, queryAll, queryOne} from './connection.ts';

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

  CREATE TABLE IF NOT EXISTS chat_close_ratings (
    closed_event_id INTEGER PRIMARY KEY,
    device_id TEXT NOT NULL,
    chat_jid TEXT NOT NULL,
    rated_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    rated_user_name TEXT NOT NULL DEFAULT '',
    closed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    status TEXT NOT NULL CHECK(status IN ('queued', 'sending', 'pending', 'rated', 'expired', 'failed')),
    expires_at INTEGER NOT NULL,
    sent_at INTEGER,
    prompt_message_id TEXT,
    reply_message_id TEXT,
    score INTEGER CHECK(score BETWEEN 1 AND 5),
    rated_at TEXT
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_close_rating_pending_chat
    ON chat_close_ratings (device_id, chat_jid) WHERE status = 'pending';
  CREATE INDEX IF NOT EXISTS idx_close_rating_queued
    ON chat_close_ratings (closed_event_id) WHERE status = 'queued';
  CREATE INDEX IF NOT EXISTS idx_close_rating_pending_webhook
    ON chat_close_ratings (chat_jid, expires_at) WHERE status = 'pending';
  CREATE UNIQUE INDEX IF NOT EXISTS idx_close_rating_reply
    ON chat_close_ratings (device_id, chat_jid, reply_message_id) WHERE reply_message_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_close_rating_report
    ON chat_close_ratings (device_id, rated_at DESC) WHERE status = 'rated';

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

  CREATE TABLE IF NOT EXISTS device_daily_reset_settings (
    device_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    reset_hour INTEGER NOT NULL DEFAULT 2 CHECK(reset_hour BETWEEN 0 AND 23),
    timezone TEXT NOT NULL DEFAULT '',
    last_run_date TEXT NOT NULL DEFAULT '',
    last_run_at TEXT,
    last_reset_count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS call_auto_reject_logs (
    device_id TEXT NOT NULL,
    call_id TEXT NOT NULL,
    caller_jid TEXT NOT NULL,
    caller_name TEXT NOT NULL DEFAULT '',
    reject_status TEXT NOT NULL CHECK(reject_status IN ('pending', 'rejected', 'already_rejected', 'failed')),
    reply_status TEXT NOT NULL CHECK(reply_status IN ('pending', 'sent', 'failed', 'no_message', 'skipped')),
    reply_message TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (device_id, call_id)
  );

  CREATE INDEX IF NOT EXISTS idx_call_auto_reject_logs_device
    ON call_auto_reject_logs(device_id, created_at_ms DESC);

  CREATE TABLE IF NOT EXISTS schedule_ownership (
    schedule_id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL,
    created_by_user_id INTEGER NOT NULL,
    created_by_name TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_schedule_ownership_creator
    ON schedule_ownership(created_by_user_id);
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
  if (!syncCols.some((c) => c.name === 'has_messages')) {
    db.exec('ALTER TABLE chat_sync_state ADD COLUMN has_messages INTEGER');
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

{
  const ratingCols = queryAll<{name: string}>('PRAGMA table_info(chat_close_ratings)');
  if (!ratingCols.some((c) => c.name === 'rated_user_id')) {
    db.exec(
      'ALTER TABLE chat_close_ratings ADD COLUMN rated_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL',
    );
  }
  if (!ratingCols.some((c) => c.name === 'rated_user_name')) {
    db.exec("ALTER TABLE chat_close_ratings ADD COLUMN rated_user_name TEXT NOT NULL DEFAULT ''");
  }
  if (!ratingCols.some((c) => c.name === 'closed_by_user_id')) {
    db.exec(
      'ALTER TABLE chat_close_ratings ADD COLUMN closed_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL',
    );
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_close_rating_user_report
      ON chat_close_ratings (rated_user_id, rated_at DESC) WHERE status = 'rated';
    UPDATE chat_close_ratings
    SET rated_user_id = COALESCE(
          rated_user_id,
          (SELECT e.target_user_id FROM chat_lifecycle_events e WHERE e.id = chat_close_ratings.closed_event_id),
          (SELECT e.actor_user_id FROM chat_lifecycle_events e WHERE e.id = chat_close_ratings.closed_event_id)
        ),
        rated_user_name = CASE
          WHEN rated_user_name != '' THEN rated_user_name
          ELSE COALESCE(
            NULLIF((SELECT e.target_name FROM chat_lifecycle_events e WHERE e.id = chat_close_ratings.closed_event_id), ''),
            (SELECT e.actor_name FROM chat_lifecycle_events e WHERE e.id = chat_close_ratings.closed_event_id),
            ''
          )
        END,
        closed_by_user_id = COALESCE(
          closed_by_user_id,
          (SELECT e.actor_user_id FROM chat_lifecycle_events e WHERE e.id = chat_close_ratings.closed_event_id)
        )
    WHERE rated_user_id IS NULL AND rated_user_name = '';
  `);
}

{
  const seededRows = queryAll<{key: string}>(
    "SELECT key FROM settings WHERE key LIKE 'default_private_list_seeded:%'",
  );
  if (seededRows.length > 0) {
    for (const row of seededRows) {
      const userId = Number(row.key.slice('default_private_list_seeded:'.length));
      if (Number.isInteger(userId) && userId > 0) {
        db.prepare(
          "DELETE FROM chat_lists WHERE user_id = ? AND LOWER(name) IN ('الخاص', 'private')",
        ).run(userId);
      }
    }
    db.exec("DELETE FROM settings WHERE key LIKE 'default_private_list_seeded:%'");
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
