import type {Zip} from 'fflate';
import type {MessageInfo} from '@/api/types';

export const DOWNLOADABLE_MEDIA_TYPES = new Set([
  'image',
  'video',
  'audio',
  'document',
  'sticker',
]);

const MIME_EXTENSIONS: Array<[string, string]> = [
  ['image/jpeg', '.jpg'],
  ['image/jpg', '.jpg'],
  ['image/pjpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
  ['image/avif', '.avif'],
  ['video/mp4', '.mp4'],
  ['video/x-f4v', '.mp4'],
  ['video/3gpp', '.3gp'],
  ['video/quicktime', '.mov'],
  ['video/webm', '.webm'],
  ['audio/ogg', '.ogg'],
  ['audio/mpeg', '.mp3'],
  ['audio/mp4', '.m4a'],
  ['audio/aac', '.aac'],
  ['audio/amr', '.amr'],
  ['application/pdf', '.pdf'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
  ['application/msword', '.doc'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
  ['application/vnd.ms-excel', '.xls'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', '.pptx'],
  ['application/vnd.ms-powerpoint', '.ppt'],
  ['application/zip', '.zip'],
  ['application/vnd.rar', '.rar'],
  ['application/x-rar-compressed', '.rar'],
  ['application/x-7z-compressed', '.7z'],
  ['application/json', '.json'],
  ['application/xml', '.xml'],
  ['text/xml', '.xml'],
  ['text/plain', '.txt'],
  ['text/csv', '.csv'],
];

const MEDIA_TYPE_FALLBACK_EXT: Record<string, string> = {
  image: '.jpg',
  sticker: '.webp',
  video: '.mp4',
  audio: '.ogg',
  document: '.bin',
};

// Go's mime.ExtensionsByType sorts extensions alphabetically and often returns
// non-canonical aliases like .jfif (image/jpeg) or .f4v (video/mp4) first.
const EXTENSION_ALIASES: Record<string, string> = {
  '.jfif': '.jpg',
  '.jpe': '.jpg',
  '.jif': '.jpg',
  '.pjp': '.jpg',
  '.pjpeg': '.jpg',
  '.f4v': '.mp4',
  '.f4p': '.mp4',
  '.mpg4': '.mp4',
  '.mpga': '.mp3',
  '.mpega': '.mp3',
  '.adts': '.aac',
  '.oga': '.ogg',
  '.qt': '.mov',
};

export function normalizeMediaExtension(
  ext: string,
  mediaType?: string,
  contentType?: string,
): string {
  const lower = ext.toLowerCase();
  const normalizedMime = (contentType || '').split(';')[0].trim().toLowerCase();
  const kind = (mediaType || '').trim().toLowerCase();

  if (kind === 'document') {
    if ((normalizedMime === 'image/jpeg' || normalizedMime === 'image/pjpeg') && EXTENSION_ALIASES[lower] === '.jpg') {
      return '.jpg';
    }
    if ((normalizedMime === 'video/mp4' || normalizedMime === 'video/x-f4v') && EXTENSION_ALIASES[lower] === '.mp4') {
      return '.mp4';
    }
    return lower;
  }

  return EXTENSION_ALIASES[lower] ?? lower;
}

export function isDownloadableMedia(
  message: Pick<MessageInfo, 'media_type' | 'is_revoked'>,
): boolean {
  if (message.is_revoked) return false;
  return DOWNLOADABLE_MEDIA_TYPES.has((message.media_type || '').trim().toLowerCase());
}

export function sanitizeFilenameSegment(raw: string): string {
  const leaf = raw.trim().split(/[/\\]/).pop() ?? '';
  // Strip Windows/POSIX reserved filename characters and control chars while keeping Unicode/Arabic intact
  const cleaned = leaf
    .replace(/[\u0000-\u001f<>:"|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return cleaned;
}

export function resolveMediaExtension(
  message: Pick<MessageInfo, 'media_type' | 'filename'>,
  contentType?: string,
  resolvedFilename?: string,
): string {
  const candidateName = sanitizeFilenameSegment(resolvedFilename || message.filename || '');
  const dotIdx = candidateName.lastIndexOf('.');
  if (dotIdx > 0 && dotIdx < candidateName.length - 1) {
    const ext = candidateName.slice(dotIdx);
    if (/^\.[a-zA-Z0-9]{1,10}$/.test(ext)) {
      return normalizeMediaExtension(ext, message.media_type, contentType);
    }
  }

  const normalizedMime = (contentType || '').split(';')[0].trim().toLowerCase();
  for (const [mimePrefix, ext] of MIME_EXTENSIONS) {
    if (normalizedMime.startsWith(mimePrefix)) return ext;
  }

  return MEDIA_TYPE_FALLBACK_EXT[(message.media_type || '').toLowerCase()] || '.bin';
}

export function normalizeDownloadedMime(contentType?: string): string {
  const normalized = (contentType || '').split(';')[0].trim().toLowerCase();
  if (normalized === 'video/x-f4v') return 'video/mp4';
  if (normalized === 'image/pjpeg') return 'image/jpeg';
  return normalized || 'application/octet-stream';
}

export function extractContactIdentifierForFilename(
  message: Pick<MessageInfo, 'chat_jid' | 'sender_jid'>,
): string {
  const rawChat = (message.chat_jid || '').trim();
  const sourceJid =
    rawChat && rawChat.toLowerCase() !== 'status@broadcast'
      ? rawChat
      : (message.sender_jid || '').trim();
  if (!sourceJid) return 'contact';
  const at = sourceJid.indexOf('@');
  const local = at === -1 ? sourceJid : sourceJid.slice(0, at);
  const colon = local.indexOf(':');
  const bare = (colon === -1 ? local : local.slice(0, colon)).replace(/^\+/, '');
  const safe = sanitizeFilenameSegment(bare).replace(/[^a-zA-Z0-9_-]/g, '');
  return safe || 'contact';
}

export function formatTimestampForFilename(timestamp?: string): string {
  const parsed = timestamp ? new Date(timestamp) : null;
  const date =
    parsed && !Number.isNaN(parsed.getTime()) && parsed.getTime() > 0 ? parsed : new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

export function resolveChatMediaFilename(
  message: Pick<MessageInfo, 'id' | 'chat_jid' | 'sender_jid' | 'timestamp' | 'media_type' | 'filename'>,
  contentType?: string,
  resolvedFilename?: string,
): string {
  const contact = extractContactIdentifierForFilename(message);
  const stamp = formatTimestampForFilename(message.timestamp);
  const ext = resolveMediaExtension(message, contentType, resolvedFilename);
  return `${contact}_${stamp}${ext}`;
}

export function resolveMediaFilename(
  message: Pick<MessageInfo, 'id' | 'media_type' | 'filename'>,
  contentType?: string,
  resolvedFilename?: string,
): string {
  const explicit = sanitizeFilenameSegment(resolvedFilename || message.filename || '');
  const ext = resolveMediaExtension(message, contentType, explicit);
  if (explicit) {
    const dotIdx = explicit.lastIndexOf('.');
    const hasExt =
      dotIdx > 0 && dotIdx < explicit.length - 1 && /^\.[a-zA-Z0-9]{1,10}$/.test(explicit.slice(dotIdx));
    if (hasExt) {
      const stem = explicit.slice(0, dotIdx);
      return `${stem}${ext}`;
    }
    return `${explicit}${ext}`;
  }
  const shortId = (message.id || 'media').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 8) || 'file';
  const kind = (message.media_type || 'file').toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'file';
  return `${kind}_${shortId}${ext}`;
}

export function buildUniqueEntryName(filename: string, usedNames: Set<string>): string {
  const clean = sanitizeFilenameSegment(filename) || 'file.bin';
  if (!usedNames.has(clean)) {
    usedNames.add(clean);
    return clean;
  }

  const dotIdx = clean.lastIndexOf('.');
  const hasExt = dotIdx > 0 && dotIdx < clean.length - 1;
  const stem = hasExt ? clean.slice(0, dotIdx) : clean;
  const ext = hasExt ? clean.slice(dotIdx) : '';

  for (let i = 2; ; i += 1) {
    const candidate = `${stem} (${i})${ext}`;
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      return candidate;
    }
  }
}

export function estimateTotalMediaBytes(
  messages: Array<Pick<MessageInfo, 'file_length'>>,
): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.file_length === 'number' && Number.isFinite(msg.file_length) && msg.file_length > 0) {
      total += msg.file_length;
    }
  }
  return total;
}

export function formatZipArchiveName(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  return `gowa-media_${stamp}.zip`;
}

/**
 * Incremental zero-compression (STORE) ZIP builder using fflate (lazy-loaded on demand).
 * Media attachments (JPEG, MP4, PDF, OGG, WebP) are already compressed, so STORE
 * avoids CPU overhead while streaming bytes immediately into final chunks.
 */
export class StreamingZipBuilder {
  private readonly usedNames = new Set<string>();
  private readonly chunks: ArrayBuffer[] = [];
  private readonly pendingEntries: Array<{name: string; data: Uint8Array}> = [];
  private readonly donePromise: Promise<Blob>;
  private readonly readyPromise: Promise<void>;
  private zip: Zip | null = null;
  private zipPassThroughCtor: (typeof import('fflate'))['ZipPassThrough'] | null = null;
  private finished = false;
  private aborted = false;
  private entryCount = 0;

  constructor() {
    let resolveDone!: (blob: Blob) => void;
    let rejectDone!: (err: unknown) => void;
    this.donePromise = new Promise<Blob>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });

    this.readyPromise = import('fflate')
      .then((fflate) => {
        if (this.aborted) return;
        this.zipPassThroughCtor = fflate.ZipPassThrough;
        this.zip = new fflate.Zip((err, chunk, final) => {
          if (err) {
            rejectDone(err);
            return;
          }
          if (chunk.byteLength > 0) {
            const copy = new Uint8Array(chunk.byteLength);
            copy.set(chunk);
            this.chunks.push(copy.buffer);
          }
          if (final) {
            resolveDone(new Blob(this.chunks, {type: 'application/zip'}));
          }
        });
        for (const pending of this.pendingEntries) {
          const entry = new fflate.ZipPassThrough(pending.name);
          this.zip.add(entry);
          entry.push(pending.data, true);
        }
        this.pendingEntries.length = 0;
      })
      .catch((err) => {
        rejectDone(err);
      });
  }

  get count(): number {
    return this.entryCount;
  }

  add(rawFilename: string, data: Uint8Array): string {
    if (this.finished) {
      throw new Error('ZIP archive already finalized');
    }
    const entryName = buildUniqueEntryName(rawFilename, this.usedNames);
    if (this.zip && this.zipPassThroughCtor) {
      const entry = new this.zipPassThroughCtor(entryName);
      this.zip.add(entry);
      entry.push(data, true);
    } else {
      this.pendingEntries.push({name: entryName, data});
    }
    this.entryCount += 1;
    return entryName;
  }

  async finalize(): Promise<Blob> {
    await this.readyPromise;
    if (!this.finished) {
      this.finished = true;
      this.zip?.end();
    }
    return this.donePromise;
  }

  abort(): void {
    this.aborted = true;
    this.finished = true;
    this.pendingEntries.length = 0;
    this.chunks.length = 0;
    this.zip?.terminate();
  }
}

export function saveBlobSafely(blob: Blob, filename: string, revokeDelayMs = 5_000): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.setTimeout(() => URL.revokeObjectURL(url), revokeDelayMs);
}

export function computeRangeSelection(
  orderedIds: string[],
  currentSelected: Set<string>,
  anchorId: string | null,
  targetId: string,
  shiftKey: boolean,
): Set<string> {
  const next = new Set(currentSelected);
  if (shiftKey && anchorId) {
    const startIdx = orderedIds.indexOf(anchorId);
    const endIdx = orderedIds.indexOf(targetId);
    if (startIdx !== -1 && endIdx !== -1) {
      const [from, to] = startIdx <= endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
      for (let i = from; i <= to; i += 1) {
        next.add(orderedIds[i]);
      }
      return next;
    }
  }
  if (next.has(targetId)) {
    next.delete(targetId);
  } else {
    next.add(targetId);
  }
  return next;
}
