import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, it} from 'node:test';
import {Virtualizer} from '@tanstack/react-virtual';
import {shouldAutoLoadMore} from '../src/features/chat/scroll-behavior.ts';

/**
 * Headless harness for the virtualizer: drives @tanstack/virtual-core's
 * Virtualizer class with a fake scroll element (no DOM available in node:test).
 * getVirtualItems() is exactly the row set the React components render, so its
 * length is the rendered-row count the virtualized lists produce.
 */
function createHeadlessVirtualizer({
  count,
  estimateSize,
  overscan,
  viewportHeight,
  scrollTop = 0,
}: {
  count: number;
  estimateSize: number;
  overscan: number;
  viewportHeight: number;
  scrollTop?: number;
}) {
  const scrollEl = {
    scrollTop,
    scrollHeight: count * estimateSize,
    clientHeight: viewportHeight,
    getBoundingClientRect: () => ({
      width: 360,
      height: viewportHeight,
      top: 0,
      left: 0,
      bottom: viewportHeight,
      right: 360,
    }),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  let offsetCb: ((offset: number, isScrolling: boolean) => void) | null = null;
  const virtualizer = new Virtualizer({
    count,
    getScrollElement: () => scrollEl as unknown as HTMLElement,
    estimateSize: () => estimateSize,
    overscan,
    scrollToFn: (offset: number) => {
      scrollEl.scrollTop = offset;
    },
    observeElementRect: (_instance: unknown, cb: (rect: {width: number; height: number}) => void) => {
      cb({width: 360, height: viewportHeight});
      return () => {};
    },
    observeElementOffset: (
      _instance: unknown,
      cb: (offset: number, isScrolling: boolean) => void,
    ) => {
      offsetCb = cb;
      cb(scrollTop, false);
      return () => {};
    },
  });
  virtualizer._didMount();
  virtualizer._willUpdate();
  return {
    virtualizer,
    setScrollTop(nextOffset: number) {
      scrollEl.scrollTop = nextOffset;
      offsetCb?.(nextOffset, false);
    },
  };
}

describe('Virtualized chat & message lists (P1 virtualization + memoization)', () => {
  it('renders a bounded window for a 500-chat list instead of all 500 rows', () => {
    const {virtualizer} = createHeadlessVirtualizer({
      count: 500,
      estimateSize: 72,
      overscan: 8,
      viewportHeight: 600,
    });
    const items = virtualizer.getVirtualItems();
    // 600px / 72px ≈ 9 visible rows + 8 overscan = 17 at most
    assert.ok(items.length > 0, 'renders at least one row');
    assert.ok(items.length <= 25, `renders ${items.length} rows, expected a bounded window`);
    assert.equal(items[0]?.index, 0);
    assert.equal(virtualizer.getTotalSize(), 500 * 72);
  });

  it('moves the rendered window when the 500-chat list scrolls', () => {
    const {virtualizer, setScrollTop} = createHeadlessVirtualizer({
      count: 500,
      estimateSize: 72,
      overscan: 8,
      viewportHeight: 600,
    });
    setScrollTop(7200); // 100 rows down
    const items = virtualizer.getVirtualItems();
    assert.ok(items.length <= 25, `renders ${items.length} rows after scrolling`);
    assert.ok(
      (items[0]?.index ?? 0) >= 90 && (items[0]?.index ?? 0) <= 100,
      `window starts at ${items[0]?.index}, expected ~95`,
    );
    assert.ok(
      (items[items.length - 1]?.index ?? 0) <= 120,
      `window ends at ${items[items.length - 1]?.index}, expected ~113`,
    );
  });

  it('renders a bounded window for a 300-message timeline instead of all 300 rows', () => {
    const {virtualizer} = createHeadlessVirtualizer({
      count: 300,
      estimateSize: 96,
      overscan: 6,
      viewportHeight: 800,
    });
    const items = virtualizer.getVirtualItems();
    // 800px / 96px ≈ 9 visible rows + 6 overscan = 15 at most
    assert.ok(items.length > 0, 'renders at least one row');
    assert.ok(items.length <= 25, `renders ${items.length} rows, expected a bounded window`);
    assert.equal(virtualizer.getTotalSize(), 300 * 96);
  });

  it('decides chat-list auto load-more only near the end of the rendered window', () => {
    assert.equal(
      shouldAutoLoadMore({lastRenderedIndex: 47, totalCount: 50, hasMore: true, isLoadingMore: false}),
      true,
    );
    assert.equal(
      shouldAutoLoadMore({lastRenderedIndex: 20, totalCount: 50, hasMore: true, isLoadingMore: false}),
      false,
    );
    assert.equal(
      shouldAutoLoadMore({lastRenderedIndex: 49, totalCount: 50, hasMore: false, isLoadingMore: false}),
      false,
    );
    assert.equal(
      shouldAutoLoadMore({lastRenderedIndex: 49, totalCount: 50, hasMore: true, isLoadingMore: true}),
      false,
    );
    assert.equal(
      shouldAutoLoadMore({lastRenderedIndex: -1, totalCount: 0, hasMore: true, isLoadingMore: false}),
      false,
    );
  });

  it('wires @tanstack/react-virtual into the chat list with stable memo props', () => {
    const chatListSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'src/features/chat/chat-list.tsx'),
      'utf8',
    );
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'),
    ) as {dependencies?: Record<string, string>};
    assert.ok(pkg.dependencies?.['@tanstack/react-virtual'], 'react-virtual is a dependency');
    assert.match(chatListSrc, /from '@tanstack\/react-virtual'/);
    assert.match(chatListSrc, /useVirtualizer</);
    assert.match(chatListSrc, /getVirtualItems\(\)/);
    assert.match(chatListSrc, /measureElement/);
    assert.match(chatListSrc, /getTotalSize\(\)/);
    // Rows stay memoised and the unstable parent callbacks are stabilised by ref
    assert.match(chatListSrc, /const ChatListRow = memo\(function ChatListRow/);
    assert.match(chatListSrc, /onSelectRef/);
    // Manual load-more path is preserved alongside the virtualized auto trigger
    assert.match(chatListSrc, /shouldAutoLoadMore/);
    assert.match(chatListSrc, /t\.chats\.loadMoreChats/);
  });

  it('wires @tanstack/react-virtual into the message timeline without breaking its scroll contract', () => {
    const viewSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'src/features/chat/message-view.tsx'),
      'utf8',
    );
    assert.match(viewSrc, /from '@tanstack\/react-virtual'/);
    assert.match(viewSrc, /useVirtualizer</);
    assert.match(viewSrc, /getVirtualItems\(\)/);
    assert.match(viewSrc, /measureElement/);
    // Fetch-older stays driven by the scroll container, reactions/read states untouched
    assert.match(viewSrc, /onScroll=\{maybeLoadOlder\}/);
    assert.match(viewSrc, /data-message-id/);
    assert.match(viewSrc, /onReact=\{handleReact\}/);
    // Jump-to-quoted-message goes through the virtualizer so off-screen targets render first
    assert.match(viewSrc, /scrollToIndex/);
  });

  it('keeps MessageBubble memoised so only the changed message re-renders', () => {
    const bubbleSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'src/features/chat/message-bubble.tsx'),
      'utf8',
    );
    assert.match(bubbleSrc, /export const MessageBubble = memo\(function MessageBubble/);
  });
});
