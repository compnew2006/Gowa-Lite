import {normalizeArabicDigits, normalizeSearchQuery as normalizeSearchInput} from '../../shared/whatsapp-identity.ts';

export {
  normalizeArabicDigits,
  normalizeSearchQuery as normalizeSearchInput,
  normalizePhoneQueryForGowa,
  normalizeWhatsAppJid as toWhatsAppJid,
} from '../../shared/whatsapp-identity.ts';

export function matchesNormalizedQuery(haystackParts: Array<string | undefined | null>, rawQuery: string): boolean {
  const normalized = normalizeSearchInput(rawQuery).toLowerCase();
  if (!normalized) return true;

  const isDigitsOnly = /^\d+$/.test(normalized);
  const strippedLeadingZero = isDigitsOnly ? normalized.replace(/^0+/, '') : '';

  for (const part of haystackParts) {
    if (!part) continue;
    const lowered = normalizeArabicDigits(part).toLowerCase();
    if (lowered.includes(normalized)) return true;
    if (isDigitsOnly) {
      const compactDigits = lowered.replace(/[^\d]/g, '');
      if (compactDigits.includes(normalized)) return true;
      if (strippedLeadingZero.length >= 3 && compactDigits.includes(strippedLeadingZero)) {
        return true;
      }
    }
  }
  return false;
}
