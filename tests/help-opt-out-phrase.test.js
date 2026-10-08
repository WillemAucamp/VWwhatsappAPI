'use strict';

/**
 * Multi-word help phrases like "opt out" must not match as raw substrings.
 * Otherwise free text such as "opt outside the income requirement" or
 * "adopt outlet near me" falsely routes to HUMAN_HANDOVER + agentTakenOver
 * and the bot stays quiet until staff Release.
 */

const assert = require('assert');
const {
  FsmEngine,
  matchesKeywordList,
  normalizeInput,
} = require('../src/engine/fsmEngine');
const config = require('../src/config');
const { MemorySessionStore } = require('../src/session/store');

class CapturingLogger {
  constructor() {
    this.records = [];
  }
  async logLead(record) {
    this.records.push(record);
  }
}

async function reachEmployedIncomeCheck(engine, wa) {
  await engine.handleInbound(wa, 'hi');
  await engine.handleInbound(wa, 'Qualify Me', {
    replyId: 'GREETING_qualify',
  });
}

function createEngine() {
  const store = new MemorySessionStore();
  const logger = new CapturingLogger();
  const engine = new FsmEngine({
    sessionStore: store,
    leadLogger: logger,
    sendMessage: async () => ({ ok: true }),
    notifyAgent: async () => ({ delivered: true }),
    options: { stubMarker: true },
  });
  return { store, logger, engine };
}

async function main() {
  const kws = config.fsm.helpIntentKeywords;

  assert.strictEqual(
    matchesKeywordList(normalizeInput('opt out'), kws),
    true
  );
  assert.strictEqual(
    matchesKeywordList(normalizeInput('I want to opt out please'), kws),
    true,
    'legitimate opt-out phrase inside a longer message must still match'
  );
  assert.strictEqual(
    matchesKeywordList(normalizeInput('opt-out'), kws),
    true,
    'hyphenated opt-out softens to the multi-word phrase'
  );

  assert.strictEqual(
    matchesKeywordList(
      normalizeInput('opt outside the income requirement'),
      kws
    ),
    false,
    '"opt outside" must not match help phrase "opt out"'
  );
  assert.strictEqual(
    matchesKeywordList(normalizeInput('adopt outlet near me'), kws),
    false,
    '"adopt outlet" must not match help phrase "opt out"'
  );
  assert.strictEqual(
    matchesKeywordList(normalizeInput('can i opt outside'), kws),
    false
  );

  const { store, engine } = createEngine();
  const wa = '27820001111';

  await reachEmployedIncomeCheck(engine, wa);
  let session = await store.get(wa);
  assert.strictEqual(session.currentState, 'EMPLOYED_INCOME_CHECK');

  await engine.handleInbound(wa, 'can I opt outside the income requirement?');
  session = await store.get(wa);
  assert.notStrictEqual(
    session.currentState,
    'HUMAN_HANDOVER',
    'substring "opt out" inside "opt outside" must not silent-hold'
  );
  assert.strictEqual(session.agentTakenOver, false);
  assert.notStrictEqual(session.status, 'quiet');

  // Genuine opt-out still hands over.
  const second = createEngine();
  await reachEmployedIncomeCheck(second.engine, '27820002222');
  await second.engine.handleInbound('27820002222', 'I want to opt out');
  session = await second.store.get('27820002222');
  assert.strictEqual(session.currentState, 'HUMAN_HANDOVER');
  assert.strictEqual(session.agentTakenOver, true);
  assert.strictEqual(session.status, 'quiet');

  // eslint-disable-next-line no-console
  console.log('help-opt-out-phrase: ok');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
