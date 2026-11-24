import {Download, FileArchive, Loader2, RotateCcw, Square, X} from 'lucide-react';
import {Button} from '@/components/ui/button';
import type {BatchDownloadState} from '@/features/chat/use-media-batch';
import {formatBytes} from '@/lib/format';
import {useI18n} from '@/lib/i18n';

export function MediaSelectionBar({
  selectedCount,
  totalDownloadable,
  estimatedBytes,
  batchState,
  onSelectAll,
  onClearSelection,
  onDownloadSeparate,
  onDownloadZip,
  onRetryFailed,
  onCancelBatch,
  onClose,
}: {
  selectedCount: number;
  totalDownloadable: number;
  estimatedBytes: number;
  batchState: BatchDownloadState;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onDownloadSeparate: () => void;
  onDownloadZip: () => void;
  onRetryFailed: () => void;
  onCancelBatch: () => void;
  onClose: () => void;
}) {
  const {lang, t} = useI18n();
  const progressPct =
    batchState.active && batchState.total > 0
      ? Math.min(100, Math.round((batchState.completed / batchState.total) * 100))
      : 0;

  return (
    <div
      role="region"
      aria-label={t.chats.selectMediaTitle}
      className="relative shrink-0 border-t border-border bg-card/95 backdrop-blur-xs"
    >
      {batchState.active && (
        <div
          aria-hidden="true"
          className="absolute inset-x-0 top-0 h-0.5 bg-muted"
        >
          <div
            className="h-full bg-primary transition-all duration-200"
            style={{width: `${progressPct}%`}}
          />
        </div>
      )}

      <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-2 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2 text-xs">
          {totalDownloadable === 0 ? (
            <span className="text-muted-foreground">{t.chats.noDownloadableMediaHint}</span>
          ) : (
            <>
              <span className="font-semibold text-foreground tabular-nums">
                {t.chats.selectedMediaCount(selectedCount, totalDownloadable)}
              </span>
              {estimatedBytes > 0 && (
                <span className="text-muted-foreground tabular-nums">
                  · ~{formatBytes(estimatedBytes, lang)}
                </span>
              )}
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {batchState.active ? (
            <>
              <div className="flex items-center gap-1.5 px-2 text-xs text-muted-foreground tabular-nums">
                <Loader2 className="size-3.5 animate-spin text-primary" />
                <span>{t.chats.downloadingProgress(batchState.completed, batchState.total)}</span>
                {batchState.bytesLoaded > 0 && (
                  <span>· {formatBytes(batchState.bytesLoaded, lang)}</span>
                )}
              </div>
              <Button variant="destructive" size="sm" onClick={onCancelBatch}>
                <Square className="size-3.5" />
                <span>{t.chats.cancelDownload}</span>
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={onSelectAll}
                disabled={totalDownloadable === 0 || selectedCount === totalDownloadable}
              >
                {t.chats.selectAllMedia}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={onClearSelection}
                disabled={selectedCount === 0}
              >
                {t.chats.clearMediaSelection}
              </Button>

              {batchState.failedIds.length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={onRetryFailed}
                  className="border-amber-500/40 text-amber-700 hover:bg-amber-500/10 dark:text-amber-300"
                >
                  <RotateCcw className="size-3.5" />
                  <span>{t.chats.retryFailedMedia(batchState.failedIds.length)}</span>
                </Button>
              )}

              <Button
                variant="outline"
                size="sm"
                onClick={onDownloadSeparate}
                disabled={selectedCount === 0}
              >
                <Download className="size-3.5" />
                <span>{t.chats.downloadSeparately}</span>
              </Button>
              <Button
                variant="default"
                size="sm"
                onClick={onDownloadZip}
                disabled={selectedCount === 0}
              >
                <FileArchive className="size-3.5" />
                <span>{t.chats.downloadAsZip}</span>
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                onClick={onClose}
                aria-label={t.close}
                title={t.close}
              >
                <X className="size-4" />
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
