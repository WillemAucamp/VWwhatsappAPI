'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');

function now() {
  return Date.now();
}

/**
 * Sessions with a queued pendingLead or pendingTerminalOutbound must not be
 * TTL-purged. pendingLead is the only durable copy of a qualification lead
 * after logLead failed; pendingTerminalOutbound is the only record that the
 * application link / handover Graph send still needs a retry. listAll()/get()
 * (and Redis EX) would otherwise delete them forever once the lead flush
 * cleared pendingLead and refreshed the TTL clock.
 *
 * Sessions with agentTakenOver must also be pinned: desk Take over / reply
 * auto-takeOver leave status=quiet with no pending* flags, and inbound while
 * held intentionally does not rewrite the session — so updatedAt freezes at
 * takeover. Without this pin, SESSION_TTL_MS deletes the hold and the next
 * customer message starts a fresh GREETING, wiping funnel progress.
 */
function isSessionExpired(session, ttlMs = config.session.ttlMs, at = now()) {
  if (!session || !session.updatedAt) return true;
  if (
    session.pendingLead ||
    session.pendingTerminalOutbound ||
    session.agentTakenOver
  ) {
    return false;
  }
  return at - session.updatedAt > ttlMs;
}

function cloneSession(session) {
  if (!session) return null;
  return {
    ...session,
    path: Array.isArray(session.path) ? [...session.path] : [],
    pendingLead: session.pendingLead
      ? {
          ...session.pendingLead,
          path: Array.isArray(session.pendingLead.path)
            ? [...session.pendingLead.path]
            : [],
          meta: session.pendingLead.meta ? { ...session.pendingLead.meta } : {},
        }
      : null,
    pendingTerminalOutbound: session.pendingTerminalOutbound
      ? { ...session.pendingTerminalOutbound }
      : null,
    lastLoggedLeadKey: session.lastLoggedLeadKey || null,
    selectedProductRetailerId: session.selectedProductRetailerId || null,
    selectedCatalogId: session.selectedCatalogId || null,
  };
}

function createEmptySession(waNumber) {
  return {
    waNumber,
    currentState: null,
    path: [],
    invalidAttempts: 0,
    status: 'new', // new | active | soft_closed | quiet
    interruptedFrom: null,
    createdAt: now(),
    updatedAt: now(),
    lastExitReason: null,
    pendingLead: null,
    // Set when a terminal Graph send fails after we still persist soft_closed/quiet.
    // Next inbound retries that outbound instead of wiping the completed path.
    pendingTerminalOutbound: null,
    // Durable lead-log fingerprint so a successful logLead + failed pendingLead
    // clear cannot double-write after process restart (in-memory set is lost).
    lastLoggedLeadKey: null,
    agentTakenOver: false,
    // Catalog car the customer messaged about / ordered from "See our cars".
    selectedProductRetailerId: null,
    selectedCatalogId: null,
    lastBotMessageAt: null,
    lastFollowUpAt: null,
    followUpCount: 0,
    followUpsExhausted: false,
  };
}

class FileSessionStore {
  constructor(dir) {
    this.dir = path.resolve(dir);
    fs.mkdirSync(this.dir, { recursive: true });
  }

  _file(waNumber) {
    const safe = String(waNumber).replace(/[^a-zA-Z0-9_+-]/g, '_');
    return path.join(this.dir, `${safe}.json`);
  }

  async get(waNumber) {
    const file = this._file(waNumber);
    if (!fs.existsSync(file)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (isSessionExpired(data)) {
        await this.delete(waNumber);
        return null;
      }
      return data;
    } catch {
      return null;
    }
  }

  async set(waNumber, session) {
    session.updatedAt = now();
    const file = this._file(waNumber);
    // Atomic replace: writeFileSync truncates first, so a crash mid-write
    // left an empty/partial JSON that get() treated as "no session" and
    // wiped in-progress qualification state.
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(session, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return session;
  }

  async delete(waNumber) {
    const file = this._file(waNumber);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }

  async listAll() {
    const files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    const sessions = [];
    for (const file of files) {
      try {
        const data = JSON.parse(
          fs.readFileSync(path.join(this.dir, file), 'utf8')
        );
        if (!data || !data.waNumber) continue;
        if (isSessionExpired(data)) {
          await this.delete(data.waNumber);
          continue;
        }
        sessions.push(data);
      } catch {
        // skip corrupt files
      }
    }
    return sessions;
  }
}

class MemorySessionStore {
  constructor() {
    this.map = new Map();
  }

  async get(waNumber) {
    const data = this.map.get(String(waNumber));
    if (!data) return null;
    if (isSessionExpired(data)) {
      this.map.delete(String(waNumber));
      return null;
    }
    return cloneSession(data);
  }

  async set(waNumber, session) {
    session.updatedAt = now();
    this.map.set(String(waNumber), cloneSession(session));
    return session;
  }

  async delete(waNumber) {
    this.map.delete(String(waNumber));
  }

  async listAll() {
    const sessions = [];
    for (const [waNumber, data] of this.map.entries()) {
      if (isSessionExpired(data)) {
        this.map.delete(waNumber);
        continue;
      }
      sessions.push(cloneSession(data));
    }
    return sessions;
  }
}

class RedisSessionStore {
  constructor(redisUrl) {
    // eslint-disable-next-line import/no-extraneous-dependencies, global-require
    const Redis = require('ioredis');
    this.client = new Redis(redisUrl);
    this.prefix = 'wa:session:';
    this.ttlSec = Math.max(1, Math.floor(config.session.ttlMs / 1000));
  }

  _key(waNumber) {
    return `${this.prefix}${waNumber}`;
  }

  async get(waNumber) {
    const raw = await this.client.get(this._key(waNumber));
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async set(waNumber, session) {
    session.updatedAt = now();
    const key = this._key(waNumber);
    const payload = JSON.stringify(session);
    // Queued leads, undelivered terminal outbounds, and active agent holds
    // must outlive the normal session TTL or Redis EX drops the only
    // retry/CRM recovery state / staff takeover.
    if (
      session.pendingLead ||
      session.pendingTerminalOutbound ||
      session.agentTakenOver
    ) {
      await this.client.set(key, payload);
    } else {
      await this.client.set(key, payload, 'EX', this.ttlSec);
    }
    return session;
  }

  async delete(waNumber) {
    await this.client.del(this._key(waNumber));
  }

  async listAll() {
    const sessions = [];
    let cursor = '0';
    do {
      // eslint-disable-next-line no-await-in-loop
      const [next, keys] = await this.client.scan(
        cursor,
        'MATCH',
        `${this.prefix}*`,
        'COUNT',
        100
      );
      cursor = next;
      for (const key of keys) {
        // eslint-disable-next-line no-await-in-loop
        const raw = await this.client.get(key);
        if (!raw) continue;
        try {
          sessions.push(JSON.parse(raw));
        } catch {
          // skip
        }
      }
    } while (cursor !== '0');
    return sessions;
  }
}

function createSessionStore(override) {
  const type = (override || config.session.store || 'file').toLowerCase();
  if (type === 'memory') return new MemorySessionStore();
  if (type === 'redis') {
    if (!config.session.redisUrl) {
      throw new Error('SESSION_STORE=redis requires REDIS_URL');
    }
    return new RedisSessionStore(config.session.redisUrl);
  }
  return new FileSessionStore(config.session.storePath);
}

module.exports = {
  createSessionStore,
  createEmptySession,
  isSessionExpired,
  FileSessionStore,
  MemorySessionStore,
};
