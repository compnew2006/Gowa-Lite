import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {parseFreeTextDateTimeLocal} from '../src/features/schedules/schedule-utils.ts';
import {
  NAV_RAIL_STORAGE_KEY,
  readNavRailExpanded,
  writeNavRailExpanded,
} from '../src/lib/nav-rail.ts';

/**
 * Phase 5 Path D — P2-4 (free-text date parsing) + P2-3 (nav-rail persisted
 * state). Pure unit tests: no DOM, no React.
 */

function memoryStorage(initial?: Record<string, string>) {
  const map = new Map(Object.entries(initial ?? {}));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}

describe('P2-4: parseFreeTextDateTimeLocal', () => {
  it('parses ISO-like text with a space separator', () => {
    assert.equal(parseFreeTextDateTimeLocal('2030-01-15 14:30'), '2030-01-15T14:30');
  });

  it('parses ISO text with a T separator and slashes', () => {
    assert.equal(parseFreeTextDateTimeLocal('2030-01-15T14:30'), '2030-01-15T14:30');
    assert.equal(parseFreeTextDateTimeLocal('2030/01/15 09:00'), '2030-01-15T09:00');
  });

  it('parses day-first text (Egypt convention) with / and - separators', () => {
    assert.equal(parseFreeTextDateTimeLocal('15/01/2030 14:30'), '2030-01-15T14:30');
    assert.equal(parseFreeTextDateTimeLocal('15-01-2030 14:30'), '2030-01-15T14:30');
  });

  it('parses 12-hour text with AM/PM', () => {
    assert.equal(parseFreeTextDateTimeLocal('15/01/2030 3:30 PM'), '2030-01-15T15:30');
    assert.equal(parseFreeTextDateTimeLocal('15/01/2030 12:05 am'), '2030-01-15T00:05');
    assert.equal(parseFreeTextDateTimeLocal('2030-01-15 12:00 PM'), '2030-01-15T12:00');
  });

  it('accepts seconds and drops them (minute precision)', () => {
    assert.equal(parseFreeTextDateTimeLocal('2030-01-15 14:30:45'), '2030-01-15T14:30');
  });

  it('defaults a date-only text to 09:00', () => {
    assert.equal(parseFreeTextDateTimeLocal('2030-01-15'), '2030-01-15T09:00');
    assert.equal(parseFreeTextDateTimeLocal('15/01/2030'), '2030-01-15T09:00');
  });

  it('accepts Arabic-Indic digits', () => {
    assert.equal(parseFreeTextDateTimeLocal('١٥/٠١/٢٠٣٠ ١٤:٣٠'), '2030-01-15T14:30');
  });

  it('rejects free prose and empty text', () => {
    assert.equal(parseFreeTextDateTimeLocal(''), null);
    assert.equal(parseFreeTextDateTimeLocal('   '), null);
    assert.equal(parseFreeTextDateTimeLocal('tomorrow at five'), null);
    assert.equal(parseFreeTextDateTimeLocal('hello'), null);
  });

  it('rejects impossible calendar dates and times', () => {
    assert.equal(parseFreeTextDateTimeLocal('30/02/2030 10:00'), null);
    assert.equal(parseFreeTextDateTimeLocal('2030-13-01 10:00'), null);
    assert.equal(parseFreeTextDateTimeLocal('2030-01-32 10:00'), null);
    assert.equal(parseFreeTextDateTimeLocal('2030-01-15 25:00'), null);
    assert.equal(parseFreeTextDateTimeLocal('2030-01-15 14:60'), null);
    assert.equal(parseFreeTextDateTimeLocal('2030-01-15 13:00 PM'), null);
    assert.equal(parseFreeTextDateTimeLocal('11/30/2030 10:00'), null);
  });
});

describe('P2-3: nav-rail persisted state', () => {
  it('uses a stable storage key and defaults to collapsed', () => {
    assert.equal(NAV_RAIL_STORAGE_KEY, 'gowa-lite:nav-rail-expanded');
    assert.equal(readNavRailExpanded(memoryStorage()), false);
    assert.equal(readNavRailExpanded(null), false);
  });

  it('reads back what was written, and treats garbage as collapsed', () => {
    const storage = memoryStorage();
    writeNavRailExpanded(true, storage);
    assert.equal(storage.getItem(NAV_RAIL_STORAGE_KEY), '1');
    assert.equal(readNavRailExpanded(storage), true);
    writeNavRailExpanded(false, storage);
    assert.equal(storage.getItem(NAV_RAIL_STORAGE_KEY), '0');
    assert.equal(readNavRailExpanded(storage), false);

    assert.equal(readNavRailExpanded(memoryStorage({[NAV_RAIL_STORAGE_KEY]: 'yes'})), false);
    assert.equal(readNavRailExpanded(memoryStorage({[NAV_RAIL_STORAGE_KEY]: 'true'})), false);
  });
});
