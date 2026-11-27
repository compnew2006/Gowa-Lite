import {
  getSetting,
  getUserById,
  listUsers,
  parseTimestampMs,
  setSetting,
  withImmediateTransaction,
  type PublicUser,
} from '../db.ts';
import {
  batchUpdateAssignmentMetadata,
  defaultChatAssignment,
  getAssignmentStatsForDevices,
  getChatLifecycleMap,
  getOpenChatCountsByUser,
  insertChatLifecycleEventRow,
  listAssignmentsForDevices,
  listChatLifecycleEventRows,
  listDbChatsByLifecycleStatus,
  readChatAssignmentRow,
  resolveKnownChatActivityMs,
  updateChatAssignmentActivityAndTitle,
  upsertChatAssignmentRow,
  type ChatAssignmentInfo,
  type ChatLifecycleEvent,
  type ChatLifecycleEventType,
  type ChatLifecycleStatus,
  type DbLifecycleChatEntry,
} from '../db/lifecycle-repo.ts';
import {GowaError} from '../errors.ts';
import {hasAnyPermission, hasDeviceAccess, hasPermission, isAdminSubject} from '../rbac.ts';
import {expireChatCloseRatings, queueChatCloseRating} from './chat-close-rating.ts';
import {
  isGroupJid,
  isNewsletterJid,
  isStatusBroadcastJid,
  normalizeWhatsAppJid,
} from '../../shared/whatsapp-identity.ts';

export type {
  ChatAssignmentInfo,
  ChatLifecycleEvent,
  ChatLifecycleEventType,
  ChatLifecycleStatus,
  DbLifecycleChatEntry,
};

export {
  getAssignmentStatsForDevices,
  getChatLifecycleMap,
  listAssignmentsForDevices,
  listDbChatsByLifecycleStatus,
};

export type UnassignedReplyPolicy = 'auto_claim' | 'allow_without_claim' | 'require_claim';
export type ClosedReplyPolicy = 'block' | 'reopen_and_claim';

export interface InboxPolicy {
  unassigned_reply_policy: UnassignedReplyPolicy;
  closed_reply_policy: ClosedReplyPolicy;
}

export interface AssignableAgent {
  id: number;
  username: string;
  display_name: string;
  role_slug: string;
  role_name: string;
  open_chat_count: number;
}

export interface ChatLifecycleWsPayload {
  code: 'CHAT_LIFECYCLE_UPDATED';
  message: string;
  device_id: string;
  result: {
    device_id: string;
    chat_jid: string;
    assignment: ChatAssignmentInfo;
    event?: ChatLifecycleEvent;
  };
}

const DEFAULT_INBOX_POLICY: InboxPolicy = {
  unassigned_reply_policy: 'auto_claim',
  closed_reply_policy: 'block',
};

const VALID_UNASSIGNED_POLICIES = new Set<UnassignedReplyPolicy>([
  'auto_claim',
  'allow_without_claim',
  'require_claim',
]);
const VALID_CLOSED_POLICIES = new Set<ClosedReplyPolicy>(['block', 'reopen_and_claim']);

export function normalizeLifecycleTarget(
  rawDeviceId: string,
  rawChatJid: string,
): {deviceId: string; chatJid: string} {
  const deviceId = rawDeviceId.trim();
  const trimmedJid = rawChatJid.trim();
  const chatJid = normalizeWhatsAppJid(trimmedJid) || trimmedJid;

  if (!deviceId || !chatJid) {
    throw new GowaError(400, 'VALIDATION_ERROR', 'معرّف الحساب والمحادثة مطلوبان');
  }
  if (isStatusBroadcastJid(chatJid) || isNewsletterJid(chatJid) || isGroupJid(chatJid)) {
    throw new GowaError(
      400,
      'UNSUPPORTED_CHAT_TYPE',
      'لا تدعم المجموعات أو القنوات أو حالات واتساب دورة حياة المحادثات',
    );
  }
  return {deviceId, chatJid};
}

function hasSupervisorView(user: PublicUser): boolean {
  return isAdminSubject(user) || hasPermission(user, 'chats', 'view_all');
}

export function buildLifecycleWsPayload(
  assignment: ChatAssignmentInfo,
  event?: ChatLifecycleEvent,
): ChatLifecycleWsPayload {
  return {
    code: 'CHAT_LIFECYCLE_UPDATED',
    message: event?.event_type || assignment.status,
    device_id: assignment.device_id,
    result: {
      device_id: assignment.device_id,
      chat_jid: assignment.chat_jid,
      assignment,
      ...(event ? {event} : {}),
    },
  };
}

export function getInboxPolicy(): InboxPolicy {
  const raw = getSetting('inbox_policy');
  if (!raw) return {...DEFAULT_INBOX_POLICY};
  try {
    const parsed = JSON.parse(raw) as Partial<InboxPolicy>;
    const unassigned = VALID_UNASSIGNED_POLICIES.has(
      parsed.unassigned_reply_policy as UnassignedReplyPolicy,
    )
      ? (parsed.unassigned_reply_policy as UnassignedReplyPolicy)
      : DEFAULT_INBOX_POLICY.unassigned_reply_policy;
    const closed = VALID_CLOSED_POLICIES.has(parsed.closed_reply_policy as ClosedReplyPolicy)
      ? (parsed.closed_reply_policy as ClosedReplyPolicy)
      : DEFAULT_INBOX_POLICY.closed_reply_policy;
    return {
      unassigned_reply_policy: unassigned,
      closed_reply_policy: closed,
    };
  } catch {
    return {...DEFAULT_INBOX_POLICY};
  }
}

export function updateInboxPolicy(input: {
  unassigned_reply_policy?: unknown;
  closed_reply_policy?: unknown;
}): InboxPolicy {
  const current = getInboxPolicy();
  let nextUnassigned = current.unassigned_reply_policy;
  let nextClosed = current.closed_reply_policy;

  if (input.unassigned_reply_policy !== undefined) {
    if (
      typeof input.unassigned_reply_policy !== 'string' ||
      !VALID_UNASSIGNED_POLICIES.has(input.unassigned_reply_policy as UnassignedReplyPolicy)
    ) {
      throw new GowaError(400, 'VALIDATION_ERROR', 'سياسة الرد على المحادثات غير المستلمة غير صالحة');
    }
    nextUnassigned = input.unassigned_reply_policy as UnassignedReplyPolicy;
  }

  if (input.closed_reply_policy !== undefined) {
    if (
      typeof input.closed_reply_policy !== 'string' ||
      !VALID_CLOSED_POLICIES.has(input.closed_reply_policy as ClosedReplyPolicy)
    ) {
      throw new GowaError(400, 'VALIDATION_ERROR', 'سياسة الرد على المحادثات المغلقة غير صالحة');
    }
    nextClosed = input.closed_reply_policy as ClosedReplyPolicy;
  }

  const nextPolicy: InboxPolicy = {
    unassigned_reply_policy: nextUnassigned,
    closed_reply_policy: nextClosed,
  };
  setSetting('inbox_policy', JSON.stringify(nextPolicy));
  return nextPolicy;
}

export function isLifecycleApplicableJid(chatJid: string): boolean {
  const trimmed = chatJid.trim();
  if (!trimmed) return false;
  return !isStatusBroadcastJid(trimmed) && !isNewsletterJid(trimmed) && !isGroupJid(trimmed);
}

export type ChatRedactionReason = 'pending' | 'closed' | 'assigned_other';

export interface ChatContentAccessState {
  allowed: boolean;
  reason?: ChatRedactionReason;
  assignment: ChatAssignmentInfo;
}

export function getChatLifecycleState(deviceIdRaw: string, chatJidRaw: string): ChatAssignmentInfo {
  const {deviceId, chatJid} = normalizeLifecycleTarget(deviceIdRaw, chatJidRaw);
  return readChatAssignmentRow(deviceId, chatJid) ?? defaultChatAssignment(deviceId, chatJid);
}

export function getChatContentAccessState(
  user: PublicUser,
  deviceIdRaw: string,
  chatJidRaw: string,
): ChatContentAccessState {
  const deviceId = deviceIdRaw.trim();
  const trimmedJid = chatJidRaw.trim();
  const chatJid = normalizeWhatsAppJid(trimmedJid) || trimmedJid;

  if (!deviceId || !chatJid || !isLifecycleApplicableJid(chatJid)) {
    return {
      allowed: true,
      assignment: defaultChatAssignment(deviceId, chatJid),
    };
  }

  const assignment =
    readChatAssignmentRow(deviceId, chatJid) ?? defaultChatAssignment(deviceId, chatJid);
  if (hasSupervisorView(user)) {
    return {allowed: true, assignment};
  }
  if (assignment.status === 'open' && assignment.assigned_user_id === user.id) {
    return {allowed: true, assignment};
  }

  const reason: ChatRedactionReason =
    assignment.status === 'closed'
      ? 'closed'
      : assignment.status === 'open'
        ? 'assigned_other'
        : 'pending';

  return {allowed: false, reason, assignment};
}

export function assertChatContentAccess(
  user: PublicUser,
  deviceIdRaw: string,
  chatJidRaw: string,
): ChatAssignmentInfo {
  const state = getChatContentAccessState(user, deviceIdRaw, chatJidRaw);
  if (!state.allowed) {
    throw new GowaError(
      403,
      'CHAT_CONTENT_REDACTED',
      'محتوى هذه المحادثة محجوب حاليًا حتى يتم استلامها أو فتحها',
      {redaction_reason: state.reason, assignment: state.assignment},
    );
  }
  return state.assignment;
}

export type UnifiedChatTab = 'all' | 'me' | 'open' | 'pending' | 'closed';

export interface UnifiedTabCounts {
  all: number;
  me: number;
  open: number;
  pending: number;
  closed: number;
}

export function syncAssignmentMetadataFromChats(
  chats: Array<{device_id: string; chat_jid: string; name?: string; last_message_time?: string}>,
  existingMap?: Map<string, ChatAssignmentInfo>,
): boolean {
  if (chats.length === 0) return false;
  const map = existingMap ?? getChatLifecycleMap(chats);
  const toUpdate: Array<{device_id: string; chat_jid: string; title: string; activityMs: number}> = [];

  for (const item of chats) {
    const existing = map.get(`${item.device_id}::${item.chat_jid}`);
    if (!existing) continue;
    const incomingTitle = (item.name ?? '').trim();
    const incomingMs = item.last_message_time ? parseTimestampMs(item.last_message_time) : 0;
    const needsTitle = !existing.cached_title && Boolean(incomingTitle);
    const needsTime = incomingMs > existing.last_activity_ms;
    if (needsTitle || needsTime) {
      toUpdate.push({
        device_id: item.device_id,
        chat_jid: item.chat_jid,
        title: incomingTitle,
        activityMs: incomingMs,
      });
    }
  }

  if (toUpdate.length === 0) return false;
  batchUpdateAssignmentMetadata(toUpdate);
  return true;
}

export function listChatLifecycleEvents(
  deviceIdRaw: string,
  chatJidRaw: string,
  limit = 100,
): ChatLifecycleEvent[] {
  const {deviceId, chatJid} = normalizeLifecycleTarget(deviceIdRaw, chatJidRaw);
  return listChatLifecycleEventRows(deviceId, chatJid, limit);
}

export function listAssignableAgents(deviceIdRaw: string): AssignableAgent[] {
  const deviceId = deviceIdRaw.trim();
  if (!deviceId) {
    throw new GowaError(400, 'VALIDATION_ERROR', 'معرّف الحساب مطلوب');
  }

  const countsByUser = getOpenChatCountsByUser();

  const eligible = listUsers()
    .filter(
      (u) =>
        u.is_active &&
        hasDeviceAccess(u, deviceId) &&
        hasAnyPermission(u, ['chats:read', 'chats:write']),
    )
    .map<AssignableAgent>((u) => ({
      id: u.id,
      username: u.username,
      display_name: u.display_name,
      role_slug: u.role_slug,
      role_name: u.role_name,
      open_chat_count: countsByUser.get(u.id) ?? 0,
    }));

  eligible.sort((a, b) => {
    if (a.open_chat_count !== b.open_chat_count) {
      return a.open_chat_count - b.open_chat_count;
    }
    return a.display_name.localeCompare(b.display_name);
  });

  return eligible;
}

export function claimChat(
  actor: PublicUser,
  deviceIdRaw: string,
  chatJidRaw: string,
  options?: {cachedTitle?: string},
): {assignment: ChatAssignmentInfo; event: ChatLifecycleEvent} {
  if (!hasPermission(actor, 'chats', 'assign')) {
    throw new GowaError(403, 'FORBIDDEN', 'ليس لديك صلاحية استلام المحادثات');
  }
  const {deviceId, chatJid} = normalizeLifecycleTarget(deviceIdRaw, chatJidRaw);
  if (!hasDeviceAccess(actor, deviceId)) {
    throw new GowaError(403, 'DEVICE_FORBIDDEN', 'غير مصرح لك بالوصول إلى حساب واتساب هذا');
  }

  return withImmediateTransaction(() => {
    const existing = readChatAssignmentRow(deviceId, chatJid);
    if (existing?.status === 'closed') {
      throw new GowaError(
        409,
        'CHAT_CLOSED',
        'هذه المحادثة مغلقة حاليًا؛ يرجى إعادة فتحها قبل الاستلام',
        {assignment: existing},
      );
    }
    if (existing?.status === 'open' && existing.assigned_user_id !== null) {
      const ownerName = existing.assigned_user_name || 'وكيل آخر';
      throw new GowaError(
        409,
        'ALREADY_CLAIMED',
        `تم استلام هذه المحادثة بالفعل بواسطة ${ownerName}`,
        {assignment: existing},
      );
    }

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const activityMs = resolveKnownChatActivityMs(
      deviceId,
      chatJid,
      existing?.last_activity_ms ?? 0,
    );
    const cachedTitle = (options?.cachedTitle ?? '').trim() || existing?.cached_title || '';

    const assignment = upsertChatAssignmentRow({
      deviceId,
      chatJid,
      status: 'open',
      assignedUserId: actor.id,
      assignedAt: nowIso,
      claimedAt: nowIso,
      closedById: null,
      closedAt: null,
      closeReason: '',
      cachedTitle,
      lastActivityMs: activityMs,
      updatedAt: nowMs,
    });

    const event = insertChatLifecycleEventRow({
      deviceId,
      chatJid,
      eventType: 'claimed',
      actorUserId: actor.id,
      actorName: actor.display_name,
      targetUserId: actor.id,
      targetName: actor.display_name,
      createdAt: nowIso,
      createdAtMs: nowMs,
    });

    return {assignment, event};
  });
}

export function assignChat(
  actor: PublicUser,
  deviceIdRaw: string,
  chatJidRaw: string,
  targetUserId: number | null,
  options?: {note?: string; cachedTitle?: string},
): {assignment: ChatAssignmentInfo; event?: ChatLifecycleEvent} {
  if (targetUserId === null) {
    return releaseChat(actor, deviceIdRaw, chatJidRaw, options);
  }

  if (!hasPermission(actor, 'chats', 'assign')) {
    throw new GowaError(403, 'FORBIDDEN', 'ليس لديك صلاحية تعيين المحادثات');
  }
  const {deviceId, chatJid} = normalizeLifecycleTarget(deviceIdRaw, chatJidRaw);
  if (!hasDeviceAccess(actor, deviceId)) {
    throw new GowaError(403, 'DEVICE_FORBIDDEN', 'غير مصرح لك بالوصول إلى حساب واتساب هذا');
  }

  const targetUser = getUserById(targetUserId);
  if (!targetUser) {
    throw new GowaError(404, 'USER_NOT_FOUND', 'المستخدم المحدد غير موجود');
  }
  if (!targetUser.is_active) {
    throw new GowaError(400, 'USER_INACTIVE', 'لا يمكن تعيين محادثة إلى مستخدم معطّل');
  }
  if (!hasDeviceAccess(targetUser, deviceId)) {
    throw new GowaError(
      403,
      'TARGET_DEVICE_FORBIDDEN',
      'المستخدم المحدد غير مخوّل للوصول إلى حساب واتساب هذا',
    );
  }
  if (!hasAnyPermission(targetUser, ['chats:read', 'chats:write'])) {
    throw new GowaError(
      400,
      'TARGET_LACKS_CHAT_PERMISSION',
      'الدور الوظيفي للمستخدم المحدد لا يشمل الوصول إلى المحادثات',
    );
  }

  return withImmediateTransaction(() => {
    const existing = readChatAssignmentRow(deviceId, chatJid);
    const supervisor = hasSupervisorView(actor);

    if (!supervisor) {
      if (existing?.status === 'closed') {
        throw new GowaError(
          403,
          'FORBIDDEN',
          'لا يمكنك تعيين محادثة مغلقة؛ يرجى إعادة فتحها أولًا',
        );
      }
      if (
        existing?.status === 'open' &&
        existing.assigned_user_id !== null &&
        existing.assigned_user_id !== actor.id
      ) {
        throw new GowaError(
          403,
          'FORBIDDEN',
          'لا يمكنك إعادة تعيين محادثة مسندة لوكيل آخر',
        );
      }
    }

    if (existing?.status === 'open' && existing.assigned_user_id === targetUser.id) {
      return {assignment: existing};
    }

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const isTransfer =
      existing?.status === 'open' &&
      existing.assigned_user_id !== null &&
      existing.assigned_user_id !== targetUser.id;
    const isSelfClaim = targetUser.id === actor.id && existing?.status !== 'open';
    const eventType: ChatLifecycleEventType = isTransfer
      ? 'transferred'
      : isSelfClaim
        ? 'claimed'
        : 'assigned';

    const activityMs = resolveKnownChatActivityMs(
      deviceId,
      chatJid,
      existing?.last_activity_ms ?? 0,
    );
    const cachedTitle = (options?.cachedTitle ?? '').trim() || existing?.cached_title || '';

    const assignment = upsertChatAssignmentRow({
      deviceId,
      chatJid,
      status: 'open',
      assignedUserId: targetUser.id,
      assignedAt: nowIso,
      claimedAt: targetUser.id === actor.id ? nowIso : existing?.claimed_at ?? null,
      closedById: null,
      closedAt: null,
      closeReason: '',
      cachedTitle,
      lastActivityMs: activityMs,
      updatedAt: nowMs,
    });

    const event = insertChatLifecycleEventRow({
      deviceId,
      chatJid,
      eventType,
      actorUserId: actor.id,
      actorName: actor.display_name,
      targetUserId: targetUser.id,
      targetName: targetUser.display_name,
      note: options?.note,
      createdAt: nowIso,
      createdAtMs: nowMs,
    });

    return {assignment, event};
  });
}

export function releaseChat(
  actor: PublicUser,
  deviceIdRaw: string,
  chatJidRaw: string,
  options?: {note?: string; cachedTitle?: string},
): {assignment: ChatAssignmentInfo; event?: ChatLifecycleEvent} {
  if (!hasPermission(actor, 'chats', 'assign')) {
    throw new GowaError(403, 'FORBIDDEN', 'ليس لديك صلاحية تحرير المحادثات');
  }
  const {deviceId, chatJid} = normalizeLifecycleTarget(deviceIdRaw, chatJidRaw);
  if (!hasDeviceAccess(actor, deviceId)) {
    throw new GowaError(403, 'DEVICE_FORBIDDEN', 'غير مصرح لك بالوصول إلى حساب واتساب هذا');
  }

  return withImmediateTransaction(() => {
    const existing = readChatAssignmentRow(deviceId, chatJid);
    const supervisor = hasSupervisorView(actor);

    if (!existing || existing.status === 'pending') {
      return {assignment: existing ?? defaultChatAssignment(deviceId, chatJid)};
    }

    if (existing.status === 'closed' && !supervisor) {
      throw new GowaError(
        403,
        'FORBIDDEN',
        'لا يمكن تحرير محادثة مغلقة مباشرة؛ يجب إعادة فتحها أولًا',
      );
    }

    if (
      existing.status === 'open' &&
      existing.assigned_user_id !== null &&
      existing.assigned_user_id !== actor.id &&
      !supervisor
    ) {
      throw new GowaError(403, 'FORBIDDEN', 'يمكنك تحرير المحادثات المسندة إليك فقط');
    }

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const activityMs = resolveKnownChatActivityMs(deviceId, chatJid, existing.last_activity_ms);
    const cachedTitle = (options?.cachedTitle ?? '').trim() || existing.cached_title || '';

    const assignment = upsertChatAssignmentRow({
      deviceId,
      chatJid,
      status: 'pending',
      assignedUserId: null,
      assignedAt: null,
      claimedAt: null,
      closedById: null,
      closedAt: null,
      closeReason: '',
      cachedTitle,
      lastActivityMs: activityMs,
      updatedAt: nowMs,
    });

    const event = insertChatLifecycleEventRow({
      deviceId,
      chatJid,
      eventType: 'released',
      actorUserId: actor.id,
      actorName: actor.display_name,
      targetUserId: existing.assigned_user_id,
      targetName: existing.assigned_user_name ?? '',
      note: options?.note,
      createdAt: nowIso,
      createdAtMs: nowMs,
    });

    return {assignment, event};
  });
}

export function closeChat(
  actor: PublicUser,
  deviceIdRaw: string,
  chatJidRaw: string,
  options?: {reason?: string; cachedTitle?: string},
): {assignment: ChatAssignmentInfo; event?: ChatLifecycleEvent} {
  if (!hasPermission(actor, 'chats', 'close')) {
    throw new GowaError(403, 'FORBIDDEN', 'ليس لديك صلاحية إغلاق المحادثات');
  }
  const {deviceId, chatJid} = normalizeLifecycleTarget(deviceIdRaw, chatJidRaw);
  if (!hasDeviceAccess(actor, deviceId)) {
    throw new GowaError(403, 'DEVICE_FORBIDDEN', 'غير مصرح لك بالوصول إلى حساب واتساب هذا');
  }

  return withImmediateTransaction(() => {
    const existing = readChatAssignmentRow(deviceId, chatJid);
    const supervisor = hasSupervisorView(actor);

    if (existing?.status === 'closed') {
      return {assignment: existing};
    }

    if (
      existing?.status === 'open' &&
      existing.assigned_user_id !== null &&
      existing.assigned_user_id !== actor.id &&
      !supervisor
    ) {
      throw new GowaError(
        403,
        'FORBIDDEN',
        'لا يمكنك إغلاق محادثة مسندة لوكيل آخر',
      );
    }

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const cleanReason = (options?.reason ?? '').trim().slice(0, 500);
    const activityMs = resolveKnownChatActivityMs(
      deviceId,
      chatJid,
      existing?.last_activity_ms ?? 0,
    );
    const cachedTitle = (options?.cachedTitle ?? '').trim() || existing?.cached_title || '';

    const ratedUserId =
      existing?.status === 'open' && existing.assigned_user_id !== null
        ? existing.assigned_user_id
        : actor.id;
    const ratedUserName =
      existing?.status === 'open' && existing.assigned_user_id !== null
        ? (existing.assigned_user_name || actor.display_name)
        : actor.display_name;

    const assignment = upsertChatAssignmentRow({
      deviceId,
      chatJid,
      status: 'closed',
      assignedUserId: null,
      assignedAt: null,
      claimedAt: null,
      closedById: actor.id,
      closedAt: nowIso,
      closeReason: cleanReason,
      cachedTitle,
      lastActivityMs: activityMs,
      updatedAt: nowMs,
    });

    const event = insertChatLifecycleEventRow({
      deviceId,
      chatJid,
      eventType: 'closed',
      actorUserId: actor.id,
      actorName: actor.display_name,
      targetUserId: ratedUserId !== actor.id ? ratedUserId : null,
      targetName: ratedUserId !== actor.id ? ratedUserName : '',
      note: cleanReason,
      createdAt: nowIso,
      createdAtMs: nowMs,
    });

    queueChatCloseRating(deviceId, chatJid, event.id, nowMs, {
      ratedUserId,
      ratedUserName,
      closedByUserId: actor.id,
    });
    return {assignment, event};
  });
}

export function reopenChat(
  actor: PublicUser,
  deviceIdRaw: string,
  chatJidRaw: string,
  options?: {assignToSelf?: boolean; note?: string; cachedTitle?: string},
): {assignment: ChatAssignmentInfo; event?: ChatLifecycleEvent} {
  if (!hasPermission(actor, 'chats', 'close')) {
    throw new GowaError(403, 'FORBIDDEN', 'ليس لديك صلاحية إعادة فتح المحادثات');
  }
  const {deviceId, chatJid} = normalizeLifecycleTarget(deviceIdRaw, chatJidRaw);
  if (!hasDeviceAccess(actor, deviceId)) {
    throw new GowaError(403, 'DEVICE_FORBIDDEN', 'غير مصرح لك بالوصول إلى حساب واتساب هذا');
  }

  return withImmediateTransaction(() => {
    const existing = readChatAssignmentRow(deviceId, chatJid);
    if (!existing || existing.status !== 'closed') {
      return {assignment: existing ?? defaultChatAssignment(deviceId, chatJid)};
    }

    expireChatCloseRatings(deviceId, chatJid);
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const shouldClaim = Boolean(options?.assignToSelf) && hasPermission(actor, 'chats', 'assign');
    const activityMs = resolveKnownChatActivityMs(deviceId, chatJid, existing.last_activity_ms);
    const cachedTitle = (options?.cachedTitle ?? '').trim() || existing.cached_title || '';

    const assignment = upsertChatAssignmentRow({
      deviceId,
      chatJid,
      status: shouldClaim ? 'open' : 'pending',
      assignedUserId: shouldClaim ? actor.id : null,
      assignedAt: shouldClaim ? nowIso : null,
      claimedAt: shouldClaim ? nowIso : null,
      closedById: null,
      closedAt: null,
      closeReason: '',
      cachedTitle,
      lastActivityMs: activityMs,
      updatedAt: nowMs,
    });

    const event = insertChatLifecycleEventRow({
      deviceId,
      chatJid,
      eventType: 'reopened',
      actorUserId: actor.id,
      actorName: actor.display_name,
      targetUserId: shouldClaim ? actor.id : null,
      targetName: shouldClaim ? actor.display_name : '',
      note: options?.note,
      createdAt: nowIso,
      createdAtMs: nowMs,
    });

    return {assignment, event};
  });
}

export function handleIncomingCustomerMessageLifecycle(
  deviceIdRaw: string,
  chatJidRaw: string,
  messageTimestampMs?: number,
  cachedTitle?: string,
): ChatLifecycleWsPayload | null {
  const deviceId = deviceIdRaw.trim();
  const trimmedJid = chatJidRaw.trim();
  const chatJid = normalizeWhatsAppJid(trimmedJid) || trimmedJid;
  if (
    !deviceId ||
    !chatJid ||
    isStatusBroadcastJid(chatJid) ||
    isNewsletterJid(chatJid) ||
    isGroupJid(chatJid)
  ) {
    return null;
  }

  return withImmediateTransaction(() => {
    const existing = readChatAssignmentRow(deviceId, chatJid);
    const activityMs = Math.max(
      existing?.last_activity_ms ?? 0,
      Number.isFinite(messageTimestampMs) && (messageTimestampMs ?? 0) > 0
        ? (messageTimestampMs as number)
        : 0,
      Date.now(),
    );

    if (!existing) {
      return null;
    }

    if (existing.status !== 'closed') {
      if (activityMs > existing.last_activity_ms || (cachedTitle && cachedTitle.trim() && !existing.cached_title)) {
        updateChatAssignmentActivityAndTitle(deviceId, chatJid, activityMs, cachedTitle ?? '');
      }
      return null;
    }

    // GOWA may round timestamps to seconds. Ignore history older than this close.
    const closedAt = parseTimestampMs(existing.closed_at || '');
    if (messageTimestampMs && messageTimestampMs < Math.floor(closedAt / 1000) * 1000) return null;

    expireChatCloseRatings(deviceId, chatJid);
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const assignment = upsertChatAssignmentRow({
      deviceId,
      chatJid,
      status: 'pending',
      assignedUserId: null,
      assignedAt: null,
      claimedAt: null,
      closedById: null,
      closedAt: null,
      closeReason: '',
      cachedTitle: (cachedTitle ?? '').trim() || existing.cached_title,
      lastActivityMs: activityMs,
      updatedAt: nowMs,
    });

    const event = insertChatLifecycleEventRow({
      deviceId,
      chatJid,
      eventType: 'reopened_by_customer',
      actorUserId: null,
      actorName: '',
      createdAt: nowIso,
      createdAtMs: nowMs,
    });

    return buildLifecycleWsPayload(assignment, event);
  });
}

export function enforceInboxPolicyBeforeSend(
  actor: PublicUser,
  deviceIdRaw: string,
  chatJidRaw: string,
  cachedTitle?: string,
): {assignment: ChatAssignmentInfo; lifecycleEvent: ChatLifecycleWsPayload | null} {
  const trimmedDevice = deviceIdRaw.trim();
  const trimmedJid = chatJidRaw.trim();
  const normalizedJid = normalizeWhatsAppJid(trimmedJid) || trimmedJid;
  if (trimmedDevice && normalizedJid && isGroupJid(normalizedJid)) {
    return {
      assignment: defaultChatAssignment(trimmedDevice, normalizedJid),
      lifecycleEvent: null,
    };
  }
  const {deviceId, chatJid} = normalizeLifecycleTarget(deviceIdRaw, chatJidRaw);
  const policy = getInboxPolicy();
  const supervisor = hasSupervisorView(actor);
  const canAssign = hasPermission(actor, 'chats', 'assign');
  const canClose = hasPermission(actor, 'chats', 'close');

  return withImmediateTransaction(() => {
    const existing = readChatAssignmentRow(deviceId, chatJid) ?? defaultChatAssignment(deviceId, chatJid);

    if (existing.status === 'closed') {
      if (policy.closed_reply_policy === 'block') {
        throw new GowaError(
          409,
          'CHAT_CLOSED',
          'هذه المحادثة مغلقة حاليًا؛ يرجى إعادة فتحها قبل إرسال الرد',
          {assignment: existing},
        );
      }
      if (!canClose && !supervisor) {
        throw new GowaError(
          403,
          'FORBIDDEN',
          'ليس لديك صلاحية إعادة فتح المحادثات المغلقة',
        );
      }
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      const activityMs = resolveKnownChatActivityMs(deviceId, chatJid, Math.max(existing.last_activity_ms, nowMs));
      const assignment = upsertChatAssignmentRow({
        deviceId,
        chatJid,
        status: canAssign ? 'open' : 'pending',
        assignedUserId: canAssign ? actor.id : null,
        assignedAt: canAssign ? nowIso : null,
        claimedAt: canAssign ? nowIso : null,
        closedById: null,
        closedAt: null,
        closeReason: '',
        cachedTitle: (cachedTitle ?? '').trim() || existing.cached_title,
        lastActivityMs: activityMs,
        updatedAt: nowMs,
      });
      const event = insertChatLifecycleEventRow({
        deviceId,
        chatJid,
        eventType: 'reopened',
        actorUserId: actor.id,
        actorName: actor.display_name,
        targetUserId: canAssign ? actor.id : null,
        targetName: canAssign ? actor.display_name : '',
        createdAt: nowIso,
        createdAtMs: nowMs,
      });
      return {assignment, lifecycleEvent: buildLifecycleWsPayload(assignment, event)};
    }

    if (existing.status === 'open') {
      if (
        existing.assigned_user_id !== null &&
        existing.assigned_user_id !== actor.id &&
        !supervisor
      ) {
        const ownerName = existing.assigned_user_name || 'وكيل آخر';
        throw new GowaError(
          403,
          'CHAT_ASSIGNED_TO_OTHER',
          `هذه المحادثة مسندة حاليًا إلى ${ownerName}`,
          {assignment: existing},
        );
      }
      return {assignment: existing, lifecycleEvent: null};
    }

    // Status is 'pending'
    if (policy.unassigned_reply_policy === 'require_claim') {
      throw new GowaError(
        409,
        'CLAIM_REQUIRED',
        'سياسة العمل تتطلب استلام المحادثة أولًا قبل الرد عليها',
        {assignment: existing},
      );
    }

    if (policy.unassigned_reply_policy === 'auto_claim' && canAssign) {
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      const activityMs = resolveKnownChatActivityMs(deviceId, chatJid, Math.max(existing.last_activity_ms, nowMs));
      const assignment = upsertChatAssignmentRow({
        deviceId,
        chatJid,
        status: 'open',
        assignedUserId: actor.id,
        assignedAt: nowIso,
        claimedAt: nowIso,
        closedById: null,
        closedAt: null,
        closeReason: '',
        cachedTitle: (cachedTitle ?? '').trim() || existing.cached_title,
        lastActivityMs: activityMs,
        updatedAt: nowMs,
      });
      const event = insertChatLifecycleEventRow({
        deviceId,
        chatJid,
        eventType: 'auto_claimed',
        actorUserId: actor.id,
        actorName: actor.display_name,
        targetUserId: actor.id,
        targetName: actor.display_name,
        createdAt: nowIso,
        createdAtMs: nowMs,
      });
      return {assignment, lifecycleEvent: buildLifecycleWsPayload(assignment, event)};
    }

    return {assignment: existing, lifecycleEvent: null};
  });
}

export interface BulkLifecycleItem {
  device_id: string;
  chat_jid: string;
  cached_title?: string;
}

export function bulkChatLifecycle(
  actor: PublicUser,
  itemsRaw: unknown,
  actionRaw: unknown,
  options?: {assignedUserId?: number | null; note?: string; reason?: string},
): {
  succeeded: Array<{assignment: ChatAssignmentInfo; wsPayload?: ChatLifecycleWsPayload}>;
  failed: Array<{device_id: string; chat_jid: string; code: string; message: string}>;
} {
  const action = typeof actionRaw === 'string' ? actionRaw.trim() : '';
  if (action !== 'close' && action !== 'release' && action !== 'assign' && action !== 'reopen') {
    throw new GowaError(400, 'VALIDATION_ERROR', 'الإجراء الجماعي المطلوب غير صالح');
  }

  if (action === 'close' || action === 'reopen') {
    if (!hasPermission(actor, 'chats', 'close')) {
      throw new GowaError(403, 'FORBIDDEN', 'ليس لديك صلاحية إغلاق أو إعادة فتح المحادثات');
    }
  } else if (!hasPermission(actor, 'chats', 'assign')) {
    throw new GowaError(403, 'FORBIDDEN', 'ليس لديك صلاحية تعيين أو تحرير المحادثات');
  }

  if (!Array.isArray(itemsRaw) || itemsRaw.length === 0) {
    throw new GowaError(400, 'VALIDATION_ERROR', 'يرجى تحديد محادثة واحدة على الأقل');
  }
  if (itemsRaw.length > 100) {
    throw new GowaError(400, 'VALIDATION_ERROR', 'الحد الأقصى للإجراء الجماعي هو 100 محادثة في المرة الواحدة');
  }

  const deduped: BulkLifecycleItem[] = [];
  const seen = new Set<string>();
  for (const rawItem of itemsRaw) {
    if (typeof rawItem !== 'object' || rawItem === null) continue;
    const itemObj = rawItem as {device_id?: unknown; chat_jid?: unknown; cached_title?: unknown};
    const dev = typeof itemObj.device_id === 'string' ? itemObj.device_id.trim() : '';
    const jid = typeof itemObj.chat_jid === 'string' ? itemObj.chat_jid.trim() : '';
    if (!dev || !jid) continue;
    const key = `${dev}::${jid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({
      device_id: dev,
      chat_jid: jid,
      cached_title: typeof itemObj.cached_title === 'string' ? itemObj.cached_title : undefined,
    });
  }

  if (deduped.length === 0) {
    throw new GowaError(400, 'VALIDATION_ERROR', 'لم يتم العثور على محادثات صالحة للتنفيذ');
  }

  const succeeded: Array<{assignment: ChatAssignmentInfo; wsPayload?: ChatLifecycleWsPayload}> = [];
  const failed: Array<{device_id: string; chat_jid: string; code: string; message: string}> = [];

  for (const item of deduped) {
    try {
      let res: {assignment: ChatAssignmentInfo; event?: ChatLifecycleEvent};
      if (action === 'close') {
        res = closeChat(actor, item.device_id, item.chat_jid, {
          reason: options?.reason,
          cachedTitle: item.cached_title,
        });
      } else if (action === 'release') {
        res = releaseChat(actor, item.device_id, item.chat_jid, {
          note: options?.note,
          cachedTitle: item.cached_title,
        });
      } else if (action === 'reopen') {
        res = reopenChat(actor, item.device_id, item.chat_jid, {
          note: options?.note,
          cachedTitle: item.cached_title,
        });
      } else {
        const targetId = options?.assignedUserId === undefined ? null : options.assignedUserId;
        res = assignChat(actor, item.device_id, item.chat_jid, targetId, {
          note: options?.note,
          cachedTitle: item.cached_title,
        });
      }
      succeeded.push({
        assignment: res.assignment,
        wsPayload: res.event ? buildLifecycleWsPayload(res.assignment, res.event) : undefined,
      });
    } catch (err) {
      if (err instanceof GowaError) {
        failed.push({
          device_id: item.device_id,
          chat_jid: item.chat_jid,
          code: err.code,
          message: err.message,
        });
      } else {
        failed.push({
          device_id: item.device_id,
          chat_jid: item.chat_jid,
          code: 'INTERNAL_ERROR',
          message: 'تعذر تنفيذ الإجراء لهذه المحادثة',
        });
      }
    }
  }

  return {succeeded, failed};
}
