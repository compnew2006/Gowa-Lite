import './phase5-preview-dom.ts';
import assert from 'node:assert/strict';
import {afterEach, describe, it} from 'node:test';
import React, {act, createElement as el} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {ChatPreviewLine} from '../src/features/chat/chat-preview-line.tsx';
import type {ChatPreview} from '../src/lib/chat-preview.ts';

// Phase 5 path B — P2-2: the preview line rendered under the chat name.
// Text previews show the text; media messages with no text show a media-type
// icon + short label (never a blank line); no preview data renders nothing.
//
// Rendered with React 19 + jsdom (no JSX: tsx does not parse JSX in .ts
// test files, and the `npm test` glob only matches `*.test.ts`).
//
// Never compare DOM nodes with assert.equal/deepEqual in this file: on
// failure Node inspects the nodes into the error message, and React-rendered
// nodes carry __reactFiber$ trees whose inspection never finishes (the test
// file hangs and can OOM). Compare with assert.ok(a === b) instead.

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderPreview(preview: ChatPreview | null) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(el(ChatPreviewLine, {preview}));
  });
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe('ChatPreviewLine (P2-2)', () => {
  it('renders the text of a text preview', async () => {
    await renderPreview({kind: 'text', text: 'أهلاً، وصل الطلب؟'});
    const line = container!.querySelector('[data-testid="chat-preview"]');
    assert.ok(line, 'preview line renders');
    assert.ok((line!.textContent ?? '').includes('أهلاً، وصل الطلب؟'));
    assert.equal(line!.querySelector('svg'), null, 'text preview has no media icon');
  });

  it('renders a media icon + short label for a media message with no text', async () => {
    await renderPreview({kind: 'media', mediaType: 'image', label: 'صورة'});
    const line = container!.querySelector('[data-testid="chat-preview"]');
    assert.ok(line, 'preview line renders for media');
    assert.ok((line!.textContent ?? '').includes('صورة'));
    assert.ok(line!.querySelector('svg'), 'media preview shows an icon');
  });

  it('renders nothing when there is no preview', async () => {
    await renderPreview(null);
    assert.equal(container!.querySelector('[data-testid="chat-preview"]'), null);
    assert.equal((container!.textContent ?? '').trim(), '');
  });

  it('renders a call icon + Arabic label for a call preview (P2-2a)', async () => {
    await renderPreview({kind: 'media', mediaType: 'call', label: 'مكالمة واردة'});
    const line = container!.querySelector('[data-testid="chat-preview"]');
    assert.ok(line, 'preview line renders for a call');
    assert.ok((line!.textContent ?? '').includes('مكالمة واردة'));
    assert.ok(!(line!.textContent ?? '').includes('Incoming call'));
    assert.ok(line!.querySelector('svg'), 'call preview shows an icon');
  });
});
