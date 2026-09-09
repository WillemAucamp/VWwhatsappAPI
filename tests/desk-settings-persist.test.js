'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createShortcutStore,
  createFileShortcutStore,
} = require('../src/agent/shortcutStore');
const {
  createLabelStore,
  createFileLabelStore,
} = require('../src/agent/labelStore');
const { createChatReadStore } = require('../src/agent/chatReadStore');

async function testShortcutEditsSurviveReopen() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-persist-sc-'));
  const file = path.join(dir, 'shortcuts.json');
  const store = createShortcutStore(file);

  const created = await store.create({
    key: 'custom',
    text: 'Keep this forever\n\nLine two',
  });
  const listed = await store.list();
  assert.ok(listed.some((s) => s.id === created.id));

  // Simulate process restart: new store instance, same durable file.
  const again = createShortcutStore(file);
  const after = await again.list();
  const found = after.find((s) => s.id === created.id);
  assert.ok(found, 'custom shortcut still present after reopen');
  assert.strictEqual(found.text, 'Keep this forever\n\nLine two');
  assert.strictEqual(found.updatedAt, created.updatedAt);

  // Explicit update is the only way text changes.
  const updated = await again.update(created.id, {
    text: 'Changed on purpose',
  });
  assert.strictEqual(updated.text, 'Changed on purpose');
  const third = createShortcutStore(file);
  const final = (await third.list()).find((s) => s.id === created.id);
  assert.strictEqual(final.text, 'Changed on purpose');

  // eslint-disable-next-line no-console
  console.log('✓ shortcut edits persist across store reopen');
}

async function testDeletingAllShortcutsDoesNotReseed() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-persist-empty-'));
  const file = path.join(dir, 'shortcuts.json');
  const store = createFileShortcutStore(file);
  const all = await store.list();
  for (const row of all) {
    await store.remove(row.id);
  }
  assert.strictEqual((await store.list()).length, 0);

  const again = createFileShortcutStore(file);
  assert.strictEqual(
    (await again.list()).length,
    0,
    'empty shortcut list must not reseed defaults while the file exists'
  );

  // eslint-disable-next-line no-console
  console.log('✓ empty shortcuts stay empty (no silent reseed)');
}

async function testCollapsedRepairRunsOnlyOnce() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-persist-repair-'));
  const file = path.join(dir, 'shortcuts.json');
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      {
        shortcuts: [
          {
            id: 'sc_legacy',
            key: 'financehelp',
            text: 'Hello 👉 age 🏛️ bank Because of all these variables',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        meta: {},
      },
      null,
      2
    )}\n`
  );

  const store = createFileShortcutStore(file);
  const first = await store.list();
  const repaired = first.find((s) => s.key === 'financehelp');
  assert.ok(repaired.text.includes('\n'));
  const firstUpdatedAt = repaired.updatedAt;

  const second = await store.list();
  const again = second.find((s) => s.key === 'financehelp');
  assert.strictEqual(again.text, repaired.text);
  assert.strictEqual(
    again.updatedAt,
    firstUpdatedAt,
    'list must not rewrite shortcut text/updatedAt after one-time repair'
  );

  // eslint-disable-next-line no-console
  console.log('✓ collapsed shortcut repair is one-time only');
}

async function testLabelAndReadEditsSurviveReopen() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-persist-lb-'));
  const labelsPath = path.join(dir, 'labels.json');
  const readsPath = path.join(dir, 'chat_reads.json');

  const labels = createLabelStore(labelsPath);
  const created = await labels.createLabel({ name: 'Mine', color: '#ca8a04' });
  await labels.setChatLabels('27821112222', [created.id]);

  const labelsAgain = createLabelStore(labelsPath);
  const map = await labelsAgain.getChatLabelsMap();
  assert.ok(map.labels.some((l) => l.id === created.id && l.name === 'Mine'));
  assert.deepStrictEqual(map.chatLabels['27821112222'], [created.id]);

  // Delete every default+custom label → must not reseed on reopen.
  for (const l of map.labels) {
    await labelsAgain.removeLabel(l.id);
  }
  assert.strictEqual((await labelsAgain.listLabels()).length, 0);
  const labelsThird = createFileLabelStore(labelsPath);
  assert.strictEqual((await labelsThird.listLabels()).length, 0);

  const reads = createChatReadStore(readsPath);
  await reads.markUnread('27821112222');
  const readsAgain = createChatReadStore(readsPath);
  const state = await readsAgain.getState();
  assert.strictEqual(state.forcedUnread['27821112222'], true);

  // eslint-disable-next-line no-console
  console.log('✓ labels and unread cursors persist; empty labels do not reseed');
}

async function testFactoryUsesPostgresWhenConfigured() {
  assert.throws(
    () => createShortcutStore({ backend: 'postgres', databaseUrl: '' }),
    /DATABASE_URL/
  );
  assert.throws(
    () => createLabelStore({ backend: 'postgres', databaseUrl: '' }),
    /DATABASE_URL/
  );
  assert.throws(
    () => createChatReadStore({ backend: 'postgres', databaseUrl: '' }),
    /DATABASE_URL/
  );

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-persist-file-'));
  const sc = createShortcutStore({
    backend: 'file',
    filePath: path.join(dir, 's.json'),
  });
  assert.strictEqual(sc.backend, 'file');

  // eslint-disable-next-line no-console
  console.log('✓ desk settings factories honor backend selection');
}

async function main() {
  await testShortcutEditsSurviveReopen();
  await testDeletingAllShortcutsDoesNotReseed();
  await testCollapsedRepairRunsOnlyOnce();
  await testLabelAndReadEditsSurviveReopen();
  await testFactoryUsesPostgresWhenConfigured();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
