export function isNewsletterJid(jid: string): boolean {
  return jid.trim().toLowerCase().endsWith('@newsletter');
}

export function isStatusBroadcastJid(jid: string): boolean {
  return jid.trim().toLowerCase() === 'status@broadcast';
}

export function isGroupJid(jid: string): boolean {
  return jid.trim().toLowerCase().endsWith('@g.us');
}

export function isExcludedFromUnifiedChats(jid: string): boolean {
  return isNewsletterJid(jid) || isStatusBroadcastJid(jid) || isGroupJid(jid);
}

export function normalizeArabicDigits(value: string): string {
  return value
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

export function normalizeSearchQuery(raw: string): string {
  const ascii = normalizeArabicDigits(raw);
  const trimmed = ascii.trim();
  if (!trimmed) return '';
  if (/^[\d\s+().-]+$/.test(trimmed)) {
    return trimmed.replace(/[\s+().-]/g, '');
  }
  return trimmed;
}

export function normalizePhoneQueryForGowa(raw: string): string {
  const normalized = normalizeSearchQuery(raw);
  if (/^0\d+$/.test(normalized)) {
    const stripped = normalized.replace(/^0+/, '');
    if (stripped.length >= 3) {
      return stripped;
    }
  }
  return normalized;
}

export function normalizeWhatsAppJid(raw: string): string {
  const ascii = normalizeArabicDigits(raw).trim();
  if (!ascii) return '';

  if (ascii.includes('@')) {
    const compact = ascii.replace(/\s+/g, '');
    const match = /^([^@\s]+)@([a-z0-9.-]+)$/i.exec(compact);
    if (!match) return '';
    let local = match[1];
    let domain = match[2].toLowerCase();
    if (domain === 'c.us') {
      domain = 's.whatsapp.net';
    }
    if (domain === 's.whatsapp.net' || domain === 'lid') {
      local = local.split(':')[0] || local;
    }
    return `${local}@${domain}`;
  }

  const digits = ascii.replace(/[\s+().-]/g, '');
  if (/^\d{5,}$/.test(digits)) {
    return `${digits}@s.whatsapp.net`;
  }
  return '';
}

export function matchesNormalizedSearch(
  haystackParts: Array<string | undefined | null>,
  rawQuery: string,
): boolean {
  const normalized = normalizeSearchQuery(rawQuery).toLowerCase();
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
