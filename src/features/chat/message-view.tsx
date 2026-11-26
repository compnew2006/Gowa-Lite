import {
  Suspense,
  lazy,
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
import {Hand, Loader2, Lock, Paperclip, RefreshCw, RotateCcw, Trash2} from 'lucide-react';
import {toast} from 'sonner';
import {
  blockUnifiedChat,
  claimUnifiedChat,
  closeUnifiedChat,
  getChatLifecycle,
  getInboxPolicy,
  getUnifiedChatMessages,
  listUnifiedChatNotes,
  listUnifiedChatSchedules,
  releaseUnifiedChat,
  reopenUnifiedChat,
  requestUnifiedChatHistory,
  revokeUnifiedMessage,
  sendUnifiedMediaMessage,
  sendUnifiedMessageReaction,
  sendUnifiedTextMessage,
} from '@/api/client';
import type {
  ChatAssignmentInfo,
  ChatInfo,
  ChatLifecycleEvent,
  ChatLifecycleResponse,
  ChatRedactionReason,
  MessageInfo,
  Pagination,
  UnifiedChat,
} from '@/api/types';
import {Button} from '@/components/ui/button';
import {Dialog} from '@/components/ui/dialog';
import type {ContextDrawerTab} from '@/features/chat/chat-context-drawer';
import {chatDisplayName} from '@/features/chat/display-name';
import {MediaSelectionBar} from '@/features/chat/media-selection-bar';
import {MessageBubble} from '@/features/chat/message-bubble';
import {
  MessageComposer,
  validateChatMediaFile,
  type ComposerLockState,
} from '@/features/chat/message-composer';
import {
  applyMessageReaction,
  dayKey,
  repliedToId,
  sortMessagesChronologically,
  updateMessageReactions,
} from '@/features/chat/message-reactions';
import {MessageViewHeader} from '@/features/chat/message-view-header';
import type {OtherAccountRef} from '@/features/chat/other-accounts';
import {
  computeTimelineScrollAction,
  isNearBottom,
  scrollContainerToBottom,
} from '@/features/chat/scroll-behavior';

const AssignChatDialog = lazy(() =>
  import('@/features/chat/assign-chat-dialog').then((m) => ({default: m.AssignChatDialog})),
);
const ChatContextDrawer = lazy(() =>
  import('@/features/chat/chat-context-drawer').then((m) => ({default: m.ChatContextDrawer})),
);
const ForwardMessageDialog = lazy(() =>
  import('@/features/chat/forward-message-dialog').then((m) => ({default: m.ForwardMessageDialog})),
);
const ScheduleMessageDialog = lazy(() =>
  import('@/features/chat/schedule-dialog').then((m) => ({default: m.ScheduleMessageDialog})),
);
import {useChatReadSync} from '@/features/chat/use-chat-read-sync';
import {useMediaBatch} from '@/features/chat/use-media-batch';
import {formatDay, formatShortTime} from '@/lib/format';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';
import {isDownloadableMedia} from '@/lib/media-download';
import {normalizeSearchInput} from '@/lib/phone';
import {hasUserPermission, useAuthStore} from '@/stores/auth';

type TimelineItem =
  | {kind: 'message'; key: string; timestamp: string; timestampMs: number; message: MessageInfo}
  | {kind: 'lifecycle'; key: string; timestamp: string; timestampMs: number; event: ChatLifecycleEvent};

function formatLifecycleEventText(
  event: ChatLifecycleEvent,
  t: ReturnType<typeof useI18n>['t'],
): string {
  const actor = event.actor_name || '—';
  const target = event.target_name || '—';
  switch (event.event_type) {
    case 'claimed':
      return t.chats.timelineEvents.claimed(actor);
    case 'auto_claimed':
      return t.chats.timelineEvents.auto_claimed(actor);
    case 'assigned':
      return t.chats.timelineEvents.assigned(actor, target);
    case 'transferred':
      return t.chats.timelineEvents.transferred(actor, target);
    case 'released':
      return t.chats.timelineEvents.released(actor);
    case 'closed':
      return t.chats.timelineEvents.closed(actor);
    case 'reopened':
      return t.chats.timelineEvents.reopened(actor, event.target_name || undefined);
    case 'reopened_by_customer':
      return t.chats.timelineEvents.reopened_by_customer;
  }
}

const PAGE_SIZE = 40;
const HISTORY_POLL_MS = 2_000;
const HISTORY_POLL_WINDOW_MS = 30_000;
const REACTION_FALLBACK_POLL_MS = 12_000;
const SCROLL_TOP_THRESHOLD_PX = 140;

type MessagesPage = {
  data: MessageInfo[];
  pagination: Pagination;
  chat_info: ChatInfo;
  content_redacted?: boolean;
  redaction_reason?: ChatRedactionReason;
  reaction_webhook_configured?: boolean;
};

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
  embeddedInGroup = false,
  otherAccounts = [],
  onSwitchAccount,
}: {
  chat: UnifiedChat;
  onBack?: () => void;
  alwaysShowBack?: boolean;
  embeddedInGroup?: boolean;
  otherAccounts?: OtherAccountRef[];
  onSwitchAccount?: (deviceId: string, jid: string) => void;
}) {
  const queryClient = useQueryClient();
  const {lang, t} = useI18n();
  const user = useAuthStore((s) => s.user);
  const canWriteChats = hasUserPermission(user, 'chats:write');
  const canRevokeChats = hasUserPermission(user, 'chats:revoke');
  const canAssignChats = hasUserPermission(user, 'chats:assign');
  const canCloseChats = hasUserPermission(user, 'chats:close');
  const canViewAllChats = hasUserPermission(user, 'chats:view_all');
  const canReadNotes = hasUserPermission(user, 'notes:read');
  const canReadSchedules = hasUserPermission(user, 'schedules:read');
  const canWriteSchedules = hasUserPermission(user, 'schedules:write');
  const scrollRef = useRef<HTMLDivElement>(null);
  const timelineContentRef = useRef<HTMLDivElement>(null);
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
  const pendingReactions = useRef(new Set<string>());
  const autoHistoryRequestedRef = useRef<Set<string>>(new Set());
  const [historyPollUntil, setHistoryPollUntil] = useState(0);
  const [autoHistoryActive, setAutoHistoryActive] = useState(false);
  const [autoHistoryFailed, setAutoHistoryFailed] = useState(false);
  const [drawerTab, setDrawerTab] = useState<ContextDrawerTab | null>(null);
  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false);
  const [assignDialogOpen, setAssignDialogOpen] = useState(false);
  const [revokingMessage, setRevokingMessage] = useState<MessageInfo | null>(null);
  const [forwardingMessage, setForwardingMessage] = useState<MessageInfo | null>(null);

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
    setAutoHistoryActive(false);
    setAutoHistoryFailed(false);
    setScheduleDialogOpen(false);
    setAssignDialogOpen(false);
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

  const lowerJid = chat.jid.toLowerCase();
  const isLifecycleSupported =
    !lowerJid.endsWith('@newsletter') &&
    !lowerJid.endsWith('@g.us') &&
    lowerJid !== 'status@broadcast';

  const lifecycleQuery = useQuery({
    queryKey: ['chat-lifecycle', chat.device_id, chat.jid],
    queryFn: () => getChatLifecycle(chat.device_id, chat.jid),
    enabled: isLifecycleSupported,
  });

  const policyQuery = useQuery({
    queryKey: ['inbox-policy'],
    queryFn: getInboxPolicy,
    enabled: isLifecycleSupported,
    staleTime: 30_000,
  });

  const effectiveLifecycle = isLifecycleSupported
    ? (lifecycleQuery.data?.assignment ?? chat.lifecycle)
    : undefined;

  const redactionReasonFromLifecycle: ChatRedactionReason | undefined =
    isLifecycleSupported && effectiveLifecycle && !canViewAllChats
      ? effectiveLifecycle.status === 'closed'
        ? 'closed'
        : effectiveLifecycle.status === 'open'
          ? effectiveLifecycle.assigned_user_id !== null &&
            user?.id !== undefined &&
            effectiveLifecycle.assigned_user_id !== user.id
            ? 'assigned_other'
            : undefined
          : 'pending'
      : undefined;

  const normalizedSearch = normalizeSearchInput(search);

  const query = useInfiniteQuery({
    queryKey: ['unified-messages', chat.device_id, chat.jid, normalizedSearch, mediaOnly],
    initialPageParam: 0,
    queryFn: ({pageParam, signal}) =>
      getUnifiedChatMessages(chat.device_id, chat.jid, {
        limit: PAGE_SIZE,
        offset: pageParam,
        search: normalizedSearch || undefined,
        media_only: mediaOnly || undefined,
      }, signal),
    getNextPageParam: computeNextMessagePageParam,
    refetchInterval: (query) => {
      if (Date.now() < historyPollUntil) return HISTORY_POLL_MS;
      const page = query.state.data?.pages[0];
      return page && !page.content_redacted && page.reaction_webhook_configured === false
        ? REACTION_FALLBACK_POLL_MS
        : false;
    },
  });

  const firstPage = query.data?.pages[0];
  const redactionReason = firstPage?.redaction_reason ?? redactionReasonFromLifecycle;
  const isContentRedacted = Boolean(firstPage?.content_redacted || redactionReasonFromLifecycle);

  useChatReadSync(chat, isContentRedacted);

  useEffect(() => {
    initialScrolledRef.current = false;
    prevScrollAnchorRef.current = null;
    stickToBottomRef.current = true;
    if (isContentRedacted) {
      setSearchOpen(false);
      setSearch('');
      setMediaOnly(false);
      setDrawerTab(null);
    }
  }, [isContentRedacted]);

  const notesQuery = useQuery({
    queryKey: ['unified-chat-notes', chat.device_id, chat.jid],
    queryFn: () => listUnifiedChatNotes(chat.device_id, chat.jid),
    enabled: canReadNotes && !isContentRedacted && (Boolean(firstPage) || drawerTab === 'notes'),
  });

  const schedulesQuery = useQuery({
    queryKey: ['unified-chat-schedules', chat.device_id, chat.jid],
    queryFn: () => listUnifiedChatSchedules(chat.device_id, chat.jid),
    enabled: canReadSchedules && !isContentRedacted && (Boolean(firstPage) || drawerTab === 'scheduled'),
  });

  const notesCount = notesQuery.data?.notes?.length ?? 0;
  const activeScheduledCount = useMemo(
    () =>
      (schedulesQuery.data?.data ?? []).filter(
        (item) => item.status === 'active' || item.status === 'running' || item.status === 'paused',
      ).length,
    [schedulesQuery.data?.data],
  );

  const messages = useMemo(() => {
    if (isContentRedacted) return [];
    const pages = query.data?.pages ?? [];
    const byId = new Map<string, MessageInfo>();
    for (const page of pages) {
      for (const msg of page.data) byId.set(msg.id, msg);
    }
    return sortMessagesChronologically(Array.from(byId.values()));
  }, [isContentRedacted, query.data?.pages]);

  const downloadableMessages = useMemo(
    () => (isContentRedacted ? [] : messages.filter(isDownloadableMedia)),
    [isContentRedacted, messages],
  );

  const mediaBatch = useMediaBatch({
    deviceId: chat.device_id,
    chatJid: chat.jid,
    downloadableMessages,
  });

  const messagesById = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  const total = firstPage?.pagination.total ?? 0;
  const resolvedChat = firstPage?.chat_info?.jid === chat.jid ? firstPage.chat_info : chat;
  const displayName = chatDisplayName(resolvedChat);
  const isDeviceReady = chat.device_state === 'logged_in';
  const {hasNextPage, isFetchingNextPage, fetchNextPage} = query;

  useEffect(() => {
    if (
      !query.isSuccess ||
      query.isFetching ||
      isContentRedacted ||
      normalizedSearch ||
      mediaOnly ||
      !isDeviceReady ||
      messages.length > 0
    ) {
      return;
    }
    const requestKey = `${chat.device_id}::${chat.jid}`;
    if (autoHistoryRequestedRef.current.has(requestKey)) return;
    autoHistoryRequestedRef.current.add(requestKey);

    let cancelled = false;
    setAutoHistoryFailed(false);
    setAutoHistoryActive(true);
    setHistoryPollUntil(Date.now() + HISTORY_POLL_WINDOW_MS);

    void requestUnifiedChatHistory(chat.device_id, chat.jid, PAGE_SIZE).catch(() => {
      if (cancelled) return;
      setAutoHistoryActive(false);
      setHistoryPollUntil(0);
      setAutoHistoryFailed(true);
    });

    return () => {
      cancelled = true;
    };
  }, [
    chat.device_id,
    chat.jid,
    isContentRedacted,
    isDeviceReady,
    mediaOnly,
    messages.length,
    normalizedSearch,
    query.isFetching,
    query.isSuccess,
  ]);

  useEffect(() => {
    if (!autoHistoryActive) return;
    if (messages.length > 0) {
      setAutoHistoryActive(false);
      setHistoryPollUntil(0);
      return;
    }
    const remaining = Math.max(0, historyPollUntil - Date.now());
    const timer = window.setTimeout(() => {
      setAutoHistoryActive(false);
    }, remaining || HISTORY_POLL_WINDOW_MS);
    return () => window.clearTimeout(timer);
  }, [autoHistoryActive, historyPollUntil, messages.length]);

  const lifecycleEvents = useMemo(() => {
    if (!isLifecycleSupported || isContentRedacted || normalizedSearch || mediaOnly) return [];
    return lifecycleQuery.data?.events ?? [];
  }, [isContentRedacted, isLifecycleSupported, lifecycleQuery.data?.events, mediaOnly, normalizedSearch]);

  const timelineItems = useMemo<TimelineItem[]>(() => {
    const items: TimelineItem[] = messages.map((msg) => ({
      kind: 'message',
      key: `msg:${msg.id}`,
      timestamp: msg.timestamp,
      timestampMs: Date.parse(msg.timestamp) || 0,
      message: msg,
    }));
    for (const event of lifecycleEvents) {
      items.push({
        kind: 'lifecycle',
        key: `life:${event.id}`,
        timestamp: event.created_at,
        timestampMs: event.created_at_ms || Date.parse(event.created_at) || 0,
        event,
      });
    }
    items.sort((a, b) => {
      if (a.timestampMs !== b.timestampMs) return a.timestampMs - b.timestampMs;
      if (a.kind !== b.kind) return a.kind === 'message' ? -1 : 1;
      return a.key.localeCompare(b.key);
    });
    return items;
  }, [lifecycleEvents, messages]);

  const {lockState, autoReopenHint} = useMemo<{
    lockState: ComposerLockState | undefined;
    autoReopenHint: boolean;
  }>(() => {
    if (chat.is_blocked) {
      return {lockState: {reason: 'blocked'}, autoReopenHint: false};
    }
    if (!isLifecycleSupported || !effectiveLifecycle) {
      return {lockState: undefined, autoReopenHint: false};
    }
    const policy = policyQuery.data;
    if (effectiveLifecycle.status === 'closed') {
      if (
        policy?.closed_reply_policy === 'reopen_and_claim' &&
        (canCloseChats || canViewAllChats)
      ) {
        return {lockState: undefined, autoReopenHint: true};
      }
      return {
        lockState: {
          reason: 'closed',
          closedByName: effectiveLifecycle.closed_by_name,
        },
        autoReopenHint: false,
      };
    }
    if (
      effectiveLifecycle.status === 'open' &&
      effectiveLifecycle.assigned_user_id !== null &&
      user?.id !== undefined &&
      effectiveLifecycle.assigned_user_id !== user.id &&
      !canViewAllChats
    ) {
      return {
        lockState: {
          reason: 'assigned_other',
          ownerName: effectiveLifecycle.assigned_user_name || '',
        },
        autoReopenHint: false,
      };
    }
    if (
      effectiveLifecycle.status === 'pending' &&
      policy?.unassigned_reply_policy === 'require_claim'
    ) {
      return {
        lockState: {reason: 'claim_required'},
        autoReopenHint: false,
      };
    }
    return {lockState: undefined, autoReopenHint: false};
  }, [
    canCloseChats,
    canViewAllChats,
    chat.is_blocked,
    effectiveLifecycle,
    isLifecycleSupported,
    policyQuery.data,
    user?.id,
  ]);

  const isSendingBlocked = Boolean(lockState);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    const action = computeTimelineScrollAction({
      hasElement: Boolean(el),
      itemCount: timelineItems.length,
      isContentRedacted,
      initialScrolled: initialScrolledRef.current,
      prevAnchor: prevScrollAnchorRef.current,
      stickToBottom: stickToBottomRef.current,
    });
    if (!el || action === 'none') return;

    if (action === 'preserve_anchor' && prevScrollAnchorRef.current) {
      const {scrollHeight: prevHeight, scrollTop: prevTop} = prevScrollAnchorRef.current;
      const heightDelta = el.scrollHeight - prevHeight;
      if (heightDelta > 0) el.scrollTop = prevTop + heightDelta;
      prevScrollAnchorRef.current = null;
      return;
    }

    if (action === 'scroll_bottom') {
      const wasInitial = !initialScrolledRef.current;
      scrollContainerToBottom(el);
      initialScrolledRef.current = true;
      if (wasInitial) {
        stickToBottomRef.current = true;
        window.requestAnimationFrame(() => {
          if (scrollRef.current && stickToBottomRef.current && !prevScrollAnchorRef.current) {
            scrollContainerToBottom(scrollRef.current);
          }
        });
      }
    }
  }, [isContentRedacted, timelineItems]);

  useEffect(() => {
    if (isContentRedacted || timelineItems.length === 0 || typeof ResizeObserver === 'undefined') {
      return;
    }
    const contentEl = timelineContentRef.current;
    if (!contentEl) return;

    const observer = new ResizeObserver(() => {
      const scrollEl = scrollRef.current;
      if (!scrollEl || !stickToBottomRef.current || prevScrollAnchorRef.current) return;
      scrollContainerToBottom(scrollEl);
    });
    observer.observe(contentEl);
    return () => observer.disconnect();
  }, [isContentRedacted, timelineItems.length]);

  const maybeLoadOlder = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = isNearBottom(el);

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

  const invalidateLifecycleScope = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: ['chat-lifecycle', chat.device_id, chat.jid],
    });
    void queryClient.invalidateQueries({
      queryKey: ['unified-messages', chat.device_id, chat.jid],
    });
    void queryClient.invalidateQueries({
      queryKey: ['unified-chat-notes', chat.device_id, chat.jid],
    });
    void queryClient.invalidateQueries({
      queryKey: ['unified-chat-schedules', chat.device_id, chat.jid],
    });
    void queryClient.invalidateQueries({queryKey: ['unified-chats']});
    void queryClient.invalidateQueries({queryKey: ['assignable-agents', chat.device_id]});
  }, [chat.device_id, chat.jid, queryClient]);

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
      invalidateLifecycleScope();
    },
    onError: (err) => {
      toast.error(toApiError(err).message);
      invalidateLifecycleScope();
      void queryClient.invalidateQueries({queryKey: ['inbox-policy']});
    },
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
      invalidateLifecycleScope();
    },
    onError: (err) => {
      toast.error(toApiError(err).message);
      invalidateLifecycleScope();
      void queryClient.invalidateQueries({queryKey: ['inbox-policy']});
    },
  });

  const applyLifecycleMutationResult = useCallback(
    (data: {assignment: ChatAssignmentInfo; event?: ChatLifecycleEvent}) => {
      if (data.assignment.status === 'open') {
        initialScrolledRef.current = false;
        prevScrollAnchorRef.current = null;
        stickToBottomRef.current = true;
      }
      queryClient.setQueryData<ChatLifecycleResponse>(
        ['chat-lifecycle', chat.device_id, chat.jid],
        (prev) => {
          const prevEvents = prev?.events ?? [];
          const nextEvents =
            data.event && !prevEvents.some((ev) => ev.id === data.event!.id)
              ? [...prevEvents, data.event]
              : prevEvents;
          return {
            assignment: data.assignment,
            events: nextEvents,
          };
        },
      );
      invalidateLifecycleScope();
      if (data.assignment.status === 'open') {
        window.requestAnimationFrame(() => {
          if (scrollRef.current && stickToBottomRef.current && !prevScrollAnchorRef.current) {
            scrollContainerToBottom(scrollRef.current);
          }
        });
      }
    },
    [chat.device_id, chat.jid, invalidateLifecycleScope, queryClient],
  );

  const claimMutation = useMutation({
    mutationFn: () => claimUnifiedChat(chat.device_id, chat.jid, displayName),
    onSuccess: (data) => {
      toast.success(t.chats.claimedToast);
      applyLifecycleMutationResult(data);
    },
    onError: (err) => {
      toast.error(toApiError(err).message);
      invalidateLifecycleScope();
    },
  });

  const releaseMutation = useMutation({
    mutationFn: () => releaseUnifiedChat(chat.device_id, chat.jid, {cached_title: displayName}),
    onSuccess: (data) => {
      toast.success(t.chats.unassignedToast);
      applyLifecycleMutationResult(data);
    },
    onError: (err) => {
      toast.error(toApiError(err).message);
      invalidateLifecycleScope();
    },
  });

  const closeMutation = useMutation({
    mutationFn: () => closeUnifiedChat(chat.device_id, chat.jid, {cached_title: displayName}),
    onSuccess: (data) => {
      if (data.rating_prompt === 'failed') toast.warning(t.chats.ratingPromptFailed);
      else toast.success(t.chats.closedToast);
      applyLifecycleMutationResult(data);
    },
    onError: (err) => {
      toast.error(toApiError(err).message);
      invalidateLifecycleScope();
    },
  });

  const reopenMutation = useMutation({
    mutationFn: (assignToSelf?: boolean) =>
      reopenUnifiedChat(chat.device_id, chat.jid, {
        assign_to_self: assignToSelf,
        cached_title: displayName,
      }),
    onSuccess: (data) => {
      toast.success(t.chats.reopenedToast);
      applyLifecycleMutationResult(data);
    },
    onError: (err) => {
      toast.error(toApiError(err).message);
      invalidateLifecycleScope();
    },
  });

  const unblockMutation = useMutation({
    mutationFn: () => blockUnifiedChat(chat.device_id, chat.jid, false),
    onSuccess: () => {
      toast.success(t.chats.unblockedToast);
      invalidateLifecycleScope();
    },
    onError: (err) => {
      toast.error(toApiError(err).message);
    },
  });

  const isLifecyclePending =
    claimMutation.isPending ||
    releaseMutation.isPending ||
    closeMutation.isPending ||
    reopenMutation.isPending ||
    unblockMutation.isPending;

  const reactionMutation = useMutation({
    mutationFn: ({deviceId, chatJid, messageId, emoji}: {
      deviceId: string;
      chatJid: string;
      messageId: string;
      emoji: string;
      pendingKey: string;
    }) => sendUnifiedMessageReaction(deviceId, chatJid, messageId, emoji),
    onMutate: async ({deviceId, chatJid, messageId, emoji}) => {
      const queryKey = ['unified-messages', deviceId, chatJid] as const;
      await queryClient.cancelQueries({queryKey});
      const previous = queryClient.getQueriesData<InfiniteData<MessagesPage>>({queryKey});
      const optimistic = {emoji, sender_jid: deviceId, is_from_me: true, timestamp: new Date().toISOString()};
      queryClient.setQueriesData<InfiniteData<MessagesPage>>({queryKey}, (data) =>
        updateMessageReactions(data, messageId, (reactions) =>
          applyMessageReaction(reactions, optimistic),
        ),
      );
      return {previous, optimistic};
    },
    onError: (err, {messageId}, context) => {
      if (context) {
        const {optimistic, previous} = context;
        for (const [key, data] of previous) {
          const original = data?.pages.flatMap((page) => page.data)
            .find((message) => message.id === messageId)?.reactions?.find((reaction) => reaction.is_from_me);
          queryClient.setQueryData<InfiniteData<MessagesPage>>(key, (current) =>
            updateMessageReactions(current, messageId, (reactions) => {
              const own = reactions?.find((reaction) => reaction.is_from_me);
              if (own ? own.timestamp !== optimistic.timestamp : optimistic.emoji) return reactions;
              return applyMessageReaction(reactions, original ?? {...optimistic, emoji: ''});
            }),
          );
        }
      }
      toast.error(toApiError(err).message);
    },
    onSettled: (_data, _err, {pendingKey}) => {
      pendingReactions.current.delete(pendingKey);
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
    if (!canWriteChats || !isDeviceReady || isAnySending || isSendingBlocked) return;
    const trimmed = draft.trim();
    if (attachment) {
      sendMediaMutation.mutate({file: attachment, caption: trimmed || undefined});
      return;
    }
    if (!trimmed) return;
    sendMutation.mutate({text: trimmed, replyMessageId: replyingTo?.id});
  };

  const handleDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (
      !canWriteChats ||
      !isDeviceReady ||
      isSendingBlocked ||
      !event.dataTransfer.types.includes('Files')
    ) {
      return;
    }
    event.preventDefault();
    dragCounterRef.current += 1;
    setIsDragOver(true);
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (
      !canWriteChats ||
      !isDeviceReady ||
      isSendingBlocked ||
      !event.dataTransfer.types.includes('Files')
    ) {
      return;
    }
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
    if (!canWriteChats || !isDeviceReady || isAnySending || isSendingBlocked) return;
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

  const reactToMessage = reactionMutation.mutate;
  const handleReact = useCallback(
    (message: MessageInfo, emoji: string) => {
      if (!isDeviceReady) return;
      const pendingKey = JSON.stringify([chat.device_id, chat.jid, message.id]);
      if (pendingReactions.current.has(pendingKey)) return;
      pendingReactions.current.add(pendingKey);
      const myExisting = message.reactions?.find((r) => r.is_from_me && r.emoji === emoji);
      reactToMessage({
        deviceId: chat.device_id, chatJid: chat.jid, messageId: message.id,
        emoji: myExisting ? '' : emoji, pendingKey,
      });
    },
    [chat.device_id, chat.jid, isDeviceReady, reactToMessage],
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
          embeddedInGroup={embeddedInGroup}
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
          canReadNotes={canReadNotes}
          canReadSchedules={canReadSchedules}
          notesCount={notesCount}
          activeScheduledCount={activeScheduledCount}
          onToggleDrawerTab={(tab) => setDrawerTab((prev) => (prev === tab ? null : tab))}
          isHistoryPending={historyMutation.isPending}
          onFetchHistory={() => historyMutation.mutate()}
          lifecycle={effectiveLifecycle}
          currentUserId={user?.id}
          canAssign={canAssignChats}
          canClose={canCloseChats}
          canViewAll={canViewAllChats}
          isContentRedacted={isContentRedacted}
          isLifecyclePending={isLifecyclePending}
          onClaim={() => claimMutation.mutate()}
          onOpenAssign={() => setAssignDialogOpen(true)}
          onRelease={() => releaseMutation.mutate()}
          onCloseChat={() => closeMutation.mutate()}
          onReopen={() => reopenMutation.mutate(!canViewAllChats && canAssignChats)}
        />

        <div
          ref={scrollRef}
          onScroll={maybeLoadOlder}
          className="wa-wallpaper relative min-h-0 flex-1 overflow-y-auto py-4"
        >
          {query.isLoading ? (
            <div className="flex items-center justify-center gap-2 p-10 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              <span>{t.chats.loadingMessages}</span>
            </div>
          ) : isContentRedacted ? (
            <div className="relative flex min-h-full items-center justify-center overflow-hidden px-4 py-8">
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 mx-auto flex max-w-4xl flex-col justify-center gap-3 px-6 py-6 opacity-70 blur-md select-none"
              >
                <div className="flex justify-start">
                  <div className="h-12 w-56 rounded-2xl rounded-ts-xs border border-border/50 bg-bubble-in shadow-2xs" />
                </div>
                <div className="flex justify-end">
                  <div className="h-10 w-44 rounded-2xl rounded-te-xs border border-border/50 bg-bubble-out shadow-2xs" />
                </div>
                <div className="flex justify-start">
                  <div className="h-16 w-72 rounded-2xl rounded-ts-xs border border-border/50 bg-bubble-in shadow-2xs" />
                </div>
                <div className="flex justify-end">
                  <div className="h-11 w-60 rounded-2xl rounded-te-xs border border-border/50 bg-bubble-out shadow-2xs" />
                </div>
              </div>

              <div className="relative z-10 w-full max-w-md rounded-2xl border border-border bg-card/95 p-6 text-center shadow-lg">
                <div className="mx-auto mb-3.5 flex size-11 items-center justify-center rounded-full bg-secondary text-foreground">
                  <Lock className="size-5" />
                </div>
                <h3 className="text-sm font-semibold text-foreground">
                  {redactionReason === 'closed'
                    ? t.chats.redactedClosedTitle
                    : redactionReason === 'assigned_other'
                      ? t.chats.redactedOtherTitle
                      : t.chats.redactedPendingTitle}
                </h3>
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                  {redactionReason === 'closed'
                    ? t.chats.redactedClosedDesc
                    : redactionReason === 'assigned_other'
                      ? t.chats.redactedOtherDesc(effectiveLifecycle?.assigned_user_name || '')
                      : t.chats.redactedPendingDesc}
                </p>

                <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                  {redactionReason === 'pending' && canAssignChats ? (
                    <Button
                      type="button"
                      size="sm"
                      disabled={isLifecyclePending}
                      onClick={() => claimMutation.mutate()}
                      className="whitespace-nowrap shrink-0"
                    >
                      {claimMutation.isPending ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Hand className="size-4" />
                      )}
                      <span>{t.chats.claimAction}</span>
                    </Button>
                  ) : redactionReason === 'closed' && canCloseChats ? (
                    <Button
                      type="button"
                      size="sm"
                      disabled={isLifecyclePending}
                      onClick={() => reopenMutation.mutate(canAssignChats)}
                      className="whitespace-nowrap shrink-0"
                    >
                      {reopenMutation.isPending ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <RotateCcw className="size-4" />
                      )}
                      <span>{t.chats.reopenAction}</span>
                    </Button>
                  ) : (
                    <p className="text-[11px] font-medium text-muted-foreground">
                      {t.chats.redactedPermissionNeeded}
                    </p>
                  )}
                </div>
              </div>
            </div>
          ) : query.isError ? (
            <div className="p-8 text-center text-sm text-destructive">
              {toApiError(query.error).message}
            </div>
          ) : timelineItems.length === 0 ? (
            autoHistoryActive || historyMutation.isPending ? (
              <div className="flex flex-col items-center justify-center gap-2 p-10 text-center text-sm text-muted-foreground">
                <Loader2 className="size-5 animate-spin text-primary" />
                <p className="font-medium text-foreground/90">{t.chats.fetchingHistoryFromPhone}</p>
                <p className="text-xs">{t.chats.noMessagesHint}</p>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center gap-2 p-10 text-center text-sm text-muted-foreground">
                <p>{t.chats.noMessagesYet}</p>
                <p className="text-xs">{t.chats.noMessagesHint}</p>
                {autoHistoryFailed && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setAutoHistoryFailed(false);
                      historyMutation.mutate();
                    }}
                    className="mt-1"
                  >
                    <RefreshCw className="size-3.5" />
                    <span>{t.retry}</span>
                  </Button>
                )}
              </div>
            )
          ) : (
            <div ref={timelineContentRef} className="flex flex-col gap-2">
              {isFetchingNextPage && (
                <div className="mx-auto flex w-full max-w-4xl justify-center px-4 pb-1 sm:px-8 lg:px-14">
                  <div className="flex items-center gap-2 rounded-lg bg-card/90 px-3 py-1 text-xs text-muted-foreground shadow-2xs">
                    <Loader2 className="size-3.5 animate-spin" />
                    <span>{t.chats.loadingOlderMessages}</span>
                  </div>
                </div>
              )}

              {timelineItems.map((item, index) => {
                const showDate =
                  index === 0 || dayKey(item.timestamp) !== dayKey(timelineItems[index - 1].timestamp);
                return (
                  <div key={item.key} className="flex flex-col gap-2">
                    {showDate && (
                      <div className="mx-auto my-1.5 flex w-full max-w-4xl justify-center px-4 sm:px-8 lg:px-14">
                        <span className="rounded-lg bg-card/95 px-3 py-1 text-[11px] font-medium text-muted-foreground shadow-2xs">
                          {formatDay(item.timestamp, lang)}
                        </span>
                      </div>
                    )}
                    {item.kind === 'lifecycle' ? (
                      <div className="mx-auto my-0.5 flex w-full max-w-4xl justify-center px-4 sm:px-8 lg:px-14">
                        <div className="max-w-md rounded-lg border border-border/80 bg-card/90 px-3 py-1 text-center text-[11px] text-muted-foreground shadow-2xs">
                          <span>{formatLifecycleEventText(item.event, t)}</span>
                          <span className="ms-1.5 text-[10px] opacity-75 tabular-nums">
                            {formatShortTime(item.event.created_at, lang)}
                          </span>
                          {item.event.note && (
                            <p className="mt-0.5 text-[10px] text-foreground/80">
                              {item.event.note}
                            </p>
                          )}
                        </div>
                      </div>
                    ) : (
                      <MessageBubble
                        message={item.message}
                        quoted={replyTarget(item.message)}
                        deviceId={chat.device_id}
                        isDeviceReady={isDeviceReady}
                        canReactAndReply={canWriteChats && !isSendingBlocked}
                        isReactionPickerOpen={reactionPickerMessageId === item.message.id}
                        onToggleReactionPicker={(id) =>
                          setReactionPickerMessageId((prev) => (prev === id ? null : id))
                        }
                        onCloseReactionPicker={() => setReactionPickerMessageId(null)}
                        onReact={handleReact}
                        onReply={handleReply}
                        onForward={
                          canWriteChats
                            ? (msg) => {
                                setReactionPickerMessageId(null);
                                setForwardingMessage(msg);
                              }
                            : undefined
                        }
                        onRevoke={
                          canRevokeChats
                            ? (msg) => {
                                setReactionPickerMessageId(null);
                                setRevokingMessage(msg);
                              }
                            : undefined
                        }
                        onJumpToMessage={handleJumpToMessage}
                        selectMode={mediaBatch.selectMode}
                        isSelected={mediaBatch.selectedIds.has(item.message.id)}
                        onToggleSelect={mediaBatch.toggleSelectItem}
                      />
                    )}
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
          canWrite={canWriteChats}
          canSchedule={canWriteSchedules}
          lockState={lockState}
          autoReopenHint={autoReopenHint}
          canClaimFromComposer={canAssignChats}
          canReopenFromComposer={canCloseChats}
          canUnblockFromComposer={canWriteChats}
          isLifecyclePending={isLifecyclePending}
          onClaimFromComposer={() => claimMutation.mutate()}
          onReopenFromComposer={() => reopenMutation.mutate(canAssignChats)}
          onUnblockFromComposer={() => unblockMutation.mutate()}
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

      {drawerTab &&
        !isContentRedacted &&
        ((drawerTab === 'notes' && canReadNotes) ||
          (drawerTab === 'scheduled' && canReadSchedules)) && (
          <Suspense fallback={null}>
            <ChatContextDrawer
              chat={chat}
              activeTab={drawerTab}
              isContentRedacted={isContentRedacted}
              canReadNotes={canReadNotes}
              canReadSchedules={canReadSchedules}
              notesCount={notesCount}
              scheduledCount={activeScheduledCount}
              onTabChange={setDrawerTab}
              onClose={() => setDrawerTab(null)}
              onOpenCreateSchedule={() => setScheduleDialogOpen(true)}
            />
          </Suspense>
        )}

      <Suspense fallback={null}>
        {scheduleDialogOpen && (
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
        )}

        {Boolean(forwardingMessage) && (
          <ForwardMessageDialog
            open={Boolean(forwardingMessage)}
            onOpenChange={(nextOpen) => {
              if (!nextOpen) setForwardingMessage(null);
            }}
            message={forwardingMessage}
            sourceDeviceId={chat.device_id}
            sourceChatJid={chat.jid}
          />
        )}

        {isLifecycleSupported && assignDialogOpen && (
          <AssignChatDialog
            open={assignDialogOpen}
            onOpenChange={setAssignDialogOpen}
            deviceId={chat.device_id}
            chatJid={chat.jid}
            chatTitle={displayName}
            currentAssigneeId={effectiveLifecycle?.assigned_user_id ?? null}
            currentUserId={user?.id}
            canViewAll={canViewAllChats}
          />
        )}
      </Suspense>

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
