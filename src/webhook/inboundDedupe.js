'use strict';

/**
 * WhatsApp Cloud API webhooks are at-least-once. Without dedupe on
 * message.id, a Meta retry re-applies the same customer text and can
 * skip states, burn invalid-attempt budget, or restart a soft-closed
 * session right after qualify / decline.
 *
 * In-process map is enough for the common single-process retry window.
 * Entries expire so the map cannot grow without bound.
 */

const DEFAULT_TTL_MS = 48 * 60 * 60 * 1000;

function createInboundDedupe({ ttlMs = DEFAULT_TTL_MS, nowFn } = {}) {
  /** @type {Map<string, number>} id -> expiresAtMs */
  const seen = new Map();
  const now = nowFn || (() => Date.now());

  function _purgeExpired(at = now()) {
    for (const [id, expiresAt] of seen.entries()) {
      if (expiresAt <= at) seen.delete(id);
    }
  }

  /**
   * Atomically claim a WhatsApp message id (check + mark).
   * @param {string|undefined|null} messageId
   * @returns {boolean} true if this delivery should be processed
   */
  function claim(messageId) {
    if (messageId == null || messageId === '') {
      // No id — cannot dedupe; process to avoid dropping legitimate traffic
      return true;
    }
    const key = String(messageId);
    const at = now();
    const existing = seen.get(key);
    if (existing != null && existing > at) {
      return false;
    }
    seen.set(key, at + ttlMs);
    // Opportunistic cleanup when the map grows
    if (seen.size > 512 && seen.size % 64 === 0) {
      _purgeExpired(at);
    }
    return true;
  }

  function clear() {
    seen.clear();
  }

  function size() {
    return seen.size;
  }

  return { claim, clear, size, _purgeExpired };
}

module.exports = {
  createInboundDedupe,
  DEFAULT_TTL_MS,
};
