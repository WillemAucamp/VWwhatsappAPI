'use strict';

const { getSharedPool, normalizeDatabaseUrl } = require('./pg');

/**
 * Cloud Postgres / Supabase-backed transcript store for the agent desk.
 * Same shape as the file JSONL store: append / listMessages / listChats.
 */

const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  wa_number TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  source TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  reply_id TEXT,
  wamid TEXT,
  at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`;

const CREATE_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS chat_messages_wa_at_idx
  ON chat_messages (wa_number, at DESC)`;

function mapRow(row) {
  return {
    id: row.id,
    waNumber: row.wa_number,
    direction: row.direction,
    source: row.source,
    text: row.text,
    replyId: row.reply_id,
    wamid: row.wamid,
    at: row.at instanceof Date ? row.at.toISOString() : String(row.at),
  };
}

function normalizeWa(wa) {
  return String(wa || '').replace(/\D/g, '');
}

function normalizeReadsMap(map) {
  const out = {};
  for (const [key, value] of Object.entries(map || {})) {
    const wa = normalizeWa(key);
    if (!wa) continue;
    if (!out[wa] || String(value) > String(out[wa])) out[wa] = value;
  }
  return out;
}

function applyUnreadFloor(chat, since) {
  let n = Number(chat && chat.unreadCount) || 0;
  const customerLast =
    (chat && chat.lastDirection === 'in') ||
    (chat && chat.lastSource === 'customer');
  if (customerLast && (!since || String(chat.lastAt) > String(since))) {
    n = Math.max(n, 1);
  }
  return n;
}

function createPostgresMessageStore(connectionString) {
  if (!connectionString) {
    throw new Error('DATABASE_URL is required for MESSAGE_STORE=postgres');
  }

  const pool = getSharedPool(connectionString);

  let ready = null;
  function ensureSchema() {
    if (!ready) {
      // Separate statements: some poolers reject multi-statement queries.
      ready = pool
        .query(CREATE_TABLE_SQL)
        .then(() => pool.query(CREATE_INDEX_SQL))
        .then(() => undefined)
        .catch((err) => {
          ready = null;
          throw err;
        });
    }
    return ready;
  }

  async function ping() {
    await ensureSchema();
    const { rows } = await pool.query('select 1 as ok');
    return rows[0] && rows[0].ok === 1;
  }

  async function append(message) {
    await ensureSchema();
    const waNumber = String(message.waNumber || '');
    if (!waNumber) return null;
    const row = {
      id:
        message.id ||
        `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      waNumber,
      direction: message.direction === 'out' ? 'out' : 'in',
      source: message.source || (message.direction === 'out' ? 'bot' : 'customer'),
      text: message.text != null ? String(message.text) : '',
      replyId: message.replyId || null,
      wamid: message.wamid || null,
      at: message.at || new Date().toISOString(),
    };
    await pool.query(
      `INSERT INTO chat_messages
        (id, wa_number, direction, source, text, reply_id, wamid, at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)
       ON CONFLICT (id) DO NOTHING`,
      [
        row.id,
        row.waNumber,
        row.direction,
        row.source,
        row.text,
        row.replyId,
        row.wamid,
        row.at,
      ]
    );
    return row;
  }

  async function listMessages(waNumber, { limit = 200 } = {}) {
    await ensureSchema();
    const { rows } = await pool.query(
      `SELECT id, wa_number, direction, source, text, reply_id, wamid, at
       FROM (
         SELECT *
         FROM chat_messages
         WHERE wa_number = $1
         ORDER BY at DESC
         LIMIT $2
       ) recent
       ORDER BY at ASC`,
      [String(waNumber), limit]
    );
    return rows.map(mapRow);
  }

  async function listChats({ lastReadByWa = {} } = {}) {
    await ensureSchema();
    const reads = normalizeReadsMap(lastReadByWa);
    const readsJson = JSON.stringify(reads);
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (wa_number)
         wa_number,
         at,
         text,
         direction,
         source,
         (SELECT COUNT(*)::int FROM chat_messages c2 WHERE c2.wa_number = c.wa_number) AS message_count,
         (SELECT COUNT(*)::int
            FROM chat_messages c_in
           WHERE c_in.wa_number = c.wa_number
             AND c_in.direction = 'in'
         ) AS inbound_total,
         (SELECT COUNT(*)::int
            FROM chat_messages c3
           WHERE c3.wa_number = c.wa_number
             AND c3.direction = 'in'
             AND ($1::jsonb ->> regexp_replace(c.wa_number, '\\D', '', 'g')) IS NOT NULL
             AND c3.at > (($1::jsonb ->> regexp_replace(c.wa_number, '\\D', '', 'g'))::timestamptz)
         ) AS unread_after_read
       FROM chat_messages c
       ORDER BY wa_number, at DESC`,
      [readsJson]
    );
    return rows
      .map((row) => {
        const wa = normalizeWa(row.wa_number);
        const since = reads[wa] || null;
        // Never opened: count every inbound message so bot replies don't hide unread.
        let unreadCount = since
          ? row.unread_after_read || 0
          : row.inbound_total || 0;
        const chat = {
          waNumber: wa || String(row.wa_number || ''),
          lastAt: row.at instanceof Date ? row.at.toISOString() : String(row.at),
          lastText: row.text,
          lastDirection: row.direction,
          lastSource: row.source,
          messageCount: row.message_count,
          unreadCount,
          lastReadAt: since,
        };
        chat.unreadCount = applyUnreadFloor(chat, since);
        return chat;
      })
      .sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
  }

  async function close() {
    await pool.end();
  }

  return {
    append,
    listMessages,
    listChats,
    close,
    ping,
    backend: 'postgres',
  };
}

module.exports = { createPostgresMessageStore, normalizeDatabaseUrl };
