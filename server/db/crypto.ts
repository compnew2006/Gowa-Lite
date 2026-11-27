import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {dbPath} from './connection.ts';

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

export function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
