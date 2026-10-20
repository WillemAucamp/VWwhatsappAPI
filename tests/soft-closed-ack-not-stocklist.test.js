'use strict';

/**
 * After SEND_LINK soft_closed, acknowledgements like "ok" / "yes" must not
 * free-text-match STOCKLIST_CAROUSEL optionLabels and restart employment screening.
 */

const assert = require('assert');
const { MemorySessionStore, createEmptySession } = require('../src/session/store');
const { FsmEngine } = require('../src/engine/fsmEngine');

async function seedSoftClosedSendLink(store, wa) {
  const session = createEmptySession(wa);
  session.status = 'soft_closed';
  session.currentState = 'SEND_LINK';
  session.path = [
    'GREETING',
    'EMPLOYED_INCOME_CHECK',
    'FINAL_CONSENT',
    'SEND_LINK',
  ];
  session.answers = {
    EMPLOYED_INCOME_CHECK: 'yes',
    FINAL_CONSENT: 'yes',
  };
  await store.set(wa, session);
  return session;
}

function makeEngine(store) {
  return new FsmEngine({
    sessionStore: store,
    leadLogger: {
      async logLead(record) {
        return record;
      },
    },
    sendMessage: async () => ({ messages: [{ id: 'wamid.test' }] }),
    notifyAgent: async () => ({ delivered: true }),
  });
}

async function testAckDoesNotRestartQualify() {
  const store = new MemorySessionStore();
  const engine = makeEngine(store);
  const wa = '27821110001';

  for (const text of ['ok', 'yes', 'continue', 'next', 'select']) {
    await seedSoftClosedSendLink(store, wa);
    await engine.handleInbound(wa, text, null);
    const session = await store.get(wa);
    assert.notStrictEqual(
      session.currentState,
      'EMPLOYED_INCOME_CHECK',
      `"${text}" must not restart employment screening from soft_closed SEND_LINK`
    );
    assert.ok(
      session.currentState === 'OFF_MENU_RECOVERY' ||
        session.currentState === 'GREETING' ||
        session.status === 'soft_closed',
      `"${text}" should go off-menu / reopen / stay soft_closed, got ${session.currentState}`
    );
  }
  // eslint-disable-next-line no-console
  console.log('✓ soft_closed acks (ok/yes/…) do not restart STOCKLIST qualify');
}

async function testAnyCarButtonStillHonoured() {
  const store = new MemorySessionStore();
  const engine = makeEngine(store);
  const wa = '27821110002';

  await seedSoftClosedSendLink(store, wa);
  await engine.handleInbound(wa, 'Check if I qualify', 'any_car');
  const session = await store.get(wa);
  assert.strictEqual(session.currentState, 'EMPLOYED_INCOME_CHECK');
  assert.ok(
    Array.isArray(session.path) && session.path.includes('STOCKLIST_CAROUSEL'),
    'any_car reply id should route via stocklist path'
  );
  // eslint-disable-next-line no-console
  console.log('✓ soft_closed any_car button tap still starts qualify');
}

async function testExactTitleStillHonoured() {
  const store = new MemorySessionStore();
  const engine = makeEngine(store);
  const wa = '27821110003';

  await seedSoftClosedSendLink(store, wa);
  await engine.handleInbound(wa, 'Check if I qualify', null);
  const session = await store.get(wa);
  assert.strictEqual(session.currentState, 'EMPLOYED_INCOME_CHECK');
  // eslint-disable-next-line no-console
  console.log('✓ soft_closed exact "Check if I qualify" title still starts qualify');
}

async function main() {
  await testAckDoesNotRestartQualify();
  await testAnyCarButtonStillHonoured();
  await testExactTitleStillHonoured();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
