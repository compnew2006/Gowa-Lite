import './phase3-names-menu-toasts-dom.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {afterEach, beforeEach, describe, it} from 'node:test';
import React, {act, createElement as el} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {MemoryRouter} from 'react-router-dom';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {Toaster} from 'sonner';
import {loadEnglishTranslations, useI18n} from '../src/lib/i18n.ts';

type AvatarMenuProps = {
  displayName: string;
  roleDisplayName: string;
  isDark: boolean;
  onToggleTheme: () => void;
  onLogout: () => void;
};
import ScheduledPage from '../src/pages/scheduled.tsx';
import type {RegistryDevice, User} from '../src/api/types.ts';
import {useAuthStore} from '../src/stores/auth.ts';

/**
 * Phase 3 wave 2 track D — P1-16 + P1-17 + P1-13 + P1-15 (names, avatar
 * menu, schedule toast).
 *
 * - P1-16 + P1-17 (decision 18): the account page is called «الملف والفحص»
 *   in the nav AND in its page title, and the daily-reset tab is called
 *   «إعادة المسندة يومياً».
 * - P1-13 (decision 14): the avatar in the app shell opens a dropdown with
 *   the name + role, a theme toggle and logout — no preferences page.
 * - P1-15 (decision 20): the schedule-created toast has a «عرض» action that
 *   navigates to /scheduled, deep-linked (filtered) on the created schedule
 *   where possible, plain page link otherwise.
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

const deviceAsir: RegistryDevice = {
  id: 'dev-asir',
  phone_number: '966500000001',
  display_name: 'Asir Account',
  resolved_name: 'خدمات عسير',
  state: 'logged_in',
  created_at: '',
};

function makeQueryClient(): QueryClient {
  const client = new QueryClient({
    // gcTime: 0 — React Query schedules a 5-minute GC timer when a query
    // loses its last observer on unmount; without this the node:test process
    // stays alive for 5 minutes after every DOM test.
    defaultOptions: {queries: {staleTime: Infinity, retry: false, gcTime: 0}},
  });
  client.setQueryData(['devices'], [deviceAsir]);
  return client;
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

// ---------------------------------------------------------------------------
// P1-16 + P1-17 — unified name + renamed tab (i18n, ar + en)
// ---------------------------------------------------------------------------

function I18nProbe() {
  const {t} = useI18n();
  // The two newest keys are read through a record cast on purpose: the probe
  // must still compile (and fail on value, not on type) before the keys land.
  const scheduled = t.scheduled as unknown as Record<string, unknown>;
  const nav = t.nav as unknown as Record<string, unknown>;
  return el(
    'div',
    {'data-testid': 'i18n-probe'},
    [
      t.nav.account,
      t.account.pageTitle,
      t.accounts.dailyReset.tab,
      scheduled.viewAction,
      nav.accountMenu,
    ].join(' | '),
  );
}

// Dynamic import through a variable specifier on purpose: the modules under
// test do not exist yet at the red stage, and a literal specifier would make
// tsc fail the whole file instead of letting each test fail on behaviour.
async function importModule<T>(relPath: string): Promise<T> {
  return (await import(relPath)) as T;
}

describe('P1-16 + P1-17 unified name and renamed tab (i18n ar + en)', () => {
  it('uses «الملف والفحص» in the nav and in the page title (ar)', async () => {
    const client = makeQueryClient();
    await render(el(QueryClientProvider, {client}, el(I18nProbe, {})));
    await flushTimers();
    const probe = document.querySelector('[data-testid="i18n-probe"]');
    assert.ok(probe, 'i18n probe renders');
    const text = probe.textContent ?? '';
    assert.ok(text.includes('الملف والفحص'), 'unified name renders');
    assert.ok(!text.includes('ملف الحساب والفحص'), 'old page-title wording is gone');
  });

  it('renames the tab to «إعادة المسندة يومياً» and adds the toast view label (ar)', async () => {
    const client = makeQueryClient();
    await render(el(QueryClientProvider, {client}, el(I18nProbe, {})));
    await flushTimers();
    const probe = document.querySelector('[data-testid="i18n-probe"]');
    assert.ok(probe, 'i18n probe renders');
    const text = probe.textContent ?? '';
    assert.ok(text.includes('إعادة المسندة يومياً'), 'tab shows the new name');
    assert.ok(!text.includes('الإعادة اليومية'), 'old tab name is gone');
    assert.ok(text.includes('عرض'), 'toast view action label exists');
    assert.ok(text.includes('قائمة الحساب'), 'avatar menu label exists');
  });

  it('uses the same unified name and tab in English', async () => {
    await loadEnglishTranslations();
    useAuthStore.setState({language: 'en', user: adminUser, status: 'authenticated'});
    const client = makeQueryClient();
    await render(el(QueryClientProvider, {client}, el(I18nProbe, {})));
    await flushTimers();
    const probe = document.querySelector('[data-testid="i18n-probe"]');
    assert.ok(probe, 'i18n probe renders (en)');
    const text = probe.textContent ?? '';
    assert.ok(text.includes('Profile & Lookup'), 'unified name (en)');
    assert.ok(text.includes('Daily Reassignment'), 'renamed tab (en)');
    assert.ok(text.includes('View'), 'toast view action label (en)');
    assert.ok(text.includes('Account menu'), 'avatar menu label (en)');
  });
});

describe('P1-16 + P1-17 wiring (source)', () => {
  it('the nav item reads t.nav.account and the account page reads t.account.pageTitle', () => {
    const shell = readSource('src/components/layout/app-shell.tsx');
    assert.ok(shell.includes('label: t.nav.account'), 'nav uses the unified key');
    const accountPage = readSource('src/pages/account.tsx');
    assert.ok(accountPage.includes('{t.account.pageTitle}'), 'page title uses the unified key');
    const workspace = readSource('src/features/accounts/account-workspace-panel.tsx');
    assert.ok(
      workspace.includes('t.accounts.dailyReset.tab'),
      'workspace tab uses the renamed tab key',
    );
  });
});

// ---------------------------------------------------------------------------
// P1-15 — schedule toast helper + deep link (pure parts + dialog wiring)
// ---------------------------------------------------------------------------

describe('P1-15 schedule toast (source wiring)', () => {
  it('the schedule dialog uses toastWithView with a deep link, not a bare toast', () => {
    const dialog = readSource('src/features/chat/schedule-dialog.tsx');
    assert.ok(dialog.includes('toastWithView'), 'dialog uses the toast helper');
    assert.ok(dialog.includes('buildScheduledDeepLink'), 'dialog builds the deep link');
    assert.ok(
      !dialog.includes('toast.success(t.scheduled.createdToast)'),
      'bare success toast is gone',
    );
  });
});

// ---------------------------------------------------------------------------
// P1-15 — /scheduled honours ?search= so the deep link filters the list
// ---------------------------------------------------------------------------

describe('P1-15 scheduled page honours ?search= (DOM)', () => {
  it('prefills the search box from the URL so the toast deep link filters', async () => {
    const client = makeQueryClient();
    client.setQueryData(['schedules', 'dev-asir', 'all', 'all', '966511111111', 0], {
      data: [],
      pagination: {limit: 25, offset: 0, total: 0},
    });
    await render(
      el(
        MemoryRouter,
        {initialEntries: ['/scheduled?search=966511111111']},
        el(QueryClientProvider, {client}, el(ScheduledPage, {})),
      ),
    );
    await flushTimers();
    const search = document.querySelector(
      'input[placeholder="بحث برقم المستلم أو نص الرسالة..."]',
    ) as HTMLInputElement | null;
    assert.ok(search, 'scheduled search box renders');
    assert.ok(search.value === '966511111111', 'search is prefilled from the URL');
  });

  it('leaves the search box empty without a ?search= param', async () => {
    const client = makeQueryClient();
    client.setQueryData(['schedules', 'dev-asir', 'all', 'all', '', 0], {
      data: [],
      pagination: {limit: 25, offset: 0, total: 0},
    });
    await render(
      el(
        MemoryRouter,
        {initialEntries: ['/scheduled']},
        el(QueryClientProvider, {client}, el(ScheduledPage, {})),
      ),
    );
    await flushTimers();
    const search = document.querySelector(
      'input[placeholder="بحث برقم المستلم أو نص الرسالة..."]',
    ) as HTMLInputElement | null;
    assert.ok(search, 'scheduled search box renders');
    assert.ok(search.value === '', 'search stays empty without the param');
  });
});

// ---------------------------------------------------------------------------
// P1-13 + P1-15 — avatar menu and toast helper (DOM) — added after the
// implementation modules exist; see the second half of this file.
// ---------------------------------------------------------------------------

describe('P1-13 avatar menu (DOM)', () => {
  it('opens on avatar click and shows name, role, theme toggle and logout', async () => {
    const {AvatarMenu} = await importModule<{AvatarMenu: React.ComponentType<AvatarMenuProps>}>('../src/components/layout/avatar-menu.tsx');
    let themeClicks = 0;
    let logoutClicks = 0;
    const client = makeQueryClient();
    await render(
      el(
        QueryClientProvider,
        {client},
        el(AvatarMenu, {
          displayName: 'Admin User',
          roleDisplayName: 'مسؤول النظام',
          isDark: false,
          onToggleTheme: () => {
            themeClicks += 1;
          },
          onLogout: () => {
            logoutClicks += 1;
          },
        }),
      ),
    );
    await flushTimers();
    const trigger = document.querySelector('button[aria-haspopup="menu"]');
    assert.ok(trigger, 'avatar menu button renders');
    assert.ok(!document.querySelector('[role="menu"]'), 'menu starts closed');
    clickButton(trigger as HTMLButtonElement);
    await flushTimers();
    const menu = document.querySelector('[role="menu"]');
    assert.ok(menu, 'menu opens on click');
    const menuText = menu.textContent ?? '';
    assert.ok(menuText.includes('Admin User'), 'menu shows the name');
    assert.ok(menuText.includes('مسؤول النظام'), 'menu shows the role');
    assert.ok(menuText.includes('الوضع الداكن'), 'menu shows the theme toggle');
    assert.ok(menuText.includes('تسجيل الخروج'), 'menu shows logout');
    const buttons = Array.from(menu.querySelectorAll('button'));
    const themeButton = buttons.find((b) => (b.textContent ?? '').includes('الوضع الداكن'));
    assert.ok(themeButton, 'theme toggle button renders');
    clickButton(themeButton as HTMLButtonElement);
    assert.ok(themeClicks === 1, 'theme toggle fires');
    // Choosing an action closes the menu — reopen it for the logout check.
    clickButton(trigger as HTMLButtonElement);
    await flushTimers();
    assert.ok(document.querySelector('[role="menu"]'), 'menu reopens');
    const logoutButton = Array.from(document.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes('تسجيل الخروج'),
    );
    assert.ok(logoutButton, 'logout button renders');
    clickButton(logoutButton as HTMLButtonElement);
    assert.ok(logoutClicks === 1, 'logout fires');
  });

  it('closes on Escape and on an outside click', async () => {
    const {AvatarMenu} = await importModule<{AvatarMenu: React.ComponentType<AvatarMenuProps>}>('../src/components/layout/avatar-menu.tsx');
    const client = makeQueryClient();
    await render(
      el(
        QueryClientProvider,
        {client},
        el(AvatarMenu, {
          displayName: 'Admin User',
          roleDisplayName: 'مسؤول النظام',
          isDark: false,
          onToggleTheme: () => {},
          onLogout: () => {},
        }),
      ),
    );
    await flushTimers();
    const trigger = document.querySelector(
      'button[aria-haspopup="menu"]',
    ) as HTMLButtonElement | null;
    assert.ok(trigger, 'avatar menu button renders');
    clickButton(trigger);
    await flushTimers();
    assert.ok(document.querySelector('[role="menu"]'), 'menu opens');
    act(() => {
      window.dispatchEvent(new window.KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
    });
    await flushTimers();
    assert.ok(!document.querySelector('[role="menu"]'), 'Escape closes the menu');
    clickButton(trigger);
    await flushTimers();
    assert.ok(document.querySelector('[role="menu"]'), 'menu reopens');
    act(() => {
      document.body.dispatchEvent(new window.MouseEvent('mousedown', {bubbles: true}));
    });
    await flushTimers();
    assert.ok(!document.querySelector('[role="menu"]'), 'outside click closes the menu');
  });
});

describe('P1-15 toastWithView + buildScheduledDeepLink (DOM + pure)', () => {
  it('builds a filtered deep link from a phone JID and a plain link otherwise', async () => {
    const {buildScheduledDeepLink} = await importModule<{
      buildScheduledDeepLink: (jid: string | null | undefined) => string;
    }>('../src/features/schedules/scheduled-link.ts');
    assert.ok(
      buildScheduledDeepLink('966511111111@s.whatsapp.net') ===
        '/scheduled?search=966511111111',
      'phone JID deep-links with the search filter',
    );
    assert.ok(
      buildScheduledDeepLink('966500000001@c.us') === '/scheduled?search=966500000001',
      '@c.us also deep-links',
    );
    assert.ok(
      buildScheduledDeepLink('123456@g.us') === '/scheduled',
      'group JID has no phone — plain page link',
    );
    assert.ok(
      buildScheduledDeepLink('abc@lid') === '/scheduled',
      '@lid is not a phone — plain page link',
    );
    assert.ok(buildScheduledDeepLink('') === '/scheduled', 'empty JID — plain page link');
    assert.ok(
      buildScheduledDeepLink(null) === '/scheduled',
      'missing JID — plain page link',
    );
  });

  it('shows the toast with a «عرض» action that navigates to the deep link', async () => {
    const {toastWithView} = await importModule<{
      toastWithView: (
        message: string,
        options: {label: string; to: string; navigate: (to: string) => void},
      ) => void;
    }>('../src/lib/toast-with-view.ts');
    const navigated: string[] = [];
    const client = makeQueryClient();
    await render(
      el(
        QueryClientProvider,
        {client},
        el(React.Fragment, null, el(Toaster, null)),
      ),
    );
    await flushTimers();
    act(() => {
      toastWithView('تمت جدولة الرسالة بنجاح', {
        label: 'عرض',
        to: '/scheduled?search=966511111111',
        navigate: (to: string) => {
          navigated.push(to);
        },
      });
    });
    await flushTimers();
    const toastEl = Array.from(document.querySelectorAll('[data-sonner-toast]')).find((node) =>
      (node.textContent ?? '').includes('تمت جدولة الرسالة بنجاح'),
    );
    assert.ok(toastEl, 'toast renders');
    const action = Array.from(toastEl.querySelectorAll('button')).find(
      (b) => (b.textContent ?? '').trim() === 'عرض',
    );
    assert.ok(action, 'toast has a «عرض» action button');
    clickButton(action as HTMLButtonElement);
    assert.ok(navigated.length === 1, 'action navigates once');
    assert.ok(
      navigated[0] === '/scheduled?search=966511111111',
      'action navigates to the deep link',
    );
  });
});
