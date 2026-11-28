// jsdom global setup for the phase5 call-bubble DOM tests.
//
// Imported FIRST so a DOM exists before any component module is evaluated
// (ES imports run before the importing module's body). Same pattern as
// tests/phase5-preview-dom.test.ts.
import './phase5-preview-dom.ts';
import assert from 'node:assert/strict';
import {afterEach, describe, it} from 'node:test';
import React, {act, createElement as el} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import type {MessageInfo} from '../src/api/types.ts';
import {MessageBubble} from '../src/features/chat/message-bubble.tsx';
import {isCallMessage} from '../src/lib/chat-preview.ts';

// Phase 5 — P2-2a (continuation): a call message inside the OPEN
// conversation. The gateway stores incoming calls as synthetic messages
// with the raw English content "Incoming call" (media_type "call"); the
// chat-list preview already localizes that row, but the bubble rendered
// the raw text verbatim (plus a meaningless download card from
// MessageMedia, which has no media to fetch for a call). The bubble must
// show the localized call label (mediaLabels.call) with a PhoneIncoming
// icon instead, and no download card.
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
let client: QueryClient | null = null;

function callMessage(overrides: Partial<MessageInfo> = {}): MessageInfo {
  return {
    id: 'msg-call-1',
    chat_jid: '966500000000@s.whatsapp.net',
    sender_jid: '966500000000@s.whatsapp.net',
    content: 'Incoming call',
    timestamp: '2026-11-28T10:00:00.000Z',
    is_from_me: false,
    media_type: 'call',
    filename: '',
    url: '',
    file_length: 0,
    ...overrides,
  };
}

function textMessage(overrides: Partial<MessageInfo> = {}): MessageInfo {
  return {
    id: 'msg-text-1',
    chat_jid: '966500000000@s.whatsapp.net',
    sender_jid: '966500000000@s.whatsapp.net',
    content: 'أهلاً، وصل الطلب؟',
    timestamp: '2026-11-28T10:00:00.000Z',
    is_from_me: false,
    media_type: '',
    filename: '',
    url: '',
    file_length: 0,
    ...overrides,
  };
}

async function renderBubble(message: MessageInfo, quoted?: MessageInfo | null) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const rootClient = new QueryClient({
    // gcTime: 0 (same as tests/composer-scheduling.test.ts): otherwise the
    // client's 5-minute garbage-collection timer keeps the test process
    // alive after the suite finishes.
    defaultOptions: {queries: {staleTime: Infinity, retry: false, gcTime: 0}},
  });
  client = rootClient;
  await act(async () => {
    root!.render(
      el(
        QueryClientProvider,
        {client: rootClient},
        el(MessageBubble, {
          message,
          quoted,
          deviceId: 'device-1',
          isDeviceReady: true,
          isReactionPickerOpen: false,
          onToggleReactionPicker: () => {},
          onCloseReactionPicker: () => {},
          onReact: () => {},
          onReply: () => {},
          onJumpToMessage: () => {},
        }),
      ),
    );
  });
}

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  client?.clear();
  client = null;
  container?.remove();
  root = null;
  container = null;
});

describe('MessageBubble call message (P2-2a, open view)', () => {
  it('shows the localized call label + icon, never the raw English text', async () => {
    await renderBubble(callMessage());
    const row = container!.querySelector('[data-message-id="msg-call-1"]');
    assert.ok(row, 'call bubble renders');
    const text = row!.textContent ?? '';
    assert.ok(text.includes('مكالمة واردة'), 'bubble shows the Arabic call label');
    assert.ok(!text.includes('Incoming call'), 'bubble hides the raw gateway text');
    assert.ok(row!.querySelector('svg'), 'call bubble shows an icon');
  });

  it('shows no download card for a call message', async () => {
    await renderBubble(callMessage());
    const row = container!.querySelector('[data-message-id="msg-call-1"]');
    assert.ok(row, 'call bubble renders');
    // The call line is a plain div, not a button: a download card would be
    // a button inside the bubble body. The toolbar buttons live outside the
    // bubble body, so scope the check to the bubble itself.
    const bubble = row!.querySelector('.rounded-xl');
    assert.ok(bubble, 'bubble body renders');
    assert.ok(bubble!.querySelector('button') === null, 'no download button in the bubble');
  });

  it('localizes a quoted call message instead of its raw text', async () => {
    await renderBubble(textMessage(), callMessage());
    const row = container!.querySelector('[data-message-id="msg-text-1"]');
    assert.ok(row, 'text bubble renders');
    const text = row!.textContent ?? '';
    assert.ok(text.includes('أهلاً، وصل الطلب؟'), 'own text still renders');
    assert.ok(text.includes('مكالمة واردة'), 'quoted call shows the Arabic label');
    assert.ok(!text.includes('Incoming call'), 'quoted call hides the raw gateway text');
  });

  it('still renders an ordinary text message verbatim (regression guard)', async () => {
    await renderBubble(textMessage());
    const row = container!.querySelector('[data-message-id="msg-text-1"]');
    assert.ok(row, 'text bubble renders');
    assert.ok((row!.textContent ?? '').includes('أهلاً، وصل الطلب؟'));
  });

  it('does not localize ordinary text that merely mentions a call', async () => {
    await renderBubble(
      textMessage({content: 'اتصل بي بعد المكالمة', id: 'msg-text-2'}),
    );
    const row = container!.querySelector('[data-message-id="msg-text-2"]');
    assert.ok(row, 'text bubble renders');
    const text = row!.textContent ?? '';
    assert.ok(text.includes('اتصل بي بعد المكالمة'), 'own text renders verbatim');
    assert.ok(!text.includes('مكالمة واردة'), 'no call label for ordinary text');
  });
});

describe('isCallMessage (P2-2a shared detection)', () => {
  it('matches media_type call regardless of content', () => {
    assert.ok(isCallMessage('anything', 'call'));
    assert.ok(isCallMessage('', 'call'));
    assert.ok(isCallMessage(null, 'call'));
  });

  it('matches the raw gateway text for rows cached without a media type', () => {
    assert.ok(isCallMessage('Incoming call', ''));
    assert.ok(isCallMessage('  Incoming   call  ', null));
  });

  it('does not match ordinary text', () => {
    assert.ok(!isCallMessage('I missed your call yesterday', ''));
    assert.ok(!isCallMessage('Incoming call tomorrow?', ''));
    assert.ok(!isCallMessage('hello', 'text'));
    assert.ok(!isCallMessage('', ''));
  });
});
