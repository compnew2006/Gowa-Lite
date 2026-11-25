import {createHmac, timingSafeEqual} from 'node:crypto';
import express, {type Router} from 'express';
import {gowaFetch, type GowaDevice} from '../gowa-client.ts';
import {createApiRouter, handleRouteError} from '../middleware/auth.ts';
import {normalizeWhatsAppJid} from '../services/chat-sync.ts';
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
      if (typeof envelope?.event !== 'string' || !isGowaReactionEvent(envelope.event)) {
        res.sendStatus(204);
        return;
      }
      const change = readGowaReaction(envelope);
      const upstreamId = typeof envelope.device_id === 'string' ? envelope.device_id.trim() : '';
      if (!change || !upstreamId) {
        res.status(400).json({code: 'INVALID_REACTION', message: 'Invalid reaction payload'});
        return;
      }

      // GOWA can identify the webhook source by WhatsApp JID while REST uses a slot ID.
      const devices = await gowaFetch<GowaDevice[]>('/devices');
      const jid = normalizeWhatsAppJid(upstreamId);
      const candidates = devices.filter((device) =>
        device.id === upstreamId || Boolean(jid && [device.jid, device.phone_number]
          .some((value) => value && normalizeWhatsAppJid(value) === jid)),
      );
      if (candidates.length === 1) {
        const event = recordMessageReaction(candidates[0].id, change.chatJid, change.messageId, change.reaction);
        if (event) wsBridge.broadcast(event);
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
