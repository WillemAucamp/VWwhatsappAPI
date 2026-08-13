'use strict';

const copy = require('./copy');
const config = require('../config');

/**
 * Resolve {{COPY.xxx}} and simple link placeholders from stub content.
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

  // Nested {{COPY.*}} inside populated content. Skip when stubMarker is on so
  // already-emitted {{COPY.key}} markers are not wiped back to empty strings.
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
    const primary = Array.isArray(labels) && labels.length ? labels[0] : key;
    return primary;
  });
}

module.exports = {
  resolveCopy,
  applyPlaceholders,
  buildOutboundText,
  listValidOptionHints,
};
