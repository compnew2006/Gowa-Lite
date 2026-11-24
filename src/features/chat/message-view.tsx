import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import {useInfiniteQuery, useMutation, useQueryClient} from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCheck,
  History,
  Image as ImageIcon,
  Loader2,
  Search,
  Send,
  X,
} from 'lucide-react';
import {toast} from 'sonner';
import {
  getUnifiedChatMessages,
  requestUnifiedChatHistory,
  sendUnifiedTextMessage,
} from '@/api/client';
import type {MessageInfo, UnifiedChat} from '@/api/types';
import {ContactAvatar} from '@/components/contact-avatar';
import {Button} from '@/components/ui/button';
import {chatDisplayName, formatJidPhone, senderDisplayName} from '@/features/chat/display-name';
import {FormattedText} from '@/features/chat/formatted-text';
import {MessageMedia} from '@/features/chat/message-media';
import {formatDate, formatDay} from '@/lib/format';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';
import {normalizeSearchInput} from '@/lib/phone';
import {cn} from '@/lib/utils';

const PAGE_SIZE = 40;
const HISTORY_POLL_MS = 2_000;
const HISTORY_POLL_WINDOW_MS = 30_000;
const SCROLL_TOP_THRESHOLD_PX = 140;

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

function MessageBubble({
  message,
  quoted,
  deviceId,
}: {
  message: MessageInfo;
  quoted: MessageInfo | null | undefined;
  deviceId: string;
}) {
  const {lang, t} = useI18n();
  const isOut = message.is_from_me;
  const hasMedia = Boolean(message.media_type);

  return (
    <div
      className={cn(
        'flex',
        isOut ? 'ltr:justify-end rtl:justify-start' : 'ltr:justify-start rtl:justify-end',
      )}
    >
      <div
        className={cn(
          'max-w-[82%] rounded-xl px-3 py-2 text-[13.5px] leading-relaxed shadow-2xs sm:max-w-[68%]',
          isOut
            ? 'rounded-tr-xs bg-bubble-out text-foreground'
            : 'rounded-tl-xs bg-bubble-in text-foreground',
        )}
      >
        {!isOut && message.chat_jid.endsWith('@g.us') && (
          <p className="mb-1 text-xs font-medium text-primary">{senderDisplayName(message)}</p>
        )}

        {quoted !== undefined && (
          <div
            className={cn(
              'mb-2 rounded-md border-s-3 border-primary px-2.5 py-1.5 text-xs',
              isOut ? 'bg-bubble-out-subtle' : 'bg-black/10 dark:bg-black/25',
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

        {message.content && <FormattedText text={message.content} />}
        {hasMedia && <MessageMedia message={message} deviceId={deviceId} />}

        {message.reactions && message.reactions.length > 0 && (
          <p className="mt-1.5 text-xs">{message.reactions.map((r) => r.emoji).join(' ')}</p>
        )}

        <div className="mt-1 flex items-center justify-end gap-1 text-[10.5px] text-muted-foreground tabular-nums">
          <span>{formatDate(message.timestamp, lang)}</span>
          {isOut && <CheckCheck className="size-3.5 text-[#53bdeb]" aria-hidden="true" />}
        </div>
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
  const initialScrolledRef = useRef(false);
  const prevScrollAnchorRef = useRef<{scrollHeight: number; scrollTop: number} | null>(null);
  const stickToBottomRef = useRef(true);

  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [mediaOnly, setMediaOnly] = useState(false);
  const [draft, setDraft] = useState('');
  const [historyPollUntil, setHistoryPollUntil] = useState(0);

  useEffect(() => {
    setSearchOpen(false);
    setSearch('');
    setMediaOnly(false);
    setDraft('');
    setHistoryPollUntil(0);
    initialScrolledRef.current = false;
    prevScrollAnchorRef.current = null;
    stickToBottomRef.current = true;
  }, [chat.device_id, chat.jid]);

  useEffect(() => {
    initialScrolledRef.current = false;
    prevScrollAnchorRef.current = null;
    stickToBottomRef.current = true;
  }, [search, mediaOnly]);

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
    mutationFn: (text: string) => sendUnifiedTextMessage(chat.device_id, chat.jid, text),
    onSuccess: () => {
      setDraft('');
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
    sendMutation.mutate(trimmed);
  };

  const replyTarget = (message: MessageInfo) => {
    const id = repliedToId(message);
    return id === undefined ? undefined : (messagesById.get(id) ?? null);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-chat-canvas">
      {/* Top WhatsApp Conversation Header */}
      <div className="flex h-[58px] shrink-0 items-center justify-between gap-3 border-b border-border bg-card px-4">
        <div className="flex min-w-0 items-center gap-3">
          {onBack && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onBack}
              className={alwaysShowBack ? 'size-8 shrink-0 rounded-full' : 'size-8 shrink-0 rounded-full lg:hidden'}
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

        <form
          onSubmit={handleSend}
          className="mx-auto flex max-w-4xl items-center gap-2 rounded-full border border-border bg-card px-4 py-1.5 shadow-sm"
        >
          <input
            type="text"
            placeholder={
              isDeviceReady
                ? t.chats.replyPlaceholder(chat.device_display_name)
                : t.chats.accountCurrentlyOffline
            }
            value={draft}
            disabled={!isDeviceReady || sendMutation.isPending}
            onChange={(event) => setDraft(event.target.value)}
            className="h-9 min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none disabled:opacity-50"
          />
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
  );
}
