'use strict';

/**
 * Regression: reopen words on OFF_MENU_RECOVERY must return to GREETING, not
 * escalate to HUMAN_HANDOVER + agentTakenOver (permanent silent hold).
 *
 * Trigger: mid-funnel typo → OFF_MENU_RECOVERY → "hi". Before the fix,
 * _handleInvalid treated "hi" as a second off-option and routed to human;
 * after agentTakeover holds, further inbound produced zero bot replies.
 *
 * Run: node tests/offmenu-reopen-no-false-handover.test.js
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

function createEngine() {
  const store = new MemorySessionStore();
  const logger = new CapturingLogger();
  const sent = [];
  const engine = new FsmEngine({
    sessionStore: store,
    leadLogger: logger,
    sendMessage: async (to, payload) => {
      sent.push({ to, text: payload && payload.text, meta: payload && payload.meta });
      return { ok: true };
    },
    notifyAgent: async () => ({ delivered: true }),
    options: { stubMarker: true },
  });
  return { store, logger, sent, engine };
}

async function driveToEmployedIncome(engine, wa) {
  await engine.handleInbound(wa, 'hi');
  await engine.handleInbound(wa, 'qualify me');
  const session = await engine.sessionStore.get(wa);
  assert.strictEqual(session.currentState, 'EMPLOYED_INCOME_CHECK');
}

async function testOffMenuReopenReturnsToGreeting() {
  const { store, logger, sent, engine } = createEngine();
  const wa = '27826662001';

  await driveToEmployedIncome(engine, wa);
  await engine.handleInbound(wa, 'zzzz');

  let session = await store.get(wa);
  assert.strictEqual(session.currentState, 'OFF_MENU_RECOVERY');
  assert.strictEqual(session.status, 'active');
  assert.strictEqual(session.agentTakenOver, false);

  const before = sent.length;
  await engine.handleInbound(wa, 'hi');

  session = await store.get(wa);
  assert.strictEqual(
    session.currentState,
    'GREETING',
    'reopen word on OFF_MENU_RECOVERY must open main menu'
  );
  assert.strictEqual(session.status, 'active');
  assert.strictEqual(
    session.agentTakenOver,
    false,
    'must not escalate to HUMAN_HANDOVER / agentTakenOver'
  );
  assert.ok(
    !logger.leads.some((l) => l.exitReason === 'human_requested'),
    'must not log a false human_requested lead'
  );
  assert.ok(
    sent.slice(before).some((m) => m.meta && m.meta.stateId === 'GREETING'),
    'must send the greeting / main menu'
  );

  // Further messages must still work (not a silent agent hold).
  const afterHoldProbe = sent.length;
  await engine.handleInbound(wa, 'qualify me');
  session = await store.get(wa);
  assert.strictEqual(session.currentState, 'EMPLOYED_INCOME_CHECK');
  assert.ok(sent.length > afterHoldProbe);

  // eslint-disable-next-line no-console
  console.log('✓ OFF_MENU_RECOVERY + hi returns to GREETING (no false handover)');
}

async function testSoftClosedOffMenuReopenReturnsToGreeting() {
  const { store, logger, engine } = createEngine();
  const wa = '27826662002';

  await driveToEmployedIncome(engine, wa);
  await engine.handleInbound(wa, 'no');
  let session = await store.get(wa);
  assert.strictEqual(session.status, 'soft_closed');

  // Off-menu free text after soft_closed → OFF_MENU_RECOVERY.
  await engine.handleInbound(wa, 'thanks');
  session = await store.get(wa);
  assert.strictEqual(session.currentState, 'OFF_MENU_RECOVERY');

  await engine.handleInbound(wa, 'hello');
  session = await store.get(wa);
  assert.strictEqual(session.currentState, 'GREETING');
  assert.strictEqual(session.agentTakenOver, false);
  assert.ok(!logger.leads.some((l) => l.exitReason === 'human_requested'));

  // eslint-disable-next-line no-console
  console.log('✓ soft_closed → OFF_MENU_RECOVERY + hello returns to GREETING');
}

async function testOffMenuHumanHandoverStillWorks() {
  const { store, engine } = createEngine();
  const wa = '27826662003';

  await driveToEmployedIncome(engine, wa);
  await engine.handleInbound(wa, 'zzzz');
  await engine.handleInbound(wa, 'Human-Handover');

  const session = await store.get(wa);
  assert.strictEqual(session.currentState, 'HUMAN_HANDOVER');
  assert.strictEqual(session.status, 'quiet');
  assert.strictEqual(session.agentTakenOver, true);

  // eslint-disable-next-line no-console
  console.log('✓ explicit Human-Handover on OFF_MENU_RECOVERY still works');
}

async function main() {
  await testOffMenuReopenReturnsToGreeting();
  await testSoftClosedOffMenuReopenReturnsToGreeting();
  await testOffMenuHumanHandoverStillWorks();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
