import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import {toast} from 'sonner';
import {downloadUnifiedMedia, fetchAuthorizedMediaBytes} from '@/api/client';
import type {DownloadedMedia, MessageInfo} from '@/api/types';
import {useI18n} from '@/lib/i18n';
import {
  StreamingZipBuilder,
  computeRangeSelection,
  estimateTotalMediaBytes,
  formatZipArchiveName,
  resolveMediaFilename,
  saveBlobSafely,
} from '@/lib/media-download';

export type BatchDownloadMode = 'separate' | 'zip';

export interface BatchDownloadState {
  active: boolean;
  mode: BatchDownloadMode | null;
  completed: number;
  total: number;
  bytesLoaded: number;
  failedIds: string[];
  lastFailedMode: BatchDownloadMode | null;
}

const INITIAL_BATCH_STATE: BatchDownloadState = {
  active: false,
  mode: null,
  completed: 0,
  total: 0,
  bytesLoaded: 0,
  failedIds: [],
  lastFailedMode: null,
};

const ZIP_CONCURRENCY = 3;
const SEPARATE_GAP_MS = 350;

function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'));
  }
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, {once: true});
  });
}

export function useMediaBatch({
  deviceId,
  chatJid,
  downloadableMessages,
}: {
  deviceId: string;
  chatJid: string;
  downloadableMessages: MessageInfo[];
}) {
  const queryClient = useQueryClient();
  const {t} = useI18n();

  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [batchState, setBatchState] = useState<BatchDownloadState>(INITIAL_BATCH_STATE);

  const anchorIdRef = useRef<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const abortActive = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  }, []);

  useEffect(() => {
    abortActive();
    setSelectMode(false);
    setSelectedIds(new Set());
    setBatchState(INITIAL_BATCH_STATE);
    anchorIdRef.current = null;
    return () => {
      abortActive();
    };
  }, [deviceId, chatJid, abortActive]);

  const orderedDownloadableIds = useMemo(
    () => downloadableMessages.map((msg) => msg.id),
    [downloadableMessages],
  );

  const selectedMessages = useMemo(
    () => downloadableMessages.filter((msg) => selectedIds.has(msg.id)),
    [downloadableMessages, selectedIds],
  );

  const estimatedBytes = useMemo(
    () => estimateTotalMediaBytes(selectedMessages),
    [selectedMessages],
  );

  const toggleSelectMode = useCallback(() => {
    setSelectMode((prev) => {
      if (prev) {
        abortActive();
        setSelectedIds(new Set());
        setBatchState(INITIAL_BATCH_STATE);
        anchorIdRef.current = null;
        return false;
      }
      return true;
    });
  }, [abortActive]);

  const toggleSelectItem = useCallback(
    (messageId: string, shiftKey: boolean) => {
      setSelectedIds((prev) =>
        computeRangeSelection(
          orderedDownloadableIds,
          prev,
          anchorIdRef.current,
          messageId,
          shiftKey,
        ),
      );
      anchorIdRef.current = messageId;
    },
    [orderedDownloadableIds],
  );

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(orderedDownloadableIds));
    anchorIdRef.current = orderedDownloadableIds[0] ?? null;
  }, [orderedDownloadableIds]);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    anchorIdRef.current = null;
    setBatchState((prev) => (prev.active ? prev : INITIAL_BATCH_STATE));
  }, []);

  const fetchMediaPayload = useCallback(
    async (
      message: MessageInfo,
      signal: AbortSignal,
    ): Promise<{bytes: Uint8Array<ArrayBuffer>; contentType: string; filename: string}> => {
      const cacheKey = ['unified-media', deviceId, message.chat_jid, message.id] as const;
      let resolved = queryClient.getQueryData<DownloadedMedia>(cacheKey);

      if (!resolved || (!resolved.file_path && !resolved.file_url)) {
        resolved = await downloadUnifiedMedia(
          deviceId,
          message.id,
          message.chat_jid,
          message.url,
          signal,
        );
        if (!resolved || (!resolved.file_path && !resolved.file_url)) {
          throw new Error(t.chats.mediaUnavailable);
        }
        queryClient.setQueryData(cacheKey, resolved);
      }

      const targetPath = resolved.file_path || resolved.file_url || '';
      const fileUrl = `/api/unified/media/file?deviceId=${encodeURIComponent(deviceId)}&path=${encodeURIComponent(targetPath)}`;
      const {bytes, contentType} = await fetchAuthorizedMediaBytes(fileUrl, signal);
      const filename = resolveMediaFilename(message, contentType, resolved.filename);
      return {bytes, contentType, filename};
    },
    [deviceId, queryClient, t.chats.mediaUnavailable],
  );

  const runBatch = useCallback(
    async (mode: BatchDownloadMode, targetMessages: MessageInfo[]) => {
      if (targetMessages.length === 0 || batchState.active) return;

      abortActive();
      const controller = new AbortController();
      abortControllerRef.current = controller;
      const {signal} = controller;

      setBatchState({
        active: true,
        mode,
        completed: 0,
        total: targetMessages.length,
        bytesLoaded: 0,
        failedIds: [],
        lastFailedMode: null,
      });

      const failedIds: string[] = [];
      let succeededCount = 0;

      if (mode === 'zip') {
        const builder = new StreamingZipBuilder();
        let nextIndex = 0;

        const worker = async () => {
          while (!signal.aborted) {
            const idx = nextIndex;
            nextIndex += 1;
            if (idx >= targetMessages.length) return;

            const msg = targetMessages[idx];
            try {
              const payload = await fetchMediaPayload(msg, signal);
              if (signal.aborted) return;
              builder.add(payload.filename, payload.bytes);
              succeededCount += 1;
              setBatchState((prev) => ({
                ...prev,
                completed: prev.completed + 1,
                bytesLoaded: prev.bytesLoaded + payload.bytes.byteLength,
              }));
            } catch {
              if (signal.aborted) return;
              failedIds.push(msg.id);
              setBatchState((prev) => ({
                ...prev,
                completed: prev.completed + 1,
              }));
            }
          }
        };

        try {
          const workerCount = Math.min(ZIP_CONCURRENCY, targetMessages.length);
          await Promise.all(Array.from({length: workerCount}, () => worker()));

          if (signal.aborted) {
            builder.abort();
            setBatchState(INITIAL_BATCH_STATE);
            toast.info(t.chats.batchDownloadCancelled);
            return;
          }

          if (builder.count > 0) {
            const zipBlob = await builder.finalize();
            saveBlobSafely(zipBlob, formatZipArchiveName());
          } else {
            builder.abort();
          }
        } catch {
          builder.abort();
          if (signal.aborted) {
            setBatchState(INITIAL_BATCH_STATE);
            toast.info(t.chats.batchDownloadCancelled);
            return;
          }
          setBatchState({
            active: false,
            mode: null,
            completed: 0,
            total: 0,
            bytesLoaded: 0,
            failedIds: targetMessages.map((m) => m.id),
            lastFailedMode: 'zip',
          });
          toast.error(t.chats.batchDownloadFailed);
          return;
        }
      } else {
        for (let i = 0; i < targetMessages.length; i += 1) {
          if (signal.aborted) break;
          const msg = targetMessages[i];
          try {
            const payload = await fetchMediaPayload(msg, signal);
            if (signal.aborted) break;
            const normalizedType =
              payload.contentType === 'video/x-f4v'
                ? 'video/mp4'
                : payload.contentType === 'image/pjpeg'
                  ? 'image/jpeg'
                  : payload.contentType || 'application/octet-stream';
            const blob = new Blob([payload.bytes], {
              type: normalizedType,
            });
            saveBlobSafely(blob, payload.filename);
            succeededCount += 1;
            setBatchState((prev) => ({
              ...prev,
              completed: prev.completed + 1,
              bytesLoaded: prev.bytesLoaded + payload.bytes.byteLength,
            }));
            if (i < targetMessages.length - 1) {
              await sleepWithSignal(SEPARATE_GAP_MS, signal);
            }
          } catch {
            if (signal.aborted) break;
            failedIds.push(msg.id);
            setBatchState((prev) => ({
              ...prev,
              completed: prev.completed + 1,
            }));
          }
        }

        if (signal.aborted) {
          setBatchState(INITIAL_BATCH_STATE);
          toast.info(t.chats.batchDownloadCancelled);
          return;
        }
      }

      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }

      if (failedIds.length === 0) {
        setBatchState(INITIAL_BATCH_STATE);
        setSelectedIds(new Set());
        setSelectMode(false);
        anchorIdRef.current = null;
        toast.success(t.chats.batchDownloadSuccess(succeededCount));
      } else if (succeededCount > 0) {
        setSelectedIds(new Set(failedIds));
        setBatchState({
          active: false,
          mode: null,
          completed: 0,
          total: 0,
          bytesLoaded: 0,
          failedIds,
          lastFailedMode: mode,
        });
        toast.warning(t.chats.batchDownloadPartial(succeededCount, targetMessages.length));
      } else {
        setSelectedIds(new Set(failedIds));
        setBatchState({
          active: false,
          mode: null,
          completed: 0,
          total: 0,
          bytesLoaded: 0,
          failedIds,
          lastFailedMode: mode,
        });
        toast.error(t.chats.batchDownloadFailed);
      }
    },
    [abortActive, batchState.active, fetchMediaPayload, t.chats],
  );

  const downloadSeparate = useCallback(
    () => void runBatch('separate', selectedMessages),
    [runBatch, selectedMessages],
  );

  const downloadZip = useCallback(
    () => void runBatch('zip', selectedMessages),
    [runBatch, selectedMessages],
  );

  const retryFailed = useCallback(() => {
    if (batchState.failedIds.length === 0) return;
    const failedSet = new Set(batchState.failedIds);
    const targets = downloadableMessages.filter((msg) => failedSet.has(msg.id));
    const mode = batchState.lastFailedMode ?? 'zip';
    if (targets.length > 0) {
      void runBatch(mode, targets);
    }
  }, [batchState.failedIds, batchState.lastFailedMode, downloadableMessages, runBatch]);

  return {
    selectMode,
    selectedIds,
    selectedCount: selectedMessages.length,
    totalDownloadable: downloadableMessages.length,
    estimatedBytes,
    batchState,
    toggleSelectMode,
    toggleSelectItem,
    selectAll,
    clearSelection,
    downloadSeparate,
    downloadZip,
    retryFailed,
    cancelBatch: abortActive,
  };
}
