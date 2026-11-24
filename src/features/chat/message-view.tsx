import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Ban,
  CalendarClock,
  Check,
  CheckCheck,
  Copy,
  History,
  Image as ImageIcon,
  Loader2,
  Reply,
  Search,
  Send,
  SmilePlus,
  StickyNote,
  X,
} from 'lucide-react';
import {toast} from 'sonner';
import {
  getUnifiedChatMessages,
  listUnifiedChatNotes,
  listUnifiedChatSchedules,
  markUnifiedChatRead,
  requestUnifiedChatHistory,
  sendUnifiedMessageReaction,
  sendUnifiedTextMessage,
} from '@/api/client';
import type {
  ChatInfo,
  MessageInfo,
  Pagination,
  ReactionInfo,
  UnifiedChat,
  UnifiedChatsResponse,
} from '@/api/types';
import {ContactAvatar} from '@/components/contact-avatar';
import {Button} from '@/components/ui/button';
import {ChatContextDrawer, type ContextDrawerTab} from '@/features/chat/chat-context-drawer';
import {chatDisplayName, formatJidPhone, senderDisplayName} from '@/features/chat/display-name';
import {FormattedText} from '@/features/chat/formatted-text';
import {MessageMedia} from '@/features/chat/message-media';
import {ScheduleMessageDialog} from '@/features/chat/schedule-dialog';
import {onWsEvent} from '@/lib/events';
import {formatDate, formatDay} from '@/lib/format';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';
import {normalizeSearchInput} from '@/lib/phone';
import {cn} from '@/lib/utils';

const PAGE_SIZE = 40;
const HISTORY_POLL_MS = 2_000;
const HISTORY_POLL_WINDOW_MS = 30_000;
const SCROLL_TOP_THRESHOLD_PX = 140;
const QUICK_REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

type MessagesPage = {data: MessageInfo[]; pagination: Pagination; chat_info: ChatInfo};

function sortMessagesChronologically(messages: MessageInfo[]): MessageInfo[] {
  return [...messages].sort((a, b) => {
    const ta = new Date(a.timestamp).getTime();
    const tb = new Date(b.timestamp).getTime();
    return ta - tb;
  });
}

function dayKey(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function repliedToId(message: MessageInfo): string | undefined {
  if (!message.context_metadata) return undefined;
  try {
    const parsed = JSON.parse(message.context_metadata) as {replied_to_id?: string};
    return parsed.replied_to_id || undefined;
  } catch {
    return undefined;
  }
}

async function copyTextWithFallback(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to execCommand fallback
    }
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

interface GroupedReaction {
  emoji: string;
  count: number;
  hasMe: boolean;
  senders: string[];
}

function groupReactions(reactions: ReactionInfo[]): GroupedReaction[] {
  const map = new Map<string, GroupedReaction>();
  for (const reaction of reactions) {
    if (!reaction.emoji) continue;
    const senderLabel =
      reaction.sender_display_name || formatJidPhone(reaction.sender_jid) || '';
    const existing = map.get(reaction.emoji);
    if (existing) {
      existing.count += 1;
      if (reaction.is_from_me) existing.hasMe = true;
      if (senderLabel && !existing.senders.includes(senderLabel)) {
        existing.senders.push(senderLabel);
      }
    } else {
      map.set(reaction.emoji, {
        emoji: reaction.emoji,
        count: 1,
        hasMe: Boolean(reaction.is_from_me),
        senders: senderLabel ? [senderLabel] : [],
      });
    }
  }
  return Array.from(map.values());
}

function applyOptimisticReaction(
  reactions: ReactionInfo[] | undefined,
  emoji: string,
): ReactionInfo[] {
  const filtered = (reactions ?? []).filter((r) => !r.is_from_me);
  if (!emoji) return filtered;
  return [
    ...filtered,
    {
      emoji,
      sender_jid: 'me',
      is_from_me: true,
      timestamp: new Date().toISOString(),
    },
  ];
}

function MessageBubble({
  message,
  quoted,
  deviceId,
  isDeviceReady,
  isReactionPickerOpen,
  onToggleReactionPicker,
  onCloseReactionPicker,
  onReact,
  onReply,
  onJumpToMessage,
}: {
  message: MessageInfo;
  quoted: MessageInfo | null | undefined;
  deviceId: string;
  isDeviceReady: boolean;
  isReactionPickerOpen: boolean;
  onToggleReactionPicker: (messageId: string) => void;
  onCloseReactionPicker: () => void;
  onReact: (message: MessageInfo, emoji: string) => void;
  onReply: (message: MessageInfo) => void;
  onJumpToMessage: (messageId: string) => void;
}) {
  const {lang, t} = useI18n();
  const isOut = message.is_from_me;
  const isRevoked = Boolean(message.is_revoked);
  const hasMedia = Boolean(message.media_type);
  const copyableText = message.content?.trim() ? message.content : '';
  const [copied, setCopied] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isReactionPickerOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(event.target as Node)) {
        onCloseReactionPicker();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onCloseReactionPicker();
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isReactionPickerOpen, onCloseReactionPicker]);

  const handleCopy = async () => {
    if (!copyableText) return;
    const ok = await copyTextWithFallback(copyableText);
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
      className={cn(
        'group flex items-end gap-1.5',
        isOut ? 'ltr:justify-end rtl:justify-start' : 'ltr:justify-start rtl:justify-end',
      )}
    >
      {/* Bubble */}
      <div
        className={cn(
          'max-w-[82%] rounded-xl px-3 py-2 text-[13.5px] leading-relaxed shadow-2xs sm:max-w-[68%]',
          isOut
            ? 'rounded-tr-xs bg-bubble-out text-foreground'
            : 'rounded-tl-xs bg-bubble-in text-foreground',
          isRevoked && 'border border-destructive/25',
        )}
      >
        {!isOut && message.chat_jid.endsWith('@g.us') && (
          <p className="mb-1 text-xs font-medium text-primary">{senderDisplayName(message)}</p>
        )}

        {quoted !== undefined && (
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
              'mb-2 rounded-md border-s-3 border-primary px-2.5 py-1.5 text-xs',
              isOut ? 'bg-bubble-out-subtle' : 'bg-black/10 dark:bg-black/25',
              quoted && 'cursor-pointer transition-opacity hover:opacity-90',
            )}
          >
            {quoted ? (
              <>
                <p className="font-medium text-primary">
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

        {groupedReactions.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {groupedReactions.map((reaction) => (
              <button
                key={reaction.emoji}
                type="button"
                disabled={!isDeviceReady || isRevoked}
                onClick={() => onReact(message, reaction.emoji)}
                title={reaction.senders.join('، ')}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs leading-none transition-colors',
                  isDeviceReady && !isRevoked ? 'cursor-pointer hover:bg-muted/80' : 'cursor-default',
                  reaction.hasMe
                    ? 'border-primary/60 bg-primary/15 text-foreground'
                    : 'border-border/80 bg-background/60 text-foreground',
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
        )}

        <div className="mt-1 flex items-center justify-end gap-1 text-[10.5px] text-muted-foreground tabular-nums">
          <span>{formatDate(message.timestamp, lang)}</span>
          {isOut && <CheckCheck className="size-3.5 text-[#53bdeb]" aria-hidden="true" />}
        </div>
      </div>

      {/* Message Actions (React, Reply, Copy) positioned on inner side of bubble */}
      <div
        className={cn(
          'relative flex shrink-0 items-center gap-0.5 self-center transition-opacity',
          isReactionPickerOpen
            ? 'opacity-100'
            : 'opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100',
          isOut ? 'ltr:order-first rtl:order-last' : 'ltr:order-last rtl:order-first',
        )}
      >
        {/* Emoji Reaction Button + Quick Picker */}
        <div ref={pickerRef} className="relative">
          <button
            type="button"
            disabled={!isDeviceReady || isRevoked}
            onClick={() => onToggleReactionPicker(message.id)}
            title={isDeviceReady ? t.chats.addReaction : t.chats.accountCurrentlyOffline}
            aria-label={t.chats.addReaction}
            aria-expanded={isReactionPickerOpen}
            className={cn(
              'flex size-7 cursor-pointer items-center justify-center rounded-full bg-card/90 text-muted-foreground shadow-2xs ring-1 ring-border/70 transition-colors hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40',
              isReactionPickerOpen && 'bg-secondary text-foreground',
            )}
          >
            <SmilePlus className="size-3.5" />
          </button>

          {isReactionPickerOpen && !isRevoked && (
            <div
              role="menu"
              className={cn(
                'absolute bottom-full z-30 mb-1.5 flex items-center gap-0.5 rounded-full border border-border bg-popover px-1.5 py-1 shadow-lg',
                isOut ? 'ltr:right-0 rtl:right-0' : 'ltr:left-0 rtl:left-0',
              )}
            >
              {QUICK_REACTION_EMOJIS.map((emoji) => {
                const isSelected = myReactionEmoji === emoji;
                return (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => {
                      onReact(message, emoji);
                      onCloseReactionPicker();
                    }}
                    className={cn(
                      'flex size-8 cursor-pointer items-center justify-center rounded-full text-base transition-transform hover:scale-115 hover:bg-muted',
                      isSelected && 'bg-primary/15 ring-1 ring-primary/50',
                    )}
                  >
                    {emoji}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Reply Button */}
        <button
          type="button"
          disabled={!isDeviceReady || isRevoked}
          onClick={() => onReply(message)}
          title={isDeviceReady ? t.chats.reply : t.chats.accountCurrentlyOffline}
          aria-label={t.chats.reply}
          className="flex size-7 cursor-pointer items-center justify-center rounded-full bg-card/90 text-muted-foreground shadow-2xs ring-1 ring-border/70 transition-colors hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Reply className="size-3.5" />
        </button>

        {/* Copy Text Button */}
        {copyableText && (
          <button
            type="button"
            onClick={() => void handleCopy()}
            title={t.chats.copyText}
            aria-label={t.chats.copyText}
            className="flex size-7 cursor-pointer items-center justify-center rounded-full bg-card/90 text-muted-foreground shadow-2xs ring-1 ring-border/70 transition-colors hover:bg-secondary hover:text-foreground"
          >
            {copied ? <Check className="size-3.5 text-primary" /> : <Copy className="size-3.5" />}
          </button>
        )}
      </div>
    </div>
  );
}

export function MessageView({
  chat,
  onBack,
  alwaysShowBack = false,
}: {
  chat: UnifiedChat;
  onBack?: () => void;
  alwaysShowBack?: boolean;
}) {
  const queryClient = useQueryClient();
  const {lang, isRtl, t} = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerInputRef = useRef<HTMLInputElement>(null);
  const initialScrolledRef = useRef(false);
  const prevScrollAnchorRef = useRef<{scrollHeight: number; scrollTop: number} | null>(null);
  const stickToBottomRef = useRef(true);
  const markingReadRef = useRef(false);
  const pendingMarkReadRef = useRef(false);
  const lastMarkedKeyRef = useRef('');

  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [mediaOnly, setMediaOnly] = useState(false);
  const [draft, setDraft] = useState('');
  const [replyingTo, setReplyingTo] = useState<MessageInfo | null>(null);
  const [reactionPickerMessageId, setReactionPickerMessageId] = useState<string | null>(null);
  const [historyPollUntil, setHistoryPollUntil] = useState(0);
  const [drawerTab, setDrawerTab] = useState<ContextDrawerTab | null>(null);
  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false);

  useEffect(() => {
    setSearchOpen(false);
    setSearch('');
    setMediaOnly(false);
    setDraft('');
    setReplyingTo(null);
    setReactionPickerMessageId(null);
    setHistoryPollUntil(0);
    setScheduleDialogOpen(false);
    initialScrolledRef.current = false;
    prevScrollAnchorRef.current = null;
    stickToBottomRef.current = true;
    lastMarkedKeyRef.current = '';
  }, [chat.device_id, chat.jid]);

  useEffect(() => {
    initialScrolledRef.current = false;
    prevScrollAnchorRef.current = null;
    stickToBottomRef.current = true;
  }, [search, mediaOnly]);

  const notesQuery = useQuery({
    queryKey: ['unified-chat-notes', chat.device_id, chat.jid],
    queryFn: () => listUnifiedChatNotes(chat.device_id, chat.jid),
  });

  const schedulesQuery = useQuery({
    queryKey: ['unified-chat-schedules', chat.device_id, chat.jid],
    queryFn: () => listUnifiedChatSchedules(chat.device_id, chat.jid),
  });

  const notesCount = notesQuery.data?.notes?.length ?? 0;
  const activeScheduledCount = useMemo(
    () =>
      (schedulesQuery.data?.data ?? []).filter(
        (item) => item.status === 'active' || item.status === 'running' || item.status === 'paused',
      ).length,
    [schedulesQuery.data?.data],
  );

  const markAsRead = useCallback(() => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    if (markingReadRef.current) {
      pendingMarkReadRef.current = true;
      return;
    }
    markingReadRef.current = true;
    pendingMarkReadRef.current = false;

    queryClient.setQueriesData<UnifiedChatsResponse>(
      {queryKey: ['unified-chats']},
      (old) => {
        if (!old) return old;
        let removed = 0;
        const nextData = old.data.map((item) => {
          if (item.device_id === chat.device_id && item.jid === chat.jid) {
            removed = item.unread_count ?? 0;
            return {...item, unread_count: 0};
          }
          return item;
        });
        if (removed === 0) return old;
        const totalUnread =
          typeof old.total_unread === 'number'
            ? Math.max(0, old.total_unread - removed)
            : nextData.reduce((sum, item) => sum + (item.unread_count ?? 0), 0);
        return {...old, data: nextData, total_unread: totalUnread};
      },
    );

    void markUnifiedChatRead(chat.device_id, chat.jid)
      .then(() => {
        void queryClient.invalidateQueries({queryKey: ['unified-chats']});
      })
      .catch(() => {
        // Non-blocking: sidebar will resync on next fetch
      })
      .finally(() => {
        markingReadRef.current = false;
        if (pendingMarkReadRef.current) {
          pendingMarkReadRef.current = false;
          markAsRead();
        }
      });
  }, [chat.device_id, chat.jid, queryClient]);

  useEffect(() => {
    const signature = `${chat.device_id}:${chat.jid}:${chat.unread_count ?? 0}:${chat.last_message_time ?? ''}`;
    if (document.visibilityState === 'visible' && lastMarkedKeyRef.current !== signature) {
      if (lastMarkedKeyRef.current === '' || (chat.unread_count ?? 0) > 0) {
        lastMarkedKeyRef.current = signature;
        markAsRead();
      }
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible' && (chat.unread_count ?? 0) > 0) {
        markAsRead();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [chat.device_id, chat.jid, chat.unread_count, chat.last_message_time, markAsRead]);

  useEffect(() => {
    return onWsEvent((event) => {
      if (event.code !== 'MESSAGE_RECEIVED') return;
      if (event.device_id && event.device_id !== chat.device_id) return;
      const result = event.result as Record<string, unknown> | undefined;
      const eventChatJid =
        typeof result?.chat_id === 'string'
          ? result.chat_id
          : typeof result?.chat_jid === 'string'
            ? result.chat_jid
            : '';
      if (eventChatJid && eventChatJid === chat.jid && document.visibilityState === 'visible') {
        markAsRead();
      }
    });
  }, [chat.device_id, chat.jid, markAsRead]);

  const normalizedSearch = normalizeSearchInput(search);

  const query = useInfiniteQuery({
    queryKey: ['unified-messages', chat.device_id, chat.jid, normalizedSearch, mediaOnly],
    initialPageParam: 0,
    queryFn: ({pageParam}) =>
      getUnifiedChatMessages(chat.device_id, chat.jid, {
        limit: PAGE_SIZE,
        offset: pageParam,
        search: normalizedSearch || undefined,
        media_only: mediaOnly || undefined,
      }),
    getNextPageParam: (lastPage, allPages) => {
      if (typeof lastPage.pagination.next_offset === 'number') {
        const rawCount = lastPage.pagination.raw_count ?? lastPage.data.length;
        const liveTotal = lastPage.pagination.live_total;
        if (rawCount === 0 || lastPage.data.length === 0) {
          return undefined;
        }
        if (typeof liveTotal === 'number' && lastPage.pagination.next_offset >= liveTotal) {
          return undefined;
        }
        return lastPage.pagination.next_offset;
      }
      const loadedCount = allPages.reduce((sum, page) => sum + page.data.length, 0);
      const totalCount = lastPage.pagination.total ?? 0;
      if (lastPage.data.length === 0 || loadedCount >= totalCount) {
        return undefined;
      }
      return loadedCount;
    },
    refetchInterval: () => (Date.now() < historyPollUntil ? HISTORY_POLL_MS : false),
  });

  const messages = useMemo(() => {
    const pages = query.data?.pages ?? [];
    const byId = new Map<string, MessageInfo>();
    for (const page of pages) {
      for (const msg of page.data) {
        byId.set(msg.id, msg);
      }
    }
    return sortMessagesChronologically(Array.from(byId.values()));
  }, [query.data?.pages]);

  const messagesById = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);

  const firstPage = query.data?.pages[0];
  const total = firstPage?.pagination.total ?? 0;
  const resolvedChat = firstPage?.chat_info?.jid === chat.jid ? firstPage.chat_info : chat;
  const displayName = chatDisplayName(resolvedChat);
  const isDeviceReady = chat.device_state === 'logged_in';
  const {hasNextPage, isFetchingNextPage, fetchNextPage} = query;

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || messages.length === 0) return;

    if (!initialScrolledRef.current) {
      el.scrollTop = el.scrollHeight;
      initialScrolledRef.current = true;
      return;
    }

    if (prevScrollAnchorRef.current) {
      const {scrollHeight: prevHeight, scrollTop: prevTop} = prevScrollAnchorRef.current;
      const heightDelta = el.scrollHeight - prevHeight;
      if (heightDelta > 0) {
        el.scrollTop = prevTop + heightDelta;
      }
      prevScrollAnchorRef.current = null;
      return;
    }

    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const maybeLoadOlder = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;

    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 120;

    if (
      initialScrolledRef.current &&
      el.scrollTop <= SCROLL_TOP_THRESHOLD_PX &&
      hasNextPage &&
      !isFetchingNextPage
    ) {
      prevScrollAnchorRef.current = {
        scrollHeight: el.scrollHeight,
        scrollTop: el.scrollTop,
      };
      void fetchNextPage().catch(() => {
        prevScrollAnchorRef.current = null;
      });
    }
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  const sendMutation = useMutation({
    mutationFn: ({text, replyMessageId}: {text: string; replyMessageId?: string}) =>
      sendUnifiedTextMessage(chat.device_id, chat.jid, text, replyMessageId),
    onSuccess: () => {
      setDraft('');
      setReplyingTo(null);
      stickToBottomRef.current = true;
      void queryClient.invalidateQueries({
        queryKey: ['unified-messages', chat.device_id, chat.jid],
      });
      void queryClient.invalidateQueries({queryKey: ['unified-chats']});
    },
    onError: (err) => {
      toast.error(toApiError(err).message);
    },
  });

  const reactionMutation = useMutation({
    mutationFn: ({messageId, emoji}: {messageId: string; emoji: string}) =>
      sendUnifiedMessageReaction(chat.device_id, chat.jid, messageId, emoji),
    onMutate: async ({messageId, emoji}) => {
      const queryKey = ['unified-messages', chat.device_id, chat.jid] as const;
      await queryClient.cancelQueries({queryKey});
      const previous = queryClient.getQueriesData<InfiniteData<MessagesPage>>({queryKey});

      queryClient.setQueriesData<InfiniteData<MessagesPage>>({queryKey}, (old) => {
        if (!old) return old;
        return {
          ...old,
          pages: old.pages.map((page) => ({
            ...page,
            data: page.data.map((msg) =>
              msg.id === messageId
                ? {...msg, reactions: applyOptimisticReaction(msg.reactions, emoji)}
                : msg,
            ),
          })),
        };
      });

      return {previous};
    },
    onError: (err, _vars, context) => {
      if (context?.previous) {
        for (const [key, data] of context.previous) {
          queryClient.setQueryData(key, data);
        }
      }
      toast.error(toApiError(err).message);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: ['unified-messages', chat.device_id, chat.jid],
      });
    },
  });

  const historyMutation = useMutation({
    mutationFn: () => requestUnifiedChatHistory(chat.device_id, chat.jid, PAGE_SIZE),
    onSuccess: () => {
      toast.success(t.chats.historyRequestedToast);
      setHistoryPollUntil(Date.now() + HISTORY_POLL_WINDOW_MS);
    },
    onError: (err) => {
      toast.error(toApiError(err).message);
    },
  });

  const handleSend = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed || sendMutation.isPending || !isDeviceReady) return;
    sendMutation.mutate({text: trimmed, replyMessageId: replyingTo?.id});
  };

  const handleReact = useCallback(
    (message: MessageInfo, emoji: string) => {
      if (!isDeviceReady) return;
      const myExisting = message.reactions?.find((r) => r.is_from_me && r.emoji === emoji);
      const emojiToSend = myExisting ? '' : emoji;
      reactionMutation.mutate({messageId: message.id, emoji: emojiToSend});
    },
    [isDeviceReady, reactionMutation],
  );

  const handleReply = useCallback((message: MessageInfo) => {
    setReplyingTo(message);
    setReactionPickerMessageId(null);
    window.setTimeout(() => composerInputRef.current?.focus(), 0);
  }, []);

  const handleJumpToMessage = useCallback((messageId: string) => {
    const container = scrollRef.current;
    if (!container) return;
    const escapedId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(messageId) : messageId;
    const target = container.querySelector<HTMLElement>(`[data-message-id="${escapedId}"]`);
    target?.scrollIntoView({behavior: 'smooth', block: 'center'});
  }, []);

  const replyTarget = (message: MessageInfo) => {
    const id = repliedToId(message);
    return id === undefined ? undefined : (messagesById.get(id) ?? null);
  };

  return (
    <div className="relative flex h-full min-h-0 w-full bg-chat-canvas">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Top WhatsApp Conversation Header */}
        <div className="flex h-[58px] shrink-0 items-center justify-between gap-3 border-b border-border bg-card px-4">
        <div className="flex min-w-0 items-center gap-3">
          {onBack && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onBack}
              className={
                alwaysShowBack ? 'size-8 shrink-0 rounded-full' : 'size-8 shrink-0 rounded-full lg:hidden'
              }
              aria-label={t.chats.backToChatsAria}
              title={t.chats.backToChatsAria}
            >
              {isRtl ? <ArrowRight className="size-4" /> : <ArrowLeft className="size-4" />}
            </Button>
          )}
          <ContactAvatar
            deviceId={chat.device_id}
            jid={chat.jid}
            name={displayName}
            sizeClass="size-10"
            eager
          />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <h2 className="truncate text-[15px] font-semibold text-foreground">{displayName}</h2>
              <span className="hidden text-xs text-muted-foreground sm:inline">·</span>
              <span
                dir="ltr"
                className="hidden truncate font-mono text-xs text-muted-foreground tabular-nums sm:inline"
              >
                {formatJidPhone(chat.jid)}
              </span>
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {t.chats.autoReplyVia}{' '}
              <span className="font-medium text-primary">{chat.device_display_name}</span>
              {total > 0 && (
                <span className="tabular-nums">{t.chats.messagesCount(total)}</span>
              )}
              {!isDeviceReady && (
                <span className="text-destructive">{t.chats.accountOfflineInline}</span>
              )}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          {searchOpen && (
            <div className="flex items-center gap-1 rounded-full bg-secondary px-3 py-1">
              <input
                type="search"
                autoFocus
                placeholder={t.chats.searchMessagesPlaceholder}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="w-32 bg-transparent text-xs text-foreground placeholder:text-muted-foreground focus:outline-none sm:w-44"
              />
              <button
                type="button"
                onClick={() => {
                  setSearch('');
                  setSearchOpen(false);
                }}
                aria-label={t.close}
                className="cursor-pointer text-muted-foreground hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            </div>
          )}

          <button
            type="button"
            onClick={() => setDrawerTab((prev) => (prev === 'notes' ? null : 'notes'))}
            title={t.chats.notesTitle}
            aria-label={t.chats.notesTitle}
            aria-pressed={drawerTab === 'notes'}
            className={cn(
              'flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-full px-2.5 transition-colors',
              drawerTab === 'notes'
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
            )}
          >
            <StickyNote className="size-4" />
            {notesCount > 0 && (
              <span className="text-[11px] font-semibold tabular-nums">{notesCount}</span>
            )}
          </button>

          <button
            type="button"
            onClick={() => setDrawerTab((prev) => (prev === 'scheduled' ? null : 'scheduled'))}
            title={t.chats.scheduledMessagesTitle}
            aria-label={t.chats.scheduledMessagesTitle}
            aria-pressed={drawerTab === 'scheduled'}
            className={cn(
              'flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-full px-2.5 transition-colors',
              drawerTab === 'scheduled'
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
            )}
          >
            <CalendarClock className="size-4" />
            {activeScheduledCount > 0 && (
              <span className="text-[11px] font-semibold tabular-nums">
                {activeScheduledCount}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => setMediaOnly((prev) => !prev)}
            title={t.chats.mediaOnly}
            aria-label={t.chats.mediaOnly}
            aria-pressed={mediaOnly}
            className={cn(
              'flex size-9 cursor-pointer items-center justify-center rounded-full transition-colors',
              mediaOnly
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
            )}
          >
            <ImageIcon className="size-4" />
          </button>

          <button
            type="button"
            onClick={() => setSearchOpen((prev) => !prev)}
            title={t.chats.searchMessagesPlaceholder}
            aria-label={t.chats.searchMessagesPlaceholder}
            aria-pressed={searchOpen}
            className={cn(
              'flex size-9 cursor-pointer items-center justify-center rounded-full transition-colors',
              searchOpen
                ? 'bg-secondary text-foreground'
                : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
            )}
          >
            <Search className="size-4" />
          </button>

          <button
            type="button"
            disabled={historyMutation.isPending}
            onClick={() => historyMutation.mutate()}
            title={t.chats.fetchOlderFromPhone}
            aria-label={t.chats.fetchOlderFromPhone}
            className="flex size-9 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50"
          >
            {historyMutation.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <History className="size-4" />
            )}
          </button>
        </div>
      </div>

      {/* WhatsApp Doodle Canvas with Upward Infinite Scroll */}
      <div
        ref={scrollRef}
        onScroll={maybeLoadOlder}
        className="wa-wallpaper min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-8 lg:px-14"
      >
        {query.isLoading ? (
          <div className="flex items-center justify-center gap-2 p-10 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            <span>{t.chats.loadingMessages}</span>
          </div>
        ) : query.isError ? (
          <div className="p-8 text-center text-sm text-destructive">
            {toApiError(query.error).message}
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-1.5 p-10 text-center text-sm text-muted-foreground">
            <p>{t.chats.noMessagesYet}</p>
            <p className="text-xs">{t.chats.noMessagesHint}</p>
          </div>
        ) : (
          <div className="mx-auto flex max-w-4xl flex-col gap-2">
            <div className="flex justify-center pb-1">
              {isFetchingNextPage ? (
                <div className="flex items-center gap-2 rounded-lg bg-card/90 px-3 py-1 text-xs text-muted-foreground shadow-2xs">
                  <Loader2 className="size-3.5 animate-spin" />
                  <span>{t.chats.loadingOlderMessages}</span>
                </div>
              ) : !hasNextPage && total > 0 ? (
                <button
                  type="button"
                  disabled={historyMutation.isPending}
                  onClick={() => historyMutation.mutate()}
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-card/90 px-3 py-1 text-xs text-muted-foreground shadow-2xs transition-colors hover:text-foreground disabled:opacity-50"
                >
                  {historyMutation.isPending ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <History className="size-3.5" />
                  )}
                  <span>{t.chats.fetchOlderFromPhone}</span>
                </button>
              ) : null}
            </div>

            {messages.map((message, index) => {
              const showDate =
                index === 0 || dayKey(message.timestamp) !== dayKey(messages[index - 1].timestamp);
              return (
                <div key={message.id} className="flex flex-col gap-2">
                  {showDate && (
                    <div className="my-1.5 flex justify-center">
                      <span className="rounded-lg bg-card/95 px-3 py-1 text-[11px] font-medium text-muted-foreground shadow-2xs">
                        {formatDay(message.timestamp, lang)}
                      </span>
                    </div>
                  )}
                  <MessageBubble
                    message={message}
                    quoted={replyTarget(message)}
                    deviceId={chat.device_id}
                    isDeviceReady={isDeviceReady}
                    isReactionPickerOpen={reactionPickerMessageId === message.id}
                    onToggleReactionPicker={(id) =>
                      setReactionPickerMessageId((prev) => (prev === id ? null : id))
                    }
                    onCloseReactionPicker={() => setReactionPickerMessageId(null)}
                    onReact={handleReact}
                    onReply={handleReply}
                    onJumpToMessage={handleJumpToMessage}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Floating Bottom Composer */}
      <div className="wa-wallpaper shrink-0 px-3 pb-3 pt-1.5">
        {!isDeviceReady && (
          <div className="mx-auto mb-2 flex max-w-4xl items-center gap-2 rounded-xl border border-destructive/30 bg-card/95 px-3 py-2 text-xs text-destructive">
            <AlertTriangle className="size-4 shrink-0" />
            <span>{t.chats.offlineSendBanner(chat.device_display_name)}</span>
          </div>
        )}

        {replyingTo && (
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
              onClick={() => setReplyingTo(null)}
              aria-label={t.chats.cancelReply}
              title={t.chats.cancelReply}
              className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </div>
        )}

        <form
          onSubmit={handleSend}
          className="mx-auto flex max-w-4xl items-center gap-2 rounded-full border border-border bg-card px-4 py-1.5 shadow-sm"
        >
          <input
            ref={composerInputRef}
            type="text"
            placeholder={
              isDeviceReady
                ? t.chats.replyPlaceholder(chat.device_display_name)
                : t.chats.accountCurrentlyOffline
            }
            value={draft}
            disabled={!isDeviceReady || sendMutation.isPending}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && replyingTo) {
                event.preventDefault();
                setReplyingTo(null);
              }
            }}
            className="h-9 min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none disabled:opacity-50"
          />
          <button
            type="button"
            disabled={sendMutation.isPending}
            onClick={() => setScheduleDialogOpen(true)}
            title={t.chats.scheduleMessageBtn}
            aria-label={t.chats.scheduleMessageBtn}
            className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          >
            <CalendarClock className="size-4" />
          </button>
          <button
            type="submit"
            aria-label={t.chats.send}
            title={t.chats.send}
            disabled={!isDeviceReady || sendMutation.isPending || !draft.trim()}
            className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {sendMutation.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Send className="size-4" />
            )}
          </button>
        </form>
      </div>
    </div>

    {drawerTab && (
      <ChatContextDrawer
        chat={chat}
        activeTab={drawerTab}
        notesCount={notesCount}
        scheduledCount={activeScheduledCount}
        onTabChange={setDrawerTab}
        onClose={() => setDrawerTab(null)}
        onOpenCreateSchedule={() => setScheduleDialogOpen(true)}
      />
    )}

    <ScheduleMessageDialog
      open={scheduleDialogOpen}
      onOpenChange={setScheduleDialogOpen}
      chat={chat}
      initialMessage={draft}
      onScheduled={(submittedMessage) => {
        if (draft.trim() === submittedMessage) {
          setDraft('');
          setReplyingTo(null);
        }
      }}
    />
  </div>
  );
}
