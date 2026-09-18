'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { getSharedPool, resolveDeskSettingsBackend } = require('./pg');

/**
 * Soft-delete / archive / clear metadata per WhatsApp number for the agent desk.
 * Complements transcript storage (chat_messages) and read cursors.
 *
 * Columns (logical):
 * - deleted_at  — soft delete; chat hidden from all desk lists
 * - archived_at — archived; hidden from main inbox
 * - cleared_at  — hide transcript messages at/before this timestamp
 */

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

function isoOf(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function emptyRow(wa) {
  return {
    waNumber: wa,
    archivedAt: null,
    deletedAt: null,
    clearedAt: null,
  };
}

function mapRow(row) {
  return {
    waNumber: normalizeWa(row.wa_number || row.waNumber),
    archivedAt: isoOf(row.archived_at != null ? row.archived_at : row.archivedAt),
    deletedAt: isoOf(row.deleted_at != null ? row.deleted_at : row.deletedAt),
    clearedAt: isoOf(row.cleared_at != null ? row.cleared_at : row.clearedAt),
  };
}

function createFileChatMetaStore(filePath = config.agent.chatMetaPath) {
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
    if (!fs.existsSync(file)) return { chats: {} };
    try {
      const raw = await fs.promises.readFile(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.chats !== 'object' || !parsed.chats) {
        return { chats: {} };
      }
      return { chats: parsed.chats };
    } catch {
      return { chats: {} };
    }
  }

  async function writeAllUnlocked(data) {
    const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2, 8)}.tmp`;
    await fs.promises.writeFile(
      tmp,
      `${JSON.stringify({ chats: data.chats || {} }, null, 2)}\n`,
      'utf8'
    );
    await fs.promises.rename(tmp, file);
  }

  async function getMap() {
    return withLock(async () => {
      const data = await readAllUnlocked();
      const out = {};
      for (const [key, value] of Object.entries(data.chats || {})) {
        const wa = normalizeWa(key);
        if (!wa) continue;
        out[wa] = mapRow({ wa_number: wa, ...value });
      }
      return out;
    });
  }

  async function get(waNumber) {
    const wa = normalizeWa(waNumber);
    if (!wa) return emptyRow('');
    const map = await getMap();
    return map[wa] || emptyRow(wa);
  }

  async function patch(waNumber, fields) {
    const wa = requireWa(waNumber);
    return withLock(async () => {
      const data = await readAllUnlocked();
      const current = data.chats[wa] || {};
      const next = {
        archived_at:
          fields.archivedAt !== undefined
            ? fields.archivedAt
            : current.archived_at || null,
        deleted_at:
          fields.deletedAt !== undefined
            ? fields.deletedAt
            : current.deleted_at || null,
        cleared_at:
          fields.clearedAt !== undefined
            ? fields.clearedAt
            : current.cleared_at || null,
      };
      if (!next.archived_at && !next.deleted_at && !next.cleared_at) {
        delete data.chats[wa];
      } else {
        data.chats[wa] = next;
      }
      await writeAllUnlocked(data);
      return mapRow({ wa_number: wa, ...next });
    });
  }

  async function softDeleteMany(waNumbers, at = new Date().toISOString()) {
    const results = [];
    for (const wa of waNumbers) {
      results.push(await patch(wa, { deletedAt: at }));
    }
    return results;
  }

  async function undeleteMany(waNumbers) {
    const results = [];
    for (const wa of waNumbers) {
      results.push(await patch(wa, { deletedAt: null }));
    }
    return results;
  }

  async function archiveMany(waNumbers, at = new Date().toISOString()) {
    const results = [];
    for (const wa of waNumbers) {
      results.push(await patch(wa, { archivedAt: at }));
    }
    return results;
  }

  async function unarchiveMany(waNumbers) {
    const results = [];
    for (const wa of waNumbers) {
      results.push(await patch(wa, { archivedAt: null }));
    }
    return results;
  }

  async function clearMany(waNumbers, at = new Date().toISOString()) {
    const results = [];
    for (const wa of waNumbers) {
      results.push(await patch(wa, { clearedAt: at }));
    }
    return results;
  }

  async function unclearedMany(entries) {
    const results = [];
    for (const entry of entries) {
      const wa = typeof entry === 'string' ? entry : entry.waNumber;
      const clearedAt =
        typeof entry === 'object' && entry && 'clearedAt' in entry
          ? entry.clearedAt
          : null;
      results.push(await patch(wa, { clearedAt }));
    }
    return results;
  }

  return {
    getMap,
    get,
    softDeleteMany,
    undeleteMany,
    archiveMany,
    unarchiveMany,
    clearMany,
    unclearedMany,
    backend: 'file',
    file,
  };
}

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS agent_chat_meta (
  wa_number TEXT PRIMARY KEY,
  archived_at TIMESTAMPTZ NULL,
  deleted_at TIMESTAMPTZ NULL,
  cleared_at TIMESTAMPTZ NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`;

function createPostgresChatMetaStore(connectionString) {
  if (!connectionString) {
    throw new Error('DATABASE_URL is required for postgres chat meta store');
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

  async function getMap() {
    await ensureSchema();
    const { rows } = await pool.query(
      `SELECT wa_number, archived_at, deleted_at, cleared_at FROM agent_chat_meta`
    );
    const out = {};
    for (const row of rows) {
      const mapped = mapRow(row);
      if (mapped.waNumber) out[mapped.waNumber] = mapped;
    }
    return out;
  }

  async function get(waNumber) {
    const wa = normalizeWa(waNumber);
    if (!wa) return emptyRow('');
    await ensureSchema();
    const { rows } = await pool.query(
      `SELECT wa_number, archived_at, deleted_at, cleared_at
       FROM agent_chat_meta WHERE wa_number = $1`,
      [wa]
    );
    return rows[0] ? mapRow(rows[0]) : emptyRow(wa);
  }

  async function upsertMany(waNumbers, column, value) {
    await ensureSchema();
    const results = [];
    const when = value;
    for (const raw of waNumbers) {
      const wa = requireWa(raw);
      if (when == null) {
        await pool.query(
          `INSERT INTO agent_chat_meta (wa_number, ${column}, updated_at)
           VALUES ($1, NULL, NOW())
           ON CONFLICT (wa_number) DO UPDATE
             SET ${column} = NULL, updated_at = NOW()`,
          [wa]
        );
      } else {
        await pool.query(
          `INSERT INTO agent_chat_meta (wa_number, ${column}, updated_at)
           VALUES ($1, $2::timestamptz, NOW())
           ON CONFLICT (wa_number) DO UPDATE
             SET ${column} = EXCLUDED.${column}, updated_at = NOW()`,
          [wa, when]
        );
      }
      results.push(await get(wa));
    }
    return results;
  }

  async function softDeleteMany(waNumbers, at = new Date().toISOString()) {
    return upsertMany(waNumbers, 'deleted_at', at);
  }

  async function undeleteMany(waNumbers) {
    return upsertMany(waNumbers, 'deleted_at', null);
  }

  async function archiveMany(waNumbers, at = new Date().toISOString()) {
    return upsertMany(waNumbers, 'archived_at', at);
  }

  async function unarchiveMany(waNumbers) {
    return upsertMany(waNumbers, 'archived_at', null);
  }

  async function clearMany(waNumbers, at = new Date().toISOString()) {
    return upsertMany(waNumbers, 'cleared_at', at);
  }

  async function unclearedMany(entries) {
    const results = [];
    for (const entry of entries) {
      const wa = typeof entry === 'string' ? entry : entry.waNumber;
      const clearedAt =
        typeof entry === 'object' && entry && 'clearedAt' in entry
          ? entry.clearedAt
          : null;
      const [row] = await upsertMany([wa], 'cleared_at', clearedAt);
      results.push(row);
    }
    return results;
  }

  return {
    getMap,
    get,
    softDeleteMany,
    undeleteMany,
    archiveMany,
    unarchiveMany,
    clearMany,
    unclearedMany,
    backend: 'postgres',
  };
}

/**
 * Apply meta to a listed chat: hide deleted/archived, blank cleared previews.
 * Returns null when the chat should be omitted from the inbox.
 */
function applyChatMeta(chat, meta, { includeArchived = false } = {}) {
  if (!chat) return null;
  const wa = normalizeWa(chat.waNumber);
  const row = (meta && meta[wa]) || emptyRow(wa);
  if (row.deletedAt) return null;
  if (row.archivedAt && !includeArchived) return null;
  const next = {
    ...chat,
    archivedAt: row.archivedAt,
    deletedAt: row.deletedAt,
    clearedAt: row.clearedAt,
  };
  if (row.clearedAt) {
    const lastAt = chat.lastAt ? String(chat.lastAt) : '';
    if (!lastAt || lastAt <= String(row.clearedAt)) {
      next.lastText = '';
      next.messageCount = 0;
      next.unreadCount = 0;
    }
  }
  return next;
}

function filterMessagesByClearedAt(messages, clearedAt) {
  if (!clearedAt) return messages || [];
  const cut = String(clearedAt);
  return (messages || []).filter((m) => {
    const at = m && m.at ? String(m.at) : '';
    return at && at > cut;
  });
}

/**
 * Soft-deleted / archived chats are hidden from the desk inbox. When the
 * customer messages again, revive the row so staff can see and reply —
 * otherwise new transcript rows land in a permanent black hole (delete has
 * only a short undo window and no recycle bin).
 */
async function reviveChatMetaOnInbound(chatMeta, waNumber) {
  if (!chatMeta || typeof chatMeta.get !== 'function') {
    return { revived: false };
  }
  const wa = normalizeWa(waNumber);
  if (!wa) return { revived: false, reason: 'wa_required' };
  const row = await chatMeta.get(wa);
  if (!row) return { revived: false };
  const out = { revived: false, undeleted: false, unarchived: false };
  if (row.deletedAt && typeof chatMeta.undeleteMany === 'function') {
    await chatMeta.undeleteMany([wa]);
    out.undeleted = true;
    out.revived = true;
  }
  if (row.archivedAt && typeof chatMeta.unarchiveMany === 'function') {
    await chatMeta.unarchiveMany([wa]);
    out.unarchived = true;
    out.revived = true;
  }
  return out;
}

function createChatMetaStore(options) {
  if (typeof options === 'string') {
    return createFileChatMetaStore(options);
  }
  const opts = options || {};
  const { backend, databaseUrl } = resolveDeskSettingsBackend(opts);
  if (backend === 'postgres') {
    return createPostgresChatMetaStore(databaseUrl);
  }
  return createFileChatMetaStore(opts.filePath || config.agent.chatMetaPath);
}

module.exports = {
  createChatMetaStore,
  createFileChatMetaStore,
  createPostgresChatMetaStore,
  applyChatMeta,
  filterMessagesByClearedAt,
  reviveChatMetaOnInbound,
  normalizeWa,
};
