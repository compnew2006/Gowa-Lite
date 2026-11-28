import type {Router} from 'express';
import {
  createConversationNote,
  deleteConversationNote,
  getConversationNoteById,
  listConversationNotes,
  updateConversationNote,
} from '../db.ts';
import {
  handleRouteError,
  requireAnyPermission,
  requireAuth,
  requireDeviceParamAccess,
  requirePermission,
} from '../middleware/auth.ts';
import {hasPermission, isAdminSubject} from '../rbac.ts';
import {decodeRouteParam} from '../security.ts';
import {recordChatActionEvent} from '../db/lifecycle-repo.ts';
import {assertChatContentAccess, getChatContentAccessState} from '../services/chat-lifecycle.ts';
import type {AuthedRequest} from '../types.ts';
import {
  conversationNoteCreateSchema,
  conversationNotePatchSchema,
  parsePositiveIntId,
  parseSchema,
} from '../validation/schemas.ts';
import type {GowaWsBridge} from '../ws-bridge.ts';

export function registerInboxNoteRoutes(router: Router, wsBridge: GowaWsBridge): void {
  router.get(
    '/api/unified/chats/:deviceId/:jid/notes',
    requireAuth,
    requirePermission('notes', 'read'),
    requireDeviceParamAccess,
    (req: AuthedRequest, res) => {
      const deviceId = decodeRouteParam(req.params.deviceId);
      const chatJid = decodeRouteParam(req.params.jid);
      try {
        const access = getChatContentAccessState(req.user!, deviceId, chatJid);
        if (!access.allowed) {
          res.json({
            code: 'SUCCESS',
            message: 'ok',
            results: {
              notes: [],
              total: 0,
              content_redacted: true,
              redaction_reason: access.reason,
            },
          });
          return;
        }
        const notes = listConversationNotes(deviceId, chatJid);
        res.json({
          code: 'SUCCESS',
          message: 'ok',
          results: {notes, total: notes.length},
        });
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.post(
    '/api/unified/chats/:deviceId/:jid/notes',
    requireAuth,
    requirePermission('notes', 'write'),
    requireDeviceParamAccess,
    (req: AuthedRequest, res) => {
      try {
        const deviceId = decodeRouteParam(req.params.deviceId);
        const chatJid = decodeRouteParam(req.params.jid);
        assertChatContentAccess(req.user!, deviceId, chatJid);
        const parsed = parseSchema(conversationNoteCreateSchema, req.body ?? {});
        const note = createConversationNote({
          deviceId,
          chatJid,
          createdById: req.user!.id,
          createdByName: req.user!.display_name,
          content: parsed.content,
          isPinned: parsed.is_pinned === true,
        });
        // P2-11: the add shows as a system line in the chat timeline
        // (recorded server-side, with a short excerpt of the note text).
        recordChatActionEvent({
          deviceId,
          chatJid,
          eventType: 'note_added',
          actorUserId: req.user!.id,
          actorName: req.user!.display_name,
          note: parsed.content.slice(0, 200),
        });
        wsBridge.broadcast({
          code: 'CONVERSATION_NOTE_UPDATED',
          message: 'created',
          device_id: deviceId,
          result: {chat_jid: chatJid, note_id: note.id},
        });
        res.status(201).json({code: 'SUCCESS', message: 'تمت إضافة الملاحظة', results: note});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.patch(
    '/api/unified/chats/:deviceId/:jid/notes/:noteId',
    requireAuth,
    requirePermission('notes', 'write'),
    requireDeviceParamAccess,
    (req: AuthedRequest, res) => {
      try {
        const deviceId = decodeRouteParam(req.params.deviceId);
        const chatJid = decodeRouteParam(req.params.jid);
        assertChatContentAccess(req.user!, deviceId, chatJid);
        const noteId = parsePositiveIntId(req.params.noteId, 'معرّف الملاحظة');

        const existing = getConversationNoteById(noteId, deviceId, chatJid);
        if (!existing) {
          res.status(404).json({code: 'NOT_FOUND', message: 'الملاحظة غير موجودة'});
          return;
        }

        const parsed = parseSchema(conversationNotePatchSchema, req.body ?? {});
        const hasContent = parsed.content !== undefined;
        const hasPin = typeof parsed.is_pinned === 'boolean';

        const canModerateNotes =
          isAdminSubject(req.user!) || hasPermission(req.user!, 'notes', 'delete');
        if (hasContent && existing.created_by_id !== req.user!.id && !canModerateNotes) {
          res.status(403).json({code: 'FORBIDDEN', message: 'يمكنك تعديل ملاحظاتك فقط'});
          return;
        }

        const updated = updateConversationNote(noteId, deviceId, chatJid, {
          content: parsed.content,
          is_pinned: hasPin ? Boolean(parsed.is_pinned) : undefined,
        });
        // P2-11: a content change shows as a system line. A pin-only
        // toggle is not a content edit — it records nothing (no noise).
        if (parsed.content !== undefined && parsed.content !== existing.content) {
          recordChatActionEvent({
            deviceId,
            chatJid,
            eventType: 'note_edited',
            actorUserId: req.user!.id,
            actorName: req.user!.display_name,
            note: parsed.content.slice(0, 200),
          });
        }
        wsBridge.broadcast({
          code: 'CONVERSATION_NOTE_UPDATED',
          message: 'updated',
          device_id: deviceId,
          result: {chat_jid: chatJid, note_id: noteId},
        });
        res.json({code: 'SUCCESS', message: 'تم تحديث الملاحظة', results: updated});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );

  router.delete(
    '/api/unified/chats/:deviceId/:jid/notes/:noteId',
    requireAuth,
    requireAnyPermission(['notes:write', 'notes:delete']),
    requireDeviceParamAccess,
    (req: AuthedRequest, res) => {
      try {
        const deviceId = decodeRouteParam(req.params.deviceId);
        const chatJid = decodeRouteParam(req.params.jid);
        assertChatContentAccess(req.user!, deviceId, chatJid);
        const noteId = parsePositiveIntId(req.params.noteId, 'معرّف الملاحظة');

        const existing = getConversationNoteById(noteId, deviceId, chatJid);
        if (!existing) {
          res.status(404).json({code: 'NOT_FOUND', message: 'الملاحظة غير موجودة'});
          return;
        }
        const canDeleteOthers =
          isAdminSubject(req.user!) || hasPermission(req.user!, 'notes', 'delete');
        if (existing.created_by_id !== req.user!.id && !canDeleteOthers) {
          res.status(403).json({code: 'FORBIDDEN', message: 'يمكنك حذف ملاحظاتك فقط'});
          return;
        }

        deleteConversationNote(noteId, deviceId, chatJid);
        // P2-11: the deletion shows as a system line carrying an excerpt
        // of the deleted text, so the removal itself leaves a trace.
        recordChatActionEvent({
          deviceId,
          chatJid,
          eventType: 'note_deleted',
          actorUserId: req.user!.id,
          actorName: req.user!.display_name,
          note: existing.content.slice(0, 200),
        });
        wsBridge.broadcast({
          code: 'CONVERSATION_NOTE_UPDATED',
          message: 'deleted',
          device_id: deviceId,
          result: {chat_jid: chatJid, note_id: noteId},
        });
        res.json({code: 'SUCCESS', message: 'تم حذف الملاحظة'});
      } catch (err) {
        handleRouteError(res, err);
      }
    },
  );
}
