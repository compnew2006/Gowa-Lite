import {useCallback, useEffect, useLayoutEffect, useRef} from 'react';
import {
  computeTimelineScrollAction,
  isNearBottom,
  scrollContainerToBottom,
} from '@/features/chat/scroll-behavior';


const SCROLL_TOP_THRESHOLD_PX = 140;

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
  const stickToBottomRef = useRef(true);


  const resetScroll = useCallback(() => {
    initialScrolledRef.current = false;
    prevScrollAnchorRef.current = null;
    stickToBottomRef.current = true;
  }, []);

  const followLatest = useCallback(() => {
    stickToBottomRef.current = true;
  }, []);

  const scheduleScrollToBottom = useCallback(() => {
    window.requestAnimationFrame(() => {
      if (scrollRef.current && stickToBottomRef.current && !prevScrollAnchorRef.current) {
        scrollContainerToBottom(scrollRef.current);
      }
    });
  }, []);

  useEffect(resetScroll, [isContentRedacted, resetScroll, scope]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    const action = computeTimelineScrollAction({
      hasElement: Boolean(el),
      itemCount: itemCount,
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
        scheduleScrollToBottom();
      }
    }
  }, [isContentRedacted, itemCount, scheduleScrollToBottom, timelineRevision]);

  useEffect(() => {
    if (isContentRedacted || itemCount === 0 || typeof ResizeObserver === 'undefined') {
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
  }, [isContentRedacted, itemCount]);

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

  return {scrollRef, timelineContentRef, maybeLoadOlder, resetScroll, scheduleScrollToBottom, followLatest};
}
