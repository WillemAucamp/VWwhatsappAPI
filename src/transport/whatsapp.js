'use strict';

const config = require('../config');

/**
 * Cloud API Graph /messages (Coexistence number).
 * Tests inject a custom sendMessage; never put internal fields (mediaSlot) on Graph bodies.
 */

function messagesUrl() {
  const { graphBaseUrl, apiVersion, phoneNumberId } = config.whatsapp;
  return `${graphBaseUrl}/${apiVersion}/${phoneNumberId}/messages`;
}

function digitsOnly(to) {
  return String(to || '').replace(/\D/g, '');
}

function requireCredentials() {
  const token = config.whatsapp.token;
  const phoneNumberId = config.whatsapp.phoneNumberId;
  if (!token || !phoneNumberId) {
    const err = new Error(
      'WhatsApp Cloud API credentials missing (WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID)'
    );
    err.code = 'WHATSAPP_CONFIG_MISSING';
    throw err;
  }
  return { token, phoneNumberId };
}

async function graphPost(graphBody) {
  const { token } = requireCredentials();
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
 * @param {string} to E.164 WhatsApp number (digits)
 * @param {object} payload Transport-agnostic payload
 * @param {string} [payload.text] Plain text body
 * @param {string} [payload.link] Optional URL to include
 * @param {string} [payload.mediaSlot] Internal only — never sent to Graph
 * @param {string} [payload.templateName] If set, send an approved template instead of text
 * @param {string} [payload.templateLanguage]
 * @param {Array}  [payload.templateComponents]
 * @param {object} [payload.meta]
 */
async function cloudApiSendMessage(to, payload = {}) {
  requireCredentials();
  const toDigits = digitsOnly(to);

  if (payload.templateName || payload.type === 'template') {
    return cloudApiSendTemplate(toDigits, {
      name: payload.templateName || payload.template,
      language: payload.templateLanguage || payload.language || 'en_US',
      components: payload.templateComponents || payload.components,
    });
  }

  const bodyText = [payload.text, payload.link].filter(Boolean).join('\n\n');

  // Only Graph-supported fields — never forward internal slots (e.g. mediaSlot)
  return graphPost({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: toDigits,
    type: 'text',
    text: {
      preview_url: Boolean(payload.link),
      body: bodyText || '',
    },
  });
}

/**
 * Send an approved message template (required outside the 24h customer-care window).
 */
async function cloudApiSendTemplate(to, { name, language = 'en_US', components } = {}) {
  requireCredentials();
  if (!name) {
    const err = new Error('template name required');
    err.code = 'WHATSAPP_TEMPLATE_NAME_MISSING';
    throw err;
  }

  const template = {
    name,
    language: { code: language },
  };
  if (Array.isArray(components) && components.length) {
    template.components = components;
  }

  return graphPost({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: digitsOnly(to),
    type: 'template',
    template,
  });
}

async function graphGet(path, fields) {
  const { token } = requireCredentials();
  const { graphBaseUrl, apiVersion } = config.whatsapp;
  const url = new URL(`${graphBaseUrl}/${apiVersion}/${path}`);
  if (fields) url.searchParams.set('fields', fields);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`WhatsApp Graph GET failed: ${res.status}`);
    err.status = res.status;
    err.response = data;
    throw err;
  }
  return data;
}

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

async function notifyAgent(event) {
  const url = config.agent.notifyWebhookUrl;
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
  cloudApiSendTemplate,
  graphGet,
  notifyAgent,
};
