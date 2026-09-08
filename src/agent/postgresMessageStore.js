'use strict';

const { Pool } = require('pg');

/**
 * Cloud Postgres / Supabase-backed transcript store for the agent desk.
 * Same shape as the file JSONL store: append / listMessages / listChats.
 */

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  wa_number TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  source TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  reply_id TEXT,
  wamid TEXT,
  at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS chat_messages_wa_at_idx
  ON chat_messages (wa_number, at DESC);
`;

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

function createPostgresMessageStore(connectionString) {
  if (!connectionString) {
    throw new Error('DATABASE_URL is required for MESSAGE_STORE=postgres');
  }

  const pool = new Pool({
    connectionString,
    ssl: connectionString.includes('localhost')
      ? undefined
      : { rejectUnauthorized: false },
    max: 5,
  });

  let ready = null;
  function ensureSchema() {
    if (!ready) {
      ready = pool.query(SCHEMA_SQL).then(() => undefined);
    }
    return ready;
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

  async function listChats() {
    await ensureSchema();
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (wa_number)
         wa_number,
         at,
         text,
         direction,
         source,
         (SELECT COUNT(*)::int FROM chat_messages c2 WHERE c2.wa_number = c.wa_number) AS message_count
       FROM chat_messages c
       ORDER BY wa_number, at DESC`
    );
    return rows
      .map((row) => ({
        waNumber: row.wa_number,
        lastAt: row.at instanceof Date ? row.at.toISOString() : String(row.at),
        lastText: row.text,
        lastDirection: row.direction,
        lastSource: row.source,
        messageCount: row.message_count,
      }))
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
    backend: 'postgres',
  };
}

module.exports = { createPostgresMessageStore };
