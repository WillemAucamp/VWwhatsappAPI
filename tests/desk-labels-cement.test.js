'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createLabelStore,
  DEFAULT_LABELS,
} = require('../src/agent/labelStore');

function tmpPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-cement-'));
  return path.join(dir, 'labels.json');
}

async function testDefaultCatalog() {
  const names = DEFAULT_LABELS.map((l) => l.name);
  assert.deepStrictEqual(names, [
    'Pre-approved',
    'Validated',
    'App-Link sent',
    'No License',
    'Bad Credit',
    'Unqualified',
  ]);
  const store = createLabelStore(tmpPath());
  const listed = await store.listLabels();
  assert.deepStrictEqual(
    listed.map((l) => l.name).sort(),
    names.slice().sort()
  );
  // eslint-disable-next-line no-console
  console.log('✓ cemented default labels seed on first install');
}

async function testEditsSurviveReopen() {
  const file = tmpPath();
  const store = createLabelStore(file);
  const created = await store.createLabel({ name: 'Mine', color: '#ca8a04' });
  await store.setChatLabels('27821112222', [created.id]);

  const again = createLabelStore(file);
  const listed = await again.listLabels();
  assert.ok(listed.some((l) => l.id === created.id && l.name === 'Mine'));
  assert.deepStrictEqual(await again.getChatLabelIds('27821112222'), [
    created.id,
  ]);
  // eslint-disable-next-line no-console
  console.log('✓ label edits persist across store reopen');
}

async function testDeleteDoesNotReseed() {
  const file = tmpPath();
  const store = createLabelStore(file);
  for (const row of await store.listLabels()) {
    await store.removeLabel(row.id);
  }
  assert.strictEqual((await store.listLabels()).length, 0);

  const again = createLabelStore(file);
  assert.strictEqual(
    (await again.listLabels()).length,
    0,
    'empty label list must not reseed while the file exists'
  );
  // eslint-disable-next-line no-console
  console.log('✓ deleted labels stay gone (no silent reseed)');
}

async function testMissingCementedLabelsAreFilledOnce() {
  const file = tmpPath();
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      {
        labels: [
          {
            id: 'lb_custom',
            name: 'Mine',
            color: '#363f72',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          {
            id: 'lb_old_link',
            name: 'App Link Sent',
            color: '#027eb5',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        chatLabels: { 27820001111: ['lb_custom'] },
      },
      null,
      2
    )}\n`
  );
  const store = createLabelStore(file);
  const listed = await store.listLabels();
  const names = listed.map((l) => l.name);
  assert.deepStrictEqual(
    names.slice(0, 6),
    [
      'Pre-approved',
      'Validated',
      'App-Link sent',
      'No License',
      'Bad Credit',
      'Unqualified',
    ]
  );
  assert.ok(names.includes('Mine'));
  assert.ok(!names.includes('App Link Sent'));
  assert.deepStrictEqual(await store.getChatLabelIds('27820001111'), [
    'lb_custom',
  ]);

  await store.removeLabel(listed.find((l) => l.name === 'Unqualified').id);
  const again = createLabelStore(file);
  const later = (await again.listLabels()).map((l) => l.name);
  assert.ok(!later.includes('Unqualified'));
  assert.ok(later.includes('Mine'));
  // eslint-disable-next-line no-console
  console.log('✓ first boot fills cemented labels; later deletes stick');
}

async function testLegacyVipCatalogIsReplaced() {
  const file = tmpPath();
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      {
        labels: [
          { id: 'lb_vip', name: 'VIP', color: '#128c7e', updatedAt: '2026-01-01T00:00:00.000Z' },
          { id: 'lb_followup', name: 'Follow-up', color: '#027eb5', updatedAt: '2026-01-01T00:00:00.000Z' },
          { id: 'lb_hot', name: 'Hot lead', color: '#c4530a', updatedAt: '2026-01-01T00:00:00.000Z' },
          { id: 'lb_complaint', name: 'Complaint', color: '#b42318', updatedAt: '2026-01-01T00:00:00.000Z' },
        ],
        chatLabels: {},
      },
      null,
      2
    )}\n`
  );
  const store = createLabelStore(file);
  const names = (await store.listLabels()).map((l) => l.name).sort();
  assert.ok(names.includes('Unqualified'));
  assert.ok(names.includes('App-Link sent'));
  assert.ok(!names.includes('VIP'));
  assert.ok(!names.includes('Complaint'));
  // eslint-disable-next-line no-console
  console.log('✓ old VIP/Complaint defaults are swapped for cemented labels');
}

async function main() {
  await testDefaultCatalog();
  await testEditsSurviveReopen();
  await testDeleteDoesNotReseed();
  await testMissingCementedLabelsAreFilledOnce();
  await testLegacyVipCatalogIsReplaced();
  // eslint-disable-next-line no-console
  console.log('\ndesk cemented-label tests passed.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
