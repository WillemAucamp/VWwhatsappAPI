'use strict';

/**
 * Regression: terminal soft_closed/quiet must be persisted before logLead.
 *
 * Trigger: Graph send for SEND_LINK succeeds, lead is logged, then
 * sessionStore.set throws (disk full / Redis blip). Old order left the
 * session active at FINAL_CONSENT, so a retry/"yes" double-logged the
 * lead and re-sent the application link.
 *
 * Run: node tests/terminal-persist-before-lead.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  MemorySessionStore,
  FileSessionStore,
  createEmptySession,
} = require('../src/session/store');
const { FsmEngine } = require('../src/engine/fsmEngine');
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

async function driveToConfirmQualify(engine, wa) {
  await driveToFinalConsent(engine, wa);
  const session = await engine.sessionStore.get(wa);
  assert.strictEqual(session.currentState, 'FINAL_CONSENT');
}

async function testTerminalSetFailureDoesNotDoubleLogLead() {
  const store = new MemorySessionStore();
  const logger = new CapturingLogger();
  let rejectQualifiedSet = false;
  const origSet = store.set.bind(store);
  store.set = async (wa, session) => {
    if (rejectQualifiedSet && session.currentState === 'SEND_LINK') {
      throw new Error('simulated session persist failure');
    }
    return origSet(wa, session);
  };

  const engine = new FsmEngine({
    sessionStore: store,
    leadLogger: logger,
    sendMessage: async () => ({ ok: true }),
    notifyAgent: async () => ({ delivered: false }),
    options: { stubMarker: true },
  });

  const wa = '27821120001';
  await driveToConfirmQualify(engine, wa);

  rejectQualifiedSet = true;
  await assert.rejects(
    () => engine.handleInbound(wa, 'yes'),
    /simulated session persist failure/
  );

  assert.strictEqual(
    logger.leads.length,
    0,
    'lead must not be written when terminal persist fails'
  );

  const mid = await store.get(wa);
  assert.strictEqual(mid.currentState, 'FINAL_CONSENT');
  assert.strictEqual(mid.status, 'active');

  rejectQualifiedSet = false;
  await engine.handleInbound(wa, 'yes');

  assert.strictEqual(logger.leads.length, 1);
  assert.strictEqual(logger.leads[0].exitReason, 'qualified_self_serve');

  const final = await store.get(wa);
  assert.strictEqual(final.status, 'soft_closed');
  assert.strictEqual(final.currentState, 'SEND_LINK');

  // eslint-disable-next-line no-console
  console.log('✓ terminal persist failure does not double-log leads');
}

async function testFollowUpPersistBeforeSendPreventsDuplicate() {
  const store = new MemorySessionStore();
  const logger = new CapturingLogger();
  let failSet = false;
  let sends = 0;
  const origSet = store.set.bind(store);
  store.set = async (wa, session) => {
    if (failSet) throw new Error('disk full');
    return origSet(wa, session);
  };

  let now = 1_000_000;
  const engine = new FsmEngine({
    sessionStore: store,
    leadLogger: logger,
    sendMessage: async () => {
      sends += 1;
      return { ok: true };
    },
    notifyAgent: async () => ({ delivered: false }),
    options: { stubMarker: true, nowFn: () => now },
  });

  const wa = '27821120002';
  const fuCfg = {
    enabled: true,
    firstDelayMs: config.followUp.firstDelayMs,
    intervalMs: config.followUp.intervalMs,
    maxCount: 3,
    includePrompt: true,
    notifyAgentOnExhausted: false,
  };

  await engine.handleInbound(wa, 'hi');
  now += fuCfg.firstDelayMs + 1;
  sends = 0;

  // Fail the pre-send persist — must not call Graph at all
  failSet = true;
  await assert.rejects(() => engine.processFollowUp(wa, now, fuCfg), /disk full/);
  assert.strictEqual(sends, 0, 'must not send follow-up when persist fails');

  failSet = false;
  const first = await engine.processFollowUp(wa, now, fuCfg);
  assert.strictEqual(first.sent, true);
  assert.strictEqual(sends, 1);

  // Already consumed for this due window — no duplicate at same `now`
  const second = await engine.processFollowUp(wa, now, fuCfg);
  assert.strictEqual(second.sent, false);
  assert.strictEqual(sends, 1);

  // eslint-disable-next-line no-console
  console.log('✓ follow-up slot persisted before send blocks duplicates');
}

async function testFileSessionStoreAtomicReplace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-sess-'));
  const store = new FileSessionStore(dir);
  const wa = '27821120003';
  const session = createEmptySession(wa);
  session.currentState = 'CREDIT_CHECK';
  session.status = 'active';
  session.path = [
    'GREETING',
    'QUALIFY_CONSENT',
    'EMPLOYED_INCOME_CHECK',
    'LICENSE_CHECK',
    'CREDIT_CHECK',
  ];
  await store.set(wa, session);

  const file = path.join(dir, `${wa}.json`);
  assert.ok(fs.existsSync(file));
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(raw.includes('CREDIT_CHECK'));

  // No leftover tmp files from the atomic write
  const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  assert.deepStrictEqual(leftovers, []);

  const loaded = await store.get(wa);
  assert.strictEqual(loaded.currentState, 'CREDIT_CHECK');
  assert.deepStrictEqual(loaded.path, session.path);

  // eslint-disable-next-line no-console
  console.log('✓ FileSessionStore set uses atomic rename');
}

async function main() {
  // eslint-disable-next-line no-console
  console.log('Running terminal-persist / follow-up / atomic-store tests…\n');
  await testTerminalSetFailureDoesNotDoubleLogLead();
  await testFollowUpPersistBeforeSendPreventsDuplicate();
  await testFileSessionStoreAtomicReplace();
  // eslint-disable-next-line no-console
  console.log('\nAll terminal-persist regression tests passed.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('\nTest failed:', err);
  process.exit(1);
});
