import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import {getGowaConfig, type GowaConfig} from './db.ts';
import {GowaError} from './errors.ts';

export {GowaError};

export interface GowaEnvelope<T> {
  code: string;
  message: string;
  results?: T;
}

export type GowaDeviceState = 'disconnected' | 'connecting' | 'connected' | 'logged_in';

export interface GowaDevice {
  id: string;
  phone_number?: string;
  display_name?: string;
  state: GowaDeviceState;
  jid?: string;
  created_at: string;
}

export interface GowaAppInfo {
  version: string;
  os: string;
  base_path: string;
  max_file_size: number;
  max_video_size: number;
  max_image_size: number;
  chatwoot_enabled?: boolean;
  scheduled_sends?: boolean;
}

export interface GowaChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  ephemeral_expiration: number;
  created_at: string;
  updated_at: string;
  archived: boolean;
}

export interface GowaReactionInfo {
  emoji: string;
  sender_jid: string;
  sender_display_name?: string;
  is_from_me: boolean;
  timestamp: string;
}

export interface GowaMessageInfo {
  id: string;
  chat_jid: string;
  sender_jid: string;
  sender_display_name?: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  media_type: string;
  reactions?: GowaReactionInfo[];
  context_metadata?: string;
  filename: string;
  url: string;
  file_length: number;
  is_revoked?: boolean;
  revoked_at?: string;
  revoked_by?: string;
}

export interface GowaPagination {
  limit: number;
  offset: number;
  total: number;
}

export interface GowaLoginQr {
  device_id: string;
  qr_link: string;
  qr_duration: number;
}

export interface GowaPairCode {
  device_id: string;
  pair_code: string;
}

export interface GowaDeviceStatus {
  device_id: string;
  is_connected: boolean;
  is_logged_in: boolean;
}

export interface GowaDownloadedMedia {
  message_id: string;
  media_type: string;
  filename: string;
  file_path: string;
  file_url?: string;
  file_size: number;
}

const BLOCKED_METADATA_HOSTS = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'metadata.azure.internal',
  '100.100.100.200',
  'fd00:ec2::254',
]);

function isMetadataOrLinkLocalHost(hostname: string): boolean {
  const clean = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!clean) return true;
  if (BLOCKED_METADATA_HOSTS.has(clean)) return true;
  const normalized = clean.startsWith('::ffff:') ? clean.slice(7) : clean;
  const family = net.isIP(normalized);
  if (family === 4) {
    const parts = normalized.split('.').map((n) => Number(n));
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) return true;
    const [a, b] = parts;
    if (a === 0 || (a === 169 && b === 254)) return true;
    return false;
  }
  if (family === 6) {
    if (normalized === '::') return true;
    if (
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb')
    ) {
      return true;
    }
  }
  return false;
}

export function validateGowaUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, '');
  if (!trimmed) {
    throw new GowaError(400, 'INVALID_GOWA_URL', 'عنوان خادم gowa مطلوب');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new GowaError(400, 'INVALID_GOWA_URL', 'صيغة عنوان خادم gowa غير صالحة');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new GowaError(400, 'INVALID_GOWA_URL', 'يجب أن يبدأ العنوان بـ http:// أو https://');
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isMetadataOrLinkLocalHost(hostname)) {
    throw new GowaError(400, 'INVALID_GOWA_URL', 'عنوان الخادم غير مسموح به');
  }
  if (process.env.BLOCK_PRIVATE_GOWA_URL === 'true') {
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal') ||
      (net.isIP(hostname) !== 0 && isPrivateIpAddress(hostname))
    ) {
      throw new GowaError(400, 'INVALID_GOWA_URL', 'لا يُسمح بعناوين الشبكة الداخلية في هذا الوضع');
    }
  }
  return trimmed;
}

function buildAuthHeader(config: GowaConfig): string | null {
  if (!config.username || !config.password) return null;
  const encoded = Buffer.from(`${config.username}:${config.password}`, 'utf8').toString('base64');
  return `Basic ${encoded}`;
}

export function resolveSafeGowaConfig(override?: Partial<GowaConfig>): GowaConfig {
  const base = getGowaConfig();
  const merged: GowaConfig = {
    url: override?.url !== undefined ? override.url.trim().replace(/\/+$/, '') : base.url,
    username: override?.username !== undefined ? override.username.trim() : base.username,
    password: override?.password !== undefined ? override.password : base.password,
  };
  if (!merged.url) {
    throw new GowaError(503, 'GOWA_NOT_CONFIGURED', 'لم يتم إعداد عنوان خادم gowa بعد');
  }
  merged.url = validateGowaUrl(merged.url);
  return merged;
}

const MAX_GOWA_JSON_BYTES = 16 * 1024 * 1024;
const MAX_GOWA_ASSET_BYTES = 64 * 1024 * 1024;

async function fetchGowaResponse(
  url: URL, init: RequestInit, timeoutMs: number, maxBytes: number, readErrorBody: boolean,
): Promise<{response: Response; buffer: Buffer}> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(url, {...init, signal});
    const body = response.body;
    if (!body || (!response.ok && !readErrorBody)) {
      if (body) void body.cancel().catch(() => {});
      return {response, buffer: Buffer.alloc(0)};
    }

    const tooLarge = () => new GowaError(502, 'GOWA_RESPONSE_TOO_LARGE', 'استجابة خادم gowa تتجاوز الحجم المسموح به');
    if (Number(response.headers.get('content-length')) > maxBytes) {
      void body.cancel().catch(() => {});
      throw tooLarge();
    }

    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) {
          void reader.cancel().catch(() => {});
          throw tooLarge();
        }
        chunks.push(value);
      }
      return {response, buffer: Buffer.concat(chunks, bytes)};
    } finally {
      reader.releaseLock();
    }
  } catch (err) {
    if (err instanceof GowaError) throw err;
    throw new GowaError(502, 'GOWA_UNREACHABLE', signal.aborted
      ? 'انتهت مهلة الاتصال بخادم gowa'
      : 'تعذر الوصول إلى خادم gowa');
  }
}

export async function gowaFetch<T>(
  routePath: string,
  options?: {
    method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    deviceId?: string;
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
    formData?: FormData;
    configOverride?: Partial<GowaConfig>;
    timeoutMs?: number;
  },
): Promise<T> {
  const config = resolveSafeGowaConfig(options?.configOverride);
  const url = new URL(`${config.url}${routePath.startsWith('/') ? routePath : `/${routePath}`}`);
  if (options?.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value !== undefined && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  const authHeader = buildAuthHeader(config);
  if (authHeader) {
    headers.Authorization = authHeader;
  }
  if (options?.deviceId) {
    headers['X-Device-Id'] = encodeURIComponent(options.deviceId);
  }
  let body: BodyInit | undefined;
  if (options?.formData !== undefined) {
    body = options.formData;
  } else if (options?.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  const {response, buffer} = await fetchGowaResponse(url, {method: options?.method ?? 'GET', headers, body},
    options?.timeoutMs ?? 15_000, MAX_GOWA_JSON_BYTES, true);
  const text = buffer.toString('utf8');
  let parsed: (Partial<GowaEnvelope<T>> & {title?: unknown; detail?: unknown}) | null = null;
  try {
    parsed = text
      ? (JSON.parse(text) as Partial<GowaEnvelope<T>> & {title?: unknown; detail?: unknown})
      : null;
  } catch {
    parsed = null;
  }

  if (response.status === 401) {
    throw new GowaError(
      502,
      parsed?.code || 'GOWA_UNAUTHORIZED',
      parsed?.message || 'بيانات دخول خادم gowa غير صحيحة',
    );
  }

  if (
    response.status === 504 ||
    (response.status >= 520 && response.status <= 524)
  ) {
    const cfReason =
      response.status === 522 || response.status === 524
        ? `تعذر اتصال Cloudflare بالخادم الأصلي لـ gowa (رمز ${response.status} — انتهت مهلة الاتصال بالخادم، تأكد من تشغيل خدمة gowa أو النفق)`
        : `تعذر الوصول إلى الخادم الأصلي لـ gowa عبر الوسيط (رمز ${response.status})`;
    throw new GowaError(502, 'GOWA_UNREACHABLE', cfReason);
  }

  if (!response.ok) {
    const fallbackDetail =
      typeof parsed?.title === 'string'
        ? parsed.title
        : typeof parsed?.detail === 'string'
          ? parsed.detail
          : `استجاب خادم gowa برمز خطأ ${response.status}`;
    throw new GowaError(
      response.status >= 400 && response.status < 500 ? response.status : 502,
      parsed?.code || 'GOWA_HTTP_ERROR',
      parsed?.message || fallbackDetail,
    );
  }

  if (!parsed || typeof parsed.code !== 'string') {
    throw new GowaError(
      502,
      'NOT_GOWA_SERVER',
      'الخادم المستهدف لم يُرجع استجابة متوافقة مع عقد gowa',
    );
  }

  return parsed.results as T;
}

export async function gowaFetchRaw(
  routePath: string,
  options?: {
    deviceId?: string;
    query?: Record<string, string | number | boolean | undefined>;
    timeoutMs?: number;
  },
): Promise<{contentType: string; buffer: Buffer; filename?: string}> {
  const config = resolveSafeGowaConfig();
  const url = new URL(`${config.url}${routePath.startsWith('/') ? routePath : `/${routePath}`}`);
  if (options?.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value !== undefined && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const headers: Record<string, string> = {};
  const authHeader = buildAuthHeader(config);
  if (authHeader) headers.Authorization = authHeader;
  if (options?.deviceId) {
    headers['X-Device-Id'] = encodeURIComponent(options.deviceId);
  }

  const {response, buffer} = await fetchGowaResponse(url, {headers, redirect: 'error'}, options?.timeoutMs ?? 15_000,
    MAX_GOWA_ASSET_BYTES, false);

  if (!response.ok) {
    throw new GowaError(
      response.status >= 400 && response.status < 500 ? response.status : 502,
      'GOWA_HTTP_ERROR',
      `استجاب خادم gowa برمز خطأ ${response.status}`,
    );
  }

  return {
    contentType: response.headers.get('content-type') || 'application/octet-stream',
    buffer,
    filename: pathFromUrl(url.pathname),
  };
}

export async function gowaFetchBinary(
  relativeOrAppPath: string,
  options?: {deviceId?: string},
): Promise<{contentType: string; buffer: Buffer; filename?: string}> {
  const config = resolveSafeGowaConfig();
  const raw = relativeOrAppPath.trim();
  if (!raw) {
    throw new GowaError(400, 'INVALID_ASSET_PATH', 'مسار الملف فارغ');
  }
  const baseUrl = new URL(config.url);
  let targetUrl: URL;
  if (/^https?:\/\//i.test(raw)) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new GowaError(400, 'INVALID_ASSET_PATH', 'رابط الملف غير صالح');
    }
    if (parsed.origin !== baseUrl.origin) {
      throw new GowaError(400, 'INVALID_ASSET_PATH', 'مسار الملف خارج نطاق خادم gowa');
    }
    targetUrl = parsed;
  } else {
    if (raw.startsWith('//') || raw.includes('..')) {
      throw new GowaError(400, 'INVALID_ASSET_PATH', 'مسار الملف غير صالح');
    }
    const normalized = raw.startsWith('/') ? raw : `/${raw}`;
    targetUrl = new URL(normalized, baseUrl);
    if (targetUrl.origin !== baseUrl.origin) {
      throw new GowaError(400, 'INVALID_ASSET_PATH', 'مسار الملف خارج نطاق خادم gowa');
    }
  }

  const headers: Record<string, string> = {};
  const authHeader = buildAuthHeader(config);
  if (authHeader) headers.Authorization = authHeader;
  if (options?.deviceId) headers['X-Device-Id'] = encodeURIComponent(options.deviceId);

  const {response, buffer} = await fetchGowaResponse(targetUrl, {headers, redirect: 'error'}, 20_000,
    MAX_GOWA_ASSET_BYTES, false);

  if (!response.ok) {
    throw new GowaError(response.status, 'GOWA_ASSET_ERROR', 'تعذر قراءة الملف من خادم gowa');
  }

  return {
    contentType: response.headers.get('content-type') || 'application/octet-stream',
    buffer,
    filename: pathFromUrl(targetUrl.pathname),
  };
}

function pathFromUrl(p: string): string | undefined {
  const idx = p.lastIndexOf('/');
  if (idx === -1) return undefined;
  const candidate = p.slice(idx + 1).split('?')[0];
  return candidate || undefined;
}

export async function probeGowa(override?: Partial<GowaConfig>): Promise<{
  ok: boolean;
  devicesCount: number;
  info?: GowaAppInfo;
  error?: string;
  code?: string;
}> {
  try {
    const devices = (await gowaFetch<GowaDevice[]>('/devices', {
      configOverride: override,
      timeoutMs: 8_000,
    })) ?? [];
    let info: GowaAppInfo | undefined;
    try {
      info = await gowaFetch<GowaAppInfo>('/app/info', {
        configOverride: override,
        timeoutMs: 6_000,
      });
    } catch {
      info = undefined;
    }
    return {ok: true, devicesCount: devices.length, info};
  } catch (err) {
    if (err instanceof GowaError) {
      return {ok: false, devicesCount: 0, error: err.message, code: err.code};
    }
    return {
      ok: false,
      devicesCount: 0,
      error: err instanceof Error ? err.message : 'خطأ غير متوقع',
      code: 'UNKNOWN',
    };
  }
}

export interface GowaAvatarInfo {
  url: string;
  id: string;
  type: string;
}

function isPrivateIpAddress(ip: string): boolean {
  const normalized = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  const family = net.isIP(normalized);
  if (family === 4) {
    const parts = normalized.split('.').map((n) => Number(n));
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) return true;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true;
    return false;
  }
  if (family === 6) {
    const lower = normalized.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
      return true; // link-local
    }
    if (lower.startsWith('ff')) return true; // multicast
    return false;
  }
  return true;
}

interface PinnedPublicTarget {
  url: URL;
  pinnedAddress?: {
    address: string;
    family: 4 | 6;
  };
}

async function assertPublicHttpUrl(rawUrl: string): Promise<PinnedPublicTarget> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new GowaError(400, 'INVALID_AVATAR_URL', 'رابط الصورة غير صالح');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new GowaError(400, 'INVALID_AVATAR_URL', 'بروتوكول رابط الصورة غير مسموح به');
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.local') || isMetadataOrLinkLocalHost(hostname)) {
    throw new GowaError(400, 'INVALID_AVATAR_URL', 'مضيف رابط الصورة غير مسموح به');
  }
  const ipFamily = net.isIP(hostname);
  if (ipFamily) {
    if (isPrivateIpAddress(hostname)) {
      throw new GowaError(400, 'INVALID_AVATAR_URL', 'عنوان الشبكة غير مسموح به');
    }
    return {
      url: parsed,
      pinnedAddress: {address: hostname, family: ipFamily as 4 | 6},
    };
  }
  const resolved = await dns.lookup(hostname, {all: true});
  if (resolved.length === 0 || resolved.some((entry) => isPrivateIpAddress(entry.address))) {
    throw new GowaError(400, 'INVALID_AVATAR_URL', 'عنوان الشبكة غير مسموح به');
  }
  const first = resolved[0];
  return {
    url: parsed,
    pinnedAddress: {
      address: first.address,
      family: (first.family === 6 ? 6 : 4) as 4 | 6,
    },
  };
}

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

function fetchPinnedUrlOnce(target: PinnedPublicTarget): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  buffer: Buffer;
}> {
  const {url, pinnedAddress} = target;
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;
  const hostname = url.hostname.replace(/^\[|\]$/g, '');

  return new Promise((resolve, reject) => {
    const req = transport.request(
      url,
      {
        method: 'GET',
        timeout: 8_000,
        servername: isHttps && !net.isIP(hostname) ? hostname : undefined,
        lookup: pinnedAddress
          ? ((_host, options, callback) => {
              if (options && typeof options === 'object' && 'all' in options && options.all) {
                (callback as (err: NodeJS.ErrnoException | null, addresses: Array<{address: string; family: number}>) => void)(
                  null,
                  [{address: pinnedAddress.address, family: pinnedAddress.family}],
                );
                return;
              }
              (callback as (err: NodeJS.ErrnoException | null, address: string, family: number) => void)(
                null,
                pinnedAddress.address,
                pinnedAddress.family,
              );
            }) as http.RequestOptions['lookup']
          : undefined,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const contentLength = Number(res.headers['content-length'] || 0);
        if (Number.isFinite(contentLength) && contentLength > MAX_AVATAR_BYTES) {
          res.resume();
          reject(new GowaError(502, 'AVATAR_TOO_LARGE', 'حجم الصورة يتجاوز الحد المسموح به'));
          return;
        }
        const chunks: Buffer[] = [];
        let receivedBytes = 0;
        res.on('data', (chunk: Buffer) => {
          receivedBytes += chunk.byteLength;
          if (receivedBytes > MAX_AVATAR_BYTES) {
            res.destroy();
            reject(new GowaError(502, 'AVATAR_TOO_LARGE', 'حجم الصورة يتجاوز الحد المسموح به'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          resolve({
            status,
            headers: res.headers,
            buffer: Buffer.concat(chunks),
          });
        });
        res.on('error', (err) => reject(err));
      },
    );

    req.on('timeout', () => {
      req.destroy(new GowaError(502, 'AVATAR_FETCH_FAILED', 'انتهت مهلة تحميل الصورة الشخصية'));
    });
    req.on('error', (err) => {
      if (err instanceof GowaError) {
        reject(err);
      } else {
        reject(new GowaError(502, 'AVATAR_FETCH_FAILED', 'تعذر تنزيل الصورة الشخصية'));
      }
    });
    req.end();
  });
}

export async function fetchPublicAvatarImage(
  rawUrl: string,
): Promise<{buffer: Buffer; contentType: string}> {
  let currentTarget = await assertPublicHttpUrl(rawUrl);
  let response: {
    status: number;
    headers: http.IncomingHttpHeaders;
    buffer: Buffer;
  } | null = null;

  for (let hop = 0; hop < 3; hop += 1) {
    const res = await fetchPinnedUrlOnce(currentTarget);
    if (res.status >= 300 && res.status < 400) {
      const locHeader = res.headers.location;
      const loc = Array.isArray(locHeader) ? locHeader[0] : locHeader;
      if (!loc) {
        throw new GowaError(502, 'AVATAR_FETCH_FAILED', 'تعذر تتبع رابط الصورة');
      }
      currentTarget = await assertPublicHttpUrl(new URL(loc, currentTarget.url).toString());
      continue;
    }
    response = res;
    break;
  }

  if (!response || response.status < 200 || response.status >= 300) {
    throw new GowaError(502, 'AVATAR_FETCH_FAILED', 'تعذر تنزيل الصورة الشخصية');
  }

  const rawType = response.headers['content-type'];
  const headerType = Array.isArray(rawType) ? rawType[0] : rawType;
  const contentType = (headerType || 'image/jpeg').split(';')[0].trim();
  if (!contentType.startsWith('image/')) {
    throw new GowaError(502, 'AVATAR_INVALID_TYPE', 'الاستجابة ليست صورة صالحة');
  }

  if (response.buffer.byteLength === 0 || response.buffer.byteLength > MAX_AVATAR_BYTES) {
    throw new GowaError(502, 'AVATAR_INVALID_SIZE', 'حجم الصورة غير صالح');
  }

  return {
    buffer: response.buffer,
    contentType,
  };
}

