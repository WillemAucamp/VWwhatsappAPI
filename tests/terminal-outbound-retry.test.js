'use strict';

/**
 * Regression: when a soft_closed terminal Graph send fails after finalize,
 * the next inbound must retry that outbound — not _restart() the funnel.
 *
 * Trigger: QUALIFIED_LINK send throws (transient Graph 5xx). Session is
 * correctly persisted soft_closed + lead logged, but the customer never
 * received the application link. Old behavior treated the next message as
 * a soft-decline reopen and wiped the completed path back to GREETING.
 *
 * Run: node tests/terminal-outbound-retry.test.js
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

async function driveToConfirmQualify(engine, wa) {
  await engine.handleInbound(wa, 'hi');
  await engine.handleInbound(wa, '3');
  await engine.handleInbound(wa, 'yes');
  await engine.handleInbound(wa, '2');
  await engine.handleInbound(wa, 'great');
  const session = await engine.sessionStore.get(wa);
  assert.strictEqual(session.currentState, 'CONFIRM_QUALIFY');
}

async function testSoftClosedRetriesUndeliveredQualifiedLink() {
  const store = new MemorySessionStore();
  const logger = new CapturingLogger();
  const sent = [];
  let failSend = false;

  const engine = new FsmEngine({
    sessionStore: store,
    leadLogger: logger,
    sendMessage: async (to, payload) => {
      if (failSend) throw new Error('simulated Graph API failure');
      sent.push({ to, text: payload && payload.text, meta: payload && payload.meta });
      return { ok: true };
    },
    notifyAgent: async () => ({ delivered: false }),
    options: { stubMarker: true },
  });

  const wa = '27826660001';
  await driveToConfirmQualify(engine, wa);

  failSend = true;
  await assert.rejects(
    () => engine.handleInbound(wa, 'yes'),
    /simulated Graph API failure/
  );

  let session = await store.get(wa);
  assert.strictEqual(session.status, 'soft_closed');
  assert.strictEqual(session.currentState, 'QUALIFIED_LINK');
  assert.ok(
    session.pendingTerminalOutbound,
    'failed terminal send must queue pendingTerminalOutbound'
  );
  assert.strictEqual(session.pendingTerminalOutbound.stateId, 'QUALIFIED_LINK');
  assert.strictEqual(logger.leads.length, 1);
  assert.strictEqual(logger.leads[0].exitReason, 'qualified_self_serve');

  const beforeRetry = sent.length;
  failSend = false;
  // Customer nudges after silence — must re-send QUALIFIED_LINK, not GREETING
  const result = await engine.handleInbound(wa, 'hello');
  assert.strictEqual(result.resentTerminal, true);

  session = await store.get(wa);
  assert.strictEqual(session.status, 'soft_closed');
  assert.strictEqual(session.currentState, 'QUALIFIED_LINK');
  assert.strictEqual(
    session.pendingTerminalOutbound,
    null,
    'successful retry clears pendingTerminalOutbound'
  );
  assert.strictEqual(logger.leads.length, 1, 'retry must not double-log the lead');
  assert.ok(sent.length > beforeRetry, 'terminal outbound must be re-sent');
  const last = sent[sent.length - 1];
  assert.strictEqual(last.meta && last.meta.stateId, 'QUALIFIED_LINK');
  assert.ok(
    !session.path.includes('GREETING') || session.path[0] === 'GREETING',
    'path should still be the completed qualify path'
  );
  assert.deepStrictEqual(session.path.slice(-1), ['QUALIFIED_LINK']);
  assert.ok(
    session.path.includes('CONFIRM_QUALIFY'),
    'completed qualification path must not be wiped'
  );

  // Next inbound (no pending outbound) may soft-reopen as designed
  await engine.handleInbound(wa, 'hello');
  session = await store.get(wa);
  assert.strictEqual(session.status, 'active');
  assert.strictEqual(session.currentState, 'GREETING');

  // eslint-disable-next-line no-console
  console.log('✓ soft_closed retries undelivered QUALIFIED_LINK instead of restart');
}

async function testQuietRetriesUndeliveredHandover() {
  const store = new MemorySessionStore();
  const logger = new CapturingLogger();
  const sent = [];
  let failSend = false;

  const engine = new FsmEngine({
    sessionStore: store,
    leadLogger: logger,
    sendMessage: async (to, payload) => {
      if (failSend) throw new Error('simulated Graph API failure');
      sent.push({ to, meta: payload && payload.meta });
      return { ok: true };
    },
    notifyAgent: async () => ({ delivered: false }),
    options: { stubMarker: true },
  });

  const wa = '27826660002';
  await engine.handleInbound(wa, 'hi');
  await engine.handleInbound(wa, '3');

  failSend = true;
  await assert.rejects(() => engine.handleInbound(wa, 'stop'));

  let session = await store.get(wa);
  assert.strictEqual(session.status, 'quiet');
  assert.ok(session.pendingTerminalOutbound);

  failSend = false;
  const result = await engine.handleInbound(wa, 'yes');
  assert.strictEqual(result.resentTerminal, true);

  session = await store.get(wa);
  assert.strictEqual(session.status, 'quiet');
  assert.strictEqual(session.currentState, 'HUMAN_HANDOVER');
  assert.strictEqual(session.pendingTerminalOutbound, null);
  assert.ok(
    !session.path.includes('INCOME_CHECK'),
    'handover retry must not resume qualification'
  );
  const last = sent[sent.length - 1];
  assert.strictEqual(last.meta && last.meta.stateId, 'HUMAN_HANDOVER');

  // eslint-disable-next-line no-console
  console.log('✓ quiet retries undelivered HUMAN_HANDOVER instead of sales flow');
}

async function testRetryKeepsPendingWhenSendStillFails() {
  const store = new MemorySessionStore();
  const logger = new CapturingLogger();
  let failSend = false;

  const engine = new FsmEngine({
    sessionStore: store,
    leadLogger: logger,
    sendMessage: async () => {
      if (failSend) throw new Error('simulated Graph API failure');
      return { ok: true };
    },
    notifyAgent: async () => ({ delivered: false }),
    options: { stubMarker: true },
  });

  const wa = '27826660003';
  await driveToConfirmQualify(engine, wa);

  failSend = true;
  await assert.rejects(() => engine.handleInbound(wa, 'yes'));

  await assert.rejects(() => engine.handleInbound(wa, 'ping'));

  const session = await store.get(wa);
  assert.strictEqual(session.status, 'soft_closed');
  assert.strictEqual(session.currentState, 'QUALIFIED_LINK');
  assert.ok(
    session.pendingTerminalOutbound,
    'failed retry must leave pendingTerminalOutbound set'
  );
  assert.strictEqual(logger.leads.length, 1);

  // eslint-disable-next-line no-console
  console.log('✓ failed terminal retry keeps pendingTerminalOutbound');
}

async function main() {
  // eslint-disable-next-line no-console
  console.log('Running terminal outbound retry regression tests…\n');
  await testSoftClosedRetriesUndeliveredQualifiedLink();
  await testQuietRetriesUndeliveredHandover();
  await testRetryKeepsPendingWhenSendStillFails();
  // eslint-disable-next-line no-console
  console.log('\nAll terminal outbound retry regression tests passed.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('\nTest failed:', err);
  process.exit(1);
});
