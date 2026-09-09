'use strict';

const crypto = require('crypto');
const express = require('express');
const config = require('../config');
const { createInboundDedupe } = require('../webhook/inboundDedupe');
const diagnostics = require('../webhook/diagnostics');

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
 * Normalize inbound Cloud API message to text + optional interactive reply id
 * and optional catalog product selection (inquiry / order).
 * @returns {{from:string,text:string,replyId:string|null,productRetailerId:string|null,catalogId:string|null}|null}
 */
function extractInboundMessage(message) {
  if (!message || !message.from) return null;

  if (message.type === 'text') {
    const text = message.text && message.text.body;
    if (text == null) return null;
    const referred =
      message.context && message.context.referred_product
        ? message.context.referred_product
        : null;
    return {
      from: message.from,
      text: String(text),
      replyId: null,
      productRetailerId:
        referred && referred.product_retailer_id != null
          ? String(referred.product_retailer_id)
          : null,
      catalogId:
        referred && referred.catalog_id != null
          ? String(referred.catalog_id)
          : null,
    };
  }

  if (message.type === 'interactive') {
    const interactive = message.interactive || {};
    const reply =
      interactive.button_reply || interactive.list_reply || null;
    if (!reply) return null;
    const replyId = reply.id != null ? String(reply.id) : null;
    const text = reply.title != null ? String(reply.title) : '';
    if (!replyId && !text) return null;
    return {
      from: message.from,
      text,
      replyId,
      productRetailerId: null,
      catalogId: null,
    };
  }

  // Cart / order from catalog (customer added products and sent order).
  if (message.type === 'order') {
    const order = message.order || {};
    const items = Array.isArray(order.product_items) ? order.product_items : [];
    const first = items.find((item) => item && item.product_retailer_id);
    if (!first) return null;
    return {
      from: message.from,
      text: order.text != null ? String(order.text) : '',
      replyId: null,
      productRetailerId: String(first.product_retailer_id),
      catalogId:
        order.catalog_id != null ? String(order.catalog_id) : null,
    };
  }

  return null;
}

/**
 * Standard WhatsApp Cloud API webhook.
 * GET  /webhook — Meta verify handshake
 * POST /webhook — inbound text + interactive button/list replies
 */
function createWebhookRouter({
  engine,
  verifyToken,
  appSecret,
  inboundDedupe,
  requireSignature,
  messageStore,
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
    diagnostics.touchPost();
    if (mustVerify) {
      if (!secret) {
        // eslint-disable-next-line no-console
        console.error(
          '[webhook] WHATSAPP_APP_SECRET required in production; rejecting POST'
        );
        diagnostics.rejectNoSecret();
        return res.sendStatus(503);
      }
      const signature = req.get('x-hub-signature-256');
      const rawBody = req.rawBody;
      if (!verifyWhatsAppSignature(rawBody, signature, secret)) {
        // eslint-disable-next-line no-console
        console.error(
          '[webhook] signature mismatch — WHATSAPP_APP_SECRET does not match this Meta app'
        );
        diagnostics.rejectSignature();
        return res.sendStatus(403);
      }
    }

    diagnostics.acceptPost();
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
            const inbound = extractInboundMessage(message);
            if (!inbound) continue;
            diagnostics.recordInbound({
              from: inbound.from,
              type: message.type,
            });
            if (messageStore) {
              try {
                await messageStore.append({
                  waNumber: inbound.from,
                  direction: 'in',
                  source: 'customer',
                  text: inbound.replyId
                    ? `${inbound.text}${inbound.text ? ' ' : ''}[${inbound.replyId}]`
                    : inbound.text,
                  replyId: inbound.replyId,
                  wamid: message.id || null,
                });
              } catch (err) {
                // eslint-disable-next-line no-console
                console.error('[webhook] transcript append failed', err.message);
              }
            }
            if (!dedupe.begin(message.id)) continue;
            try {
              await engine.handleInbound(inbound.from, inbound.text, {
                replyId: inbound.replyId,
                productRetailerId: inbound.productRetailerId,
                catalogId: inbound.catalogId,
              });
              diagnostics.recordHandled();
              dedupe.commit(message.id);
            } catch (err) {
              diagnostics.recordHandleError(err);
              if (err && (err.status || err.response)) {
                diagnostics.recordSendError(err);
              }
              dedupe.release(message.id);
              // eslint-disable-next-line no-console
              console.error('[webhook] message processing error', {
                messageId: message.id,
                from: inbound.from,
                message: err && err.message ? err.message : String(err),
                response: err && err.response ? err.response : undefined,
              });
            }
          }
        }
      }
    } catch (err) {
      diagnostics.recordHandleError(err);
      // eslint-disable-next-line no-console
      console.error('[webhook] processing error', err);
    }
  });

  return router;
}

module.exports = {
  createWebhookRouter,
  verifyWhatsAppSignature,
  extractInboundMessage,
};
