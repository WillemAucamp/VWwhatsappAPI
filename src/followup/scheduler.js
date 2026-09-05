'use strict';

const config = require('../config');

/**
 * Polls sessions for:
 *   - queued pendingLead / pendingTerminalOutbound / pendingQuestionOutbound
 *     recovery (always)
 *   - no-reply follow-up nudges when FOLLOW_UP_ENABLED (config.followUp.enabled)
 *
 * FOLLOW_UP_ENABLED=false must not stop lead flush or outbound retry —
 * those recover CRM writes and question/application-link delivery.
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
    // Always poll: pendingLead / pending*Outbound recovery must run even
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
      const resentQuestion = [];
      const errors = [];
      for (const session of sessions) {
        // Isolate CRM flush from terminal WhatsApp retry. A shared try/catch
        // meant logLead failures skipped pendingTerminalOutbound — qualified
        // users never got the application link while CRM was down even when
        // Graph was healthy again.
        if (session.pendingLead && typeof this.engine.flushPendingLead === 'function') {
          try {
            // eslint-disable-next-line no-await-in-loop
            const didFlush = await this.engine.flushPendingLead(session.waNumber);
            if (didFlush) flushed.push(session.waNumber);
          } catch (err) {
            errors.push({
              waNumber: session.waNumber,
              message: err && err.message ? err.message : String(err),
            });
            // eslint-disable-next-line no-console
            console.error('[follow-up] flushPendingLead error', {
              waNumber: session.waNumber,
              message: err && err.message ? err.message : String(err),
            });
          }
        }

        if (
          session.pendingTerminalOutbound &&
          typeof this.engine.retryPendingTerminalOutbound === 'function'
        ) {
          try {
            // eslint-disable-next-line no-await-in-loop
            const retryResult = await this.engine.retryPendingTerminalOutbound(
              session.waNumber
            );
            if (retryResult && retryResult.resentTerminal) {
              resentTerminal.push(session.waNumber);
            }
          } catch (err) {
            errors.push({
              waNumber: session.waNumber,
              message: err && err.message ? err.message : String(err),
            });
            // eslint-disable-next-line no-console
            console.error('[follow-up] retryPendingTerminalOutbound error', {
              waNumber: session.waNumber,
              message: err && err.message ? err.message : String(err),
            });
          }
        }

        if (
          session.pendingQuestionOutbound &&
          typeof this.engine.retryPendingQuestionOutbound === 'function'
        ) {
          try {
            // eslint-disable-next-line no-await-in-loop
            const retryResult = await this.engine.retryPendingQuestionOutbound(
              session.waNumber
            );
            if (retryResult && retryResult.resentQuestion) {
              resentQuestion.push(session.waNumber);
            }
          } catch (err) {
            errors.push({
              waNumber: session.waNumber,
              message: err && err.message ? err.message : String(err),
            });
            // eslint-disable-next-line no-console
            console.error('[follow-up] retryPendingQuestionOutbound error', {
              waNumber: session.waNumber,
              message: err && err.message ? err.message : String(err),
            });
          }
        }

        if (!this.cfg.enabled) {
          continue;
        }

        try {
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
        resentQuestion: resentQuestion.length,
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
