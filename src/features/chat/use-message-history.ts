import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useInfiniteQuery, useMutation} from '@tanstack/react-query';
import {toast} from 'sonner';
import {useNavigate} from 'react-router-dom';
import {requestUnifiedChatHistory} from '@/api/requests/chats';
import type {ChatRedactionReason, MessageInfo, UnifiedChat} from '@/api/types';
import {isNoHistoryOnPhoneError, shouldTriggerAutoHistoryFetch, type EmptyHistoryStatus} from '@/features/chat/empty-history';
import {messageHistoryOptions, PAGE_SIZE} from '@/features/chat/message-history-query';
import {sortMessagesChronologically} from '@/features/chat/message-reactions';
import {toApiError} from '@/lib/http';
import {useI18n} from '@/lib/i18n';
import {toastWithView} from '@/lib/toast-with-view';
import {buildConversationDeepLink} from '@/lib/deep-links';
import {normalizeSearchInput} from '@/lib/phone';

const HISTORY_POLL_MS = 2_000;
const HISTORY_POLL_WINDOW_MS = 30_000;
const MIN_HISTORY_LOADING_MS = 450;
const REACTION_FALLBACK_POLL_MS = 12_000;

export function useMessageHistory({chat, openNonce, search, mediaOnly, redactionReasonFromLifecycle}: {
  chat: UnifiedChat;
  openNonce: number;
  search: string;
  mediaOnly: boolean;
  redactionReasonFromLifecycle?: ChatRedactionReason;
}) {
  const {t} = useI18n();
  const navigate = useNavigate();
  const isDeviceReady = chat.device_state === 'logged_in';
  const lastAutoTriggerKeyRef = useRef<string | null>(null);
  const lastResetOpenKeyRef = useRef<string | null>(null);
  const historyRequestIdRef = useRef(0);
  const minLoadingTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const [historyPollUntil, setHistoryPollUntil] = useState(0);
  const [emptyHistoryStatus, setEmptyHistoryStatus] = useState<EmptyHistoryStatus>('idle');
  const [emptyHistoryError, setEmptyHistoryError] = useState('');

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (minLoadingTimerRef.current !== null) {
        window.clearTimeout(minLoadingTimerRef.current);
        minLoadingTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const triggerKey = `${chat.device_id}::${chat.jid}::${openNonce}`;
    if (lastResetOpenKeyRef.current === triggerKey) return;
    lastResetOpenKeyRef.current = triggerKey;
    historyRequestIdRef.current += 1;
    if (minLoadingTimerRef.current !== null) {
      window.clearTimeout(minLoadingTimerRef.current);
      minLoadingTimerRef.current = null;
    }
    setHistoryPollUntil(0);
    setEmptyHistoryStatus('idle');
    setEmptyHistoryError('');
  }, [chat.device_id, chat.jid, openNonce]);

  const normalizedSearch = normalizeSearchInput(search);

  const query = useInfiniteQuery({
    ...messageHistoryOptions(chat.device_id, chat.jid, normalizedSearch, mediaOnly),
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

  const messages = useMemo(() => {
    if (isContentRedacted) return [];
    const pages = query.data?.pages ?? [];
    const byId = new Map<string, MessageInfo>();
    for (const page of pages) {
      for (const msg of page.data) byId.set(msg.id, msg);
    }
    return sortMessagesChronologically(Array.from(byId.values()));
  }, [isContentRedacted, query.data?.pages]);

  const requestEmptyChatHistory = useCallback(
    (source: 'auto' | 'manual') => {
      if (minLoadingTimerRef.current !== null) {
        window.clearTimeout(minLoadingTimerRef.current);
        minLoadingTimerRef.current = null;
      }
      const reqId = ++historyRequestIdRef.current;
      const startedAt = Date.now();
      setEmptyHistoryError('');
      setEmptyHistoryStatus('loading');
      setHistoryPollUntil(Date.now() + HISTORY_POLL_WINDOW_MS);

      return requestUnifiedChatHistory(chat.device_id, chat.jid, PAGE_SIZE)
        .then((res) => {
          if (!mountedRef.current || historyRequestIdRef.current !== reqId) return res;
          if (source === 'manual') {
            toastWithView(t.chats.historyRequestedToast, {
              label: t.scheduled.viewAction,
              to: buildConversationDeepLink(chat.device_id, chat.jid),
              navigate,
            });
          }
          return res;
        })
        .catch((err: unknown) => {
          if (!mountedRef.current || historyRequestIdRef.current !== reqId) {
            if (source === 'manual') throw err;
            return undefined;
          }
          const apiErr = toApiError(err);
          const noHistory = isNoHistoryOnPhoneError(apiErr.status, apiErr.message);
          const remainingMs = Math.max(0, MIN_HISTORY_LOADING_MS - (Date.now() - startedAt));
          const applyFailureState = () => {
            if (!mountedRef.current || historyRequestIdRef.current !== reqId) return;
            minLoadingTimerRef.current = null;
            setHistoryPollUntil(0);
            if (noHistory) {
              setEmptyHistoryStatus('empty');
              setEmptyHistoryError('');
              if (source === 'manual') {
                toast.info(t.chats.noHistoryOnPhone);
              }
            } else {
              setEmptyHistoryStatus('error');
              setEmptyHistoryError(apiErr.message);
              if (source === 'manual') {
                toast.error(apiErr.message);
              }
            }
          };
          if (remainingMs > 0) {
            minLoadingTimerRef.current = window.setTimeout(applyFailureState, remainingMs);
          } else {
            applyFailureState();
          }
          return undefined;
        });
    },
    [chat.device_id, chat.jid, t.chats.historyRequestedToast, t.chats.noHistoryOnPhone],
  );

  useEffect(() => {
    const triggerKey = `${chat.device_id}::${chat.jid}::${openNonce}`;
    if (
      !shouldTriggerAutoHistoryFetch({
        isSuccess: query.isSuccess,
        isFetching: query.isFetching,
        isContentRedacted,
        hasSearchOrMediaFilter: Boolean(normalizedSearch || mediaOnly),
        isDeviceReady,
        messageCount: messages.length,
        currentTriggerKey: triggerKey,
        lastTriggeredKey: lastAutoTriggerKeyRef.current,
      })
    ) {
      return;
    }
    lastAutoTriggerKeyRef.current = triggerKey;
    void requestEmptyChatHistory('auto');
  }, [
    chat.device_id,
    chat.jid,
    isContentRedacted,
    isDeviceReady,
    mediaOnly,
    messages.length,
    normalizedSearch,
    openNonce,
    query.isFetching,
    query.isSuccess,
    requestEmptyChatHistory,
  ]);

  useEffect(() => {
    if (messages.length > 0) {
      if (emptyHistoryStatus !== 'idle') {
        setEmptyHistoryStatus('idle');
        setEmptyHistoryError('');
      }
      if (historyPollUntil > 0) {
        setHistoryPollUntil(0);
      }
      return;
    }
    if (emptyHistoryStatus !== 'loading' || historyPollUntil <= 0) return;
    const remaining = Math.max(0, historyPollUntil - Date.now());
    const timer = window.setTimeout(() => {
      if (!mountedRef.current) return;
      setHistoryPollUntil(0);
      setEmptyHistoryStatus('empty');
    }, remaining || HISTORY_POLL_WINDOW_MS);
    return () => window.clearTimeout(timer);
  }, [emptyHistoryStatus, historyPollUntil, messages.length]);

  const historyMutation = useMutation({
    mutationFn: async () => {
      if (messages.length === 0) {
        await requestEmptyChatHistory('manual');
        return;
      }
      await requestUnifiedChatHistory(chat.device_id, chat.jid, PAGE_SIZE);
      toastWithView(t.chats.historyRequestedToast, {
        label: t.scheduled.viewAction,
        to: buildConversationDeepLink(chat.device_id, chat.jid),
        navigate,
      });
      setHistoryPollUntil(Date.now() + HISTORY_POLL_WINDOW_MS);
    },
    onError: (err) => toast.error(toApiError(err).message),
  });

  return {
    query, firstPage, messages, isDeviceReady, normalizedSearch, redactionReason,
    isContentRedacted, historyMutation, emptyHistoryStatus, emptyHistoryError,
  };
}
