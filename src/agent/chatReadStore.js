'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { getSharedPool, resolveAgentStoreBackend } = require('./pg');

/**
 * Agent-desk-only "last opened" cursors per WhatsApp number.
 * Does not touch bot sessions, webhooks, or message transcripts.
 */

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
    const wa = String(waNumber || '').replace(/\D/g, '');
    if (!wa) return null;
    const all = await getAll();
    return all[wa] || null;
  }

  async function markRead(waNumber, at = new Date().toISOString()) {
    const wa = String(waNumber || '').replace(/\D/g, '');
    if (!wa) {
      const err = new Error('wa_required');
      err.status = 400;
      throw err;
    }
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
    const wa = String(waNumber || '').replace(/\D/g, '');
    if (!wa) {
      const err = new Error('wa_required');
      err.status = 400;
      throw err;
    }
    return withLock(async () => {
      const data = await readAllUnlocked();
      // Epoch cursor → every inbound counts as unread again.
      data.reads[wa] = '1970-01-01T00:00:00.000Z';
      if (!data.forcedUnread) data.forcedUnread = {};
      data.forcedUnread[wa] = true;
      await writeAllUnlocked(data);
      return {
        waNumber: wa,
        lastReadAt: data.reads[wa],
        forcedUnread: true,
      };
    });
  }

  return { getAll, getState, get, markRead, markUnread, file, backend: 'file' };
}

function createPostgresChatReadStore(connectionString, opts = {}) {
  if (!connectionString) {
    throw new Error('DATABASE_URL is required for MESSAGE_STORE=postgres');
  }
  const pool = getSharedPool(connectionString);
  const fileFallback = path.resolve(
    opts.filePath || config.agent.chatReadsPath
  );
  let ready = null;
  let chain = Promise.resolve();

  function withLock(fn) {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async function tryImportFromFile() {
    if (!fs.existsSync(fileFallback)) return null;
    try {
      const raw = await fs.promises.readFile(fileFallback, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.reads !== 'object') return null;
      return {
        reads: parsed.reads || {},
        forcedUnread:
          parsed.forcedUnread && typeof parsed.forcedUnread === 'object'
            ? parsed.forcedUnread
            : {},
      };
    } catch {
      return null;
    }
  }

  function ensureSchema() {
    if (!ready) {
      ready = (async () => {
        await pool.query(`
CREATE TABLE IF NOT EXISTS agent_chat_reads (
  wa_number TEXT PRIMARY KEY,
  last_read_at TIMESTAMPTZ NOT NULL,
  forced_unread BOOLEAN NOT NULL DEFAULT FALSE
)`);
        const { rows } = await pool.query(
          `SELECT COUNT(*)::int AS n FROM agent_chat_reads`
        );
        if (!rows[0] || rows[0].n === 0) {
          const imported = await tryImportFromFile();
          if (imported) {
            for (const [waRaw, at] of Object.entries(imported.reads || {})) {
              const wa = String(waRaw || '').replace(/\D/g, '');
              if (!wa) continue;
              await pool.query(
                `INSERT INTO agent_chat_reads (wa_number, last_read_at, forced_unread)
                 VALUES ($1, $2::timestamptz, $3)
                 ON CONFLICT (wa_number) DO NOTHING`,
                [
                  wa,
                  at,
                  Boolean(imported.forcedUnread && imported.forcedUnread[waRaw]),
                ]
              );
            }
          }
        }
      })().catch((err) => {
        ready = null;
        throw err;
      });
    }
    return ready;
  }

  async function getAll() {
    return withLock(async () => {
      await ensureSchema();
      const { rows } = await pool.query(
        `SELECT wa_number, last_read_at FROM agent_chat_reads`
      );
      const out = {};
      for (const row of rows) {
        out[row.wa_number] =
          row.last_read_at instanceof Date
            ? row.last_read_at.toISOString()
            : String(row.last_read_at);
      }
      return out;
    });
  }

  async function getState() {
    return withLock(async () => {
      await ensureSchema();
      const { rows } = await pool.query(
        `SELECT wa_number, last_read_at, forced_unread FROM agent_chat_reads`
      );
      const reads = {};
      const forcedUnread = {};
      for (const row of rows) {
        reads[row.wa_number] =
          row.last_read_at instanceof Date
            ? row.last_read_at.toISOString()
            : String(row.last_read_at);
        if (row.forced_unread) forcedUnread[row.wa_number] = true;
      }
      return { reads, forcedUnread };
    });
  }

  async function get(waNumber) {
    const wa = String(waNumber || '').replace(/\D/g, '');
    if (!wa) return null;
    const all = await getAll();
    return all[wa] || null;
  }

  async function markRead(waNumber, at = new Date().toISOString()) {
    const wa = String(waNumber || '').replace(/\D/g, '');
    if (!wa) {
      const err = new Error('wa_required');
      err.status = 400;
      throw err;
    }
    const when = at || new Date().toISOString();
    return withLock(async () => {
      await ensureSchema();
      await pool.query(
        `INSERT INTO agent_chat_reads (wa_number, last_read_at, forced_unread)
         VALUES ($1, $2::timestamptz, FALSE)
         ON CONFLICT (wa_number) DO UPDATE
           SET last_read_at = EXCLUDED.last_read_at,
               forced_unread = FALSE`,
        [wa, when]
      );
      return { waNumber: wa, lastReadAt: when, forcedUnread: false };
    });
  }

  async function markUnread(waNumber) {
    const wa = String(waNumber || '').replace(/\D/g, '');
    if (!wa) {
      const err = new Error('wa_required');
      err.status = 400;
      throw err;
    }
    const when = '1970-01-01T00:00:00.000Z';
    return withLock(async () => {
      await ensureSchema();
      await pool.query(
        `INSERT INTO agent_chat_reads (wa_number, last_read_at, forced_unread)
         VALUES ($1, $2::timestamptz, TRUE)
         ON CONFLICT (wa_number) DO UPDATE
           SET last_read_at = EXCLUDED.last_read_at,
               forced_unread = TRUE`,
        [wa, when]
      );
      return { waNumber: wa, lastReadAt: when, forcedUnread: true };
    });
  }

  return {
    getAll,
    getState,
    get,
    markRead,
    markUnread,
    file: fileFallback,
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
  const { backend, databaseUrl } = resolveAgentStoreBackend(opts);
  if (backend === 'postgres') {
    return createPostgresChatReadStore(databaseUrl, opts);
  }
  return createFileChatReadStore(opts.filePath || config.agent.chatReadsPath);
}

module.exports = {
  createChatReadStore,
  createFileChatReadStore,
  createPostgresChatReadStore,
};
