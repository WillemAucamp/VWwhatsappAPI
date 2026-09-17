'use strict';

/**
 * Postgres unread counting, with the driver stubbed.
 *
 * Live runs on Supabase, so the shape of these queries matters more than any
 * local run: an inbox that throws used to blank the whole desk. The cursor
 * query must degrade to lifetime totals instead of returning nothing.
 */

const assert = require('assert');

// Patch the driver before src/agent/pg.js destructures Pool from it.
const pg = require('pg');
const calls = [];
let nextResults = [];

class FakePool {
  async query(sql, params) {
    calls.push({ sql: String(sql), params: params || null });
    const next = nextResults.shift();
    if (typeof next === 'function') return next(sql, params);
    return next || { rows: [] };
  }
}
pg.Pool = FakePool;

const {
  createPostgresMessageStore,
} = require('../src/agent/postgresMessageStore');

function schemaResults() {
  // ensureSchema: create table, create index, then the media ALTERs.
  return [{ rows: [] }, { rows: [] }, ...Array(5).fill({ rows: [] })];
}

function listedRow(overrides = {}) {
  return {
    wa_number: '27612642189',
    at: '2026-09-11T06:43:00.000Z',
    text: 'Ok',
    direction: 'in',
    source: 'customer',
    message_count: 8,
    unread_total: 6,
    ...overrides,
  };
}

function newStore(name) {
  calls.length = 0;
  return createPostgresMessageStore(
    `postgresql://u:p@localhost:5432/${name}`
  );
}

async function testCursorAwareCountsAndParams() {
  const store = newStore('unread_cursor');
  nextResults = [...schemaResults(), { rows: [listedRow({ unread_total: 2 })] }];

  const chats = await store.listChats({
    lastReadByWa: { '27612642189': '2026-09-11T06:00:00.000Z' },
  });

  const listQuery = calls[calls.length - 1];
  assert.ok(
    /unnest\(\$1::text\[\], \$2::timestamptz\[\]\)/.test(listQuery.sql),
    'per-chat read cursors must be joined in SQL'
  );
  assert.ok(
    /source IS DISTINCT FROM 'agent'/.test(listQuery.sql),
    'agent messages must not count as unread'
  );
  assert.ok(
    /m\.at > r\.last_read_at/.test(listQuery.sql),
    'only messages after the cursor count'
  );
  assert.ok(
    !/media_bytes/.test(listQuery.sql),
    'inbox must never select media bytes'
  );
  assert.deepStrictEqual(listQuery.params[0], ['27612642189']);
  assert.deepStrictEqual(listQuery.params[1], ['2026-09-11T06:00:00.000Z']);

  assert.strictEqual(chats.length, 1);
  assert.strictEqual(chats[0].unreadCount, 2);
  assert.strictEqual(chats[0].waNumber, '27612642189');
  assert.strictEqual(store.unreadMode(), 'cursor-join');
  // eslint-disable-next-line no-console
  console.log('✓ cursor-aware unread query counts only unreviewed messages');
}

async function testFallsBackToTotalsWhenCursorQueryFails() {
  const store = newStore('unread_fallback');
  nextResults = [
    ...schemaResults(),
    () => {
      throw new Error('syntax error at or near "unnest"');
    },
    { rows: [listedRow({ unread_total: 6 })] },
  ];

  const chats = await store.listChats({
    lastReadByWa: { '27612642189': '2026-09-11T06:00:00.000Z' },
  });

  assert.strictEqual(chats.length, 1, 'a failed unread query must not blank the desk');
  assert.strictEqual(chats[0].waNumber, '27612642189');
  assert.strictEqual(chats[0].unreadCount, 1, 'cursor is newer than the last message');
  assert.strictEqual(store.unreadMode(), 'totals-fallback');
  const fallbackQuery = calls[calls.length - 1];
  assert.ok(
    !/unnest/.test(fallbackQuery.sql),
    'fallback must be the plain totals query'
  );
  assert.strictEqual(fallbackQuery.params, null);
  // eslint-disable-next-line no-console
  console.log('✓ unread query failure degrades to totals, never an empty inbox');
}

async function testNoCursorsUsesTotalsDirectly() {
  const store = newStore('unread_totals');
  nextResults = [...schemaResults(), { rows: [listedRow({ unread_total: 6 })] }];

  const chats = await store.listChats();

  const listQuery = calls[calls.length - 1];
  assert.ok(!/unnest/.test(listQuery.sql), 'no cursors means no join');
  assert.ok(
    /COUNT\(\*\) FILTER \(WHERE source IS DISTINCT FROM 'agent'\)/.test(listQuery.sql),
    'totals must still exclude agent messages'
  );
  assert.strictEqual(chats[0].unreadCount, 6, 'never opened: every message awaits review');
  // eslint-disable-next-line no-console
  console.log('✓ never-opened chats report every unreviewed message');
}

async function testAgentLastMessageIsNotFlooredToUnread() {
  const store = newStore('unread_agent_last');
  nextResults = [
    ...schemaResults(),
    {
      rows: [
        listedRow({
          direction: 'out',
          source: 'agent',
          text: 'Agent replied',
          unread_total: 0,
        }),
      ],
    },
  ];

  const chats = await store.listChats({
    lastReadByWa: { '27612642189': '2026-09-11T06:00:00.000Z' },
  });
  assert.strictEqual(
    chats[0].unreadCount,
    0,
    'an agent reply must not re-flag the chat as unread'
  );
  // eslint-disable-next-line no-console
  console.log('✓ agent reply as the latest message leaves the chat read');
}

/**
 * Render already had agent_chat_reads from an older deploy (no updated_at,
 * last_read_at NOT NULL). CREATE IF NOT EXISTS is a no-op there, so markRead
 * must migrate before inserting or every open-chat click 500s.
 */
async function testChatReadStoreMigratesLegacySchema() {
  const { createPostgresChatReadStore } = require('../src/agent/chatReadStore');
  calls.length = 0;
  nextResults = [
    { rows: [] }, // CREATE TABLE IF NOT EXISTS
    { rows: [] }, // ADD updated_at
    { rows: [] }, // DROP NOT NULL
    { rows: [] }, // INSERT markRead
  ];
  const store = createPostgresChatReadStore(
    'postgresql://u:p@localhost:5432/chat_reads_migrate'
  );
  const marked = await store.markRead('27612642189', '2026-09-15T07:00:00.000Z');
  assert.strictEqual(marked.forcedUnread, false);
  assert.ok(
    calls.some((c) => /ADD COLUMN IF NOT EXISTS updated_at/i.test(c.sql)),
    'must add updated_at for legacy Render tables'
  );
  assert.ok(
    calls.some((c) => /ALTER COLUMN last_read_at DROP NOT NULL/i.test(c.sql)),
    'must allow null last_read_at for mark-unread flags'
  );
  const insert = calls.find((c) => /INSERT INTO agent_chat_reads/i.test(c.sql));
  assert.ok(insert, 'markRead must insert after migrate');
  assert.deepStrictEqual(insert.params[0], '27612642189');
  assert.ok(
    !/updated_at/i.test(insert.sql),
    'markRead must not require updated_at so legacy tables still accept opens'
  );
  // eslint-disable-next-line no-console
  console.log('✓ chat read store migrates legacy agent_chat_reads schema');
}

async function main() {
  await testCursorAwareCountsAndParams();
  await testFallsBackToTotalsWhenCursorQueryFails();
  await testNoCursorsUsesTotalsDirectly();
  await testAgentLastMessageIsNotFlooredToUnread();
  await testChatReadStoreMigratesLegacySchema();
  // eslint-disable-next-line no-console
  console.log('\npostgres unread tests passed.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
