import './schedule-account-line-dom.ts';
import assert from 'node:assert/strict';
import {afterEach, beforeEach, describe, it} from 'node:test';
import React, {act, createElement as el} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {Toaster} from 'sonner';
import {ScheduleMessageDialog} from '../src/features/chat/schedule-dialog.tsx';
import {ScheduledMessageBubble} from '../src/features/chat/scheduled-message-bubble.tsx';
import {
  buildScheduledTimelineEntries,
  scheduledBubbleText,
} from '../src/features/chat/scheduled-timeline.ts';
import {
  ScheduleValidationError,
  toLocalDateTimeInput,
  validateAndBuildScheduleFields,
  validateScheduleFutureMs,
} from '../src/features/schedules/schedule-utils.ts';
import {
  buildMediaScheduleFormData,
  validateAndBuildSchedulePayload,
} from '../server/services/schedule-service.ts';
import {syncLiveQueryCache} from '../src/lib/live-query-sync.ts';
import type {RegistryDevice, ScheduledSend, UnifiedChat, User} from '../src/api/types.ts';
import {useAuthStore} from '../src/stores/auth.ts';

/**
 * Phase 2 Path A (P1-23 + P1-3): schedule the message written in the
 * composer itself — the dialog receives the composer draft (text + attached
 * file, if any), has no separate message field and no time default — and the
 * scheduled message shows in the chat as a "scheduled" bubble with
 * edit-time / cancel actions, replaced by the sent message over WS when
 * its time comes.
 *
 * Rendered with React 19 + jsdom (no JSX: tsx does not parse JSX in .ts
 * test files). Never compare DOM nodes with assert.equal/deepEqual: on
 * failure Node inspects the nodes into the error message, and
 * React-rendered nodes carry __reactFiber$ trees whose inspection never
 * finishes. Compare with assert.ok(a === b) instead.
 */

const deviceTayba: RegistryDevice = {
  id: 'dev-tayba',
  phone_number: '966500000002',
  display_name: 'Tayba Account',
  resolved_name: 'خدمات طيبة',
  state: 'logged_in',
  created_at: '',
};

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

const NOW = Date.parse('2026-11-28T12:00:00+03:00');

function chatOnTayba(): UnifiedChat {
  return {
    device_id: 'dev-tayba',
    jid: '966511111111@s.whatsapp.net',
    name: 'Test Chat',
    device_display_name: 'خدمات طيبة',
    device_state: 'logged_in',
  } as unknown as UnifiedChat;
}

function scheduleFixture(overrides: Partial<ScheduledSend> = {}): ScheduledSend {
  return {
    id: 'sched-1',
    message_type: 'text',
    recipient: '966511111111@s.whatsapp.net',
    content: 'hello scheduled',
    scheduled_at: '2026-11-28T15:00:00+03:00',
    timezone: 'Asia/Riyadh',
    recurrence: 'once',
    occurrence_count: 0,
    status: 'active',
    next_run_at: '2026-11-28T15:00:00+03:00',
    created_at: '2026-11-28T12:00:00+03:00',
    updated_at: '2026-11-28T12:00:00+03:00',
    ...overrides,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function makeQueryClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: {queries: {staleTime: Infinity, retry: false, gcTime: 0}},
  });
  client.setQueryData(['devices'], [deviceTayba]);
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

function clickButton(button: HTMLButtonElement) {
  act(() => {
    button.click();
  });
}

function submitButton(): HTMLButtonElement {
  const buttons = Array.from(document.querySelectorAll('button[type="submit"]'));
  assert.ok(buttons.length > 0, 'submit button renders');
  return buttons[0] as HTMLButtonElement;
}

function renderDialog(props: {
  initialMessage?: string;
  initialAttachment?: File | null;
  onOpenChange?: (open: boolean) => void;
  onScheduled?: (message: string, hadAttachment?: boolean) => void;
}) {
  const client = makeQueryClient();
  return render(
    el(
      QueryClientProvider,
      {client},
      el(
        React.Fragment,
        null,
        el(Toaster, null),
        el(ScheduleMessageDialog, {
          open: true,
          onOpenChange: props.onOpenChange ?? (() => {}),
          chat: chatOnTayba(),
          initialMessage: props.initialMessage ?? 'hello draft',
          initialAttachment: props.initialAttachment ?? null,
          onScheduled: props.onScheduled,
        }),
      ),
    ),
  );
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

describe('ScheduleMessageDialog receives the composer draft (P1-23 + P1-3)', () => {
  it('shows the composer draft as a read-only preview and has no separate message field', async () => {
    await renderDialog({initialMessage: 'hello draft'});
    await flushTimers();
    const preview = document.querySelector('[data-testid="schedule-draft-preview"]');
    assert.ok(preview, 'draft preview renders');
    assert.ok((preview.textContent ?? '').includes('hello draft'), 'draft text is shown');
    assert.ok(!document.querySelector('#chat-sched-msg'), 'no separate message textarea');
    assert.ok(!document.querySelector('textarea'), 'no textarea at all in the dialog');
  });

  it('shows an attached composer file in the preview', async () => {
    const file = new File(['x'], 'photo.png', {type: 'image/png'});
    await renderDialog({initialMessage: 'with photo', initialAttachment: file});
    await flushTimers();
    const preview = document.querySelector('[data-testid="schedule-attachment-preview"]');
    assert.ok(preview, 'attachment preview renders');
    assert.ok((preview.textContent ?? '').includes('photo.png'), 'attachment name is shown');
    assert.ok(!document.querySelector('#chat-sched-msg'), 'no separate message textarea');
  });

  it('shows an empty-draft hint when the composer is empty', async () => {
    await renderDialog({initialMessage: '', initialAttachment: null});
    await flushTimers();
    const hint = document.querySelector('[data-testid="schedule-empty-draft-hint"]');
    assert.ok(hint, 'empty-draft hint renders');
    assert.ok(submitButton().disabled, 'submit stays disabled with no draft and no attachment');
  });

  it('starts with an empty send-time field — no default (decision 5)', async () => {
    await renderDialog({initialMessage: 'hello draft'});
    await flushTimers();
    const at = document.querySelector('#chat-sched-at') as HTMLInputElement | null;
    assert.ok(at, 'send-time input renders');
    assert.ok(at.value === '', 'send-time field starts empty');
  });

  it('keeps submit disabled while the send time is empty', async () => {
    await renderDialog({initialMessage: 'hello draft'});
    await flushTimers();
    assert.ok(submitButton().disabled, 'submit disabled with an empty time');
  });

  it('enables submit once a future time is picked', async () => {
    await renderDialog({initialMessage: 'hello draft'});
    await flushTimers();
    const at = document.querySelector('#chat-sched-at') as HTMLInputElement | null;
    assert.ok(at, 'send-time input renders');
    setInputValue(at, toLocalDateTimeInput(new Date(Date.now() + 60 * 60_000)));
    await flushTimers();
    assert.ok(!submitButton().disabled, 'submit enabled with a future time');
  });

  it('rejects a past time: the dialog stays open and nothing is scheduled', async () => {
    const opened: boolean[] = [];
    await renderDialog({
      initialMessage: 'hello draft',
      onOpenChange: (open) => {
        opened.push(open);
      },
    });
    await flushTimers();
    const at = document.querySelector('#chat-sched-at') as HTMLInputElement | null;
    assert.ok(at, 'send-time input renders');
    setInputValue(at, toLocalDateTimeInput(new Date(Date.now() - 60 * 60_000)));
    await flushTimers();
    clickButton(submitButton());
    await flushTimers();
    assert.ok(!opened.includes(false), 'dialog does not close on a past time');
    assert.ok(bodyText().includes('hello draft'), 'draft preview is still shown');
  });
});

describe('validateAndBuildScheduleFields time rules (decision 5)', () => {
  const base = {
    message: 'hello',
    scheduledAtLocal: '',
    timezone: 'Asia/Riyadh',
    recurrence: 'once' as const,
    weekdays: [],
    dayOfMonth: '1',
    occurrenceLimit: '',
    endAtLocal: '',
  };
  const messages = {
    pastTime: 'PAST',
    invalidEndAt: 'BAD_END',
    emptyTime: 'EMPTY',
  };

  it('rejects an empty time with the required-time message', () => {
    assert.throws(
      () => validateAndBuildScheduleFields({...base, scheduledAtLocal: ''}, messages, NOW),
      (err: unknown) =>
        err instanceof ScheduleValidationError && err.message === 'EMPTY',
    );
  });

  it('rejects a past time with the past-time message', () => {
    assert.throws(
      () =>
        validateAndBuildScheduleFields(
          {
            ...base,
            scheduledAtLocal: toLocalDateTimeInput(new Date(NOW - 3_600_000)),
          },
          messages,
          NOW,
        ),
      (err: unknown) =>
        err instanceof ScheduleValidationError && err.message === 'PAST',
    );
  });

  it('accepts a future time and builds the payload', () => {
    const payload = validateAndBuildScheduleFields(
      {...base, scheduledAtLocal: toLocalDateTimeInput(new Date(NOW + 3_600_000))},
      messages,
      NOW,
    );
    assert.equal(payload.message, 'hello');
    assert.ok(Date.parse(payload.scheduled_at) > NOW, 'scheduled_at is in the future');
  });

  it('validateScheduleFutureMs rejects past times and accepts future ones', () => {
    assert.throws(
      () => validateScheduleFutureMs(toLocalDateTimeInput(new Date(NOW - 3_600_000)), NOW),
      (err: unknown) => err instanceof ScheduleValidationError,
    );
    assert.ok(
      validateScheduleFutureMs(toLocalDateTimeInput(new Date(NOW + 3_600_000)), NOW) > NOW,
    );
  });
});

describe('scheduled timeline entries (bubble source)', () => {
  it('includes active/paused/running schedules, sorted by next run', () => {
    const entries = buildScheduledTimelineEntries([
      scheduleFixture({id: 'later', next_run_at: '2026-11-28T18:00:00+03:00'}),
      scheduleFixture({id: 'done', status: 'completed'}),
      scheduleFixture({id: 'gone', status: 'cancelled'}),
      scheduleFixture({id: 'paused-1', status: 'paused', next_run_at: '2026-11-28T16:00:00+03:00'}),
      scheduleFixture({id: 'soon', status: 'running', next_run_at: '2026-11-28T14:00:00+03:00'}),
    ]);
    assert.deepEqual(
      entries.map((e) => e.item.id),
      ['soon', 'paused-1', 'later'],
    );
    assert.ok(entries[0].key === 'sched:soon', 'entry key is stable');
    assert.ok(entries[0].timestampMs === Date.parse('2026-11-28T14:00:00+03:00'));
  });

  it('falls back to scheduled_at when next_run_at is missing', () => {
    const entries = buildScheduledTimelineEntries([
      scheduleFixture({id: 'a', next_run_at: undefined, scheduled_at: '2026-11-28T15:00:00+03:00'}),
    ]);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].timestamp, '2026-11-28T15:00:00+03:00');
  });

  it('reads the bubble text from content, message, caption, then filename', () => {
    assert.equal(scheduledBubbleText(scheduleFixture({content: 'c'})), 'c');
    assert.equal(
      scheduledBubbleText(scheduleFixture({content: undefined, message: 'm'})),
      'm',
    );
    assert.equal(
      scheduledBubbleText(
        scheduleFixture({content: undefined, message: undefined, caption: 'cap'}),
      ),
      'cap',
    );
    assert.equal(
      scheduledBubbleText(
        scheduleFixture({
          content: undefined,
          message: undefined,
          caption: undefined,
          filename: 'file.pdf',
        }),
      ),
      'file.pdf',
    );
    assert.equal(
      scheduledBubbleText(
        scheduleFixture({
          content: undefined,
          message: undefined,
          caption: undefined,
          filename: undefined,
        }),
      ),
      '—',
    );
  });
});

describe('ScheduledMessageBubble (chat bubble)', () => {
  const statusLabels = {
    active: 'نشط',
    running: 'قيد التنفيذ',
    paused: 'متوقف مؤقتًا',
    completed: 'مكتمل',
    failed: 'فشل',
    cancelled: 'ملغي',
  };
  const recurrenceLabels = {
    once: 'مرة واحدة',
    daily: 'يوميًا',
    weekly: 'أسبوعيًا',
    monthly: 'شهريًا',
  };

  function renderBubble(props: {
    item?: ScheduledSend;
    canEditTime?: boolean;
    canManageStatus?: boolean;
    isEditing?: boolean;
    editingTime?: string;
    isConfirmingCancel?: boolean;
    onSaveTime?: (id: string) => void;
    onAction?: (id: string, action: 'pause' | 'resume' | 'cancel') => void;
  }) {
    const client = makeQueryClient();
    return render(
      el(
        QueryClientProvider,
        {client},
        el(ScheduledMessageBubble, {
          item: props.item ?? scheduleFixture(),
          lang: 'ar',
          statusLabels,
          recurrenceLabels,
          canEditTime: props.canEditTime ?? true,
          canManageStatus: props.canManageStatus ?? true,
          isBusy: false,
          isEditing: props.isEditing ?? false,
          editingTime: props.editingTime ?? '',
          minLocal: '2026-11-28T12:01',
          isConfirmingCancel: props.isConfirmingCancel ?? false,
          onStartEditing: () => {},
          onEditingTimeChange: () => {},
          onCancelEditing: () => {},
          onSaveTime: props.onSaveTime ?? (() => {}),
          onAction: props.onAction ?? (() => {}),
          onToggleCancelConfirm: () => {},
        }),
      ),
    );
  }

  it('renders the text, the send time and the scheduled status', async () => {
    await renderBubble({});
    await flushTimers();
    const bubble = document.querySelector('[data-testid="scheduled-message-bubble"]');
    assert.ok(bubble, 'scheduled bubble renders');
    const text = bubble.textContent ?? '';
    assert.ok(text.includes('hello scheduled'), 'message text is shown');
    assert.ok(text.includes('نشط'), 'scheduled status is shown');
  });

  it('hides the edit pencil for non-text schedules', async () => {
    await renderBubble({item: scheduleFixture({message_type: 'image'})});
    await flushTimers();
    const pencil = document.querySelector('[aria-label="تعديل الموعد"]');
    assert.ok(!pencil, 'no edit pencil for image schedules');
  });

  it('saves the new time through onSaveTime when editing', async () => {
    const saved: string[] = [];
    await renderBubble({
      isEditing: true,
      editingTime: '2026-11-28T16:00',
      onSaveTime: (id) => {
        saved.push(id);
      },
    });
    await flushTimers();
    const buttons = Array.from(document.querySelectorAll('button'));
    const save = buttons.find((b) => (b.textContent ?? '').includes('حفظ'));
    assert.ok(save, 'save button renders while editing');
    clickButton(save as HTMLButtonElement);
    await flushTimers();
    assert.deepEqual(saved, ['sched-1']);
  });

  it('asks for confirmation then cancels through onAction', async () => {
    const actions: Array<[string, string]> = [];
    const client = makeQueryClient();
    let confirmMode = false;
    const renderWithConfirm = () =>
      render(
        el(
          QueryClientProvider,
          {client},
          el(ScheduledMessageBubble, {
            item: scheduleFixture(),
            lang: 'ar',
            statusLabels,
            recurrenceLabels,
            canEditTime: true,
            canManageStatus: true,
            isBusy: false,
            isEditing: false,
            editingTime: '',
            minLocal: '2026-11-28T12:01',
            isConfirmingCancel: confirmMode,
            onStartEditing: () => {},
            onEditingTimeChange: () => {},
            onCancelEditing: () => {},
            onSaveTime: () => {},
            onAction: (id, action) => {
              actions.push([id, action]);
            },
            onToggleCancelConfirm: () => {
              confirmMode = !confirmMode;
            },
          }),
        ),
      );
    await renderWithConfirm();
    await flushTimers();
    const cancelBtn = document.querySelector(
      '[aria-label="إلغاء الجدولة"]',
    ) as HTMLButtonElement | null;
    assert.ok(cancelBtn, 'cancel button renders');
    // The toggle is a prop callback in this unit render; flip the mode by
    // re-rendering with the confirm state on, then confirm.
    clickButton(cancelBtn);
    await flushTimers();
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
    confirmMode = true;
    await renderWithConfirm();
    await flushTimers();
    const confirmBtn = Array.from(document.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes('تأكيد الإلغاء'),
    ) as HTMLButtonElement | undefined;
    assert.ok(confirmBtn, 'confirm-cancel button renders');
    clickButton(confirmBtn);
    await flushTimers();
    assert.deepEqual(actions, [['sched-1', 'cancel']]);
  });
});

describe('WS replacement: a fired schedule leaves the chat schedules cache', () => {
  const jid = '966511111111@s.whatsapp.net';
  const otherJid = '966522222222@s.whatsapp.net';

  function fromMeEvent(isFromMe: boolean) {
    return {
      code: 'MESSAGE_RECEIVED',
      message: '',
      device_id: 'dev-tayba',
      result: {
        chat_jid: jid,
        id: 'msg-fired',
        content: 'hello scheduled',
        is_from_me: isFromMe,
        sender_jid: 'me',
        timestamp: new Date().toISOString(),
        media_type: 'text',
      },
    };
  }

  it('invalidates the chat schedules when the sent message arrives from this device', () => {
    const client = new QueryClient();
    const schedulesKey = ['unified-chat-schedules', 'dev-tayba', jid] as const;
    const otherSchedulesKey = ['unified-chat-schedules', 'dev-tayba', otherJid] as const;
    client.setQueryData(schedulesKey, {stored: true});
    client.setQueryData(otherSchedulesKey, {stored: true});

    syncLiveQueryCache(client, fromMeEvent(true));

    assert.equal(client.getQueryState(schedulesKey)?.isInvalidated, true);
    assert.equal(client.getQueryState(otherSchedulesKey)?.isInvalidated, false);
  });

  it('does not invalidate schedules for messages from other people', () => {
    const client = new QueryClient();
    const schedulesKey = ['unified-chat-schedules', 'dev-tayba', jid] as const;
    client.setQueryData(schedulesKey, {stored: true});

    syncLiveQueryCache(client, fromMeEvent(false));

    assert.equal(client.getQueryState(schedulesKey)?.isInvalidated, false);
  });
});

describe('media scheduling (server)', () => {
  it('allows an empty message when a file is attached', () => {
    const payload = validateAndBuildSchedulePayload(
      {
        phone: '966511111111@s.whatsapp.net',
        message: '',
        scheduled_at: '2026-11-28T15:00:00.000Z',
        recurrence: 'once',
      },
      {allowEmptyMessage: true, nowMs: NOW},
    );
    assert.equal(payload.message, '');
    assert.equal(payload.scheduled_at, '2026-11-28T15:00:00.000Z');
  });

  it('still requires a message (or a file) without the media flag', () => {
    assert.throws(
      () =>
        validateAndBuildSchedulePayload(
          {
            phone: '966511111111@s.whatsapp.net',
            message: '',
            scheduled_at: '2026-11-28T15:00:00.000Z',
            recurrence: 'once',
          },
          {nowMs: NOW},
        ),
      (err: unknown) => err instanceof Error && /نص الرسالة/.test(err.message),
    );
  });

  it('still requires a future send time with media', () => {
    assert.throws(
      () =>
        validateAndBuildSchedulePayload(
          {
            phone: '966511111111@s.whatsapp.net',
            message: '',
            scheduled_at: new Date(NOW - 3_600_000).toISOString(),
            recurrence: 'once',
          },
          {allowEmptyMessage: true, nowMs: NOW},
        ),
      (err: unknown) => err instanceof Error && /المستقبل/.test(err.message),
    );
  });

  it('builds a gateway image schedule form with caption + schedule fields', async () => {
    const {endpoint, formData} = buildMediaScheduleFormData(
      '966511111111@s.whatsapp.net',
      {
        file: {
          buffer: Buffer.from([1, 2, 3]),
          filename: 'photo.png',
          mimeType: 'image/png',
        },
        caption: 'hello scheduled',
        scheduledAt: '2026-11-28T15:00:00.000Z',
        timezone: 'Asia/Riyadh',
        recurrence: 'once',
      },
    );
    assert.equal(endpoint, '/send/image');
    assert.equal(formData.get('phone'), '966511111111@s.whatsapp.net');
    assert.equal(formData.get('caption'), 'hello scheduled');
    assert.equal(formData.get('scheduled_at'), '2026-11-28T15:00:00.000Z');
    assert.equal(formData.get('timezone'), 'Asia/Riyadh');
    assert.equal(formData.get('recurrence'), 'once');
    const image = formData.get('image');
    assert.ok(image instanceof File, 'image file is attached under the gateway field');
    assert.equal((image as File).name, 'photo.png');
  });

  it('builds a gateway audio schedule form without a caption field', () => {
    const {endpoint, formData} = buildMediaScheduleFormData(
      '966511111111@s.whatsapp.net',
      {
        file: {
          buffer: Buffer.from([1, 2, 3]),
          filename: 'voice.ogg',
          mimeType: 'audio/ogg',
        },
        caption: 'ignored caption',
        scheduledAt: '2026-11-28T15:00:00.000Z',
        timezone: 'Asia/Riyadh',
        recurrence: 'once',
      },
    );
    assert.equal(endpoint, '/send/audio');
    assert.equal(formData.get('audio') instanceof File, true);
    assert.equal(formData.get('caption'), null);
  });
});
