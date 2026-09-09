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
  const allKeys = Object.keys(state.options);
  if (!allKeys.length) return null;

  // Prefer explicit interactiveOptions (keeps extra options text-matchable
  // without forcing a WhatsApp list message when >3 keys exist).
  const keys =
    Array.isArray(state.interactiveOptions) && state.interactiveOptions.length
      ? state.interactiveOptions.filter((k) =>
          Object.prototype.hasOwnProperty.call(state.options, k)
        )
      : allKeys;
  if (!keys.length) return null;

  const rows = keys.map((key) => {
    const titled =
      state.optionTitles && state.optionTitles[key]
        ? state.optionTitles[key]
        : null;
    const labels = state.optionLabels && state.optionLabels[key];
    const fallback =
      Array.isArray(labels) && labels.length ? labels[0] : key;
    const description =
      state.optionDescriptions && state.optionDescriptions[key]
        ? String(state.optionDescriptions[key]).slice(0, 72)
        : undefined;
    return {
      id: String(key),
      title: truncateTitle(titled || fallback),
      description,
    };
  });

  const headerText =
    state.interactiveHeader != null
      ? String(state.interactiveHeader).slice(0, 60)
      : null;

  if (rows.length <= REPLY_BUTTON_MAX) {
    return {
      type: 'button',
      header: headerText || undefined,
      buttons: rows.map((r) => ({ id: r.id, title: r.title })),
    };
  }

  return {
    type: 'list',
    header: headerText || undefined,
    button: state.listButtonTitle
      ? String(state.listButtonTitle).slice(0, 20)
      : 'View options',
    sections: [
      {
        title: state.listSectionTitle
          ? String(state.listSectionTitle).slice(0, 24)
          : 'Options',
        rows: rows.map((r) => ({
          id: r.id,
          title: truncateTitle(r.title, 24),
          description: r.description,
        })),
      },
    ],
  };
}

/**
 * Follow-up action menus (not FSM state options).
 * reply ids: fu_continue | fu_human_handover | fu_opt_out
 */
const FOLLOW_UP_MENU = {
  choice: {
    kind: 'choice',
    promptKey: 'follow_up_choice',
    options: {
      fu_human_handover: true,
      fu_opt_out: true,
      fu_continue: true,
    },
    optionTitles: {
      fu_human_handover: 'Human-Handover',
      fu_opt_out: 'Opt-out',
      fu_continue: 'Continue chat',
    },
    optionLabels: {
      fu_human_handover: [
        'human-handover',
        'human handover',
        'handover',
        'human',
        'agent',
        'fu_human_handover',
      ],
      fu_opt_out: [
        'opt-out',
        'opt out',
        'optout',
        'unsubscribe',
        'fu_opt_out',
      ],
      fu_continue: [
        'continue chat',
        'continue',
        'yes',
        'resume',
        'fu_continue',
      ],
    },
  },
  final: {
    kind: 'final',
    promptKey: 'follow_up_final',
    options: {
      fu_continue: true,
      fu_opt_out: true,
    },
    optionTitles: {
      fu_continue: 'Continue chat',
      fu_opt_out: 'Opt-out',
    },
    optionLabels: {
      fu_continue: [
        'continue chat',
        'continue',
        'yes',
        'opt in',
        'opt-in',
        'optin',
        'resume',
        'fu_continue',
      ],
      fu_opt_out: [
        'opt-out',
        'opt out',
        'optout',
        'unsubscribe',
        'fu_opt_out',
      ],
    },
  },
};

function followUpMenuSpec(kind) {
  if (kind === 'choice' || kind === 'final') return FOLLOW_UP_MENU[kind];
  return null;
}

function buildFollowUpMenuInteractive(kind) {
  const spec = followUpMenuSpec(kind);
  if (!spec) return null;
  return buildInteractiveFromState({
    options: spec.options,
    optionTitles: spec.optionTitles,
    optionLabels: spec.optionLabels,
    interactiveHeader: 'VW Melrose',
  });
}

/**
 * Resolve a follow-up menu action from button reply id or free text.
 * @returns {'fu_continue'|'fu_human_handover'|'fu_opt_out'|null}
 */
function resolveFollowUpMenuAction(kind, normalized, replyId) {
  const spec = followUpMenuSpec(kind);
  if (!spec) return null;
  if (
    replyId != null &&
    replyId !== '' &&
    Object.prototype.hasOwnProperty.call(spec.options, replyId)
  ) {
    return String(replyId);
  }
  const text = String(normalized || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  if (!text) return null;
  for (const [optionKey, labels] of Object.entries(spec.optionLabels)) {
    const list = Array.isArray(labels) ? labels : [labels];
    for (const label of list) {
      if (
        String(label || '')
          .trim()
          .toLowerCase()
          .replace(/\s+/g, ' ') === text
      ) {
        return optionKey;
      }
    }
  }
  return null;
}

module.exports = {
  resolveCopy,
  applyPlaceholders,
  buildOutboundText,
  listValidOptionHints,
  buildInteractiveFromState,
  buildFollowUpMenuInteractive,
  resolveFollowUpMenuAction,
  followUpMenuSpec,
  FOLLOW_UP_MENU,
  BUTTON_TITLE_MAX,
  REPLY_BUTTON_MAX,
};
