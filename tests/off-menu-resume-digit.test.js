'use strict';

/**
 * OFF_MENU recovery must not:
 * 1) Treat free-text "1" as Human-Handover after a Yes/No typo (digit means Yes).
 * 2) Clobber interruptedFrom on second miss so Release re-traps on OFF_MENU.
 *
 * Run: node tests/off-menu-resume-digit.test.js
 */

const assert = require('assert');
const { MemorySessionStore } = require('../src/session/store');
const { FsmEngine } = require('../src/engine/fsmEngine');

class CapturingLogger {
  constructor() {
    this.leads = [];
  }
  async logLead(record) {
    this.leads.push(record);
    return record;
  }
}

function createHarness() {
  const messages = [];
  const logger = new CapturingLogger();
  const store = new MemorySessionStore();
  const engine = new FsmEngine({
    sessionStore: store,
    leadLogger: logger,
    sendMessage: async (to, payload) => {
      messages.push({ to, ...payload });
      return { ok: true };
    },
    notifyAgent: async () => ({ delivered: true }),
    options: { stubMarker: true },
  });
  return {
    engine,
    store,
    logger,
    messages,
    async say(wa, text) {
      return engine.handleInbound(wa, text);
    },
    async tap(wa, replyId, title = '') {
      return engine.handleInbound(wa, title, { replyId });
    },
  };
}

async function testDigitOneRetriesPriorYes() {
  const h = createHarness();
  const wa = '27821110001';
  await h.say(wa, 'hi');
  await h.say(wa, 'qualify me');
  assert.strictEqual((await h.store.get(wa)).currentState, 'EMPLOYED_INCOME_CHECK');

  await h.say(wa, 'yes please');
  let session = await h.store.get(wa);
  assert.strictEqual(session.currentState, 'OFF_MENU_RECOVERY');
  assert.strictEqual(session.interruptedFrom, 'EMPLOYED_INCOME_CHECK');

  await h.say(wa, '1');
  session = await h.store.get(wa);
  assert.strictEqual(
    session.currentState,
    'LICENSE_CHECK',
    'free-text 1 after typo must mean Yes on prior menu, not Human-Handover'
  );
  assert.strictEqual(session.status, 'active');
  assert.strictEqual(session.agentTakenOver, false);
  assert.strictEqual(h.logger.leads.length, 0, 'must not log false human_requested');
  // eslint-disable-next-line no-console
  console.log('✓ OFF_MENU free-text 1 retries prior Yes → LICENSE_CHECK');
}

async function testYesFreeTextRetriesPriorYes() {
  const h = createHarness();
  const wa = '27821110002';
  await h.say(wa, 'hi');
  await h.say(wa, 'qualify me');
  await h.say(wa, 'yeah sure');
  assert.strictEqual((await h.store.get(wa)).currentState, 'OFF_MENU_RECOVERY');
  await h.say(wa, 'yes');
  const session = await h.store.get(wa);
  assert.strictEqual(session.currentState, 'LICENSE_CHECK');
  assert.strictEqual(session.agentTakenOver, false);
  // eslint-disable-next-line no-console
  console.log('✓ OFF_MENU free-text yes retries prior Yes');
}

async function testHumanButtonStillHandover() {
  const h = createHarness();
  const wa = '27821110003';
  await h.say(wa, 'hi');
  await h.say(wa, 'qualify me');
  await h.say(wa, 'zzzz');
  await h.tap(wa, 'human_handover', 'Human-Handover');
  const session = await h.store.get(wa);
  assert.strictEqual(session.status, 'quiet');
  assert.strictEqual(session.agentTakenOver, true);
  assert.strictEqual(h.logger.leads[0].exitReason, 'human_requested');
  // eslint-disable-next-line no-console
  console.log('✓ OFF_MENU Human-Handover button still works');
}

async function testSecondMissReleaseResumesQualifyStep() {
  const h = createHarness();
  const wa = '27821110004';
  await h.say(wa, 'hi');
  await h.say(wa, 'qualify me');
  await h.say(wa, 'yes');
  assert.strictEqual((await h.store.get(wa)).currentState, 'LICENSE_CHECK');

  await h.say(wa, 'blah');
  let session = await h.store.get(wa);
  assert.strictEqual(session.currentState, 'OFF_MENU_RECOVERY');
  assert.strictEqual(session.interruptedFrom, 'LICENSE_CHECK');

  await h.say(wa, 'blah');
  session = await h.store.get(wa);
  assert.strictEqual(session.status, 'quiet');
  assert.strictEqual(session.agentTakenOver, true);
  assert.strictEqual(
    session.interruptedFrom,
    'LICENSE_CHECK',
    'second miss must keep LICENSE_CHECK for Release, not OFF_MENU_RECOVERY'
  );

  await h.engine.releaseToBot(wa);
  session = await h.store.get(wa);
  assert.strictEqual(
    session.currentState,
    'LICENSE_CHECK',
    'Release must resume LICENSE_CHECK, not re-trap on OFF_MENU'
  );
  assert.strictEqual(session.agentTakenOver, false);
  assert.strictEqual(session.status, 'active');

  await h.say(wa, 'yes');
  session = await h.store.get(wa);
  assert.strictEqual(session.currentState, 'CREDIT_CHECK');
  assert.strictEqual(session.agentTakenOver, false);
  // eslint-disable-next-line no-console
  console.log('✓ second OFF_MENU miss → Release resumes LICENSE_CHECK');
}

async function testMainMenuDigitTwoStillWorks() {
  const h = createHarness();
  const wa = '27821110005';
  await h.say(wa, 'hi');
  await h.say(wa, 'qualify me');
  await h.say(wa, 'zzzz');
  await h.say(wa, '2');
  const session = await h.store.get(wa);
  assert.strictEqual(session.currentState, 'GREETING');
  assert.strictEqual(session.agentTakenOver, false);
  // eslint-disable-next-line no-console
  console.log('✓ OFF_MENU free-text 2 still maps to Main-Menu');
}

async function main() {
  await testDigitOneRetriesPriorYes();
  await testYesFreeTextRetriesPriorYes();
  await testHumanButtonStillHandover();
  await testSecondMissReleaseResumesQualifyStep();
  await testMainMenuDigitTwoStillWorks();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
