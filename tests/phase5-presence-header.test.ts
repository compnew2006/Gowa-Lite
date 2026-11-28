import './phase5-presence-dom.ts';
import assert from 'node:assert/strict';
import {afterEach, beforeEach, describe, it} from 'node:test';
import React, {act, createElement as el} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {MessageViewHeader} from '../src/features/chat/message-view-header.tsx';
import type {UnifiedChat} from '../src/api/types.ts';

/**
 * Phase 5 path A — P2-1 presence badge in the message view header.
 *
 * Rendered with React 19 + jsdom (no JSX: tsx does not parse JSX in .ts
 * test files, and the `npm test` glob only matches `*.test.ts`).
 *
 * Never compare DOM nodes with assert.equal/deepEqual in this file: on
 * failure Node inspects the nodes into the error message, and React-rendered
 * nodes carry __reactFiber$ trees whose inspection never finishes (the test
 * file hangs and can OOM). Compare with assert.ok(a === b) instead.
 */

function makeQueryClient(): QueryClient {
  return new QueryClient({
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

beforeEach(() => {
  root = null;
  container = null;
  queryClient = null;
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  // ContactAvatar sets gcTime: 1h on its own query, which overrides the
  // client's gcTime: 0 default and would keep the node:test process alive
  // for an hour after unmount. Clear the cache to cancel its GC timer.
  queryClient?.clear();
  container?.remove();
  root = null;
  container = null;
  queryClient = null;
});

function makeChat(overrides: Partial<UnifiedChat> = {}): UnifiedChat {
  return {
    device_id: 'dev-1',
    device_display_name: 'العيينة (0026)',
    jid: '201000000001@s.whatsapp.net',
    name: 'عميل الاختبار',
    ...overrides,
  } as UnifiedChat;
}

function renderHeader(props: Partial<React.ComponentProps<typeof MessageViewHeader>> = {}) {
  return render(
    el(MessageViewHeader, {
      chat: makeChat(),
      displayName: 'عميل الاختبار',
      total: 3,
      isDeviceReady: true,
      alwaysShowBack: false,
      searchOpen: false,
      search: '',
      onSearchChange: () => {},
      onToggleSearch: () => {},
      onCloseSearch: () => {},
      mediaOnly: false,
      onToggleMediaOnly: () => {},
      selectMode: false,
      selectedMediaCount: 0,
      onToggleSelectMode: () => {},
      drawerTab: null,
      notesCount: 0,
      activeScheduledCount: 0,
      onToggleDrawerTab: () => {},
      isHistoryPending: false,
      onFetchHistory: () => {},
      currentUserId: 1,
      ...props,
    }),
  );
}

function badge(): HTMLElement | null {
  return document.querySelector('[data-testid="chat-viewers-badge"]');
}

describe('presence badge in the message view header', () => {
  it('shows no badge when nobody else is viewing', async () => {
    await renderHeader({viewers: []});
    assert.equal(badge(), null);
  });

  it('shows the other viewer by name, singular', async () => {
    await renderHeader({viewers: [{userId: 2, displayName: 'سارة'}]});
    const elBadge = badge();
    assert.ok(elBadge, 'badge renders for another viewer');
    assert.ok((elBadge.textContent ?? '').includes('سارة'));
    assert.ok((elBadge.textContent ?? '').includes('يطالع'));
  });

  it('never shows the current user themself in the badge', async () => {
    await renderHeader({
      viewers: [
        {userId: 1, displayName: 'أحمد'},
        {userId: 2, displayName: 'سارة'},
      ],
    });
    const elBadge = badge();
    assert.ok(elBadge, 'badge renders');
    assert.ok((elBadge.textContent ?? '').includes('سارة'));
    assert.ok(!(elBadge.textContent ?? '').includes('أحمد'), 'own name must not appear');
  });

  it('shows no badge when the only viewer is the current user', async () => {
    await renderHeader({viewers: [{userId: 1, displayName: 'أحمد'}]});
    assert.equal(badge(), null);
  });

  it('lists several other viewers together', async () => {
    await renderHeader({
      viewers: [
        {userId: 2, displayName: 'سارة'},
        {userId: 3, displayName: 'خالد'},
      ],
    });
    const elBadge = badge();
    assert.ok(elBadge, 'badge renders for several viewers');
    assert.ok((elBadge.textContent ?? '').includes('سارة'));
    assert.ok((elBadge.textContent ?? '').includes('خالد'));
  });
});
