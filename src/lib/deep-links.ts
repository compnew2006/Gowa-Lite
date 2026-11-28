/**
 * P2-10 (decision 20): deep links for toast «view» actions — a deep link
 * where the item has an id, a plain page link where it does not.
 *
 * - Chats open via /chats?device=<id>&jid=<jid> (chats.tsx applies the
 *   params and opens the chat); groups via /groups?device=<id>&jid=<jid>
 *   (groups.tsx selects the group).
 * - A group JID handed to the chats page is redirected to /groups by the
 *   chats page itself, so call sites that may hold either kind of JID
 *   (forward target, row-menu chat, notes) use buildConversationDeepLink.
 * - Schedules keep their own builder in scheduled-link.ts (filtered on
 *   the recipient phone); accounts, settings, users and roles have no
 *   per-item deep link, so their toasts link to the plain page.
 */
export function buildChatDeepLink(
  deviceId: string | null | undefined,
  jid: string | null | undefined,
): string {
  if (!deviceId && !jid) return '/chats';
  const params = new URLSearchParams();
  if (deviceId) params.set('device', deviceId);
  if (jid) params.set('jid', jid);
  return `/chats?${params.toString()}`;
}

export function buildGroupDeepLink(
  deviceId: string | null | undefined,
  jid: string | null | undefined,
): string {
  if (!deviceId && !jid) return '/groups';
  const params = new URLSearchParams();
  if (deviceId) params.set('device', deviceId);
  if (jid) params.set('jid', jid);
  return `/groups?${params.toString()}`;
}

export function buildConversationDeepLink(
  deviceId: string | null | undefined,
  jid: string | null | undefined,
): string {
  if (jid && jid.toLowerCase().endsWith('@g.us')) {
    return buildGroupDeepLink(deviceId, jid);
  }
  return buildChatDeepLink(deviceId, jid);
}
