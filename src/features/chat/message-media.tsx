import {useEffect, useRef, useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {Download, FileText, Image as ImageIcon, Loader2, RefreshCw} from 'lucide-react';
import {downloadUnifiedMedia, fetchAuthorizedBlobUrl} from '@/api/client';
import type {MessageInfo} from '@/api/types';
import {Button} from '@/components/ui/button';
import {Dialog} from '@/components/ui/dialog';
import {formatBytes} from '@/lib/format';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';

const IMAGE_EXTENSIONS = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;
const AUTO_MEDIA_MAX_BYTES = 20 * 1024 * 1024;

function isImageAttachment(message: MessageInfo, resolvedFilename?: string): boolean {
  if (message.media_type === 'image' || message.media_type === 'sticker') return true;
  const name = resolvedFilename || message.filename;
  if (message.media_type === 'document' && name) {
    return IMAGE_EXTENSIONS.test(name);
  }
  return false;
}

function shouldAutoFetch(message: MessageInfo): boolean {
  if (isImageAttachment(message)) return true;
  if (message.media_type === 'audio' || message.media_type === 'video') {
    return !message.file_length || message.file_length <= AUTO_MEDIA_MAX_BYTES;
  }
  return false;
}

export function MessageMedia({message, deviceId}: {message: MessageInfo; deviceId: string}) {
  const {lang, t} = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const autoFetch = shouldAutoFetch(message);
  const [inView, setInView] = useState(!autoFetch);
  const [requested, setRequested] = useState(autoFetch);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [blobError, setBlobError] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

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

  const query = useQuery({
    queryKey: ['unified-media', deviceId, message.chat_jid, message.id],
    queryFn: async () => {
      const data = await downloadUnifiedMedia(
        deviceId,
        message.id,
        message.chat_jid,
        message.url,
      );
      if (!data || (!data.file_path && !data.file_url)) {
        throw new Error(t.chats.mediaUnavailable);
      }
      return data;
    },
    enabled: requested && inView,
    staleTime: Infinity,
    retry: false,
  });

  const resolvedPath = query.data?.file_path || query.data?.file_url || '';

  useEffect(() => {
    if (!resolvedPath) return;
    let active = true;
    let createdUrl = '';
    setBlobError(null);

    const url = `/api/unified/media/file?path=${encodeURIComponent(resolvedPath)}`;
    void fetchAuthorizedBlobUrl(url)
      .then((objectUrl) => {
        if (!active) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        createdUrl = objectUrl;
        setBlobUrl(objectUrl);
      })
      .catch((err) => {
        if (active) setBlobError(toApiError(err).message);
      });

    return () => {
      active = false;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [resolvedPath]);

  const isImage = isImageAttachment(message, query.data?.filename);
  const label =
    t.chats.mediaLabels[message.media_type] || message.media_type || t.chats.mediaLabels.file;

  if (!requested) {
    return (
      <div ref={containerRef}>
        <button
          type="button"
          onClick={() => {
            setInView(true);
            setRequested(true);
          }}
          className="mt-2 flex w-full max-w-xs cursor-pointer items-center gap-3 rounded-lg border border-black/10 bg-black/10 px-3 py-2.5 text-start transition-colors hover:bg-black/15 dark:border-white/10 dark:bg-black/25 dark:hover:bg-black/35"
        >
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <FileText className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium text-foreground">
              {message.filename || label}
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">
              {label}
              {message.file_length ? ` · ${formatBytes(message.file_length, lang)}` : ''}
            </p>
          </div>
          <Download className="size-4 shrink-0 text-muted-foreground" />
        </button>
      </div>
    );
  }

  if (!inView || query.isLoading || (!blobUrl && !query.isError && !blobError)) {
    if (isImage) {
      return (
        <div
          ref={containerRef}
          className="mt-2 flex h-40 w-52 items-center justify-center rounded-lg border border-border bg-muted/60 text-muted-foreground"
        >
          <div className="flex flex-col items-center gap-1.5 text-xs">
            <ImageIcon className="size-5 opacity-60" />
            <span>{t.chats.loadingImage}</span>
          </div>
        </div>
      );
    }
    return (
      <div ref={containerRef} className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        <span>{t.chats.loadingMedia(label)}</span>
      </div>
    );
  }

  if (query.isError || blobError || !query.data || !blobUrl) {
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
            void query.refetch();
          }}
        >
          <RefreshCw className="size-3" />
          <span>{t.retry}</span>
        </Button>
      </div>
    );
  }

  const filename = query.data.filename || message.filename || 'attachment';

  if (isImage) {
    return (
      <div ref={containerRef}>
        <button
          type="button"
          onClick={() => setPreviewOpen(true)}
          className="mt-2 block cursor-pointer overflow-hidden rounded-lg border border-border bg-muted/20 focus-visible:outline-2 focus-visible:outline-ring"
          aria-label={t.chats.enlargeMediaAria(filename)}
        >
          <img
            src={blobUrl}
            alt={filename}
            referrerPolicy="no-referrer"
            className="max-h-56 w-auto max-w-full object-cover transition-opacity hover:opacity-95"
          />
        </button>

        <Dialog
          open={previewOpen}
          onOpenChange={setPreviewOpen}
          title={filename}
          className="max-w-2xl"
        >
          <div className="flex flex-col items-center gap-3">
            <img
              src={blobUrl}
              alt={filename}
              referrerPolicy="no-referrer"
              className="max-h-[70vh] w-auto max-w-full rounded-lg border border-border object-contain"
            />
            <a
              href={blobUrl}
              download={filename}
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs font-medium text-foreground hover:bg-muted"
            >
              <Download className="size-3.5" />
              <span>{t.chats.downloadImage}</span>
            </a>
          </div>
        </Dialog>
      </div>
    );
  }

  if (message.media_type === 'video') {
    return (
      <div ref={containerRef} className="mt-2">
        <video
          src={blobUrl}
          controls
          className="max-h-60 max-w-full rounded-lg border border-border"
        />
      </div>
    );
  }

  if (message.media_type === 'audio') {
    return (
      <div ref={containerRef} className="mt-2">
        <audio src={blobUrl} controls className="max-w-full" />
      </div>
    );
  }

  return (
    <div ref={containerRef}>
      <a
        href={blobUrl}
        download={filename}
        className="mt-2 flex w-full max-w-xs items-center gap-3 rounded-lg border border-black/10 bg-black/10 px-3 py-2.5 text-start transition-colors hover:bg-black/15 dark:border-white/10 dark:bg-black/25 dark:hover:bg-black/35"
      >
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <FileText className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-foreground">{filename}</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">
            {label}
            {query.data.file_size ? ` · ${formatBytes(query.data.file_size, lang)}` : ''}
          </p>
        </div>
        <Download className="size-4 shrink-0 text-muted-foreground" />
      </a>
    </div>
  );
}
