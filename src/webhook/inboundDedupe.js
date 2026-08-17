'use strict';

/**
 * WhatsApp Cloud API webhooks are at-least-once. Without dedupe on
 * message.id, a Meta retry re-applies the same customer text and can
 * skip states, burn invalid-attempt budget, or restart a soft-closed
 * session right after qualify / decline.
 *
 * Claim is two-phase: begin() reserves an id while handleInbound runs;
 * commit() marks success; release() drops the reservation so a later
 * Meta redelivery can retry after a processing failure. Marking an id
 * done before handleInbound finishes permanently drops the message when
 * outbound send / session write throws and Meta retries the same wamid.
 *
 * In-process map is enough for the common single-process retry window.
 * Entries expire so the map cannot grow without bound.
 */

const DEFAULT_TTL_MS = 48 * 60 * 60 * 1000;

function createInboundDedupe({ ttlMs = DEFAULT_TTL_MS, nowFn } = {}) {
  /** @type {Map<string, number>} id -> expiresAtMs (successfully processed) */
  const seen = new Map();
  /** @type {Set<string>} ids currently being processed */
  const inFlight = new Set();
  const now = nowFn || (() => Date.now());

  function _purgeExpired(at = now()) {
    for (const [id, expiresAt] of seen.entries()) {
      if (expiresAt <= at) seen.delete(id);
    }
  }

  function _hasKey(messageId) {
    return messageId != null && messageId !== '';
  }

  /**
   * Reserve a WhatsApp message id for processing (check + in-flight).
   * @param {string|undefined|null} messageId
   * @returns {boolean} true if this delivery should be processed
   */
  function begin(messageId) {
    if (!_hasKey(messageId)) {
      // No id — cannot dedupe; process to avoid dropping legitimate traffic
      return true;
    }
    const key = String(messageId);
    const at = now();
    const existing = seen.get(key);
    if (existing != null && existing > at) {
      return false;
    }
    if (inFlight.has(key)) {
      return false;
    }
    inFlight.add(key);
    return true;
  }

  /**
   * Mark a message id as successfully processed (suppress future retries).
   * @param {string|undefined|null} messageId
   */
  function commit(messageId) {
    if (!_hasKey(messageId)) return;
    const key = String(messageId);
    const at = now();
    inFlight.delete(key);
    seen.set(key, at + ttlMs);
    if (seen.size > 512 && seen.size % 64 === 0) {
      _purgeExpired(at);
    }
  }

  /**
   * Drop an in-flight reservation after a processing failure so Meta
   * redeliveries of the same wamid can be tried again.
   * @param {string|undefined|null} messageId
   */
  function release(messageId) {
    if (!_hasKey(messageId)) return;
    inFlight.delete(String(messageId));
  }

  /**
   * Atomically claim + commit (for unit tests / callers that do not need
   * failure-release). Prefer begin/commit/release around async work.
   * @param {string|undefined|null} messageId
   * @returns {boolean} true if this delivery should be processed
   */
  function claim(messageId) {
    if (!begin(messageId)) return false;
    commit(messageId);
    return true;
  }

  function clear() {
    seen.clear();
    inFlight.clear();
  }

  function size() {
    return seen.size;
  }

  function inFlightSize() {
    return inFlight.size;
  }

  return {
    begin,
    commit,
    release,
    claim,
    clear,
    size,
    inFlightSize,
    _purgeExpired,
  };
}

module.exports = {
  createInboundDedupe,
  DEFAULT_TTL_MS,
};
