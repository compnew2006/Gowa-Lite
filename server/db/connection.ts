import path from 'node:path';
import {DatabaseSync, type SQLInputValue} from 'node:sqlite';
import dotenv from 'dotenv';

dotenv.config({quiet: true});

export const dbPath =
  process.env.GOWA_LITE_DB_PATH?.trim() || path.resolve(process.cwd(), 'gowa-lite.db');

export const db = new DatabaseSync(dbPath);

export function queryAll<T extends object>(sql: string, ...params: SQLInputValue[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function queryOne<T extends object>(sql: string, ...params: SQLInputValue[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function withImmediateTransaction<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    throw err;
  }
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
