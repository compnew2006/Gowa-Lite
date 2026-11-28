import './phase5-bulk-assign-dom.ts';
import assert from 'node:assert/strict';
import {afterEach, beforeEach, describe, it} from 'node:test';
import React, {act, createElement as el} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import type {AssignableAgent, ScheduledSend} from '../src/api/types.ts';
import {BulkActionBar} from '../src/features/chat/bulk-action-bar.tsx';
import {
  BulkAssignDialog,
  intersectAssignableAgents,
} from '../src/features/chat/bulk-assign-dialog.tsx';
import {ScheduleEditDialog} from '../src/features/schedules/schedule-edit-dialog.tsx';

/**
 * Phase 5 path F — P2-8 + P2-9 DOM tests.
 *
 * Rendered with React 19 + jsdom (no JSX: tsx does not parse JSX in .ts
 * test files). Never compare DOM nodes with assert.equal/deepEqual: on
 * failure Node inspects the nodes into the error message, and
 * React-rendered nodes carry __reactFiber$ trees whose inspection never
 * finishes. Compare with assert.ok(a === b) instead.
 */

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {queries: {staleTime: Infinity, retry: false, gcTime: 0}},
  });
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let queryClient: QueryClient | null = null;

function render(element: React.ReactElement, seed?: (client: QueryClient) => void) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = makeQueryClient();
  // Seed the cache BEFORE mount so useQueries resolve from cache without
  // a network round-trip (the test client has no server behind it).
  seed?.(queryClient);
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
  queryClient?.clear();
  container?.remove();
  root = null;
  container = null;
  queryClient = null;
});

function flushTimers() {
  return act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

function findButton(label: string): HTMLButtonElement | null {
  // Dialogs render through a portal into document.body, outside the test
  // container, so search the whole document.
  for (const button of [...document.querySelectorAll('button')]) {
    if (button.textContent?.includes(label)) return button as HTMLButtonElement;
  }
  return null;
}

function documentText(): string {
  return document.body.textContent ?? '';
}

function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    input instanceof window.HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  setter.call(input, value);
  input.dispatchEvent(new window.Event('input', {bubbles: true}));
}

const agentSara: AssignableAgent = {
  id: 11,
  username: 'sara',
  display_name: 'Sara Alpha',
  role_slug: 'agent',
  role_name: 'Agent',
  open_chat_count: 3,
};
const agentOmar: AssignableAgent = {
  id: 22,
  username: 'omar',
  display_name: 'Omar All',
  role_slug: 'agent',
  role_name: 'Agent',
  open_chat_count: 1,
};

describe('P2-8 BulkActionBar bulk-assign button', () => {
  it('shows "تعيين المحدد" and opens the picker when clicked', async () => {
    let opened = false;
    await render(
      el(BulkActionBar, {
        selectedCount: 2,
        activeTab: 'pending',
        canAssign: true,
        canClose: true,
        isBulkPending: false,
        onRunBulk: () => undefined,
        onOpenBulkAssign: () => {
          opened = true;
        },
        onSelectAllVisible: () => undefined,
        onCancel: () => undefined,
      }),
    );
    const button = findButton('تعيين المحدد');
    assert.ok(button, 'bulk assign button must be rendered');
    await act(async () => {
      button!.click();
    });
    assert.equal(opened, true);
  });

  it('hides the button on the closed tab and without assign permission', async () => {
    await render(
      el(BulkActionBar, {
        selectedCount: 2,
        activeTab: 'closed',
        canAssign: true,
        canClose: true,
        isBulkPending: false,
        onRunBulk: () => undefined,
        onOpenBulkAssign: () => undefined,
        onSelectAllVisible: () => undefined,
        onCancel: () => undefined,
      }),
    );
    assert.equal(findButton('تعيين المحدد'), null);
    await act(async () => {
      root?.unmount();
    });
    container?.remove();
    await render(
      el(BulkActionBar, {
        selectedCount: 2,
        activeTab: 'pending',
        canAssign: false,
        canClose: true,
        isBulkPending: false,
        onRunBulk: () => undefined,
        onOpenBulkAssign: () => undefined,
        onSelectAllVisible: () => undefined,
        onCancel: () => undefined,
      }),
    );
    assert.equal(findButton('تعيين المحدد'), null);
  });
});

describe('P2-8 assignable-agent intersection', () => {
  it('keeps only agents authorized for every selected account, summing open counts', () => {
    const result = intersectAssignableAgents([
      [agentSara, agentOmar],
      [{...agentOmar, open_chat_count: 4}],
    ]);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.id, 22);
    assert.equal(result[0]?.open_chat_count, 5);
    assert.deepEqual(intersectAssignableAgents([]), []);
  });
});

describe('P2-8 BulkAssignDialog', () => {
  it('lists the agents of the selected account and confirms the chosen one', async () => {
    let confirmed: {id: number; note?: string} | null = null;
    await render(
      el(BulkAssignDialog, {
        open: true,
        onOpenChange: () => undefined,
        deviceIds: ['dev-alpha'],
        selectedCount: 2,
        currentUserId: 11,
        canViewAll: false,
        isPending: false,
        onConfirm: (id: number, note?: string) => {
          confirmed = {id, note};
        },
      }),
      (client) => {
        client.setQueryData(['assignable-agents', 'dev-alpha'], [agentSara, agentOmar]);
      },
    );
    await flushTimers();
    // Pick Omar (not the current user) — the self-transfer warning shows.
    const omarRow = [...document.querySelectorAll('[role="radio"]')].find((row) =>
      row.textContent?.includes('Omar All'),
    ) as HTMLElement | undefined;
    assert.ok(omarRow, 'Omar row must be listed');
    await act(async () => {
      omarRow!.click();
    });
    await flushTimers();
    assert.ok(documentText().includes('سيُنقل المحدد من قائمتك النشطة'));
    const confirm = findButton('تعيين المحدد');
    assert.ok(confirm, 'confirm button must be rendered');
    assert.equal(confirm!.disabled, false);
    await act(async () => {
      confirm!.click();
    });
    assert.ok(confirmed !== null);
    assert.equal((confirmed as {id: number} | null)?.id, 22);
  });

  it('shows only the agent common to both accounts for a multi-device selection', async () => {
    await render(
      el(BulkAssignDialog, {
        open: true,
        onOpenChange: () => undefined,
        deviceIds: ['dev-alpha', 'dev-beta'],
        selectedCount: 3,
        currentUserId: 11,
        canViewAll: true,
        isPending: false,
        onConfirm: () => undefined,
      }),
      (client) => {
        client.setQueryData(['assignable-agents', 'dev-alpha'], [agentSara, agentOmar]);
        client.setQueryData(['assignable-agents', 'dev-beta'], [agentOmar]);
      },
    );
    await flushTimers();
    assert.ok(documentText().includes('Omar All'));
    assert.ok(!documentText().includes('Sara Alpha'));
  });
});

function scheduleFixture(overrides: Partial<ScheduledSend> = {}): ScheduledSend {
  return {
    id: 'sched-1',
    message_type: 'text',
    recipient: '966511111111@s.whatsapp.net',
    content: 'hello scheduled',
    scheduled_at: '2027-01-10T12:00:00.000Z',
    timezone: 'Asia/Riyadh',
    recurrence: 'once',
    occurrence_count: 0,
    status: 'active',
    next_run_at: '2027-01-10T12:00:00.000Z',
    created_at: '2027-01-01T12:00:00.000Z',
    updated_at: '2027-01-01T12:00:00.000Z',
    ...overrides,
  };
}

describe('P2-9 ScheduleEditDialog', () => {
  it('edits time and text for a text schedule, sending message only when changed', async () => {
    let saved: {scheduled_at: string; message?: string} | null = null;
    await render(
      el(ScheduleEditDialog, {
        open: true,
        onOpenChange: () => undefined,
        item: scheduleFixture(),
        isSaving: false,
        onSave: async (payload: {scheduled_at: string; message?: string}) => {
          saved = payload;
        },
      }),
    );
    await flushTimers();
    const timeInput = document.querySelector('#sched-edit-time') as HTMLInputElement | null;
    const textInput = document.querySelector(
      '#sched-edit-message',
    ) as HTMLTextAreaElement | null;
    assert.ok(timeInput, 'time input must be rendered');
    assert.ok(textInput, 'text input must be rendered for text schedules');
    assert.equal(textInput!.value, 'hello scheduled');
    const submit = findButton('حفظ التعديل');
    assert.ok(submit, 'submit button must be rendered');
    assert.equal(submit!.disabled, true, 'submit is disabled while nothing changed');
    // Time-only change: no message in the payload.
    await act(async () => {
      setInputValue(timeInput!, '2027-01-11T12:00');
    });
    await flushTimers();
    assert.equal(submit!.disabled, false);
    await act(async () => {
      submit!.click();
    });
    await flushTimers();
    assert.ok(saved !== null);
    assert.equal(
      (saved as {scheduled_at: string} | null)?.scheduled_at,
      new Date('2027-01-11T12:00').toISOString(),
    );
    assert.equal((saved as {message?: string} | null)?.message, undefined);
    // Text change: the new message is sent along.
    await act(async () => {
      setInputValue(textInput!, 'updated text');
    });
    await flushTimers();
    await act(async () => {
      submit!.click();
    });
    await flushTimers();
    assert.equal((saved as {message?: string} | null)?.message, 'updated text');
  });

  it('offers time-only editing for a media schedule (no text field)', async () => {
    await render(
      el(ScheduleEditDialog, {
        open: true,
        onOpenChange: () => undefined,
        item: scheduleFixture({message_type: 'image', content: ''}),
        isSaving: false,
        onSave: async () => undefined,
      }),
    );
    await flushTimers();
    assert.equal(document.querySelector('#sched-edit-message'), null);
    assert.ok(documentText().includes('تعديل الوقت فقط'));
    assert.ok(document.querySelector('#sched-edit-time') !== null);
  });
});
