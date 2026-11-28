import './schedule-account-line-dom.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, afterEach, before, beforeEach, describe, it} from 'node:test';
import React, {act, createElement as el} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {MemoryRouter} from 'react-router-dom';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {DeviceSelectorBar, useActiveDevice} from '../src/components/device-selector-bar.tsx';
import {ScheduleRecurrenceFields} from '../src/features/schedules/schedule-recurrence-fields.tsx';
import ScheduledPage from '../src/pages/scheduled.tsx';import {
  applySchedulePreset,
  formatPresetDateTimeLocal,
  ScheduleValidationError,
  validateAndBuildScheduleFields,
  type SchedulePreset,
} from '../src/features/schedules/schedule-utils.ts';
import {
  ACTIVE_DEVICE_STORAGE_KEY,
  CHAT_DEVICE_FILTER_STORAGE_KEY,
  filterExistingDeviceIds,
  readSavedActiveDeviceId,
  readSavedChatDeviceIds,
  saveActiveDeviceId,
  saveChatDeviceIds,
} from '../src/lib/active-device.ts';
import type {RegistryDevice} from '../src/api/types.ts';
import {useAuthStore} from '../src/stores/auth.ts';

/**
 * Phase 2 — Path C (P1-8 + P1-9 + P1-20 + P1-21): persisted active device +
 * chat filter, refresh button states, quick-preset dates, recurrence end rule.
 *
 * Rendered with React 19 + jsdom (no JSX: tsx does not parse JSX in .ts
 * test files, and the `npm test` glob only matches `*.test.ts`).
 *
 * Never compare DOM nodes with assert.equal/deepEqual in this file: on
 * failure Node inspects the nodes into the error message, and React-rendered
 * nodes carry __reactFiber$ trees whose inspection never finishes (the test
 * file hangs and can OOM). Compare with assert.ok(a === b) instead.
 */

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gowa-lite-phase2-c-'));
process.env.GOWA_LITE_DB_PATH = path.join(tempDir, 'test.db');

type GowaModule = typeof import('../server/gowa-client.ts');
type ScheduleServiceModule = typeof import('../server/services/schedule-service.ts');

let gowaMod: GowaModule;
let schedSvc: ScheduleServiceModule;

before(async () => {
  gowaMod = await import('../server/gowa-client.ts');
  schedSvc = await import('../server/services/schedule-service.ts');
});

after(() => {
  try {
    fs.rmSync(tempDir, {recursive: true, force: true});
  } catch {
    // ignore
  }
});

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

const deviceOffline: RegistryDevice = {
  id: 'dev-off',
  phone_number: '966500000003',
  display_name: 'Offline Account',
  resolved_name: 'حساب غير متصل',
  state: 'disconnected',
  created_at: '',
};

const devices = [deviceAsir, deviceTayba, deviceOffline];

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
    // Phase 3 track D: ScheduledPage reads ?search= — it needs a router context.
    root!.render(el(MemoryRouter, {}, element));
  });
}

function setSelectValue(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLSelectElement.prototype,
    'value',
  )?.set;
  assert.ok(setter, 'native value setter exists');
  act(() => {
    setter.call(select, value);
    select.dispatchEvent(new window.Event('input', {bubbles: true}));
    select.dispatchEvent(new window.Event('change', {bubbles: true}));
  });
}

function activeDeviceSelect(): HTMLSelectElement {
  const select = document.querySelector('#active-device-select') as HTMLSelectElement | null;
  assert.ok(select, 'active device select renders');
  return select;
}

function refreshButton(): HTMLButtonElement {
  const button = document.querySelector(
    'button[aria-label="تحديث"]',
  ) as HTMLButtonElement | null;
  assert.ok(button, 'refresh button renders');
  return button;
}

function ActiveDeviceProbe() {
  const deviceState = useActiveDevice();
  return el(DeviceSelectorBar, {
    devices: deviceState.devices,
    selectedDevice: deviceState.selectedDevice,
    selectedDeviceId: deviceState.selectedDeviceId,
    onSelectDevice: deviceState.setSelectedDeviceId,
    isLoading: deviceState.isLoading,
    isFetching: deviceState.isFetching,
    error: deviceState.error,
    onRefresh: () => {
      void deviceState.refetch();
    },
  });
}

beforeEach(() => {
  useAuthStore.setState({language: 'ar', user: null, status: 'unauthenticated'});
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
  window.localStorage.clear();
  useAuthStore.setState({user: null, status: 'unauthenticated'});
});

describe('active-device storage helpers (P1-8)', () => {
  it('uses the gowa-lite:active-device key and round-trips the saved id', () => {
    assert.equal(ACTIVE_DEVICE_STORAGE_KEY, 'gowa-lite:active-device');
    assert.equal(readSavedActiveDeviceId(), null);
    saveActiveDeviceId('dev-tayba');
    assert.equal(readSavedActiveDeviceId(), 'dev-tayba');
    assert.equal(window.localStorage.getItem('gowa-lite:active-device'), 'dev-tayba');
    saveActiveDeviceId('');
    assert.equal(readSavedActiveDeviceId(), null);
    assert.equal(window.localStorage.getItem('gowa-lite:active-device'), null);
  });

  it('round-trips the saved chat device filter and tolerates bad stored JSON', () => {
    assert.deepEqual(readSavedChatDeviceIds(), []);
    saveChatDeviceIds(['dev-asir', 'dev-tayba']);
    assert.deepEqual(readSavedChatDeviceIds(), ['dev-asir', 'dev-tayba']);
    assert.equal(
      window.localStorage.getItem(CHAT_DEVICE_FILTER_STORAGE_KEY),
      JSON.stringify(['dev-asir', 'dev-tayba']),
    );
    saveChatDeviceIds([]);
    assert.deepEqual(readSavedChatDeviceIds(), []);
    window.localStorage.setItem(CHAT_DEVICE_FILTER_STORAGE_KEY, 'not-json{');
    assert.deepEqual(readSavedChatDeviceIds(), []);
    window.localStorage.setItem(CHAT_DEVICE_FILTER_STORAGE_KEY, JSON.stringify('dev-asir'));
    assert.deepEqual(readSavedChatDeviceIds(), []);
  });

  it('keeps only ids that still exist when pruning a saved filter', () => {
    assert.deepEqual(filterExistingDeviceIds(['dev-asir', 'dev-gone'], ['dev-asir']), [
      'dev-asir',
    ]);
    assert.deepEqual(filterExistingDeviceIds([], ['dev-asir']), []);
    assert.deepEqual(filterExistingDeviceIds(['dev-gone'], []), []);
  });
});

describe('useActiveDevice persistence (P1-8)', () => {
  it('restores the saved device instead of the first logged-in device', async () => {
    window.localStorage.setItem('gowa-lite:active-device', 'dev-tayba');
    const client = makeQueryClient();
    await render(el(QueryClientProvider, {client}, el(ActiveDeviceProbe, {})));
    await flushTimers();
    assert.equal(activeDeviceSelect().value, 'dev-tayba');
  });

  it('persists a newly selected device and restores it after remount', async () => {
    const client = makeQueryClient();
    await render(el(QueryClientProvider, {client}, el(ActiveDeviceProbe, {})));
    await flushTimers();
    assert.equal(activeDeviceSelect().value, 'dev-asir');

    setSelectValue(activeDeviceSelect(), 'dev-tayba');
    await flushTimers();
    assert.equal(window.localStorage.getItem('gowa-lite:active-device'), 'dev-tayba');

    await act(async () => {
      root!.unmount();
    });
    root = null;
    container!.remove();
    container = null;
    document.body.innerHTML = '';

    const client2 = makeQueryClient();
    await render(el(QueryClientProvider, {client: client2}, el(ActiveDeviceProbe, {})));
    await flushTimers();
    assert.equal(activeDeviceSelect().value, 'dev-tayba');
  });

  it('falls back to the first logged-in device when the saved device is gone', async () => {
    window.localStorage.setItem('gowa-lite:active-device', 'dev-gone');
    const client = makeQueryClient();
    await render(el(QueryClientProvider, {client}, el(ActiveDeviceProbe, {})));
    await flushTimers();
    assert.equal(activeDeviceSelect().value, 'dev-asir');
  });

  it('does not restore a saved device that is no longer logged in', async () => {
    window.localStorage.setItem('gowa-lite:active-device', 'dev-off');
    const client = makeQueryClient();
    await render(el(QueryClientProvider, {client}, el(ActiveDeviceProbe, {})));
    await flushTimers();
    assert.equal(activeDeviceSelect().value, 'dev-asir');
  });
});

describe('DeviceSelectorBar refresh button (P1-9)', () => {
  it('is disabled with an explanatory title only while devices are fetching', async () => {
    const client = makeQueryClient();
    await render(
      el(
        QueryClientProvider,
        {client},
        el(DeviceSelectorBar, {
          devices,
          selectedDevice: deviceAsir,
          selectedDeviceId: 'dev-asir',
          onSelectDevice: () => {},
          isLoading: false,
          isFetching: true,
          error: null,
          onRefresh: () => {},
        }),
      ),
    );
    await flushTimers();
    const button = refreshButton();
    assert.equal(button.disabled, true);
    assert.equal(button.getAttribute('title'), 'جارٍ تحديث قائمة الحسابات…');
  });

  it('is enabled with the plain refresh title when devices are not fetching', async () => {
    const client = makeQueryClient();
    await render(
      el(
        QueryClientProvider,
        {client},
        el(DeviceSelectorBar, {
          devices,
          selectedDevice: deviceAsir,
          selectedDeviceId: 'dev-asir',
          onSelectDevice: () => {},
          isLoading: false,
          isFetching: false,
          error: null,
          onRefresh: () => {},
        }),
      ),
    );
    await flushTimers();
    const button = refreshButton();
    assert.equal(button.disabled, false);
    assert.equal(button.getAttribute('title'), 'تحديث');
  });
});

describe('ScheduledPage refresh button wiring (P1-9)', () => {
  it('stays enabled while the schedules list itself is fetching', async () => {
    const client = makeQueryClient();
    // Hold the page's schedules query in flight: the component's useQuery
    // joins the in-flight fetch for the same key instead of starting its
    // own, so isFetching stays true for ['schedules', ...] the whole time.
    void client.fetchQuery({
      queryKey: ['schedules', 'dev-asir', 'all', 'all', '', 0],
      queryFn: () => new Promise<never>(() => {}),
    });
    await render(el(QueryClientProvider, {client}, el(ScheduledPage, {})));
    await flushTimers();
    assert.ok(
      client.isFetching({queryKey: ['schedules']}) > 0,
      'a schedules fetch is in flight during the assertion',
    );
    const button = refreshButton();
    assert.equal(button.disabled, false);
    assert.equal(button.getAttribute('title'), 'تحديث');
  });
});

describe('quick preset dates (P1-20)', () => {
  const fixedNow = new Date(2026, 10, 28, 10, 0, 0).getTime();
  let realDateNow: () => number;

  beforeEach(() => {
    realDateNow = Date.now;
    Date.now = () => fixedNow;
  });

  afterEach(() => {
    Date.now = realDateNow;
  });

  it('formats a datetime-local value as a short DD/MM HH:mm date', () => {
    assert.equal(formatPresetDateTimeLocal('2026-11-28T09:00'), '28/11 09:00');
    assert.equal(formatPresetDateTimeLocal('2026-01-05T23:59'), '05/01 23:59');
    assert.equal(formatPresetDateTimeLocal(''), '');
    assert.equal(formatPresetDateTimeLocal('not-a-date'), '');
  });

  it('shows the computed date beside every quick-preset label', async () => {
    const client = makeQueryClient();
    const presets: ReadonlyArray<readonly [SchedulePreset, string]> = [
      ['5m', 'بعد 5 دقائق'],
      ['30m', 'بعد 30 دقيقة'],
      ['1h', 'بعد ساعة'],
      ['tomorrow', 'غدًا 9:00 ص'],
      ['monday', 'الإثنين 9:00 ص'],
    ];
    await render(
      el(
        QueryClientProvider,
        {client},
        el(ScheduleRecurrenceFields, {
          idPrefix: 'test',
          scheduledAtLocal: '2026-11-28T10:15',
          onScheduledAtChange: () => {},
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
        }),
      ),
    );
    await flushTimers();
    const buttons = Array.from(document.querySelectorAll('button'));
    for (const [preset, label] of presets) {
      const expected = formatPresetDateTimeLocal(applySchedulePreset(preset, fixedNow));
      const target = buttons.find((b) => (b.textContent ?? '').includes(label));
      assert.ok(target, `preset button "${label}" renders`);
      assert.ok(
        (target.textContent ?? '').includes(expected),
        `preset "${label}" shows its computed date ${expected}`,
      );
    }
  });
});

describe('recurrence must end: frontend validation (P1-21)', () => {
  const now = 1_700_000_000_000;
  const futureLocal = '2026-11-28T10:05';
  const errorMessages = {
    pastTime: 'past',
    invalidEndAt: 'invalid_end',
    recurrenceEndRequired: 'recurrence needs an end',
  };

  function fields(overrides: Record<string, unknown> = {}) {
    return {
      message: 'Reminder',
      scheduledAtLocal: futureLocal,
      timezone: 'UTC',
      recurrence: 'daily' as const,
      weekdays: [],
      dayOfMonth: '1',
      occurrenceLimit: '',
      endAtLocal: '',
      ...overrides,
    };
  }

  it('rejects a recurrence with neither an end date nor an occurrence limit', () => {
    assert.throws(
      () => validateAndBuildScheduleFields(fields(), errorMessages, now),
      (err: unknown) =>
        err instanceof ScheduleValidationError && err.message === 'recurrence needs an end',
    );
  });

  it('rejects a recurrence with a zero occurrence limit and no end date', () => {
    assert.throws(
      () =>
        validateAndBuildScheduleFields(
          fields({occurrenceLimit: '0'}),
          errorMessages,
          now,
        ),
      (err: unknown) =>
        err instanceof ScheduleValidationError && err.message === 'recurrence needs an end',
    );
  });

  it('accepts a recurrence with an end date', () => {
    const validated = validateAndBuildScheduleFields(
      fields({endAtLocal: '2026-12-28T10:05'}),
      errorMessages,
      now,
    );
    assert.equal(validated.recurrence, 'daily');
    assert.ok(validated.end_at);
    assert.equal(validated.occurrence_limit, undefined);
  });

  it('accepts a recurrence with an occurrence limit', () => {
    const validated = validateAndBuildScheduleFields(
      fields({occurrenceLimit: '5'}),
      errorMessages,
      now,
    );
    assert.equal(validated.recurrence, 'daily');
    assert.equal(validated.occurrence_limit, 5);
    assert.equal(validated.end_at, undefined);
  });

  it('still allows a one-off send with neither an end date nor a limit', () => {
    const validated = validateAndBuildScheduleFields(
      fields({recurrence: 'once'}),
      errorMessages,
      now,
    );
    assert.equal(validated.recurrence, 'once');
  });
});

describe('recurrence must end: server validation (P1-21)', () => {
  const now = 1_700_000_000_000;
  const validTime = new Date(now + 120_000).toISOString();

  function body(overrides: Record<string, unknown> = {}) {
    return {
      message: 'Hello',
      scheduled_at: validTime,
      recurrence: 'daily',
      ...overrides,
    };
  }

  it('rejects an open-ended recurrence with neither end_at nor occurrence_limit', () => {
    assert.throws(
      () =>
        schedSvc.validateAndBuildSchedulePayload(body(), {
          fixedPhone: '966500000000@s.whatsapp.net',
          nowMs: now,
        }),
      (err: unknown) =>
        err instanceof gowaMod.GowaError &&
        err.status === 400 &&
        err.code === 'VALIDATION_ERROR' &&
        err.message.includes('التكرار'),
    );
  });

  it('accepts a recurrence with an end date', () => {
    const payload = schedSvc.validateAndBuildSchedulePayload(
      body({end_at: new Date(now + 86_400_000).toISOString()}),
      {fixedPhone: '966500000000@s.whatsapp.net', nowMs: now},
    );
    assert.ok(payload.end_at);
    assert.equal(payload.occurrence_limit, undefined);
  });

  it('accepts a recurrence with an occurrence limit', () => {
    const payload = schedSvc.validateAndBuildSchedulePayload(body({occurrence_limit: 5}), {
      fixedPhone: '966500000000@s.whatsapp.net',
      nowMs: now,
    });
    assert.equal(payload.occurrence_limit, 5);
    assert.equal(payload.end_at, undefined);
  });

  it('still allows a one-off send with neither an end date nor a limit', () => {
    const payload = schedSvc.validateAndBuildSchedulePayload(body({recurrence: 'once'}), {
      fixedPhone: '966500000000@s.whatsapp.net',
      nowMs: now,
    });
    assert.equal(payload.recurrence, 'once');
  });
});
