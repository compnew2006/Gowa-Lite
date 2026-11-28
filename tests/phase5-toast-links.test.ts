import './phase5-toast-links-dom.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {afterEach, beforeEach, describe, it} from 'node:test';
import React, {act, createElement as el} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {Toaster} from 'sonner';
import {useAuthStore} from '../src/stores/auth.ts';
import type {User} from '../src/api/types.ts';

/**
 * Phase 5 path G — P2-10 (decision 20): generalise the «view» toast action
 * to every toast that has a viewable item.
 *
 * - P1-15's `toastWithView` was used in one place (schedule-created); every
 *   other success/warning toast was bare.
 * - After this path: each generalised toast carries a «عرض» action that
 *   navigates to a deep link where the item has an id (chat / group /
 *   schedule filtered by phone) and to the plain page where it does not
 *   (accounts, settings, users, roles, bulk results, deleted items).
 * - Link-less by design (asserted below): error toasts, transient
 *   clipboard/download info, and the setup/logout toasts that already
 *   navigate away.
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

function countOccurrences(src: string, needle: string): number {
  return src.split(needle).length - 1;
}

const adminUser: User = {
  id: 1,
  username: 'admin',
  display_name: 'Admin User',
  role: 'admin',
  role_id: 1,
  role_slug: 'admin',
  role_name: 'Admin',
  permissions: ['schedules:read', 'schedules:write', 'schedules:manage'],
  allowed_device_ids: [],
  is_active: true,
  created_at: '',
  theme: 'light',
  language: 'ar',
};

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

function render(element: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  return act(async () => {
    root!.render(element);
  });
}

function flushTimers() {
  return act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

function clickButton(button: HTMLButtonElement) {
  act(() => {
    button.click();
  });
}

beforeEach(() => {
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
  useAuthStore.setState({user: null, status: 'unauthenticated'});
});

// Dynamic import through a variable specifier on purpose: the modules under
// test do not exist yet at the red stage, and a literal specifier would make
// tsc fail the whole file instead of letting each test fail on behaviour.
async function importModule<T>(relPath: string): Promise<T> {
  return (await import(relPath)) as T;
}

// ---------------------------------------------------------------------------
// P2-10 — deep-link builders (pure)
// ---------------------------------------------------------------------------

describe('P2-10 deep-link builders (pure)', () => {
  it('builds a chat deep link from device + JID, and a filtered page link without a JID', async () => {
    const {buildChatDeepLink} = await importModule<{
      buildChatDeepLink: (deviceId: string | null | undefined, jid: string | null | undefined) => string;
    }>('../src/lib/deep-links.ts');
    assert.ok(
      buildChatDeepLink('dev-1', '966511111111@s.whatsapp.net') ===
        '/chats?device=dev-1&jid=966511111111%40s.whatsapp.net',
      'chat deep link opens the chat on its device',
    );
    assert.ok(
      buildChatDeepLink('dev-1', '') === '/chats?device=dev-1',
      'no JID — page link filtered on the device',
    );
    assert.ok(buildChatDeepLink('', '') === '/chats', 'no device or JID — plain page link');
    assert.ok(buildChatDeepLink(null, null) === '/chats', 'missing ids — plain page link');
  });

  it('builds a group deep link from device + group JID', async () => {
    const {buildGroupDeepLink} = await importModule<{
      buildGroupDeepLink: (deviceId: string | null | undefined, jid: string | null | undefined) => string;
    }>('../src/lib/deep-links.ts');
    assert.ok(
      buildGroupDeepLink('dev-1', '123456@g.us') === '/groups?device=dev-1&jid=123456%40g.us',
      'group deep link opens the group on its device',
    );
    assert.ok(
      buildGroupDeepLink('dev-1', '') === '/groups?device=dev-1',
      'no JID — page link filtered on the device',
    );
    assert.ok(buildGroupDeepLink(null, null) === '/groups', 'missing ids — plain page link');
  });

  it('routes a conversation JID to the group page for @g.us and to chats otherwise', async () => {
    const {buildConversationDeepLink} = await importModule<{
      buildConversationDeepLink: (
        deviceId: string | null | undefined,
        jid: string | null | undefined,
      ) => string;
    }>('../src/lib/deep-links.ts');
    assert.ok(
      buildConversationDeepLink('dev-1', '123456@g.us') ===
        '/groups?device=dev-1&jid=123456%40g.us',
      'group JID deep-links to the groups page',
    );
    assert.ok(
      buildConversationDeepLink('dev-1', '966511111111@s.whatsapp.net') ===
        '/chats?device=dev-1&jid=966511111111%40s.whatsapp.net',
      'phone JID deep-links to the chats page',
    );
    assert.ok(
      buildConversationDeepLink('dev-1', '') === '/chats?device=dev-1',
      'no JID — chats page filtered on the device',
    );
  });

  it('builds a filtered scheduled deep link from a bare phone as well as a phone JID', async () => {
    const {buildScheduledDeepLink} = await importModule<{
      buildScheduledDeepLink: (jid: string | null | undefined) => string;
    }>('../src/features/schedules/scheduled-link.ts');
    assert.ok(
      buildScheduledDeepLink('966511111111') === '/scheduled?search=966511111111',
      'bare phone deep-links with the search filter',
    );
    assert.ok(
      buildScheduledDeepLink('966511111111@s.whatsapp.net') === '/scheduled?search=966511111111',
      'phone JID still deep-links',
    );
    assert.ok(
      buildScheduledDeepLink('123456@g.us') === '/scheduled',
      'group JID has no phone — plain page link',
    );
    assert.ok(
      buildScheduledDeepLink('Some Name') === '/scheduled',
      'a display name is not a phone — plain page link',
    );
    assert.ok(buildScheduledDeepLink('') === '/scheduled', 'empty — plain page link');
  });
});

// ---------------------------------------------------------------------------
// P2-10 — toastWithView with a kind (DOM)
// ---------------------------------------------------------------------------

describe('P2-10 toastWithView kind (DOM)', () => {
  it('shows a warning toast with a «عرض» action that navigates to its target', async () => {
    const {toastWithView} = await importModule<{
      toastWithView: (
        message: string,
        options: {
          label: string;
          to: string;
          navigate: (to: string) => void;
          kind?: 'success' | 'warning' | 'info';
        },
      ) => void;
    }>('../src/lib/toast-with-view.ts');
    const navigated: string[] = [];
    const client = makeQueryClient();
    await render(
      el(QueryClientProvider, {client}, el(React.Fragment, null, el(Toaster, null))),
    );
    await flushTimers();
    act(() => {
      toastWithView('تم إغلاق الشات لكن تعذّر إرسال طلب التقييم', {
        label: 'عرض',
        to: '/chats?device=dev-1&jid=966511111111%40s.whatsapp.net',
        navigate: (to: string) => {
          navigated.push(to);
        },
        kind: 'warning',
      });
    });
    await flushTimers();
    const toastEl = Array.from(document.querySelectorAll('[data-sonner-toast]')).find((node) =>
      (node.textContent ?? '').includes('تم إغلاق الشات لكن تعذّر إرسال طلب التقييم'),
    );
    assert.ok(toastEl, 'warning toast renders');
    assert.ok(
      (toastEl.getAttribute('data-type') ?? '') === 'warning',
      'toast is a warning toast, not success',
    );
    const action = Array.from(toastEl.querySelectorAll('button')).find(
      (b) => (b.textContent ?? '').trim() === 'عرض',
    );
    assert.ok(action, 'warning toast has a «عرض» action button');
    clickButton(action as HTMLButtonElement);
    assert.ok(navigated.length === 1, 'action navigates once');
    assert.ok(
      navigated[0] === '/chats?device=dev-1&jid=966511111111%40s.whatsapp.net',
      'action navigates to the chat deep link',
    );
  });

  it('still defaults to a success toast when no kind is given', async () => {
    const {toastWithView} = await importModule<{
      toastWithView: (
        message: string,
        options: {
          label: string;
          to: string;
          navigate: (to: string) => void;
          kind?: 'success' | 'warning' | 'info';
        },
      ) => void;
    }>('../src/lib/toast-with-view.ts');
    const client = makeQueryClient();
    await render(
      el(QueryClientProvider, {client}, el(React.Fragment, null, el(Toaster, null))),
    );
    await flushTimers();
    act(() => {
      toastWithView('تم الاستلام', {
        label: 'عرض',
        to: '/chats?device=dev-1&jid=966511111111%40s.whatsapp.net',
        navigate: () => {},
      });
    });
    await flushTimers();
    const toastEl = Array.from(document.querySelectorAll('[data-sonner-toast]')).find((node) =>
      (node.textContent ?? '').includes('تم الاستلام'),
    );
    assert.ok(toastEl, 'toast renders');
    assert.ok(
      (toastEl.getAttribute('data-type') ?? '') === 'success',
      'default kind is success',
    );
    const action = Array.from(toastEl.querySelectorAll('button')).find(
      (b) => (b.textContent ?? '').trim() === 'عرض',
    );
    assert.ok(action, 'default toast has a «عرض» action button');
  });
});

// ---------------------------------------------------------------------------
// P2-10 — every generalised toast site uses toastWithView (source wiring)
// ---------------------------------------------------------------------------

// Files whose success/warning toasts are ALL generalised: no bare
// toast.success / toast.warning may remain (toast.error stays — failures
// have no viewable item).
const fullyGeneralised: string[] = [
  'src/features/chat/message-view.tsx',
  'src/features/chat/chat-list.tsx',
  'src/features/chat/drawer-notes-panel.tsx',
  'src/features/chat/forward-message-dialog.tsx',
  'src/features/chat/assign-chat-dialog.tsx',
  'src/features/chat/chat-list-assign-dialog.tsx',
  'src/features/chat/use-chat-schedule-actions.ts',
  'src/features/chat/use-message-actions.ts',
  'src/features/chat/use-inbox-controller.ts',
  'src/pages/scheduled.tsx',
  'src/pages/groups.tsx',
  'src/pages/roles.tsx',
  'src/features/groups/newsletter-messages-panel.tsx',
  'src/features/groups/newsletter-workspace-panel.tsx',
  'src/features/accounts/account-workspace-panel.tsx',
  'src/features/accounts/create-device-dialog.tsx',
  'src/features/accounts/edit-alias-dialog.tsx',
  'src/features/accounts/login-code-dialog.tsx',
  'src/features/accounts/login-qr-dialog.tsx',
  'src/features/accounts/account-daily-reset-panel.tsx',
  'src/features/accounts/account-close-rating-panel.tsx',
  'src/features/accounts/reject-call-panel.tsx',
  'src/features/settings/gowa-settings-form.tsx',
  'src/features/settings/inbox-policy-form.tsx',
  'src/features/users/user-dialogs.tsx',
];

describe('P2-10 toast generalisation (source wiring)', () => {
  it('every generalised file uses toastWithView and keeps no bare success/warning toast', () => {
    for (const rel of fullyGeneralised) {
      const src = readSource(rel);
      assert.ok(src.includes('toastWithView'), `${rel} uses the toast helper`);
      assert.ok(
        countOccurrences(src, 'toast.success(') === 0,
        `${rel} keeps no bare toast.success`,
      );
      assert.ok(
        countOccurrences(src, 'toast.warning(') === 0,
        `${rel} keeps no bare toast.warning`,
      );
      assert.ok(src.includes('useNavigate'), `${rel} navigates from the toast action`);
    }
  });

  it('use-message-history generalises the success toast but keeps the no-history info toast bare', () => {
    const src = readSource('src/features/chat/use-message-history.ts');
    assert.ok(src.includes('toastWithView'), 'history uses the toast helper');
    assert.ok(
      countOccurrences(src, 'toast.success(') === 0,
      'history keeps no bare toast.success',
    );
    assert.ok(
      src.includes('toast.info(t.chats.noHistoryOnPhone)'),
      'no-history-on-phone stays a bare info toast: no new item, user is already in the chat',
    );
  });

  it('account-profile-panel generalises the saves but keeps the no-avatar info toast bare', () => {
    const src = readSource('src/features/accounts/account-profile-panel.tsx');
    assert.ok(src.includes('toastWithView'), 'profile panel uses the toast helper');
    assert.ok(
      countOccurrences(src, 'toast.success(') === 0,
      'profile panel keeps no bare toast.success',
    );
    assert.ok(
      src.includes('toast.info(t.account.noAvatarFound)'),
      'no-avatar stays a bare info toast: nothing new to view',
    );
  });

  it('group-workspace-panel generalises every toast except the CSV export (a file download)', () => {
    const src = readSource('src/features/groups/group-workspace-panel.tsx');
    assert.ok(src.includes('toastWithView'), 'group panel uses the toast helper');
    assert.ok(
      countOccurrences(src, 'toast.success(') === 1,
      'group panel keeps exactly one bare success toast (the export)',
    );
    assert.ok(
      src.includes('toast.success(t.groups.exportedToast)'),
      'the remaining bare toast is the CSV export: a file download has no in-app item to view',
    );
    assert.ok(src.includes('buildGroupDeepLink'), 'group toasts deep-link to the group');
  });

  it('chat toasts deep-link to the conversation (chat or group page by JID)', () => {
    for (const rel of [
      'src/features/chat/message-view.tsx',
      'src/features/chat/chat-list.tsx',
      'src/features/chat/drawer-notes-panel.tsx',
      'src/features/chat/forward-message-dialog.tsx',
      'src/features/chat/assign-chat-dialog.tsx',
      'src/features/chat/chat-list-assign-dialog.tsx',
      'src/features/chat/use-message-actions.ts',
      'src/features/chat/use-message-history.ts',
    ]) {
      assert.ok(
        readSource(rel).includes('buildConversationDeepLink'),
        `${rel} deep-links to the conversation`,
      );
    }
  });

  it('schedule toasts deep-link to /scheduled (filtered on the recipient phone where known)', () => {
    assert.ok(
      readSource('src/features/chat/use-chat-schedule-actions.ts').includes(
        'buildScheduledDeepLink',
      ),
      'drawer schedule actions deep-link to /scheduled',
    );
    const page = readSource('src/pages/scheduled.tsx');
    assert.ok(page.includes('buildScheduledDeepLink'), 'scheduled page deep-links its toasts');
    assert.ok(
      page.includes('toWhatsAppJid'),
      'scheduled page builds the deep link from the entered phone',
    );
  });

  it('group toasts deep-link to the group; newsletter toasts link to the /misc page', () => {
    assert.ok(
      readSource('src/pages/groups.tsx').includes('buildGroupDeepLink'),
      'groups page deep-links created/joined groups',
    );
    for (const rel of [
      'src/features/groups/newsletter-messages-panel.tsx',
      'src/features/groups/newsletter-workspace-panel.tsx',
    ]) {
      const src = readSource(rel);
      assert.ok(src.includes("'/misc'"), `${rel} links to the /misc page (no channel deep link)`);
    }
  });

  it('account toasts link to the accounts list or the account page (no per-account deep link exists)', () => {
    for (const rel of [
      'src/features/accounts/account-workspace-panel.tsx',
      'src/features/accounts/create-device-dialog.tsx',
      'src/features/accounts/edit-alias-dialog.tsx',
      'src/features/accounts/login-code-dialog.tsx',
      'src/features/accounts/login-qr-dialog.tsx',
    ]) {
      assert.ok(
        readSource(rel).includes("'/accounts'"),
        `${rel} links to the /accounts page`,
      );
    }
    for (const rel of [
      'src/features/accounts/account-profile-panel.tsx',
      'src/features/accounts/account-daily-reset-panel.tsx',
      'src/features/accounts/account-close-rating-panel.tsx',
      'src/features/accounts/reject-call-panel.tsx',
    ]) {
      assert.ok(
        readSource(rel).includes("'/account'"),
        `${rel} links to the /account page`,
      );
    }
    assert.ok(
      readSource('src/features/accounts/reject-call-panel.tsx').includes(
        'buildConversationDeepLink',
      ),
      'manual call rejection deep-links to the caller chat',
    );
  });

  it('settings / users / roles toasts link to their pages', () => {
    assert.ok(
      readSource('src/features/settings/gowa-settings-form.tsx').includes("'/settings'"),
      'gowa settings links to /settings',
    );
    assert.ok(
      readSource('src/features/settings/inbox-policy-form.tsx').includes("'/settings'"),
      'inbox policy links to /settings',
    );
    assert.ok(
      readSource('src/features/users/user-dialogs.tsx').includes("'/settings/users'"),
      'user toasts link to /settings/users',
    );
    assert.ok(
      readSource('src/pages/roles.tsx').includes("'/settings/roles'"),
      'role toasts link to /settings/roles',
    );
  });

  it('bulk results link to /chats (many chats, no single item)', () => {
    const src = readSource('src/features/chat/use-inbox-controller.ts');
    assert.ok(src.includes("'/chats'"), 'bulk toasts link to the /chats page');
  });

  it('the deleted-chat toast links to /chats (the list, since the chat itself is gone)', () => {
    const src = readSource('src/features/chat/chat-list.tsx');
    assert.ok(src.includes("toastWithView(t.chats.deletedToast"), 'deleted toast is generalised');
    assert.ok(src.includes("'/chats'"), 'deleted toast links to the /chats page');
  });
});

// ---------------------------------------------------------------------------
// P2-10 — toasts deliberately left without a link (negative guards)
// ---------------------------------------------------------------------------

describe('P2-10 toasts left without a link (negative guards)', () => {
  it('setup success stays bare: it already navigates to /chats right after', () => {
    const src = readSource('src/pages/setup.tsx');
    assert.ok(
      src.includes('toast.success(t.setup.successToast)'),
      'setup toast stays bare',
    );
    assert.ok(src.includes("navigate('/chats'"), 'setup navigates to /chats immediately');
    assert.ok(!src.includes('toastWithView'), 'setup does not use the helper');
  });

  it('logout stays bare: it already navigates to the login page', () => {
    const src = readSource('src/components/layout/app-shell.tsx');
    assert.ok(
      src.includes('toast.success(t.nav.loggedOutToast)'),
      'logout toast stays bare',
    );
    assert.ok(!src.includes('toastWithView'), 'app shell does not use the helper');
  });

  it('media batch downloads stay bare: the files land on disk, not in the app', () => {
    const src = readSource('src/features/chat/use-media-batch.ts');
    assert.ok(
      src.includes('toast.success(t.chats.batchDownloadSuccess(succeededCount))'),
      'download success stays bare',
    );
    assert.ok(
      src.includes('toast.warning(t.chats.batchDownloadPartial('),
      'partial download stays bare',
    );
    assert.ok(!src.includes('toastWithView'), 'media batch does not use the helper');
  });

  it('copy-to-clipboard stays bare: a transient clipboard action has nothing to view', () => {
    const src = readSource('src/features/chat/message-bubble.tsx');
    assert.ok(
      src.includes('toast.success(t.chats.copiedToClipboard)'),
      'copy toast stays bare',
    );
    assert.ok(!src.includes('toastWithView'), 'message bubble does not use the helper');
  });

  it('no error toast gains a view link', () => {
    for (const rel of [...fullyGeneralised, 'src/features/chat/use-message-history.ts']) {
      const src = readSource(rel);
      assert.ok(
        !src.includes('toastWithView(toApiError'),
        `${rel} does not wrap error toasts`,
      );
    }
  });
});
