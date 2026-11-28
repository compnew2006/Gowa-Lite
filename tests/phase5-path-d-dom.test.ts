import './schedule-account-line-dom.ts';
import assert from 'node:assert/strict';
import {afterEach, beforeEach, describe, it} from 'node:test';
import React, {act, createElement as el, useState} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {MemoryRouter} from 'react-router-dom';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {Toaster} from 'sonner';
import {AppShell} from '../src/components/layout/app-shell.tsx';
import {useDevicesQuery} from '../src/components/device-selector-bar.tsx';
import {ScheduleRecurrenceFields} from '../src/features/schedules/schedule-recurrence-fields.tsx';
import AccountsPage from '../src/pages/accounts.tsx';
import ChatsPage from '../src/pages/chats.tsx';
import ScheduledPage from '../src/pages/scheduled.tsx';
import {DEFAULT_UNIFIED_CHATS_QUERY_KEY} from '../src/features/chat/inbox-query-keys.ts';
import type {RegistryDevice, UnifiedChatsResponse, User} from '../src/api/types.ts';
import {useAuthStore} from '../src/stores/auth.ts';

// jsdom has no ResizeObserver; the chat workspace's resizable sidebar uses
// one on mount. A no-op stub keeps the page tests on the component logic.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

/**
 * Phase 5 Path D — P2-4 (free-text date field) + P2-3 (collapsible nav
 * rail) + P2-5 (row reconnect button) + P2-6 (shared ['devices'] query).
 *
 * Rendered with React 19 + jsdom (no JSX: tsx does not parse JSX in .ts
 * test files). Never compare DOM nodes with assert.equal/deepEqual: on
 * failure Node inspects the nodes into the error message, and
 * React-rendered nodes carry __reactFiber$ trees whose inspection never
 * finishes. Compare with assert.ok(a === b) instead.
 */

const adminUser: User = {
  id: 1,
  username: 'admin',
  display_name: 'Admin',
  role: 'admin',
  role_id: 1,
  role_slug: 'admin',
  role_name: 'Admin',
  permissions: [
    'accounts:read',
    'accounts:write',
    'chats:read',
    'chats:write',
    'chats:view_all',
    'chats:assign',
    'chats:close',
    'schedules:read',
    'schedules:write',
    'schedules:manage',
    'groups:read',
  ],
  allowed_device_ids: [],
  is_active: true,
  created_at: '',
  theme: 'light',
  language: 'ar',
};

const readOnlyUser: User = {
  ...adminUser,
  id: 2,
  username: 'reader',
  display_name: 'Reader',
  role: 'agent',
  role_slug: 'agent',
  role_name: 'Agent',
  permissions: ['accounts:read', 'chats:read'],
};

const deviceOnline: RegistryDevice = {
  id: 'dev-online',
  phone_number: '966500000001',
  display_name: 'Online Account',
  resolved_name: 'حساب متصل',
  state: 'logged_in',
  jid: '966500000001@s.whatsapp.net',
  created_at: '2026-11-01T00:00:00.000Z',
};

const deviceOffline: RegistryDevice = {
  id: 'dev-offline',
  phone_number: '966500000002',
  display_name: 'Offline Account',
  resolved_name: 'حساب مفصول',
  state: 'disconnected',
  jid: '966500000002@s.whatsapp.net',
  created_at: '2026-11-01T00:00:00.000Z',
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const clients: QueryClient[] = [];

function makeQueryClient(): QueryClient {
  const client = new QueryClient({
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
  return render(
    el(
      MemoryRouter,
      {},
      el(
        QueryClientProvider,
        {client},
        el(React.Fragment, null, el(Toaster, null), element),
      ),
    ),
  );
}

function bodyText(): string {
  return document.body.textContent ?? '';
}

function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    input instanceof window.HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  assert.ok(setter, 'native value setter exists');
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new window.Event('input', {bubbles: true}));
    input.dispatchEvent(new window.Event('change', {bubbles: true}));
  });
}

function blurInput(input: HTMLElement) {
  act(() => {
    input.focus();
    input.blur();
  });
}

function clickButton(button: HTMLButtonElement) {
  act(() => {
    button.click();
  });
}

function buttonByExactText(text: string): HTMLButtonElement | null {
  return (
    Array.from(document.querySelectorAll('button')).find(
      (b) => (b.textContent ?? '').trim() === text,
    ) ?? null
  );
}

function setAuthUser(user: User | null) {
  useAuthStore.setState({
    language: 'ar',
    user,
    status: user ? 'authenticated' : 'unauthenticated',
  });
}

beforeEach(() => {
  setAuthUser(null);
  window.localStorage.clear();
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
  setAuthUser(null);
  window.localStorage.clear();
});

function FreeTextHarness({
  onErrorChange,
}: {
  onErrorChange?: (error: string | null) => void;
}) {
  const [at, setAt] = useState('2030-06-01T09:00');
  return el(ScheduleRecurrenceFields, {
    idPrefix: 't',
    scheduledAtLocal: at,
    onScheduledAtChange: setAt,
    timezone: 'Asia/Riyadh',
    onTimezoneChange: () => {},
    recurrence: 'once',
    onRecurrenceChange: () => {},
    weekdays: [],
    onWeekdaysChange: () => {},
    dayOfMonth: '1',
    onDayOfMonthChange: () => {},
    occurrenceLimit: '',
    onOccurrenceLimitChange: () => {},
    endAtLocal: '',
    onEndAtChange: () => {},
    onFreeTextErrorChange: onErrorChange,
  });
}

function freeTextInput(): HTMLInputElement | null {
  return document.querySelector('#t-at-text') as HTMLInputElement | null;
}

function pickerInput(): HTMLInputElement | null {
  return document.querySelector('#t-at') as HTMLInputElement | null;
}

function freeTextError(): string | null {
  return document.querySelector('#t-at-text-error')?.textContent ?? null;
}

describe('P2-4: free-text date field next to the picker', () => {
  it('renders a free-text input beside the datetime-local picker', async () => {
    const client = makeQueryClient();
    await renderWithProviders(el(FreeTextHarness, {}), client);
    await flushTimers();
    assert.ok(pickerInput(), 'datetime-local picker renders');
    assert.ok(freeTextInput(), 'free-text date input renders');
  });

  it('pasted valid text fills the picker on blur', async () => {
    const client = makeQueryClient();
    await renderWithProviders(el(FreeTextHarness, {}), client);
    await flushTimers();
    const input = freeTextInput();
    assert.ok(input, 'free-text input renders');
    setInputValue(input, '15/01/2030 14:30');
    blurInput(input);
    await flushTimers();
    assert.ok(pickerInput()?.value === '2030-01-15T14:30', 'picker takes the parsed date');
    assert.ok(freeTextError() === null, 'no error for a valid date');
  });

  it('applies valid text on Enter as well', async () => {
    const client = makeQueryClient();
    await renderWithProviders(el(FreeTextHarness, {}), client);
    await flushTimers();
    const input = freeTextInput();
    assert.ok(input, 'free-text input renders');
    setInputValue(input, '2030-02-20 08:15');
    act(() => {
      input.dispatchEvent(new window.KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
    });
    await flushTimers();
    assert.ok(pickerInput()?.value === '2030-02-20T08:15', 'Enter applies the parsed date');
  });

  it('invalid text shows a clear error and leaves the picker unchanged', async () => {
    const errors: Array<string | null> = [];
    const client = makeQueryClient();
    await renderWithProviders(
      el(FreeTextHarness, {onErrorChange: (e) => errors.push(e)}),
      client,
    );
    await flushTimers();
    const input = freeTextInput();
    assert.ok(input, 'free-text input renders');
    setInputValue(input, 'not a date');
    blurInput(input);
    await flushTimers();
    assert.ok(
      (freeTextError() ?? '').includes('2026-11-30 15:30'),
      `invalid-date error is shown, got: ${freeTextError()}`,
    );
    assert.ok(pickerInput()?.value === '2030-06-01T09:00', 'picker keeps its previous value');
    assert.ok(errors.length > 0 && errors[errors.length - 1] !== null, 'parent is told the text is invalid');
  });

  it('a past date shows the future-time error and leaves the picker unchanged', async () => {
    const client = makeQueryClient();
    await renderWithProviders(el(FreeTextHarness, {}), client);
    await flushTimers();
    const input = freeTextInput();
    assert.ok(input, 'free-text input renders');
    setInputValue(input, '2020-01-01 10:00');
    blurInput(input);
    await flushTimers();
    assert.ok(
      (freeTextError() ?? '').includes('المستقبل'),
      `past-date error is shown, got: ${freeTextError()}`,
    );
    assert.ok(pickerInput()?.value === '2030-06-01T09:00', 'picker keeps its previous value');
  });

  it('fixing the text clears the error and notifies the parent', async () => {
    const errors: Array<string | null> = [];
    const client = makeQueryClient();
    await renderWithProviders(
      el(FreeTextHarness, {onErrorChange: (e) => errors.push(e)}),
      client,
    );
    await flushTimers();
    const input = freeTextInput();
    assert.ok(input, 'free-text input renders');
    setInputValue(input, 'garbage');
    blurInput(input);
    await flushTimers();
    assert.ok(freeTextError() !== null, 'error shows for garbage text');
    setInputValue(input, '2030-03-10 11:00');
    blurInput(input);
    await flushTimers();
    assert.ok(freeTextError() === null, 'error clears after a valid date');
    assert.ok(errors[errors.length - 1] === null, 'parent is told the text is valid again');
    assert.ok(pickerInput()?.value === '2030-03-10T11:00', 'picker takes the fixed date');
  });
});

describe('P2-4: an invalid free-text date blocks submitting the schedule', () => {
  it('scheduled page: submit with a bad free-text date toasts the error and stays open', async () => {
    setAuthUser(adminUser);
    const client = makeQueryClient();
    client.setQueryData(['devices'], [deviceOnline]);
    await renderWithProviders(el(ScheduledPage, {}), client);
    await flushTimers();
    await flushTimers();

    const newButton = buttonByExactText('جدولة رسالة');
    assert.ok(newButton, 'new-schedule button renders once a device is selected');
    clickButton(newButton);
    await flushTimers();
    assert.ok(bodyText().includes('جدولة رسالة جديدة'), 'create dialog opens');

    const phone = document.querySelector('#sched-phone') as HTMLInputElement | null;
    const message = document.querySelector('#sched-message') as HTMLTextAreaElement | null;
    const freeText = document.querySelector('#sched-at-text') as HTMLInputElement | null;
    assert.ok(phone && message && freeText, 'dialog fields render');
    setInputValue(phone, '966500000000');
    setInputValue(message, 'hello');
    setInputValue(freeText, 'not a date');
    blurInput(freeText);
    await flushTimers();
    assert.ok(
      (document.querySelector('#sched-at-text-error')?.textContent ?? '').includes('2026-11-30 15:30'),
      'invalid-date error shows in the dialog',
    );

    const submit = document.querySelector('button[type="submit"]') as HTMLButtonElement | null;
    assert.ok(submit, 'submit button renders');
    clickButton(submit);
    await flushTimers();
    assert.ok(
      bodyText().includes('2026-11-30 15:30'),
      'submit surfaces the invalid-date error instead of sending',
    );
    assert.ok(!bodyText().includes('تمت جدولة الرسالة بنجاح'), 'no success toast: nothing was sent');
    assert.ok(bodyText().includes('جدولة رسالة جديدة'), 'dialog stays open after the blocked submit');
  });
});

describe('P2-3: collapsible nav rail (decision 16)', () => {
  function railAside(): HTMLElement | null {
    return document.querySelector('aside[aria-label="التنقل الرئيسي"]');
  }

  function toggleButton(): HTMLButtonElement | null {
    return document.querySelector('button[aria-label="توسيع الشريط الجانبي"], button[aria-label="طيّ الشريط الجانبي"]');
  }

  it('defaults to collapsed (62px), hides labels, and expands on toggle', async () => {
    setAuthUser(adminUser);
    const client = makeQueryClient();
    await renderWithProviders(el(AppShell, {}), client);
    await flushTimers();

    const aside = railAside();
    assert.ok(aside, 'desktop rail renders');
    assert.ok(aside.className.includes('w-[62px]'), `rail starts collapsed, got: ${aside.className}`);
    assert.ok(!bodyText().includes('المحادثات'), 'labels are hidden while collapsed');

    const toggle = toggleButton();
    assert.ok(toggle, 'expand toggle renders');
    assert.ok(toggle.getAttribute('aria-label') === 'توسيع الشريط الجانبي', 'toggle offers expanding');
    clickButton(toggle);
    await flushTimers();

    assert.ok(railAside()?.className.includes('w-60'), 'rail expands to w-60');
    assert.ok(bodyText().includes('المحادثات'), 'labels appear when expanded');
    assert.ok(
      window.localStorage.getItem('gowa-lite:nav-rail-expanded') === '1',
      'expanded state is persisted',
    );
    assert.ok(
      toggleButton()?.getAttribute('aria-label') === 'طيّ الشريط الجانبي',
      'toggle now offers collapsing',
    );
  });

  it('collapses again on a second toggle and persists the collapsed state', async () => {
    setAuthUser(adminUser);
    const client = makeQueryClient();
    window.localStorage.setItem('gowa-lite:nav-rail-expanded', '1');
    await renderWithProviders(el(AppShell, {}), client);
    await flushTimers();

    assert.ok(railAside()?.className.includes('w-60'), 'saved expanded state is restored');
    const toggle = toggleButton();
    assert.ok(toggle, 'collapse toggle renders');
    clickButton(toggle);
    await flushTimers();
    assert.ok(railAside()?.className.includes('w-[62px]'), 'rail collapses again');
    assert.ok(
      window.localStorage.getItem('gowa-lite:nav-rail-expanded') === '0',
      'collapsed state is persisted',
    );
    assert.ok(!bodyText().includes('المحادثات'), 'labels hide again after collapsing');
  });
});

describe('P2-5: reconnect button in the account list row', () => {
  function reconnectButtons(): HTMLButtonElement[] {
    return Array.from(document.querySelectorAll('button')).filter(
      (b) => (b.textContent ?? '').trim() === 'إعادة ربط',
    ) as HTMLButtonElement[];
  }

  it('shows a reconnect button only on disconnected rows and opens the QR dialog', async () => {
    setAuthUser(adminUser);
    const client = makeQueryClient();
    client.setQueryData(['devices'], [deviceOnline, deviceOffline]);
    await renderWithProviders(el(AccountsPage, {}), client);
    await flushTimers();
    await flushTimers();

    const buttons = reconnectButtons();
    assert.ok(buttons.length === 1, `exactly one reconnect button (offline row), got ${buttons.length}`);
    clickButton(buttons[0]);
    await flushTimers();
    assert.ok(bodyText().includes('الربط عبر رمز QR'), 'QR pairing dialog opens from the row button');
  });

  it('shows no reconnect button without accounts:write', async () => {
    setAuthUser(readOnlyUser);
    const client = makeQueryClient();
    client.setQueryData(['devices'], [deviceOnline, deviceOffline]);
    await renderWithProviders(el(AccountsPage, {}), client);
    await flushTimers();
    await flushTimers();

    assert.ok(reconnectButtons().length === 0, 'read-only user sees no row reconnect button');
  });
});

describe('P2-6: one shared devices query for chats and scheduled', () => {
  function DevicesProbe() {
    const {data} = useDevicesQuery();
    return el('div', {id: 'devices-probe'}, (data ?? []).map((d) => d.id).join(','));
  }

  function devicesObservers(client: QueryClient): number {
    return client.getQueryCache().find({queryKey: ['devices']})?.getObserversCount() ?? 0;
  }

  it('useDevicesQuery serves the shared ["devices"] key', async () => {
    const client = makeQueryClient();
    client.setQueryData(['devices'], [deviceOnline, deviceOffline]);
    await renderWithProviders(el(DevicesProbe, {}), client);
    await flushTimers();
    assert.ok(
      document.querySelector('#devices-probe')?.textContent === 'dev-online,dev-offline',
      'shared query data reaches the consumer',
    );
    assert.ok(devicesObservers(client) >= 1, 'consumer subscribes to the ["devices"] query');
  });

  it('scheduled page refetches devices on entry when the cache is stale', async () => {
    setAuthUser(adminUser);
    const client = makeQueryClient();
    // A minutes-old cached list: the page must not trust it — entering
    // must trigger a devices refetch. (staleTime is Infinity in this test
    // client, so React Query's automatic mount refetch does NOT fire for
    // seeded data; only the page's explicit entry refetch can fetch here.)
    client.setQueryData(['devices'], [deviceOnline], {
      updatedAt: Date.now() - 60_000,
    });
    await renderWithProviders(el(ScheduledPage, {}), client);
    await flushTimers();
    await flushTimers();
    const entry = client.getQueryCache().find({queryKey: ['devices']});
    assert.ok(
      (entry?.state.fetchFailureCount ?? 0) >= 1,
      'entering the scheduled page triggers a devices refetch for a stale cache',
    );
  });

  it('scheduled page does not refetch devices on entry when the cache is fresh', async () => {
    setAuthUser(adminUser);
    const client = makeQueryClient();
    // Fresh cached data (just fetched): the shared query already
    // guarantees this page sees the same list as chats, so no refetch —
    // and the P1-9 refresh button stays usable while the page loads.
    client.setQueryData(['devices'], [deviceOnline]);
    await renderWithProviders(el(ScheduledPage, {}), client);
    await flushTimers();
    await flushTimers();
    const entry = client.getQueryCache().find({queryKey: ['devices']});
    assert.ok(
      (entry?.state.fetchFailureCount ?? 0) === 0,
      'a fresh devices cache is trusted on entry (no refetch)',
    );
  });

  it('chats page subscribes to the same ["devices"] query', async () => {
    setAuthUser(adminUser);
    const client = makeQueryClient();
    client.setQueryData(['devices'], [deviceOnline, deviceOffline]);
    const emptyInbox: UnifiedChatsResponse = {
      data: [],
      total: 0,
      total_unread: 0,
      accounts: [
        {id: 'dev-online', display_name: 'حساب متصل', phone_number: '966500000001', state: 'logged_in'},
        {id: 'dev-offline', display_name: 'حساب مفصول', phone_number: '966500000002', state: 'disconnected'},
      ],
      device_errors: [],
    };
    client.setQueryData(DEFAULT_UNIFIED_CHATS_QUERY_KEY, emptyInbox);
    await renderWithProviders(el(ChatsPage, {}), client);
    await flushTimers();
    await flushTimers();
    assert.ok(
      devicesObservers(client) >= 1,
      'chats page subscribes to the shared ["devices"] query',
    );
  });
});
