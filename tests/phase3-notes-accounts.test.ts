import './phase3-notes-accounts-dom.ts';
import assert from 'node:assert/strict';
import {afterEach, beforeEach, describe, it} from 'node:test';
import React, {act, createElement as el} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {MemoryRouter} from 'react-router-dom';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {NotesPanelBody} from '../src/features/chat/drawer-notes-panel.tsx';
import {AccountWorkspacePanel} from '../src/features/accounts/account-workspace-panel.tsx';
import AccountsPage from '../src/pages/accounts.tsx';
import AccountPage from '../src/pages/account.tsx';
import type {ConversationNote, RegistryDevice, UnifiedChat, User} from '../src/api/types.ts';
import {formatDate} from '../src/lib/format.ts';
import {useAuthStore} from '../src/stores/auth.ts';

/**
 * Phase 3 Path C — P1-11 (note edit time) + P1-12 (phone from JID) + P1-14
 * (skeleton loading rows).
 *
 * Rendered with React 19 + jsdom (no JSX: tsx does not parse JSX in .ts
 * test files, and the `npm test` glob only matches `*.test.ts`).
 *
 * Never compare DOM nodes with assert.equal/deepEqual in this file: on
 * failure Node inspects the nodes into the error message, and React-rendered
 * nodes carry __reactFiber$ trees whose inspection never finishes (the test
 * file hangs and can OOM). Compare with assert.ok(a === b) instead.
 */

const adminUser: User = {
  id: 1,
  username: 'admin',
  display_name: 'Admin',
  role: 'admin',
  role_id: 1,
  role_slug: 'admin',
  role_name: 'Admin',
  permissions: ['notes:write', 'notes:delete', 'accounts:read', 'accounts:write', 'chats:read'],
  allowed_device_ids: [],
  is_active: true,
  created_at: '',
  theme: 'light',
  language: 'ar',
};

const deviceNoPhone: RegistryDevice = {
  id: 'dev-asir',
  phone_number: undefined,
  display_name: 'Asir Account',
  alias: undefined,
  resolved_name: 'خدمات عسير',
  state: 'logged_in',
  jid: '966500000001@s.whatsapp.net',
  created_at: '2026-11-01T00:00:00.000Z',
};

const deviceWithPhone: RegistryDevice = {
  id: 'dev-tayba',
  phone_number: '966500000002',
  display_name: 'Tayba Account',
  alias: undefined,
  resolved_name: 'خدمات طيبة',
  state: 'logged_in',
  jid: '966500000002@s.whatsapp.net',
  created_at: '2026-11-01T00:00:00.000Z',
};

const deviceLid: RegistryDevice = {
  id: 'dev-lid',
  phone_number: undefined,
  display_name: 'LID Account',
  alias: undefined,
  resolved_name: 'حساب LID',
  state: 'logged_in',
  jid: '123456789@lid',
  created_at: '2026-11-01T00:00:00.000Z',
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
// Every QueryClient created by a test: cleared in afterEach. ContactAvatar
// sets gcTime: 60min on its own query, overriding the client default —
// without clear() that GC timer keeps the node:test process alive for an
// hour after the file's tests finish.
const clients: QueryClient[] = [];

function makeQueryClient(): QueryClient {
  const client = new QueryClient({
    // gcTime: 0 — React Query schedules a 5-minute GC timer when a query
    // loses its last observer on unmount; without this the node:test process
    // stays alive for 5 minutes after every DOM test.
    defaultOptions: {queries: {staleTime: Infinity, retry: false, gcTime: 0}},
  });
  clients.push(client);
  return client;
}

function flushTimers() {
  return act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

function render(element: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  return act(async () => {
    root!.render(element);
  });
}

function renderWithProviders(element: React.ReactElement, client: QueryClient) {
  return render(el(MemoryRouter, {}, el(QueryClientProvider, {client}, element)));
}

function bodyText(): string {
  return document.body.textContent ?? '';
}

function phoneRowValue(): string | null {
  const dt = Array.from(document.querySelectorAll('dt')).find(
    (d) => (d.textContent ?? '').trim() === 'رقم الهاتف',
  );
  if (!dt) return null;
  const dd = dt.parentElement?.querySelector('dd');
  return dd ? (dd.textContent ?? '').trim() : null;
}

// Text of the accounts-list rows only (the detail panel also renders the
// device JID, which contains the same digits — body-level assertions would
// pass for the wrong reason).
function listRowTexts(): string[] {
  return Array.from(document.querySelectorAll('ul li')).map((li) => li.textContent ?? '');
}

beforeEach(() => {
  window.localStorage.clear();
  useAuthStore.setState({language: 'ar', user: adminUser, status: 'authenticated'});
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
  document.body.innerHTML = '';
  for (const client of clients.splice(0)) client.clear();
  window.localStorage.clear();
  useAuthStore.setState({user: null, status: 'unauthenticated'});
});

describe('P1-11: edited notes show the edit time next to the "edited" marker', () => {
  const chatJid = '966511111111@s.whatsapp.net';
  const chat = {
    device_id: 'dev-tayba',
    jid: chatJid,
    name: 'Test Chat',
    device_display_name: 'خدمات طيبة',
    device_state: 'logged_in',
  } as unknown as UnifiedChat;

  const editedNote: ConversationNote = {
    id: 1,
    device_id: 'dev-tayba',
    chat_jid: chatJid,
    created_by_id: 1,
    created_by_name: 'Writer',
    content: 'ملاحظة معدلة',
    is_pinned: false,
    created_at: '2026-11-19T09:00:00.000Z',
    updated_at: '2026-11-20T10:30:00.000Z',
  };

  const plainNote: ConversationNote = {
    id: 2,
    device_id: 'dev-tayba',
    chat_jid: chatJid,
    created_by_id: 1,
    created_by_name: 'Writer',
    content: 'ملاحظة عادية',
    is_pinned: false,
    created_at: '2026-11-18T08:00:00.000Z',
    updated_at: '2026-11-18T08:00:00.000Z',
  };

  it('shows formatDate(updated_at) next to the edited marker', async () => {
    const client = makeQueryClient();
    client.setQueryData(['unified-chat-notes', 'dev-tayba', chatJid], {
      notes: [editedNote, plainNote],
      total: 2,
    });
    await renderWithProviders(el(NotesPanelBody, {chat}), client);
    await flushTimers();

    const text = bodyText();
    assert.ok(text.includes('معدّلة'), 'edited marker is shown');
    assert.ok(
      text.includes(formatDate('2026-11-20T10:30:00.000Z', 'ar')),
      'edit time is shown next to the marker',
    );
  });

  it('shows the edited marker exactly once: unedited notes show no edit time', async () => {
    const client = makeQueryClient();
    client.setQueryData(['unified-chat-notes', 'dev-tayba', chatJid], {
      notes: [editedNote, plainNote],
      total: 2,
    });
    await renderWithProviders(el(NotesPanelBody, {chat}), client);
    await flushTimers();

    const text = bodyText();
    assert.ok(text.match(/معدّلة/g)?.length === 1, 'only the edited note carries the marker');
    assert.ok(
      !text.includes(formatDate('2026-11-18T08:00:00.000Z', 'ar')),
      'unedited note shows no edit time',
    );
  });
});

describe('P1-12: account phone falls back to the number derived from the JID', () => {
  const noop = () => {};

  it('workspace panel: shows the JID-derived number when phone_number is missing', async () => {
    const client = makeQueryClient();
    await renderWithProviders(
      el(AccountWorkspacePanel, {
        device: deviceNoPhone,
        onBack: noop,
        onLoginQr: noop,
        onLoginCode: noop,
        onEditAlias: noop,
        onDeleted: noop,
      }),
      client,
    );
    await flushTimers();

    assert.ok(bodyText().includes('966500000001'), 'derived phone is shown in the panel');
    assert.ok(phoneRowValue() === '966500000001', 'details phone row shows the derived number');
  });

  it('workspace panel: explicit phone_number still wins over the JID', async () => {
    const client = makeQueryClient();
    await renderWithProviders(
      el(AccountWorkspacePanel, {
        device: deviceWithPhone,
        onBack: noop,
        onLoginQr: noop,
        onLoginCode: noop,
        onEditAlias: noop,
        onDeleted: noop,
      }),
      client,
    );
    await flushTimers();

    assert.ok(phoneRowValue() === '966500000002', 'explicit phone_number is shown');
  });

  it('workspace panel: an @lid JID is not shown as a phone number', async () => {
    const client = makeQueryClient();
    await renderWithProviders(
      el(AccountWorkspacePanel, {
        device: deviceLid,
        onBack: noop,
        onLoginQr: noop,
        onLoginCode: noop,
        onEditAlias: noop,
        onDeleted: noop,
      }),
      client,
    );
    await flushTimers();

    assert.ok(phoneRowValue() === '—', '@lid JID leaves the phone row empty');
  });

  it('accounts list: shows the JID-derived number, never a @lid number', async () => {
    const client = makeQueryClient();
    client.setQueryData(['devices'], [deviceNoPhone, deviceLid]);
    await renderWithProviders(el(AccountsPage, {}), client);
    await flushTimers();

    assert.ok(
      listRowTexts().some((row) => row.includes('966500000001')),
      'list row shows the derived phone number',
    );
    assert.ok(
      listRowTexts().every((row) => !row.includes('123456789')),
      '@lid local part is not shown as a number',
    );
  });
});

describe('P1-14: loading shows skeleton rows and keeps search usable', () => {
  // A never-resolving fetch keeps the ['devices'] query in-flight, so the
  // pages stay in their isLoading branch without touching the network.
  function hangDevicesQuery(client: QueryClient) {
    void client.prefetchQuery({
      queryKey: ['devices'],
      queryFn: () => new Promise<RegistryDevice[]>(() => {}),
    });
  }

  function skeletonRows(): number {
    return document.querySelectorAll('.animate-pulse').length;
  }

  function searchInput(): HTMLInputElement | null {
    return document.querySelector('input[type="search"]');
  }

  it('accounts page: 6 skeleton rows while loading, search stays enabled', async () => {
    const client = makeQueryClient();
    hangDevicesQuery(client);
    await renderWithProviders(el(AccountsPage, {}), client);
    await flushTimers();

    assert.ok(skeletonRows() === 6, `expected 6 skeleton rows, got ${skeletonRows()}`);
    const input = searchInput();
    assert.ok(input, 'search input renders while loading');
    assert.ok(input.disabled === false, 'search input stays enabled while loading');
  });

  it('account page: 6 skeleton rows while loading, search stays enabled', async () => {
    const client = makeQueryClient();
    hangDevicesQuery(client);
    await renderWithProviders(el(AccountPage, {}), client);
    await flushTimers();

    assert.ok(skeletonRows() === 6, `expected 6 skeleton rows, got ${skeletonRows()}`);
    const input = searchInput();
    assert.ok(input, 'search input renders while loading');
    assert.ok(input.disabled === false, 'search input stays enabled while loading');
  });
});
