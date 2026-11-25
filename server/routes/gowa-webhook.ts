import {createHmac, timingSafeEqual} from 'node:crypto';
import express, {type Router} from 'express';
import {createApiRouter, handleRouteError} from '../middleware/auth.ts';
import {
  asReactionRecord,
  isGowaReactionEvent,
  readGowaReaction,
  recordMessageReaction,
} from '../services/message-reactions.ts';
import type {GowaWsBridge} from '../ws-bridge.ts';

const MESSAGE_CODES = new Map([
  ['message', 'MESSAGE_RECEIVED'],
  ['message.edited', 'MESSAGE_EDITED'],
  ['message.deleted', 'MESSAGE_REVOKED'],
  ['message.revoked', 'MESSAGE_REVOKED'],
]);

export function registerGowaWebhookRoutes(wsBridge: GowaWsBridge): Router {
  const router = createApiRouter();
  const secret = process.env.GOWA_WEBHOOK_SECRET?.trim();
  if (!secret) return router;

  router.post('/api/webhooks/gowa', express.raw({type: 'application/json', limit: '64kb'}), async (req, res) => {
    const signature = /^sha256=([\da-f]{64})$/i.exec(req.get('X-Hub-Signature-256') ?? '');
    if (!Buffer.isBuffer(req.body) || !signature ||
        !timingSafeEqual(Buffer.from(signature[1], 'hex'), createHmac('sha256', secret).update(req.body).digest())) {
      res.status(401).json({code: 'INVALID_SIGNATURE', message: 'Invalid webhook signature'});
      return;
    }

    try {
      const envelope = asReactionRecord(JSON.parse(req.body.toString('utf8')));
      const code = typeof envelope?.event === 'string' ? envelope.event : '';
      const isReaction = isGowaReactionEvent(code);
      const messageCode = MESSAGE_CODES.get(code);
      if (!isReaction && !messageCode) {
        res.sendStatus(204);
        return;
      }
      const change = isReaction ? readGowaReaction(envelope) : undefined;
      const payload = asReactionRecord(envelope?.payload);
      const upstreamId = typeof envelope?.device_id === 'string' ? envelope.device_id.trim() : '';
      const sessionId = typeof envelope?.session_id === 'string' ? envelope.session_id.trim() : '';
      if ((!upstreamId && !sessionId) || (isReaction && !change) || (messageCode && !payload)) {
        res.status(400).json({
          code: isReaction ? 'INVALID_REACTION' : 'INVALID_WEBHOOK_PAYLOAD',
          message: 'Invalid GOWA webhook payload',
        });
        return;
      }

      const deviceId = await wsBridge.resolveWebhookDevice(upstreamId, sessionId);
      if (deviceId) {
        if (change) {
          const event = recordMessageReaction(deviceId, change.chatJid, change.messageId, change.reaction);
          if (event) wsBridge.broadcast(event);
        } else if (messageCode) {
          wsBridge.relayScopedEvent(deviceId, {code: messageCode, message: '', result: payload});
        }
      }
      res.sendStatus(204);
    } catch (error) {
      if (error instanceof SyntaxError) {
        res.status(400).json({code: 'INVALID_JSON', message: 'Invalid webhook JSON'});
        return;
      }
      handleRouteError(res, error);
    }
  });

  return router;
}
