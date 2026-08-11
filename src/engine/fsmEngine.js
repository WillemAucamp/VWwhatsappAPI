'use strict';

const config = require('../config');
const { STATES, ENTRY_STATE } = require('../fsm/states');
const { createEmptySession } = require('../session/store');
const { buildOutboundText, listValidOptionHints, resolveCopy } = require('../content/resolve');
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
    // phrase containment for multi-word intents like "opt out"
    if (k.includes(' ') && normalized.includes(k)) return true;
    // whole-word match for single tokens
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
  /**
   * @param {object} deps
   * @param {object} deps.sessionStore
   * @param {object} deps.leadLogger
   * @param {Function} [deps.sendMessage]
   * @param {Function} [deps.notifyAgent]
   * @param {object} [deps.options]
   * @param {boolean} [deps.options.stubMarker] show {{COPY.x}} when blank (tests)
   */
  constructor({ sessionStore, leadLogger, sendMessage, notifyAgent, options } = {}) {
    if (!sessionStore) throw new Error('sessionStore required');
    if (!leadLogger) throw new Error('leadLogger required');
    this.sessionStore = sessionStore;
    this.leadLogger = leadLogger;
    this.sendMessage = sendMessage || transport.sendMessage;
    this.notifyAgent = notifyAgent || transport.notifyAgent;
    this.stubMarker = Boolean(options && options.stubMarker);
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
    session.path.push(stateId);
    session.invalidAttempts = 0;
    session.status = 'active';
    session.updatedAt = Date.now();

    if (fromInterrupt) {
      session.interruptedFrom = fromInterrupt;
    }

    await this._send(session.waNumber, state.promptKey, state);

    if (state.terminal) {
      await this._finalizeTerminal(session, state);
    }

    await this.sessionStore.set(session.waNumber, session);
    return { session, state };
  }

  async _finalizeTerminal(session, state) {
    const exitReason = state.exitReason;
    session.lastExitReason = exitReason;

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

    if (state.quiet) {
      session.status = 'quiet';
    } else if (state.softDecline) {
      session.status = 'soft_closed';
    } else {
      session.status = 'soft_closed';
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

    // Re-prompt current state options with footer
    await this._send(session.waNumber, state.promptKey, state, extra);
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

    if (notice || footer) {
      await this.sendMessage(session.waNumber, {
        text: [notice, footer].filter(Boolean).join('\n\n'),
        meta: { stateId: null, promptKey: 'session_restart_notice' },
      });
    }

    return this._enterState(session, ENTRY_STATE);
  }

  /**
   * Process one inbound customer message.
   * @param {string} waNumber
   * @param {string} text
   */
  async handleInbound(waNumber, text) {
    const normalized = normalizeInput(text);
    let session = await this.getOrCreateSession(waNumber);

    // Quiet thread (HUMAN_HANDOVER): stay silent unless reopen keyword
    if (session.status === 'quiet') {
      if (matchesKeywordList(normalized, config.fsm.reopenKeywords)) {
        return this._restart(session);
      }
      // Bot stays quiet — optional stub notice only if configured non-empty
      const quietNotice = resolveCopy('quiet_thread_notice', {
        stubMarker: false,
      });
      if (quietNotice) {
        await this.sendMessage(waNumber, { text: quietNotice, meta: { quiet: true } });
      }
      return { session, quiet: true };
    }

    // Soft decline closed: any new message restarts cleanly
    if (session.status === 'soft_closed') {
      return this._restart(session);
    }

    // New / no state → enter GREETING (first message may also be help-intent)
    if (!session.currentState || session.status === 'new') {
      // Universal opt-out even before first state settles
      if (matchesKeywordList(normalized, config.fsm.helpIntentKeywords)) {
        session.status = 'active';
        session.path = [];
        return this._routeToHuman(session, null);
      }

      // First inbound starts the flow (message itself is not matched as a choice)
      session.status = 'active';
      return this._enterState(session, ENTRY_STATE);
    }

    // Universal help / opt-out — before option matching, from any state
    if (matchesKeywordList(normalized, config.fsm.helpIntentKeywords)) {
      return this._routeToHuman(session, session.currentState);
    }

    const state = STATES[session.currentState];
    if (!state) {
      return this._enterState(session, ENTRY_STATE);
    }

    // Terminal should not receive input while active; treat as restart safety net
    if (state.terminal) {
      if (state.quiet) {
        session.status = 'quiet';
        await this.sessionStore.set(waNumber, session);
        return { session, quiet: true };
      }
      session.status = 'soft_closed';
      return this._restart(session);
    }

    // Info states always continue to a fixed next state on any non-help input
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
