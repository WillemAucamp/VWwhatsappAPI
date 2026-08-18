'use strict';

const config = require('../config');
const { STATES, ENTRY_STATE } = require('../fsm/states');
const { createEmptySession } = require('../session/store');
const {
  buildOutboundText,
  listValidOptionHints,
  resolveCopy,
} = require('../content/resolve');
const { buildRecord } = require('../logger/leadLogger');
const transport = require('../transport/whatsapp');

function normalizeInput(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function matchesKeywordList(normalized, keywords) {
  if (!normalized) return false;
  return keywords.some((kw) => {
    const k = String(kw).toLowerCase().trim();
    if (!k) return false;
    if (normalized === k) return true;
    if (k.includes(' ') && normalized.includes(k)) return true;
    if (!k.includes(' ')) {
      const re = new RegExp(`(^|\\s)${escapeRegex(k)}(\\s|$)`, 'i');
      return re.test(normalized);
    }
    return false;
  });
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchOption(state, normalized) {
  if (!state || !state.optionLabels) return null;
  for (const [optionKey, labels] of Object.entries(state.optionLabels)) {
    const list = Array.isArray(labels) ? labels : [labels];
    for (const label of list) {
      if (normalizeInput(label) === normalized) {
        return optionKey;
      }
    }
  }
  return null;
}

function linkForState(state) {
  if (!state || !state.sendLink) return undefined;
  if (state.sendLink === 'application') return config.links.applicationLink || undefined;
  if (state.sendLink === 'stock') return config.links.stockLink || undefined;
  return undefined;
}

/**
 * FSM engine — resolves session, matches help-intent / options, retries, escalates.
 */
class FsmEngine {
  constructor({ sessionStore, leadLogger, sendMessage, notifyAgent, options } = {}) {
    if (!sessionStore) throw new Error('sessionStore required');
    if (!leadLogger) throw new Error('leadLogger required');
    this.sessionStore = sessionStore;
    this.leadLogger = leadLogger;
    this.sendMessage = sendMessage || transport.sendMessage;
    this.notifyAgent = notifyAgent || transport.notifyAgent;
    this.stubMarker = Boolean(options && options.stubMarker);
    this.nowFn = (options && options.nowFn) || (() => Date.now());
    /** @type {Map<string, Promise<void>>} */
    this._sessionChains = new Map();
  }

  _now() {
    return this.nowFn();
  }

  /**
   * Serialize all session mutations per WhatsApp number.
   * Follow-up sends and inbound replies both read-modify-write the same session.
   */
  async _withSessionLock(waNumber, fn) {
    const key = String(waNumber);
    const prev = this._sessionChains.get(key) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const chain = prev.then(
      () => gate,
      () => gate
    );
    this._sessionChains.set(key, chain);

    await prev.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this._sessionChains.get(key) === chain) {
        this._sessionChains.delete(key);
      }
    }
  }

  _armWaitingFollowUp(session) {
    session.lastBotMessageAt = this._now();
    session.lastFollowUpAt = null;
    session.followUpCount = 0;
    session.followUpsExhausted = false;
  }

  _clearFollowUp(session) {
    session.lastBotMessageAt = null;
    session.lastFollowUpAt = null;
    session.followUpCount = 0;
    session.followUpsExhausted = false;
  }

  nextFollowUpDueAt(session, followUpConfig = config.followUp) {
    if (!session || !followUpConfig.enabled) return null;
    if (session.status !== 'active') return null;
    if (!session.currentState || !session.lastBotMessageAt) return null;
    if (session.followUpsExhausted) return null;
    const state = STATES[session.currentState];
    if (!state || state.terminal) return null;

    const max = followUpConfig.maxCount;
    if (session.followUpCount >= max) return null;

    if (session.followUpCount === 0) {
      return session.lastBotMessageAt + followUpConfig.firstDelayMs;
    }
    const anchor = session.lastFollowUpAt || session.lastBotMessageAt;
    return anchor + followUpConfig.intervalMs;
  }

  async processFollowUp(waNumber, now = this._now(), followUpConfig = config.followUp) {
    return this._withSessionLock(waNumber, () =>
      this._processFollowUpUnlocked(waNumber, now, followUpConfig)
    );
  }

  async _processFollowUpUnlocked(
    waNumber,
    now = this._now(),
    followUpConfig = config.followUp
  ) {
    if (!followUpConfig.enabled) return { sent: false, reason: 'disabled' };

    const session = await this.sessionStore.get(waNumber);
    if (!session) return { sent: false, reason: 'no_session' };

    const dueAt = this.nextFollowUpDueAt(session, followUpConfig);
    if (dueAt == null) return { sent: false, reason: 'not_eligible' };
    if (now < dueAt) return { sent: false, reason: 'not_due', dueAt };

    const state = STATES[session.currentState];
    const isFirst = session.followUpCount === 0;
    const promptKey = isFirst ? 'follow_up_first' : 'follow_up_repeat';

    const nudge = resolveCopy(promptKey, { stubMarker: this.stubMarker });
    const footer = resolveCopy('help_footer', { stubMarker: this.stubMarker });
    const parts = [nudge];

    if (followUpConfig.includePrompt && state && state.promptKey) {
      const question = resolveCopy(state.promptKey, { stubMarker: this.stubMarker });
      if (question) parts.push(question);
      if (state.continuePromptKey) {
        const cont = resolveCopy(state.continuePromptKey, {
          stubMarker: this.stubMarker,
        });
        if (cont) parts.push(cont);
      }
    }

    if (footer) parts.push(footer);

    // Persist the follow-up slot before Graph send. Otherwise a successful
    // send + failed sessionStore.set leaves lastFollowUpAt unset and the next
    // scheduler tick re-sends the same nudge.
    const prevCount = session.followUpCount;
    const prevFollowUpAt = session.lastFollowUpAt;
    const prevExhausted = session.followUpsExhausted;

    session.followUpCount += 1;
    session.lastFollowUpAt = now;
    if (session.followUpCount >= followUpConfig.maxCount) {
      session.followUpsExhausted = true;
    }
    await this.sessionStore.set(session.waNumber, session);

    try {
      await this.sendMessage(session.waNumber, {
        text: parts.filter(Boolean).join('\n\n'),
        link: linkForState(state),
        meta: {
          type: 'follow_up',
          followUpIndex: session.followUpCount,
          stateId: session.currentState,
          promptKey,
        },
      });
    } catch (err) {
      session.followUpCount = prevCount;
      session.lastFollowUpAt = prevFollowUpAt;
      session.followUpsExhausted = prevExhausted;
      await this.sessionStore.set(session.waNumber, session);
      throw err;
    }

    if (
      session.followUpsExhausted &&
      followUpConfig.notifyAgentOnExhausted
    ) {
      await this.notifyAgent({
        type: 'follow_up_exhausted',
        waNumber: session.waNumber,
        path: session.path,
        currentState: session.currentState,
        followUpCount: session.followUpCount,
        timestamp: new Date(now).toISOString(),
      });
    }

    return {
      sent: true,
      waNumber: session.waNumber,
      followUpCount: session.followUpCount,
      stateId: session.currentState,
      exhausted: session.followUpsExhausted,
    };
  }

  async getOrCreateSession(waNumber) {
    let session = await this.sessionStore.get(waNumber);
    if (!session) {
      session = createEmptySession(waNumber);
      await this.sessionStore.set(waNumber, session);
    }
    return session;
  }

  async _send(waNumber, promptKey, state, extraText) {
    const body = buildOutboundText(promptKey, {
      includeFooter: true,
      stubMarker: this.stubMarker,
    });
    const continueKey = state && state.continuePromptKey;
    const continueText = continueKey
      ? buildOutboundText(continueKey, {
          includeFooter: false,
          stubMarker: this.stubMarker,
        })
      : '';

    const parts = [body, continueText, extraText].filter(Boolean);
    const text = parts.join('\n\n');

    const payload = {
      text,
      link: linkForState(state),
      mediaSlot: state && state.mediaSlot ? state.mediaSlot : undefined,
      meta: { stateId: state ? state.id : null, promptKey },
    };

    return this.sendMessage(waNumber, payload);
  }

  async _enterState(session, stateId, { fromInterrupt } = {}) {
    const state = STATES[stateId];
    if (!state) throw new Error(`Unknown state: ${stateId}`);

    session.currentState = stateId;
    session.path = Array.isArray(session.path) ? session.path.slice() : [];
    session.path.push(stateId);
    session.invalidAttempts = 0;
    session.status = 'active';
    session.updatedAt = this._now();

    if (fromInterrupt) {
      session.interruptedFrom = fromInterrupt;
    }

    let sendError = null;
    try {
      await this._send(session.waNumber, state.promptKey, state);
    } catch (err) {
      if (!state.terminal) throw err;
      sendError = err;
      // eslint-disable-next-line no-console
      console.error(
        '[fsm] terminal outbound send failed; persisting terminal state anyway',
        { stateId, waNumber: session.waNumber, message: err.message }
      );
    }

    if (state.terminal) {
      this._clearFollowUp(session);
      await this._finalizeTerminal(session, state);
    } else {
      this._armWaitingFollowUp(session);
      await this.sessionStore.set(session.waNumber, session);
    }

    if (sendError) throw sendError;
    return { session, state };
  }

  async _finalizeTerminal(session, state) {
    const exitReason = state.exitReason;
    session.lastExitReason = exitReason;

    if (state.quiet) {
      session.status = 'quiet';
    } else {
      session.status = 'soft_closed';
    }

    // Persist terminal/quiet status BEFORE lead/agent side effects. If set
    // runs after logLead and throws, the customer already got the terminal
    // WhatsApp message + a CRM lead, but the store still says "active" at the
    // prior question — Meta retry / re-answer then double-logs the lead and
    // continues the funnel.
    await this.sessionStore.set(session.waNumber, session);

    const record = buildRecord({
      waNumber: session.waNumber,
      exitReason,
      path: session.path,
      interruptedFrom: session.interruptedFrom,
      meta: {
        quiet: Boolean(state.quiet),
        softDecline: Boolean(state.softDecline),
      },
    });

    await this.leadLogger.logLead(record);

    if (state.notifyAgent) {
      await this.notifyAgent({
        type: 'handover',
        exitReason,
        waNumber: session.waNumber,
        path: session.path,
        interruptedFrom: session.interruptedFrom,
        agentHandoverNumber: config.agent.handoverNumber || null,
        timestamp: record.timestamp,
      });
    }
  }

  async _routeToHuman(session, interruptedFrom) {
    session.interruptedFrom = interruptedFrom || session.currentState;
    return this._enterState(session, 'HUMAN_HANDOVER', {
      fromInterrupt: session.interruptedFrom,
    });
  }

  async _handleInvalid(session, state) {
    const max = config.fsm.maxInvalidAttempts;
    session.invalidAttempts += 1;

    if (session.invalidAttempts > max) {
      return this._routeToHuman(session, state.id);
    }

    const hints = listValidOptionHints(state);
    const reprompt = resolveCopy('invalid_input_reprompt', {
      stubMarker: this.stubMarker,
    });
    const hintLine = hints.length ? hints.join(' | ') : '';
    const extra = [reprompt, hintLine].filter(Boolean).join('\n');

    await this._send(session.waNumber, state.promptKey, state, extra);
    this._armWaitingFollowUp(session);
    await this.sessionStore.set(session.waNumber, session);
    return { session, state, invalid: true };
  }

  async _restart(session) {
    const notice = resolveCopy('session_restart_notice', {
      stubMarker: this.stubMarker,
    });
    const footer = resolveCopy('help_footer', { stubMarker: this.stubMarker });

    session.currentState = null;
    session.path = [];
    session.invalidAttempts = 0;
    session.status = 'active';
    session.interruptedFrom = null;
    session.lastExitReason = null;
    this._clearFollowUp(session);

    if (notice || footer) {
      await this.sendMessage(session.waNumber, {
        text: [notice, footer].filter(Boolean).join('\n\n'),
        meta: { stateId: null, promptKey: 'session_restart_notice' },
      });
    }

    return this._enterState(session, ENTRY_STATE);
  }

  async handleInbound(waNumber, text) {
    return this._withSessionLock(waNumber, () =>
      this._handleInboundUnlocked(waNumber, text)
    );
  }

  async _handleInboundUnlocked(waNumber, text) {
    const normalized = normalizeInput(text);
    let session = await this.getOrCreateSession(waNumber);

    if (session.status === 'quiet') {
      if (matchesKeywordList(normalized, config.fsm.reopenKeywords)) {
        return this._restart(session);
      }
      const quietNotice = resolveCopy('quiet_thread_notice', {
        stubMarker: false,
      });
      if (quietNotice) {
        await this.sendMessage(waNumber, { text: quietNotice, meta: { quiet: true } });
      }
      return { session, quiet: true };
    }

    if (session.status === 'soft_closed') {
      return this._restart(session);
    }

    if (!session.currentState || session.status === 'new') {
      if (matchesKeywordList(normalized, config.fsm.helpIntentKeywords)) {
        session.status = 'active';
        session.path = [];
        return this._routeToHuman(session, null);
      }

      session.status = 'active';
      return this._enterState(session, ENTRY_STATE);
    }

    if (matchesKeywordList(normalized, config.fsm.helpIntentKeywords)) {
      return this._routeToHuman(session, session.currentState);
    }

    const state = STATES[session.currentState];
    if (!state) {
      return this._enterState(session, ENTRY_STATE);
    }

    if (state.terminal) {
      if (state.quiet) {
        session.status = 'quiet';
        await this.sessionStore.set(waNumber, session);
        return { session, quiet: true };
      }
      session.status = 'soft_closed';
      return this._restart(session);
    }

    if (state.type === 'info' && state.next) {
      return this._enterState(session, state.next);
    }

    const optionKey = matchOption(state, normalized);
    if (!optionKey) {
      return this._handleInvalid(session, state);
    }

    const nextId = state.options[optionKey] || state.next;
    if (!nextId) {
      return this._handleInvalid(session, state);
    }

    return this._enterState(session, nextId);
  }
}

module.exports = {
  FsmEngine,
  normalizeInput,
  matchesKeywordList,
  matchOption,
};
