'use strict';

const copy = require('./copy');
const config = require('../config');

/** WhatsApp reply-button title limit */
const BUTTON_TITLE_MAX = 20;
/** Use list message when more options than reply buttons allow */
const REPLY_BUTTON_MAX = 3;

/**
 * Resolve {{COPY.xxx}} and simple link placeholders from content.
 * Blank keys resolve to empty strings (or a visible stub marker in tests).
 */

function resolveCopy(key, { stubMarker = false } = {}) {
  if (!key) return '';
  if (!Object.prototype.hasOwnProperty.call(copy, key)) {
    return stubMarker ? `{{COPY.${key}}}` : '';
  }
  const value = copy[key];
  if (value == null || value === '') {
    return stubMarker ? `{{COPY.${key}}}` : '';
  }
  return String(value);
}

function applyPlaceholders(template, extras = {}, { stubMarker = false } = {}) {
  if (!template) return '';
  let out = String(template);

  if (!stubMarker) {
    out = out.replace(/\{\{COPY\.([a-zA-Z0-9_]+)\}\}/g, (_, key) =>
      resolveCopy(key, { stubMarker: false })
    );
  }

  return out
    .replace(
      /\{\{APPLICATION_LINK\}\}/g,
      extras.applicationLink ?? config.links.applicationLink ?? ''
    )
    .replace(
      /\{\{STOCK_LINK\}\}/g,
      extras.stockLink ?? config.links.stockLink ?? ''
    )
    .replace(
      /\{\{FOOTER\.help\}\}/g,
      resolveCopy('help_footer', { stubMarker })
    );
}

function buildOutboundText(
  promptKey,
  { includeFooter = true, stubMarker = false, extras = {} } = {}
) {
  const body = resolveCopy(promptKey, { stubMarker });
  const footer = includeFooter
    ? resolveCopy('help_footer', { stubMarker })
    : '';
  const parts = [body, footer].filter((p) => p !== '' && p != null);
  const joined = parts.join(parts.length > 1 ? '\n\n' : '');
  return applyPlaceholders(joined, extras, { stubMarker });
}

function listValidOptionHints(state) {
  if (!state || !state.optionLabels) return [];
  return Object.entries(state.optionLabels).map(([key, labels]) => {
    if (state.optionTitles && state.optionTitles[key]) {
      return state.optionTitles[key];
    }
    const primary = Array.isArray(labels) && labels.length ? labels[0] : key;
    return primary;
  });
}

function truncateTitle(title, max = BUTTON_TITLE_MAX) {
  const t = String(title || '').trim();
  if (!t) return 'Option';
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

/**
 * Build Cloud API interactive action from FSM state options.
 * ≤3 options → reply buttons; more → list message.
 * Reply `id` is always the FSM option key.
 *
 * @returns {null|{type:'button',buttons:Array}|{type:'list',button:string,sections:Array}}
 */
function buildInteractiveFromState(state) {
  if (!state || !state.options) return null;
  const keys = Object.keys(state.options);
  if (!keys.length) return null;

  const rows = keys.map((key) => {
    const titled =
      state.optionTitles && state.optionTitles[key]
        ? state.optionTitles[key]
        : null;
    const labels = state.optionLabels && state.optionLabels[key];
    const fallback =
      Array.isArray(labels) && labels.length ? labels[0] : key;
    return {
      id: String(key),
      title: truncateTitle(titled || fallback),
    };
  });

  if (rows.length <= REPLY_BUTTON_MAX) {
    return {
      type: 'button',
      buttons: rows,
    };
  }

  return {
    type: 'list',
    button: 'Choose',
    sections: [
      {
        title: 'Options',
        rows: rows.map((r) => ({
          id: r.id,
          title: truncateTitle(r.title, 24),
        })),
      },
    ],
  };
}

module.exports = {
  resolveCopy,
  applyPlaceholders,
  buildOutboundText,
  listValidOptionHints,
  buildInteractiveFromState,
  BUTTON_TITLE_MAX,
  REPLY_BUTTON_MAX,
};
