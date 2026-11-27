import type {Router} from 'express';
import {createApiRouter} from '../middleware/auth.ts';
import type {GowaWsBridge} from '../ws-bridge.ts';
import {registerInboxChatRoutes} from './inbox-chats.ts';
import {registerInboxListRoutes} from './inbox-lists.ts';
import {registerInboxMediaRoutes} from './inbox-media.ts';
import {registerInboxMessageRoutes} from './inbox-messages.ts';
import {registerInboxNoteRoutes} from './inbox-notes.ts';
import {registerInboxScheduleRoutes} from './inbox-schedules.ts';

export function registerUnifiedInboxRoutes(wsBridge: GowaWsBridge): Router {
  const router = createApiRouter();
  registerInboxChatRoutes(router, wsBridge);
  registerInboxMessageRoutes(router, wsBridge);
  registerInboxNoteRoutes(router, wsBridge);
  registerInboxScheduleRoutes(router, wsBridge);
  registerInboxMediaRoutes(router);
  registerInboxListRoutes(router);
  return router;
}
