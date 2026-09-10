'use strict';

const config = require('../config');

/**
 * Cloud API Graph /messages (Coexistence number).
 * Supports text, templates, interactive (reply buttons / lists), and images.
 * Never put internal fields (mediaSlot, meta, mediaBuffer) on Graph bodies.
 */

const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function messagesUrl() {
  const { graphBaseUrl, apiVersion, phoneNumberId } = config.whatsapp;
  return `${graphBaseUrl}/${apiVersion}/${phoneNumberId}/messages`;
}

function mediaUrl() {
  const { graphBaseUrl, apiVersion, phoneNumberId } = config.whatsapp;
  return `${graphBaseUrl}/${apiVersion}/${phoneNumberId}/media`;
}

function normalizeImageMime(mimeType) {
  const mime = String(mimeType || '')
    .trim()
    .toLowerCase()
    .split(';')[0];
  if (mime === 'image/jpg') return 'image/jpeg';
  return mime;
}

function assertImagePayload({ mimeType, byteLength }) {
  const mime = normalizeImageMime(mimeType);
  if (!IMAGE_MIME_TYPES.has(mime)) {
    const err = new Error(
      'Unsupported image type. Use JPEG, PNG, or WebP (WhatsApp image limits).'
    );
    err.code = 'WHATSAPP_MEDIA_TYPE_UNSUPPORTED';
    err.status = 400;
    throw err;
  }
  if (!byteLength || byteLength > MAX_IMAGE_BYTES) {
    const err = new Error('Image must be under 5MB.');
    err.code = 'WHATSAPP_MEDIA_TOO_LARGE';
    err.status = 400;
    throw err;
  }
  return mime;
}

function digitsOnly(to) {
  return String(to || '').replace(/\D/g, '');
}

/** Append link only when it is not already present in the body text. */
function joinTextAndLink(text, link) {
  const body = text != null ? String(text) : '';
  const url = link != null ? String(link).trim() : '';
  if (!url) return body;
  if (body && body.includes(url)) return body;
  return [body, url].filter(Boolean).join('\n\n');
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
  const bodyText = joinTextAndLink(text, link);
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
 * Upload binary media to Graph, return media id for immediate send.
 * @param {{ buffer: Buffer, mimeType: string, filename?: string }} opts
 */
async function uploadMedia({ buffer, mimeType, filename } = {}) {
  const { token } = requireCredentials();
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const mime = assertImagePayload({ mimeType, byteLength: bytes.length });
  const name =
    filename ||
    (mime === 'image/png' ? 'image.png' : mime === 'image/webp' ? 'image.webp' : 'image.jpg');

  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mime);
  form.append('file', new Blob([bytes], { type: mime }), name);

  const res = await fetch(mediaUrl(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const graph = (data && data.error) || {};
    const detail = graph.message ? ` (${graph.message})` : '';
    const err = new Error(`WhatsApp media upload failed: ${res.status}${detail}`);
    err.status = res.status;
    err.code = graph.code != null ? graph.code : null;
    err.response = data;
    throw err;
  }
  const id = data && data.id ? String(data.id) : '';
  if (!id) {
    const err = new Error('WhatsApp media upload returned no id');
    err.code = 'WHATSAPP_MEDIA_ID_MISSING';
    err.response = data;
    throw err;
  }
  return { id, mimeType: mime };
}

async function cloudApiSendImage(to, { mediaId, caption } = {}) {
  requireCredentials();
  if (!mediaId) {
    const err = new Error('image mediaId required');
    err.code = 'WHATSAPP_MEDIA_ID_MISSING';
    throw err;
  }
  const image = { id: String(mediaId) };
  const cap = caption != null ? String(caption).trim() : '';
  if (cap) image.caption = cap.slice(0, 1024);

  return graphPost({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: digitsOnly(to),
    type: 'image',
    image,
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

  if (
    payload.type === 'image' ||
    payload.mediaId ||
    payload.mediaBuffer ||
    payload.imageBase64
  ) {
    let mediaId = payload.mediaId ? String(payload.mediaId) : '';
    if (!mediaId) {
      let buffer = payload.mediaBuffer;
      if (!buffer && payload.imageBase64) {
        buffer = Buffer.from(String(payload.imageBase64), 'base64');
      }
      const uploaded = await uploadMedia({
        buffer,
        mimeType: payload.mimeType || payload.mediaMimeType,
        filename: payload.filename,
      });
      mediaId = uploaded.id;
    }
    const caption = joinTextAndLink(payload.text, payload.link) || payload.caption || '';
    return cloudApiSendImage(toDigits, { mediaId, caption });
  }

  const bodyText = joinTextAndLink(payload.text, payload.link);

  return graphPost({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: toDigits,
    type: 'text',
    text: {
      preview_url: Boolean(payload.link) || /https?:\/\//i.test(bodyText),
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
    const graph = (data && data.error) || {};
    const detail = graph.message ? ` (${graph.message})` : '';
    const err = new Error(`WhatsApp Graph GET failed: ${res.status}${detail}`);
    err.status = res.status;
    err.code = graph.code != null ? graph.code : null;
    err.response = data;
    throw err;
  }
  return data;
}

/**
 * Download media bytes for an inbound WhatsApp media id.
 * GET /{media-id} → temporary URL, then GET URL with Bearer token.
 */
async function downloadMedia(mediaId) {
  const { token } = requireCredentials();
  const id = String(mediaId || '').trim();
  if (!id) {
    const err = new Error('media id required');
    err.code = 'WHATSAPP_MEDIA_ID_MISSING';
    throw err;
  }
  const meta = await graphGet(id);
  const url = meta && meta.url ? String(meta.url) : '';
  if (!url) {
    const err = new Error('WhatsApp media metadata missing url');
    err.code = 'WHATSAPP_MEDIA_URL_MISSING';
    err.response = meta;
    throw err;
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const err = new Error(`WhatsApp media download failed: ${res.status}`);
    err.status = res.status;
    err.code = 'WHATSAPP_MEDIA_DOWNLOAD_FAILED';
    throw err;
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  return {
    buffer,
    mimeType: meta.mime_type || null,
    fileSize: meta.file_size != null ? Number(meta.file_size) : buffer.length,
    sha256: meta.sha256 || null,
  };
}

/**
 * Low-level Graph POST to an arbitrary path (not only /messages).
 * @param {string} path e.g. "{phoneNumberId}/whatsapp_commerce_settings"
 * @param {object|null} body JSON body (null → query-only POST)
 * @param {Record<string,string|boolean|number>} [query]
 */
async function graphPostPath(path, body = null, query = {}) {
  const { token } = requireCredentials();
  const { graphBaseUrl, apiVersion } = config.whatsapp;
  const url = new URL(`${graphBaseUrl}/${apiVersion}/${path}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value == null) continue;
    url.searchParams.set(key, String(value));
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body != null ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const graph = (data && data.error) || {};
    const detail = graph.message ? ` (${graph.message})` : '';
    const err = new Error(`WhatsApp Graph POST failed: ${res.status}${detail}`);
    err.status = res.status;
    err.code = graph.code != null ? graph.code : null;
    err.response = data;
    throw err;
  }
  return data;
}

/**
 * Read catalog/cart visibility for this business phone number.
 */
async function getCommerceSettings() {
  const { phoneNumberId } = requireCredentials();
  const data = await graphGet(`${phoneNumberId}/whatsapp_commerce_settings`);
  const row =
    data && Array.isArray(data.data) && data.data.length ? data.data[0] : null;
  return {
    is_catalog_visible: Boolean(row && row.is_catalog_visible),
    is_cart_enabled: row && row.is_cart_enabled != null ? Boolean(row.is_cart_enabled) : null,
    id: row && row.id != null ? String(row.id) : null,
    linked: Boolean(row),
    raw: data,
  };
}

/**
 * List catalogs currently connected to the WhatsApp Business Account.
 */
async function listWabaProductCatalogs() {
  const wabaId = config.whatsapp.wabaId;
  if (!wabaId) {
    const err = new Error('WHATSAPP_WABA_ID missing');
    err.code = 'WABA_ID_MISSING';
    throw err;
  }
  const data = await graphGet(`${wabaId}/product_catalogs`, 'id,name');
  const rows = Array.isArray(data && data.data) ? data.data : [];
  return rows.map((row) => ({
    id: row.id != null ? String(row.id) : null,
    name: row.name != null ? String(row.name) : null,
  }));
}

/**
 * Connect WHATSAPP_CATALOG_ID to the WABA (idempotent when already linked).
 */
async function ensureCatalogLinkedToWaba() {
  const wabaId = config.whatsapp.wabaId;
  const catalogId = config.whatsapp.catalogId;
  if (!wabaId) {
    const err = new Error('WHATSAPP_WABA_ID missing — cannot link catalog via API');
    err.code = 'WABA_ID_MISSING';
    throw err;
  }
  if (!catalogId) {
    const err = new Error('WHATSAPP_CATALOG_ID missing');
    err.code = 'CATALOG_ID_MISSING';
    throw err;
  }

  let existing = [];
  try {
    existing = await listWabaProductCatalogs();
  } catch (_) {
    existing = [];
  }
  if (existing.some((c) => c.id === String(catalogId))) {
    return { linked: true, already: true, catalogs: existing };
  }

  await graphPostPath(`${wabaId}/product_catalogs`, { catalog_id: String(catalogId) });
  const catalogs = await listWabaProductCatalogs().catch(() => existing);
  return { linked: true, already: false, catalogs };
}

/**
 * Show the linked catalog on this WhatsApp number (required for View catalog).
 * Only toggles catalog visibility — leave cart settings to WhatsApp Manager.
 */
async function ensureCatalogVisible() {
  const { phoneNumberId } = requireCredentials();
  await graphPostPath(`${phoneNumberId}/whatsapp_commerce_settings`, null, {
    is_catalog_visible: true,
  });
  return getCommerceSettings();
}

/**
 * Digits-only business display number for https://wa.me/c/{digits} catalog links.
 */
async function getBusinessCatalogLink() {
  const { phoneNumberId } = requireCredentials();
  const phone = await graphGet(
    phoneNumberId,
    'display_phone_number,verified_name'
  );
  const digits = String(phone.display_phone_number || '').replace(/\D/g, '');
  if (!digits) {
    const err = new Error('Could not resolve display_phone_number for catalog link');
    err.code = 'CATALOG_LINK_PHONE_MISSING';
    throw err;
  }
  return {
    url: `https://wa.me/c/${digits}`,
    digits,
    display_phone_number: phone.display_phone_number || null,
    verified_name: phone.verified_name || null,
  };
}

/**
 * Phone numbers on this WABA — used to confirm Cloud API number matches.
 */
async function listWabaPhoneNumbers() {
  const wabaId = config.whatsapp.wabaId;
  if (!wabaId) {
    const err = new Error('WHATSAPP_WABA_ID missing');
    err.code = 'WABA_ID_MISSING';
    throw err;
  }
  const data = await graphGet(
    `${wabaId}/phone_numbers`,
    'id,display_phone_number,verified_name'
  );
  const rows = Array.isArray(data && data.data) ? data.data : [];
  return rows.map((row) => ({
    id: row.id != null ? String(row.id) : null,
    display_phone_number:
      row.display_phone_number != null ? String(row.display_phone_number) : null,
    verified_name: row.verified_name != null ? String(row.verified_name) : null,
  }));
}

/**
 * Link catalog to WABA (when possible) then make it visible on the phone number.
 * Catalog may already be linked in WhatsApp Manager; API link needs Manage catalogue.
 */
async function prepareCatalogForMessaging() {
  const result = {
    link: null,
    linkError: null,
    commerce: null,
    commerceError: null,
    phones: [],
    phonesError: null,
    phoneMatchesConfig: null,
  };

  try {
    result.phones = await listWabaPhoneNumbers();
    const configured = String(config.whatsapp.phoneNumberId || '');
    result.phoneMatchesConfig = result.phones.some((p) => p.id === configured);
  } catch (err) {
    result.phonesError = err && err.message ? String(err.message) : String(err);
  }

  try {
    result.link = await ensureCatalogLinkedToWaba();
  } catch (err) {
    result.linkError = err && err.message ? String(err.message) : String(err);
    result.linkResponse = err && err.response ? err.response : undefined;
    // If Meta says Manage catalogue is required, catalogue is often already
    // linked in WhatsApp Manager — still try visibility + catalog_message.
  }

  try {
    result.commerce = await ensureCatalogVisible();
  } catch (err) {
    result.commerceError = err && err.message ? String(err.message) : String(err);
    result.commerceResponse = err && err.response ? err.response : undefined;
    // Fall back to GET so /health still shows current visibility when POST fails.
    try {
      result.commerce = await getCommerceSettings();
      result.commerceError = result.commerceError
        ? `${result.commerceError} (GET after POST failed)`
        : null;
    } catch (_) {
      // keep POST error
    }
  }
  return result;
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
  cloudApiSendImage,
  uploadMedia,
  downloadMedia,
  buildInteractiveGraph,
  joinTextAndLink,
  graphGet,
  graphPostPath,
  getCommerceSettings,
  getBusinessCatalogLink,
  listWabaProductCatalogs,
  listWabaPhoneNumbers,
  ensureCatalogLinkedToWaba,
  ensureCatalogVisible,
  prepareCatalogForMessaging,
  notifyAgent,
  IMAGE_MIME_TYPES,
  MAX_IMAGE_BYTES,
};
