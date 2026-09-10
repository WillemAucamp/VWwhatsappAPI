'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MemorySessionStore } = require('../src/session/store');
const { FsmEngine } = require('../src/engine/fsmEngine');
const { createLabelStore } = require('../src/agent/labelStore');
const { driveToFinalConsent, driveToSendLink } = require('./melrose-path');

class CapturingLogger {
  async logLead() {
    return {};
  }
}

function tmpLabelStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-labels-'));
  return createLabelStore(path.join(dir, 'labels.json'));
}

async function seedQualificationLabels(store) {
  const names = ['Unqualified', 'No License', 'Bad Credit', 'App Link Sent'];
  const byName = {};
  for (const name of names) {
    byName[name.toLowerCase()] = await store.createLabel({ name });
  }
  return byName;
}

function makeEngine(labelStore) {
  return new FsmEngine({
    sessionStore: new MemorySessionStore(),
    leadLogger: new CapturingLogger(),
    sendMessage: async () => ({ messages: [{ id: 'wamid.test' }] }),
    notifyAgent: async () => ({ delivered: false }),
    options: { stubMarker: true },
    labelStore,
  });
}

async function labelNamesFor(store, wa) {
  const ids = await store.getChatLabelIds(wa);
  const all = await store.listLabels();
  const byId = new Map(all.map((l) => [l.id, l.name]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

async function testUnqualifiedOnEmploymentNo() {
  const labels = tmpLabelStore();
  await seedQualificationLabels(labels);
  const engine = makeEngine(labels);
  const wa = '27821110001';
  await engine.handleInbound(wa, 'hi');
  await engine.handleInbound(wa, 'qualify me');
  await engine.handleInbound(wa, 'no');
  assert.deepStrictEqual(await labelNamesFor(labels, wa), ['Unqualified']);
  // eslint-disable-next-line no-console
  console.log('✓ employed/income No → Unqualified');
}

async function testNoLicenseOnLicenseNo() {
  const labels = tmpLabelStore();
  await seedQualificationLabels(labels);
  const engine = makeEngine(labels);
  const wa = '27821110002';
  await engine.handleInbound(wa, 'hi');
  await engine.handleInbound(wa, 'qualify me');
  await engine.handleInbound(wa, 'yes');
  await engine.handleInbound(wa, 'no');
  assert.deepStrictEqual(await labelNamesFor(labels, wa), ['No License']);
  // eslint-disable-next-line no-console
  console.log('✓ license No → No License');
}

async function testBadCreditOnCreditBad() {
  const labels = tmpLabelStore();
  await seedQualificationLabels(labels);
  const engine = makeEngine(labels);
  const wa = '27821110003';
  await engine.handleInbound(wa, 'hi');
  await engine.handleInbound(wa, 'qualify me');
  await engine.handleInbound(wa, 'yes');
  await engine.handleInbound(wa, 'yes');
  await engine.handleInbound(wa, 'bad');
  assert.deepStrictEqual(await labelNamesFor(labels, wa), ['Bad Credit']);
  // eslint-disable-next-line no-console
  console.log('✓ credit Bad → Bad Credit');
}

async function testAppLinkSentOnYesSendIt() {
  const labels = tmpLabelStore();
  await seedQualificationLabels(labels);
  const engine = makeEngine(labels);
  const wa = '27821110004';
  await driveToSendLink(engine, wa);
  assert.deepStrictEqual(await labelNamesFor(labels, wa), ['App Link Sent']);
  // eslint-disable-next-line no-console
  console.log('✓ Yes, send it → App Link Sent');
}

async function testAdditiveAndCaseInsensitive() {
  const labels = tmpLabelStore();
  const existing = await labels.listLabels();
  const vip = existing.find((l) => l.name.toLowerCase() === 'vip');
  assert.ok(vip, 'default VIP label should exist');
  await labels.createLabel({ name: 'Unqualified' });
  const wa = '27821110005';
  await labels.setChatLabels(wa, [vip.id]);
  const added = await labels.addChatLabelByName(wa, 'unqualified');
  assert.strictEqual(added.applied, true);
  const names = await labelNamesFor(labels, wa);
  assert.ok(names.includes('VIP'));
  assert.ok(names.includes('Unqualified'));
  const again = await labels.addChatLabelByName(wa, 'Unqualified');
  assert.strictEqual(again.reason, 'already_set');
  assert.strictEqual((await labels.getChatLabelIds(wa)).length, 2);
  // eslint-disable-next-line no-console
  console.log('✓ auto-tag is additive and case-insensitive');
}

async function testMissingLabelDoesNotThrow() {
  const labels = tmpLabelStore();
  const engine = makeEngine(labels);
  const wa = '27821110006';
  await engine.handleInbound(wa, 'hi');
  await engine.handleInbound(wa, 'qualify me');
  await engine.handleInbound(wa, 'no');
  assert.deepStrictEqual(await labelNamesFor(labels, wa), []);
  // eslint-disable-next-line no-console
  console.log('✓ missing Unqualified label is a no-op');
}

async function testGoodCreditDoesNotTag() {
  const labels = tmpLabelStore();
  await seedQualificationLabels(labels);
  const engine = makeEngine(labels);
  const wa = '27821110007';
  await driveToFinalConsent(engine, wa);
  assert.deepStrictEqual(await labelNamesFor(labels, wa), []);
  // eslint-disable-next-line no-console
  console.log('✓ qualifying answers do not tag until Yes, send it');
}

async function main() {
  await testUnqualifiedOnEmploymentNo();
  await testNoLicenseOnLicenseNo();
  await testBadCreditOnCreditBad();
  await testAppLinkSentOnYesSendIt();
  await testAdditiveAndCaseInsensitive();
  await testMissingLabelDoesNotThrow();
  await testGoodCreditDoesNotTag();
  // eslint-disable-next-line no-console
  console.log('\ndesk auto-label tests passed.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
