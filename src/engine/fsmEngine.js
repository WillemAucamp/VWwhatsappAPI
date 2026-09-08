'use strict';

const config = require('../config');
const { STATES, ENTRY_STATE } = require('../fsm/states');
const { createEmptySession } = require('../session/store');
const {
  buildOutboundText,
  buildInteractiveFromState,
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

/**
 * Prefer interactive reply id (button/list), then free-text optionLabels.
 * @param {object} state
 * @param {string} normalized
 * @param {string|null|undefined} replyId
 */
function resolveOptionKey(state, normalized, replyId) {
  if (
    replyId != null &&
    replyId !== '' &&
    state &&
    state.options &&
    Object.prototype.hasOwnProperty.call(state.options, replyId)
  ) {
    return String(replyId);
  }
  return matchOption(state, normalized);
}

/**
 * If the inbound matches a main-menu (GREETING) option — e.g. customer tapped
 * Qualify Me on an older greeting after a redeploy wiped the session — return
 * the destination state id. Otherwise null.
 */
function resolveGreetingDestination(normalized, replyId) {
  const greeting = STATES[ENTRY_STATE];
  if (!greeting) return null;
  const optionKey = resolveOptionKey(greeting, normalized, replyId);
  if (!optionKey) return null;
  return greeting.options[optionKey] || null;
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
    /** @type {Set<string>} in-process idempotency for pendingLead flushes */
    this._loggedLeadKeys = new Set();
  }

  _leadKey(record) {
    if (!record) return '';
    const pathKey = Array.isArray(record.path) ? record.path.join('>') : '';
    return `${record.waNumber}|${record.exitReason}|${pathKey}|${record.timestamp}`;
  }

  /**
   * Log a lead at most once per record fingerprint.
   * In-memory _loggedLeadKeys covers same-process retries; session.lastLoggedLeadKey
   * is persisted after a successful log so a failed pendingLead clear + process
   * restart cannot double-write the CRM/log on the next flush.
   */
  async _logLeadOnce(record, session) {
    const key = this._leadKey(record);
    if (!key) {
      await this.leadLogger.logLead(record);
      return true;
    }
    if (session && session.lastLoggedLeadKey === key) return false;
    if (this._loggedLeadKeys.has(key)) {
      if (session) session.lastLoggedLeadKey = key;
      return false;
    }
    await this.leadLogger.logLead(record);
    this._loggedLeadKeys.add(key);
    if (session) session.lastLoggedLeadKey = key;
    if (this._loggedLeadKeys.size > 4096) {
      const oldest = this._loggedLeadKeys.values().next().value;
      this._loggedLeadKeys.delete(oldest);
    }
    return true;
  }

  /**
   * After logLead succeeds, durably record the fingerprint while pendingLead
   * is still set. Then clear pendingLead. If only the clear write fails (or
   * the process dies after this marker), the next flush skips logLead.
   */
  async _persistLoggedLeadAndClearPending(session, record) {
    const key = this._leadKey(record);
    if (key) session.lastLoggedLeadKey = key;
    // Marker write: lastLoggedLeadKey set, pendingLead still present.
    await this.sessionStore.set(session.waNumber, session);
    session.pendingLead = null;
    await this.sessionStore.set(session.waNumber, session);
  }

  /**
   * If logLead succeeded but marker/clear persistence failed, try once more to
   * leave lastLoggedLeadKey on disk so a restart flush will not double-log.
   */
  async _bestEffortPersistLeadLogMarker(session, record) {
    const key = this._leadKey(record);
    if (!key) return;
    if (session.lastLoggedLeadKey !== key && !this._loggedLeadKeys.has(key)) return;
    try {
      session.lastLoggedLeadKey = key;
      session.pendingLead = record;
      await this.sessionStore.set(session.waNumber, session);
    } catch (_) {
      // Disk still broken — pendingLead from the initial terminal persist remains.
    }
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
      const interactive = buildInteractiveFromState(state);
      const followPayload = {
        text: parts.filter(Boolean).join('\n\n'),
        link: linkForState(state),
        meta: {
          type: 'follow_up',
          followUpIndex: session.followUpCount,
          stateId: session.currentState,
          promptKey,
        },
      };
      if (interactive) {
        followPayload.interactive = interactive;
        followPayload.type = 'interactive';
      }
      await this.sendMessage(session.waNumber, followPayload);
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
    const interactive = buildInteractiveFromState(state);

    const payload = {
      text,
      link: linkForState(state),
      mediaSlot: state && state.mediaSlot ? state.mediaSlot : undefined,
      meta: { stateId: state ? state.id : null, promptKey },
    };
    if (interactive) {
      payload.interactive = interactive;
      payload.type = 'interactive';
    }

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
      // Soft_closed/quiet must stick (opt-out / completed qualify), but if Graph
      // never delivered the terminal body the next inbound must retry that send
      // instead of _restart()-ing and discarding the finished path.
      session.pendingTerminalOutbound = sendError
        ? { stateId: state.id, promptKey: state.promptKey }
        : null;
      await this._finalizeTerminal(session, state);
    } else {
      this._armWaitingFollowUp(session);
      await this.sessionStore.set(session.waNumber, session);
    }

    if (sendError) throw sendError;
    return { session, state };
  }

  /**
   * Re-send a terminal prompt that failed after the session was already
   * finalized to soft_closed/quiet. Does not restart the funnel.
   */
  async _retryTerminalOutbound(session) {
    const pending = session.pendingTerminalOutbound;
    const stateId =
      (pending && pending.stateId) || session.currentState;
    const state = STATES[stateId];
    if (!state || !state.terminal) {
      session.pendingTerminalOutbound = null;
      await this.sessionStore.set(session.waNumber, session);
      return { session, retried: false, reason: 'no_terminal_state' };
    }

    const promptKey =
      (pending && pending.promptKey) || state.promptKey;

    try {
      await this._send(session.waNumber, promptKey, state);
    } catch (err) {
      // Leave pendingTerminalOutbound set so a later inbound can try again.
      // eslint-disable-next-line no-console
      console.error(
        '[fsm] terminal outbound retry failed; keeping pendingTerminalOutbound',
        {
          stateId,
          waNumber: session.waNumber,
          message: err && err.message ? err.message : String(err),
        }
      );
      throw err;
    }

    session.pendingTerminalOutbound = null;
    session.updatedAt = this._now();
    await this.sessionStore.set(session.waNumber, session);
    return { session, state, resentTerminal: true };
  }

  async _finalizeTerminal(session, state) {
    const exitReason = state.exitReason;
    session.lastExitReason = exitReason;

    if (state.quiet) {
      session.status = 'quiet';
    } else {
      session.status = 'soft_closed';
    }

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

    // Persist terminal/quiet status WITH pendingLead before logLead.
    // Soft_closed alone then a failed/crashed pendingLead write left disk in
    // soft_closed with nothing to flush — the next inbound _restart()s and
    // the qualification lead is gone forever. Pre-queuing keeps the payload
    // durable even when logLead (or a later clear-set) fails.
    session.pendingLead = record;
    await this.sessionStore.set(session.waNumber, session);

    try {
      await this._logLeadOnce(record, session);
      await this._persistLoggedLeadAndClearPending(session, record);
    } catch (err) {
      // pendingLead remains on disk from the first persist when logLead
      // failed. If logLead succeeded and the marker/clear set failed,
      // best-effort write lastLoggedLeadKey so a restart flush is idempotent.
      await this._bestEffortPersistLeadLogMarker(session, record);
      // eslint-disable-next-line no-console
      console.error(
        '[fsm] lead log or pendingLead clear failed after terminal persist; leaving pendingLead queued',
        {
          waNumber: session.waNumber,
          exitReason,
          message: err && err.message ? err.message : String(err),
        }
      );
    }

    if (state.notifyAgent) {
      try {
        await this.notifyAgent({
          type: 'handover',
          exitReason,
          waNumber: session.waNumber,
          path: session.path,
          interruptedFrom: session.interruptedFrom,
          agentHandoverNumber: config.agent.handoverNumber || null,
          timestamp: record.timestamp,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[fsm] agent notify failed after terminal persist', {
          waNumber: session.waNumber,
          exitReason,
          message: err && err.message ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Write a lead that failed during _finalizeTerminal before soft_closed
   * restart / quiet handling can drop the completed qualification path.
   */
  async _flushPendingLead(session) {
    if (!session || !session.pendingLead) return false;
    const record = session.pendingLead;
    const key = this._leadKey(record);
    // Already logged (marker survived a failed clear or prior flush).
    if (key && session.lastLoggedLeadKey === key) {
      session.pendingLead = null;
      await this.sessionStore.set(session.waNumber, session);
      return true;
    }
    try {
      await this._logLeadOnce(record, session);
      await this._persistLoggedLeadAndClearPending(session, record);
    } catch (err) {
      await this._bestEffortPersistLeadLogMarker(session, record);
      throw err;
    }
    return true;
  }

  /**
   * Background / scheduler entry: flush a queued pendingLead under the
   * per-number lock so CRM recovery does not depend on the customer texting.
   */
  async flushPendingLead(waNumber) {
    return this._withSessionLock(waNumber, async () => {
      const session = await this.sessionStore.get(waNumber);
      if (!session) return false;
      return this._flushPendingLead(session);
    });
  }

  /**
   * Background / scheduler entry: re-send a terminal WhatsApp body that failed
   * after soft_closed/quiet was persisted. Qualified users who are waiting for
   * the application link will not message again — recovery cannot depend on
   * inbound alone.
   */
  async retryPendingTerminalOutbound(waNumber) {
    return this._withSessionLock(waNumber, async () => {
      const session = await this.sessionStore.get(waNumber);
      if (!session || !session.pendingTerminalOutbound) {
        return { retried: false, reason: 'none_pending' };
      }
      return this._retryTerminalOutbound(session);
    });
  }

  async _routeToHuman(session, interruptedFrom) {
    session.interruptedFrom = interruptedFrom || session.currentState;
    return this._enterState(session, 'HUMAN_HANDOVER', {
      fromInterrupt: session.interruptedFrom,
    });
  }

  async _handleInvalid(session, state) {
    // Already on the recovery menu and still off-option → hand over quietly.
    if (state && state.id === 'OFF_MENU_RECOVERY') {
      return this._routeToHuman(session, state.id);
    }

    session.interruptedFrom = state ? state.id : session.currentState;
    session.invalidAttempts = 0;
    return this._enterState(session, 'OFF_MENU_RECOVERY', {
      fromInterrupt: session.interruptedFrom,
    });
  }

  async _restart(session) {
    const notice = resolveCopy('session_restart_notice', {
      stubMarker: this.stubMarker,
    });
    const footer = resolveCopy('help_footer', { stubMarker: this.stubMarker });

    this._resetSessionForFreshStart(session);

    if (notice || footer) {
      await this.sendMessage(session.waNumber, {
        text: [notice, footer].filter(Boolean).join('\n\n'),
        meta: { stateId: null, promptKey: 'session_restart_notice' },
      });
    }

    return this._enterState(session, ENTRY_STATE);
  }

  _resetSessionForFreshStart(session) {
    session.currentState = null;
    session.path = [];
    session.invalidAttempts = 0;
    session.status = 'active';
    session.interruptedFrom = null;
    session.lastExitReason = null;
    session.pendingLead = null;
    session.pendingTerminalOutbound = null;
    session.lastLoggedLeadKey = null;
    session.agentTakenOver = false;
    this._clearFollowUp(session);
  }

  /**
   * Start from a wiped/soft-closed session. Honour main-menu button taps
   * (Qualify Me, See our cars, Opt-Out) so they don't bounce back to GREETING.
   */
  async _beginFromMainMenuIntent(session, normalized, replyId) {
    this._resetSessionForFreshStart(session);
    const destination = resolveGreetingDestination(normalized, replyId);
    if (destination) {
      session.path = [ENTRY_STATE];
      return this._enterState(session, destination);
    }
    return this._enterState(session, ENTRY_STATE);
  }

  /**
   * Staff takeover: bot goes quiet until release / customer restart.
   * @param {{silent?: boolean}} [options] skip optional notice
   */
  async takeOver(waNumber, options = {}) {
    return this._withSessionLock(waNumber, async () => {
      const session = await this.getOrCreateSession(waNumber);
      session.agentTakenOver = true;
      session.status = 'quiet';
      session.updatedAt = this._now();
      this._clearFollowUp(session);
      await this.sessionStore.set(waNumber, session);

      if (!options.silent) {
        const notice = resolveCopy('human_handover_body', {
          stubMarker: this.stubMarker,
        });
        if (notice) {
          try {
            await this.sendMessage(waNumber, {
              text: notice,
              meta: { stateId: 'HUMAN_HANDOVER', source: 'agent_takeover' },
            });
          } catch (err) {
            // Keep takeover even if notice fails.
            // eslint-disable-next-line no-console
            console.error('[fsm] takeover notice send failed', err.message);
          }
        }
      }

      return {
        session: {
          waNumber: session.waNumber,
          status: session.status,
          agentTakenOver: true,
          currentState: session.currentState,
        },
      };
    });
  }

  /**
   * Staff release: clear takeover and restart Melrose greeting for the customer.
   */
  async releaseToBot(waNumber) {
    return this._withSessionLock(waNumber, async () => {
      const session = await this.getOrCreateSession(waNumber);
      session.agentTakenOver = false;
      return this._restart(session);
    });
  }

  async handleInbound(waNumber, text, extras = {}) {
    return this._withSessionLock(waNumber, () =>
      this._handleInboundUnlocked(waNumber, text, extras)
    );
  }

  async _handleInboundUnlocked(waNumber, text, extras = {}) {
    const normalized = normalizeInput(text);
    const replyId =
      extras && extras.replyId != null && extras.replyId !== ''
        ? String(extras.replyId)
        : null;
    let session = await this.getOrCreateSession(waNumber);

    if (session.status === 'quiet') {
      await this._flushPendingLead(session);
      if (session.pendingTerminalOutbound) {
        return this._retryTerminalOutbound(session);
      }
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
      await this._flushPendingLead(session);
      if (session.pendingTerminalOutbound) {
        return this._retryTerminalOutbound(session);
      }
      // Honour Qualify Me / See our cars / Opt-Out taps instead of only
      // re-showing the main menu (common after Render session wipe).
      if (resolveGreetingDestination(normalized, replyId)) {
        return this._beginFromMainMenuIntent(session, normalized, replyId);
      }
      return this._restart(session);
    }

    if (!session.currentState || session.status === 'new') {
      if (matchesKeywordList(normalized, config.fsm.helpIntentKeywords)) {
        session.status = 'active';
        session.path = [];
        return this._routeToHuman(session, null);
      }

      return this._beginFromMainMenuIntent(session, normalized, replyId);
    }

    if (matchesKeywordList(normalized, config.fsm.helpIntentKeywords)) {
      return this._routeToHuman(session, session.currentState);
    }

    const state = STATES[session.currentState];
    if (!state) {
      return this._beginFromMainMenuIntent(session, normalized, replyId);
    }

    if (state.terminal) {
      if (session.pendingTerminalOutbound) {
        return this._retryTerminalOutbound(session);
      }
      if (state.quiet) {
        session.status = 'quiet';
        await this.sessionStore.set(waNumber, session);
        return { session, quiet: true };
      }
      session.status = 'soft_closed';
      if (resolveGreetingDestination(normalized, replyId)) {
        return this._beginFromMainMenuIntent(session, normalized, replyId);
      }
      return this._restart(session);
    }

    const optionKey = resolveOptionKey(state, normalized, replyId);
    if (!optionKey) {
      // Info states with a fixed next: allow any non-help tap/text to continue
      // only when there are no options defined.
      if (
        state.type === 'info' &&
        state.next &&
        (!state.options || !Object.keys(state.options).length)
      ) {
        return this._enterState(session, state.next);
      }
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
  resolveOptionKey,
  resolveGreetingDestination,
};
