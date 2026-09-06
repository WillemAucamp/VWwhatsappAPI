'use strict';

/**
 * Regression: stale interactive reply ids must not fall back to title matching.
 *
 * Trigger: User is on FINAL_CONSENT ("Shall I send it?"). They scroll up and
 * tap Yes on an earlier EMPLOYMENT_CHECK button (replyId=employed_yes, title
 * "Yes"). Old resolveOptionKey ignored the unknown id and matched the title
 * against consent_yes's "yes" label → SEND_LINK without real consent.
 *
 * Run: node tests/stale-interactive-reply.test.js
 */

const assert = require('assert');
const { MemorySessionStore } = require('../src/session/store');
const { FsmEngine, resolveOptionKey } = require('../src/engine/fsmEngine');
const { STATES } = require('../src/fsm/states');
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

function testResolveOptionKeyUnit() {
  const state = STATES.FINAL_CONSENT;
  assert.strictEqual(
    resolveOptionKey(state, 'yes, send it', 'consent_yes'),
    'consent_yes',
    'valid reply id wins'
  );
  assert.strictEqual(
    resolveOptionKey(state, 'yes', 'employed_yes'),
    null,
    'stale employed_yes must not fall back to Yes title → consent_yes'
  );
  assert.strictEqual(
    resolveOptionKey(state, 'yes', null),
    'consent_yes',
    'free-text yes still matches when no reply id'
  );
  // eslint-disable-next-line no-console
  console.log('✓ resolveOptionKey rejects stale reply ids');
}

async function testStaleEmploymentYesAtFinalConsent() {
  const store = new MemorySessionStore();
  const logger = new CapturingLogger();
  const sent = [];

  const engine = new FsmEngine({
    sessionStore: store,
    leadLogger: logger,
    sendMessage: async (to, payload) => {
      sent.push({ to, ...payload });
      return { ok: true };
    },
    notifyAgent: async () => ({ delivered: true }),
  });

  const wa = '27822220001';
  await driveToFinalConsent(engine, wa);

  const before = await store.get(wa);
  assert.strictEqual(before.currentState, 'FINAL_CONSENT');
  const sentBefore = sent.length;

  // Stale employment Yes button (id + title as Meta would send).
  await engine.handleInbound(wa, 'Yes', { replyId: 'employed_yes' });

  const after = await store.get(wa);
  assert.strictEqual(
    after.currentState,
    'FINAL_CONSENT',
    'must stay on FINAL_CONSENT — not treat stale Yes as consent_yes'
  );
  assert.strictEqual(logger.leads.length, 0, 'must not log qualified lead');
  assert.ok(
    !logger.leads.some((l) => l.exitReason === 'qualified_self_serve'),
    'no qualified_self_serve lead'
  );
  assert.ok(
    sent.length > sentBefore,
    'should reprompt / handle as invalid, not advance silently'
  );
  const advancedToSendLink = sent.some(
    (m) => m.meta && m.meta.stateId === 'SEND_LINK'
  );
  assert.ok(!advancedToSendLink, 'must not send application link');

  // eslint-disable-next-line no-console
  console.log('✓ stale employment Yes at FINAL_CONSENT does not consent');
}

async function testValidConsentStillWorks() {
  const store = new MemorySessionStore();
  const logger = new CapturingLogger();

  const engine = new FsmEngine({
    sessionStore: store,
    leadLogger: logger,
    sendMessage: async () => ({ ok: true }),
    notifyAgent: async () => ({ delivered: true }),
  });

  const wa = '27822220002';
  await driveToFinalConsent(engine, wa);
  await engine.handleInbound(wa, 'Yes, send it', { replyId: 'consent_yes' });

  const session = await store.get(wa);
  assert.strictEqual(session.status, 'soft_closed');
  assert.strictEqual(logger.leads[0].exitReason, 'qualified_self_serve');

  // eslint-disable-next-line no-console
  console.log('✓ valid consent_yes reply id still qualifies');
}

async function main() {
  // eslint-disable-next-line no-console
  console.log('Running stale interactive reply tests…\n');
  testResolveOptionKeyUnit();
  await testStaleEmploymentYesAtFinalConsent();
  await testValidConsentStillWorks();
  // eslint-disable-next-line no-console
  console.log('\nAll stale interactive reply tests passed.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
