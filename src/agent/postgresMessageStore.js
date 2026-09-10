'use strict';

const { getSharedPool, normalizeDatabaseUrl } = require('./pg');

/**
 * Cloud Postgres / Supabase-backed transcript store for the agent desk.
 * Same shape as the file JSONL store: append / listMessages / listChats.
 * Inbound media bytes are stored in BYTEA so they survive Render disk wipes.
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

const MEDIA_COLUMNS_SQL = [
  'ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS media_kind TEXT',
  'ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS media_mime TEXT',
  'ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS media_filename TEXT',
  'ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS media_byte_length INTEGER',
  'ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS media_bytes BYTEA',
];

function mapRow(row) {
  const out = {
    id: row.id,
    waNumber: row.wa_number,
    direction: row.direction,
    source: row.source,
    text: row.text,
    replyId: row.reply_id,
    wamid: row.wamid,
    at: row.at instanceof Date ? row.at.toISOString() : String(row.at),
  };
  if (row.media_kind) {
    out.mediaKind = row.media_kind;
    out.mediaMime = row.media_mime || null;
    out.mediaFilename = row.media_filename || null;
    out.mediaByteLength =
      row.media_byte_length != null ? Number(row.media_byte_length) : null;
    out.hasMedia = true;
  }
  return out;
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
        .then(async () => {
          for (const sql of MEDIA_COLUMNS_SQL) {
            await pool.query(sql);
          }
        })
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
      mediaKind: message.mediaKind || null,
      mediaMime: message.mediaMime || message.mimeType || null,
      mediaFilename: message.mediaFilename || message.filename || null,
      mediaByteLength:
        message.mediaByteLength != null
          ? Number(message.mediaByteLength)
          : message.mediaBuffer
            ? message.mediaBuffer.length
            : null,
      mediaBuffer: message.mediaBuffer || null,
    };
    await pool.query(
      `INSERT INTO chat_messages
        (id, wa_number, direction, source, text, reply_id, wamid, at,
         media_kind, media_mime, media_filename, media_byte_length, media_bytes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz,
         $9, $10, $11, $12, $13)
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
        row.mediaKind,
        row.mediaMime,
        row.mediaFilename,
        row.mediaByteLength,
        row.mediaBuffer,
      ]
    );
    return mapRow({
      id: row.id,
      wa_number: row.waNumber,
      direction: row.direction,
      source: row.source,
      text: row.text,
      reply_id: row.replyId,
      wamid: row.wamid,
      at: row.at,
      media_kind: row.mediaKind,
      media_mime: row.mediaMime,
      media_filename: row.mediaFilename,
      media_byte_length: row.mediaByteLength,
    });
  }

  async function listMessages(waNumber, { limit = 200 } = {}) {
    await ensureSchema();
    const { rows } = await pool.query(
      `SELECT id, wa_number, direction, source, text, reply_id, wamid, at,
              media_kind, media_mime, media_filename, media_byte_length
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

  async function readMedia(waNumber, messageId) {
    await ensureSchema();
    const { rows } = await pool.query(
      `SELECT media_kind, media_mime, media_filename, media_bytes
       FROM chat_messages
       WHERE wa_number = $1 AND id = $2
       LIMIT 1`,
      [String(waNumber), String(messageId)]
    );
    const row = rows[0];
    if (!row || !row.media_kind || !row.media_bytes) return null;
    return {
      buffer: row.media_bytes,
      mimeType: row.media_mime || 'application/octet-stream',
      filename: row.media_filename || 'file',
      mediaKind: row.media_kind,
    };
  }

  async function countChats() {
    await ensureSchema();
    const { rows } = await pool.query(
      `SELECT COUNT(DISTINCT wa_number)::int AS n FROM chat_messages`
    );
    return rows[0] && rows[0].n != null ? Number(rows[0].n) : 0;
  }

  async function listChats({ lastReadByWa = {} } = {}) {
    await ensureSchema();
    const reads = normalizeReadsMap(lastReadByWa);
    // Two set-based scans beat N correlated COUNTs against BYTEA rows.
    // Do not select media_bytes — TOAST would stall the inbox.
    const { rows } = await pool.query(
      `SELECT
         latest.wa_number,
         latest.at,
         latest.text,
         latest.direction,
         latest.source,
         counts.message_count,
         counts.inbound_total
       FROM (
         SELECT DISTINCT ON (wa_number)
           wa_number, at, text, direction, source
         FROM chat_messages
         ORDER BY wa_number, at DESC
       ) latest
       JOIN (
         SELECT
           wa_number,
           COUNT(*)::int AS message_count,
           COUNT(*) FILTER (WHERE direction = 'in')::int AS inbound_total
         FROM chat_messages
         GROUP BY wa_number
       ) counts ON counts.wa_number = latest.wa_number`
    );
    return rows
      .map((row) => {
        const wa = normalizeWa(row.wa_number);
        const since = reads[wa] || null;
        const lastAt =
          row.at instanceof Date ? row.at.toISOString() : String(row.at);
        const customerLast =
          row.direction === 'in' || row.source === 'customer';
        let unreadCount;
        if (!since) {
          unreadCount = row.inbound_total || 0;
        } else if (customerLast && String(lastAt) > String(since)) {
          unreadCount = 1;
        } else {
          unreadCount = 0;
        }
        const chat = {
          waNumber: wa || String(row.wa_number || ''),
          lastAt,
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
    // Shared pool is also used by labels/shortcuts/reads — do not shut it.
  }

  return {
    append,
    listMessages,
    listChats,
    countChats,
    readMedia,
    close,
    ping,
    backend: 'postgres',
  };
}

module.exports = { createPostgresMessageStore, normalizeDatabaseUrl };
