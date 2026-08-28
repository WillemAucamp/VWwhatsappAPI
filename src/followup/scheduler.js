'use strict';

const config = require('../config');

/**
 * Polls sessions for:
 *   - queued pendingLead / pendingTerminalOutbound recovery (always)
 *   - no-reply follow-up nudges when FOLLOW_UP_ENABLED (config.followUp.enabled)
 *
 * FOLLOW_UP_ENABLED=false must not stop lead flush or terminal outbound retry —
 * those recover CRM writes and application-link delivery for quiet customers.
 */
class FollowUpScheduler {
  constructor({
    engine,
    sessionStore,
    followUpConfig,
    setIntervalFn,
    clearIntervalFn,
    nowFn,
  } = {}) {
    if (!engine) throw new Error('engine required');
    if (!sessionStore || typeof sessionStore.listAll !== 'function') {
      throw new Error('sessionStore with listAll() required');
    }
    this.engine = engine;
    this.sessionStore = sessionStore;
    this.cfg = followUpConfig || config.followUp;
    this.setIntervalFn = setIntervalFn || setInterval;
    this.clearIntervalFn = clearIntervalFn || clearInterval;
    this.nowFn = nowFn || (() => Date.now());
    this._timer = null;
    this._running = false;
  }

  start() {
    if (this._timer) return this;
    const pollMs = Math.max(1000, this.cfg.pollMs || 60_000);
    this._timer = this.setIntervalFn(() => {
      this.tick().catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[follow-up] tick error', err);
      });
    }, pollMs);
    if (typeof this._timer.unref === 'function') this._timer.unref();
    // Always poll: pendingLead / pendingTerminalOutbound recovery must run even
    // when FOLLOW_UP_ENABLED=false (that flag only disables no-reply nudges).
    if (!this.cfg.enabled) {
      // eslint-disable-next-line no-console
      console.log(
        `[follow-up] nudges disabled; recovery poll still running (poll=${pollMs}ms)`
      );
    } else {
      // eslint-disable-next-line no-console
      console.log(
        `[follow-up] scheduler started (first=${this.cfg.firstDelayMs}ms, every=${this.cfg.intervalMs}ms, max=${this.cfg.maxCount}, poll=${pollMs}ms)`
      );
    }
    return this;
  }

  stop() {
    if (this._timer) {
      this.clearIntervalFn(this._timer);
      this._timer = null;
    }
    return this;
  }

  async tick(now = this.nowFn()) {
    if (this._running) return { skipped: true, reason: 'overlap' };
    this._running = true;
    try {
      const sessions = await this.sessionStore.listAll();
      const sent = [];
      const flushed = [];
      const resentTerminal = [];
      const errors = [];
      for (const session of sessions) {
        try {
          // Drain queued leads before follow-up eligibility. Pending leads are
          // exempt from session TTL, but still need a writer when CRM recovers
          // even if the customer never messages again.
          // Runs even when FOLLOW_UP_ENABLED=false — that flag only gates nudges.
          if (session.pendingLead && typeof this.engine.flushPendingLead === 'function') {
            // eslint-disable-next-line no-await-in-loop
            const didFlush = await this.engine.flushPendingLead(session.waNumber);
            if (didFlush) flushed.push(session.waNumber);
          }

          // Terminal Graph failures leave pendingTerminalOutbound after soft_closed.
          // The customer already answered the last question and is waiting for the
          // application link / handover — they will not inbound to trigger retry.
          if (
            session.pendingTerminalOutbound &&
            typeof this.engine.retryPendingTerminalOutbound === 'function'
          ) {
            // eslint-disable-next-line no-await-in-loop
            const retryResult = await this.engine.retryPendingTerminalOutbound(
              session.waNumber
            );
            if (retryResult && retryResult.resentTerminal) {
              resentTerminal.push(session.waNumber);
            }
          }

          if (!this.cfg.enabled) {
            continue;
          }

          // eslint-disable-next-line no-await-in-loop
          const result = await this.engine.processFollowUp(
            session.waNumber,
            now,
            this.cfg
          );
          if (result && result.sent) sent.push(result);
        } catch (err) {
          errors.push({
            waNumber: session.waNumber,
            message: err && err.message ? err.message : String(err),
          });
          // eslint-disable-next-line no-console
          console.error('[follow-up] processFollowUp error', {
            waNumber: session.waNumber,
            message: err && err.message ? err.message : String(err),
          });
        }
      }
      return {
        checked: sessions.length,
        sent: sent.length,
        flushed: flushed.length,
        resentTerminal: resentTerminal.length,
        nudgesEnabled: Boolean(this.cfg.enabled),
        details: sent,
        errors,
      };
    } finally {
      this._running = false;
    }
  }
}

module.exports = { FollowUpScheduler };
