'use strict';

const config = require('../config');

/**
 * Cloud API Graph /messages (Coexistence number).
 * Supports text, templates, and interactive (reply buttons / lists).
 * Never put internal fields (mediaSlot, meta) on Graph bodies.
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
    const graph = (data && data.error) || {};
    const code = graph.code != null ? graph.code : null;
    const graphMsg = graph.message ? String(graph.message) : '';
    let hint = '';
    if (res.status === 401 || code === 190) {
      hint =
        ' — WHATSAPP_TOKEN is invalid or expired. Create a new token (prefer a permanent system-user token) in Meta Developer → WhatsApp → API Setup, paste it into Render env, and redeploy.';
    } else if (code === 100 || code === 33) {
      hint =
        ' — Check WHATSAPP_PHONE_NUMBER_ID matches the number on this Meta app.';
    }
    const detail = [graphMsg, code != null ? `code ${code}` : '']
      .filter(Boolean)
      .join(' · ');
    const err = new Error(
      `WhatsApp send failed: ${res.status}${detail ? ` (${detail})` : ''}${hint}`
    );
    err.status = res.status;
    err.code = code;
    err.response = data;
    throw err;
  }
  return data;
}

/**
 * @param {object} interactive Spec from buildInteractiveFromState
 * @param {string} bodyText
 */
function buildInteractiveGraph(interactive, bodyText) {
  if (!interactive || !interactive.type) {
    const err = new Error('interactive.type required');
    err.code = 'WHATSAPP_INTERACTIVE_INVALID';
    throw err;
  }

  if (interactive.type === 'button') {
    const buttons = (interactive.buttons || []).slice(0, 3).map((b) => ({
      type: 'reply',
      reply: {
        id: String(b.id),
        title: String(b.title || b.id).slice(0, 20),
      },
    }));
    if (!buttons.length) {
      const err = new Error('interactive buttons required');
      err.code = 'WHATSAPP_INTERACTIVE_INVALID';
      throw err;
    }
    const payload = {
      type: 'button',
      body: { text: bodyText || ' ' },
      action: { buttons },
    };
    if (interactive.header) {
      payload.header = {
        type: 'text',
        text: String(interactive.header).slice(0, 60),
      };
    }
    if (interactive.footer) {
      payload.footer = { text: String(interactive.footer).slice(0, 60) };
    }
    return payload;
  }

  if (interactive.type === 'list') {
    const sections = (interactive.sections || []).map((section) => ({
      title: section.title ? String(section.title).slice(0, 24) : undefined,
      rows: (section.rows || []).map((row) => ({
        id: String(row.id),
        title: String(row.title || row.id).slice(0, 24),
        description: row.description
          ? String(row.description).slice(0, 72)
          : undefined,
      })),
    }));
    const payload = {
      type: 'list',
      body: { text: bodyText || ' ' },
      action: {
        button: String(interactive.button || 'View options').slice(0, 20),
        sections,
      },
    };
    if (interactive.header) {
      payload.header = {
        type: 'text',
        text: String(interactive.header).slice(0, 60),
      };
    }
    if (interactive.footer) {
      payload.footer = { text: String(interactive.footer).slice(0, 60) };
    }
    return payload;
  }

  // Multi-product message — live Meta Commerce catalog browse.
  if (interactive.type === 'product_list') {
    const catalogId = interactive.catalogId || interactive.catalog_id;
    if (!catalogId) {
      const err = new Error('product_list requires catalogId');
      err.code = 'WHATSAPP_INTERACTIVE_INVALID';
      throw err;
    }
    const sections = (interactive.sections || []).map((section) => ({
      title: section.title ? String(section.title).slice(0, 24) : undefined,
      product_items: (section.product_items || section.productItems || []).map(
        (item) => ({
          product_retailer_id: String(
            item.product_retailer_id || item.productRetailerId || item
          ),
        })
      ),
    }));
    const totalItems = sections.reduce(
      (n, s) => n + (s.product_items ? s.product_items.length : 0),
      0
    );
    if (!totalItems) {
      const err = new Error('product_list requires product_items');
      err.code = 'WHATSAPP_INTERACTIVE_INVALID';
      throw err;
    }
    const payload = {
      type: 'product_list',
      header: {
        type: 'text',
        text: String(interactive.header || 'Our cars').slice(0, 60),
      },
      body: { text: bodyText || ' ' },
      action: {
        catalog_id: String(catalogId),
        sections,
      },
    };
    if (interactive.footer) {
      payload.footer = { text: String(interactive.footer).slice(0, 60) };
    }
    return payload;
  }

  // Opens the WABA-linked Meta catalog inside WhatsApp (View catalog).
  if (interactive.type === 'catalog_message') {
    const payload = {
      type: 'catalog_message',
      body: { text: bodyText || ' ' },
      action: {
        name: 'catalog_message',
      },
    };
    const thumb =
      interactive.thumbnailProductRetailerId ||
      interactive.thumbnail_product_retailer_id;
    if (thumb) {
      payload.action.parameters = {
        thumbnail_product_retailer_id: String(thumb),
      };
    }
    if (interactive.footer) {
      payload.footer = { text: String(interactive.footer).slice(0, 60) };
    }
    return payload;
  }

  const err = new Error(`Unsupported interactive type: ${interactive.type}`);
  err.code = 'WHATSAPP_INTERACTIVE_INVALID';
  throw err;
}

async function cloudApiSendInteractive(to, { text, link, interactive } = {}) {
  requireCredentials();
  const bodyText = [text, link].filter(Boolean).join('\n\n');
  const interactivePayload = buildInteractiveGraph(interactive, bodyText);

  return graphPost({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: digitsOnly(to),
    type: 'interactive',
    interactive: interactivePayload,
  });
}

/**
 * @param {string} to E.164 WhatsApp number (digits)
 * @param {object} payload Transport-agnostic payload
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

  if (
    payload.interactive ||
    payload.type === 'interactive'
  ) {
    return cloudApiSendInteractive(toDigits, {
      text: payload.text,
      link: payload.link,
      interactive: payload.interactive,
    });
  }

  const bodyText = [payload.text, payload.link].filter(Boolean).join('\n\n');

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
  cloudApiSendInteractive,
  buildInteractiveGraph,
  graphGet,
  notifyAgent,
};
