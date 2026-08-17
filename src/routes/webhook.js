'use strict';

const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const { createInboundDedupe } = require('../webhook/inboundDedupe');

/**
 * Verify Meta X-Hub-Signature-256 against the raw request body.
 * @param {Buffer} rawBody
 * @param {string|undefined} signatureHeader
 * @param {string} appSecret
 */
function verifyWhatsAppSignature(rawBody, signatureHeader, appSecret) {
  if (!appSecret || !rawBody || !signatureHeader) return false;
  const expected =
    'sha256=' +
    crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const left = Buffer.from(signatureHeader);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * Standard WhatsApp Cloud API webhook.
 * GET  /webhook — Meta verify handshake
 * POST /webhook — inbound customer text (statuses / echoes ignored)
 */
function createWebhookRouter({
  engine,
  verifyToken,
  appSecret,
  inboundDedupe,
  requireSignature,
} = {}) {
  const router = express.Router();
  const token = verifyToken || config.whatsapp.verifyToken;
  const secret =
    appSecret !== undefined ? appSecret : config.whatsapp.appSecret;
  const mustVerify =
    requireSignature !== undefined
      ? Boolean(requireSignature)
      : Boolean(secret) || config.nodeEnv === 'production';
  const dedupe = inboundDedupe || createInboundDedupe();

  router.get('/', (req, res) => {
    const mode = req.query['hub.mode'];
    const challenge = req.query['hub.challenge'];
    const hubToken = req.query['hub.verify_token'];

    if (mode === 'subscribe' && hubToken === token) {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  });

  router.post('/', async (req, res) => {
    if (mustVerify) {
      if (!secret) {
        // eslint-disable-next-line no-console
        console.error(
          '[webhook] WHATSAPP_APP_SECRET required in production; rejecting POST'
        );
        return res.sendStatus(503);
      }
      const signature = req.get('x-hub-signature-256');
      const rawBody = req.rawBody;
      if (!verifyWhatsAppSignature(rawBody, signature, secret)) {
        return res.sendStatus(403);
      }
    }

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
            // begin/commit/release: do not mark wamid done until handleInbound
            // succeeds — otherwise a Graph/session failure + Meta retry drops
            // the customer message forever.
            if (!dedupe.begin(message.id)) continue;
            try {
              await engine.handleInbound(from, text);
              dedupe.commit(message.id);
            } catch (err) {
              dedupe.release(message.id);
              // eslint-disable-next-line no-console
              console.error('[webhook] message processing error', {
                messageId: message.id,
                from,
                message: err && err.message ? err.message : String(err),
              });
            }
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

module.exports = { createWebhookRouter, verifyWhatsAppSignature };
