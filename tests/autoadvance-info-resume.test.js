'use strict';

/**
 * Regression: specials info slides persist then auto-advance into
 * EMPLOYED_INCOME_CHECK in the same turn. If that second Graph send fails,
 * disk stays on PAYMENT_HOLIDAY_INFO / LOWER_RATE_INFO / DISCOUNT_INFO (no
 * options). The next inbound must resume autoAdvanceTo — not treat the
 * info slide as an invalid choice and dump the customer into OFF_MENU.
 *
 * Run: node tests/autoadvance-info-resume.test.js
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

function createEngine(sendMessage) {
  return new FsmEngine({
    sessionStore: new MemorySessionStore(),
    leadLogger: new CapturingLogger(),
    sendMessage,
    notifyAgent: async () => ({ delivered: true }),
    options: { stubMarker: true },
  });
}

async function reachSpecialsMenu(engine, wa) {
  await engine.handleInbound(wa, 'hi');
  await engine.handleInbound(wa, 'I saw a special', {
    replyId: 'saw_special',
  });
  const session = await engine.sessionStore.get(wa);
  assert.strictEqual(session.currentState, 'SPECIALS_MENU');
}

async function testResumeAfterAutoAdvanceGraphFailure(infoReplyId, infoStateId) {
  let failEmployed = false;
  const sent = [];
  const engine = createEngine(async (_to, payload) => {
    const stateId = payload && payload.meta && payload.meta.stateId;
    sent.push(stateId || null);
    if (failEmployed && stateId === 'EMPLOYED_INCOME_CHECK') {
      throw new Error('simulated Graph API failure on employed check');
    }
    return { ok: true };
  });

  const wa = `2782${String(infoReplyId).replace(/\W/g, '').slice(0, 6)}001`;
  await reachSpecialsMenu(engine, wa);

  failEmployed = true;
  await assert.rejects(
    () =>
      engine.handleInbound(wa, infoReplyId.replace(/_/g, ' '), {
        replyId: infoReplyId,
      }),
    /simulated Graph API failure on employed check/
  );

  let session = await engine.sessionStore.get(wa);
  assert.strictEqual(
    session.currentState,
    infoStateId,
    'info slide must remain on disk when the follow-on Graph send fails'
  );
  assert.ok(
    sent.includes(infoStateId),
    'customer must have already received the info body'
  );
  assert.ok(
    !sent.includes('OFF_MENU_RECOVERY'),
    'failed auto-advance must not route to off-menu in the same turn'
  );

  failEmployed = false;
  // Customer follow-up after the blip — any non-help text should resume.
  await engine.handleInbound(wa, 'ok');
  session = await engine.sessionStore.get(wa);
  assert.strictEqual(
    session.currentState,
    'EMPLOYED_INCOME_CHECK',
    'inbound while stuck on autoAdvance info must resume the qualify question'
  );
  assert.notStrictEqual(
    session.currentState,
    'OFF_MENU_RECOVERY',
    'must not dump specials customers into OFF_MENU_RECOVERY'
  );
  assert.ok(
    sent.filter((id) => id === 'EMPLOYED_INCOME_CHECK').length >= 1,
    'employed+income prompt must be delivered on resume'
  );
}

async function main() {
  await testResumeAfterAutoAdvanceGraphFailure(
    'payment_holiday',
    'PAYMENT_HOLIDAY_INFO'
  );
  await testResumeAfterAutoAdvanceGraphFailure('lower_rate', 'LOWER_RATE_INFO');
  await testResumeAfterAutoAdvanceGraphFailure('discount', 'DISCOUNT_INFO');
  // eslint-disable-next-line no-console
  console.log('✓ autoAdvance info slides resume after Graph failure');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
