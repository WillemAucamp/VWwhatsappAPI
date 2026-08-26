'use strict';

/**
 * Regression: successful logLead + failed pendingLead clear must not
 * double-write the lead after process restart.
 *
 * Trigger: QUALIFIED_LINK finalize logs the lead, then sessionStore.set to
 * clear pendingLead throws (or the process dies after logLead). Old
 * _loggedLeadKeys lived only in memory, so a new FsmEngine after restart
 * flushed pendingLead and appended a duplicate CRM/log row.
 *
 * Run: node tests/pending-lead-restart-idempotency.test.js
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

function wrapStoreClearFail(store) {
  let clearFail = false;
  const origSet = store.set.bind(store);
  store.set = async (wa, session) => {
    // Fail only the write that clears pendingLead after a successful log.
    if (
      clearFail &&
      session.pendingLead == null &&
      (session.status === 'soft_closed' || session.status === 'quiet')
    ) {
      throw new Error('simulated pendingLead clear-set failure');
    }
    return origSet(wa, session);
  };
  return {
    arm() {
      clearFail = true;
    },
    disarm() {
      clearFail = false;
    },
  };
}

async function driveToConfirmQualify(engine, wa) {
  await engine.handleInbound(wa, 'hi');
  await engine.handleInbound(wa, '3');
  await engine.handleInbound(wa, 'yes');
  await engine.handleInbound(wa, '2');
  await engine.handleInbound(wa, 'great');
  const session = await engine.sessionStore.get(wa);
  assert.strictEqual(session.currentState, 'CONFIRM_QUALIFY');
}

function makeEngine(store, logger) {
  return new FsmEngine({
    sessionStore: store,
    leadLogger: logger,
    sendMessage: async () => ({ ok: true }),
    notifyAgent: async () => ({ delivered: false }),
    options: { stubMarker: true },
  });
}

async function testNoDoubleLogAfterRestartWhenClearFails() {
  const store = new MemorySessionStore();
  const logger = new CapturingLogger();
  const gate = wrapStoreClearFail(store);
  const engine = makeEngine(store, logger);

  const wa = '27824440001';
  await driveToConfirmQualify(engine, wa);

  gate.arm();
  await engine.handleInbound(wa, 'yes');
  gate.disarm();

  assert.strictEqual(logger.leads.length, 1, 'lead must be logged once before clear failure');

  const queued = await store.get(wa);
  assert.strictEqual(queued.status, 'soft_closed');
  assert.ok(queued.pendingLead, 'pendingLead remains until clear succeeds');
  assert.ok(
    queued.lastLoggedLeadKey,
    'lastLoggedLeadKey must be durable after logLead so restart is idempotent'
  );
  assert.strictEqual(
    queued.lastLoggedLeadKey,
    `${queued.pendingLead.waNumber}|${queued.pendingLead.exitReason}|${queued.pendingLead.path.join('>')}|${queued.pendingLead.timestamp}`
  );

  // New engine instance ≈ process restart (in-memory _loggedLeadKeys is empty).
  const engine2 = makeEngine(store, logger);
  await engine2.handleInbound(wa, 'hello');

  assert.strictEqual(
    logger.leads.length,
    1,
    'restart flush must not double-log when lastLoggedLeadKey matches pendingLead'
  );

  const after = await store.get(wa);
  assert.strictEqual(after.pendingLead, null);
  assert.strictEqual(after.status, 'active');
  assert.strictEqual(after.currentState, 'GREETING');

  // eslint-disable-next-line no-console
  console.log('✓ pendingLead clear-fail + restart does not double-log');
}

async function testSameProcessClearFailStillSingleLog() {
  const store = new MemorySessionStore();
  const logger = new CapturingLogger();
  const gate = wrapStoreClearFail(store);
  const engine = makeEngine(store, logger);

  const wa = '27824440002';
  await driveToConfirmQualify(engine, wa);

  gate.arm();
  await engine.handleInbound(wa, 'yes');
  gate.disarm();

  assert.strictEqual(logger.leads.length, 1);

  await engine.handleInbound(wa, 'hello');
  assert.strictEqual(logger.leads.length, 1, 'same-process flush must stay idempotent');

  // eslint-disable-next-line no-console
  console.log('✓ same-process pendingLead clear-fail flush stays single-log');
}

async function main() {
  // eslint-disable-next-line no-console
  console.log('Running pending-lead restart idempotency tests…\n');
  await testNoDoubleLogAfterRestartWhenClearFails();
  await testSameProcessClearFailStillSingleLog();
  // eslint-disable-next-line no-console
  console.log('\nAll pending-lead restart idempotency tests passed.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('\nTest failed:', err);
  process.exit(1);
});
