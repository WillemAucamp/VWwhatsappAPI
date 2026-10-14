'use strict';

/**
 * False HUMAN_HANDOVER / silent agentTakenOver from:
 * 1) Legacy GREETING opt_out label "3" after Opt-Out left the 2-button menu
 * 2) Catalog product/order inquiry outside STOCKLIST_CAROUSEL → OFF_MENU →
 *    second invalid → quiet hold
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FsmEngine, matchOption } = require('../src/engine/fsmEngine');
const { STATES } = require('../src/fsm/states');
const { FileSessionStore } = require('../src/session/store');
const { createLeadLogger } = require('../src/logger/leadLogger');

function createEngine(dir) {
  const store = new FileSessionStore(dir);
  const sent = [];
  const engine = new FsmEngine({
    sessionStore: store,
    leadLogger: createLeadLogger('console'),
    sendMessage: async (to, payload) => {
      sent.push({ to, payload });
      return { messages: [{ id: `wamid.${sent.length}` }] };
    },
  });
  return { engine, store, sent };
}

async function testGreetingNumeralThreeIsNotOptOut() {
  assert.strictEqual(
    matchOption(STATES.GREETING, '3'),
    null,
    'legacy numeral 3 must not match GREETING opt_out'
  );
  assert.strictEqual(
    matchOption(STATES.GREETING, 'opt out'),
    'opt_out',
    'explicit opt-out text must still match'
  );

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-greet3-'));
  try {
    const { engine, store } = createEngine(dir);
    await engine.handleInbound('27821110001', 'hi');
    await engine.handleInbound('27821110001', '3');
    const session = await store.get('27821110001');
    assert.strictEqual(session.currentState, 'OFF_MENU_RECOVERY');
    assert.strictEqual(session.status, 'active');
    assert.strictEqual(session.agentTakenOver, false);
    // eslint-disable-next-line no-console
    console.log('✓ GREETING free-text "3" is off-menu, not silent handover');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testMidFunnelCatalogProductDoesNotFalseHandover() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-cat-mid-'));
  try {
    const { engine, store } = createEngine(dir);
    await engine.handleInbound('27821110002', 'hi');
    await engine.handleInbound('27821110002', 'Qualify Me', {
      replyId: 'qualify_me',
    });
    let session = await store.get('27821110002');
    assert.strictEqual(session.currentState, 'EMPLOYED_INCOME_CHECK');

    await engine.handleInbound('27821110002', '', {
      productRetailerId: 'polo-2022',
      catalogId: '1067415159340072',
    });
    session = await store.get('27821110002');
    assert.strictEqual(
      session.currentState,
      'EMPLOYED_INCOME_CHECK',
      'product inquiry mid-funnel must re-prompt current step, not OFF_MENU'
    );
    assert.strictEqual(session.selectedProductRetailerId, 'polo-2022');
    assert.strictEqual(session.selectedCatalogId, '1067415159340072');
    assert.strictEqual(session.agentTakenOver, false);

    // Stale employment Yes from chat history must still advance — not cascade
    // from OFF_MENU into HUMAN_HANDOVER silent hold.
    await engine.handleInbound('27821110002', 'Yes', {
      replyId: 'employed_income_yes',
    });
    session = await store.get('27821110002');
    assert.strictEqual(session.currentState, 'LICENSE_CHECK');
    assert.strictEqual(session.status, 'active');
    assert.strictEqual(session.agentTakenOver, false);
    assert.strictEqual(session.selectedProductRetailerId, 'polo-2022');
    // eslint-disable-next-line no-console
    console.log('✓ mid-funnel catalog product keeps qualify + selection');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testSoftClosedCatalogProductStartsQualify() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-cat-soft-'));
  try {
    const { engine, store } = createEngine(dir);
    await engine.handleInbound('27821110003', 'hi');
    await engine.handleInbound('27821110003', 'Qualify Me', {
      replyId: 'qualify_me',
    });
    await engine.handleInbound('27821110003', 'yes', {
      replyId: 'employed_income_yes',
    });
    await engine.handleInbound('27821110003', 'yes', {
      replyId: 'license_yes',
    });
    await engine.handleInbound('27821110003', 'good', {
      replyId: 'credit_good',
    });
    await engine.handleInbound('27821110003', 'Yes, send it', {
      replyId: 'consent_yes',
    });
    let session = await store.get('27821110003');
    assert.strictEqual(session.status, 'soft_closed');

    await engine.handleInbound('27821110003', '', {
      productRetailerId: 'tiguan-2021',
      catalogId: '1067415159340072',
    });
    session = await store.get('27821110003');
    assert.strictEqual(session.currentState, 'EMPLOYED_INCOME_CHECK');
    assert.strictEqual(session.status, 'active');
    assert.strictEqual(session.agentTakenOver, false);
    assert.strictEqual(session.selectedProductRetailerId, 'tiguan-2021');
    // eslint-disable-next-line no-console
    console.log('✓ soft_closed catalog product starts qualify with car kept');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  await testGreetingNumeralThreeIsNotOptOut();
  await testMidFunnelCatalogProductDoesNotFalseHandover();
  await testSoftClosedCatalogProductStartsQualify();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
