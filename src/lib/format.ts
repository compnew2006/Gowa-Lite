import type {LanguagePreference} from '@/api/types';
import {useAuthStore} from '@/stores/auth';

function resolveLang(lang?: LanguagePreference): LanguagePreference {
  return lang ?? useAuthStore.getState().language ?? 'ar';
}

export function formatBytes(bytes: number, lang?: LanguagePreference): string {
  const activeLang = resolveLang(lang);
  const units =
    activeLang === 'ar'
      ? ['ب', 'ك.ب', 'م.ب', 'ج.ب', 'ت.ب']
      : ['B', 'KB', 'MB', 'GB', 'TB'];
  if (!Number.isFinite(bytes) || bytes <= 0) return `0 ${units[0]}`;
  const power = Math.min(Math.floor(Math.log10(bytes) / 3), units.length - 1);
  const value = bytes / 1000 ** power;
  return `${value % 1 === 0 ? value : value.toFixed(1)} ${units[power]}`;
}

export function isZeroTime(iso: string | null | undefined): boolean {
  if (!iso) return true;
  const millis = new Date(iso).getTime();
  return Number.isNaN(millis) || millis <= 0;
}

const LATIN_AR_LOCALE = 'ar-EG-u-nu-latn';

const formatters = {
  ar: {
    dateTime: new Intl.DateTimeFormat(LATIN_AR_LOCALE, {dateStyle: 'long', timeStyle: 'short'}),
    day: new Intl.DateTimeFormat(LATIN_AR_LOCALE, {dateStyle: 'long'}),
    timeOnly: new Intl.DateTimeFormat(LATIN_AR_LOCALE, {timeStyle: 'short'}),
  },
  en: {
    dateTime: new Intl.DateTimeFormat('en-US', {dateStyle: 'medium', timeStyle: 'short'}),
    day: new Intl.DateTimeFormat('en-US', {dateStyle: 'medium'}),
    timeOnly: new Intl.DateTimeFormat('en-US', {timeStyle: 'short'}),
  },
};

// Decision 1: Latin digits everywhere. The single home for number formatting;
// every display site must go through this instead of building its own
// Intl.NumberFormat or calling toLocaleString() without a locale.
const numberFormatterCache = new Map<string, Intl.NumberFormat>();

export function formatNumber(
  n: number,
  lang?: LanguagePreference,
  options?: Intl.NumberFormatOptions,
): string {
  const activeLang = resolveLang(lang);
  const locale = activeLang === 'ar' ? LATIN_AR_LOCALE : 'en-US';
  const key = `${locale}|${JSON.stringify(options ?? {})}`;
  let formatter = numberFormatterCache.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, options);
    numberFormatterCache.set(key, formatter);
  }
  return formatter.format(n);
}

export function formatDate(iso: string, lang?: LanguagePreference): string {
  if (isZeroTime(iso)) return '—';
  const date = new Date(iso);
  const activeLang = resolveLang(lang);
  return Number.isNaN(date.getTime()) ? iso : formatters[activeLang].dateTime.format(date);
}

export function formatDay(iso: string, lang?: LanguagePreference): string {
  if (isZeroTime(iso)) return '—';
  const date = new Date(iso);
  const activeLang = resolveLang(lang);
  return Number.isNaN(date.getTime()) ? iso : formatters[activeLang].day.format(date);
}

export function formatShortTime(iso: string, lang?: LanguagePreference): string {
  if (isZeroTime(iso)) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const isSameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const activeLang = resolveLang(lang);
  return isSameDay ? formatters[activeLang].timeOnly.format(date) : formatters[activeLang].day.format(date);
}
