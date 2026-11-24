export function normalizeArabicDigits(value: string): string {
  return value
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

export function normalizeSearchInput(raw: string): string {
  const ascii = normalizeArabicDigits(raw);
  const trimmed = ascii.trim();
  if (!trimmed) return '';
  if (/^[\d\s+().-]+$/.test(trimmed)) {
    return trimmed.replace(/[\s+().-]/g, '');
  }
  return trimmed;
}

export function normalizePhoneQueryForGowa(raw: string): string {
  const normalized = normalizeSearchInput(raw);
  if (/^0\d+$/.test(normalized)) {
    const stripped = normalized.replace(/^0+/, '');
    if (stripped.length >= 3) {
      return stripped;
    }
  }
  return normalized;
}

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
