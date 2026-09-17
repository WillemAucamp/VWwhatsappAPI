'use strict';

/**
 * Regression: help-intent single words must be exact messages.
 * Whole-word-in-sentence matching (e.g. "human" inside "human resources")
 * routed mid-funnel customers to HUMAN_HANDOVER with agentTakenOver, which
 * silently holds the chat until staff Release.
 *
 * Run: node tests/help-keyword-exact.test.js
 */

const assert = require('assert');
const { MemorySessionStore } = require('../src/session/store');
const {
  FsmEngine,
  matchesKeywordList,
  normalizeInput,
} = require('../src/engine/fsmEngine');
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

function testMatcherExactSingleWord() {
  const kws = config.fsm.helpIntentKeywords;

  assert.strictEqual(
    matchesKeywordList(normalizeInput('help'), kws, { exactSingleWord: true }),
    true
  );
  assert.strictEqual(
    matchesKeywordList(normalizeInput('Help!'), kws, { exactSingleWord: true }),
    true
  );
  assert.strictEqual(
    matchesKeywordList(normalizeInput('stop'), kws, { exactSingleWord: true }),
    true
  );
  assert.strictEqual(
    matchesKeywordList(normalizeInput('opt out'), kws, {
      exactSingleWord: true,
    }),
    true
  );
  assert.strictEqual(
    matchesKeywordList(normalizeInput('I want to opt out please'), kws, {
      exactSingleWord: true,
    }),
    true,
    'multi-word opt-out phrase may appear inside a longer message'
  );

  assert.strictEqual(
    matchesKeywordList(normalizeInput('I am a human resources manager'), kws, {
      exactSingleWord: true,
    }),
    false,
    'human inside a sentence must not be help-intent'
  );
  assert.strictEqual(
    matchesKeywordList(
      normalizeInput('please stop asking, my answer is yes'),
      kws,
      { exactSingleWord: true }
    ),
    false,
    'stop inside a sentence must not be help-intent'
  );
  assert.strictEqual(
    matchesKeywordList(normalizeInput('I need help with this'), kws, {
      exactSingleWord: true,
    }),
    false,
    'copy asks customers to type *help* alone'
  );

  // eslint-disable-next-line no-console
  console.log('✓ help-intent matcher uses exact single-word matching');
}

async function testHumanResourcesDoesNotSilentHold() {
  const { store, engine } = createEngine();
  const wa = '27829991001';

  await engine.handleInbound(wa, 'hi');
  await engine.handleInbound(wa, 'qualify me');
  let session = await store.get(wa);
  assert.strictEqual(session.currentState, 'EMPLOYED_INCOME_CHECK');

  await engine.handleInbound(wa, 'I am a human resources manager');
  session = await store.get(wa);

  assert.notStrictEqual(
    session.currentState,
    'HUMAN_HANDOVER',
    'employment answer mentioning "human" must not force handover'
  );
  assert.strictEqual(
    session.agentTakenOver,
    false,
    'must not silent-hold on false help keyword'
  );
  assert.notStrictEqual(session.status, 'quiet');

  // Explicit help still works and holds until Release.
  await engine.handleInbound(wa, 'help');
  session = await store.get(wa);
  assert.strictEqual(session.currentState, 'HUMAN_HANDOVER');
  assert.strictEqual(session.status, 'quiet');
  assert.strictEqual(session.agentTakenOver, true);

  await engine.handleInbound(wa, 'hi');
  session = await store.get(wa);
  assert.strictEqual(
    session.agentTakenOver,
    true,
    'held chats stay quiet on reopen words until Release'
  );
  assert.strictEqual(session.status, 'quiet');

  // eslint-disable-next-line no-console
  console.log('✓ "human resources" mid-funnel does not silent-hold; exact help does');
}

async function testStopInsideSentenceDoesNotHandover() {
  const { store, engine } = createEngine();
  const wa = '27829991002';

  await engine.handleInbound(wa, 'hi');
  await engine.handleInbound(wa, 'qualify me');
  await engine.handleInbound(wa, 'please stop asking, my answer is yes');

  const session = await store.get(wa);
  assert.notStrictEqual(session.currentState, 'HUMAN_HANDOVER');
  assert.strictEqual(session.agentTakenOver, false);

  // Exact stop still opts out into silent hold.
  await engine.handleInbound(wa, 'stop');
  const after = await store.get(wa);
  assert.strictEqual(after.currentState, 'HUMAN_HANDOVER');
  assert.strictEqual(after.agentTakenOver, true);

  // eslint-disable-next-line no-console
  console.log('✓ "stop" inside a sentence is not opt-out; exact stop is');
}

async function main() {
  testMatcherExactSingleWord();
  await testHumanResourcesDoesNotSilentHold();
  await testStopInsideSentenceDoesNotHandover();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
