'use strict';

const { STATES } = require('../fsm/states');
const { resolveCopy } = require('../content/resolve');
const config = require('../config');

const AUTO_LABEL_ORDER = [
  'Unqualified',
  'No License',
  'Bad Credit',
  'App-Link sent',
];

const EXIT_REASON_LABEL = {
  not_ready_income_employment: 'Unqualified',
  employed_no: 'Unqualified',
  income_under_5k: 'Unqualified',
  no_license: 'No License',
  credit_bad: 'Bad Credit',
  qualified_self_serve: 'App-Link sent',
};

const BOT_COPY_LABELS = [
  {
    name: 'Unqualified',
    needles: ["wouldn't be able to move forward just yet"],
  },
  {
    name: 'No License',
    needles: ['license is a must for vehicle finance'],
  },
  {
    name: 'Bad Credit',
    needles: ['quick plan to get your score where it needs to be'],
  },
  {
    name: 'App-Link sent',
    needles: ['click on the link below to see what you qualify for'],
  },
];

function fold(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueNames(names) {
  const seen = new Set();
  const out = [];
  for (const name of names || []) {
    const key = fold(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const canonical =
      AUTO_LABEL_ORDER.find((n) => fold(n) === key) || String(name);
    out.push(canonical);
  }
  return out;
}

function deskLabelForStateId(stateId) {
  const state = stateId ? STATES[stateId] : null;
  return state && state.deskLabel ? String(state.deskLabel) : null;
}

function labelsFromSession(session) {
  if (!session) return [];
  const names = [];
  const reason = session.lastExitReason && EXIT_REASON_LABEL[session.lastExitReason];
  if (reason) names.push(reason);
  for (const id of session.path || []) {
    const label = deskLabelForStateId(id);
    if (label) names.push(label);
  }
  const current = deskLabelForStateId(session.currentState);
  if (current) names.push(current);
  return uniqueNames(names);
}

function textHasNeedle(text, needle) {
  return fold(text).includes(fold(needle));
}

function labelsFromText(text) {
  if (!text) return [];
  const names = [];
  const folded = fold(text);
  for (const row of BOT_COPY_LABELS) {
    if (row.needles.some((needle) => folded.includes(fold(needle)))) {
      names.push(row.name);
    }
  }
  const appLink = fold(config.links.applicationLink);
  if (appLink && folded.includes(appLink) && !names.includes('App-Link sent')) {
    // Application URL in a bot message after consent, not the consent prompt itself.
    if (folded.includes('click on the link below') || folded.includes('what you qualify for')) {
      names.push('App-Link sent');
    }
  }
  return uniqueNames(names);
}

function isBotOutbound(row) {
  if (!row) return false;
  if (row.direction === 'out') return row.source !== 'agent';
  return row.source === 'bot';
}

function isCustomerInbound(row) {
  if (!row) return false;
  if (row.direction === 'in') return true;
  return row.source === 'customer';
}

function isNoAnswer(text) {
  const t = fold(text);
  return t === 'no' || t === 'n' || t === '2' || t === 'employed income no' || t === 'license no';
}

function isBadCreditAnswer(text) {
  const t = fold(text);
  return t === 'bad' || t === 'poor' || t === '2' || t === 'credit bad';
}

function isYesSendAnswer(text) {
  const t = fold(text);
  return (
    t === 'yes' ||
    t === 'y' ||
    t === '1' ||
    t === 'send' ||
    t.includes('yes send it') ||
    t.includes('send it')
  );
}

function promptKindFromBotText(text) {
  const t = fold(text);
  const employed = fold(resolveCopy('employed_income_prompt'));
  const license = fold(resolveCopy('license_check_prompt'));
  const credit = fold(resolveCopy('credit_check_prompt'));
  const consent = fold(resolveCopy('final_consent_prompt'));
  if (employed && t.includes(employed.slice(0, 40))) return 'employed';
  if (license && t.includes("valid driver's license")) return 'license';
  if (credit && t.includes('credit standing')) return 'credit';
  if (consent && t.includes('ready for me to send it')) return 'consent';
  return null;
}

function labelsFromMessages(messages) {
  const names = [];
  let pending = null;
  for (const row of messages || []) {
    const text = row && row.text != null ? String(row.text) : '';
    if (isBotOutbound(row)) {
      names.push(...labelsFromText(text));
      pending = promptKindFromBotText(text) || pending;
      continue;
    }
    if (!isCustomerInbound(row) || !pending) continue;
    if (pending === 'employed' && isNoAnswer(text)) names.push('Unqualified');
    if (pending === 'license' && isNoAnswer(text)) names.push('No License');
    if (pending === 'credit' && isBadCreditAnswer(text)) names.push('Bad Credit');
    if (pending === 'consent' && isYesSendAnswer(text)) names.push('App-Link sent');
    pending = null;
  }
  return uniqueNames(names);
}

function inferDeskLabelNames({ session, messages, lastText } = {}) {
  const names = [
    ...labelsFromSession(session),
    ...labelsFromMessages(messages),
    ...labelsFromText(lastText),
  ];
  return uniqueNames(names);
}

/**
 * Persist inferred funnel labels onto the chat. Additive; staff labels stay.
 */
async function syncInferredDeskLabels(labelStore, waNumber, hints = {}) {
  if (!labelStore || typeof labelStore.addChatLabelByName !== 'function') {
    return { applied: [], names: [] };
  }
  const wa = String(waNumber || '').replace(/\D/g, '');
  if (!wa) return { applied: [], names: [] };
  const names = inferDeskLabelNames(hints);
  const applied = [];
  for (const name of names) {
    try {
      const result = await labelStore.addChatLabelByName(wa, name);
      if (result && result.applied) applied.push(name);
    } catch (_) {
      // Listing chats must not fail because one label write failed.
    }
  }
  return { applied, names };
}

module.exports = {
  AUTO_LABEL_ORDER,
  inferDeskLabelNames,
  labelsFromSession,
  labelsFromMessages,
  labelsFromText,
  syncInferredDeskLabels,
  deskLabelForStateId,
};
