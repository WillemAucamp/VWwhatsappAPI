'use strict';

/**
 * Regression: pendingTerminalOutbound must be retried by the scheduler tick,
 * not only on the next inbound.
 *
 * Trigger: QUALIFIED_LINK Graph send fails after soft_closed + lead persist.
 * The customer already answered the last question and is waiting for the
 * application link — they will not message again. Old behavior only retried
 * on inbound, so the link was never delivered unless Meta redelivered or the
 * user nudged.
 *
 * Run: node tests/scheduler-terminal-outbound-retry.test.js
 */

const assert = require('assert');
const { MemorySessionStore } = require('../src/session/store');
const { FsmEngine } = require('../src/engine/fsmEngine');
const { FollowUpScheduler } = require('../src/followup/scheduler');

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

async function testSchedulerRetriesUndeliveredQualifiedLink() {
  const store = new MemorySessionStore();
  const logger = new CapturingLogger();
  const sent = [];
  let failSend = false;
  let clock = 1_000_000;

  const engine = new FsmEngine({
    sessionStore: store,
    leadLogger: logger,
    sendMessage: async (to, payload) => {
      if (failSend) throw new Error('simulated Graph API failure');
      sent.push({ to, meta: payload && payload.meta });
      return { ok: true };
    },
    notifyAgent: async () => ({ delivered: false }),
    options: {
      stubMarker: true,
      nowFn: () => clock,
    },
  });

  const wa = '27827770001';
  await driveToConfirmQualify(engine, wa);

  failSend = true;
  await assert.rejects(
    () => engine.handleInbound(wa, 'yes'),
    /simulated Graph API failure/
  );

  let session = await store.get(wa);
  assert.strictEqual(session.status, 'soft_closed');
  assert.ok(session.pendingTerminalOutbound);
  assert.strictEqual(logger.leads.length, 1);

  failSend = false;
  const before = sent.length;

  const scheduler = new FollowUpScheduler({
    engine,
    sessionStore: store,
    followUpConfig: {
      enabled: true,
      firstDelayMs: 30 * 60 * 1000,
      intervalMs: 4 * 60 * 60 * 1000,
      maxCount: 3,
      pollMs: 60_000,
      includePrompt: true,
      notifyAgentOnExhausted: false,
    },
    nowFn: () => clock,
  });

  // No inbound — only the scheduler tick may recover the undelivered link.
  const result = await scheduler.tick(clock);
  assert.strictEqual(result.resentTerminal, 1);
  assert.ok(sent.length > before, 'scheduler must re-send QUALIFIED_LINK');
  const last = sent[sent.length - 1];
  assert.strictEqual(last.meta && last.meta.stateId, 'QUALIFIED_LINK');

  session = await store.get(wa);
  assert.strictEqual(session.status, 'soft_closed');
  assert.strictEqual(session.currentState, 'QUALIFIED_LINK');
  assert.strictEqual(session.pendingTerminalOutbound, null);
  assert.strictEqual(logger.leads.length, 1);

  // eslint-disable-next-line no-console
  console.log('✓ scheduler retries undelivered QUALIFIED_LINK without inbound');
}

async function testSchedulerKeepsPendingWhenRetryStillFails() {
  const store = new MemorySessionStore();
  const logger = new CapturingLogger();
  let failSend = false;
  let clock = 2_000_000;

  const engine = new FsmEngine({
    sessionStore: store,
    leadLogger: logger,
    sendMessage: async () => {
      if (failSend) throw new Error('simulated Graph API failure');
      return { ok: true };
    },
    notifyAgent: async () => ({ delivered: false }),
    options: {
      stubMarker: true,
      nowFn: () => clock,
    },
  });

  const wa = '27827770002';
  await driveToConfirmQualify(engine, wa);

  failSend = true;
  await assert.rejects(() => engine.handleInbound(wa, 'yes'));

  const scheduler = new FollowUpScheduler({
    engine,
    sessionStore: store,
    followUpConfig: {
      enabled: true,
      firstDelayMs: 30 * 60 * 1000,
      intervalMs: 4 * 60 * 60 * 1000,
      maxCount: 3,
      pollMs: 60_000,
      includePrompt: true,
      notifyAgentOnExhausted: false,
    },
    nowFn: () => clock,
  });

  const result = await scheduler.tick(clock);
  assert.strictEqual(result.resentTerminal, 0);
  assert.ok(result.errors && result.errors.length === 1);
  assert.strictEqual(result.errors[0].waNumber, wa);

  const session = await store.get(wa);
  assert.ok(
    session.pendingTerminalOutbound,
    'failed scheduler retry must leave pendingTerminalOutbound for a later tick'
  );

  // eslint-disable-next-line no-console
  console.log('✓ failed scheduler terminal retry keeps pendingTerminalOutbound');
}

async function testSchedulerIsolatesTerminalRetryFailures() {
  const store = new MemorySessionStore();
  const logger = new CapturingLogger();
  let failQualified = false;
  let clock = 3_000_000;
  const followUps = [];

  const engine = new FsmEngine({
    sessionStore: store,
    leadLogger: logger,
    sendMessage: async (to, payload) => {
      if (failQualified && to === '27827770003') {
        throw new Error('simulated Graph API failure');
      }
      if (payload.meta && payload.meta.type === 'follow_up') {
        followUps.push(to);
      }
      return { ok: true };
    },
    notifyAgent: async () => ({ delivered: false }),
    options: {
      stubMarker: true,
      nowFn: () => clock,
    },
  });

  // Soft_closed with pending terminal outbound (will keep failing on retry).
  await driveToConfirmQualify(engine, '27827770003');
  failQualified = true;
  await assert.rejects(() => engine.handleInbound('27827770003', 'yes'));
  failQualified = true; // retry path still fails

  // Active session that should still receive a follow-up in the same tick.
  await engine.handleInbound('27827770004', 'hi');
  clock += 30 * 60 * 1000 + 1;

  const scheduler = new FollowUpScheduler({
    engine,
    sessionStore: store,
    followUpConfig: {
      enabled: true,
      firstDelayMs: 30 * 60 * 1000,
      intervalMs: 4 * 60 * 60 * 1000,
      maxCount: 3,
      pollMs: 60_000,
      includePrompt: true,
      notifyAgentOnExhausted: false,
    },
    nowFn: () => clock,
  });

  const result = await scheduler.tick(clock);
  assert.ok(result.errors && result.errors.length >= 1);
  assert.ok(
    followUps.includes('27827770004'),
    'active follow-up must still send when another number terminal retry fails'
  );
  assert.strictEqual(result.sent, 1);

  // eslint-disable-next-line no-console
  console.log('✓ terminal retry failure does not starve later follow-ups');
}

async function main() {
  // eslint-disable-next-line no-console
  console.log('Running scheduler terminal outbound retry regression…\n');
  await testSchedulerRetriesUndeliveredQualifiedLink();
  await testSchedulerKeepsPendingWhenRetryStillFails();
  await testSchedulerIsolatesTerminalRetryFailures();
  // eslint-disable-next-line no-console
  console.log('\nAll scheduler terminal outbound retry tests passed.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('\nTest failed:', err);
  process.exit(1);
});
