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
  const listed = await store.listLabels();
  const names = ['Unqualified', 'No License', 'Bad Credit', 'App-Link sent'];
  const byName = {};
  for (const name of names) {
    const existing = listed.find(
      (l) => String(l.name).toLowerCase().replace(/[-_]+/g, ' ') ===
        name.toLowerCase().replace(/[-_]+/g, ' ')
    );
    byName[name.toLowerCase()] = existing || (await store.createLabel({ name }));
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
  assert.deepStrictEqual(await labelNamesFor(labels, wa), ['App-Link sent']);
  // eslint-disable-next-line no-console
  console.log('✓ Yes, send it → App Link Sent');
}

async function testAdditiveAndCaseInsensitive() {
  const labels = tmpLabelStore();
  const existing = await labels.listLabels();
  const validated = existing.find((l) => l.name.toLowerCase() === 'validated');
  assert.ok(validated, 'default Validated label should exist');
  const wa = '27821110005';
  await labels.setChatLabels(wa, [validated.id]);
  const added = await labels.addChatLabelByName(wa, 'unqualified');
  assert.strictEqual(added.applied, true);
  const names = await labelNamesFor(labels, wa);
  assert.ok(names.includes('Validated'));
  assert.ok(names.includes('Unqualified'));
  const again = await labels.addChatLabelByName(wa, 'Unqualified');
  assert.strictEqual(again.reason, 'already_set');
  assert.strictEqual((await labels.getChatLabelIds(wa)).length, 2);
  const hyphen = await labels.addChatLabelByName(wa, 'App Link Sent');
  assert.strictEqual(hyphen.applied, true);
  assert.ok((await labelNamesFor(labels, wa)).includes('App-Link sent'));
  // eslint-disable-next-line no-console
  console.log('✓ auto-tag is additive and case-insensitive');
}

async function testMissingLabelDoesNotThrow() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-labels-empty-'));
  const file = path.join(dir, 'labels.json');
  fs.writeFileSync(
    file,
    `${JSON.stringify({ labels: [], chatLabels: {}, meta: { labels_seeded: true } }, null, 2)}\n`
  );
  const labels = createLabelStore(file);
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

async function testInferFromSessionPath() {
  const { inferDeskLabelNames } = require('../src/agent/deskAutoLabels');
  assert.deepStrictEqual(
    inferDeskLabelNames({
      session: {
        currentState: 'LICENSE_NO_HANDOVER',
        lastExitReason: 'no_license',
        path: ['GREETING', 'EMPLOYED_INCOME_CHECK', 'LICENSE_CHECK', 'LICENSE_NO_HANDOVER'],
      },
    }),
    ['No License']
  );
  assert.deepStrictEqual(
    inferDeskLabelNames({
      session: {
        currentState: 'SEND_LINK',
        lastExitReason: 'qualified_self_serve',
        path: ['FINAL_CONSENT', 'SEND_LINK'],
      },
    }),
    ['App-Link sent']
  );
  // eslint-disable-next-line no-console
  console.log('✓ infer labels from session path / exit reason');
}

async function testInferFromTranscriptWithoutSession() {
  const { inferDeskLabelNames } = require('../src/agent/deskAutoLabels');
  const licenseNo = inferDeskLabelNames({
    messages: [
      {
        direction: 'out',
        source: 'bot',
        text: "Do you hold a valid driver's license?",
      },
      { direction: 'in', source: 'customer', text: 'No' },
    ],
  });
  assert.deepStrictEqual(licenseNo, ['No License']);

  const unqualified = inferDeskLabelNames({
    messages: [
      {
        direction: 'out',
        source: 'bot',
        text: "Ah, unfortunately we wouldn't be able to move forward just yet, but the good news is you can definitely build towards it to get your dream car!",
      },
    ],
  });
  assert.deepStrictEqual(unqualified, ['Unqualified']);

  const consentOnly = inferDeskLabelNames({
    messages: [
      {
        direction: 'out',
        source: 'bot',
        text: 'To take the next step, I can send over a short, simple application form.\n\nReady for me to send it?',
      },
    ],
  });
  assert.deepStrictEqual(consentOnly, []);

  const sent = inferDeskLabelNames({
    messages: [
      {
        direction: 'out',
        source: 'bot',
        text: 'Click on the link below to see what you qualify for, calculate your estimated repayments, and explore the best current specials for you:',
      },
    ],
  });
  assert.deepStrictEqual(sent, ['App-Link sent']);
  // eslint-disable-next-line no-console
  console.log('✓ infer labels from transcript when session is gone');
}

async function testSyncPersistsInferredLabels() {
  const { syncInferredDeskLabels } = require('../src/agent/deskAutoLabels');
  const labels = tmpLabelStore();
  const wa = '27821119999';
  await syncInferredDeskLabels(labels, wa, {
    messages: [
      {
        direction: 'out',
        source: 'bot',
        text: 'Here is the quick plan to get your score where it needs to be:',
      },
    ],
  });
  assert.deepStrictEqual(await labelNamesFor(labels, wa), ['Bad Credit']);
  // eslint-disable-next-line no-console
  console.log('✓ inferred transcript labels are persisted on the chat');
}

async function testBackfillWorkerDoesNotUseInboxList() {
  const { createLabelBackfill } = require('../src/agent/labelBackfill');
  const { createMessageStore } = require('../src/agent/messageStore');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-backfill-'));
  const messages = createMessageStore(path.join(dir, 'tx'));
  const labels = tmpLabelStore();
  const wa = '27821118888';
  await messages.append({
    waNumber: wa,
    direction: 'out',
    source: 'bot',
    text: "Unfortunately a license is a must for vehicle finance — the only times you can use someone else's license would be for the following reasons:",
  });
  messages.listChats = async () => {
    throw new Error('backfill must not call listChats');
  };
  const worker = createLabelBackfill({
    labelStore: labels,
    messageStore: messages,
    sessionStore: { listAll: async () => [] },
    options: { batch: 2, tickMs: 2000, intervalMs: 60000 },
  });
  const result = await worker.tick();
  assert.ok(result.applied >= 1, JSON.stringify(result));
  assert.deepStrictEqual(await labelNamesFor(labels, wa), ['No License']);
  // eslint-disable-next-line no-console
  console.log('✓ background backfill labels a chat without GET /api/chats');
}

async function testBackfillSkipsWhenEmergency() {
  const { createLabelBackfill } = require('../src/agent/labelBackfill');
  const config = require('../src/config');
  const prev = config.agent.deskEmergency;
  config.agent.deskEmergency = true;
  try {
    const worker = createLabelBackfill({
      labelStore: tmpLabelStore(),
      messageStore: { listWaNumbers: async () => ['2782'], listMessages: async () => [] },
      sessionStore: { listAll: async () => [] },
    });
    const result = await worker.tick();
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.reason, 'disabled');
  } finally {
    config.agent.deskEmergency = prev;
  }
  // eslint-disable-next-line no-console
  console.log('✓ backfill skips when AGENT_DESK_EMERGENCY is on');
}

async function main() {
  await testUnqualifiedOnEmploymentNo();
  await testNoLicenseOnLicenseNo();
  await testBadCreditOnCreditBad();
  await testAppLinkSentOnYesSendIt();
  await testAdditiveAndCaseInsensitive();
  await testMissingLabelDoesNotThrow();
  await testGoodCreditDoesNotTag();
  await testInferFromSessionPath();
  await testInferFromTranscriptWithoutSession();
  await testSyncPersistsInferredLabels();
  await testBackfillWorkerDoesNotUseInboxList();
  await testBackfillSkipsWhenEmergency();
  // eslint-disable-next-line no-console
  console.log('\ndesk auto-label tests passed.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
