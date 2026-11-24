import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, it} from 'node:test';
import {
  formatNavUnreadCount,
  formatSecondaryChatPhone,
  shouldShowAccountFilter,
  shouldShowNavUnreadBadge,
  shouldShowRowAccountName,
  shouldShowRowLifecycle,
} from '../src/features/chat/chat-ui-helpers.ts';

describe('Chats Screen Decluttering & Unread Hygiene', () => {
  it('suppresses duplicate phone number when contact displayName is already the phone number', () => {
    assert.equal(formatSecondaryChatPhone('+966 50 123 4567', '+966 50 123 4567'), null);
    assert.equal(formatSecondaryChatPhone('  +966 50 123 4567  ', '+966 50 123 4567'), null);
    assert.equal(formatSecondaryChatPhone('أحمد محمد', '+966 50 123 4567'), '+966 50 123 4567');
    assert.equal(formatSecondaryChatPhone('أحمد محمد', ''), null);
  });

  it('hides single-account filter dropdown and single-account row labels unless multi-account or filtered', () => {
    assert.equal(shouldShowAccountFilter(0, 0), false);
    assert.equal(shouldShowAccountFilter(1, 0), false);
    assert.equal(shouldShowAccountFilter(1, 1), true);
    assert.equal(shouldShowAccountFilter(2, 0), true);

    assert.equal(shouldShowRowAccountName(0), false);
    assert.equal(shouldShowRowAccountName(1), false);
    assert.equal(shouldShowRowAccountName(2), true);
  });

  it('omits redundant pending/closed status text on rows inside dedicated pending/closed tabs', () => {
    assert.equal(shouldShowRowLifecycle('pending', 'pending'), false);
    assert.equal(shouldShowRowLifecycle('closed', 'closed'), false);
    assert.equal(shouldShowRowLifecycle('all', 'pending'), true);
    assert.equal(shouldShowRowLifecycle('me', 'open'), true);
    assert.equal(shouldShowRowLifecycle('pending', 'open'), true);
    assert.equal(shouldShowRowLifecycle(undefined, 'pending'), true);
  });

  it('hides global unread badge while already viewing the active route and formats actual unread counts without 99+ cap', () => {
    assert.equal(shouldShowNavUnreadBadge(true, 150), false);
    assert.equal(shouldShowNavUnreadBadge(false, 0), false);
    assert.equal(shouldShowNavUnreadBadge(false, 150), true);

    assert.equal(formatNavUnreadCount(0), '0');
    assert.equal(formatNavUnreadCount(7), '7');
    assert.equal(formatNavUnreadCount(150), '150');
    assert.equal(formatNavUnreadCount(1240), '1240');
  });

  it('keeps ChatList and AppShell free of redundant global unread widgets and 99+ caps, and shows unread badges on /chats and /groups', () => {
    const chatListSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/features/chat/chat-list.tsx'),
      'utf8',
    );
    const appShellSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/layout/app-shell.tsx'),
      'utf8',
    );
    assert.equal(chatListSource.includes('user-unread-widget'), false);
    assert.equal(chatListSource.includes('totalUnreadCount'), false);
    assert.equal(chatListSource.includes('userUnreadTitle'), false);
    assert.equal(chatListSource.includes("'99+'"), false);
    assert.equal(appShellSource.includes("'99+'"), false);
    assert.equal(appShellSource.includes("to === '/groups'"), true);
    assert.equal(appShellSource.includes('totalGroupsUnread'), true);
  });
});
