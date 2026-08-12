'use strict';

const config = require('../config');

/**
 * Transport abstraction — single outbound surface for the FSM engine.
 * Cloud API Graph /messages is the default implementation (Coexistence number).
 * Tests / alternate transports inject a custom sendMessage.
 */

function messagesUrl() {
  const { graphBaseUrl, apiVersion, phoneNumberId } = config.whatsapp;
  return `${graphBaseUrl}/${apiVersion}/${phoneNumberId}/messages`;
}

/**
 * @param {string} to E.164 WhatsApp number (digits)
 * @param {object} payload Transport-agnostic payload
 * @param {string} [payload.text] Plain text body
 * @param {string} [payload.link] Optional URL to include
 * @param {string} [payload.mediaSlot] Optional media slot id
 * @param {object} [payload.meta] Extra metadata for adapters
 */
async function cloudApiSendMessage(to, payload) {
  const token = config.whatsapp.token;
  const phoneNumberId = config.whatsapp.phoneNumberId;

  if (!token || !phoneNumberId) {
    const err = new Error(
      'WhatsApp Cloud API credentials missing (WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID)'
    );
    err.code = 'WHATSAPP_CONFIG_MISSING';
    throw err;
  }

  const bodyText = [payload.text, payload.link].filter(Boolean).join('\n\n');

  // Only Graph-supported fields — never forward internal slots (e.g. mediaSlot)
  // into the request body; unknown properties cause (#100) Invalid parameter.
  const graphBody = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: String(to).replace(/\D/g, ''),
    type: 'text',
    text: {
      preview_url: Boolean(payload.link),
      body: bodyText || '',
    },
  };

  const res = await fetch(messagesUrl(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(graphBody),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`WhatsApp send failed: ${res.status}`);
    err.status = res.status;
    err.response = data;
    throw err;
  }
  return data;
}

/**
 * Default exportable interface used by the engine.
 * Swap by calling setSendMessage(fn) or constructing the engine with a custom sender.
 */
let activeSender = cloudApiSendMessage;

function setSendMessage(fn) {
  if (typeof fn !== 'function') {
    throw new TypeError('sendMessage must be a function');
  }
  activeSender = fn;
}

function resetSendMessage() {
  activeSender = cloudApiSendMessage;
}

async function sendMessage(to, payload) {
  return activeSender(to, payload || {});
}

/**
 * Optional agent notify hook (webhook URL if configured).
 * Kept separate from customer sendMessage.
 */
async function notifyAgent(event) {
  const url = config.agent.notifyWebhookUrl;
  // Always log locally so handover is observable without CRM wiring
  // eslint-disable-next-line no-console
  console.log('[agent-notify]', JSON.stringify(event));

  if (!url) {
    return { delivered: false, reason: 'no_webhook' };
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...event,
        agentHandoverNumber: config.agent.handoverNumber || null,
      }),
    });
    return { delivered: res.ok, status: res.status };
  } catch (err) {
    return { delivered: false, reason: err.message };
  }
}

module.exports = {
  sendMessage,
  setSendMessage,
  resetSendMessage,
  cloudApiSendMessage,
  notifyAgent,
};
