import {useEffect, useRef, useState} from 'react';
import {useQuery, useQueryClient} from '@tanstack/react-query';
import {
  Check,
  Download,
  ExternalLink,
  FileText,
  Film,
  Image as ImageIcon,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import {toast} from 'sonner';
import {fetchAuthorizedMediaBytes} from '@/api/client';
import type {MessageInfo} from '@/api/types';
import {Button} from '@/components/ui/button';
import {Dialog} from '@/components/ui/dialog';
import {formatBytes} from '@/lib/format';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';
import {
  getCachedMedia,
  getOrFetchCachedMedia,
  isMediaDecoded,
  markMediaDecoded,
  updateCachedMediaDimensions,
} from '@/lib/media-cache';
import {
  messageMediaQuery,
  normalizeDownloadedMime,
  resolveChatMediaFilename,
  saveBlobSafely,
} from '@/lib/media-download';
import {useAuthStore} from '@/stores/auth';

const IMAGE_EXTENSIONS = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;
const AUTO_MEDIA_MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_FRAME_CLASS = 'w-56 sm:w-64 max-w-full aspect-[4/3]';
const STICKER_FRAME_CLASS = 'size-32 max-w-full';
const VIDEO_FRAME_CLASS = 'w-64 max-w-full aspect-[4/3]';
const AUDIO_FRAME_CLASS = 'h-[54px] w-64 max-w-full';

function isImageAttachment(message: MessageInfo, resolvedFilename?: string): boolean {
  if (message.media_type === 'image' || message.media_type === 'sticker') return true;
  const name = resolvedFilename || message.filename;
  if (message.media_type === 'document' && name) {
    return IMAGE_EXTENSIONS.test(name);
  }
  return false;
}

function isLinkMessage(message: MessageInfo): boolean {
  return message.media_type === 'link' || message.media_type === 'url';
}

function normalizeHref(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^www\./i.test(trimmed)) return `https://${trimmed}`;
  return null;
}

function shouldAutoFetch(message: MessageInfo): boolean {
  if (isLinkMessage(message)) return false;
  if (isImageAttachment(message)) return true;
  if (message.media_type === 'audio' || message.media_type === 'video') {
    return !message.file_length || message.file_length <= AUTO_MEDIA_MAX_BYTES;
  }
  return false;
}

export function MessageMedia({message, deviceId}: {message: MessageInfo; deviceId: string}) {
  const {lang, t} = useI18n();
  const queryClient = useQueryClient();
  const authToken = useAuthStore((s) => s.token);
  const containerRef = useRef<HTMLDivElement>(null);
  const isLink = isLinkMessage(message);
  const linkHref = isLink ? normalizeHref(message.url || message.content) : null;
  const autoFetch = shouldAutoFetch(message);
  const messageKey = `${deviceId}::${message.chat_jid}::${message.id}`;
  const initialCached = autoFetch ? getCachedMedia(messageKey) : null;

  const [inView, setInView] = useState(!autoFetch || Boolean(initialCached));
  const [blobUrl, setBlobUrl] = useState<string | null>(() => initialCached?.objectUrl ?? null);
  const [blobContentType, setBlobContentType] = useState<string | undefined>(
    () => initialCached?.contentType,
  );
  const [blobError, setBlobError] = useState<string | null>(null);
  const [streamFallback, setStreamFallback] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(() =>
    Boolean(initialCached && isMediaDecoded(messageKey)),
  );
  const imgRef = useRef<HTMLImageElement>(null);

  const [directDownloading, setDirectDownloading] = useState(false);
  const [directDownloaded, setDirectDownloaded] = useState(false);
  const [directError, setDirectError] = useState<string | null>(null);
  const [resolvedFileSize, setResolvedFileSize] = useState<number | null>(null);
  const cachedDirectFileRef = useRef<{blob: Blob; filename: string} | null>(null);
  const activeMessageKeyRef = useRef(messageKey);
  activeMessageKeyRef.current = messageKey;

  useEffect(() => {
    const cached = autoFetch ? getCachedMedia(messageKey) : null;
    cachedDirectFileRef.current = null;
    setInView(!autoFetch || Boolean(cached));
    setBlobUrl(cached?.objectUrl ?? null);
    setBlobContentType(cached?.contentType);
    setBlobError(null);
    setStreamFallback(false);
    setImageLoaded(Boolean(cached && isMediaDecoded(messageKey)));
    setDirectDownloading(false);
    setDirectDownloaded(false);
    setDirectError(null);
    setResolvedFileSize(null);
  }, [autoFetch, messageKey]);

  useEffect(() => {
    if (!autoFetch || inView) return;
    const node = containerRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true);
          observer.disconnect();
        }
      },
      {rootMargin: '250px'},
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [autoFetch, inView]);

  const mediaQuery = messageMediaQuery(deviceId, message.chat_jid, message.id);
  const query = useQuery({...mediaQuery, enabled: autoFetch && inView});
  const resolvedPath = query.data?.proxy_url || '';
  const isImage = isImageAttachment(message, query.data?.filename);
  const isStreamable = !isImage && (message.media_type === 'video' || message.media_type === 'audio');
  // When running with cookie auth, stream video/audio directly so HTTP Range (206) starts playback immediately.
  // If Bearer token auth is required or direct tag playback errors, fetch and cache via authorized http client.
  const canStreamDirectly = isStreamable && Boolean(resolvedPath) && !authToken && !streamFallback;

  useEffect(() => {
    if (!autoFetch || !resolvedPath) return;
    const existing = getCachedMedia(messageKey);
    if (existing) {
      setBlobUrl(existing.objectUrl);
      setBlobContentType(existing.contentType);
      setBlobError(null);
      return;
    }
    if (canStreamDirectly) return;

    let active = true;
    setBlobError(null);

    void getOrFetchCachedMedia(messageKey, resolvedPath)
      .then((entry) => {
        if (!active) return;
        setBlobContentType(entry.contentType);
        setBlobUrl(entry.objectUrl);
      })
      .catch((err) => {
        if (active) {
          setBlobError(toApiError(err).message);
        }
      });

    return () => {
      active = false;
    };
  }, [autoFetch, canStreamDirectly, messageKey, resolvedPath]);

  const handleDirectDownload = async () => {
    if (directDownloading) return;
    setDirectError(null);

    if (cachedDirectFileRef.current) {
      saveBlobSafely(cachedDirectFileRef.current.blob, cachedDirectFileRef.current.filename);
      setDirectDownloaded(true);
      return;
    }

    const expectedKey = messageKey;
    setDirectDownloading(true);
    try {
      const resolved = await queryClient.fetchQuery(mediaQuery);
      if (!resolved?.proxy_url) throw new Error(t.chats.mediaUnavailable);
      const {bytes, contentType} = await fetchAuthorizedMediaBytes(resolved.proxy_url);
      const blob = new Blob([bytes], {type: normalizeDownloadedMime(contentType)});
      const downloadName = resolveChatMediaFilename(message, contentType, resolved.filename);

      saveBlobSafely(blob, downloadName);
      if (activeMessageKeyRef.current === expectedKey) {
        cachedDirectFileRef.current = {blob, filename: downloadName};
        setResolvedFileSize(resolved.file_size || bytes.byteLength);
        setDirectDownloaded(true);
      }
    } catch (err) {
      const msg = toApiError(err).message;
      if (activeMessageKeyRef.current === expectedKey) {
        setDirectError(msg);
      }
      toast.error(msg);
    } finally {
      if (activeMessageKeyRef.current === expectedKey) {
        setDirectDownloading(false);
      }
    }
  };

  const playbackSrc = blobUrl ?? (canStreamDirectly ? resolvedPath : null);
  const isSticker = message.media_type === 'sticker';
  const imageFrameClass = isSticker ? STICKER_FRAME_CLASS : IMAGE_FRAME_CLASS;

  useEffect(() => {
    const img = imgRef.current;
    if (!img || !playbackSrc || !img.complete || img.naturalWidth <= 0) return;
    updateCachedMediaDimensions(messageKey, {
      width: img.naturalWidth,
      height: img.naturalHeight,
    });
    markMediaDecoded(messageKey);
    setImageLoaded(true);
  }, [messageKey, playbackSrc]);

  const label =
    t.chats.mediaLabels[message.media_type] || message.media_type || t.chats.mediaLabels.file;

  if (isLink) {
    if (!linkHref) return null;
    return (
      <a
        href={linkHref}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => event.stopPropagation()}
        className="mt-2 flex w-full max-w-xs items-center gap-2.5 rounded-lg border border-black/10 bg-black/10 px-3 py-2 text-start transition-colors hover:bg-black/15 dark:border-white/10 dark:bg-black/25 dark:hover:bg-black/35"
      >
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
          <ExternalLink className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          {message.filename && (
            <p className="truncate text-xs font-medium text-foreground">{message.filename}</p>
          )}
          <p dir="ltr" className="truncate text-xs text-sky-600 underline dark:text-sky-400">
            {linkHref}
          </p>
        </div>
      </a>
    );
  }

  if (!autoFetch) {
    const displayedSize = resolvedFileSize || message.file_length;
    return (
      <div ref={containerRef} className="mt-2 w-full max-w-xs">
        <button
          type="button"
          disabled={directDownloading}
          onClick={() => void handleDirectDownload()}
          aria-busy={directDownloading}
          className="flex w-full cursor-pointer items-center gap-3 rounded-lg border border-black/10 bg-black/10 px-3 py-2.5 text-start transition-colors hover:bg-black/15 disabled:cursor-wait disabled:opacity-80 dark:border-white/10 dark:bg-black/25 dark:hover:bg-black/35"
        >
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <FileText className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium text-foreground">
              {message.filename || label}
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">
              {directDownloading ? (
                t.chats.loadingMedia(label)
              ) : (
                <>
                  {label}
                  {displayedSize ? ` · ${formatBytes(displayedSize, lang)}` : ''}
                </>
              )}
            </p>
          </div>
          {directDownloading ? (
            <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
          ) : directDownloaded ? (
            <Check className="size-4 shrink-0 text-primary" />
          ) : (
            <Download className="size-4 shrink-0 text-muted-foreground" />
          )}
        </button>
        {directError && (
          <div className="mt-1.5 flex items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-2.5 py-1 text-[11px] text-destructive">
            <span className="min-w-0 truncate">{directError}</span>
            <button
              type="button"
              onClick={() => void handleDirectDownload()}
              className="inline-flex shrink-0 cursor-pointer items-center gap-1 font-medium underline hover:opacity-80"
            >
              <RefreshCw className="size-3" />
              <span>{t.retry}</span>
            </button>
          </div>
        )}
      </div>
    );
  }

  if (isImage) {
    const filename = playbackSrc
      ? resolveChatMediaFilename(message, blobContentType, query.data?.filename)
      : '';
    const isLoadingFrame =
      !playbackSrc && (!inView || query.isLoading || (!query.isError && !blobError));
    const hasErrorFrame = !playbackSrc && !isLoadingFrame;

    return (
      <>
        <div
          ref={containerRef}
          className={`relative mt-2 overflow-hidden rounded-lg border ${
            hasErrorFrame
              ? 'border-destructive/30 bg-destructive/10 text-destructive'
              : playbackSrc
                ? `border-border ${isSticker ? 'bg-muted/20' : 'bg-black/5 dark:bg-black/25'}`
                : 'border-border/60 bg-muted/70 text-muted-foreground'
          } ${imageFrameClass}`}
        >
          {isLoadingFrame ? (
            <div
              aria-label={t.chats.loadingImage}
              className="absolute inset-0 flex items-center justify-center"
            >
              <ImageIcon className="size-6 opacity-45" />
            </div>
          ) : hasErrorFrame ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 p-3 text-center text-xs">
              <span className="line-clamp-3">
                {blobError || (query.error ? toApiError(query.error).message : t.chats.mediaLoadFailed)}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={() => {
                  setBlobError(null);
                  setStreamFallback(false);
                  void query.refetch();
                }}
              >
                <RefreshCw className="size-3" />
                <span>{t.retry}</span>
              </Button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setPreviewOpen(true)}
              className="absolute inset-0 block h-full w-full cursor-pointer focus-visible:outline-2 focus-visible:outline-ring"
              aria-label={t.chats.enlargeMediaAria(filename)}
            >
              {!imageLoaded && (
                <span
                  aria-hidden="true"
                  className="absolute inset-0 flex items-center justify-center bg-muted/70 text-muted-foreground"
                >
                  <ImageIcon className="size-6 opacity-45" />
                </span>
              )}
              <img
                ref={imgRef}
                src={playbackSrc!}
                alt={filename}
                decoding="async"
                referrerPolicy="no-referrer"
                onLoad={(event) => {
                  const img = event.currentTarget;
                  if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                    updateCachedMediaDimensions(messageKey, {
                      width: img.naturalWidth,
                      height: img.naturalHeight,
                    });
                  }
                  markMediaDecoded(messageKey);
                  setImageLoaded(true);
                }}
                className={`absolute inset-0 h-full w-full object-contain transition-opacity duration-150 hover:opacity-95 ${
                  imageLoaded ? 'opacity-100' : 'opacity-0'
                }`}
              />
            </button>
          )}
        </div>

        {playbackSrc && (
          <Dialog
            open={previewOpen}
            onOpenChange={setPreviewOpen}
            title={filename}
            className="max-w-2xl"
          >
            <div className="flex flex-col items-center gap-3">
              <img
                src={playbackSrc}
                alt={filename}
                referrerPolicy="no-referrer"
                className="max-h-[70vh] w-auto max-w-full rounded-lg border border-border object-contain"
              />
              <a
                href={playbackSrc}
                download={filename}
                className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs font-medium text-foreground hover:bg-muted"
              >
                <Download className="size-3.5" />
                <span>{t.chats.downloadImage}</span>
              </a>
            </div>
          </Dialog>
        )}
      </>
    );
  }

  if (message.media_type === 'video') {
    const isLoadingFrame =
      !playbackSrc && (!inView || query.isLoading || (!query.isError && !blobError));
    const hasErrorFrame = !playbackSrc && !isLoadingFrame;

    return (
      <div
        ref={containerRef}
        className={`relative mt-2 overflow-hidden rounded-lg border ${
          hasErrorFrame
            ? 'border-destructive/30 bg-destructive/10 text-destructive'
            : playbackSrc
              ? 'border-border bg-black'
              : 'border-border/60 bg-muted/70 text-muted-foreground'
        } ${VIDEO_FRAME_CLASS}`}
      >
        {isLoadingFrame ? (
          <div
            aria-label={t.chats.loadingMedia(label)}
            className="absolute inset-0 flex items-center justify-center"
          >
            <Film className="size-6 opacity-45" />
          </div>
        ) : hasErrorFrame ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 p-3 text-center text-xs">
            <span className="line-clamp-3">
              {blobError || (query.error ? toApiError(query.error).message : t.chats.mediaLoadFailed)}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => {
                setBlobError(null);
                setStreamFallback(false);
                void query.refetch();
              }}
            >
              <RefreshCw className="size-3" />
              <span>{t.retry}</span>
            </Button>
          </div>
        ) : (
          <video
            src={playbackSrc!}
            controls
            preload="metadata"
            onError={() => {
              if (!blobUrl && canStreamDirectly) {
                setStreamFallback(true);
              } else {
                setBlobError(t.chats.mediaLoadFailed);
              }
            }}
            className="absolute inset-0 h-full w-full object-contain"
          />
        )}
      </div>
    );
  }

  if (
    !playbackSrc &&
    (!inView || query.isLoading || (!query.isError && !blobError))
  ) {
    return (
      <div
        ref={containerRef}
        aria-label={t.chats.loadingMedia(label)}
        className={`mt-2 flex items-center gap-2 rounded-lg border border-border/60 bg-muted/70 px-3 text-muted-foreground ${AUDIO_FRAME_CLASS}`}
      >
        <Loader2 className="size-4 animate-spin opacity-60" />
      </div>
    );
  }

  if (query.isError || blobError || !playbackSrc) {
    return (
      <div
        ref={containerRef}
        className="mt-2 flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive"
      >
        <span>
          {blobError || (query.error ? toApiError(query.error).message : t.chats.mediaLoadFailed)}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={() => {
            setBlobError(null);
            setStreamFallback(false);
            void query.refetch();
          }}
        >
          <RefreshCw className="size-3" />
          <span>{t.retry}</span>
        </Button>
      </div>
    );
  }

  if (message.media_type === 'audio') {
    return (
      <div ref={containerRef} className={`mt-2 flex items-center overflow-hidden ${AUDIO_FRAME_CLASS}`}>
        <audio
          src={playbackSrc}
          controls
          preload="metadata"
          onError={() => {
            if (!blobUrl && canStreamDirectly) {
              setStreamFallback(true);
            } else {
              setBlobError(t.chats.mediaLoadFailed);
            }
          }}
          className="w-full"
        />
      </div>
    );
  }

  return null;
}
