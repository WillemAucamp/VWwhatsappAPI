'use strict';

/**
 * Regression: terminal soft_closed must be persisted WITH pendingLead.
 *
 * Trigger: SEND_LINK send succeeds, first sessionStore.set writes
 * soft_closed, then logLead throws. Old code tried to write pendingLead in a
 * second set — if that set also threw (or the process crashed), disk stayed
 * soft_closed with pendingLead=null. The customer's next message called
 * _restart() and the qualification lead was gone forever.
 *
 * Also: logLead success + clear-set failure must not double-log on flush.
 *
 * Run: node tests/pending-lead-prepersist.test.js
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
      throw new Error('simulated lead log failure');
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

async function testSoftClosedNeverPersistsWithoutPendingLeadOnLogFailure() {
  const store = new MemorySessionStore();
  const logger = new FlakyLeadLogger();
  const writes = [];
  const origSet = store.set.bind(store);
  store.set = async (wa, session) => {
    writes.push({
      status: session.status,
      currentState: session.currentState,
      hasPendingLead: Boolean(session.pendingLead),
      exitReason: session.pendingLead && session.pendingLead.exitReason,
    });
    return origSet(wa, session);
  };

  const engine = new FsmEngine({
    sessionStore: store,
    leadLogger: logger,
    sendMessage: async () => ({ ok: true }),
    notifyAgent: async () => ({ delivered: false }),
    options: { stubMarker: true },
  });

  const wa = '27824440001';
  await driveToConfirmQualify(engine, wa);

  logger.failNext = true;
  await engine.handleInbound(wa, 'yes');

  const terminalWrites = writes.filter(
    (w) => w.currentState === 'SEND_LINK' && w.status === 'soft_closed'
  );
  assert.ok(terminalWrites.length >= 1, 'soft_closed must be persisted');
  for (const w of terminalWrites) {
    assert.strictEqual(
      w.hasPendingLead,
      true,
      'every soft_closed persist before a successful logLead clear must carry pendingLead'
    );
    assert.strictEqual(w.exitReason, 'qualified_self_serve');
  }

  const session = await store.get(wa);
  assert.strictEqual(session.status, 'soft_closed');
  assert.ok(session.pendingLead, 'pendingLead must remain queued after logLead failure');
  assert.strictEqual(logger.leads.length, 0);

  // eslint-disable-next-line no-console
  console.log('✓ soft_closed persist always includes pendingLead when logLead fails');
}

async function testClearSetFailureDoesNotDoubleLogOnFlush() {
  const store = new MemorySessionStore();
  const logger = new FlakyLeadLogger();
  let failClearSet = false;
  const origSet = store.set.bind(store);
  store.set = async (wa, session) => {
    // After logLead succeeds, engine clears pendingLead then set()s.
    // Fail only that clear write (soft_closed + pendingLead=null).
    if (
      failClearSet &&
      session.status === 'soft_closed' &&
      session.currentState === 'SEND_LINK' &&
      session.pendingLead == null
    ) {
      throw new Error('simulated clear-set failure');
    }
    return origSet(wa, session);
  };

  const engine = new FsmEngine({
    sessionStore: store,
    leadLogger: logger,
    sendMessage: async () => ({ ok: true }),
    notifyAgent: async () => ({ delivered: false }),
    options: { stubMarker: true },
  });

  const wa = '27824440002';
  await driveToConfirmQualify(engine, wa);

  failClearSet = true;
  // Must not throw — inbound already sent the terminal WhatsApp message.
  await engine.handleInbound(wa, 'yes');

  assert.strictEqual(logger.leads.length, 1, 'lead logged once during finalize');

  // Disk still has pendingLead because clear-set failed
  const mid = await store.get(wa);
  assert.strictEqual(mid.status, 'soft_closed');
  assert.ok(mid.pendingLead, 'clear-set failure leaves pendingLead on disk');

  failClearSet = false;
  await engine.handleInbound(wa, 'hello');

  assert.strictEqual(
    logger.leads.length,
    1,
    'flush after clear-set failure must not double-log the lead'
  );

  const final = await store.get(wa);
  assert.strictEqual(final.pendingLead, null);
  assert.strictEqual(final.status, 'active');
  assert.strictEqual(final.currentState, 'GREETING');

  // eslint-disable-next-line no-console
  console.log('✓ clear-set failure does not double-log on pendingLead flush');
}

async function testPendingLeadSurviveSimulatedSecondPersistOutage() {
  // Models the old hole: soft_closed written, logLead fails, second set throws.
  // With pre-queue, the first soft_closed write already has pendingLead so a
  // subsequent persist outage cannot strand soft_closed without a lead payload.
  const store = new MemorySessionStore();
  const logger = new FlakyLeadLogger();
  let rejectPostTerminalSets = false;
  let terminalPersists = 0;
  const origSet = store.set.bind(store);
  store.set = async (wa, session) => {
    if (
      session.currentState === 'SEND_LINK' &&
      session.status === 'soft_closed'
    ) {
      terminalPersists += 1;
      if (rejectPostTerminalSets && terminalPersists > 1) {
        throw new Error('simulated pendingLead persist outage');
      }
    }
    return origSet(wa, session);
  };

  const engine = new FsmEngine({
    sessionStore: store,
    leadLogger: logger,
    sendMessage: async () => ({ ok: true }),
    notifyAgent: async () => ({ delivered: false }),
    options: { stubMarker: true },
  });

  const wa = '27824440003';
  await driveToConfirmQualify(engine, wa);

  logger.failNext = true;
  rejectPostTerminalSets = true;
  await engine.handleInbound(wa, 'yes');

  const session = await store.get(wa);
  assert.strictEqual(session.status, 'soft_closed');
  assert.ok(
    session.pendingLead,
    'first soft_closed write must retain pendingLead when later sets fail'
  );
  assert.strictEqual(session.pendingLead.exitReason, 'qualified_self_serve');
  assert.strictEqual(logger.leads.length, 0);

  rejectPostTerminalSets = false;
  await engine.handleInbound(wa, 'hello');
  assert.strictEqual(logger.leads.length, 1);
  assert.strictEqual(logger.leads[0].exitReason, 'qualified_self_serve');

  // eslint-disable-next-line no-console
  console.log('✓ pendingLead survives post-terminal persist outage');
}

async function main() {
  // eslint-disable-next-line no-console
  console.log('Running pendingLead pre-persist regression tests…\n');
  await testSoftClosedNeverPersistsWithoutPendingLeadOnLogFailure();
  await testClearSetFailureDoesNotDoubleLogOnFlush();
  await testPendingLeadSurviveSimulatedSecondPersistOutage();
  // eslint-disable-next-line no-console
  console.log('\nAll pendingLead pre-persist regression tests passed.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('\nTest failed:', err);
  process.exit(1);
});
