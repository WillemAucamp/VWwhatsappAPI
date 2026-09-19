'use strict';

/**
 * Regression: reopen single words must be exact messages.
 * Whole-word-in-sentence matching (e.g. "start" inside "when can I start")
 * _restart()ed soft_closed SEND_LINK chats back to GREETING, wiping the
 * completed path so a second qualify run could double-log the CRM lead.
 *
 * Run: node tests/reopen-keyword-exact.test.js
 */

const assert = require('assert');
const { MemorySessionStore } = require('../src/session/store');
const {
  FsmEngine,
  matchesKeywordList,
  normalizeInput,
} = require('../src/engine/fsmEngine');
const config = require('../src/config');
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
  const kws = config.fsm.reopenKeywords;

  assert.strictEqual(
    matchesKeywordList(normalizeInput('hi'), kws, { exactSingleWord: true }),
    true
  );
  assert.strictEqual(
    matchesKeywordList(normalizeInput('Hello!'), kws, { exactSingleWord: true }),
    true
  );
  assert.strictEqual(
    matchesKeywordList(normalizeInput('restart'), kws, {
      exactSingleWord: true,
    }),
    true
  );
  assert.strictEqual(
    matchesKeywordList(normalizeInput('start'), kws, { exactSingleWord: true }),
    true
  );

  assert.strictEqual(
    matchesKeywordList(
      normalizeInput('Thanks, when can I start the paperwork?'),
      kws,
      { exactSingleWord: true }
    ),
    false,
    'start inside a sentence must not reopen'
  );
  assert.strictEqual(
    matchesKeywordList(normalizeInput('say hi to the team'), kws, {
      exactSingleWord: true,
    }),
    false,
    'hi inside a sentence must not reopen'
  );
  assert.strictEqual(
    matchesKeywordList(normalizeInput('I want to start soon'), kws, {
      exactSingleWord: true,
    }),
    false,
    'start soon must not reopen'
  );

  // Without the flag, in-sentence matching still works (legacy callers).
  assert.strictEqual(
    matchesKeywordList(normalizeInput('when can I start'), kws),
    true,
    'legacy whole-word-in-sentence matching remains available'
  );

  // eslint-disable-next-line no-console
  console.log('✓ reopen matcher uses exact single-word matching');
}

async function driveToSoftClosedSendLink(engine, wa) {
  await driveToFinalConsent(engine, wa);
  const before = await engine.sessionStore.get(wa);
  assert.strictEqual(before.currentState, 'FINAL_CONSENT');
  await engine.handleInbound(wa, 'yes');
  const session = await engine.sessionStore.get(wa);
  assert.strictEqual(session.status, 'soft_closed');
  assert.strictEqual(session.currentState, 'SEND_LINK');
  return session;
}

async function testSoftClosedSentenceWithStartDoesNotRestart() {
  const { store, logger, engine } = createEngine();
  const wa = '27827770001';

  await driveToSoftClosedSendLink(engine, wa);
  assert.strictEqual(logger.leads.length, 1);
  const pathBefore = (await store.get(wa)).path.slice();

  await engine.handleInbound(wa, 'Thanks, when can I start the paperwork?');
  const session = await store.get(wa);

  assert.notStrictEqual(
    session.currentState,
    'GREETING',
    'in-sentence start must not wipe soft_closed back to GREETING'
  );
  assert.strictEqual(
    session.status,
    'active',
    'off-menu free text should enter recovery, not restart'
  );
  assert.strictEqual(session.currentState, 'OFF_MENU_RECOVERY');
  assert.ok(
    pathBefore.includes('FINAL_CONSENT') || pathBefore.includes('SEND_LINK'),
    'precondition: completed qualify path'
  );
  assert.strictEqual(
    logger.leads.length,
    1,
    'false reopen must not create a second lead by itself'
  );

  // eslint-disable-next-line no-console
  console.log('✓ soft_closed "when can I start…" → OFF_MENU_RECOVERY, not GREETING');
}

async function testSoftClosedExactHiStillRestarts() {
  const { store, engine } = createEngine();
  const wa = '27827770002';

  await driveToSoftClosedSendLink(engine, wa);
  await engine.handleInbound(wa, 'hi');
  const session = await store.get(wa);

  assert.strictEqual(session.status, 'active');
  assert.strictEqual(session.currentState, 'GREETING');

  // eslint-disable-next-line no-console
  console.log('✓ soft_closed exact "hi" still restarts greeting');
}

async function testSoftClosedHelloPunctuationStillRestarts() {
  const { store, engine } = createEngine();
  const wa = '27827770003';

  await driveToSoftClosedSendLink(engine, wa);
  await engine.handleInbound(wa, 'Hello!');
  const session = await store.get(wa);

  assert.strictEqual(session.status, 'active');
  assert.strictEqual(session.currentState, 'GREETING');

  // eslint-disable-next-line no-console
  console.log('✓ soft_closed "Hello!" still restarts greeting');
}

async function testQuietWithoutHoldSentenceWithStartDoesNotRestart() {
  const { store, engine } = createEngine();
  const wa = '27827770004';

  // Quiet without agentTakenOver (staff released hold, or legacy quiet):
  // reopen words still apply, but only as exact messages.
  await store.set(wa, {
    ...(await engine.getOrCreateSession(wa)),
    status: 'quiet',
    currentState: 'HUMAN_HANDOVER',
    path: ['GREETING', 'HUMAN_HANDOVER'],
    agentTakenOver: false,
    pendingTerminalOutbound: null,
    pendingLead: null,
  });

  await engine.handleInbound(wa, 'I want to start the application soon');
  let session = await store.get(wa);
  assert.strictEqual(session.status, 'quiet');
  assert.strictEqual(session.currentState, 'HUMAN_HANDOVER');

  await engine.handleInbound(wa, 'restart');
  session = await store.get(wa);
  assert.strictEqual(session.status, 'active');
  assert.strictEqual(session.currentState, 'GREETING');

  // eslint-disable-next-line no-console
  console.log('✓ quiet in-sentence start stays quiet; exact restart reopens');
}

async function main() {
  testMatcherExactSingleWord();
  await testSoftClosedSentenceWithStartDoesNotRestart();
  await testSoftClosedExactHiStillRestarts();
  await testSoftClosedHelloPunctuationStillRestarts();
  await testQuietWithoutHoldSentenceWithStartDoesNotRestart();
  // eslint-disable-next-line no-console
  console.log('\nAll reopen-keyword-exact tests passed.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
