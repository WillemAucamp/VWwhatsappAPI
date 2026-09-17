'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pg = require('pg');

class FakePool {
  constructor() {
    this.meta = new Map();
    this.byId = new Map();
    this.byKey = new Map();
  }

  _put(row) {
    this.byId.set(row.id, row);
    this.byKey.set(row.key, row);
  }

  async query(sql, params = []) {
    const s = String(sql);
    if (/CREATE TABLE IF NOT EXISTS/i.test(s)) return { rows: [], rowCount: 0 };
    if (/SELECT value FROM agent_desk_meta/i.test(s)) {
      const v = this.meta.get(params[0]);
      return { rows: v == null ? [] : [{ value: v }] };
    }
    if (/INSERT INTO agent_desk_meta/i.test(s)) {
      this.meta.set(params[0], String(params[1]));
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT id FROM agent_shortcuts LIMIT 1/i.test(s)) {
      const first = this.byId.keys().next();
      return { rows: first.done ? [] : [{ id: first.value }] };
    }
    if (/INSERT INTO agent_shortcuts/i.test(s)) {
      const [id, key, text, updatedAt] = params;
      if (/ON CONFLICT \(id\) DO NOTHING/i.test(s) && this.byId.has(id)) {
        return { rows: [], rowCount: 0 };
      }
      if (this.byId.has(id) || this.byKey.has(key)) {
        const err = new Error('duplicate key value violates unique constraint');
        err.code = '23505';
        throw err;
      }
      this._put({ id, key, text, updated_at: updatedAt });
      return { rows: [], rowCount: 1 };
    }
    if (/SELECT id, key, text, updated_at FROM agent_shortcuts ORDER BY key/i.test(s)) {
      const rows = [...this.byId.values()].sort((a, b) =>
        String(a.key).localeCompare(String(b.key))
      );
      return { rows };
    }
    if (/SELECT id FROM agent_shortcuts WHERE key = \$1 AND id <> \$2/i.test(s)) {
      const row = this.byKey.get(params[0]);
      if (row && row.id !== params[1]) return { rows: [{ id: row.id }] };
      return { rows: [] };
    }
    if (/SELECT id FROM agent_shortcuts WHERE key = \$1/i.test(s)) {
      const row = this.byKey.get(params[0]);
      return { rows: row ? [{ id: row.id }] : [] };
    }
    if (/SELECT id, key, text, updated_at FROM agent_shortcuts WHERE id = \$1/i.test(s)) {
      const row = this.byId.get(params[0]);
      return { rows: row ? [row] : [] };
    }
    if (/UPDATE agent_shortcuts/i.test(s)) {
      const [id, key, text, updatedAt] = params;
      const current = this.byId.get(id);
      if (!current) return { rows: [], rowCount: 0 };
      this.byKey.delete(current.key);
      this._put({ id, key, text, updated_at: updatedAt });
      return { rows: [], rowCount: 1 };
    }
    if (/DELETE FROM agent_shortcuts WHERE id = \$1/i.test(s)) {
      const current = this.byId.get(params[0]);
      if (!current) return { rows: [], rowCount: 0 };
      this.byId.delete(current.id);
      this.byKey.delete(current.key);
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unhandled sql: ${s}`);
  }
}

pg.Pool = FakePool;

const {
  createShortcutStore,
  DEFAULT_SHORTCUTS,
} = require('../src/agent/shortcutStore');

function tmpPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-shortcuts-'));
  return path.join(dir, 'shortcuts.json');
}

function keysOf(list) {
  return list.map((s) => s.key).sort();
}

async function testDefaultCatalog() {
  const store = createShortcutStore(tmpPath());
  assert.strictEqual(store.backend, 'file');
  const listed = await store.list();
  assert.deepStrictEqual(
    keysOf(listed),
    DEFAULT_SHORTCUTS.map((s) => s.key).sort()
  );
  // eslint-disable-next-line no-console
  console.log('✓ default shortcuts seed on first install');
}

async function testAddSurvivesReopen() {
  const file = tmpPath();
  const store = createShortcutStore(file);
  const created = await store.create({
    key: '/TradeIn',
    text: 'Happy to look at a trade-in.\n\nSend a few photos when you can.',
  });
  assert.strictEqual(created.key, 'tradein');
  assert.ok(created.text.includes('\n\n'));

  const again = createShortcutStore(file);
  const listed = await again.list();
  const found = listed.find((s) => s.id === created.id);
  assert.ok(found, 'custom shortcut must still be listed after reopen');
  assert.strictEqual(found.key, 'tradein');
  assert.strictEqual(found.text, created.text);
  // eslint-disable-next-line no-console
  console.log('✓ added shortcuts persist across store reopen (UI refresh)');
}

async function testDeleteDoesNotReseed() {
  const file = tmpPath();
  const store = createShortcutStore(file);
  const greeting = (await store.list()).find((s) => s.key === 'greeting');
  assert.ok(greeting);
  await store.remove(greeting.id);
  for (const row of await store.list()) {
    await store.remove(row.id);
  }
  assert.strictEqual((await store.list()).length, 0);

  const again = createShortcutStore(file);
  assert.strictEqual(
    (await again.list()).length,
    0,
    'empty shortcut list must not reseed while the file exists'
  );
  // eslint-disable-next-line no-console
  console.log('✓ deleted shortcuts stay gone (no silent reseed)');
}

async function testMissingFileReseedsOnce() {
  const file = tmpPath();
  const store = createShortcutStore(file);
  await store.list();
  fs.unlinkSync(file);
  const again = createShortcutStore(file);
  const listed = await again.list();
  assert.deepStrictEqual(
    keysOf(listed),
    DEFAULT_SHORTCUTS.map((s) => s.key).sort()
  );
  // eslint-disable-next-line no-console
  console.log('✓ missing file reseeds defaults on a fresh install');
}

function testBackendSelection() {
  const file = tmpPath();
  const fileStore = createShortcutStore(file);
  assert.strictEqual(fileStore.backend, 'file');

  const pgStore = createShortcutStore({
    backend: 'postgres',
    databaseUrl: 'postgresql://u:p@localhost:5432/shortcuts_backend',
  });
  assert.strictEqual(pgStore.backend, 'postgres');
  ['list', 'create', 'update', 'remove'].forEach((fn) => {
    assert.strictEqual(
      typeof pgStore[fn],
      'function',
      `postgres shortcut store must expose ${fn}`
    );
  });

  const auto = createShortcutStore({
    databaseUrl: 'postgresql://u:p@localhost:5432/shortcuts_auto',
  });
  assert.strictEqual(auto.backend, 'postgres');
  // eslint-disable-next-line no-console
  console.log('✓ shortcuts go to Postgres whenever DATABASE_URL is set');
}

async function testPostgresAddAndDeleteSurviveReopen() {
  const url = 'postgresql://u:p@localhost:5432/shortcuts_persist';
  const store = createShortcutStore({ backend: 'postgres', databaseUrl: url });
  const first = await store.list();
  assert.deepStrictEqual(
    keysOf(first),
    DEFAULT_SHORTCUTS.map((s) => s.key).sort()
  );

  const created = await store.create({
    key: 'hours-extra',
    text: 'We also open late on Thursday.',
  });
  const greeting = first.find((s) => s.key === 'greeting');
  await store.remove(greeting.id);

  const again = createShortcutStore({ backend: 'postgres', databaseUrl: url });
  const listed = await again.list();
  assert.ok(listed.some((s) => s.id === created.id && s.key === 'hours-extra'));
  assert.ok(!listed.some((s) => s.key === 'greeting'));
  // eslint-disable-next-line no-console
  console.log('✓ postgres add/delete survive a new store (refresh / redeploy)');
}

async function testPostgresEmptyFileIsNotReseeded() {
  const file = tmpPath();
  fs.writeFileSync(
    file,
    `${JSON.stringify({ shortcuts: [], meta: { shortcuts_seeded: true } }, null, 2)}\n`
  );
  const store = createShortcutStore({
    backend: 'postgres',
    databaseUrl: 'postgresql://u:p@localhost:5432/shortcuts_empty_file',
    filePath: file,
  });
  assert.strictEqual((await store.list()).length, 0);
  const again = createShortcutStore({
    backend: 'postgres',
    databaseUrl: 'postgresql://u:p@localhost:5432/shortcuts_empty_file',
    filePath: file,
  });
  assert.strictEqual((await again.list()).length, 0);
  // eslint-disable-next-line no-console
  console.log('✓ postgres honours an empty on-disk catalog (no default reseed)');
}

async function testPostgresImportsExistingFile() {
  const file = tmpPath();
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      {
        shortcuts: [
          {
            id: 'sc_custom',
            key: 'stocklist',
            text: 'Here is the current stock list.',
            updatedAt: '2026-09-01T00:00:00.000Z',
          },
        ],
        meta: { shortcuts_seeded: true },
      },
      null,
      2
    )}\n`
  );
  const store = createShortcutStore({
    backend: 'postgres',
    databaseUrl: 'postgresql://u:p@localhost:5432/shortcuts_import',
    filePath: file,
  });
  const listed = await store.list();
  assert.deepStrictEqual(keysOf(listed), ['stocklist']);
  assert.ok(!listed.some((s) => s.key === 'greeting'));
  // eslint-disable-next-line no-console
  console.log('✓ first postgres boot imports existing shortcuts instead of defaults');
}

function testHealthExposesShortcutBackend() {
  const src = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
  assert.ok(
    /shortcutStore:\s*\n\s*shortcutStore && shortcutStore\.backend/.test(src),
    'health must report the shortcut store backend'
  );
  assert.ok(
    src.includes("shortcutsPersist: 'postgres-seed-once-2026-09-17'"),
    'health must mark seed-once shortcut persistence'
  );
  // eslint-disable-next-line no-console
  console.log('✓ /health reports shortcut store backend and seed-once persist');
}

async function main() {
  await testDefaultCatalog();
  await testAddSurvivesReopen();
  await testDeleteDoesNotReseed();
  await testMissingFileReseedsOnce();
  testBackendSelection();
  await testPostgresAddAndDeleteSurviveReopen();
  await testPostgresEmptyFileIsNotReseeded();
  await testPostgresImportsExistingFile();
  testHealthExposesShortcutBackend();
  // eslint-disable-next-line no-console
  console.log('\ndesk shortcut persist tests passed.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
