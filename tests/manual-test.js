'use strict';

/**
 * Manual FSM exercise script — dummy/stub copy only, no real advice content.
 *
 * Covers:
 *  1) Full qualify path
 *  2) Each decline branch (no_license, affordability, credit, declined_self_serve)
 *  3) Invalid-input retry + escalation to HUMAN_HANDOVER
 *  4) Help-intent interrupt from two different states
 *  5) Soft-decline reopen
 *  6) No-reply follow-ups (30m first, then 4h cadence) via fake clock
 *
 * Run: npm run test:manual
 */

const assert = require('assert');
const config = require('../src/config');
const { MemorySessionStore } = require('../src/session/store');
const { FsmEngine } = require('../src/engine/fsmEngine');
const { FollowUpScheduler } = require('../src/followup/scheduler');
const { buildRecord } = require('../src/logger/leadLogger');

const THIRTY_MIN = 30 * 60 * 1000;
const FOUR_HOURS = 4 * 60 * 60 * 1000;

class CapturingLogger {
  constructor() {
    this.leads = [];
  }

  async logLead(record) {
    this.leads.push(record);
    return record;
  }
}

function createHarness(label, { nowFn } = {}) {
  const messages = [];
  const agentEvents = [];
  const logger = new CapturingLogger();
  const store = new MemorySessionStore();
  let clock = Date.now();

  const engine = new FsmEngine({
    sessionStore: store,
    leadLogger: logger,
    sendMessage: async (to, payload) => {
      messages.push({ to, ...payload, at: (nowFn || (() => clock))() });
      return { ok: true };
    },
    notifyAgent: async (event) => {
      agentEvents.push(event);
      return { delivered: false, reason: 'test' };
    },
    options: {
      stubMarker: true,
      nowFn: nowFn || (() => clock),
    },
  });

  return {
    label,
    engine,
    store,
    logger,
    messages,
    agentEvents,
    get clock() {
      return clock;
    },
    setClock(ms) {
      clock = ms;
    },
    advance(ms) {
      clock += ms;
      return clock;
    },
    async say(wa, text) {
      return engine.handleInbound(wa, text);
    },
  };
}

function lastLead(h) {
  return h.logger.leads[h.logger.leads.length - 1];
}

function assertFooterOnOutbound(h, minExpected = 1) {
  const withFooter = h.messages.filter(
    (m) => m.text && String(m.text).includes('{{COPY.help_footer}}')
  );
  assert.ok(
    withFooter.length >= minExpected,
    `${h.label}: expected help footer on outbound turns`
  );
}

async function testFullQualifyPath() {
  const h = createHarness('full_qualify');
  const wa = '27000000001';

  await h.say(wa, 'hi'); // → GREETING
  await h.say(wa, '3'); // → LICENSE_CHECK
  await h.say(wa, 'yes'); // → INCOME_CHECK
  await h.say(wa, '2'); // mid → CREDIT_CHECK
  await h.say(wa, 'great'); // → CONFIRM_QUALIFY
  await h.say(wa, 'yes'); // → QUALIFIED_LINK

  const lead = lastLead(h);
  assert.strictEqual(lead.exitReason, 'qualified_self_serve');
  assert.deepStrictEqual(lead.path, [
    'GREETING',
    'LICENSE_CHECK',
    'INCOME_CHECK',
    'CREDIT_CHECK',
    'CONFIRM_QUALIFY',
    'QUALIFIED_LINK',
  ]);
  assertFooterOnOutbound(h);
  // eslint-disable-next-line no-console
  console.log('✓ full qualify path');
}

async function testViaSpecialAndStock() {
  const h = createHarness('special_then_qualify_start');
  const wa = '27000000002';

  await h.say(wa, 'hello');
  await h.say(wa, '1'); // SPECIAL_INFO
  await h.say(wa, 'continue'); // → LICENSE_CHECK
  const session = await h.store.get(wa);
  assert.strictEqual(session.currentState, 'LICENSE_CHECK');
  assert.deepStrictEqual(session.path, ['GREETING', 'SPECIAL_INFO', 'LICENSE_CHECK']);

  const h2 = createHarness('stock_then_license');
  const wa2 = '27000000003';
  await h2.say(wa2, 'hi');
  await h2.say(wa2, '2'); // STOCK_LIST
  const stockMsg = h2.messages.find((m) => m.mediaSlot === 'stock_list');
  assert.ok(stockMsg, 'stock mediaSlot present on outbound');
  await h2.say(wa2, '1'); // → LICENSE_CHECK
  const s2 = await h2.store.get(wa2);
  assert.strictEqual(s2.currentState, 'LICENSE_CHECK');
  // eslint-disable-next-line no-console
  console.log('✓ SPECIAL_INFO / STOCK_LIST continue to LICENSE_CHECK');
}

async function testNoLicenseDecline() {
  const h = createHarness('no_license');
  const wa = '27000000004';
  await h.say(wa, 'hi');
  await h.say(wa, '3');
  await h.say(wa, 'no');
  const lead = lastLead(h);
  assert.strictEqual(lead.exitReason, 'no_license');
  assert.ok(lead.path.includes('NO_LICENSE_ADVICE'));
  // soft reopen
  await h.say(wa, 'hello again');
  const session = await h.store.get(wa);
  assert.strictEqual(session.currentState, 'GREETING');
  assert.deepStrictEqual(session.path, ['GREETING']);
  // eslint-disable-next-line no-console
  console.log('✓ no_license decline + soft reopen');
}

async function testAffordabilityDecline() {
  const h = createHarness('affordability');
  const wa = '27000000005';
  await h.say(wa, 'hi');
  await h.say(wa, '3');
  await h.say(wa, 'yes');
  await h.say(wa, '1'); // below
  const lead = lastLead(h);
  assert.strictEqual(lead.exitReason, 'affordability_decline');
  assert.ok(lead.path.includes('AFFORDABILITY_DECLINE'));
  // eslint-disable-next-line no-console
  console.log('✓ affordability_decline');
}

async function testCreditDecline() {
  const h = createHarness('credit');
  const wa = '27000000006';
  await h.say(wa, 'hi');
  await h.say(wa, '3');
  await h.say(wa, 'yes');
  await h.say(wa, '3'); // above
  await h.say(wa, 'poor');
  const lead = lastLead(h);
  assert.strictEqual(lead.exitReason, 'credit_decline');
  assert.ok(lead.path.includes('CREDIT_DECLINE'));
  // eslint-disable-next-line no-console
  console.log('✓ credit_decline');
}

async function testDeclinedSelfServe() {
  const h = createHarness('declined_self_serve');
  const wa = '27000000007';
  await h.say(wa, 'hi');
  await h.say(wa, '3');
  await h.say(wa, 'yes');
  await h.say(wa, '2');
  await h.say(wa, 'average');
  await h.say(wa, 'no');
  const lead = lastLead(h);
  assert.strictEqual(lead.exitReason, 'declined_self_serve');
  assert.ok(h.agentEvents.some((e) => e.exitReason === 'declined_self_serve'));
  // eslint-disable-next-line no-console
  console.log('✓ declined_self_serve + agent notify');
}

async function testInvalidRetryThenEscalate() {
  const h = createHarness('invalid_escalate');
  const wa = '27000000008';
  await h.say(wa, 'hi'); // GREETING
  const before = h.messages.length;

  await h.say(wa, 'zzzz'); // invalid #1 → re-prompt
  const session1 = await h.store.get(wa);
  assert.strictEqual(session1.currentState, 'GREETING');
  assert.strictEqual(session1.invalidAttempts, 1);
  assert.ok(h.messages.length > before, 're-prompt sent');

  await h.say(wa, 'still-wrong'); // invalid #2 → HUMAN_HANDOVER (max=1)
  const lead = lastLead(h);
  assert.strictEqual(lead.exitReason, 'human_requested');
  assert.strictEqual(lead.interruptedFrom, 'GREETING');
  assert.ok(lead.path.includes('HUMAN_HANDOVER'));
  assert.ok(
    config.fsm.maxInvalidAttempts >= 1,
    'max invalid attempts should allow one re-prompt'
  );
  // eslint-disable-next-line no-console
  console.log('✓ invalid retry then escalate (maxInvalidAttempts=%s)', config.fsm.maxInvalidAttempts);
}

async function testHelpIntentFromTwoStates() {
  // From LICENSE_CHECK
  const h1 = createHarness('help_from_license');
  const wa1 = '27000000009';
  await h1.say(wa1, 'hi');
  await h1.say(wa1, '3'); // LICENSE_CHECK
  await h1.say(wa1, 'help');
  const lead1 = lastLead(h1);
  assert.strictEqual(lead1.exitReason, 'human_requested');
  assert.strictEqual(lead1.interruptedFrom, 'LICENSE_CHECK');
  assert.ok(h1.agentEvents.length >= 1);

  // Quiet: further messages ignored until reopen
  const quietResult = await h1.say(wa1, 'anything else');
  assert.strictEqual(quietResult.quiet, true);
  const leadsAfterQuiet = h1.logger.leads.length;

  // From CREDIT_CHECK
  const h2 = createHarness('help_from_credit');
  const wa2 = '27000000010';
  await h2.say(wa2, 'hi');
  await h2.say(wa2, '3');
  await h2.say(wa2, 'yes');
  await h2.say(wa2, '2');
  await h2.say(wa2, 'agent'); // help intent
  const lead2 = lastLead(h2);
  assert.strictEqual(lead2.exitReason, 'human_requested');
  assert.strictEqual(lead2.interruptedFrom, 'CREDIT_CHECK');

  // Reopen quiet thread
  await h1.say(wa1, 'restart');
  const s1 = await h1.store.get(wa1);
  assert.strictEqual(s1.currentState, 'GREETING');
  assert.ok(h1.logger.leads.length === leadsAfterQuiet, 'no extra lead while quiet');

  // eslint-disable-next-line no-console
  console.log('✓ help-intent interrupt from LICENSE_CHECK and CREDIT_CHECK');
}

async function testIncomeAbovePathToConfirm() {
  const h = createHarness('income_above');
  const wa = '27000000011';
  await h.say(wa, 'hi');
  await h.say(wa, 'qualify me');
  await h.say(wa, 'y');
  await h.say(wa, 'above');
  const session = await h.store.get(wa);
  assert.strictEqual(session.currentState, 'CREDIT_CHECK');
  // eslint-disable-next-line no-console
  console.log('✓ income above → CREDIT_CHECK');
}

async function testFollowUpCadence() {
  const h = createHarness('follow_up_cadence');
  const wa = '27000000012';
  const fuCfg = {
    enabled: true,
    firstDelayMs: THIRTY_MIN,
    intervalMs: FOUR_HOURS,
    maxCount: 3,
    includePrompt: true,
    notifyAgentOnExhausted: true,
  };

  await h.say(wa, 'hi'); // GREETING — arms follow-up
  let session = await h.store.get(wa);
  assert.strictEqual(session.currentState, 'GREETING');
  assert.ok(session.lastBotMessageAt, 'lastBotMessageAt armed');
  assert.strictEqual(session.followUpCount, 0);

  // Not due yet
  h.advance(THIRTY_MIN - 1000);
  let result = await h.engine.processFollowUp(wa, h.clock, fuCfg);
  assert.strictEqual(result.sent, false);
  assert.strictEqual(result.reason, 'not_due');

  // First follow-up at 30 minutes
  h.advance(1000);
  const before = h.messages.length;
  result = await h.engine.processFollowUp(wa, h.clock, fuCfg);
  assert.strictEqual(result.sent, true);
  assert.strictEqual(result.followUpCount, 1);
  const firstFu = h.messages[h.messages.length - 1];
  assert.strictEqual(firstFu.meta.type, 'follow_up');
  assert.ok(String(firstFu.text).includes('{{COPY.follow_up_first}}'));
  assert.ok(String(firstFu.text).includes('{{COPY.greeting_prompt}}'));
  assert.ok(h.messages.length > before);

  // Second follow-up after 4 hours (not before)
  h.advance(FOUR_HOURS - 1000);
  result = await h.engine.processFollowUp(wa, h.clock, fuCfg);
  assert.strictEqual(result.sent, false);

  h.advance(1000);
  result = await h.engine.processFollowUp(wa, h.clock, fuCfg);
  assert.strictEqual(result.sent, true);
  assert.strictEqual(result.followUpCount, 2);
  assert.ok(
    String(h.messages[h.messages.length - 1].text).includes('{{COPY.follow_up_repeat}}')
  );

  // Third follow-up after another 4 hours → exhausted
  h.advance(FOUR_HOURS);
  result = await h.engine.processFollowUp(wa, h.clock, fuCfg);
  assert.strictEqual(result.sent, true);
  assert.strictEqual(result.exhausted, true);
  assert.ok(h.agentEvents.some((e) => e.type === 'follow_up_exhausted'));

  // No more
  h.advance(FOUR_HOURS);
  result = await h.engine.processFollowUp(wa, h.clock, fuCfg);
  assert.strictEqual(result.sent, false);

  // Customer reply resets / advances state — new arm
  await h.say(wa, '3');
  session = await h.store.get(wa);
  assert.strictEqual(session.currentState, 'LICENSE_CHECK');
  assert.strictEqual(session.followUpCount, 0);
  assert.strictEqual(session.followUpsExhausted, false);

  // eslint-disable-next-line no-console
  console.log('✓ follow-up cadence (30m then 4h) + exhaust + reset on reply');
}

async function testFollowUpSkippedOnTerminalAndScheduler() {
  const h = createHarness('follow_up_terminal_skip');
  const wa = '27000000013';
  const fuCfg = {
    enabled: true,
    firstDelayMs: THIRTY_MIN,
    intervalMs: FOUR_HOURS,
    maxCount: 3,
    includePrompt: true,
    notifyAgentOnExhausted: false,
  };

  await h.say(wa, 'hi');
  await h.say(wa, '3');
  await h.say(wa, 'no'); // NO_LICENSE_ADVICE terminal
  h.advance(THIRTY_MIN + 1000);
  const result = await h.engine.processFollowUp(wa, h.clock, fuCfg);
  assert.strictEqual(result.sent, false);

  // Scheduler tick over waiting session
  const h2 = createHarness('follow_up_scheduler');
  const wa2 = '27000000014';
  await h2.say(wa2, 'hi');
  const scheduler = new FollowUpScheduler({
    engine: h2.engine,
    sessionStore: h2.store,
    followUpConfig: { ...fuCfg, pollMs: 60_000 },
    nowFn: () => h2.clock,
  });
  h2.advance(THIRTY_MIN);
  const tick = await scheduler.tick(h2.clock);
  assert.strictEqual(tick.sent, 1);

  // eslint-disable-next-line no-console
  console.log('✓ follow-ups skipped on terminal; scheduler tick sends due');
}

async function main() {
  // Ensure default invalid attempt config is sensible for the scenario
  // eslint-disable-next-line no-console
  console.log('Running FSM manual tests (stub copy markers, no advice content)…\n');

  await testFullQualifyPath();
  await testViaSpecialAndStock();
  await testNoLicenseDecline();
  await testAffordabilityDecline();
  await testCreditDecline();
  await testDeclinedSelfServe();
  await testInvalidRetryThenEscalate();
  await testHelpIntentFromTwoStates();
  await testIncomeAbovePathToConfirm();
  await testFollowUpCadence();
  await testFollowUpSkippedOnTerminalAndScheduler();

  // Sanity: buildRecord shape
  const sample = buildRecord({
    waNumber: '0',
    exitReason: 'test',
    path: ['GREETING'],
  });
  assert.ok(sample.timestamp);

  // Default config sanity
  assert.strictEqual(config.followUp.firstDelayMs, THIRTY_MIN);
  assert.strictEqual(config.followUp.intervalMs, FOUR_HOURS);

  // eslint-disable-next-line no-console
  console.log('\nAll manual FSM scenarios passed.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('\nManual test failed:', err);
  process.exit(1);
});
