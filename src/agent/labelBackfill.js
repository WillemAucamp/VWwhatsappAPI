'use strict';

const config = require('../config');
const {
  labelsFromSession,
  syncInferredDeskLabels,
} = require('./deskAutoLabels');

/**
 * Slow, capped backfill of funnel labels. Never runs on GET /api/chats.
 * Skips when AGENT_DESK_EMERGENCY is on so the inbox keeps the pool.
 */
function createLabelBackfill({
  labelStore,
  messageStore,
  sessionStore,
  options = {},
} = {}) {
  const intervalMs = Math.max(
    5000,
    Number(options.intervalMs != null
      ? options.intervalMs
      : config.agent.labelBackfillIntervalMs) || 20000
  );
  const batch = Math.max(
    1,
    Number(options.batch != null ? options.batch : config.agent.labelBackfillBatch) || 2
  );
  const tickMs = Math.max(
    200,
    Number(options.tickMs != null ? options.tickMs : config.agent.labelBackfillTickMs) || 1500
  );
  const setIntervalFn = options.setIntervalFn || setInterval;
  const clearIntervalFn = options.clearIntervalFn || clearInterval;

  const done = new Set();
  let cursor = '';
  let timer = null;
  let running = false;
  let exhausted = false;

  function emergencyOn() {
    return Boolean(config.agent.deskEmergency);
  }

  function enabled() {
    if (emergencyOn()) return false;
    if (options.enabled === false) return false;
    if (config.agent.labelBackfillEnabled === false) return false;
    return Boolean(labelStore && messageStore);
  }

  async function nextWaNumbers(limit) {
    if (
      messageStore &&
      typeof messageStore.listWaNumbers === 'function'
    ) {
      return messageStore.listWaNumbers({ limit, after: cursor });
    }
    return [];
  }

  async function labelOne(wa, hints) {
    const key = String(wa || '').replace(/\D/g, '');
    if (!key || done.has(key)) return false;
    await syncInferredDeskLabels(labelStore, key, hints);
    done.add(key);
    return true;
  }

  async function tick() {
    if (running) return { skipped: true, reason: 'overlap' };
    if (!enabled()) return { skipped: true, reason: 'disabled' };
    running = true;
    const started = Date.now();
    const deadline = started + tickMs;
    let applied = 0;
    try {
      if (sessionStore && typeof sessionStore.listAll === 'function') {
        const sessions = await sessionStore.listAll();
        for (const session of sessions || []) {
          if (Date.now() >= deadline || applied >= batch) break;
          const wa = session && session.waNumber;
          if (labelsFromSession(session).length) {
            if (await labelOne(wa, { session })) applied += 1;
          }
        }
      }

      while (applied < batch && Date.now() < deadline && !exhausted) {
        const remaining = batch - applied;
        const ids = await nextWaNumbers(remaining);
        if (!ids.length) {
          exhausted = true;
          cursor = '';
          break;
        }
        for (const wa of ids) {
          if (Date.now() >= deadline || applied >= batch) break;
          cursor = String(wa);
          if (done.has(String(wa).replace(/\D/g, ''))) continue;
          let messages = [];
          if (typeof messageStore.listMessages === 'function') {
            messages = await messageStore.listMessages(wa, { limit: 80 });
          }
          if (await labelOne(wa, { messages })) applied += 1;
        }
        if (ids.length < remaining) {
          exhausted = true;
          cursor = '';
        }
      }
      return { applied, elapsedMs: Date.now() - started };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[labels] backfill tick failed', err && err.message ? err.message : err);
      return {
        applied,
        error: err && err.message ? err.message : String(err),
        elapsedMs: Date.now() - started,
      };
    } finally {
      running = false;
    }
  }

  function start() {
    if (!enabled()) {
      // eslint-disable-next-line no-console
      console.log('[labels] backfill disabled');
      return { tick, stop, start };
    }
    if (timer) return { tick, stop, start };
    timer = setIntervalFn(() => {
      tick().catch(() => undefined);
    }, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    // eslint-disable-next-line no-console
    console.log(
      `[labels] backfill started (every=${intervalMs}ms, batch=${batch}, tick<=${tickMs}ms)`
    );
    return { tick, stop, start };
  }

  function stop() {
    if (timer) {
      clearIntervalFn(timer);
      timer = null;
    }
    return { tick, stop, start };
  }

  return { tick, start, stop, enabled };
}

module.exports = { createLabelBackfill };
