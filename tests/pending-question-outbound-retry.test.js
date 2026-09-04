'use strict';

/**
 * Regression: persist-before-send for non-terminal states must queue
 * pendingQuestionOutbound so a crash between persist and Graph delivery cannot
 * turn Meta's redelivery of the prior answer into invalidAttempts → HUMAN_HANDOVER.
 *
 * Trigger: employment Yes persists AFFORDABILITY_CHECK, process dies before the
 * affordability prompt is sent. Meta redelivers employed_yes. Without a pending
 * outbound flag, stale-id rejection counts as invalid; with maxInvalidAttempts=1
 * a second redelivery falsely hands the customer to a human.
 *
 * Run: node tests/pending-question-outbound-retry.test.js
 */

const assert = require('assert');
const { MemorySessionStore, isSessionExpired } = require('../src/session/store');
const { FsmEngine } = require('../src/engine/fsmEngine');
const { FollowUpScheduler } = require('../src/followup/scheduler');
const config = require('../src/config');

class CapturingLogger {
  constructor() {
    this.leads = [];
  }

  async logLead(record) {
    this.leads.push(record);
    return record;
  }
}

async function testPendingSetDuringNonTerminalSend() {
  const store = new MemorySessionStore();
  const logger = new CapturingLogger();
  let sawPendingDuringSend = false;

  const engine = new FsmEngine({
    sessionStore: store,
    leadLogger: logger,
    sendMessage: async (to, payload) => {
      const meta = payload && payload.meta;
      if (meta && meta.stateId === 'AFFORDABILITY_CHECK') {
        const mid = await store.get(to);
        assert.strictEqual(mid.currentState, 'AFFORDABILITY_CHECK');
        assert.ok(
          mid.pendingQuestionOutbound,
          'pendingQuestionOutbound must be set until Graph confirms'
        );
        assert.strictEqual(
          mid.pendingQuestionOutbound.stateId,
          'AFFORDABILITY_CHECK'
        );
        sawPendingDuringSend = true;
      }
      return { ok: true };
    },
    notifyAgent: async () => ({ delivered: true }),
    options: { stubMarker: true },
  });

  const wa = '27825551001';
  await engine.handleInbound(wa, 'hi');
  await engine.handleInbound(wa, 'qualify me');
  await engine.handleInbound(wa, 'yes', { replyId: 'employed_yes' });

  assert.ok(sawPendingDuringSend, 'must observe pending flag during send');
  const after = await store.get(wa);
  assert.strictEqual(after.currentState, 'AFFORDABILITY_CHECK');
  assert.strictEqual(
    after.pendingQuestionOutbound,
    null,
    'pendingQuestionOutbound cleared after successful send'
  );

  // eslint-disable-next-line no-console
  console.log('✓ pendingQuestionOutbound set during send and cleared after');
}

async function testCrashBeforeSendMetaRedeliveryRetriesQuestion() {
  const store = new MemorySessionStore();
  const logger = new CapturingLogger();
  const sent = [];

  const engine = new FsmEngine({
    sessionStore: store,
    leadLogger: logger,
    sendMessage: async (to, payload) => {
      sent.push({
        stateId: payload && payload.meta && payload.meta.stateId,
        text: payload && payload.text,
      });
      return { ok: true };
    },
    notifyAgent: async () => ({ delivered: true }),
    options: { stubMarker: true },
  });

  const wa = '27825551002';
  await engine.handleInbound(wa, 'hi');
  await engine.handleInbound(wa, 'qualify me');

  // Simulate crash after persist-before-send of AFFORDABILITY, before Graph
  // delivery and before rollback (process death).
  const session = await store.get(wa);
  session.currentState = 'AFFORDABILITY_CHECK';
  session.path = ['GREETING', 'EMPLOYMENT_CHECK', 'AFFORDABILITY_CHECK'];
  session.status = 'active';
  session.invalidAttempts = 0;
  session.pendingQuestionOutbound = {
    stateId: 'AFFORDABILITY_CHECK',
    promptKey: 'affordability_check_prompt',
  };
  session.lastBotMessageAt = Date.now();
  await store.set(wa, session);

  const beforeLen = sent.length;
  // Meta redelivers the employment Yes that caused the transition.
  await engine.handleInbound(wa, 'Yes', { replyId: 'employed_yes' });

  const after = await store.get(wa);
  assert.strictEqual(
    after.currentState,
    'AFFORDABILITY_CHECK',
    'must stay on AFFORDABILITY — not escalate'
  );
  assert.strictEqual(after.status, 'active');
  assert.strictEqual(
    after.invalidAttempts,
    0,
    'stale redelivery must not burn invalidAttempts'
  );
  assert.strictEqual(after.pendingQuestionOutbound, null);
  assert.ok(
    sent.length > beforeLen,
    'affordability question must be re-sent'
  );
  assert.ok(
    sent.slice(beforeLen).some((s) => s.stateId === 'AFFORDABILITY_CHECK'),
    'retry must deliver AFFORDABILITY_CHECK body'
  );
  assert.strictEqual(logger.leads.length, 0, 'must not log a false handover lead');

  // A second redelivery after clear should be able to answer normally.
  await engine.handleInbound(wa, 'More than R15k', {
    replyId: 'income_over_15k',
  });
  const advanced = await store.get(wa);
  assert.strictEqual(advanced.currentState, 'LICENSE_CHECK');

  // eslint-disable-next-line no-console
  console.log(
    '✓ Meta redelivery after crash retries question instead of false handover'
  );
}

async function testSchedulerRetriesPendingQuestionOutbound() {
  const store = new MemorySessionStore();
  const logger = new CapturingLogger();
  const sent = [];

  const engine = new FsmEngine({
    sessionStore: store,
    leadLogger: logger,
    sendMessage: async (to, payload) => {
      sent.push(payload && payload.meta && payload.meta.stateId);
      return { ok: true };
    },
    notifyAgent: async () => ({ delivered: true }),
    options: { stubMarker: true },
  });

  const wa = '27825551003';
  await engine.handleInbound(wa, 'hi');
  await engine.handleInbound(wa, 'qualify me');

  const session = await store.get(wa);
  session.currentState = 'AFFORDABILITY_CHECK';
  session.path = ['GREETING', 'EMPLOYMENT_CHECK', 'AFFORDABILITY_CHECK'];
  session.status = 'active';
  session.pendingQuestionOutbound = {
    stateId: 'AFFORDABILITY_CHECK',
    promptKey: 'affordability_check_prompt',
  };
  session.lastBotMessageAt = Date.now();
  await store.set(wa, session);

  const before = sent.length;
  const scheduler = new FollowUpScheduler({
    engine,
    sessionStore: store,
    followUpConfig: {
      enabled: false,
      pollMs: 60_000,
      firstDelayMs: 1,
      intervalMs: 1,
      maxCount: 1,
      includePrompt: false,
      notifyAgentOnExhausted: false,
    },
  });
  const tick = await scheduler.tick();
  assert.ok(
    tick.resentQuestion >= 1,
    'scheduler must retry pendingQuestionOutbound when nudges disabled'
  );
  assert.ok(sent.length > before);
  assert.ok(sent.slice(before).includes('AFFORDABILITY_CHECK'));

  const recovered = await store.get(wa);
  assert.strictEqual(recovered.pendingQuestionOutbound, null);

  // eslint-disable-next-line no-console
  console.log('✓ scheduler retries pendingQuestionOutbound without inbound');
}

async function testTtlSkipsPendingQuestionOutbound() {
  const stale = {
    waNumber: '1',
    updatedAt: Date.now() - config.session.ttlMs - 1000,
    pendingLead: null,
    pendingTerminalOutbound: null,
    pendingQuestionOutbound: {
      stateId: 'AFFORDABILITY_CHECK',
      promptKey: 'affordability_check_prompt',
    },
  };
  assert.strictEqual(
    isSessionExpired(stale),
    false,
    'pendingQuestionOutbound must pin the session past TTL'
  );

  // eslint-disable-next-line no-console
  console.log('✓ isSessionExpired preserves sessions with pendingQuestionOutbound');
}

async function testSendFailureRollsBackPendingFlag() {
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
    notifyAgent: async () => ({ delivered: true }),
    options: { stubMarker: true },
  });

  const wa = '27825551004';
  await engine.handleInbound(wa, 'hi');
  await engine.handleInbound(wa, 'qualify me');

  failSend = true;
  await assert.rejects(
    () => engine.handleInbound(wa, 'yes', { replyId: 'employed_yes' }),
    /simulated Graph API failure/
  );

  const session = await store.get(wa);
  assert.strictEqual(session.currentState, 'EMPLOYMENT_CHECK');
  assert.strictEqual(
    session.pendingQuestionOutbound,
    null,
    'rollback must clear pendingQuestionOutbound'
  );

  // eslint-disable-next-line no-console
  console.log('✓ Graph failure rolls back pendingQuestionOutbound with state');
}

async function main() {
  // eslint-disable-next-line no-console
  console.log('Running pending-question-outbound retry regression tests…\n');
  await testPendingSetDuringNonTerminalSend();
  await testCrashBeforeSendMetaRedeliveryRetriesQuestion();
  await testSchedulerRetriesPendingQuestionOutbound();
  await testTtlSkipsPendingQuestionOutbound();
  await testSendFailureRollsBackPendingFlag();
  // eslint-disable-next-line no-console
  console.log('\nAll pending-question-outbound retry tests passed.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
