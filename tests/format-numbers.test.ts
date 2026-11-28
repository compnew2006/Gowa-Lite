import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, it} from 'node:test';
import {formatDate, formatDay, formatNumber, formatShortTime} from '../src/lib/format.ts';
import {formatNavUnreadCount} from '../src/features/chat/chat-ui-helpers.ts';

const EASTERN_ARABIC_DIGITS = /[٠-٩]/;

describe('P1-7 unified number/date formatting (Latin digits everywhere)', () => {
  it('formatNumber uses Latin digits with grouping for Arabic and English', () => {
    assert.equal(formatNumber(51531, 'ar'), '51,531');
    assert.equal(formatNumber(51531, 'en'), '51,531');
    assert.equal(formatNumber(1240, 'ar'), '1,240');
    assert.equal(formatNumber(7, 'ar'), '7');
    assert.equal(formatNumber(0, 'ar'), '0');
    assert.ok(!EASTERN_ARABIC_DIGITS.test(formatNumber(51531, 'ar')));
  });

  it('formatNumber keeps one decimal for rating scores with a Latin decimal point', () => {
    assert.equal(formatNumber(4.5, 'ar', {maximumFractionDigits: 1}), '4.5');
    assert.equal(formatNumber(5, 'ar', {maximumFractionDigits: 1}), '5');
    assert.equal(formatNumber(4.5, 'en', {maximumFractionDigits: 1}), '4.5');
  });

  it('formatDate in Arabic gives an Arabic month name with Latin digits', () => {
    const local = new Date(2026, 11, 5, 10, 57, 0);
    const out = formatDate(local.toISOString(), 'ar');
    assert.equal(out, '5 ديسمبر 2026 في 10:57 ص');
    assert.ok(out.includes('ديسمبر'));
    assert.ok(!EASTERN_ARABIC_DIGITS.test(out));
  });

  it('formatDay in Arabic is the long form with Latin digits (no ambiguous numeric date)', () => {
    const local = new Date(2026, 11, 5, 10, 57, 0);
    assert.equal(formatDay(local.toISOString(), 'ar'), '5 ديسمبر 2026');
  });

  it('formatShortTime falls back to the long day form with Latin digits for other days', () => {
    const past = new Date(2026, 10, 20, 8, 30, 0);
    const out = formatShortTime(past.toISOString(), 'ar');
    assert.equal(out, '20 نوفمبر 2026');
    assert.ok(!EASTERN_ARABIC_DIGITS.test(out));
  });

  it('formatDate in English stays unambiguous', () => {
    const local = new Date(2026, 11, 5, 10, 57, 0);
    assert.equal(formatDate(local.toISOString(), 'en'), 'Dec 5, 2026, 10:57 AM');
  });

  it('formatNavUnreadCount routes through formatNumber (grouped Latin digits)', () => {
    assert.equal(formatNavUnreadCount(0, 'ar'), '0');
    assert.equal(formatNavUnreadCount(7, 'ar'), '7');
    assert.equal(formatNavUnreadCount(150, 'ar'), '150');
    assert.equal(formatNavUnreadCount(1240, 'ar'), '1,240');
    assert.equal(formatNavUnreadCount(1240, 'en'), '1,240');
  });

  it('every display site routes through the unified formatters', () => {
    const read = (rel: string) => fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');
    const chatList = read('src/features/chat/chat-list.tsx');
    assert.ok(chatList.includes('formatNumber(tabItem.count'));
    assert.ok(chatList.includes('formatNumber(unreadCount'));
    assert.ok(!chatList.includes('{String(unreadCount)}'));
    assert.ok(!chatList.includes('{tabItem.count}'));
    const helpers = read('src/features/chat/chat-ui-helpers.ts');
    assert.ok(helpers.includes('formatNumber('));
    const appShell = read('src/components/layout/app-shell.tsx');
    assert.ok(appShell.includes('formatNavUnreadCount(badgeCount, lang)'));
    const i18n = read('src/lib/i18n.ts');
    const i18nEn = read('src/lib/i18n-en.ts');
    assert.ok(!i18n.includes('toLocaleString()'));
    assert.ok(!i18nEn.includes('toLocaleString()'));
    assert.ok(i18n.includes('formatNumber(count'));
    assert.ok(i18nEn.includes('formatNumber(count'));
  });

  it('no hardcoded Eastern-Arabic digits remain in user-visible copy', () => {
    // Decision 1: Latin digits everywhere — including static copy, not just
    // formatted values. (shared/whatsapp-identity.ts intentionally keeps its
    // Eastern-digit regex: it normalises customer input, it does not display.)
    for (const rel of [
      'src/lib/i18n.ts',
      'src/lib/i18n-en.ts',
      'server/services/chat-close-rating.ts',
    ]) {
      const source = fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');
      assert.ok(
        !EASTERN_ARABIC_DIGITS.test(source),
        `${rel} still contains hardcoded Eastern-Arabic digits`,
      );
    }
  });

  it('no scattered Intl.NumberFormat or Eastern-digit locale remains outside format.ts', () => {
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        return entry.isDirectory() ? walk(full) : [full];
      });
    for (const file of walk(path.resolve(process.cwd(), 'src'))) {
      if (!/\.(ts|tsx)$/.test(file)) continue;
      if (file.endsWith('src/lib/format.ts')) continue;
      const source = fs.readFileSync(file, 'utf8');
      assert.ok(
        !source.includes('new Intl.NumberFormat'),
        `${file} still builds its own number formatter`,
      );
      assert.ok(
        !source.includes("'ar-EG'") && !source.includes("'ar-SA'"),
        `${file} still uses an Eastern-digit Arabic locale`,
      );
    }
  });
});
