import {useCallback, useEffect, useLayoutEffect, useRef} from 'react';
import {
  computeAnchorDeltaScrollTop,
  computeTimelineScrollAction,
  isNearBottom,
  scrollContainerToBottom,
  shouldFollowResizeToBottom,
} from '@/features/chat/scroll-behavior';

const SCROLL_TOP_THRESHOLD_PX = 140;
const ANCHOR_SETTLE_WINDOW_MS = 2_000;

interface ElementAnchor {
  messageId: string;
  offsetFromTop: number;
  expiresAt: number;
}

function captureTopVisibleAnchor(scrollEl: HTMLDivElement): ElementAnchor | null {
  const scrollRect = scrollEl.getBoundingClientRect();
  const rows = scrollEl.querySelectorAll<HTMLElement>('[data-message-id]');
  for (const row of rows) {
    const rect = row.getBoundingClientRect();
    if (rect.bottom > scrollRect.top + 4) {
      const messageId = row.dataset.messageId;
      if (!messageId) continue;
      return {
        messageId,
        offsetFromTop: rect.top - scrollRect.top,
        expiresAt: Date.now() + ANCHOR_SETTLE_WINDOW_MS,
      };
    }
  }
  return null;
}

function findMessageRow(scrollEl: HTMLDivElement, messageId: string): HTMLElement | null {
  const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(messageId) : messageId;
  return scrollEl.querySelector<HTMLElement>(`[data-message-id="${escaped}"]`);
}

export function useMessageTimelineScroll({
  scope, timelineRevision, itemCount, isContentRedacted, hasNextPage, isFetchingNextPage, fetchNextPage,
}: {
  scope: string;
  timelineRevision: readonly unknown[];
  itemCount: number;
  isContentRedacted: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => Promise<unknown>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const timelineContentRef = useRef<HTMLDivElement>(null);
  const initialScrolledRef = useRef(false);
  const prevScrollAnchorRef = useRef<{scrollHeight: number; scrollTop: number} | null>(null);
  const elementAnchorRef = useRef<ElementAnchor | null>(null);
  const stickToBottomRef = useRef(true);
  const userScrollingUpRef = useRef(false);
  const lastScrollTopRef = useRef(0);
  const programmaticScrollRef = useRef(false);
  const isFetchingOlderRef = useRef(isFetchingNextPage);
  isFetchingOlderRef.current = isFetchingNextPage;

  const markProgrammaticScroll = useCallback((el: HTMLDivElement) => {
    programmaticScrollRef.current = true;
    lastScrollTopRef.current = el.scrollTop;
    window.requestAnimationFrame(() => {
      programmaticScrollRef.current = false;
    });
  }, []);

  const reconcileElementAnchor = useCallback((el: HTMLDivElement): boolean => {
    const anchor = elementAnchorRef.current;
    if (!anchor) return false;
    if (!isFetchingOlderRef.current && Date.now() > anchor.expiresAt) {
      elementAnchorRef.current = null;
      return false;
    }
    const row = findMessageRow(el, anchor.messageId);
    if (!row) {
      elementAnchorRef.current = null;
      return false;
    }
    const currentOffset = row.getBoundingClientRect().top - el.getBoundingClientRect().top;
    const nextScrollTop = computeAnchorDeltaScrollTop({
      currentScrollTop: el.scrollTop,
      beforeOffsetTop: anchor.offsetFromTop,
      afterOffsetTop: currentOffset,
    });
    if (Math.abs(nextScrollTop - el.scrollTop) >= 0.5) {
      el.scrollTop = nextScrollTop;
      markProgrammaticScroll(el);
    }
    return true;
  }, [markProgrammaticScroll]);

  const resetScroll = useCallback(() => {
    initialScrolledRef.current = false;
    prevScrollAnchorRef.current = null;
    elementAnchorRef.current = null;
    stickToBottomRef.current = true;
    userScrollingUpRef.current = false;
    lastScrollTopRef.current = 0;
  }, []);

  const followLatest = useCallback(() => {
    stickToBottomRef.current = true;
    userScrollingUpRef.current = false;
    elementAnchorRef.current = null;
  }, []);

  const scheduleScrollToBottom = useCallback(() => {
    window.requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (
        el &&
        shouldFollowResizeToBottom({
          stickToBottom: stickToBottomRef.current,
          hasPendingAnchor: Boolean(prevScrollAnchorRef.current || elementAnchorRef.current),
          userScrollingUp: userScrollingUpRef.current,
        })
      ) {
        scrollContainerToBottom(el);
        markProgrammaticScroll(el);
      }
    });
  }, [markProgrammaticScroll]);

  useEffect(resetScroll, [isContentRedacted, resetScroll, scope]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    const action = computeTimelineScrollAction({
      hasElement: Boolean(el),
      itemCount,
      isContentRedacted,
      initialScrolled: initialScrolledRef.current,
      prevAnchor: prevScrollAnchorRef.current,
      stickToBottom: stickToBottomRef.current && !userScrollingUpRef.current,
    });
    if (!el || action === 'none') {
      if (el && elementAnchorRef.current && !userScrollingUpRef.current) {
        reconcileElementAnchor(el);
      }
      return;
    }

    if (action === 'preserve_anchor' && prevScrollAnchorRef.current) {
      const anchoredByElement = reconcileElementAnchor(el);
      if (!anchoredByElement) {
        const {scrollHeight: prevHeight, scrollTop: prevTop} = prevScrollAnchorRef.current;
        const heightDelta = el.scrollHeight - prevHeight;
        if (heightDelta > 0) {
          el.scrollTop = prevTop + heightDelta;
          markProgrammaticScroll(el);
        }
      }
      if (elementAnchorRef.current) {
        elementAnchorRef.current.expiresAt = Date.now() + ANCHOR_SETTLE_WINDOW_MS;
      }
      prevScrollAnchorRef.current = null;
      return;
    }

    if (action === 'scroll_bottom') {
      const wasInitial = !initialScrolledRef.current;
      scrollContainerToBottom(el);
      markProgrammaticScroll(el);
      initialScrolledRef.current = true;
      if (wasInitial) {
        stickToBottomRef.current = true;
        userScrollingUpRef.current = false;
        scheduleScrollToBottom();
      }
    }
  }, [
    isContentRedacted,
    itemCount,
    markProgrammaticScroll,
    reconcileElementAnchor,
    scheduleScrollToBottom,
    timelineRevision,
  ]);

  useEffect(() => {
    if (isContentRedacted || itemCount === 0 || typeof ResizeObserver === 'undefined') {
      return;
    }
    const contentEl = timelineContentRef.current;
    if (!contentEl) return;

    const observer = new ResizeObserver(() => {
      const scrollEl = scrollRef.current;
      if (!scrollEl) return;

      if (elementAnchorRef.current) {
        reconcileElementAnchor(scrollEl);
        return;
      }

      if (
        shouldFollowResizeToBottom({
          stickToBottom: stickToBottomRef.current,
          hasPendingAnchor: Boolean(prevScrollAnchorRef.current),
          userScrollingUp: userScrollingUpRef.current,
        })
      ) {
        scrollContainerToBottom(scrollEl);
        markProgrammaticScroll(scrollEl);
      }
    });
    observer.observe(contentEl);
    return () => observer.disconnect();
  }, [isContentRedacted, itemCount, markProgrammaticScroll, reconcileElementAnchor]);

  const maybeLoadOlder = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;

    if (!programmaticScrollRef.current) {
      const delta = el.scrollTop - lastScrollTopRef.current;
      if (delta < -2) {
        userScrollingUpRef.current = true;
        stickToBottomRef.current = false;
      } else if (isNearBottom(el)) {
        userScrollingUpRef.current = false;
        stickToBottomRef.current = true;
      } else {
        stickToBottomRef.current = false;
      }
      if (elementAnchorRef.current && Math.abs(delta) > 2 && !isFetchingOlderRef.current) {
        elementAnchorRef.current = null;
      }
    }
    lastScrollTopRef.current = el.scrollTop;

    if (
      initialScrolledRef.current &&
      el.scrollTop <= SCROLL_TOP_THRESHOLD_PX &&
      hasNextPage &&
      !isFetchingNextPage
    ) {
      elementAnchorRef.current = captureTopVisibleAnchor(el);
      prevScrollAnchorRef.current = {scrollHeight: el.scrollHeight, scrollTop: el.scrollTop};
      void fetchNextPage().catch(() => {
        prevScrollAnchorRef.current = null;
        elementAnchorRef.current = null;
      });
    }
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  return {scrollRef, timelineContentRef, maybeLoadOlder, resetScroll, scheduleScrollToBottom, followLatest};
}
