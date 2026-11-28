import './phase3-claim-copy-dom.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {afterEach, beforeEach, describe, it} from 'node:test';
import React, {act, createElement as el} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {BulkActionBar} from '../src/features/chat/bulk-action-bar.tsx';
import {
  MessageBubble,
  resolveCopyTarget,
} from '../src/features/chat/message-bubble.tsx';
import {buildBulkLifecycleRequest} from '../src/features/chat/use-inbox-controller.ts';
import type {MessageInfo, UnifiedChat} from '../src/api/types.ts';
import {useAuthStore} from '../src/stores/auth.ts';

/**
 * Phase 3 path A — P1-6 + P1-5 + P1-10 (claim & copy in the inbox).
 *
 * Rendered with React 19 + jsdom (no JSX: tsx does not parse JSX in .ts
 * test files, and the `npm test` glob only matches `*.test.ts`).
 *
 * Never compare DOM nodes with assert.equal/deepEqual in this file: on
 * failure Node inspects the nodes into the error message, and React-rendered
 * nodes carry __reactFiber$ trees whose inspection never finishes (the test
 * file hangs and can OOM). Compare with assert.ok(a === b) instead.
 */

function readSource(relPath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relPath), 'utf8');
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    // gcTime: 0 — React Query schedules a 5-minute GC timer when a query
    // loses its last observer on unmount; without this the node:test process
    // stays alive for 5 minutes after every DOM test.
    defaultOptions: {queries: {staleTime: Infinity, retry: false, gcTime: 0}},
  });
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let queryClient: QueryClient | null = null;

function render(element: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = makeQueryClient();
  const tree = el(QueryClientProvider, {client: queryClient}, element);
  return act(async () => {
    root!.render(tree);
  });
}

function flushTimers() {
  return act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

function clickButtonWithText(text: string): HTMLButtonElement {
  const buttons = Array.from(document.querySelectorAll('button'));
  const target = buttons.find((b) => (b.textContent ?? '').includes(text));
  assert.ok(target, `button with text "${text}" renders`);
  return target as HTMLButtonElement;
}

function copyButton(): HTMLButtonElement {
  const button = document.querySelector('button[aria-label="نسخ النص"]');
  assert.ok(button, 'copy button renders');
  return button as HTMLButtonElement;
}

function makeChat(overrides: Partial<UnifiedChat> = {}): UnifiedChat {
  return {
    device_id: 'dev-1',
    device_display_name: 'Asir Account',
    device_state: 'logged_in',
    jid: '966500000001@s.whatsapp.net',
    name: 'Customer Alpha',
    last_message: null,
    last_message_at: null,
    ...overrides,
  } as UnifiedChat;
}

function makeMessage(overrides: Partial<MessageInfo> = {}): MessageInfo {
  return {
    id: 'msg-1',
    chat_jid: '966500000001@s.whatsapp.net',
    sender_jid: '966500000001@s.whatsapp.net',
    sender_display_name: 'Customer Alpha',
    content: '',
    timestamp: new Date().toISOString(),
    is_from_me: false,
    media_type: '',
    filename: '',
    url: '',
    file_length: 0,
    ...overrides,
  };
}

describe('P1-6: one claim button for a pending chat (header only)', () => {
  it('removes the big claim button from the redaction lock card and the composer lock-bar button; header only', () => {
    const viewSource = readSource('src/features/chat/message-view.tsx');
    const headerSource = readSource('src/features/chat/message-view-header.tsx');
    const composerSource = readSource('src/features/chat/message-composer.tsx');

    // The header claim button stays — the single claim entry point.
    assert.equal(headerSource.includes('onClaim'), true);
    assert.equal(headerSource.includes('t.chats.claimAction'), true);
    assert.equal(
      viewSource.includes('onClaim={() => claimMutation.mutate()}'),
      true,
      'MessageView still wires the header claim button to the claim mutation',
    );
    // The composer lock bar no longer claims: no wiring, no button — the
    // bar still explains the state, the header button does the claiming.
    assert.equal(viewSource.includes('onClaimFromComposer'), false);
    assert.equal(viewSource.includes('canClaimFromComposer'), false);
    assert.equal(composerSource.includes('onClaimFromComposer'), false);
    assert.equal(composerSource.includes('canClaimFromComposer'), false);
    assert.equal(composerSource.includes('t.chats.claimAction'), false);
    assert.equal(composerSource.includes('composerLockedClaimRequired'), true);
    // Only the header call site remains.
    const callSites = viewSource.match(/claimMutation\.mutate\(\)/g) ?? [];
    assert.equal(callSites.length, 1);
  });

  it('keeps the reopen button and the permission hint in the lock card', () => {
    const viewSource = readSource('src/features/chat/message-view.tsx');
    assert.equal(viewSource.includes('reopenMutation.mutate(canAssignChats)'), true);
    assert.equal(viewSource.includes('t.chats.redactedPermissionNeeded'), true);
  });
});

describe('P1-5: bulk claim assigns the selected chats to the current user', () => {
  const chats = [makeChat(), makeChat({jid: '966500000002@s.whatsapp.net', name: 'Customer Beta'})];

  it('builds an assign request with assigned_user_id = the current user', () => {
    const request = buildBulkLifecycleRequest('assign', chats, 7);
    assert.equal(request.action, 'assign');
    assert.equal(request.assigned_user_id, 7);
    assert.deepEqual(request.items, [
      {
        device_id: 'dev-1',
        chat_jid: '966500000001@s.whatsapp.net',
        cached_title: 'Customer Alpha',
      },
      {
        device_id: 'dev-1',
        chat_jid: '966500000002@s.whatsapp.net',
        cached_title: 'Customer Beta',
      },
    ]);
  });

  it('fails closed: bulk claim without a signed-in user id never builds a request', () => {
    assert.throws(
      () => buildBulkLifecycleRequest('assign', chats, undefined),
      /signed-in user/,
    );
  });

  it('does not attach assigned_user_id to close/release/reopen requests', () => {
    for (const action of ['close', 'release', 'reopen'] as const) {
      const request = buildBulkLifecycleRequest(action, chats, 7);
      assert.equal('assigned_user_id' in request, false);
    }
  });

  it('wires the bulk action bar claim button to the assign action', async () => {
    const calls: Array<{action: string}> = [];
    await render(
      el(BulkActionBar, {
        selectedCount: 2,
        activeTab: 'pending',
        canAssign: true,
        canClose: false,
        isBulkPending: false,
        onRunBulk: (action: string) => {
          calls.push({action});
        },
        onSelectAllVisible: () => {},
        onCancel: () => {},
      }),
    );
    const button = clickButtonWithText('استلام المحدد');
    assert.equal(button.disabled, false);
    act(() => {
      button.click();
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, 'assign');
  });

  it('hides the bulk claim button where claiming makes no sense', async () => {
    await render(
      el(BulkActionBar, {
        selectedCount: 2,
        activeTab: 'closed',
        canAssign: true,
        canClose: true,
        isBulkPending: false,
        onRunBulk: () => {},
        onSelectAllVisible: () => {},
        onCancel: () => {},
      }),
    );
    const buttons = Array.from(document.querySelectorAll('button'));
    assert.equal(
      buttons.some((b) => (b.textContent ?? '').includes('استلام المحدد')),
      false,
    );
  });

  it('chat-list passes the assign action through its bulk handler', () => {
    const chatListSource = readSource('src/features/chat/chat-list.tsx');
    assert.equal(chatListSource.includes('BulkActionBar'), true);
    assert.equal(
      chatListSource.includes('action: BulkLifecycleAction'),
      true,
      'onBulkLifecycle accepts the assign action',
    );
    assert.equal(
      chatListSource.includes(
        'const handleRunBulk = async (action: BulkLifecycleAction)',
      ),
      true,
    );
  });
});

describe('P1-10: copy button is always visible in the bubble toolbar', () => {
  it('resolves the copy target: text first, file name when there is no text', () => {
    assert.deepEqual(resolveCopyTarget(makeMessage({content: 'hello'})), {
      text: 'hello',
      isFileName: false,
    });
    assert.deepEqual(
      resolveCopyTarget(
        makeMessage({content: '   ', media_type: 'document', filename: 'report.pdf'}),
      ),
      {text: 'report.pdf', isFileName: true},
    );
    assert.deepEqual(
      resolveCopyTarget(makeMessage({content: '', media_type: 'document', filename: ''})),
      {text: '', isFileName: false},
    );
    assert.deepEqual(
      resolveCopyTarget(
        makeMessage({content: 'caption', media_type: 'image', filename: 'photo.jpg'}),
      ),
      {text: 'caption', isFileName: false},
    );
  });

  it('copies the file name for caption-less media', async () => {
    let copied: string | null = null;
    Object.defineProperty(window.navigator, 'clipboard', {
      value: {
        writeText: async (text: string) => {
          copied = text;
        },
      },
      configurable: true,
    });
    await render(
      el(MessageBubble, {
        message: makeMessage({media_type: 'document', filename: 'report.pdf'}),
        quoted: null,
        deviceId: 'dev-1',
        isDeviceReady: true,
        canReactAndReply: true,
        isReactionPickerOpen: false,
        onToggleReactionPicker: () => {},
        onCloseReactionPicker: () => {},
        onReact: () => {},
        onReply: () => {},
        onJumpToMessage: () => {},
      }),
    );
    const button = copyButton();
    assert.equal(button.disabled, false);
    assert.equal(button.getAttribute('title'), 'نسخ اسم الملف');
    act(() => {
      button.click();
    });
    await flushTimers();
    assert.equal(copied, 'report.pdf');
  });

  it('stays visible but disabled with an explanatory title when there is nothing to copy', async () => {
    await render(
      el(MessageBubble, {
        message: makeMessage({media_type: 'document', filename: ''}),
        quoted: null,
        deviceId: 'dev-1',
        isDeviceReady: true,
        canReactAndReply: true,
        isReactionPickerOpen: false,
        onToggleReactionPicker: () => {},
        onCloseReactionPicker: () => {},
        onReact: () => {},
        onReply: () => {},
        onJumpToMessage: () => {},
      }),
    );
    const button = copyButton();
    assert.equal(button.disabled, true);
    assert.equal(
      button.getAttribute('title'),
      'لا يوجد نص أو اسم ملف قابل للنسخ في هذه الرسالة',
    );
  });

  it('still copies the message text when there is one', async () => {
    let copied: string | null = null;
    Object.defineProperty(window.navigator, 'clipboard', {
      value: {
        writeText: async (text: string) => {
          copied = text;
        },
      },
      configurable: true,
    });
    await render(
      el(MessageBubble, {
        message: makeMessage({content: 'مرحبا بالعالم'}),
        quoted: null,
        deviceId: 'dev-1',
        isDeviceReady: true,
        canReactAndReply: true,
        isReactionPickerOpen: false,
        onToggleReactionPicker: () => {},
        onCloseReactionPicker: () => {},
        onReact: () => {},
        onReply: () => {},
        onJumpToMessage: () => {},
      }),
    );
    const button = copyButton();
    assert.equal(button.disabled, false);
    assert.equal(button.getAttribute('title'), 'نسخ النص');
    act(() => {
      button.click();
    });
    await flushTimers();
    assert.equal(copied, 'مرحبا بالعالم');
  });
});

beforeEach(() => {
  useAuthStore.setState({language: 'ar', user: null, status: 'unauthenticated'});
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  if (container) {
    container.remove();
    container = null;
  }
  queryClient = null;
});
