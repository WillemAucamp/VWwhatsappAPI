'use strict';

/**
 * Regression: terminal / help-intent state must persist when outbound send fails.
 * Otherwise "stop" / "opt out" / "help" leaves the session active and the bot
 * continues the qualification flow.
 *
 * Run: npm test
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

async function testHelpIntentPersistsWhenSendFails() {
  const store = new MemorySessionStore();
  const logger = new CapturingLogger();
  const agentEvents = [];
  let failSend = false;

  const engine = new FsmEngine({
    sessionStore: store,
    leadLogger: logger,
    sendMessage: async () => {
      if (failSend) throw new Error('simulated Graph API failure');
      return { ok: true };
    },
    notifyAgent: async (event) => {
      agentEvents.push(event);
      return { delivered: false, reason: 'test' };
    },
    options: { stubMarker: true },
  });

  const wa = '27821110001';
  await engine.handleInbound(wa, 'hi');
  await engine.handleInbound(wa, 'qualify me'); // QUALIFY_CONSENT

  failSend = true;
  await assert.rejects(
    () => engine.handleInbound(wa, 'stop'),
    /simulated Graph API failure/,
    'send failure should still surface to the caller'
  );

  const session = await store.get(wa);
  assert.strictEqual(
    session.status,
    'quiet',
    'opt-out/help must enter quiet even when handover message fails'
  );
  assert.strictEqual(session.currentState, 'HUMAN_HANDOVER');
  assert.strictEqual(
    logger.leads.length,
    1,
    'lead must be logged for the terminal handover'
  );
  assert.strictEqual(logger.leads[0].exitReason, 'human_requested');
  assert.strictEqual(agentEvents.length, 1, 'agent must still be notified');

  // Further non-reopen input must not continue the sales flow
  failSend = false;
  await engine.handleInbound(wa, 'yes');
  const after = await store.get(wa);
  assert.strictEqual(after.status, 'quiet');
  assert.strictEqual(after.currentState, 'HUMAN_HANDOVER');
  assert.ok(
    !after.path.includes('EMPLOYED_INCOME_CHECK'),
    'bot must not advance qualification after a failed opt-out send'
  );

  // eslint-disable-next-line no-console
  console.log('✓ help/opt-out terminal persists when outbound send fails');
}

async function testNonTerminalSendFailureDoesNotAdvance() {
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

  const wa = '27821110002';
  await engine.handleInbound(wa, 'hi');
  const before = await store.get(wa);
  assert.strictEqual(before.currentState, 'GREETING');

  failSend = true;
  await assert.rejects(() => engine.handleInbound(wa, 'qualify me'));

  const after = await store.get(wa);
  assert.strictEqual(
    after.currentState,
    'GREETING',
    'non-terminal failure must not persist the next state'
  );
  assert.deepStrictEqual(after.path, ['GREETING']);

  // eslint-disable-next-line no-console
  console.log('✓ non-terminal send failure does not advance session');
}

async function main() {
  // eslint-disable-next-line no-console
  console.log('Running terminal send-failure regression tests…\n');
  await testHelpIntentPersistsWhenSendFails();
  await testNonTerminalSendFailureDoesNotAdvance();
  // eslint-disable-next-line no-console
  console.log('\nAll terminal send-failure regression tests passed.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('\nTest failed:', err);
  process.exit(1);
});
