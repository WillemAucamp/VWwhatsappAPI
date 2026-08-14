'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');

/**
 * Lightweight session store.
 * Default: JSON files under SESSION_STORE_PATH.
 * Optional: Redis when SESSION_STORE=redis and REDIS_URL is set (lazy require).
 */

function now() {
  return Date.now();
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
    // Follow-up automation (no reply to last bot question)
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
      if (this._expired(data)) {
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
    fs.writeFileSync(file, JSON.stringify(session, null, 2), 'utf8');
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
        if (this._expired(data)) {
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

  _expired(session) {
    if (!session || !session.updatedAt) return true;
    return now() - session.updatedAt > config.session.ttlMs;
  }
}

class MemorySessionStore {
  constructor() {
    this.map = new Map();
  }

  async get(waNumber) {
    const data = this.map.get(String(waNumber));
    if (!data) return null;
    if (now() - data.updatedAt > config.session.ttlMs) {
      this.map.delete(String(waNumber));
      return null;
    }
    return { ...data };
  }

  async set(waNumber, session) {
    session.updatedAt = now();
    this.map.set(String(waNumber), { ...session });
    return session;
  }

  async delete(waNumber) {
    this.map.delete(String(waNumber));
  }

  async listAll() {
    const sessions = [];
    for (const [waNumber, data] of this.map.entries()) {
      if (now() - data.updatedAt > config.session.ttlMs) {
        this.map.delete(waNumber);
        continue;
      }
      sessions.push({ ...data });
    }
    return sessions;
  }
}

class RedisSessionStore {
  constructor(redisUrl) {
    // Optional dependency — only loaded when configured
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
    await this.client.set(
      this._key(waNumber),
      JSON.stringify(session),
      'EX',
      this.ttlSec
    );
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
  FileSessionStore,
  MemorySessionStore,
};
