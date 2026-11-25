import {createHmac, timingSafeEqual} from 'node:crypto';
import express, {type Router} from 'express';
import {gowaFetch, type GowaDevice} from '../gowa-client.ts';
import {createApiRouter, handleRouteError} from '../middleware/auth.ts';
import {hasPendingChatCloseRating} from '../services/chat-close-rating.ts';
import {handleUpstreamGowaEvent, normalizeWhatsAppJid} from '../services/chat-sync.ts';
import {
  asReactionRecord,
  isGowaReactionEvent,
  readGowaReaction,
  recordMessageReaction,
} from '../services/message-reactions.ts';
import type {GowaWsBridge} from '../ws-bridge.ts';

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
      const incoming = code === 'message' ? asReactionRecord(envelope?.payload) : undefined;
      const chatJid = typeof incoming?.chat_id === 'string' ? normalizeWhatsAppJid(incoming.chat_id) : '';
      const isRatingInboxMessage = incoming?.is_from_me === false && Boolean(chatJid) &&
        hasPendingChatCloseRating(chatJid);
      if (!isReaction && !isRatingInboxMessage) {
        res.sendStatus(204);
        return;
      }
      const change = isReaction ? readGowaReaction(envelope) : undefined;
      const upstreamId = typeof envelope?.device_id === 'string' ? envelope.device_id.trim() : '';
      const sessionId = typeof envelope?.session_id === 'string' ? envelope.session_id.trim() : '';
      if ((!upstreamId && !sessionId) || (isReaction && !change)) {
        res.status(400).json({
          code: isReaction ? 'INVALID_REACTION' : 'INVALID_WEBHOOK_PAYLOAD',
          message: 'Invalid GOWA webhook payload',
        });
        return;
      }

      // GOWA can identify the webhook source by WhatsApp JID while REST uses a slot ID.
      const devices = await gowaFetch<GowaDevice[]>('/devices');
      const jid = normalizeWhatsAppJid(upstreamId);
      const candidates = sessionId
        ? devices.filter((device) => device.id === sessionId)
        : devices.filter((device) =>
          device.id === upstreamId || Boolean(jid && [device.jid, device.phone_number]
            .some((value) => value && normalizeWhatsAppJid(value) === jid)),
        );
      if (candidates.length === 1) {
        const deviceId = candidates[0].id;
        if (change) {
          const event = recordMessageReaction(deviceId, change.chatJid, change.messageId, change.reaction);
          if (event) wsBridge.broadcast(event);
        } else if (hasPendingChatCloseRating(chatJid, deviceId)) {
          handleUpstreamGowaEvent(deviceId, {
            code: 'MESSAGE_RECEIVED', message: '', result: incoming, device_id: deviceId,
          }, (event) => wsBridge.broadcast(event));
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
