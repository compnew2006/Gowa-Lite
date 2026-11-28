import './db/schema.ts';

export {
  closeDatabaseSafely,
  db,
  parseTimestampMs,
  queryAll,
  queryOne,
  withImmediateTransaction,
} from './db/connection.ts';

export {hashPassword, hashPasswordAsync, hashSessionToken, verifyPassword, verifyPasswordAsync} from './db/crypto.ts';

export {seedAndMigrateRbac} from './db/schema.ts';

export {
  authenticateUser,
  authenticateUserAsync,
  bumpUserCacheVersion,
  countActiveAdmins,
  createRole,
  createSession,
  createUser,
  createUserAsync,
  deleteRole,
  deleteSession,
  deleteUser,
  getRoleById,
  getRoleBySlug,
  getSessionUser,
  getUserById,
  getUserCacheVersion,
  getUserPreferences,
  hasActiveSession,
  hasAnyUsers,
  listRoles,
  listUsers,
  setUserPreferences,
  setUserTheme,
  updateRole,
  updateUser,
  updateUserAsync,
  type LanguagePreference,
  type PublicUser,
  type RoleRecord,
  type ThemePreference,
  type UserRole,
} from './db/auth-repo.ts';

export {
  cleanupExpiredRecords,
  deleteCachedAvatars,
  deleteSetting,
  getAccountAliases,
  getCachedAvatar,
  getGowaConfig,
  getSetting,
  listKnownDeviceIds,
  setAccountAlias,
  setGowaConfig,
  setSetting,
  upsertCachedAvatar,
  type CachedAvatarRow,
  type GowaConfig,
} from './db/config-repo.ts';

export {initializeFirstAdmin} from './db/bootstrap-repo.ts';

export {
  clearChatCatchup,
  getCachedMessage,
  getChatsMessagePresenceMap,
  getGroupUnreadSummaryForUser,
  getLastMessagePreviews,
  getUnreadCountsForUser,
  listPendingCatchupChats,
  markCachedMessageRevoked,
  markChatReadForUser,
  markChatUnreadForUser,
  setChatMessagePresence,
  storeMessageReaction,
  syncAndMergeChatMessages,
  syncChatWatermarks,
  upsertCachedMessages,
  type CachedMessagePayload,
  type CachedReactionLike,
  type PendingCatchupChat,
} from './db/messages-repo.ts';

export {
  clearChatHistoryInDb,
  computeMutedUntilMs,
  createChatListForUser,
  createConversationNote,
  deleteChatInDb,
  deleteChatListForUser,
  deleteConversationNote,
  getChatDeviceState,
  getChatDeviceStatesMap,
  getConversationNoteById,
  getUserChatListMemberships,
  getUserChatPreferencesMap,
  getUserMutedChatKeys,
  isChatBlocked,
  listChatListsForUser,
  listConversationNotes,
  normalizeActiveMutedUntil,
  setChatArchiveOverride,
  setChatBlockedState,
  setChatListMembership,
  setChatPinState,
  setUserChatFavourite,
  setUserChatMute,
  updateConversationNote,
  type ChatDeviceState,
  type ChatListSummary,
  type ConversationNote,
  type MuteDuration,
  type UserChatPreference,
} from './db/chat-states-repo.ts';

export {
  getDailyResetSettings,
  listEnabledDailyResets,
  resetAssignedChatsForDevice,
  updateDailyResetSettings,
  type DailyResetResult,
  type DailyResetSettings,
} from './db/daily-reset-repo.ts';

export {
  claimQueuedRating,
  expireChatCloseRatings,
  failRatingPrompt,
  getAccountRatingRows,
  getUserRatingRows,
  hasPendingChatCloseRating,
  hasRecordedRatingReply,
  insertQueuedRating,
  listQueuedRatingEvents,
  listUsersCloseRatingSummaries,
  markRatingPromptSent,
  recordPendingRating,
} from './db/close-rating-repo.ts';

export {
  beginCallRejection,
  completeCallRejection,
  listRecentCallRejections,
  type CallAutoRejectLogEntry,
  type CallRejectStatus,
  type CallReplyStatus,
} from './db/call-reject-repo.ts';
