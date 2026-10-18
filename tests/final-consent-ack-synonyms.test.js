'use strict';

/**
 * Regression: common affirmative free-text at Yes/Good menus must not
 * false-handover into quiet + agentTakenOver (silent hold until Release).
 *
 * Prompt at FINAL_CONSENT is "Ready for me to send it?" — customers often
 * reply ok / sure / yeah instead of tapping "Yes, send it". Without those
 * synonyms, matchOption misses → OFF_MENU_RECOVERY → any second miss
 * (including repeating ok, or typing yes) routes to HUMAN_HANDOVER and
 * never delivers the application link.
 *
 * Run: npm test
 */

const assert = require('assert');
const { MemorySessionStore } = require('../src/session/store');
const { FsmEngine } = require('../src/engine/fsmEngine');
const { driveToFinalConsent } = require('./melrose-path');

class CapturingLogger {
  constructor() {
    this.leads = [];
  }

  async logLead(record) {
    this.leads.push(record);
    return record;
  }
}

function makeEngine() {
  const store = new MemorySessionStore();
  const logger = new CapturingLogger();
  const sent = [];
  const engine = new FsmEngine({
    sessionStore: store,
    leadLogger: logger,
    sendMessage: async (_wa, payload) => {
      sent.push(payload);
      return { ok: true, messageId: 'wamid.test' };
    },
    notifyAgent: async () => ({ delivered: true }),
    options: { stubMarker: true },
  });
  return { store, logger, sent, engine };
}

async function assertAckReachesSendLink(ackText) {
  const { store, logger, engine } = makeEngine();
  const wa = `2782${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
  await driveToFinalConsent(engine, wa);

  let session = await store.get(wa);
  assert.strictEqual(session.currentState, 'FINAL_CONSENT');

  await engine.handleInbound(wa, ackText);
  session = await store.get(wa);

  assert.strictEqual(
    session.currentState,
    'SEND_LINK',
    `"${ackText}" at FINAL_CONSENT must reach SEND_LINK, got ${session.currentState}`
  );
  assert.strictEqual(session.status, 'soft_closed');
  assert.strictEqual(session.agentTakenOver, false);
  assert.strictEqual(logger.leads.length, 1);
  assert.strictEqual(logger.leads[0].exitReason, 'qualified_self_serve');
}

async function testFinalConsentAckSynonymsReachSendLink() {
  for (const ack of ['ok', 'okay', 'sure', 'yeah', 'yep']) {
    await assertAckReachesSendLink(ack);
  }
  // eslint-disable-next-line no-console
  console.log('✓ FINAL_CONSENT ok/okay/sure/yeah/yep reach SEND_LINK (no silent hold)');
}

async function testEmployedYeahDoesNotFalseHandover() {
  const { store, logger, engine } = makeEngine();
  const wa = '27821110099';

  await engine.handleInbound(wa, 'hi');
  await engine.handleInbound(wa, 'qualify me');
  let session = await store.get(wa);
  assert.strictEqual(session.currentState, 'EMPLOYED_INCOME_CHECK');

  await engine.handleInbound(wa, 'yeah');
  session = await store.get(wa);
  assert.strictEqual(
    session.currentState,
    'LICENSE_CHECK',
    'yeah at EMPLOYED must advance, not OFF_MENU'
  );
  assert.strictEqual(session.agentTakenOver, false);
  assert.strictEqual(logger.leads.length, 0);

  // eslint-disable-next-line no-console
  console.log('✓ EMPLOYED_INCOME_CHECK yeah advances to LICENSE (no false handover)');
}

async function testCreditOkDoesNotFalseHandover() {
  const { store, logger, engine } = makeEngine();
  const wa = '27821110088';

  await engine.handleInbound(wa, 'hi');
  await engine.handleInbound(wa, 'qualify me');
  await engine.handleInbound(wa, 'yes');
  await engine.handleInbound(wa, 'yes');
  let session = await store.get(wa);
  assert.strictEqual(session.currentState, 'CREDIT_CHECK');

  await engine.handleInbound(wa, 'ok');
  session = await store.get(wa);
  assert.strictEqual(
    session.currentState,
    'FINAL_CONSENT',
    'ok at CREDIT_CHECK must advance, not OFF_MENU → hold'
  );
  assert.strictEqual(session.agentTakenOver, false);
  assert.strictEqual(logger.leads.length, 0);

  // eslint-disable-next-line no-console
  console.log('✓ CREDIT_CHECK ok advances to FINAL_CONSENT (no false handover)');
}

async function run() {
  await testFinalConsentAckSynonymsReachSendLink();
  await testEmployedYeahDoesNotFalseHandover();
  await testCreditOkDoesNotFalseHandover();
}

module.exports = { run };

if (require.main === module) {
  run().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
