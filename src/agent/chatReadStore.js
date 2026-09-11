'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { getSharedPool, resolveDeskSettingsBackend } = require('./pg');

/**
 * Agent-desk-only "last opened" cursors per WhatsApp number.
 * Does not touch bot sessions, webhooks, or message transcripts.
 *
 * Backends:
 * - postgres (whenever DATABASE_URL is set): survives Render redeploys
 * - file: JSONL-free JSON blob under AGENT_CHAT_READS_PATH (tests / local)
 *
 * WhatsApp has no "mark chat unread" API — in the WhatsApp client that is
 * local device state. forcedUnread is the desk's equivalent, and it stays
 * set until staff explicitly open the chat again.
 */

/** Epoch cursor → every message counts as unread again. */
const EPOCH = '1970-01-01T00:00:00.000Z';

function normalizeWa(waNumber) {
  return String(waNumber || '').replace(/\D/g, '');
}

function requireWa(waNumber) {
  const wa = normalizeWa(waNumber);
  if (!wa) {
    const err = new Error('wa_required');
    err.status = 400;
    throw err;
  }
  return wa;
}

function createFileChatReadStore(filePath = config.agent.chatReadsPath) {
  const file = path.resolve(filePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let chain = Promise.resolve();

  function withLock(fn) {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async function readAllUnlocked() {
    if (!fs.existsSync(file)) {
      return { reads: {}, forcedUnread: {} };
    }
    try {
      const raw = await fs.promises.readFile(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.reads !== 'object' || !parsed.reads) {
        return { reads: {}, forcedUnread: {} };
      }
      return {
        reads: parsed.reads,
        forcedUnread:
          parsed.forcedUnread && typeof parsed.forcedUnread === 'object'
            ? parsed.forcedUnread
            : {},
      };
    } catch {
      return { reads: {}, forcedUnread: {} };
    }
  }

  async function writeAllUnlocked(data) {
    const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2, 8)}.tmp`;
    const payload = {
      reads: data.reads || {},
      forcedUnread: data.forcedUnread || {},
    };
    await fs.promises.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await fs.promises.rename(tmp, file);
  }

  async function getAll() {
    return withLock(async () => {
      const data = await readAllUnlocked();
      return { ...data.reads };
    });
  }

  async function getState() {
    return withLock(async () => {
      const data = await readAllUnlocked();
      return {
        reads: { ...data.reads },
        forcedUnread: { ...data.forcedUnread },
      };
    });
  }

  async function get(waNumber) {
    const wa = normalizeWa(waNumber);
    if (!wa) return null;
    const all = await getAll();
    return all[wa] || null;
  }

  async function isForcedUnread(waNumber) {
    const wa = normalizeWa(waNumber);
    if (!wa) return false;
    const state = await getState();
    return Boolean(state.forcedUnread[wa]);
  }

  async function markRead(waNumber, at = new Date().toISOString()) {
    const wa = requireWa(waNumber);
    const when = at || new Date().toISOString();
    return withLock(async () => {
      const data = await readAllUnlocked();
      data.reads[wa] = when;
      if (data.forcedUnread) delete data.forcedUnread[wa];
      await writeAllUnlocked(data);
      return { waNumber: wa, lastReadAt: when, forcedUnread: false };
    });
  }

  async function markUnread(waNumber) {
    const wa = requireWa(waNumber);
    return withLock(async () => {
      const data = await readAllUnlocked();
      data.reads[wa] = EPOCH;
      if (!data.forcedUnread) data.forcedUnread = {};
      data.forcedUnread[wa] = true;
      await writeAllUnlocked(data);
      return { waNumber: wa, lastReadAt: EPOCH, forcedUnread: true };
    });
  }

  return {
    getAll,
    getState,
    get,
    isForcedUnread,
    markRead,
    markUnread,
    file,
    backend: 'file',
  };
}

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS agent_chat_reads (
  wa_number TEXT PRIMARY KEY,
  last_read_at TIMESTAMPTZ,
  forced_unread BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`;

function createPostgresChatReadStore(connectionString) {
  if (!connectionString) {
    throw new Error('DATABASE_URL is required for the postgres chat read store');
  }
  const pool = getSharedPool(connectionString);
  let ready = null;

  function ensureSchema() {
    if (!ready) {
      ready = pool
        .query(CREATE_TABLE_SQL)
        .then(() => undefined)
        .catch((err) => {
          ready = null;
          throw err;
        });
    }
    return ready;
  }

  function isoOf(value) {
    if (!value) return null;
    return value instanceof Date ? value.toISOString() : String(value);
  }

  async function getState() {
    await ensureSchema();
    const { rows } = await pool.query(
      `SELECT wa_number, last_read_at, forced_unread FROM agent_chat_reads`
    );
    const reads = {};
    const forcedUnread = {};
    for (const row of rows) {
      const wa = normalizeWa(row.wa_number);
      if (!wa) continue;
      const at = isoOf(row.last_read_at);
      if (at) reads[wa] = at;
      if (row.forced_unread) forcedUnread[wa] = true;
    }
    return { reads, forcedUnread };
  }

  async function getAll() {
    const state = await getState();
    return state.reads;
  }

  async function get(waNumber) {
    const wa = normalizeWa(waNumber);
    if (!wa) return null;
    await ensureSchema();
    const { rows } = await pool.query(
      `SELECT last_read_at FROM agent_chat_reads WHERE wa_number = $1`,
      [wa]
    );
    return rows[0] ? isoOf(rows[0].last_read_at) : null;
  }

  async function isForcedUnread(waNumber) {
    const wa = normalizeWa(waNumber);
    if (!wa) return false;
    await ensureSchema();
    const { rows } = await pool.query(
      `SELECT forced_unread FROM agent_chat_reads WHERE wa_number = $1`,
      [wa]
    );
    return Boolean(rows[0] && rows[0].forced_unread);
  }

  async function markRead(waNumber, at = new Date().toISOString()) {
    const wa = requireWa(waNumber);
    const when = at || new Date().toISOString();
    await ensureSchema();
    await pool.query(
      `INSERT INTO agent_chat_reads (wa_number, last_read_at, forced_unread, updated_at)
       VALUES ($1, $2::timestamptz, FALSE, NOW())
       ON CONFLICT (wa_number) DO UPDATE
         SET last_read_at = EXCLUDED.last_read_at,
             forced_unread = FALSE,
             updated_at = NOW()`,
      [wa, when]
    );
    return { waNumber: wa, lastReadAt: when, forcedUnread: false };
  }

  async function markUnread(waNumber) {
    const wa = requireWa(waNumber);
    await ensureSchema();
    await pool.query(
      `INSERT INTO agent_chat_reads (wa_number, last_read_at, forced_unread, updated_at)
       VALUES ($1, $2::timestamptz, TRUE, NOW())
       ON CONFLICT (wa_number) DO UPDATE
         SET last_read_at = EXCLUDED.last_read_at,
             forced_unread = TRUE,
             updated_at = NOW()`,
      [wa, EPOCH]
    );
    return { waNumber: wa, lastReadAt: EPOCH, forcedUnread: true };
  }

  return {
    getAll,
    getState,
    get,
    isForcedUnread,
    markRead,
    markUnread,
    backend: 'postgres',
  };
}

/**
 * @param {string|object} [options] File path (tests) or { backend, databaseUrl, filePath }
 */
function createChatReadStore(options) {
  if (typeof options === 'string') {
    return createFileChatReadStore(options);
  }
  const opts = options || {};
  const { backend, databaseUrl } = resolveDeskSettingsBackend(opts);
  if (backend === 'postgres') {
    return createPostgresChatReadStore(databaseUrl);
  }
  return createFileChatReadStore(opts.filePath || config.agent.chatReadsPath);
}

module.exports = {
  createChatReadStore,
  createFileChatReadStore,
  createPostgresChatReadStore,
  EPOCH,
};
