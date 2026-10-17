'use strict';

/**
 * Regression: soft_closed thank-you → OFF_MENU_RECOVERY → "no" must not
 * false HUMAN_HANDOVER + agentTakenOver silent hold.
 *
 * Trigger: complete SEND_LINK (soft_closed), customer texts "thanks", then
 * declines the Human-Handover / Main-Menu offer with "no" / "no thanks" /
 * "I'm done". Old behavior treated any off-option on OFF_MENU as handover.
 *
 * Run: node tests/off-menu-decline-no-hold.test.js
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
  const agentEvents = [];
  const logger = new CapturingLogger();
  const store = new MemorySessionStore();
  const engine = new FsmEngine({
    sessionStore: store,
    leadLogger: logger,
    sendMessage: async (to, payload) => {
      messages.push({ to, ...payload });
      return { ok: true };
    },
    notifyAgent: async (event) => {
      agentEvents.push(event);
      return { delivered: true };
    },
    options: { stubMarker: true },
  });
  return { engine, store, logger, messages, agentEvents };
}

async function qualifyToSendLink(engine, wa) {
  await engine.handleInbound(wa, 'hi');
  await engine.handleInbound(wa, 'qualify me');
  await engine.handleInbound(wa, 'yes');
  await engine.handleInbound(wa, 'yes');
  await engine.handleInbound(wa, 'good');
  await engine.handleInbound(wa, 'yes');
}

async function testSoftClosedThanksThenNoGoesToMainMenu() {
  const h = createHarness();
  const wa = '27991110001';
  await qualifyToSendLink(h.engine, wa);

  let session = await h.store.get(wa);
  assert.strictEqual(session.status, 'soft_closed');
  assert.strictEqual(session.currentState, 'SEND_LINK');
  assert.strictEqual(h.logger.leads.length, 1);
  assert.strictEqual(h.logger.leads[0].exitReason, 'qualified_self_serve');

  await h.engine.handleInbound(wa, 'thanks');
  session = await h.store.get(wa);
  assert.strictEqual(session.currentState, 'OFF_MENU_RECOVERY');
  assert.strictEqual(session.status, 'active');
  assert.strictEqual(session.agentTakenOver, false);

  await h.engine.handleInbound(wa, 'no');
  session = await h.store.get(wa);
  assert.strictEqual(
    session.currentState,
    'GREETING',
    'declining talk-to-me must open Main-Menu, not HUMAN_HANDOVER'
  );
  assert.strictEqual(session.status, 'active');
  assert.strictEqual(
    session.agentTakenOver,
    false,
    'must not enter silent agent hold after "no"'
  );
  assert.strictEqual(
    h.logger.leads.length,
    1,
    'must not append a false human_requested lead'
  );
  assert.ok(
    !h.agentEvents.some((e) => e && e.type === 'handover'),
    'must not notify agent of a false handover'
  );
  // eslint-disable-next-line no-console
  console.log('✓ soft_closed thanks → no → Main-Menu (no silent hold)');
}

async function testSoftClosedGibberishThenNoThanks() {
  const h = createHarness();
  const wa = '27991110002';
  await qualifyToSendLink(h.engine, wa);
  await h.engine.handleInbound(wa, 'sfds');
  assert.strictEqual((await h.store.get(wa)).currentState, 'OFF_MENU_RECOVERY');

  await h.engine.handleInbound(wa, 'no thanks');
  const session = await h.store.get(wa);
  assert.strictEqual(session.currentState, 'GREETING');
  assert.strictEqual(session.agentTakenOver, false);
  assert.strictEqual(h.logger.leads.length, 1);
  // eslint-disable-next-line no-console
  console.log('✓ soft_closed gibberish → no thanks → Main-Menu');
}

async function testSoftClosedImDoneDecline() {
  const h = createHarness();
  const wa = '27991110003';
  await qualifyToSendLink(h.engine, wa);
  await h.engine.handleInbound(wa, 'ok cool');
  assert.strictEqual((await h.store.get(wa)).currentState, 'OFF_MENU_RECOVERY');

  await h.engine.handleInbound(wa, "I'm done");
  const session = await h.store.get(wa);
  assert.strictEqual(session.currentState, 'GREETING');
  assert.strictEqual(session.agentTakenOver, false);
  // eslint-disable-next-line no-console
  console.log('✓ soft_closed → I\'m done → Main-Menu');
}

async function testExplicitHumanStillHandover() {
  const h = createHarness();
  const wa = '27991110004';
  await qualifyToSendLink(h.engine, wa);
  await h.engine.handleInbound(wa, 'thanks');
  await h.engine.handleInbound(wa, 'human');
  const session = await h.store.get(wa);
  assert.strictEqual(session.currentState, 'HUMAN_HANDOVER');
  assert.strictEqual(session.status, 'quiet');
  assert.strictEqual(session.agentTakenOver, true);
  assert.ok(h.logger.leads.some((l) => l.exitReason === 'human_requested'));
  // eslint-disable-next-line no-console
  console.log('✓ OFF_MENU explicit human still handovers');
}

async function main() {
  await testSoftClosedThanksThenNoGoesToMainMenu();
  await testSoftClosedGibberishThenNoThanks();
  await testSoftClosedImDoneDecline();
  await testExplicitHumanStillHandover();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
