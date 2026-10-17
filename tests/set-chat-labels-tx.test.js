'use strict';

/**
 * Postgres setChatLabels must replace assignments in one transaction.
 * A non-transactional DELETE + INSERT wiped chatLabels when INSERT failed.
 */

const assert = require('assert');

const pg = require('pg');
const clientCalls = [];
let insertShouldFail = false;
let schemaReady = false;

class FakeClient {
  async query(sql, params) {
    const text = String(sql);
    clientCalls.push({ sql: text, params: params || null });
    if (/^BEGIN$/i.test(text.trim())) return { rows: [] };
    if (/^COMMIT$/i.test(text.trim())) return { rows: [] };
    if (/^ROLLBACK$/i.test(text.trim())) return { rows: [] };
    if (/DELETE FROM agent_chat_labels/i.test(text)) return { rowCount: 1, rows: [] };
    if (/INSERT INTO agent_chat_labels/i.test(text)) {
      if (insertShouldFail) {
        const err = new Error('insert boom');
        err.code = '23503';
        throw err;
      }
      return { rowCount: 1, rows: [] };
    }
    return { rows: [] };
  }

  release() {}
}

class FakePool {
  async connect() {
    return new FakeClient();
  }

  async query(sql) {
    const text = String(sql);
    if (/CREATE TABLE IF NOT EXISTS agent_desk_meta/i.test(text)) {
      schemaReady = true;
      return { rows: [] };
    }
    if (/CREATE TABLE IF NOT EXISTS agent_labels/i.test(text)) return { rows: [] };
    if (/CREATE TABLE IF NOT EXISTS agent_chat_labels/i.test(text)) return { rows: [] };
    if (/FROM agent_desk_meta/i.test(text) || /INTO agent_desk_meta/i.test(text)) {
      // Already seeded so seedIfNeeded is a no-op after labels exist.
      if (/SELECT value FROM agent_desk_meta/i.test(text)) {
        return { rows: [{ value: '1' }] };
      }
      return { rows: [] };
    }
    if (/SELECT id, name, color, updated_at FROM agent_labels/i.test(text)) {
      return {
        rows: [
          {
            id: 'lb_a',
            name: 'Pre-approved',
            color: '#067647',
            updated_at: new Date().toISOString(),
          },
          {
            id: 'lb_b',
            name: 'Validated',
            color: '#6941c6',
            updated_at: new Date().toISOString(),
          },
        ],
      };
    }
    if (/SELECT id FROM agent_labels/i.test(text)) {
      return { rows: [{ id: 'lb_a' }, { id: 'lb_b' }] };
    }
    if (/INSERT INTO agent_labels/i.test(text)) return { rows: [] };
    if (/DELETE FROM agent_/i.test(text)) return { rowCount: 0, rows: [] };
    return { rows: [] };
  }
}

pg.Pool = FakePool;

const { createPostgresLabelStore } = require('../src/agent/labelStore');

async function testReplaceUsesTransactionAndCommits() {
  clientCalls.length = 0;
  insertShouldFail = false;
  schemaReady = false;
  const store = createPostgresLabelStore(
    'postgresql://u:p@localhost:5432/labels_tx_ok'
  );
  const result = await store.setChatLabels('27821110000', ['lb_a', 'lb_b']);
  assert.deepStrictEqual(result.labelIds, ['lb_a', 'lb_b']);
  assert.ok(schemaReady, 'schema must be ensured');

  const sqls = clientCalls.map((c) => c.sql.replace(/\s+/g, ' ').trim());
  assert.ok(sqls.some((s) => /^BEGIN$/i.test(s)), 'must BEGIN');
  assert.ok(
    sqls.some((s) => /DELETE FROM agent_chat_labels/i.test(s)),
    'must DELETE inside the client transaction'
  );
  assert.strictEqual(
    sqls.filter((s) => /INSERT INTO agent_chat_labels/i.test(s)).length,
    2,
    'must INSERT each label on the same client'
  );
  assert.ok(sqls.some((s) => /^COMMIT$/i.test(s)), 'must COMMIT');
  assert.ok(!sqls.some((s) => /^ROLLBACK$/i.test(s)), 'must not ROLLBACK on success');
  // eslint-disable-next-line no-console
  console.log('✓ setChatLabels replaces labels inside BEGIN/COMMIT');
}

async function testInsertFailureRollsBack() {
  clientCalls.length = 0;
  insertShouldFail = true;
  const store = createPostgresLabelStore(
    'postgresql://u:p@localhost:5432/labels_tx_fail'
  );
  await assert.rejects(
    () => store.setChatLabels('27821110000', ['lb_a', 'lb_b']),
    /insert boom/
  );
  const sqls = clientCalls.map((c) => c.sql.replace(/\s+/g, ' ').trim());
  assert.ok(sqls.some((s) => /^BEGIN$/i.test(s)), 'must BEGIN before replace');
  assert.ok(
    sqls.some((s) => /DELETE FROM agent_chat_labels/i.test(s)),
    'DELETE still runs before the failing INSERT'
  );
  assert.ok(
    sqls.some((s) => /^ROLLBACK$/i.test(s)),
    'INSERT failure must ROLLBACK so prior chatLabels are not wiped'
  );
  assert.ok(!sqls.some((s) => /^COMMIT$/i.test(s)), 'must not COMMIT after failure');
  // eslint-disable-next-line no-console
  console.log('✓ setChatLabels rolls back when INSERT fails after DELETE');
}

async function main() {
  await testReplaceUsesTransactionAndCommits();
  await testInsertFailureRollsBack();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
