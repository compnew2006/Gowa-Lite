import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
} from 'react';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import {History, Loader2, Paperclip, Trash2} from 'lucide-react';
import {toast} from 'sonner';
import {
  getUnifiedChatMessages,
  listUnifiedChatNotes,
  listUnifiedChatSchedules,
  requestUnifiedChatHistory,
  revokeUnifiedMessage,
  sendUnifiedMediaMessage,
  sendUnifiedMessageReaction,
  sendUnifiedTextMessage,
} from '@/api/client';
import type {ChatInfo, MessageInfo, Pagination, UnifiedChat} from '@/api/types';
import {Button} from '@/components/ui/button';
import {Dialog} from '@/components/ui/dialog';
import {ChatContextDrawer, type ContextDrawerTab} from '@/features/chat/chat-context-drawer';
import {chatDisplayName} from '@/features/chat/display-name';
import {ForwardMessageDialog} from '@/features/chat/forward-message-dialog';
import {MediaSelectionBar} from '@/features/chat/media-selection-bar';
import {MessageBubble} from '@/features/chat/message-bubble';
import {MessageComposer, validateChatMediaFile} from '@/features/chat/message-composer';
import {
  applyOptimisticReaction,
  dayKey,
  repliedToId,
  sortMessagesChronologically,
} from '@/features/chat/message-reactions';
import {MessageViewHeader} from '@/features/chat/message-view-header';
import type {OtherAccountRef} from '@/features/chat/other-accounts';
import {ScheduleMessageDialog} from '@/features/chat/schedule-dialog';
import {useChatReadSync} from '@/features/chat/use-chat-read-sync';
import {useMediaBatch} from '@/features/chat/use-media-batch';
import {formatDay} from '@/lib/format';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';
import {isDownloadableMedia} from '@/lib/media-download';
import {normalizeSearchInput} from '@/lib/phone';

const PAGE_SIZE = 40;
const HISTORY_POLL_MS = 2_000;
const HISTORY_POLL_WINDOW_MS = 30_000;
const SCROLL_TOP_THRESHOLD_PX = 140;

type MessagesPage = {data: MessageInfo[]; pagination: Pagination; chat_info: ChatInfo};

function computeNextMessagePageParam(
  lastPage: MessagesPage,
  allPages: MessagesPage[],
): number | undefined {
  if (typeof lastPage.pagination.next_offset === 'number') {
    const rawCount = lastPage.pagination.raw_count ?? lastPage.data.length;
    const liveTotal = lastPage.pagination.live_total;
    if (rawCount === 0 || lastPage.data.length === 0) return undefined;
    if (typeof liveTotal === 'number' && lastPage.pagination.next_offset >= liveTotal) {
      return undefined;
    }
    return lastPage.pagination.next_offset;
  }
  const loadedCount = allPages.reduce((sum, page) => sum + page.data.length, 0);
  const totalCount = lastPage.pagination.total ?? 0;
  if (lastPage.data.length === 0 || loadedCount >= totalCount) return undefined;
  return loadedCount;
}

export function MessageView({
  chat,
  onBack,
  alwaysShowBack = false,
  otherAccounts = [],
  onSwitchAccount,
}: {
  chat: UnifiedChat;
  onBack?: () => void;
  alwaysShowBack?: boolean;
  otherAccounts?: OtherAccountRef[];
  onSwitchAccount?: (deviceId: string, jid: string) => void;
}) {
  const queryClient = useQueryClient();
  const {lang, t} = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerInputRef = useRef<HTMLInputElement>(null);
  const initialScrolledRef = useRef(false);
  const prevScrollAnchorRef = useRef<{scrollHeight: number; scrollTop: number} | null>(null);
  const stickToBottomRef = useRef(true);

  const dragCounterRef = useRef(0);

  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [mediaOnly, setMediaOnly] = useState(false);
  const [draft, setDraft] = useState('');
  const [attachment, setAttachment] = useState<File | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [replyingTo, setReplyingTo] = useState<MessageInfo | null>(null);
  const [reactionPickerMessageId, setReactionPickerMessageId] = useState<string | null>(null);
  const [historyPollUntil, setHistoryPollUntil] = useState(0);
  const [drawerTab, setDrawerTab] = useState<ContextDrawerTab | null>(null);
  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false);
  const [revokingMessage, setRevokingMessage] = useState<MessageInfo | null>(null);
  const [forwardingMessage, setForwardingMessage] = useState<MessageInfo | null>(null);

  useChatReadSync(chat);

  useEffect(() => {
    setSearchOpen(false);
    setSearch('');
    setMediaOnly(false);
    setDraft('');
    setAttachment(null);
    setIsDragOver(false);
    dragCounterRef.current = 0;
    setReplyingTo(null);
    setReactionPickerMessageId(null);
    setHistoryPollUntil(0);
    setScheduleDialogOpen(false);
    setRevokingMessage(null);
    setForwardingMessage(null);
    initialScrolledRef.current = false;
    prevScrollAnchorRef.current = null;
    stickToBottomRef.current = true;
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
    getNextPageParam: computeNextMessagePageParam,
    refetchInterval: () => (Date.now() < historyPollUntil ? HISTORY_POLL_MS : false),
  });

  const messages = useMemo(() => {
    const pages = query.data?.pages ?? [];
    const byId = new Map<string, MessageInfo>();
    for (const page of pages) {
      for (const msg of page.data) byId.set(msg.id, msg);
    }
    return sortMessagesChronologically(Array.from(byId.values()));
  }, [query.data?.pages]);

  const downloadableMessages = useMemo(
    () => messages.filter(isDownloadableMedia),
    [messages],
  );

  const mediaBatch = useMediaBatch({
    deviceId: chat.device_id,
    chatJid: chat.jid,
    downloadableMessages,
  });

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
      if (heightDelta > 0) el.scrollTop = prevTop + heightDelta;
      prevScrollAnchorRef.current = null;
      return;
    }

    if (stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const maybeLoadOlder = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;

    if (
      initialScrolledRef.current &&
      el.scrollTop <= SCROLL_TOP_THRESHOLD_PX &&
      hasNextPage &&
      !isFetchingNextPage
    ) {
      prevScrollAnchorRef.current = {scrollHeight: el.scrollHeight, scrollTop: el.scrollTop};
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
    onError: (err) => toast.error(toApiError(err).message),
  });

  const sendMediaMutation = useMutation({
    mutationFn: ({file, caption}: {file: File; caption?: string}) =>
      sendUnifiedMediaMessage(chat.device_id, chat.jid, {file, caption}),
    onSuccess: () => {
      setAttachment(null);
      setDraft('');
      setReplyingTo(null);
      stickToBottomRef.current = true;
      void queryClient.invalidateQueries({
        queryKey: ['unified-messages', chat.device_id, chat.jid],
      });
      void queryClient.invalidateQueries({queryKey: ['unified-chats']});
    },
    onError: (err) => toast.error(toApiError(err).message),
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
        for (const [key, data] of context.previous) queryClient.setQueryData(key, data);
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
    onError: (err) => toast.error(toApiError(err).message),
  });

  const revokeMutation = useMutation({
    mutationFn: (messageId: string) => revokeUnifiedMessage(chat.device_id, chat.jid, messageId),
    onMutate: async (messageId) => {
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
                ? {...msg, is_revoked: true, revoked_at: new Date().toISOString()}
                : msg,
            ),
          })),
        };
      });
      return {previous};
    },
    onSuccess: () => {
      toast.success(t.chats.revokedToast);
      setRevokingMessage(null);
    },
    onError: (err, _vars, context) => {
      if (context?.previous) {
        for (const [key, data] of context.previous) queryClient.setQueryData(key, data);
      }
      toast.error(toApiError(err).message);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: ['unified-messages', chat.device_id, chat.jid],
      });
      void queryClient.invalidateQueries({queryKey: ['unified-chats']});
    },
  });

  const isAnySending = sendMutation.isPending || sendMediaMutation.isPending;

  const handleSend = (event: FormEvent) => {
    event.preventDefault();
    if (!isDeviceReady || isAnySending) return;
    const trimmed = draft.trim();
    if (attachment) {
      sendMediaMutation.mutate({file: attachment, caption: trimmed || undefined});
      return;
    }
    if (!trimmed) return;
    sendMutation.mutate({text: trimmed, replyMessageId: replyingTo?.id});
  };

  const handleDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!isDeviceReady || !event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    dragCounterRef.current += 1;
    setIsDragOver(true);
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!isDeviceReady || !event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDragOver(false);
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    dragCounterRef.current = 0;
    setIsDragOver(false);
    if (!isDeviceReady || isAnySending) return;
    const dropped = event.dataTransfer.files?.[0];
    if (!dropped) return;
    const check = validateChatMediaFile(dropped);
    if (check === 'blocked') {
      toast.error(t.chats.mediaBlockedError);
      return;
    }
    if (check === 'too_large') {
      toast.error(t.chats.mediaTooLargeError);
      return;
    }
    setAttachment(dropped);
    window.setTimeout(() => composerInputRef.current?.focus(), 0);
  };

  const handleReact = useCallback(
    (message: MessageInfo, emoji: string) => {
      if (!isDeviceReady) return;
      const myExisting = message.reactions?.find((r) => r.is_from_me && r.emoji === emoji);
      reactionMutation.mutate({messageId: message.id, emoji: myExisting ? '' : emoji});
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
    container.querySelector<HTMLElement>(`[data-message-id="${escapedId}"]`)?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    });
  }, []);

  const replyTarget = (message: MessageInfo) => {
    const id = repliedToId(message);
    return id === undefined ? undefined : (messagesById.get(id) ?? null);
  };

  return (
    <div className="relative flex h-full min-h-0 w-full bg-chat-canvas">
      <div
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className="relative flex min-h-0 min-w-0 flex-1 flex-col"
      >
        {isDragOver && (
          <div className="pointer-events-none absolute inset-3 z-30 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-primary bg-card/90 text-sm font-medium text-primary shadow-md backdrop-blur-[2px]">
            <Paperclip className="size-7" />
            <span>{t.chats.dropMediaHint}</span>
          </div>
        )}
        <MessageViewHeader
          chat={chat}
          displayName={displayName}
          total={total}
          isDeviceReady={isDeviceReady}
          alwaysShowBack={alwaysShowBack}
          otherAccounts={otherAccounts}
          onSwitchAccount={onSwitchAccount}
          onBack={onBack}
          searchOpen={searchOpen}
          search={search}
          onSearchChange={setSearch}
          onToggleSearch={() => setSearchOpen((prev) => !prev)}
          onCloseSearch={() => {
            setSearch('');
            setSearchOpen(false);
          }}
          mediaOnly={mediaOnly}
          onToggleMediaOnly={() => setMediaOnly((prev) => !prev)}
          selectMode={mediaBatch.selectMode}
          selectedMediaCount={mediaBatch.selectedCount}
          onToggleSelectMode={() => {
            setReactionPickerMessageId(null);
            mediaBatch.toggleSelectMode();
          }}
          drawerTab={drawerTab}
          notesCount={notesCount}
          activeScheduledCount={activeScheduledCount}
          onToggleDrawerTab={(tab) => setDrawerTab((prev) => (prev === tab ? null : tab))}
          isHistoryPending={historyMutation.isPending}
          onFetchHistory={() => historyMutation.mutate()}
        />

        <div
          ref={scrollRef}
          onScroll={maybeLoadOlder}
          className="wa-wallpaper min-h-0 flex-1 overflow-y-auto py-4"
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
            <div className="flex flex-col gap-2">
              <div className="mx-auto flex w-full max-w-4xl justify-center px-4 pb-1 sm:px-8 lg:px-14">
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
                      <div className="mx-auto my-1.5 flex w-full max-w-4xl justify-center px-4 sm:px-8 lg:px-14">
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
                      onForward={(msg) => {
                        setReactionPickerMessageId(null);
                        setForwardingMessage(msg);
                      }}
                      onRevoke={(msg) => {
                        setReactionPickerMessageId(null);
                        setRevokingMessage(msg);
                      }}
                      onJumpToMessage={handleJumpToMessage}
                      selectMode={mediaBatch.selectMode}
                      isSelected={mediaBatch.selectedIds.has(message.id)}
                      onToggleSelect={mediaBatch.toggleSelectItem}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {mediaBatch.selectMode && (
          <MediaSelectionBar
            selectedCount={mediaBatch.selectedCount}
            totalDownloadable={mediaBatch.totalDownloadable}
            estimatedBytes={mediaBatch.estimatedBytes}
            batchState={mediaBatch.batchState}
            onSelectAll={mediaBatch.selectAll}
            onClearSelection={mediaBatch.clearSelection}
            onDownloadSeparate={mediaBatch.downloadSeparate}
            onDownloadZip={mediaBatch.downloadZip}
            onRetryFailed={mediaBatch.retryFailed}
            onCancelBatch={mediaBatch.cancelBatch}
            onClose={mediaBatch.toggleSelectMode}
          />
        )}

        <MessageComposer
          inputRef={composerInputRef}
          deviceDisplayName={chat.device_display_name}
          isDeviceReady={isDeviceReady}
          draft={draft}
          attachment={attachment}
          replyingTo={replyingTo}
          isSending={isAnySending}
          onDraftChange={setDraft}
          onAttachmentChange={setAttachment}
          onCancelReply={() => setReplyingTo(null)}
          onOpenSchedule={() => setScheduleDialogOpen(true)}
          onSubmit={handleSend}
        />
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

      <ForwardMessageDialog
        open={Boolean(forwardingMessage)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setForwardingMessage(null);
        }}
        message={forwardingMessage}
        sourceDeviceId={chat.device_id}
        sourceChatJid={chat.jid}
      />

      <Dialog
        open={Boolean(revokingMessage)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !revokeMutation.isPending) setRevokingMessage(null);
        }}
        title={t.chats.revokeConfirmTitle}
        description={t.chats.revokeConfirmDesc}
      >
        <div className="space-y-4">
          {revokingMessage && (revokingMessage.content || revokingMessage.filename) && (
            <div className="rounded-lg border border-border bg-secondary/50 px-3 py-2 text-xs text-foreground/90">
              <p className="line-clamp-3">
                {revokingMessage.content || revokingMessage.filename}
              </p>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={revokeMutation.isPending}
              onClick={() => setRevokingMessage(null)}
            >
              {t.cancel}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={!revokingMessage || revokeMutation.isPending}
              onClick={() => revokingMessage && revokeMutation.mutate(revokingMessage.id)}
            >
              {revokeMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}
              <span>{t.chats.revokeMessage}</span>
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
