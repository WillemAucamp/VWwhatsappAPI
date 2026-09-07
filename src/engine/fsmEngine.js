'use strict';

const config = require('../config');
const { STATES, ENTRY_STATE } = require('../fsm/states');
const { createEmptySession } = require('../session/store');
const {
  buildOutboundText,
  buildInteractiveFromState,
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

/**
 * Prefer interactive reply id (button/list), then free-text optionLabels.
 * When a reply id is present but not valid for the current state (stale button
 * from an earlier question), do NOT fall back to title matching — Melrose
 * reuses "Yes"/"No" titles across states, so a stale employment Yes would
 * otherwise match FINAL_CONSENT's consent_yes and skip real consent.
 * @param {object} state
 * @param {string} normalized
 * @param {string|null|undefined} replyId
 */
function resolveOptionKey(state, normalized, replyId) {
  if (replyId != null && replyId !== '') {
    if (
      state &&
      state.options &&
      Object.prototype.hasOwnProperty.call(state.options, replyId)
    ) {
      return String(replyId);
    }
    return null;
  }
  return matchOption(state, normalized);
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

    // A successful follow-up re-delivers the open question — clear any
    // pendingQuestionOutbound left by a crash between persist and Graph send.
    if (session.pendingQuestionOutbound) {
      session.pendingQuestionOutbound = null;
      await this.sessionStore.set(session.waNumber, session);
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

    // Snapshot for non-terminal rollback if Graph send fails after we pre-persist.
    const prevSnapshot = {
      currentState: session.currentState,
      path: Array.isArray(session.path) ? session.path.slice() : [],
      invalidAttempts: session.invalidAttempts,
      status: session.status,
      interruptedFrom: session.interruptedFrom,
      lastBotMessageAt: session.lastBotMessageAt,
      lastFollowUpAt: session.lastFollowUpAt,
      followUpCount: session.followUpCount,
      followUpsExhausted: session.followUpsExhausted,
      pendingQuestionOutbound: session.pendingQuestionOutbound
        ? { ...session.pendingQuestionOutbound }
        : null,
    };

    session.currentState = stateId;
    session.path = Array.isArray(session.path) ? session.path.slice() : [];
    session.path.push(stateId);
    session.invalidAttempts = 0;
    session.status = 'active';
    session.updatedAt = this._now();

    if (fromInterrupt) {
      session.interruptedFrom = fromInterrupt;
    }

    if (state.terminal) {
      this._clearFollowUp(session);
      // A prior non-terminal pendingQuestionOutbound is no longer relevant once
      // we finalize to soft_closed/quiet.
      session.pendingQuestionOutbound = null;
      // Persist soft_closed/quiet + pendingLead BEFORE Graph send.
      // Webhook already returned 200, so a crash (or deploy) after a successful
      // SEND_LINK/HANDOVER Graph call would otherwise leave disk on the prior
      // active state with no pendingLead — quiet self-serve users never inbound
      // again and the qualification lead is gone forever.
      // Mark pendingTerminalOutbound until Graph confirms delivery so scheduler /
      // next inbound can retry if send fails or the clear-set never runs.
      session.pendingTerminalOutbound = {
        stateId: state.id,
        promptKey: state.promptKey,
      };
      await this._finalizeTerminal(session, state);

      let sendError = null;
      try {
        await this._send(session.waNumber, state.promptKey, state);
      } catch (err) {
        sendError = err;
        // eslint-disable-next-line no-console
        console.error(
          '[fsm] terminal outbound send failed; terminal state already persisted',
          { stateId, waNumber: session.waNumber, message: err.message }
        );
      }

      if (!sendError) {
        session.pendingTerminalOutbound = null;
        try {
          await this.sessionStore.set(session.waNumber, session);
        } catch (setErr) {
          // Lead/handover outcome is already durable; leave pendingTerminalOutbound
          // for scheduler retry (possible duplicate WhatsApp body). Do not throw —
          // Meta would redeliver and send again.
          // eslint-disable-next-line no-console
          console.error(
            '[fsm] failed to clear pendingTerminalOutbound after successful send',
            {
              stateId,
              waNumber: session.waNumber,
              message:
                setErr && setErr.message ? setErr.message : String(setErr),
            }
          );
        }
      }

      if (sendError) throw sendError;
      return { session, state };
    }

    // Non-terminal: persist BEFORE Graph send. Webhook already returned 200 to
    // Meta, so a successful send + failed sessionStore.set leaves the customer
    // reading the new question while disk still has the previous state — the
    // next interactive tap is then rejected as a stale reply id / invalid.
    // Mark pendingQuestionOutbound until Graph confirms delivery so a crash
    // between persist and send cannot leave Meta redelivering the prior answer
    // against the new state (invalidAttempts → false HUMAN_HANDOVER).
    this._armWaitingFollowUp(session);
    session.pendingQuestionOutbound = {
      stateId: state.id,
      promptKey: state.promptKey,
    };
    await this.sessionStore.set(session.waNumber, session);
    try {
      await this._send(session.waNumber, state.promptKey, state);
    } catch (err) {
      session.currentState = prevSnapshot.currentState;
      session.path = prevSnapshot.path;
      session.invalidAttempts = prevSnapshot.invalidAttempts;
      session.status = prevSnapshot.status;
      session.interruptedFrom = prevSnapshot.interruptedFrom;
      session.lastBotMessageAt = prevSnapshot.lastBotMessageAt;
      session.lastFollowUpAt = prevSnapshot.lastFollowUpAt;
      session.followUpCount = prevSnapshot.followUpCount;
      session.followUpsExhausted = prevSnapshot.followUpsExhausted;
      session.pendingQuestionOutbound = prevSnapshot.pendingQuestionOutbound;
      await this.sessionStore.set(session.waNumber, session);
      throw err;
    }

    session.pendingQuestionOutbound = null;
    try {
      await this.sessionStore.set(session.waNumber, session);
    } catch (setErr) {
      // Question was delivered; leave pendingQuestionOutbound for retry
      // (possible duplicate WhatsApp body). Do not throw — Meta would
      // redeliver the prior answer and escalate via invalidAttempts.
      // eslint-disable-next-line no-console
      console.error(
        '[fsm] failed to clear pendingQuestionOutbound after successful send',
        {
          stateId,
          waNumber: session.waNumber,
          message:
            setErr && setErr.message ? setErr.message : String(setErr),
        }
      );
    }

    return { session, state };
  }

  /**
   * Re-send a non-terminal prompt that was persisted before Graph confirmed
   * delivery. Does not advance the funnel or count as an answer.
   */
  async _retryQuestionOutbound(session) {
    const pending = session.pendingQuestionOutbound;
    const stateId =
      (pending && pending.stateId) || session.currentState;
    const state = STATES[stateId];
    if (!state || state.terminal) {
      session.pendingQuestionOutbound = null;
      await this.sessionStore.set(session.waNumber, session);
      return { session, retried: false, reason: 'no_question_state' };
    }

    const promptKey =
      (pending && pending.promptKey) || state.promptKey;

    try {
      await this._send(session.waNumber, promptKey, state);
    } catch (err) {
      // Leave pendingQuestionOutbound set so a later inbound/tick can try again.
      // eslint-disable-next-line no-console
      console.error(
        '[fsm] question outbound retry failed; keeping pendingQuestionOutbound',
        {
          stateId,
          waNumber: session.waNumber,
          message: err && err.message ? err.message : String(err),
        }
      );
      throw err;
    }

    session.pendingQuestionOutbound = null;
    this._armWaitingFollowUp(session);
    session.updatedAt = this._now();
    await this.sessionStore.set(session.waNumber, session);
    return { session, state, resentQuestion: true };
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
   * Attempt pendingLead flush; return the error instead of throwing so callers
   * can still retry pendingTerminalOutbound when CRM is down.
   * @returns {Error|null}
   */
  async _tryFlushPendingLead(session) {
    if (!session || !session.pendingLead) return null;
    try {
      await this._flushPendingLead(session);
      return null;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        '[fsm] pendingLead flush failed; continuing with terminal retry if needed',
        {
          waNumber: session.waNumber,
          message: err && err.message ? err.message : String(err),
        }
      );
      return err instanceof Error ? err : new Error(String(err));
    }
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

  /**
   * Background / scheduler entry: re-send a non-terminal WhatsApp question that
   * was persisted before Graph confirmed delivery. Crash/deploy between
   * persist-before-send and the Graph call leaves disk on the new state with
   * no delivered prompt; recovery cannot depend on treating Meta redeliveries
   * of the prior answer as input (that burns invalidAttempts → handover).
   */
  async retryPendingQuestionOutbound(waNumber) {
    return this._withSessionLock(waNumber, async () => {
      const session = await this.sessionStore.get(waNumber);
      if (!session || !session.pendingQuestionOutbound) {
        return { retried: false, reason: 'none_pending' };
      }
      return this._retryQuestionOutbound(session);
    });
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

    return this._repromptCurrent(session, state, { invalid: true });
  }

  /**
   * Re-send the current question (optional invalid hint) without advancing.
   * Used for free-text invalids and for stale interactive reply ids.
   */
  async _repromptCurrent(session, state, flags = {}) {
    const hints = listValidOptionHints(state);
    const reprompt = resolveCopy('invalid_input_reprompt', {
      stubMarker: this.stubMarker,
    });
    const hintLine = hints.length ? hints.join(' | ') : '';
    const extra = [reprompt, hintLine].filter(Boolean).join('\n');

    await this._send(session.waNumber, state.promptKey, state, extra);
    this._armWaitingFollowUp(session);
    await this.sessionStore.set(session.waNumber, session);
    return { session, state, ...flags };
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
    session.pendingLead = null;
    session.pendingTerminalOutbound = null;
    session.pendingQuestionOutbound = null;
    session.lastLoggedLeadKey = null;
    this._clearFollowUp(session);

    if (notice || footer) {
      await this.sendMessage(session.waNumber, {
        text: [notice, footer].filter(Boolean).join('\n\n'),
        meta: { stateId: null, promptKey: 'session_restart_notice' },
      });
    }

    return this._enterState(session, ENTRY_STATE);
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
      // CRM flush must not block terminal WhatsApp retry — Graph may be healthy
      // while logLead is still failing. Never _restart while pendingLead remains
      // (restart clears the only durable copy of the qualification).
      const flushErr = await this._tryFlushPendingLead(session);
      if (session.pendingTerminalOutbound) {
        return this._retryTerminalOutbound(session);
      }
      if (session.pendingLead) {
        if (flushErr) throw flushErr;
        return { session, quiet: true, pendingLead: true };
      }
      if (flushErr) throw flushErr;
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
      const flushErr = await this._tryFlushPendingLead(session);
      if (session.pendingTerminalOutbound) {
        return this._retryTerminalOutbound(session);
      }
      if (session.pendingLead) {
        if (flushErr) throw flushErr;
        return { session, softClosed: true, pendingLead: true };
      }
      if (flushErr) throw flushErr;
      return this._restart(session);
    }

    if (session.pendingQuestionOutbound) {
      // Help / opt-out / stop must win over question-retry. Otherwise a crash
      // between persist-before-send and Graph delivery (pending left set) plus
      // a Graph outage makes every "stop" throw on retry — the quiet/handover
      // persist from _enterState never runs, follow-ups keep firing, and the
      // customer cannot opt out until Graph recovers.
      // Also honor a stale GREETING Opt-Out tap (reply id `opt_out`): WhatsApp
      // users often re-tap the earlier menu button, and title-only matching
      // still missed `opt-out` / `unsubscribe` before those keywords were added.
      const optOutReply =
        replyId != null && String(replyId).toLowerCase() === 'opt_out';
      if (
        optOutReply ||
        matchesKeywordList(normalized, config.fsm.helpIntentKeywords)
      ) {
        session.pendingQuestionOutbound = null;
        return this._routeToHuman(session, session.currentState);
      }
      return this._retryQuestionOutbound(session);
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
      if (session.pendingTerminalOutbound) {
        return this._retryTerminalOutbound(session);
      }
      if (state.quiet) {
        session.status = 'quiet';
        await this.sessionStore.set(waNumber, session);
        return { session, quiet: true };
      }
      session.status = 'soft_closed';
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
      // Stale interactive reply (chat-history Yes/No from an earlier state):
      // resolveOptionKey already refused title fallback so we do not skip
      // consent — but counting it as invalid burns the default
      // maxInvalidAttempts=1 budget. Two stale taps (or a typo + one stale
      // tap at FINAL_CONSENT) falsely quieted customers into HUMAN_HANDOVER
      // and logged a fake human_requested lead. Free-text mistakes still
      // go through _handleInvalid.
      if (replyId != null && replyId !== '') {
        return this._repromptCurrent(session, state, { staleReply: true });
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
};
