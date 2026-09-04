'use strict';

/**
 * Regression: non-terminal state transitions must persist before Graph send.
 *
 * Webhook returns 200 before handleInbound finishes. If Graph succeeds and then
 * sessionStore.set fails, Meta will not retry — the customer sees the next
 * question while disk still has the previous state. With stale interactive id
 * rejection, their tap is treated as invalid and the funnel breaks.
 *
 * Run: node tests/nonterminal-persist-before-send.test.js
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

async function testPersistFailureAfterSendDoesNotDesync() {
  const store = new MemorySessionStore();
  const logger = new CapturingLogger();
  const sent = [];
  let failNextSet = false;
  const origSet = store.set.bind(store);
  store.set = async (wa, session) => {
    if (failNextSet) {
      failNextSet = false;
      throw new Error('simulated persist failure');
    }
    return origSet(wa, session);
  };

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

  const wa = '27829991001';
  await engine.handleInbound(wa, 'hi');
  await engine.handleInbound(wa, 'qualify me');

  const before = await store.get(wa);
  assert.strictEqual(before.currentState, 'EMPLOYMENT_CHECK');

  // With persist-before-send, the failing set happens BEFORE Graph — so the
  // AFFORDABILITY body must never be delivered on a failed transition.
  // First set after EMPLOYMENT is the AFFORDABILITY pre-persist (with
  // pendingQuestionOutbound); fail that write.
  failNextSet = true;
  await assert.rejects(
    () => engine.handleInbound(wa, 'yes', { replyId: 'employed_yes' }),
    /simulated persist failure/
  );

  const afterFail = await store.get(wa);
  assert.strictEqual(
    afterFail.currentState,
    'EMPLOYMENT_CHECK',
    'disk must remain on EMPLOYMENT_CHECK when persist fails'
  );
  assert.ok(
    !sent.some((s) => s.meta && s.meta.stateId === 'AFFORDABILITY_CHECK'),
    'AFFORDABILITY must not be sent when session persist failed first'
  );

  // Retry the same answer once the store is healthy again.
  await engine.handleInbound(wa, 'yes', { replyId: 'employed_yes' });
  const afterOk = await store.get(wa);
  assert.strictEqual(afterOk.currentState, 'AFFORDABILITY_CHECK');
  assert.ok(
    sent.some((s) => s.meta && s.meta.stateId === 'AFFORDABILITY_CHECK'),
    'AFFORDABILITY must send after a successful persist'
  );

  // eslint-disable-next-line no-console
  console.log('✓ persist failure before send does not desync non-terminal state');
}

async function testSendFailureRollsBackPrePersistedState() {
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

  const wa = '27829991002';
  await engine.handleInbound(wa, 'hi');
  await engine.handleInbound(wa, 'qualify me');

  failSend = true;
  await assert.rejects(
    () => engine.handleInbound(wa, 'yes', { replyId: 'employed_yes' }),
    /simulated Graph API failure/
  );

  const session = await store.get(wa);
  assert.strictEqual(
    session.currentState,
    'EMPLOYMENT_CHECK',
    'Graph failure after pre-persist must roll session back'
  );
  assert.deepStrictEqual(session.path, ['GREETING', 'EMPLOYMENT_CHECK']);

  failSend = false;
  await engine.handleInbound(wa, 'yes', { replyId: 'employed_yes' });
  const after = await store.get(wa);
  assert.strictEqual(after.currentState, 'AFFORDABILITY_CHECK');

  // eslint-disable-next-line no-console
  console.log('✓ Graph send failure rolls back pre-persisted non-terminal state');
}

async function main() {
  await testPersistFailureAfterSendDoesNotDesync();
  await testSendFailureRollsBackPrePersistedState();
  // eslint-disable-next-line no-console
  console.log('\nAll non-terminal persist-before-send tests passed.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
