'use strict';

/**
 * Regression: logLead failure after terminal persist must not lose the lead.
 *
 * Trigger: SEND_LINK Graph send + sessionStore.set succeed, then
 * leadLogger.logLead throws (disk full). Old behavior left soft_closed with
 * no lead and threw — the customer's next message (or a Meta retry after
 * dedupe release) called _restart() and the qualification lead was gone.
 *
 * Run: node tests/pending-lead-flush.test.js
 */

const assert = require('assert');
const { MemorySessionStore } = require('../src/session/store');
const { FsmEngine } = require('../src/engine/fsmEngine');
const { driveToFinalConsent } = require('./melrose-path');

class FlakyLeadLogger {
  constructor() {
    this.leads = [];
    this.failNext = false;
  }

  async logLead(record) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('simulated lead log disk full');
    }
    this.leads.push(record);
    return record;
  }
}

async function driveToConfirmQualify(engine, wa) {
  await driveToFinalConsent(engine, wa);
  const session = await engine.sessionStore.get(wa);
  assert.strictEqual(session.currentState, 'FINAL_CONSENT');
}

async function testPendingLeadFlushedBeforeSoftClosedRestart() {
  const store = new MemorySessionStore();
  const logger = new FlakyLeadLogger();
  const engine = new FsmEngine({
    sessionStore: store,
    leadLogger: logger,
    sendMessage: async () => ({ ok: true }),
    notifyAgent: async () => ({ delivered: false }),
    options: { stubMarker: true },
  });

  const wa = '27823330001';
  await driveToConfirmQualify(engine, wa);

  logger.failNext = true;
  // Must not throw — terminal state is already correct; throwing would
  // release webhook dedupe and invite a soft_closed→restart with no lead.
  await engine.handleInbound(wa, 'yes');

  let session = await store.get(wa);
  assert.strictEqual(session.status, 'soft_closed');
  assert.strictEqual(session.currentState, 'SEND_LINK');
  assert.ok(session.pendingLead, 'failed logLead must queue pendingLead');
  assert.strictEqual(session.pendingLead.exitReason, 'qualified_self_serve');
  assert.strictEqual(logger.leads.length, 0);

  // Next inbound flushes the queued lead, then restarts by design
  await engine.handleInbound(wa, 'hello');

  assert.strictEqual(logger.leads.length, 1, 'pending lead must be flushed');
  assert.strictEqual(logger.leads[0].exitReason, 'qualified_self_serve');
  assert.deepStrictEqual(
    logger.leads[0].path,
    [
      'GREETING',
      'EMPLOYMENT_CHECK',
      'AFFORDABILITY_CHECK',
      'LICENSE_CHECK',
      'CREDIT_CHECK',
      'FINAL_CONSENT',
      'SEND_LINK',
    ]
  );

  session = await store.get(wa);
  assert.strictEqual(session.status, 'active');
  assert.strictEqual(session.currentState, 'GREETING');
  assert.strictEqual(session.pendingLead, null);

  // eslint-disable-next-line no-console
  console.log('✓ pendingLead flushed before soft_closed restart');
}

async function testLeadLogSuccessClearsPendingAndDoesNotDoubleLog() {
  const store = new MemorySessionStore();
  const logger = new FlakyLeadLogger();
  const engine = new FsmEngine({
    sessionStore: store,
    leadLogger: logger,
    sendMessage: async () => ({ ok: true }),
    notifyAgent: async () => ({ delivered: false }),
    options: { stubMarker: true },
  });

  const wa = '27823330002';
  await driveToConfirmQualify(engine, wa);
  await engine.handleInbound(wa, 'yes');

  const session = await store.get(wa);
  assert.strictEqual(session.status, 'soft_closed');
  assert.strictEqual(session.pendingLead, null);
  assert.strictEqual(logger.leads.length, 1);

  await engine.handleInbound(wa, 'hello');
  assert.strictEqual(logger.leads.length, 1, 'restart must not re-log the lead');

  // eslint-disable-next-line no-console
  console.log('✓ successful logLead leaves no pendingLead / no double log');
}

async function main() {
  // eslint-disable-next-line no-console
  console.log('Running pending-lead flush regression tests…\n');
  await testPendingLeadFlushedBeforeSoftClosedRestart();
  await testLeadLogSuccessClearsPendingAndDoesNotDoubleLog();
  // eslint-disable-next-line no-console
  console.log('\nAll pending-lead flush regression tests passed.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('\nTest failed:', err);
  process.exit(1);
});
