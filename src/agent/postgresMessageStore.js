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

/** Ensure a latest unreviewed message after last-read always shows as unread. */
function applyUnreadFloor(chat, since) {
  let n = Number(chat && chat.unreadCount) || 0;
  const unreviewedLast = chat && chat.lastSource !== 'agent';
  if (unreviewedLast && (!since || String(chat.lastAt) > String(since))) {
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
    const waNumber = normalizeWa(message.waNumber) || String(message.waNumber || '');
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

  function lookupKeys(waNumber) {
    const { waLookupKeys } = require('../../public/agent/deskListFilters');
    return waLookupKeys(waNumber);
  }

  async function listMessages(waNumber, { limit = 200 } = {}) {
    await ensureSchema();
    const keys = lookupKeys(waNumber);
    if (!keys.length) return [];
    const { rows } = await pool.query(
      `SELECT id, wa_number, direction, source, text, reply_id, wamid, at,
              media_kind, media_mime, media_filename, media_byte_length
       FROM (
         SELECT id, wa_number, direction, source, text, reply_id, wamid, at,
                media_kind, media_mime, media_filename, media_byte_length
         FROM chat_messages
         WHERE regexp_replace(wa_number, '\\D', '', 'g') = ANY($1::text[])
            OR wa_number = ANY($1::text[])
         ORDER BY at DESC
         LIMIT $2
       ) recent
       ORDER BY at ASC`,
      [keys, limit]
    );
    return rows.map(mapRow);
  }

  async function readMedia(waNumber, messageId) {
    await ensureSchema();
    const keys = lookupKeys(waNumber);
    if (!keys.length) return null;
    const { rows } = await pool.query(
      `SELECT media_kind, media_mime, media_filename, media_bytes
       FROM chat_messages
       WHERE id = $2
         AND (
           regexp_replace(wa_number, '\\D', '', 'g') = ANY($1::text[])
           OR wa_number = ANY($1::text[])
         )
       LIMIT 1`,
      [keys, String(messageId)]
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

  function mapListedChat(row, reads, cursorAware) {
    const wa = normalizeWa(row.wa_number);
    const since = reads[wa] || null;
    const lastAt =
      row.at instanceof Date ? row.at.toISOString() : String(row.at);
    const unreviewedLast = row.source !== 'agent';
    let unreadCount;
    if (cursorAware) {
      // SQL already excluded anything staff read before their cursor.
      unreadCount = Number(row.unread_total) || 0;
    } else if (!since) {
      unreadCount = Number(row.unread_total) || 0;
    } else if (unreviewedLast && String(lastAt) > String(since)) {
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
  }

  async function countChats() {
    await ensureSchema();
    const { rows } = await pool.query(
      `SELECT COUNT(DISTINCT wa_number)::int AS n FROM chat_messages`
    );
    return rows[0] && rows[0].n != null ? Number(rows[0].n) : 0;
  }

  // Two set-based scans beat N correlated COUNTs against BYTEA rows.
  // Do not select media_bytes — TOAST would stall the inbox.
  const LATEST_PER_CHAT_SQL = `
    SELECT DISTINCT ON (wa_number)
      wa_number, at, text, direction, source
    FROM chat_messages
    ORDER BY wa_number, at DESC`;

  /**
   * Unread = messages the desk has not reviewed since its read cursor.
   * Bot replies count (staff must review them); agent messages never do.
   */
  const CURSOR_AWARE_LIST_SQL = `
    SELECT
      latest.wa_number, latest.at, latest.text, latest.direction, latest.source,
      counts.message_count, counts.unread_total
    FROM (${LATEST_PER_CHAT_SQL}) latest
    JOIN (
      SELECT
        m.wa_number,
        COUNT(*)::int AS message_count,
        COUNT(*) FILTER (
          WHERE m.source IS DISTINCT FROM 'agent'
            AND (r.last_read_at IS NULL OR m.at > r.last_read_at)
        )::int AS unread_total
      FROM chat_messages m
      LEFT JOIN (
        SELECT * FROM unnest($1::text[], $2::timestamptz[]) AS t(wa_number, last_read_at)
      ) r ON r.wa_number = regexp_replace(m.wa_number, '\\D', '', 'g')
      GROUP BY m.wa_number
    ) counts ON counts.wa_number = latest.wa_number`;

  const TOTALS_ONLY_LIST_SQL = `
    SELECT
      latest.wa_number, latest.at, latest.text, latest.direction, latest.source,
      counts.message_count, counts.unread_total
    FROM (${LATEST_PER_CHAT_SQL}) latest
    JOIN (
      SELECT
        wa_number,
        COUNT(*)::int AS message_count,
        COUNT(*) FILTER (WHERE source IS DISTINCT FROM 'agent')::int AS unread_total
      FROM chat_messages
      GROUP BY wa_number
    ) counts ON counts.wa_number = latest.wa_number`;

  let lastUnreadMode = null;

  async function listChats({ lastReadByWa = {} } = {}) {
    await ensureSchema();
    const reads = normalizeReadsMap(lastReadByWa);
    const waKeys = Object.keys(reads);

    if (waKeys.length) {
      try {
        const { rows } = await pool.query(CURSOR_AWARE_LIST_SQL, [
          waKeys,
          waKeys.map((wa) => reads[wa]),
        ]);
        lastUnreadMode = 'cursor-join';
        return rows
          .map((row) => mapListedChat(row, reads, true))
          .sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
      } catch (err) {
        // An unread-count query must never blank the desk; fall back to totals.
        // eslint-disable-next-line no-console
        console.error('[transcript] cursor unread counts failed', err.message);
        lastUnreadMode = 'totals-fallback';
      }
    } else if (!lastUnreadMode) {
      lastUnreadMode = 'totals';
    }

    const { rows } = await pool.query(TOTALS_ONLY_LIST_SQL);
    return rows
      .map((row) => mapListedChat(row, reads, false))
      .sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
  }

  function unreadMode() {
    return lastUnreadMode;
  }

  async function searchChats({ query, lastReadByWa = {}, limit = 40 } = {}) {
    const { waNumberMatchesQuery } = require('../../public/agent/deskListFilters');
    const cap = Math.max(1, Math.min(80, Number(limit) || 40));
    // Same matcher as the desk UI. A separate LIKE scan missed stored 27…
    // numbers and could time out, which the UI treated as "not stored".
    const chats = await listChats({ lastReadByWa });
    return chats
      .filter((chat) => waNumberMatchesQuery(chat.waNumber, query))
      .slice(0, cap);
  }

  async function close() {
    // Shared pool is also used by labels/shortcuts/reads — do not shut it.
  }

  async function listWaNumbers({ limit = 20, after = '' } = {}) {
    await ensureSchema();
    const cap = Math.max(1, Number(limit) || 20);
    const { rows } = await pool.query(
      `SELECT DISTINCT wa_number
         FROM chat_messages
        WHERE ($1 = '' OR wa_number > $1)
        ORDER BY wa_number
        LIMIT $2`,
      [String(after || ''), cap]
    );
    return rows.map((row) => normalizeWa(row.wa_number)).filter(Boolean);
  }

  return {
    append,
    listMessages,
    listChats,
    searchChats,
    countChats,
    listWaNumbers,
    readMedia,
    close,
    ping,
    unreadMode,
    backend: 'postgres',
  };
}

module.exports = { createPostgresMessageStore, normalizeDatabaseUrl };
