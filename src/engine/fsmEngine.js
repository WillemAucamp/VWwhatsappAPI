'use strict';

const config = require('../config');
const { STATES, ENTRY_STATE } = require('../fsm/states');
const { createEmptySession } = require('../session/store');
const {
  buildOutboundText,
  buildInteractiveFromState,
  resolveCopy,
} = require('../content/resolve');
const {
  listProductsForProductList,
  buildProductListInteractive,
  buildCatalogMessageInteractive,
} = require('../catalog/products');
const { buildRecord } = require('../logger/leadLogger');
const transport = require('../transport/whatsapp');
const diagnostics = require('../webhook/diagnostics');

function normalizeInput(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function matchesKeywordList(normalized, keywords) {
  if (!normalized) return false;
  // Strip punctuation so "Hello!" / "hi," still match reopen words.
  const softened = normalized
    .replace(/[^a-z0-9\s]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const candidates = softened && softened !== normalized
    ? [normalized, softened]
    : [normalized];
  return keywords.some((kw) => {
    const k = String(kw).toLowerCase().trim();
    if (!k) return false;
    return candidates.some((text) => {
      if (text === k) return true;
      if (k.includes(' ') && text.includes(k)) return true;
      if (!k.includes(' ')) {
        const re = new RegExp(`(^|\\s)${escapeRegex(k)}(\\s|$)`, 'i');
        return re.test(text);
      }
      return false;
    });
  });
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchOption(state, normalized) {
  if (!state || !normalized) return null;

  // Exact match on optionTitles (button / list labels customers tap or type).
  if (state.optionTitles) {
    for (const [optionKey, title] of Object.entries(state.optionTitles)) {
      if (normalizeInput(title) === normalized) return optionKey;
    }
  }

  if (!state.optionLabels) return null;
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
 *
 * Also recognises stocklist "Check if I qualify" (`any_car`) so a wiped or
 * soft-closed session does not bounce that tap back to the main menu.
 */
function resolveGreetingDestination(normalized, replyId) {
  const greeting = STATES[ENTRY_STATE];
  if (greeting) {
    const optionKey = resolveOptionKey(greeting, normalized, replyId);
    if (optionKey && greeting.options[optionKey]) {
      return greeting.options[optionKey];
    }
  }

  const stocklist = STATES.STOCKLIST_CAROUSEL;
  if (stocklist) {
    const stockKey = resolveOptionKey(stocklist, normalized, replyId);
    if (stockKey && stocklist.options[stockKey]) {
      return stocklist.options[stockKey];
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
  constructor({
    sessionStore,
    leadLogger,
    sendMessage,
    notifyAgent,
    options,
    labelStore,
  } = {}) {
    if (!sessionStore) throw new Error('sessionStore required');
    if (!leadLogger) throw new Error('leadLogger required');
    this.sessionStore = sessionStore;
    this.leadLogger = leadLogger;
    this.sendMessage = sendMessage || transport.sendMessage;
    this.notifyAgent = notifyAgent || transport.notifyAgent;
    this.labelStore = labelStore || null;
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
    if (session.agentTakenOver) return null;
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
    if (session.agentTakenOver || session.status === 'quiet') {
      return { sent: false, reason: 'agent_held' };
    }

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
    const extras = {};
    const appLink = linkForState(state);
    if (state && state.sendLink === 'application' && appLink) {
      extras.applicationLink = appLink;
    }
    if (state && state.sendLink === 'stock' && appLink) {
      extras.stockLink = appLink;
    }

    // Live Meta catalog for "See our cars":
    // Prefer catalog_message (View catalog) — works with a linked WABA catalog
    // even when the token cannot read Commerce Manager products.
    // Then product_list if product-read works. Stock-link button last.
    if (state && state.catalogProductList && config.whatsapp.catalogId) {
      const body = buildOutboundText(promptKey, {
        includeFooter: true,
        stubMarker: this.stubMarker,
        extras,
      });
      const parts = [body, extraText].filter(Boolean);
      const text = parts.join('\n\n');

      try {
        await transport.prepareCatalogForMessaging();
      } catch (visErr) {
        diagnostics.recordCatalogError(visErr, 'prepare_catalog');
        // eslint-disable-next-line no-console
        console.error('[fsm] prepareCatalogForMessaging failed', {
          message: visErr && visErr.message ? visErr.message : String(visErr),
          response: visErr && visErr.response ? visErr.response : undefined,
        });
      }

      try {
        return await this.sendMessage(waNumber, {
          text,
          type: 'interactive',
          interactive: buildCatalogMessageInteractive(),
          meta: {
            stateId: state.id,
            promptKey,
            catalogId: config.whatsapp.catalogId,
            catalogMode: 'catalog_message',
          },
        });
      } catch (catalogMsgErr) {
        diagnostics.recordCatalogError(catalogMsgErr, 'catalog_message');
        // eslint-disable-next-line no-console
        console.error('[fsm] catalog_message send failed; trying product_list', {
          catalogId: config.whatsapp.catalogId,
          message:
            catalogMsgErr && catalogMsgErr.message
              ? catalogMsgErr.message
              : String(catalogMsgErr),
          response:
            catalogMsgErr && catalogMsgErr.response
              ? catalogMsgErr.response
              : undefined,
        });
      }

      try {
        const products = await listProductsForProductList({
          catalogId: config.whatsapp.catalogId,
        });
        if (products.length) {
          const interactive = buildProductListInteractive({
            catalogId: config.whatsapp.catalogId,
            products,
            header: state.interactiveHeader || 'Our cars',
            sectionTitle: state.catalogSectionTitle || 'Available now',
          });
          try {
            return await this.sendMessage(waNumber, {
              text,
              type: 'interactive',
              interactive,
              meta: {
                stateId: state.id,
                promptKey,
                catalogId: config.whatsapp.catalogId,
                productCount: products.length,
                catalogMode: 'product_list',
              },
            });
          } catch (sendErr) {
            diagnostics.recordCatalogError(sendErr, 'product_list');
            // eslint-disable-next-line no-console
            console.error(
              '[fsm] product_list send failed; falling back to stock link',
              {
                catalogId: config.whatsapp.catalogId,
                productCount: products.length,
                message:
                  sendErr && sendErr.message ? sendErr.message : String(sendErr),
                response: sendErr && sendErr.response ? sendErr.response : undefined,
              }
            );
          }
        } else {
          // eslint-disable-next-line no-console
          console.warn('[fsm] catalog product read empty; falling back to stock link', {
            catalogId: config.whatsapp.catalogId,
          });
        }
      } catch (err) {
        diagnostics.recordCatalogError(err, 'product_read');
        // eslint-disable-next-line no-console
        console.error(
          '[fsm] catalog product read failed; trying catalog link',
          {
            catalogId: config.whatsapp.catalogId,
            message: err && err.message ? err.message : String(err),
            response: err && err.response ? err.response : undefined,
          }
        );
      }

      // Meta catalog link message — wa.me/c/{businessPhone} with preview thumbnails.
      try {
        const catalogLink = await transport.getBusinessCatalogLink();
        const linkBody = buildOutboundText('stocklist_link_body', {
          includeFooter: true,
          stubMarker: this.stubMarker,
          extras,
        });
        // Put the URL only via `link` so Graph sends one preview (not a duplicate).
        const linkText = [linkBody, extraText].filter(Boolean).join('\n\n');
        return await this.sendMessage(waNumber, {
          text: linkText,
          link: catalogLink.url,
          meta: {
            stateId: state.id,
            promptKey: 'stocklist_link_body',
            catalogId: config.whatsapp.catalogId,
            catalogMode: 'catalog_link',
            catalogUrl: catalogLink.url,
          },
        });
      } catch (linkErr) {
        diagnostics.recordCatalogError(linkErr, 'catalog_link');
        // eslint-disable-next-line no-console
        console.error(
          '[fsm] catalog link send failed; falling back to qualify button',
          {
            message: linkErr && linkErr.message ? linkErr.message : String(linkErr),
            response: linkErr && linkErr.response ? linkErr.response : undefined,
          }
        );
      }
    }

    const effectivePromptKey =
      state &&
      state.catalogProductList &&
      state.fallbackPromptKey
        ? state.fallbackPromptKey
        : promptKey;

    const body = buildOutboundText(effectivePromptKey, {
      includeFooter: true,
      stubMarker: this.stubMarker,
      extras,
    });
    const continueKey = state && state.continuePromptKey;
    const continueText = continueKey
      ? buildOutboundText(continueKey, {
          includeFooter: false,
          stubMarker: this.stubMarker,
          extras,
        })
      : '';

    const parts = [body, continueText, extraText].filter(Boolean);
    let text = parts.join('\n\n');
    // Always surface the application URL for SEND_LINK even if copy/env drifted.
    if (
      state &&
      state.sendLink === 'application' &&
      appLink &&
      !String(text).includes(appLink)
    ) {
      text = `${text}\n\n${appLink}`;
    }

    const interactive = buildInteractiveFromState(state);

    const payload = {
      text,
      link: appLink,
      mediaSlot: state && state.mediaSlot ? state.mediaSlot : undefined,
      meta: { stateId: state ? state.id : null, promptKey: effectivePromptKey },
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
    } else if (state.autoAdvanceTo && !sendError) {
      // Info slides (e.g. special descriptions) → continue into the next step
      // in the same turn so the customer lands on Quick check immediately.
      this._clearFollowUp(session);
      await this.sessionStore.set(session.waNumber, session);
      return this._enterState(session, state.autoAdvanceTo);
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

  async _applyDeskLabel(session, state) {
    const name = state && state.deskLabel;
    if (
      !name ||
      !this.labelStore ||
      typeof this.labelStore.addChatLabelByName !== 'function'
    ) {
      return;
    }
    try {
      const result = await this.labelStore.addChatLabelByName(
        session.waNumber,
        name
      );
      if (result && result.reason === 'label_not_found') {
        // eslint-disable-next-line no-console
        console.warn('[fsm] desk label missing; chat not tagged', {
          waNumber: session.waNumber,
          name,
        });
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[fsm] desk label failed', {
        waNumber: session.waNumber,
        name,
        message: err && err.message ? err.message : String(err),
      });
    }
  }

  async _finalizeTerminal(session, state) {
    const exitReason = state.exitReason;
    session.lastExitReason = exitReason;

    if (state.quiet) {
      session.status = 'quiet';
    } else {
      session.status = 'soft_closed';
    }

    if (state.agentTakeover) {
      session.agentTakenOver = true;
    }

    await this._applyDeskLabel(session, state);

    const record = buildRecord({
      waNumber: session.waNumber,
      exitReason,
      path: session.path,
      interruptedFrom: session.interruptedFrom,
      meta: {
        quiet: Boolean(state.quiet),
        softDecline: Boolean(state.softDecline),
        selectedProductRetailerId: session.selectedProductRetailerId || null,
        selectedCatalogId: session.selectedCatalogId || null,
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
    // Already on a recovery menu and still off-option → hand over quietly.
    if (
      state &&
      (state.id === 'OFF_MENU_RECOVERY' || state.id === 'QUALIFY_CONSENT_NO')
    ) {
      return this._routeToHuman(session, state.id);
    }

    session.interruptedFrom = state ? state.id : session.currentState;
    session.invalidAttempts = 0;
    return this._enterState(session, 'OFF_MENU_RECOVERY', {
      fromInterrupt: session.interruptedFrom,
    });
  }

  /**
   * Off-menu free text when there is no active choice (wiped / soft_closed /
   * never started). Offer Human-Handover / Main-Menu instead of dumping the
   * customer back on the greeting.
   */
  async _enterOffMenuRecoveryFresh(session, { interruptedFrom } = {}) {
    this._resetSessionForFreshStart(session);
    if (interruptedFrom) {
      session.interruptedFrom = interruptedFrom;
    }
    return this._enterState(session, 'OFF_MENU_RECOVERY', {
      fromInterrupt: session.interruptedFrom || undefined,
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
    session.selectedProductRetailerId = null;
    session.selectedCatalogId = null;
    this._clearFollowUp(session);
  }

  /**
   * Start from a wiped/soft-closed session. Honour main-menu button taps
   * (Qualify Me, See our cars, Opt-Out) and stocklist "Check if I qualify"
   * so they don't bounce back to GREETING. Unknown free text → off-menu recovery.
   */
  async _beginFromMainMenuIntent(session, normalized, replyId) {
    this._resetSessionForFreshStart(session);
    const destination = resolveGreetingDestination(normalized, replyId);
    if (destination) {
      session.path = [ENTRY_STATE];
      if (destination !== 'STOCKLIST_CAROUSEL' && STATES.STOCKLIST_CAROUSEL) {
        const stock = STATES.STOCKLIST_CAROUSEL;
        const stockKey = resolveOptionKey(stock, normalized, replyId);
        if (stockKey && stock.options[stockKey] === destination) {
          session.path.push('STOCKLIST_CAROUSEL');
        }
      }
      return this._enterState(session, destination);
    }

    // Genuine reopen / first hello → main menu. Anything else off-menu → recovery.
    if (
      !normalized ||
      matchesKeywordList(normalized, config.fsm.reopenKeywords)
    ) {
      return this._enterState(session, ENTRY_STATE);
    }

    return this._enterState(session, 'OFF_MENU_RECOVERY');
  }

  /**
   * Staff takeover: bot goes quiet until release / customer restart.
   * Remembers the in-progress step so Release to bot can resume there.
   * @param {{silent?: boolean}} [options] skip optional notice
   */
  async takeOver(waNumber, options = {}) {
    return this._withSessionLock(waNumber, async () => {
      const session = await this.getOrCreateSession(waNumber);
      this._rememberResumePoint(session);
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
          interruptedFrom: session.interruptedFrom,
        },
      };
    });
  }

  /**
   * Staff release: resume the step from before handover when possible;
   * otherwise restart at the Melrose greeting.
   */
  async releaseToBot(waNumber) {
    return this._withSessionLock(waNumber, async () => {
      const session = await this.getOrCreateSession(waNumber);
      session.agentTakenOver = false;

      const resumeId = this._resumeStateId(session);
      if (resumeId) {
        return this._resumeAtState(session, resumeId);
      }
      return this._restart(session);
    });
  }

  /**
   * Snapshot the in-progress menu step before going quiet, unless we already
   * have an interruptedFrom from a bot-driven human handover.
   */
  _rememberResumePoint(session) {
    if (session.interruptedFrom && this._isResumableStateId(session.interruptedFrom)) {
      return;
    }
    const resumeId = this._resumeStateId(session);
    if (resumeId) {
      session.interruptedFrom = resumeId;
    }
  }

  _isResumableStateId(stateId) {
    const state = stateId ? STATES[stateId] : null;
    if (!state || state.terminal) return false;
    if (state.autoAdvanceTo) return false;
    return state.type === 'choice';
  }

  /**
   * Prefer interruptedFrom, then currentState, then walk path backwards for
   * the last choice menu the customer was answering.
   */
  _resumeStateId(session) {
    const candidates = [session.interruptedFrom, session.currentState];
    for (const id of candidates) {
      if (this._isResumableStateId(id)) return id;
      const state = id ? STATES[id] : null;
      if (state && state.autoAdvanceTo && this._isResumableStateId(state.autoAdvanceTo)) {
        return state.autoAdvanceTo;
      }
    }
    if (Array.isArray(session.path)) {
      for (let i = session.path.length - 1; i >= 0; i -= 1) {
        const id = session.path[i];
        if (this._isResumableStateId(id)) return id;
      }
    }
    return null;
  }

  async _resumeAtState(session, stateId) {
    session.status = 'active';
    session.agentTakenOver = false;
    session.interruptedFrom = null;
    session.lastExitReason = null;
    session.pendingTerminalOutbound = null;
    // Keep path history; drop a trailing human-handover terminal if present.
    if (Array.isArray(session.path) && session.path.length) {
      const last = session.path[session.path.length - 1];
      const lastState = STATES[last];
      if (lastState && lastState.terminal && lastState.quiet) {
        session.path = session.path.slice(0, -1);
      }
    }
    this._clearFollowUp(session);

    const notice = resolveCopy('session_resume_notice', {
      stubMarker: this.stubMarker,
    });
    if (notice) {
      try {
        await this.sendMessage(session.waNumber, {
          text: notice,
          meta: { stateId: null, promptKey: 'session_resume_notice' },
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[fsm] resume notice send failed', err.message);
      }
    }

    return this._enterState(session, stateId);
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
    const productRetailerId =
      extras &&
      extras.productRetailerId != null &&
      extras.productRetailerId !== ''
        ? String(extras.productRetailerId)
        : null;
    const inboundCatalogId =
      extras && extras.catalogId != null && extras.catalogId !== ''
        ? String(extras.catalogId)
        : null;
    let session = await this.getOrCreateSession(waNumber);

    if (session.status === 'quiet') {
      await this._flushPendingLead(session);
      // Staff (or bot-marked) takeover: no menus, no quiet notices, no restart
      // on hi/hello until Release. Only retry an undelivered terminal body
      // (e.g. failed HUMAN_HANDOVER notice) so the customer still gets it once.
      if (session.agentTakenOver) {
        if (session.pendingTerminalOutbound) {
          return this._retryTerminalOutbound(session);
        }
        return { session, quiet: true, agentHeld: true };
      }
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
      // Explicit reopen words still restart the greeting.
      if (matchesKeywordList(normalized, config.fsm.reopenKeywords)) {
        return this._restart(session);
      }
      // Off-menu free text → Human-Handover / Main-Menu, not a silent main-menu dump.
      return this._enterOffMenuRecoveryFresh(session);
    }

    if (!session.currentState || session.status === 'new') {
      // First inbound ever for this number: always show the main menu.
      // Free text can be anything ("Hello!", questions, gibberish, even
      // "help") — never off-menu recovery and never skip straight to a
      // later step unless they tapped an interactive button reply id.
      this._resetSessionForFreshStart(session);
      if (replyId) {
        const destination = resolveGreetingDestination(normalized, replyId);
        if (destination) {
          session.path = [ENTRY_STATE];
          if (destination !== 'STOCKLIST_CAROUSEL' && STATES.STOCKLIST_CAROUSEL) {
            const stock = STATES.STOCKLIST_CAROUSEL;
            const stockKey = resolveOptionKey(stock, normalized, replyId);
            if (stockKey && stock.options[stockKey] === destination) {
              session.path.push('STOCKLIST_CAROUSEL');
            }
          }
          return this._enterState(session, destination);
        }
      }
      return this._enterState(session, ENTRY_STATE);
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
      if (matchesKeywordList(normalized, config.fsm.reopenKeywords)) {
        return this._restart(session);
      }
      return this._enterOffMenuRecoveryFresh(session);
    }

    // Customer messaged about / ordered a catalog car while on stock browse.
    if (state.catalogProductList && productRetailerId) {
      session.selectedProductRetailerId = productRetailerId;
      session.selectedCatalogId =
        inboundCatalogId || config.whatsapp.catalogId || null;
      const nextId =
        (state.options && state.options.any_car) || 'EMPLOYED_INCOME_CHECK';
      return this._enterState(session, nextId);
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
