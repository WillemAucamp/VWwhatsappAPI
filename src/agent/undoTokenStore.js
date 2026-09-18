'use strict';

const crypto = require('crypto');

const DEFAULT_TTL_MS = 10_000;

/**
 * Process-local undo token store with TTL.
 * Tokens are generated server-side; clients cannot forge valid entries.
 */
function createUndoTokenStore({ ttlMs = DEFAULT_TTL_MS } = {}) {
  const tokens = new Map();

  function prune() {
    const now = Date.now();
    for (const [key, entry] of tokens.entries()) {
      if (!entry || entry.expiresAt <= now) tokens.delete(key);
    }
  }

  function create(payload) {
    prune();
    const undoToken = crypto.randomBytes(18).toString('base64url');
    const now = Date.now();
    const entry = {
      ...payload,
      undoToken,
      createdAt: now,
      expiresAt: now + ttlMs,
    };
    tokens.set(undoToken, entry);
    return entry;
  }

  function peek(undoToken) {
    prune();
    const key = String(undoToken || '');
    const entry = tokens.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      tokens.delete(key);
      return null;
    }
    return entry;
  }

  function consume(undoToken) {
    const entry = peek(undoToken);
    if (!entry) return null;
    tokens.delete(String(undoToken));
    return entry;
  }

  function size() {
    prune();
    return tokens.size;
  }

  return { create, peek, consume, size, ttlMs };
}

module.exports = {
  createUndoTokenStore,
  DEFAULT_TTL_MS,
};
