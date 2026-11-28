import {phoneFromJid} from '@/features/chat/display-name';
import {toWhatsAppJid} from '@/lib/phone';

/**
 * P1-15 (decision 20): deep link to the scheduled-messages page, filtered
 * on the created schedule where possible.
 *
 * The create-schedule call returns the gateway's untyped result, so no
 * schedule id is reliably available on the client — the recipient phone
 * derived from the chat JID is the filter key the /scheduled search box
 * understands. When the JID yields no phone (group JID, @lid, empty) the
 * link falls back to the plain page.
 *
 * P2-10: the scheduled page's own toasts pass a row recipient, which is a
 * bare phone (not a JID) more often than a JID — normalise it through
 * toWhatsAppJid first so a bare phone deep-links too; a display name (or
 * '—') still falls back to the plain page.
 */
export function buildScheduledDeepLink(jid: string | null | undefined): string {
  const phone = phoneFromJid(jid) || phoneFromJid(toWhatsAppJid(jid ?? ''));
  if (!phone) return '/scheduled';
  return `/scheduled?search=${encodeURIComponent(phone)}`;
}
