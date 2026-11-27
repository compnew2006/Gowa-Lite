import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, it} from 'node:test';

describe('Timeline Scroll Stability & Zero-CLS Media (Superpowers TDD)', () => {
  it('computes exact element-based anchor compensation when images above resize late', async () => {
    const scrollBehavior = await import('../src/features/chat/scroll-behavior.ts');

    // Anchor element shifted down by +184px because an image in a prepended older page decoded late
    const nextScrollTop = scrollBehavior.computeAnchorDeltaScrollTop({
      currentScrollTop: 320,
      beforeOffsetTop: 140,
      afterOffsetTop: 324,
    });
    assert.equal(nextScrollTop, 504);

    // No shift when anchor offset is unchanged
    assert.equal(
      scrollBehavior.computeAnchorDeltaScrollTop({
        currentScrollTop: 320,
        beforeOffsetTop: 140,
        afterOffsetTop: 140,
      }),
      320,
    );
  });

  it('never allows ResizeObserver to fight user upward scroll or an active older-page anchor', async () => {
    const scrollBehavior = await import('../src/features/chat/scroll-behavior.ts');

    assert.equal(
      scrollBehavior.shouldFollowResizeToBottom({
        stickToBottom: true,
        hasPendingAnchor: false,
        userScrollingUp: false,
      }),
      true,
    );

    assert.equal(
      scrollBehavior.shouldFollowResizeToBottom({
        stickToBottom: true,
        hasPendingAnchor: true,
        userScrollingUp: false,
      }),
      false,
    );

    assert.equal(
      scrollBehavior.shouldFollowResizeToBottom({
        stickToBottom: true,
        hasPendingAnchor: false,
        userScrollingUp: true,
      }),
      false,
    );

    assert.equal(
      scrollBehavior.shouldFollowResizeToBottom({
        stickToBottom: false,
        hasPendingAnchor: false,
        userScrollingUp: false,
      }),
      false,
    );
  });

  it('stores and retrieves intrinsic media dimensions in media-cache without collapsing to 0', async () => {
    const mediaCache = await import('../src/lib/media-cache.ts');
    mediaCache.clearMediaCache();

    mediaCache.setCachedMedia('dev1::jid1::m1', {
      objectUrl: 'blob:test-1',
      contentType: 'image/jpeg',
      byteLength: 1024,
    });

    assert.equal(mediaCache.getCachedMedia('dev1::jid1::m1')?.dimensions, undefined);

    mediaCache.updateCachedMediaDimensions('dev1::jid1::m1', {width: 1080, height: 1920});
    assert.deepEqual(mediaCache.getCachedMedia('dev1::jid1::m1')?.dimensions, {
      width: 1080,
      height: 1920,
    });

    // Ignores invalid zero/negative dimensions
    mediaCache.updateCachedMediaDimensions('dev1::jid1::m1', {width: 0, height: 500});
    assert.deepEqual(mediaCache.getCachedMedia('dev1::jid1::m1')?.dimensions, {
      width: 1080,
      height: 1920,
    });

    mediaCache.clearMediaCache();
  });

  it('keeps content-visibility off variable-height .message-row while preserving .chat-list-row memory', () => {
    const css = fs.readFileSync(path.resolve(process.cwd(), 'src/index.css'), 'utf8');
    assert.match(css, /\.chat-list-row\s*\{[\s\S]*contain-intrinsic-size:\s*auto\s+72px/);
    assert.doesNotMatch(css, /\.message-row\s*\{[^}]*content-visibility:\s*auto/);
  });

  it('keeps older-messages loading banner out of flow so mounting it does not shift messages', () => {
    const viewSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'src/features/chat/message-view.tsx'),
      'utf8',
    );
    assert.match(viewSrc, /isFetchingNextPage[\s\S]*pointer-events-none\s+sticky\s+top-/);
  });

  it('renders img and video out-of-flow (absolute inset-0) inside an invariant relative frame in MessageMedia', () => {
    const mediaSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'src/features/chat/message-media.tsx'),
      'utf8',
    );
    assert.equal(mediaSrc.includes("const IMAGE_FRAME_CLASS = 'w-56 sm:w-64 max-w-full aspect-[4/3]'"), true);
    assert.equal(mediaSrc.includes("const STICKER_FRAME_CLASS = 'size-32 max-w-full'"), true);
    assert.equal(mediaSrc.includes('setImageDimensions'), false);
    assert.equal(mediaSrc.includes('markMediaDecoded'), true);
    assert.match(mediaSrc, /<img[\s\S]*?className=\{`absolute inset-0 h-full w-full object-contain/);
    assert.match(mediaSrc, /<video[\s\S]*?className="absolute inset-0 h-full w-full object-contain"/);
  });
});
