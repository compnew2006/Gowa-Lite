export interface ScrollAnchor {
  scrollHeight: number;
  scrollTop: number;
}

export interface ScrollableLike {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

export type TimelineScrollAction = 'none' | 'scroll_bottom' | 'preserve_anchor';

export function isNearBottom(el: ScrollableLike, thresholdPx = 120): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < thresholdPx;
}

export function scrollContainerToBottom(
  el: Pick<ScrollableLike, 'scrollHeight' | 'scrollTop'>,
): void {
  el.scrollTop = el.scrollHeight;
}

export function computeTimelineScrollAction(params: {
  hasElement: boolean;
  itemCount: number;
  isContentRedacted: boolean;
  initialScrolled: boolean;
  prevAnchor: ScrollAnchor | null;
  stickToBottom: boolean;
}): TimelineScrollAction {
  if (!params.hasElement || params.isContentRedacted || params.itemCount === 0) {
    return 'none';
  }
  if (!params.initialScrolled) {
    return 'scroll_bottom';
  }
  if (params.prevAnchor) {
    return 'preserve_anchor';
  }
  if (params.stickToBottom) {
    return 'scroll_bottom';
  }
  return 'none';
}
