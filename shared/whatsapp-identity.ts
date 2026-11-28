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

/**
 * The device's own WhatsApp JID, from the gateway's device record.
 * Prefers the explicit `jid`, then the phone number, then the device id
 * itself (some deployments use the phone number as the device id).
 * Returns '' when nothing usable identifies the device.
 */
export function resolveDeviceOwnJid(device: {
  id: string;
  jid?: string | null;
  phone_number?: string | null;
}): string {
  for (const candidate of [device.jid, device.phone_number, device.id]) {
    if (!candidate) continue;
    const normalized = normalizeWhatsAppJid(candidate);
    if (normalized) return normalized;
  }
  return '';
}

/**
 * Server-side `is_from_me` derivation (P1-18, decision 19): the sender JID
 * is ground truth — a message is outgoing iff its (normalized) sender JID
 * equals the device's own JID. The gateway flag is never the sole source,
 * and an explicit `true` flag is never flipped to `false` (some paths carry
 * sender_jid 'me' or an empty sender for own messages, e.g. locally cached
 * sends). A `false` flag loses to the ground-truth sender JID.
 */
export function resolveIsFromMe(
  senderJid: string | undefined | null,
  deviceOwnJid: string | undefined | null,
  gatewayFlag?: boolean | null,
): boolean {
  if (gatewayFlag === true) return true;
  const sender = senderJid ? normalizeWhatsAppJid(senderJid) : '';
  const own = deviceOwnJid ? normalizeWhatsAppJid(deviceOwnJid) : '';
  return Boolean(sender && own && sender === own);
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
