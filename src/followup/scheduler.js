'use strict';

const config = require('../config');

/**
 * Polls sessions and asks the engine to send due no-reply follow-ups.
 * Intervals come from config (default: first after 30m, then every 4h).
 */
class FollowUpScheduler {
  /**
   * @param {object} deps
   * @param {import('../engine/fsmEngine').FsmEngine} deps.engine
   * @param {object} deps.sessionStore store with listAll()
   * @param {object} [deps.followUpConfig] override config.followUp
   * @param {Function} [deps.setIntervalFn]
   * @param {Function} [deps.clearIntervalFn]
   * @param {Function} [deps.nowFn]
   */
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
    if (!this.cfg.enabled) {
      // eslint-disable-next-line no-console
      console.log('[follow-up] disabled');
      return this;
    }
    if (this._timer) return this;
    const pollMs = Math.max(1000, this.cfg.pollMs || 60_000);
    this._timer = this.setIntervalFn(() => {
      this.tick().catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[follow-up] tick error', err);
      });
    }, pollMs);
    if (typeof this._timer.unref === 'function') this._timer.unref();
    // eslint-disable-next-line no-console
    console.log(
      `[follow-up] scheduler started (first=${this.cfg.firstDelayMs}ms, every=${this.cfg.intervalMs}ms, max=${this.cfg.maxCount}, poll=${pollMs}ms)`
    );
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
    if (!this.cfg.enabled) return { skipped: true, reason: 'disabled' };
    this._running = true;
    try {
      const sessions = await this.sessionStore.listAll();
      const sent = [];
      for (const session of sessions) {
        // eslint-disable-next-line no-await-in-loop
        const result = await this.engine.processFollowUp(session.waNumber, now, this.cfg);
        if (result && result.sent) sent.push(result);
      }
      return { checked: sessions.length, sent: sent.length, details: sent };
    } finally {
      this._running = false;
    }
  }
}

module.exports = { FollowUpScheduler };
