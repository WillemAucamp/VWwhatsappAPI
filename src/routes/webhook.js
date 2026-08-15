'use strict';

const express = require('express');
const config = require('../config');
const { createInboundDedupe } = require('../webhook/inboundDedupe');

/**
 * Standard WhatsApp Cloud API webhook pattern.
 * Coexistence: same Business number; inbound via webhook, outbound via Graph /messages.
 */
function createWebhookRouter({ engine, verifyToken, inboundDedupe } = {}) {
  const router = express.Router();
  const token = verifyToken || config.whatsapp.verifyToken;
  const dedupe = inboundDedupe || createInboundDedupe();

  // Verification handshake (Meta)
  router.get('/', (req, res) => {
    const mode = req.query['hub.mode'];
    const challenge = req.query['hub.challenge'];
    const hubToken = req.query['hub.verify_token'];

    if (mode === 'subscribe' && hubToken === token) {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  });

  // Inbound messages
  router.post('/', async (req, res) => {
    // Acknowledge immediately per WhatsApp webhook best practice
    res.sendStatus(200);

    try {
      const body = req.body;
      if (!body || body.object !== 'whatsapp_business_account') return;

      const entries = body.entry || [];
      for (const entry of entries) {
        const changes = entry.changes || [];
        for (const change of changes) {
          const value = change.value || {};
          const messages = value.messages || [];
          for (const message of messages) {
            if (message.type !== 'text') continue;
            const from = message.from;
            const text = message.text && message.text.body;
            if (!from || text == null) continue;
            // Meta may redeliver the same wamid; skip duplicates.
            if (!dedupe.claim(message.id)) continue;
            await engine.handleInbound(from, text);
          }
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[webhook] processing error', err);
    }
  });

  return router;
}

module.exports = { createWebhookRouter };
