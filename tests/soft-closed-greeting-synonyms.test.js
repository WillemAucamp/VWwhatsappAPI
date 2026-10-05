'use strict';

/**
 * After SEND_LINK soft_closed, short GREETING optionLabels like "1" / "2" /
 * "3" / "special" must not free-text-match and restart the funnel or silent-
 * hold via HUMAN_HANDOVER. Interactive reply ids and exact button titles
 * remain honoured.
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

async function testSynonymsDoNotRestartOrHold() {
  const store = new MemorySessionStore();
  const engine = makeEngine(store);
  const wa = '27821120001';

  for (const text of ['1', '2', '3', 'special', 'specials']) {
    await seedSoftClosedSendLink(store, wa);
    await engine.handleInbound(wa, text, null);
    const session = await store.get(wa);
    assert.notStrictEqual(
      session.currentState,
      'EMPLOYED_INCOME_CHECK',
      `"${text}" must not restart employment screening from soft_closed SEND_LINK`
    );
    assert.notStrictEqual(
      session.currentState,
      'SPECIALS_MENU',
      `"${text}" must not open SPECIALS_MENU from soft_closed SEND_LINK`
    );
    assert.ok(
      !session.agentTakenOver,
      `"${text}" must not set agentTakenOver silent hold from soft_closed`
    );
    assert.ok(
      session.currentState === 'OFF_MENU_RECOVERY' ||
        session.currentState === 'GREETING' ||
        session.status === 'soft_closed',
      `"${text}" should go off-menu / reopen / stay soft_closed, got ${session.currentState}`
    );
  }
  // eslint-disable-next-line no-console
  console.log('✓ soft_closed GREETING synonyms (1/2/3/special) do not restart/hold');
}

async function testQualifyMeButtonStillHonoured() {
  const store = new MemorySessionStore();
  const engine = makeEngine(store);
  const wa = '27821120002';

  await seedSoftClosedSendLink(store, wa);
  await engine.handleInbound(wa, 'Qualify Me', 'qualify_me');
  const session = await store.get(wa);
  assert.strictEqual(session.currentState, 'EMPLOYED_INCOME_CHECK');
  // eslint-disable-next-line no-console
  console.log('✓ soft_closed qualify_me button tap still starts qualify');
}

async function testExactTitleStillHonoured() {
  const store = new MemorySessionStore();
  const engine = makeEngine(store);
  const wa = '27821120003';

  await seedSoftClosedSendLink(store, wa);
  await engine.handleInbound(wa, 'Qualify Me', null);
  const session = await store.get(wa);
  assert.strictEqual(session.currentState, 'EMPLOYED_INCOME_CHECK');
  // eslint-disable-next-line no-console
  console.log('✓ soft_closed exact "Qualify Me" title still starts qualify');
}

async function testSawSpecialTitleStillHonoured() {
  const store = new MemorySessionStore();
  const engine = makeEngine(store);
  const wa = '27821120004';

  await seedSoftClosedSendLink(store, wa);
  await engine.handleInbound(wa, 'I saw a special', null);
  const session = await store.get(wa);
  assert.strictEqual(session.currentState, 'SPECIALS_MENU');
  // eslint-disable-next-line no-console
  console.log('✓ soft_closed exact "I saw a special" title still opens specials');
}

async function main() {
  await testSynonymsDoNotRestartOrHold();
  await testQualifyMeButtonStillHonoured();
  await testExactTitleStillHonoured();
  await testSawSpecialTitleStillHonoured();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
