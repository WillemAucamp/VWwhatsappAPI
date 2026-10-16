'use strict';

/**
 * Sticky interruptedFrom after OFF_MENU → Main-Menu must not poison Release.
 * Without the fix, Release resumes the pre-off-menu step (or re-opens a finished
 * qualify) instead of the live funnel position.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FsmEngine } = require('../src/engine/fsmEngine');
const { FileSessionStore } = require('../src/session/store');

function createEngine(dir) {
  const store = new FileSessionStore(dir);
  const sent = [];
  const leads = [];
  const engine = new FsmEngine({
    sessionStore: store,
    leadLogger: {
      logLead: async (payload) => {
        leads.push(payload);
        return payload;
      },
    },
    sendMessage: async (to, payload) => {
      sent.push({ to, payload });
      return { messages: [{ id: `wamid.${sent.length}` }] };
    },
  });
  return { engine, store, sent, leads };
}

async function advanceQualifyFromGreeting(engine, wa) {
  await engine.handleInbound(wa, 'Qualify Me', { replyId: 'qualify_me' });
  await engine.handleInbound(wa, 'yes', { replyId: 'employed_income_yes' });
  await engine.handleInbound(wa, 'yes', { replyId: 'license_yes' });
  await engine.handleInbound(wa, 'good', { replyId: 'credit_good' });
  await engine.handleInbound(wa, 'Yes, send it', { replyId: 'consent_yes' });
}

async function testMainMenuClearsStickyInterruptedFromOnRelease() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-sticky-if-'));
  try {
    const { engine, store } = createEngine(dir);
    const wa = '27821116001';

    await engine.handleInbound(wa, 'hi');
    await engine.handleInbound(wa, 'Qualify Me', { replyId: 'qualify_me' });
    let session = await store.get(wa);
    assert.strictEqual(session.currentState, 'EMPLOYED_INCOME_CHECK');

    // Off-menu free text bookmarks the live step.
    await engine.handleInbound(wa, 'zzzz not an option');
    session = await store.get(wa);
    assert.strictEqual(session.currentState, 'OFF_MENU_RECOVERY');
    assert.strictEqual(session.interruptedFrom, 'EMPLOYED_INCOME_CHECK');

    // Main-Menu must clear that bookmark so later progress is authoritative.
    await engine.handleInbound(wa, 'Main-Menu', { replyId: 'main_menu' });
    session = await store.get(wa);
    assert.strictEqual(session.currentState, 'GREETING');
    assert.strictEqual(
      session.interruptedFrom,
      null,
      'Main-Menu must clear interruptedFrom from the prior OFF_MENU'
    );

    // Continue past the sticky bookmark into a later step.
    await engine.handleInbound(wa, 'Qualify Me', { replyId: 'qualify_me' });
    await engine.handleInbound(wa, 'yes', { replyId: 'employed_income_yes' });
    await engine.handleInbound(wa, 'yes', { replyId: 'license_yes' });
    session = await store.get(wa);
    assert.strictEqual(session.currentState, 'CREDIT_CHECK');
    assert.strictEqual(session.interruptedFrom, null);

    await engine.takeOver(wa, { silent: true });
    session = await store.get(wa);
    assert.strictEqual(session.interruptedFrom, 'CREDIT_CHECK');

    await engine.releaseToBot(wa);
    session = await store.get(wa);
    assert.strictEqual(
      session.currentState,
      'CREDIT_CHECK',
      'Release must resume the live step, not the sticky EMPLOYED_INCOME_CHECK'
    );
    assert.strictEqual(session.agentTakenOver, false);
    assert.strictEqual(session.status, 'active');
    // eslint-disable-next-line no-console
    console.log('✓ Main-Menu clears sticky interruptedFrom; Release resumes CREDIT_CHECK');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testHumanHandoverKeepsResumeBookmark() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-sticky-hh-'));
  try {
    const { engine, store } = createEngine(dir);
    const wa = '27821116002';

    await engine.handleInbound(wa, 'hi');
    await engine.handleInbound(wa, 'Qualify Me', { replyId: 'qualify_me' });
    await engine.handleInbound(wa, 'zzzz');
    let session = await store.get(wa);
    assert.strictEqual(session.interruptedFrom, 'EMPLOYED_INCOME_CHECK');

    // replyId-only: title text "Human-Handover" softens to "human handover" and
    // matches helpIntentKeywords ("human") before option routing.
    await engine.handleInbound(wa, '', { replyId: 'human_handover' });
    session = await store.get(wa);
    assert.strictEqual(session.status, 'quiet');
    assert.strictEqual(session.agentTakenOver, true);
    assert.strictEqual(
      session.interruptedFrom,
      'EMPLOYED_INCOME_CHECK',
      'quiet HUMAN_HANDOVER must keep the pre-OFF_MENU resume bookmark'
    );

    await engine.releaseToBot(wa);
    session = await store.get(wa);
    assert.strictEqual(session.currentState, 'EMPLOYED_INCOME_CHECK');
    // eslint-disable-next-line no-console
    console.log('✓ HUMAN_HANDOVER keeps interruptedFrom for Release resume');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testStickyInterruptedFromMustNotReopenFinishedQualify() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-sticky-lead-'));
  try {
    const { engine, store, leads } = createEngine(dir);
    const wa = '27821116003';

    await engine.handleInbound(wa, 'hi');
    await engine.handleInbound(wa, 'Qualify Me', { replyId: 'qualify_me' });
    await engine.handleInbound(wa, 'zzzz');
    await engine.handleInbound(wa, 'Main-Menu', { replyId: 'main_menu' });
    let session = await store.get(wa);
    assert.strictEqual(session.currentState, 'GREETING');
    assert.strictEqual(session.interruptedFrom, null);

    await advanceQualifyFromGreeting(engine, wa);
    session = await store.get(wa);
    assert.strictEqual(session.status, 'soft_closed');
    assert.strictEqual(session.currentState, 'SEND_LINK');
    assert.strictEqual(leads.length, 1);
    assert.strictEqual(leads[0].exitReason, 'qualified_self_serve');

    // Desk takeOver after SEND_LINK, then Release must not resume the stale
    // EMPLOYED_INCOME_CHECK bookmark and invite a second qualification lead.
    await engine.takeOver(wa, { silent: true });
    await engine.releaseToBot(wa);
    session = await store.get(wa);
    assert.notStrictEqual(
      session.currentState,
      'EMPLOYED_INCOME_CHECK',
      'Release after finished qualify must not reopen employment check'
    );
    assert.strictEqual(
      leads.length,
      1,
      'must not log a second qualification lead from sticky interruptedFrom'
    );
    // eslint-disable-next-line no-console
    console.log('✓ sticky interruptedFrom cannot reopen finished qualify on Release');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  await testMainMenuClearsStickyInterruptedFromOnRelease();
  await testHumanHandoverKeepsResumeBookmark();
  await testStickyInterruptedFromMustNotReopenFinishedQualify();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
