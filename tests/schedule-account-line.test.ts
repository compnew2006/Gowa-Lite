import './schedule-account-line-dom.ts';
import assert from 'node:assert/strict';
import {afterEach, beforeEach, describe, it} from 'node:test';
import React, {act, createElement as el} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {ScheduleMessageDialog} from '../src/features/chat/schedule-dialog.tsx';
import {
  ScheduleAccountLine,
  ScheduleConfirmationSummary,
  resolveScheduleAccount,
} from '../src/features/schedules/schedule-account-line.tsx';
import ScheduledPage from '../src/pages/scheduled.tsx';
import type {RegistryDevice, UnifiedChat, User} from '../src/api/types.ts';
import {formatDate} from '../src/lib/format.ts';
import {useAuthStore} from '../src/stores/auth.ts';

/**
 * P0-4: the schedule forms must show the sending account (name + number) in a
 * fixed line at the top, and a read-only confirmation summary above submit.
 *
 * Rendered with React 19 + jsdom (no JSX: tsx does not parse JSX in .ts
 * test files, and the `npm test` glob only matches `*.test.ts`).
 *
 * Never compare DOM nodes with assert.equal/deepEqual in this file: on
 * failure Node inspects the nodes into the error message, and React-rendered
 * nodes carry __reactFiber$ trees whose inspection never finishes (the test
 * file hangs and can OOM). Compare with assert.ok(a === b) instead.
 */

const deviceAsir: RegistryDevice = {
  id: 'dev-asir',
  phone_number: '966500000001',
  display_name: 'Asir Account',
  alias: 'Asir alias',
  resolved_name: 'خدمات عسير',
  state: 'logged_in',
  created_at: '',
};

const deviceTayba: RegistryDevice = {
  id: 'dev-tayba',
  phone_number: '966500000002',
  display_name: 'Tayba Account',
  resolved_name: 'خدمات طيبة',
  state: 'logged_in',
  created_at: '',
};

const devices = [deviceAsir, deviceTayba];

const writerUser: User = {
  id: 1,
  username: 'writer',
  display_name: 'Writer',
  role: 'admin',
  role_id: 1,
  role_slug: 'admin',
  role_name: 'Admin',
  permissions: ['schedules:write', 'schedules:manage', 'schedules:read'],
  allowed_device_ids: [],
  is_active: true,
  created_at: '',
  theme: 'light',
  language: 'ar',
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function makeQueryClient(): QueryClient {
  const client = new QueryClient({
    // gcTime: 0 — React Query schedules a 5-minute GC timer when a query
    // loses its last observer on unmount; without this the node:test process
    // stays alive for 5 minutes after every DOM test.
    defaultOptions: {queries: {staleTime: Infinity, retry: false, gcTime: 0}},
  });
  client.setQueryData(['devices'], devices);
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

function bodyText(): string {
  return document.body.textContent ?? '';
}

function accountLineText(): string {
  const line = document.querySelector('[data-testid="schedule-account-line"]');
  assert.ok(line, 'schedule account line renders');
  return line.textContent ?? '';
}

function summaryText(): string {
  const summary = document.querySelector('[data-testid="schedule-confirmation-summary"]');
  assert.ok(summary, 'confirmation summary renders');
  return summary.textContent ?? '';
}

function setInputValue(input: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto =
    input instanceof window.HTMLSelectElement
      ? window.HTMLSelectElement.prototype
      : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  assert.ok(setter, 'native value setter exists');
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new window.Event('input', {bubbles: true}));
    input.dispatchEvent(new window.Event('change', {bubbles: true}));
  });
}

function clickButtonWithText(text: string): void {
  const buttons = Array.from(document.querySelectorAll('button'));
  const target = buttons.find((b) => (b.textContent ?? '').includes(text));
  assert.ok(target, `button with text "${text}" renders`);
  act(() => {
    target.click();
  });
}

beforeEach(() => {
  useAuthStore.setState({language: 'ar', user: writerUser, status: 'authenticated'});
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
  useAuthStore.setState({user: null, status: 'unauthenticated'});
});

describe('resolveScheduleAccount (account name + number resolution)', () => {
  it('prefers resolved_name, then alias, then display_name, then id', () => {
    assert.equal(resolveScheduleAccount(deviceAsir)?.name, 'خدمات عسير');
    assert.equal(
      resolveScheduleAccount({...deviceAsir, resolved_name: undefined})?.name,
      'Asir alias',
    );
    assert.equal(
      resolveScheduleAccount({...deviceAsir, resolved_name: undefined, alias: undefined})
        ?.name,
      'Asir Account',
    );
    assert.equal(
      resolveScheduleAccount({
        ...deviceAsir,
        resolved_name: undefined,
        alias: undefined,
        display_name: undefined,
      })?.name,
      'dev-asir',
    );
  });

  it('always shows a number: phone_number, falling back to the device id', () => {
    assert.equal(resolveScheduleAccount(deviceAsir)?.number, '966500000001');
    assert.equal(
      resolveScheduleAccount({...deviceAsir, phone_number: undefined})?.number,
      'dev-asir',
    );
  });

  it('returns null when no device is resolved yet', () => {
    assert.equal(resolveScheduleAccount(null), null);
    assert.equal(resolveScheduleAccount(undefined), null);
  });
});

describe('ScheduleAccountLine + ScheduleConfirmationSummary (shared blocks)', () => {
  it('renders the account name and number', async () => {
    const client = makeQueryClient();
    await render(
      el(QueryClientProvider, {client}, el(ScheduleAccountLine, {device: deviceTayba})),
    );
    await flushTimers();
    const text = accountLineText();
    assert.ok(text.includes('خدمات طيبة'), 'account name is shown');
    assert.ok(text.includes('966500000002'), 'account number is shown');
    assert.ok(!text.includes('966500000001'), 'other account number is not shown');
  });

  it('renders a read-only summary with recipient + account + date/time + timezone', async () => {
    const client = makeQueryClient();
    const scheduledAtLocal = '2026-11-28T14:30';
    await render(
      el(
        QueryClientProvider,
        {client},
        el(ScheduleConfirmationSummary, {
          recipient: '966511111111',
          device: deviceAsir,
          scheduledAtLocal,
          timezone: 'Asia/Riyadh',
        }),
      ),
    );
    await flushTimers();
    const text = summaryText();
    assert.ok(text.includes('966511111111'), 'recipient is shown');
    assert.ok(text.includes('خدمات عسير'), 'account name is shown');
    assert.ok(text.includes('966500000001'), 'account number is shown');
    assert.ok(
      text.includes(formatDate(scheduledAtLocal, 'ar')),
      'date/time is shown with the existing formatter',
    );
    assert.ok(text.includes('Asia/Riyadh'), 'timezone is shown');
  });
});

describe('ScheduleMessageDialog (chat entry point)', () => {
  function chatOnTayba(): UnifiedChat {
    return {
      device_id: 'dev-tayba',
      jid: '966511111111@s.whatsapp.net',
      name: 'Test Chat',
      device_display_name: 'خدمات طيبة',
      device_state: 'logged_in',
    } as unknown as UnifiedChat;
  }

  it('shows the account of the open chat device_id (name + number), not another device', async () => {
    const client = makeQueryClient();
    await render(
      el(
        QueryClientProvider,
        {client},
        el(ScheduleMessageDialog, {
          open: true,
          onOpenChange: () => {},
          chat: chatOnTayba(),
          initialMessage: 'hello',
        }),
      ),
    );
    await flushTimers();
    const text = accountLineText();
    assert.ok(text.includes('خدمات طيبة'), 'chat device account name is shown');
    assert.ok(text.includes('966500000002'), 'chat device account number is shown');
    assert.ok(!text.includes('خدمات عسير'), 'other device account is not shown');
    assert.ok(!text.includes('966500000001'), 'other device number is not shown');
  });

  it('shows the confirmation summary before submit', async () => {
    const client = makeQueryClient();
    await render(
      el(
        QueryClientProvider,
        {client},
        el(ScheduleMessageDialog, {
          open: true,
          onOpenChange: () => {},
          chat: chatOnTayba(),
          initialMessage: 'hello',
        }),
      ),
    );
    await flushTimers();
    const text = summaryText();
    assert.ok(text.includes('Test Chat'), 'summary shows the chat recipient');
    assert.ok(text.includes('خدمات طيبة'), 'summary shows the account name');
    assert.ok(text.includes('966500000002'), 'summary shows the account number');
    assert.ok(text.includes('Asia/Riyadh') || text.includes('UTC'), 'summary shows a timezone');
  });
});

describe('ScheduledPage create form (page entry point)', () => {
  it('follows the currently selected device when it changes', async () => {
    const client = makeQueryClient();
    await render(el(QueryClientProvider, {client}, el(ScheduledPage, {})));
    await flushTimers();

    // The page defaults to the first logged-in device (Asir).
    clickButtonWithText('جدولة رسالة');
    await flushTimers();
    const before = accountLineText();
    assert.ok(before.includes('خدمات عسير'), 'form starts on the selected device (Asir)');
    assert.ok(before.includes('966500000001'), 'form starts on the selected device number');

    // Switch the account selector to Tayba: the form line must follow it.
    const select = document.querySelector(
      '#active-device-select',
    ) as HTMLSelectElement | null;
    assert.ok(select, 'account selector renders');
    setInputValue(select, 'dev-tayba');
    await flushTimers();
    const after = accountLineText();
    assert.ok(after.includes('خدمات طيبة'), 'form follows the newly selected device');
    assert.ok(after.includes('966500000002'), 'form follows the new device number');
    assert.ok(!after.includes('966500000001'), 'old device number is gone after switching');
  });

  it('shows the confirmation summary in the create form with the typed recipient', async () => {
    const client = makeQueryClient();
    await render(el(QueryClientProvider, {client}, el(ScheduledPage, {})));
    await flushTimers();
    clickButtonWithText('جدولة رسالة');
    await flushTimers();

    const phone = document.querySelector('#sched-phone') as HTMLInputElement | null;
    assert.ok(phone, 'recipient input renders');
    setInputValue(phone, '966511111111');
    await flushTimers();

    const text = summaryText();
    assert.ok(text.includes('966511111111'), 'summary shows the typed recipient');
    assert.ok(text.includes('خدمات عسير'), 'summary shows the selected account name');
    assert.ok(text.includes('966500000001'), 'summary shows the selected account number');
    assert.ok(text.includes('Asia/Riyadh') || text.includes('UTC'), 'summary shows a timezone');
  });
});

describe('P0-4 scope guard: dialog is not rebuilt as composer-driven', () => {
  it('keeps the existing dialog form (message textarea + recurrence fields + submit)', async () => {
    const client = makeQueryClient();
    await render(
      el(
        QueryClientProvider,
        {client},
        el(ScheduleMessageDialog, {
          open: true,
          onOpenChange: () => {},
          chat: {
            device_id: 'dev-tayba',
            jid: '966511111111@s.whatsapp.net',
            name: 'Test Chat',
            device_display_name: 'خدمات طيبة',
            device_state: 'logged_in',
          } as unknown as UnifiedChat,
          initialMessage: 'hello',
        }),
      ),
    );
    await flushTimers();
    const text = bodyText();
    assert.ok(
      document.querySelector('#chat-sched-msg'),
      'message textarea is still present',
    );
    assert.ok(text.includes('تأكيد الجدولة'), 'submit button is still present');
  });
});
