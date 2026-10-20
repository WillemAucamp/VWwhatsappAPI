'use strict';

/**
 * Regression: agent desk reply auto-takeOver, then Release to bot, must not
 * destroy SEND_LINK recovery or re-open a finished soft_closed funnel.
 *
 * Trigger: Graph fails on SEND_LINK → soft_closed + pendingTerminalOutbound.
 * Staff replies from /agent (silent takeOver), then Release to bot. Old
 * releaseToBot path-walked to FINAL_CONSENT, cleared pendingTerminalOutbound,
 * and re-asked consent — the application link could never be retried.
 *
 * Run: node tests/release-preserves-terminal-recovery.test.js
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

async function driveToConfirmQualify(engine, wa) {
  await driveToFinalConsent(engine, wa);
  const session = await engine.sessionStore.get(wa);
  assert.strictEqual(session.currentState, 'FINAL_CONSENT');
}

async function testReleaseRetriesPendingTerminalOutbound() {
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

  const wa = '27826661001';
  await driveToConfirmQualify(engine, wa);

  failSend = true;
  await assert.rejects(
    () => engine.handleInbound(wa, 'yes'),
    /simulated Graph API failure/
  );

  let session = await store.get(wa);
  assert.strictEqual(session.status, 'soft_closed');
  assert.strictEqual(session.currentState, 'SEND_LINK');
  assert.ok(session.pendingTerminalOutbound);

  // Agent desk reply path: silent takeOver then later Release to bot.
  failSend = false;
  await engine.takeOver(wa, { silent: true });
  session = await store.get(wa);
  assert.strictEqual(session.agentTakenOver, true);
  assert.ok(
    session.pendingTerminalOutbound,
    'takeOver must not clear pendingTerminalOutbound'
  );

  const before = sent.length;
  const result = await engine.releaseToBot(wa);
  assert.strictEqual(result.resentTerminal, true);

  session = await store.get(wa);
  assert.strictEqual(session.agentTakenOver, false);
  assert.strictEqual(session.pendingTerminalOutbound, null);
  assert.strictEqual(session.currentState, 'SEND_LINK');
  assert.notStrictEqual(
    session.currentState,
    'FINAL_CONSENT',
    'release must not resume FINAL_CONSENT over an undelivered SEND_LINK'
  );
  assert.ok(
    sent.slice(before).some((m) => m.meta && m.meta.stateId === 'SEND_LINK'),
    'release must re-send the application link'
  );
  assert.strictEqual(logger.leads.length, 1);

  // eslint-disable-next-line no-console
  console.log('✓ releaseToBot retries pendingTerminalOutbound instead of resuming');
}

async function testReleaseAfterSuccessfulQualifyRestartsNotResumes() {
  const store = new MemorySessionStore();
  const logger = new CapturingLogger();

  const engine = new FsmEngine({
    sessionStore: store,
    leadLogger: logger,
    sendMessage: async () => ({ ok: true }),
    notifyAgent: async () => ({ delivered: false }),
    options: { stubMarker: true },
  });

  const wa = '27826661002';
  await driveToConfirmQualify(engine, wa);
  await engine.handleInbound(wa, 'yes');

  let session = await store.get(wa);
  assert.strictEqual(session.status, 'soft_closed');
  assert.strictEqual(session.currentState, 'SEND_LINK');
  assert.strictEqual(session.pendingTerminalOutbound, null);

  await engine.takeOver(wa, { silent: true });
  await engine.releaseToBot(wa);

  session = await store.get(wa);
  assert.strictEqual(session.agentTakenOver, false);
  assert.strictEqual(
    session.currentState,
    'GREETING',
    'completed soft_closed must restart at greeting, not re-ask FINAL_CONSENT'
  );
  assert.strictEqual(logger.leads.length, 1);

  // eslint-disable-next-line no-console
  console.log('✓ release after successful SEND_LINK restarts at GREETING');
}

async function testReleaseDoesNotDropPendingLeadWhenFlushFails() {
  const store = new MemorySessionStore();
  const logger = {
    async logLead() {
      throw new Error('CRM down');
    },
  };

  const engine = new FsmEngine({
    sessionStore: store,
    leadLogger: logger,
    sendMessage: async () => ({ ok: true }),
    notifyAgent: async () => ({ delivered: false }),
    options: { stubMarker: true },
  });

  const wa = '27826661003';
  await driveToConfirmQualify(engine, wa);
  await engine.handleInbound(wa, 'yes');

  let session = await store.get(wa);
  assert.ok(session.pendingLead);

  await engine.takeOver(wa, { silent: true });
  const result = await engine.releaseToBot(wa);
  assert.strictEqual(result.deferred, 'pending_lead');

  session = await store.get(wa);
  assert.ok(session.pendingLead, 'failed flush must leave pendingLead queued');
  assert.strictEqual(session.agentTakenOver, false);
  assert.strictEqual(session.currentState, 'SEND_LINK');

  // eslint-disable-next-line no-console
  console.log('✓ releaseToBot preserves pendingLead when CRM flush fails');
}

async function main() {
  // eslint-disable-next-line no-console
  console.log('Running release → terminal recovery regression tests…\n');
  await testReleaseRetriesPendingTerminalOutbound();
  await testReleaseAfterSuccessfulQualifyRestartsNotResumes();
  await testReleaseDoesNotDropPendingLeadWhenFlushFails();
  // eslint-disable-next-line no-console
  console.log('\nAll release → terminal recovery regression tests passed.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
