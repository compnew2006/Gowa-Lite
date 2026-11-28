import {memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {Ban, Check, CheckCheck, Copy, Forward, Reply, SmilePlus, Trash2} from 'lucide-react';
import {toast} from 'sonner';
import type {MessageInfo} from '@/api/types';
import {senderDisplayName} from '@/features/chat/display-name';
import {FormattedText} from '@/features/chat/formatted-text';
import {MessageMedia} from '@/features/chat/message-media';
import {
  QUICK_REACTION_EMOJIS,
  groupReactions,
  type GroupedReaction,
} from '@/features/chat/message-reactions';
import {
  computeFloatingPickerPosition,
  type FloatingPickerPosition,
} from '@/features/chat/reaction-picker-position';
import {copyTextWithFallback} from '@/lib/clipboard';
import {formatDate, formatShortTime} from '@/lib/format';
import {useI18n} from '@/lib/i18n';
import {isDownloadableMedia} from '@/lib/media-download';
import {cn} from '@/lib/utils';

/**
 * What the bubble toolbar's copy button copies (P1-10, decision 17): the
 * message text when there is one, otherwise the attachment file name when
 * there is one, otherwise nothing (the button renders disabled).
 */
export function resolveCopyTarget(message: Pick<MessageInfo, 'content' | 'filename'>): {
  text: string;
  isFileName: boolean;
} {
  const text = message.content?.trim() ? message.content : '';
  if (text) return {text, isFileName: false};
  const fileName = message.filename?.trim() || '';
  return {text: fileName, isFileName: fileName !== ''};
}

function QuotedMessagePreview({
  quoted,
  isOut,
  onJumpToMessage,
}: {
  quoted: MessageInfo | null;
  isOut: boolean;
  onJumpToMessage: (messageId: string) => void;
}) {
  const {t} = useI18n();
  return (
    <div
      role={quoted ? 'button' : undefined}
      tabIndex={quoted ? 0 : undefined}
      onClick={quoted ? () => onJumpToMessage(quoted.id) : undefined}
      onKeyDown={
        quoted
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onJumpToMessage(quoted.id);
              }
            }
          : undefined
      }
      className={cn(
        'mb-2 rounded-lg border-s-4 border-live px-2.5 py-1.5 text-xs',
        isOut ? 'bg-bubble-out-subtle' : 'bg-secondary dark:bg-black/25',
        quoted && 'cursor-pointer transition-opacity hover:opacity-90',
      )}
    >
      {quoted ? (
        <>
          <p className="font-medium text-accent-foreground">
            {quoted.is_from_me ? t.you : senderDisplayName(quoted)}
          </p>
          <p className="truncate text-muted-foreground">
            {quoted.content || quoted.filename || quoted.media_type || t.messageFallback}
          </p>
        </>
      ) : (
        <p className="italic text-muted-foreground">{t.repliedToOlder}</p>
      )}
    </div>
  );
}

function MessageReactionsBar({
  groupedReactions,
  interactive,
  onReact,
}: {
  groupedReactions: GroupedReaction[];
  interactive: boolean;
  onReact: (emoji: string) => void;
}) {
  if (groupedReactions.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {groupedReactions.map((reaction) => (
        <button
          key={reaction.emoji}
          type="button"
          disabled={!interactive}
          aria-pressed={reaction.hasMe}
          onClick={() => onReact(reaction.emoji)}
          title={reaction.senders.join('، ')}
          className={cn(
            'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs leading-none shadow-2xs transition-colors',
            interactive ? 'cursor-pointer hover:bg-muted/80' : 'cursor-default',
            reaction.hasMe
              ? 'border-primary/40 bg-accent text-accent-foreground'
              : 'border-border bg-card text-foreground',
          )}
        >
          <span>{reaction.emoji}</span>
          {reaction.count > 1 && (
            <span className="text-[10px] font-medium text-muted-foreground tabular-nums">
              {reaction.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

function MessageBubbleActions({
  message,
  isOut,
  isRevoked,
  isDeviceReady,
  canReactAndReply,
  copyTarget,
  copied,
  isReactionPickerOpen,
  myReactionEmoji,
  onToggleReactionPicker,
  onCloseReactionPicker,
  onReact,
  onReply,
  onCopy,
  onForward,
  onRevoke,
}: {
  message: MessageInfo;
  isOut: boolean;
  isRevoked: boolean;
  isDeviceReady: boolean;
  canReactAndReply: boolean;
  copyTarget: {text: string; isFileName: boolean};
  copied: boolean;
  isReactionPickerOpen: boolean;
  myReactionEmoji: string | undefined;
  onToggleReactionPicker: (messageId: string) => void;
  onCloseReactionPicker: () => void;
  onReact: (message: MessageInfo, emoji: string) => void;
  onReply: (message: MessageInfo) => void;
  onCopy: () => void;
  onForward?: (message: MessageInfo) => void;
  onRevoke?: (message: MessageInfo) => void;
}) {
  const {isRtl, t} = useI18n();
  const triggerBtnRef = useRef<HTMLButtonElement>(null);
  const floatingPickerRef = useRef<HTMLDivElement>(null);
  const [pickerPos, setPickerPos] = useState<FloatingPickerPosition | null>(null);

  const updatePickerPosition = useCallback(() => {
    const btn = triggerBtnRef.current;
    if (!btn) return;
    const triggerRect = btn.getBoundingClientRect();
    const measured = floatingPickerRef.current?.getBoundingClientRect();
    const pickerSize = {
      width: measured && measured.width > 0 ? measured.width : 264,
      height: measured && measured.height > 0 ? measured.height : 44,
    };
    const alignEnd = isRtl ? !isOut : isOut;
    setPickerPos(
      computeFloatingPickerPosition({
        triggerRect,
        pickerSize,
        viewport: {width: window.innerWidth, height: window.innerHeight},
        alignEnd,
      }),
    );
  }, [isOut, isRtl]);

  useLayoutEffect(() => {
    if (!isReactionPickerOpen || isRevoked) {
      setPickerPos(null);
      return;
    }
    updatePickerPosition();
  }, [isReactionPickerOpen, isRevoked, updatePickerPosition]);

  useEffect(() => {
    if (!isReactionPickerOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerBtnRef.current?.contains(target) || floatingPickerRef.current?.contains(target)) {
        return;
      }
      onCloseReactionPicker();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseReactionPicker();
    };
    const onViewportChange = () => updatePickerPosition();
    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
    };
  }, [isReactionPickerOpen, onCloseReactionPicker, updatePickerPosition]);

  return (
    <div
      className={cn(
        'relative flex shrink-0 items-center gap-0.5 self-center transition-opacity',
        isReactionPickerOpen
          ? 'opacity-100'
          : 'opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100',
        isOut ? 'ltr:order-first rtl:order-last' : 'ltr:order-last rtl:order-first',
      )}
    >
      {canReactAndReply && (
        <>
          <div className="relative">
            <button
              ref={triggerBtnRef}
              type="button"
              disabled={!isDeviceReady || isRevoked}
              onClick={() => onToggleReactionPicker(message.id)}
              title={isDeviceReady ? t.chats.addReaction : t.chats.accountCurrentlyOffline}
              aria-label={t.chats.addReaction}
              aria-expanded={isReactionPickerOpen}
              className={cn(
                'flex size-7 cursor-pointer items-center justify-center rounded-full bg-card/95 text-muted-foreground shadow-2xs ring-1 ring-border transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40',
                isReactionPickerOpen && 'bg-secondary text-foreground',
              )}
            >
              <SmilePlus className="size-3.5" />
            </button>

            {isReactionPickerOpen &&
              !isRevoked &&
              typeof document !== 'undefined' &&
              createPortal(
                <div
                  ref={floatingPickerRef}
                  role="menu"
                  style={
                    pickerPos
                      ? {position: 'fixed', top: pickerPos.top, left: pickerPos.left}
                      : {position: 'fixed', top: -9999, left: -9999}
                  }
                  className="z-50 flex items-center gap-0.5 rounded-full border border-border bg-popover px-2 py-1 shadow-[0_4px_20px_rgba(11,20,26,0.16)]"
                >
                  {QUICK_REACTION_EMOJIS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      onClick={() => {
                        onReact(message, emoji);
                        onCloseReactionPicker();
                      }}
                      className={cn(
                        'flex size-8 cursor-pointer items-center justify-center rounded-full text-xl leading-none transition-transform hover:scale-125 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring',
                        myReactionEmoji === emoji && 'bg-accent ring-1 ring-primary/40',
                      )}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>,
                document.body,
              )}
          </div>

          <button
            type="button"
            disabled={!isDeviceReady || isRevoked}
            onClick={() => onReply(message)}
            title={isDeviceReady ? t.chats.reply : t.chats.accountCurrentlyOffline}
            aria-label={t.chats.reply}
            className="flex size-7 cursor-pointer items-center justify-center rounded-full bg-card/90 text-muted-foreground shadow-2xs ring-1 ring-border/70 transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Reply className="size-3.5" />
          </button>
        </>
      )}

      {/* P1-10: the copy button is always visible; it copies the file name
          for caption-less media and is disabled (with an explanatory title)
          when there is neither text nor a file name. */}
      <button
        type="button"
        disabled={!copyTarget.text}
        onClick={onCopy}
        title={
          copyTarget.text
            ? copyTarget.isFileName
              ? t.chats.copyFileName
              : t.chats.copyText
            : t.chats.copyUnavailableTitle
        }
        aria-label={t.chats.copyText}
        className="flex size-7 cursor-pointer items-center justify-center rounded-full bg-card/90 text-muted-foreground shadow-2xs ring-1 ring-border/70 transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40"
      >
        {copied ? <Check className="size-3.5 text-primary" /> : <Copy className="size-3.5" />}
      </button>

      {onForward && !isRevoked && (copyTarget.text || Boolean(message.media_type)) && (
        <button
          type="button"
          onClick={() => onForward(message)}
          title={t.chats.forwardMessage}
          aria-label={t.chats.forwardMessage}
          className="flex size-7 cursor-pointer items-center justify-center rounded-full bg-card/90 text-muted-foreground shadow-2xs ring-1 ring-border/70 transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <Forward className="size-3.5" />
        </button>
      )}

      {onRevoke && isOut && !isRevoked && (
        <button
          type="button"
          disabled={!isDeviceReady}
          onClick={() => onRevoke(message)}
          title={isDeviceReady ? t.chats.revokeMessage : t.chats.accountCurrentlyOffline}
          aria-label={t.chats.revokeMessage}
          className="flex size-7 cursor-pointer items-center justify-center rounded-full bg-card/90 text-muted-foreground shadow-2xs ring-1 ring-border/70 transition-colors hover:bg-destructive/15 hover:text-destructive focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Trash2 className="size-3.5" />
        </button>
      )}
    </div>
  );
}

export const MessageBubble = memo(function MessageBubble({
  message,
  quoted,
  deviceId,
  isDeviceReady,
  canReactAndReply = true,
  isReactionPickerOpen,
  onToggleReactionPicker,
  onCloseReactionPicker,
  onReact,
  onReply,
  onForward,
  onRevoke,
  onJumpToMessage,
  selectMode = false,
  isSelected = false,
  onToggleSelect,
}: {
  message: MessageInfo;
  quoted: MessageInfo | null | undefined;
  deviceId: string;
  isDeviceReady: boolean;
  canReactAndReply?: boolean;
  isReactionPickerOpen: boolean;
  onToggleReactionPicker: (messageId: string) => void;
  onCloseReactionPicker: () => void;
  onReact: (message: MessageInfo, emoji: string) => void;
  onReply: (message: MessageInfo) => void;
  onForward?: (message: MessageInfo) => void;
  onRevoke?: (message: MessageInfo) => void;
  onJumpToMessage: (messageId: string) => void;
  selectMode?: boolean;
  isSelected?: boolean;
  onToggleSelect?: (messageId: string, shiftKey: boolean) => void;
}) {
  const {lang, t} = useI18n();
  const isOut = message.is_from_me;
  const isRevoked = Boolean(message.is_revoked);
  const hasMedia = Boolean(message.media_type);
  const isSelectable = Boolean(selectMode && isDownloadableMedia(message));
  const copyTarget = resolveCopyTarget(message);
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!copyTarget.text) return;
    const ok = await copyTextWithFallback(copyTarget.text);
    if (ok) {
      setCopied(true);
      toast.success(t.chats.copiedToClipboard);
      window.setTimeout(() => setCopied(false), 1500);
    } else {
      toast.error(t.chats.copyFailedToast);
    }
  };

  const myReactionEmoji = message.reactions?.find((r) => r.is_from_me)?.emoji;
  const groupedReactions = useMemo(
    () => (message.reactions?.length ? groupReactions(message.reactions) : []),
    [message.reactions],
  );

  return (
    <div
      data-message-id={message.id}
      onClick={(event) => {
        if (!isSelectable || !onToggleSelect) return;
        const target = event.target as HTMLElement;
        if (target.closest('a,button,[role="button"],video,audio,[role="dialog"]')) return;
        if (typeof window !== 'undefined' && window.getSelection()?.toString()) return;
        onToggleSelect(message.id, event.shiftKey);
      }}
      className={cn(
        'message-row group w-full px-4 sm:px-8 lg:px-14 transition-colors',
        isSelectable && 'cursor-pointer py-0.5',
        isSelectable &&
          (isSelected ? 'bg-primary/10' : 'hover:bg-black/5 dark:hover:bg-white/5'),
      )}
    >
      <div
        className={cn(
          'mx-auto flex w-full max-w-4xl items-end gap-1.5',
          isOut ? 'ltr:justify-end rtl:justify-start' : 'ltr:justify-start rtl:justify-end',
        )}
      >
        {isSelectable && onToggleSelect && (
          <button
            type="button"
            role="checkbox"
            aria-checked={isSelected}
            aria-label={message.filename || message.media_type}
            onClick={(event) => onToggleSelect(message.id, event.shiftKey)}
            className={cn(
              'mb-1 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md border transition-colors self-center focus-visible:outline-2 focus-visible:outline-ring',
              isOut ? 'ltr:order-last rtl:order-first' : 'ltr:order-first rtl:order-last',
              isSelected
                ? 'border-primary bg-primary text-primary-foreground shadow-xs'
                : 'border-border bg-card/90 text-transparent hover:border-primary/60',
            )}
          >
            <Check className="size-3.5 stroke-[2.5]" />
          </button>
        )}

        <div
          className={cn(
            'max-w-[82%] rounded-xl px-3 py-2 text-[13.5px] leading-relaxed shadow-[0_1px_0.5px_rgba(11,20,26,0.12)] sm:max-w-[68%]',
            isOut
              ? 'rounded-tr-xs bg-bubble-out text-foreground'
              : 'rounded-tl-xs bg-bubble-in text-foreground',
            isRevoked && 'border border-destructive/25',
            isSelectable && isSelected && 'ring-2 ring-primary/80 ring-offset-1 ring-offset-background',
          )}
        >
          {!isOut && message.chat_jid.endsWith('@g.us') && (
            <p className="mb-1 text-xs font-medium text-primary">{senderDisplayName(message)}</p>
          )}

          {quoted !== undefined && (
            <QuotedMessagePreview quoted={quoted} isOut={isOut} onJumpToMessage={onJumpToMessage} />
          )}

          {isRevoked && (
            <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-destructive dark:text-red-400">
              <Ban className="size-3.5 shrink-0" />
              <span>{t.chats.messageDeletedBySender}</span>
            </div>
          )}

          {message.content || hasMedia ? (
            <div className={cn(isRevoked && 'opacity-70')}>
              {message.content && <FormattedText text={message.content} />}
              {hasMedia && <MessageMedia message={message} deviceId={deviceId} />}
            </div>
          ) : isRevoked ? (
            <p className="text-xs italic text-muted-foreground opacity-75">
              {t.chats.messageDeletedNoContent}
            </p>
          ) : null}

          <MessageReactionsBar
            groupedReactions={groupedReactions}
            interactive={canReactAndReply && isDeviceReady && !isRevoked}
            onReact={(emoji) => onReact(message, emoji)}
          />

          <div className="mt-1 flex items-center justify-end gap-1 text-[10.5px] text-muted-foreground tabular-nums">
            <span>{formatDate(message.timestamp, lang)}</span>
            {/* P2-7: "edited" badge + edit time, only on messages the gateway
                reported as edited. Never shown on unedited messages. */}
            {message.is_edited && (
              <>
                <span aria-hidden="true">·</span>
                <span>{t.chats.editedMarker}</span>
                {message.edited_at && (
                  <time
                    dateTime={message.edited_at}
                    title={formatDate(message.edited_at, lang)}
                  >
                    {formatShortTime(message.edited_at, lang)}
                  </time>
                )}
              </>
            )}
            {isOut && <CheckCheck className="size-3.5 text-[#53bdeb]" aria-hidden="true" />}
          </div>
        </div>

        {!selectMode && (
          <MessageBubbleActions
            message={message}
            isOut={isOut}
            isRevoked={isRevoked}
            isDeviceReady={isDeviceReady}
            canReactAndReply={canReactAndReply}
            copyTarget={copyTarget}
            copied={copied}
            isReactionPickerOpen={isReactionPickerOpen}
            myReactionEmoji={myReactionEmoji}
            onToggleReactionPicker={onToggleReactionPicker}
            onCloseReactionPicker={onCloseReactionPicker}
            onReact={onReact}
            onReply={onReply}
            onCopy={() => void handleCopy()}
            onForward={onForward}
            onRevoke={onRevoke}
          />
        )}
      </div>
    </div>
  );
});
