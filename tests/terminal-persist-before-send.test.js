'use strict';

/**
 * Regression: terminal transitions must persist soft_closed/quiet + pendingLead
 * BEFORE the Graph send.
 *
 * Webhook returns 200 before handleInbound finishes. If SEND_LINK Graph succeeds
 * and the process then dies (OOM/deploy) before _finalizeTerminal, disk still
 * has FINAL_CONSENT with no pendingLead. Qualified users often never message
 * again after getting the application link — the lead is lost forever.
 *
 * Run: node tests/terminal-persist-before-send.test.js
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

async function qualifyToConsent(engine, wa) {
  await engine.handleInbound(wa, 'hi');
  await engine.handleInbound(wa, 'qualify me');
  await engine.handleInbound(wa, 'yes', { replyId: 'employed_yes' });
  await engine.handleInbound(wa, 'More than R15k', {
    replyId: 'income_over_15k',
  });
  await engine.handleInbound(wa, 'yes', { replyId: 'license_yes' });
  await engine.handleInbound(wa, 'Good', { replyId: 'credit_good' });
  const session = await engine.sessionStore.get(wa);
  assert.strictEqual(session.currentState, 'FINAL_CONSENT');
}

async function testTerminalPersistedBeforeGraphSend() {
  const store = new MemorySessionStore();
  const logger = new CapturingLogger();
  const sent = [];
  let sawDurableTerminalDuringSend = false;

  const engine = new FsmEngine({
    sessionStore: store,
    leadLogger: logger,
    sendMessage: async (to, payload) => {
      const meta = payload && payload.meta;
      if (meta && meta.stateId === 'SEND_LINK') {
        const mid = await store.get(to);
        assert.strictEqual(
          mid.status,
          'soft_closed',
          'soft_closed must be on disk before SEND_LINK Graph call'
        );
        assert.ok(
          mid.pendingLead || mid.lastLoggedLeadKey,
          'qualification lead must be durable before SEND_LINK Graph call'
        );
        assert.ok(
          mid.pendingTerminalOutbound,
          'pendingTerminalOutbound must be set until Graph confirms'
        );
        assert.strictEqual(mid.currentState, 'SEND_LINK');
        sawDurableTerminalDuringSend = true;
      }
      sent.push({ to, text: payload && payload.text, meta });
      return { ok: true };
    },
    notifyAgent: async () => ({ delivered: true }),
    options: { stubMarker: true },
  });

  const wa = '27828881001';
  await qualifyToConsent(engine, wa);
  await engine.handleInbound(wa, 'Yes, send it', { replyId: 'consent_yes' });

  assert.ok(sawDurableTerminalDuringSend, 'must observe pre-send persist');
  assert.ok(
    sent.some((s) => s.meta && s.meta.stateId === 'SEND_LINK'),
    'application link must still be sent'
  );

  const after = await store.get(wa);
  assert.strictEqual(after.status, 'soft_closed');
  assert.strictEqual(after.currentState, 'SEND_LINK');
  assert.strictEqual(after.pendingTerminalOutbound, null);
  assert.strictEqual(logger.leads.length, 1);
  assert.strictEqual(logger.leads[0].exitReason, 'qualified_self_serve');

  // eslint-disable-next-line no-console
  console.log('✓ terminal soft_closed + pendingLead persisted before Graph send');
}

async function testCrashAfterSendLeavesLeadAndSchedulerRetries() {
  const store = new MemorySessionStore();
  const logger = new CapturingLogger();
  const sent = [];
  let clearAttempts = 0;

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

  const wa = '27828881002';
  await qualifyToConsent(engine, wa);

  const origSet = store.set.bind(store);
  store.set = async (num, session) => {
    // After Graph succeeds, clearing pendingTerminalOutbound is the last write.
    // Simulate process death / disk failure there: lead must remain durable and
    // pendingTerminalOutbound must stay set for scheduler recovery.
    if (
      session &&
      session.currentState === 'SEND_LINK' &&
      session.status === 'soft_closed' &&
      session.pendingTerminalOutbound == null &&
      (session.pendingLead == null || session.lastLoggedLeadKey)
    ) {
      clearAttempts += 1;
      throw new Error('simulated crash clearing pendingTerminalOutbound');
    }
    return origSet(num, session);
  };

  await engine.handleInbound(wa, 'Yes, send it', { replyId: 'consent_yes' });

  assert.ok(clearAttempts >= 1, 'clear-after-send must have been attempted');
  assert.ok(
    sent.some((s) => s.meta && s.meta.stateId === 'SEND_LINK'),
    'Graph send must have succeeded before the clear failure'
  );

  store.set = origSet;
  const crashed = await store.get(wa);
  assert.strictEqual(crashed.status, 'soft_closed');
  assert.strictEqual(crashed.currentState, 'SEND_LINK');
  assert.ok(
    crashed.pendingLead || crashed.lastLoggedLeadKey,
    'qualification must survive crash after Graph send'
  );
  assert.ok(
    crashed.pendingTerminalOutbound,
    'pendingTerminalOutbound must remain for retry'
  );
  assert.strictEqual(logger.leads.length, 1);

  const beforeRetry = sent.length;
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
  assert.ok(tick.resentTerminal >= 1, 'scheduler must retry terminal outbound');
  assert.ok(sent.length > beforeRetry, 'application link must be re-sent');

  const recovered = await store.get(wa);
  assert.strictEqual(recovered.pendingTerminalOutbound, null);

  // eslint-disable-next-line no-console
  console.log(
    '✓ crash after terminal Graph send keeps lead; scheduler retries link'
  );
}

async function testSendFailureStillPersistsTerminalAndQueuesRetry() {
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

  const wa = '27828881003';
  await qualifyToConsent(engine, wa);

  failSend = true;
  await assert.rejects(
    () => engine.handleInbound(wa, 'Yes, send it', { replyId: 'consent_yes' }),
    /simulated Graph API failure/
  );

  const session = await store.get(wa);
  assert.strictEqual(session.status, 'soft_closed');
  assert.strictEqual(session.currentState, 'SEND_LINK');
  assert.ok(session.pendingTerminalOutbound);
  assert.strictEqual(session.pendingTerminalOutbound.stateId, 'SEND_LINK');
  assert.strictEqual(logger.leads.length, 1);

  // eslint-disable-next-line no-console
  console.log('✓ Graph failure after pre-persist still queues terminal retry');
}

async function main() {
  // eslint-disable-next-line no-console
  console.log('Running terminal persist-before-send regression tests…\n');
  await testTerminalPersistedBeforeGraphSend();
  await testCrashAfterSendLeavesLeadAndSchedulerRetries();
  await testSendFailureStillPersistsTerminalAndQueuesRetry();
  // eslint-disable-next-line no-console
  console.log('\nAll terminal persist-before-send tests passed.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
