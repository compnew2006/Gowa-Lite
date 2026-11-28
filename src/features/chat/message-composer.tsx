import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
  type RefObject,
} from 'react';
import {
  AlertTriangle,
  Ban,
  CalendarClock,
  FileText,
  Film,
  Info,
  Loader2,
  Lock,
  Music,
  Paperclip,
  RotateCcw,
  Send,
  X,
} from 'lucide-react';
import {toast} from 'sonner';
import type {MessageInfo} from '@/api/types';
import {Button} from '@/components/ui/button';
import {senderDisplayName} from '@/features/chat/display-name';
import {formatBytes} from '@/lib/format';
import {useI18n} from '@/lib/i18n';

export const MAX_CHAT_MEDIA_BYTES = 20 * 1024 * 1024;

export interface ComposerLockState {
  reason: 'blocked' | 'closed' | 'assigned_other' | 'claim_required';
  ownerName?: string;
  closedByName?: string | null;
}

const BLOCKED_EXTENSIONS = new Set([
  '.exe',
  '.bat',
  '.cmd',
  '.com',
  '.msi',
  '.ps1',
  '.vbs',
  '.scr',
  '.sh',
  '.dll',
  '.pif',
  '.jar',
  '.hta',
  '.cpl',
  '.lnk',
]);

export function validateChatMediaFile(file: File): 'ok' | 'too_large' | 'blocked' {
  const dot = file.name.lastIndexOf('.');
  if (dot !== -1) {
    const ext = file.name.slice(dot).toLowerCase();
    if (BLOCKED_EXTENSIONS.has(ext)) {
      return 'blocked';
    }
  }
  if (file.size <= 0 || file.size > MAX_CHAT_MEDIA_BYTES) {
    return 'too_large';
  }
  return 'ok';
}

export function MessageComposer({
  inputRef,
  deviceDisplayName,
  isDeviceReady,
  canWrite = true,
  canSchedule = true,
  lockState,
  autoReopenHint = false,
  canReopenFromComposer = false,
  canUnblockFromComposer = false,
  isLifecyclePending = false,
  onReopenFromComposer,
  onUnblockFromComposer,
  draft,
  attachment,
  replyingTo,
  isSending,
  onDraftChange,
  onAttachmentChange,
  onCancelReply,
  onOpenSchedule,
  onSubmit,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  deviceDisplayName: string;
  isDeviceReady: boolean;
  canWrite?: boolean;
  canSchedule?: boolean;
  lockState?: ComposerLockState;
  autoReopenHint?: boolean;
  canReopenFromComposer?: boolean;
  canUnblockFromComposer?: boolean;
  isLifecyclePending?: boolean;
  onReopenFromComposer?: () => void;
  onUnblockFromComposer?: () => void;
  draft: string;
  attachment: File | null;
  replyingTo: MessageInfo | null;
  isSending: boolean;
  onDraftChange: (value: string) => void;
  onAttachmentChange: (file: File | null) => void;
  onCancelReply: () => void;
  onOpenSchedule: () => void;
  onSubmit: (event: FormEvent) => void;
}) {
  const {lang, t} = useI18n();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!attachment || !attachment.type.startsWith('image/') || attachment.type === 'image/svg+xml') {
      setImagePreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(attachment);
    setImagePreviewUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [attachment]);

  const stageFile = (file: File | undefined | null) => {
    if (!file) return;
    const check = validateChatMediaFile(file);
    if (check === 'blocked') {
      toast.error(t.chats.mediaBlockedError);
      return;
    }
    if (check === 'too_large') {
      toast.error(t.chats.mediaTooLargeError);
      return;
    }
    onAttachmentChange(file);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  };

  const handlePaste = (event: ClipboardEvent<HTMLInputElement>) => {
    const pastedFiles = event.clipboardData?.files;
    if (!pastedFiles || pastedFiles.length === 0) return;
    event.preventDefault();
    if (!canWrite || !isDeviceReady || isSending || lockState) return;
    stageFile(pastedFiles[0]);
  };

  if (!canWrite && !canSchedule && !lockState) {
    return null;
  }

  if (lockState) {
    const lockMessage =
      lockState.reason === 'blocked'
        ? t.chats.composerBlockedBanner
        : lockState.reason === 'closed'
          ? t.chats.composerLockedClosed(lockState.closedByName)
          : lockState.reason === 'assigned_other'
            ? t.chats.composerLockedOther(lockState.ownerName || '')
            : t.chats.composerLockedClaimRequired;

    const showReopenBtn =
      lockState.reason === 'closed' && canReopenFromComposer && onReopenFromComposer;
    const showUnblockBtn =
      lockState.reason === 'blocked' && canUnblockFromComposer && onUnblockFromComposer;

    return (
      <div className="wa-wallpaper shrink-0 px-3 pb-3 pt-1.5">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-2.5 shadow-2xs">
          <div className="flex min-w-0 flex-1 items-center gap-2.5 text-xs text-muted-foreground">
            {lockState.reason === 'blocked' ? (
              <Ban className="size-4 shrink-0 text-destructive" />
            ) : (
              <Lock className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
            )}
            <span className="leading-relaxed text-foreground/90">{lockMessage}</span>
          </div>
          {showReopenBtn && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={isLifecyclePending}
              onClick={onReopenFromComposer}
              className="h-8 whitespace-nowrap shrink-0 px-3 text-xs"
            >
              {isLifecyclePending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RotateCcw className="size-3.5" />
              )}
              <span>{t.chats.reopenAction}</span>
            </Button>
          )}
          {showUnblockBtn && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={isLifecyclePending}
              onClick={onUnblockFromComposer}
              className="h-8 whitespace-nowrap shrink-0 px-3 text-xs"
            >
              {isLifecyclePending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Ban className="size-3.5" />
              )}
              <span>{t.chats.unblockAction}</span>
            </Button>
          )}
        </div>
      </div>
    );
  }

  const isAudioAttachment = Boolean(attachment?.type.startsWith('audio/'));
  const isVideoAttachment = Boolean(attachment?.type.startsWith('video/'));
  const canSend =
    canWrite && isDeviceReady && !isSending && (Boolean(draft.trim()) || Boolean(attachment));

  return (
    <div className="wa-wallpaper shrink-0 px-3 pb-3 pt-1.5">
      {autoReopenHint && canWrite && (
        <div className="mx-auto mb-2 flex max-w-4xl items-center gap-2 rounded-xl border border-amber-500/35 bg-card/95 px-3 py-1.5 text-xs text-amber-800 dark:text-amber-300">
          <Info className="size-4 shrink-0" />
          <span>{t.chats.composerAutoReopenHint}</span>
        </div>
      )}

      {!isDeviceReady && (
        <div className="mx-auto mb-2 flex max-w-4xl items-center gap-2 rounded-xl border border-destructive/30 bg-card/95 px-3 py-2 text-xs text-destructive">
          <AlertTriangle className="size-4 shrink-0" />
          <span>{t.chats.offlineSendBanner(deviceDisplayName)}</span>
        </div>
      )}

      {replyingTo && !attachment && (
        <div className="mx-auto mb-2 flex max-w-4xl items-center justify-between gap-2 rounded-xl border border-border bg-card/95 px-3 py-2 shadow-xs">
          <div className="min-w-0 flex-1 border-s-3 border-primary ps-2.5">
            <p className="truncate text-xs font-semibold text-primary">
              {t.chats.replyingTo(
                replyingTo.is_from_me ? t.you : senderDisplayName(replyingTo),
              )}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {replyingTo.content ||
                replyingTo.filename ||
                t.chats.mediaLabels[replyingTo.media_type] ||
                replyingTo.media_type ||
                t.messageFallback}
            </p>
          </div>
          <button
            type="button"
            onClick={onCancelReply}
            aria-label={t.chats.cancelReply}
            title={t.chats.cancelReply}
            className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
      )}

      {attachment && (
        <div className="mx-auto mb-2 flex max-w-4xl items-center justify-between gap-3 rounded-xl border border-border bg-card/95 px-3 py-2 shadow-xs">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            {imagePreviewUrl ? (
              <img
                src={imagePreviewUrl}
                alt={attachment.name}
                className="size-11 shrink-0 rounded-lg border border-border object-cover"
              />
            ) : (
              <span className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-secondary text-primary">
                {isVideoAttachment ? (
                  <Film className="size-5" />
                ) : isAudioAttachment ? (
                  <Music className="size-5" />
                ) : (
                  <FileText className="size-5" />
                )}
              </span>
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-semibold text-foreground">{attachment.name}</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">
                {formatBytes(attachment.size, lang)}
                {isAudioAttachment ? ` · ${t.chats.audioCaptionHint}` : ''}
              </p>
            </div>
          </div>
          <button
            type="button"
            disabled={isSending}
            onClick={() => onAttachmentChange(null)}
            aria-label={t.chats.removeAttachment}
            title={t.chats.removeAttachment}
            className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-40"
          >
            <X className="size-4" />
          </button>
        </div>
      )}

      <form
        onSubmit={onSubmit}
        className="mx-auto flex max-w-4xl items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1.5 shadow-[0_1px_4px_rgba(11,20,26,0.1)]"
      >
        {canWrite && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={(event) => {
                stageFile(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
            <button
              type="button"
              disabled={!isDeviceReady || isSending}
              onClick={() => fileInputRef.current?.click()}
              title={t.chats.attachMedia}
              aria-label={t.chats.attachMedia}
              className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Paperclip className="size-4" />
            </button>

            <input
              ref={inputRef}
              type="text"
              placeholder={
                !isDeviceReady
                  ? t.chats.accountCurrentlyOffline
                  : attachment
                    ? t.chats.captionPlaceholder
                    : t.chats.replyPlaceholder(deviceDisplayName)
              }
              value={draft}
              disabled={!isDeviceReady || isSending}
              onChange={(event) => onDraftChange(event.target.value)}
              onPaste={handlePaste}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  if (attachment) {
                    event.preventDefault();
                    onAttachmentChange(null);
                  } else if (replyingTo) {
                    event.preventDefault();
                    onCancelReply();
                  }
                }
              }}
              className="h-9 min-w-0 flex-1 bg-transparent px-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none disabled:opacity-50"
            />
          </>
        )}

        {canSchedule && (
          <button
            type="button"
            disabled={isSending}
            onClick={onOpenSchedule}
            title={t.chats.scheduleMessageBtn}
            aria-label={t.chats.scheduleMessageBtn}
            className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <CalendarClock className="size-4" />
          </button>
        )}

        {canWrite && (
          <button
            type="submit"
            aria-label={t.chats.send}
            title={t.chats.send}
            disabled={!canSend}
            className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full bg-live text-white transition-colors hover:bg-primary disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isSending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
          </button>
        )}
      </form>
    </div>
  );
}
