'use strict';

/**
 * Melrose FSM exercise — VW_Melrose_WhatsApp_Bot_Flow.pdf paths.
 *
 * Run: npm run test:manual
 */

const assert = require('assert');
const config = require('../src/config');
const copy = require('../src/content/copy');
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
    async tap(wa, replyId, title = '') {
      return engine.handleInbound(wa, title, { replyId });
    },
  };
}

function lastLead(h) {
  return h.logger.leads[h.logger.leads.length - 1];
}

function assertGreetingCopy(h) {
  const first = h.messages[0];
  assert.ok(first && first.text, `${h.label}: expected greeting outbound`);
  assert.ok(
    String(first.text).includes('Willem Aucamp') &&
      String(first.text).includes('VW Melrose'),
    `${h.label}: greeting must use Melrose script`
  );
}

function assertInteractiveMenu(h) {
  const interactive = h.messages.filter((m) => m.interactive);
  assert.ok(interactive.length >= 1, `${h.label}: expected interactive menu`);
  const greet = interactive[0];
  assert.strictEqual(greet.interactive.type, 'button');
  // See our cars temporarily hidden from the greeting menu.
  assert.strictEqual(greet.interactive.buttons.length, 2);
  assert.deepStrictEqual(
    greet.interactive.buttons.map((b) => b.id),
    ['qualify_me', 'saw_special']
  );
  assert.deepStrictEqual(
    greet.interactive.buttons.map((b) => b.title),
    ['Qualify Me', 'I saw a special']
  );
}

async function testFullQualifyPath() {
  const h = createHarness('full_qualify');
  const wa = '27000000001';

  await h.say(wa, 'hi');
  await h.say(wa, 'qualify me');
  await h.say(wa, 'yes'); // employed + income
  await h.say(wa, 'yes'); // license
  await h.say(wa, 'good');
  await h.say(wa, 'yes'); // final consent

  const lead = lastLead(h);
  assert.strictEqual(lead.exitReason, 'qualified_self_serve');
  assert.deepStrictEqual(lead.path, [
    'GREETING',
    'EMPLOYED_INCOME_CHECK',
    'LICENSE_CHECK',
    'CREDIT_CHECK',
    'FINAL_CONSENT',
    'SEND_LINK',
  ]);
  assertGreetingCopy(h);
  // eslint-disable-next-line no-console
  console.log('✓ full qualify path');
}

async function testInteractiveQualifyPath() {
  const h = createHarness('interactive_qualify');
  const wa = '27000000099';

  await h.say(wa, 'hi');
  assertInteractiveMenu(h);
  await h.tap(wa, 'qualify_me', 'Qualify Me');
  await h.tap(wa, 'employed_income_yes', 'Yes');
  await h.tap(wa, 'license_yes', 'Yes');
  await h.tap(wa, 'credit_good', 'Good');
  await h.tap(wa, 'consent_yes', 'Yes, send it');

  const lead = lastLead(h);
  assert.strictEqual(lead.exitReason, 'qualified_self_serve');
  const lastText = String(h.messages[h.messages.length - 1].text);
  assert.ok(lastText.includes('https://forms.gle/eZq13HF91GpGqivU9'));
  assert.ok(lastText.includes('Click on the link below'));
  assert.ok(lastText.includes('estimated repayments'));
  // eslint-disable-next-line no-console
  console.log('✓ interactive qualify path');
}

async function testQualifyMeWithoutPriorGreetingSession() {
  // After Render redeploy, session is gone but WhatsApp still shows old buttons.
  const h = createHarness('qualify_me_cold');
  const wa = '27000000100';
  await h.tap(wa, 'qualify_me', 'Qualify Me');
  const session = await h.store.get(wa);
  assert.strictEqual(session.currentState, 'EMPLOYED_INCOME_CHECK');
  assert.deepStrictEqual(session.path, ['GREETING', 'EMPLOYED_INCOME_CHECK']);
  assert.ok(
    h.messages.some((m) => m.meta && m.meta.stateId === 'EMPLOYED_INCOME_CHECK'),
    'should enter qualification tree, not bounce to GREETING'
  );
  assert.ok(
    !h.messages.some((m) => m.meta && m.meta.stateId === 'GREETING'),
    'should not re-send main menu when Qualify Me was tapped'
  );
  // eslint-disable-next-line no-console
  console.log('✓ Qualify Me with no session → employed+income check');
}

async function testQualifyMeAfterSoftClose() {
  const h = createHarness('qualify_me_soft');
  const wa = '27000000101';
  await h.say(wa, 'hi');
  await h.tap(wa, 'qualify_me', 'Qualify Me');
  await h.tap(wa, 'employed_income_no', 'No');
  let session = await h.store.get(wa);
  assert.strictEqual(session.status, 'soft_closed');

  await h.tap(wa, 'qualify_me', 'Qualify Me');
  session = await h.store.get(wa);
  assert.strictEqual(session.currentState, 'EMPLOYED_INCOME_CHECK');
  assert.strictEqual(session.status, 'active');
  // eslint-disable-next-line no-console
  console.log('✓ Qualify Me after soft_closed → employed+income check');
}

async function testNotReadyEndChat() {
  const h = createHarness('not_ready');
  const wa = '27000000005';
  await h.say(wa, 'hi');
  await h.say(wa, 'qualify me');
  await h.say(wa, 'no');
  const lead = lastLead(h);
  assert.strictEqual(lead.exitReason, 'not_ready_income_employment');
  assert.ok(lead.path.includes('END_CHAT_NOT_READY'));
  assert.ok(
    String(h.messages[h.messages.length - 1].text).includes('R9,500')
  );
  await h.say(wa, 'hello again');
  const session = await h.store.get(wa);
  assert.strictEqual(session.currentState, 'GREETING');
  // eslint-disable-next-line no-console
  console.log('✓ not-ready end_chat + soft reopen');
}

async function testLicenseNoHandover() {
  const h = createHarness('license_no');
  const wa = '27000000006';
  await h.say(wa, 'hi');
  await h.say(wa, 'qualify me');
  await h.say(wa, 'yes');
  await h.say(wa, 'no');
  const lead = lastLead(h);
  assert.strictEqual(lead.exitReason, 'no_license');
  assert.ok(h.agentEvents.some((e) => e.type === 'handover'));
  const session = await h.store.get(wa);
  assert.strictEqual(session.status, 'quiet');
  assert.strictEqual(session.agentTakenOver, true);
  const lastText = String(h.messages[h.messages.length - 1].text);
  assert.ok(lastText.includes('license is a must'));
  assert.ok(lastText.includes('community of property'));
  assert.ok(lastText.includes('only one bank'));
  await h.say(wa, 'thanks');
  assert.strictEqual((await h.store.get(wa)).status, 'quiet');
  // eslint-disable-next-line no-console
  console.log('✓ license_no → exceptions plan + quiet for manual replies');
}

async function testCreditBadHandover() {
  const h = createHarness('credit_bad');
  const wa = '27000000007';
  await h.say(wa, 'hi');
  await h.say(wa, 'qualify me');
  await h.say(wa, 'yes');
  await h.say(wa, 'yes');
  await h.say(wa, 'bad');
  const lead = lastLead(h);
  assert.strictEqual(lead.exitReason, 'credit_bad');
  assert.ok(h.agentEvents.some((e) => e.type === 'handover'));
  const session = await h.store.get(wa);
  assert.strictEqual(session.status, 'quiet');
  assert.strictEqual(session.agentTakenOver, true);
  const lastText = String(h.messages[h.messages.length - 1].text);
  assert.ok(lastText.includes('ClearScore'));
  assert.ok(lastText.includes("I've saved your details"));
  assert.ok(lastText.includes('*What to do:*'));
  // Further customer input stays open for staff (quiet), does not restart funnel
  await h.say(wa, 'thanks');
  assert.strictEqual((await h.store.get(wa)).status, 'quiet');
  // eslint-disable-next-line no-console
  console.log('✓ credit_bad → plan + quiet for manual replies');
}

async function testConsentNoHandover() {
  const h = createHarness('final_consent_no');
  const wa = '27000000008';
  await h.say(wa, 'hi');
  await h.say(wa, 'qualify me');
  await h.say(wa, 'yes');
  await h.say(wa, 'yes');
  await h.say(wa, 'good');
  await h.say(wa, 'not right now');
  const lead = lastLead(h);
  assert.strictEqual(lead.exitReason, 'declined_self_serve');
  assert.ok(h.agentEvents.some((e) => e.type === 'handover'));
  // eslint-disable-next-line no-console
  console.log('✓ consent_no → human_handover');
}

async function testOptOutFromGreeting() {
  const h = createHarness('opt_out');
  const wa = '27000000009';
  await h.say(wa, 'hi');
  // Opt-Out is text-matchable (not a main-menu button anymore).
  await h.say(wa, 'opt out');
  const lead = lastLead(h);
  assert.strictEqual(lead.exitReason, 'human_requested');
  assert.strictEqual((await h.store.get(wa)).status, 'quiet');
  // eslint-disable-next-line no-console
  console.log('✓ Opt-Out from greeting → human_handover');
}

async function testInvalidRetryThenEscalate() {
  const h = createHarness('invalid');
  const wa = '27000000010';
  await h.say(wa, 'hi');
  await h.say(wa, 'qualify me');
  await h.say(wa, 'zzzz');
  let session = await h.store.get(wa);
  assert.strictEqual(session.currentState, 'OFF_MENU_RECOVERY');
  assert.strictEqual(session.interruptedFrom, 'EMPLOYED_INCOME_CHECK');
  assert.ok(
    h.messages.some(
      (m) =>
        m.text &&
        m.text.includes("haven't chosen an option") &&
        m.text.includes('*Opt-Out*')
    ),
    'recovery prompt should mention off-menu + bold Opt-Out'
  );
  const recoverySend = h.messages.filter(
    (m) => m.meta && m.meta.stateId === 'OFF_MENU_RECOVERY'
  );
  assert.ok(recoverySend.length >= 1);
  const interactive = recoverySend[recoverySend.length - 1].interactive;
  assert.ok(interactive, 'recovery should send interactive buttons');
  assert.strictEqual(interactive.type, 'button');
  assert.deepStrictEqual(
    interactive.buttons.map((b) => b.id),
    ['human_handover', 'main_menu']
  );
  assert.deepStrictEqual(
    interactive.buttons.map((b) => b.title),
    ['Human-Handover', 'Main-Menu']
  );

  // Main-Menu → first menu (GREETING)
  await h.tap(wa, 'main_menu', 'Main-Menu');
  session = await h.store.get(wa);
  assert.strictEqual(session.currentState, 'GREETING');

  // Off-menu again → recovery → Human-Handover → quiet
  await h.say(wa, 'zzzz');
  session = await h.store.get(wa);
  assert.strictEqual(session.currentState, 'OFF_MENU_RECOVERY');
  await h.tap(wa, 'human_handover', 'Human-Handover');
  const lead = lastLead(h);
  assert.strictEqual(lead.exitReason, 'human_requested');
  session = await h.store.get(wa);
  assert.strictEqual(session.status, 'quiet');
  // eslint-disable-next-line no-console
  console.log('✓ off-menu recovery → Main-Menu / Human-Handover');
}

async function testOffMenuWhenSessionMissingOrSoftClosed() {
  // Wiped / never-started session + gibberish must not dump the main menu.
  const h = createHarness('off_menu_cold');
  const wa = '27000000110';
  await h.say(wa, 'sfds');
  let session = await h.store.get(wa);
  assert.strictEqual(session.currentState, 'OFF_MENU_RECOVERY');
  assert.ok(
    h.messages.some((m) => m.meta && m.meta.stateId === 'OFF_MENU_RECOVERY')
  );
  assert.ok(
    !h.messages.some((m) => m.meta && m.meta.stateId === 'GREETING'),
    'off-menu free text must not open the main menu greeting'
  );

  // Soft-closed + gibberish → recovery (hi still reopens greeting).
  const h2 = createHarness('off_menu_soft');
  const wa2 = '27000000111';
  await h2.say(wa2, 'hi');
  await h2.say(wa2, 'qualify me');
  await h2.say(wa2, 'no');
  assert.strictEqual((await h2.store.get(wa2)).status, 'soft_closed');
  await h2.say(wa2, 'sfds');
  session = await h2.store.get(wa2);
  assert.strictEqual(session.currentState, 'OFF_MENU_RECOVERY');
  assert.strictEqual(session.status, 'active');

  const h3 = createHarness('off_menu_soft_hi');
  const wa3 = '27000000112';
  await h3.say(wa3, 'hi');
  await h3.say(wa3, 'qualify me');
  await h3.say(wa3, 'no');
  await h3.say(wa3, 'hello');
  assert.strictEqual((await h3.store.get(wa3)).currentState, 'GREETING');

  // eslint-disable-next-line no-console
  console.log('✓ off-menu free text → recovery (cold + soft_closed)');
}

async function testHelpIntentFromTwoStates() {
  const h1 = createHarness('help_income');
  const wa1 = '27000000011';
  await h1.say(wa1, 'hi');
  await h1.say(wa1, 'qualify me');
  await h1.say(wa1, 'help');
  const lead1 = lastLead(h1);
  assert.strictEqual(lead1.exitReason, 'human_requested');
  assert.strictEqual(lead1.interruptedFrom, 'EMPLOYED_INCOME_CHECK');

  const h2 = createHarness('help_credit');
  const wa2 = '27000000012';
  await h2.say(wa2, 'hi');
  await h2.say(wa2, 'qualify me');
  await h2.say(wa2, 'yes');
  await h2.say(wa2, 'yes');
  await h2.say(wa2, 'help');
  const lead2 = lastLead(h2);
  assert.strictEqual(lead2.interruptedFrom, 'CREDIT_CHECK');
  // eslint-disable-next-line no-console
  console.log('✓ help-intent interrupt from EMPLOYED_INCOME_CHECK and CREDIT_CHECK');
}

async function testReleaseResumesWhereLeftOff() {
  const h = createHarness('release_resume');
  const wa = '27000000040';
  await h.say(wa, 'hi');
  await h.say(wa, 'qualify me');
  let session = await h.store.get(wa);
  assert.strictEqual(session.currentState, 'EMPLOYED_INCOME_CHECK');

  // Staff desk takeover mid-question
  await h.engine.takeOver(wa, { silent: true });
  session = await h.store.get(wa);
  assert.strictEqual(session.status, 'quiet');
  assert.strictEqual(session.agentTakenOver, true);
  assert.strictEqual(session.interruptedFrom, 'EMPLOYED_INCOME_CHECK');

  await h.engine.releaseToBot(wa);
  session = await h.store.get(wa);
  assert.strictEqual(session.agentTakenOver, false);
  assert.strictEqual(session.status, 'active');
  assert.strictEqual(session.currentState, 'EMPLOYED_INCOME_CHECK');
  assert.ok(
    h.messages.some((m) => m.text && m.text.includes('pick up where we left off'))
  );
  assert.ok(
    h.messages.filter((m) => m.meta && m.meta.stateId === 'EMPLOYED_INCOME_CHECK').length >= 2,
    'employed+income prompt should be re-sent on resume'
  );

  // Bot-driven handover (help) then release also resumes
  const h2 = createHarness('release_after_help');
  const wa2 = '27000000041';
  await h2.say(wa2, 'hi');
  await h2.say(wa2, 'qualify me');
  await h2.say(wa2, 'yes');
  await h2.say(wa2, 'help');
  assert.strictEqual((await h2.store.get(wa2)).interruptedFrom, 'LICENSE_CHECK');
  await h2.engine.releaseToBot(wa2);
  assert.strictEqual((await h2.store.get(wa2)).currentState, 'LICENSE_CHECK');

  // No prior step → release still starts at greeting
  const h3 = createHarness('release_fresh');
  const wa3 = '27000000042';
  await h3.engine.takeOver(wa3, { silent: true });
  await h3.engine.releaseToBot(wa3);
  assert.strictEqual((await h3.store.get(wa3)).currentState, 'GREETING');

  // eslint-disable-next-line no-console
  console.log('✓ release to bot resumes prior step (or greeting if none)');
}

async function testSpecialsMenuThenQualify() {
  const h = createHarness('specials');
  const wa = '27000000013';
  await h.say(wa, 'hi');
  await h.tap(wa, 'saw_special', 'I saw a special');
  let session = await h.store.get(wa);
  assert.strictEqual(session.currentState, 'SPECIALS_MENU');
  const menu = h.messages.filter((m) => m.meta && m.meta.stateId === 'SPECIALS_MENU').pop();
  assert.ok(menu && menu.interactive);
  assert.deepStrictEqual(
    menu.interactive.buttons.map((b) => b.id),
    ['payment_holiday', 'lower_rate', 'discount']
  );

  await h.tap(wa, 'payment_holiday', 'Payment Holiday');
  session = await h.store.get(wa);
  assert.strictEqual(session.currentState, 'EMPLOYED_INCOME_CHECK');
  assert.ok(session.path.includes('PAYMENT_HOLIDAY_INFO'));
  assert.ok(
    h.messages.some(
      (m) => m.text && m.text.includes('Payment Holiday promotion') && m.text.includes('*R15,000*')
    )
  );
  assert.ok(
    h.messages.some((m) => m.meta && m.meta.stateId === 'EMPLOYED_INCOME_CHECK'),
    'should auto-advance into employed+income check'
  );

  // Lower rate path from a fresh chat
  const h2 = createHarness('specials_rate');
  const wa2 = '27000000023';
  await h2.say(wa2, 'hi');
  await h2.tap(wa2, 'saw_special', 'I saw a special');
  await h2.tap(wa2, 'lower_rate', 'Lower Interest Rate');
  assert.strictEqual((await h2.store.get(wa2)).currentState, 'EMPLOYED_INCOME_CHECK');
  assert.ok(
    h2.messages.some((m) => m.text && m.text.includes('Lower Interest Rate Promotion'))
  );

  const h3 = createHarness('specials_discount');
  const wa3 = '27000000033';
  await h3.say(wa3, 'hi');
  await h3.say(wa3, 'i saw a special');
  await h3.tap(wa3, 'discount', 'Discount');
  assert.strictEqual((await h3.store.get(wa3)).currentState, 'EMPLOYED_INCOME_CHECK');
  assert.ok(
    h3.messages.some((m) => m.text && m.text.includes('Deposit Assistance Special'))
  );

  // eslint-disable-next-line no-console
  console.log('✓ I saw a special → description → employed+income check');
}

async function testFollowUpCadence() {
  const h = createHarness('follow_up');
  const wa = '27000000014';
  const fuCfg = {
    enabled: true,
    firstDelayMs: THIRTY_MIN,
    intervalMs: FOUR_HOURS,
    maxCount: 3,
    includePrompt: true,
    notifyAgentOnExhausted: true,
  };

  await h.say(wa, 'hi');
  h.advance(THIRTY_MIN - 1000);
  let result = await h.engine.processFollowUp(wa, h.clock, fuCfg);
  assert.strictEqual(result.sent, false);

  h.advance(1000);
  result = await h.engine.processFollowUp(wa, h.clock, fuCfg);
  assert.strictEqual(result.sent, true);
  const firstFu = h.messages[h.messages.length - 1];
  assert.ok(String(firstFu.text).includes(copy.follow_up_first));
  assert.ok(String(firstFu.text).includes(copy.greeting_prompt));
  assert.ok(firstFu.interactive && firstFu.interactive.type === 'button');

  h.advance(FOUR_HOURS - 1000);
  result = await h.engine.processFollowUp(wa, h.clock, fuCfg);
  assert.strictEqual(result.sent, false);
  h.advance(1000);
  result = await h.engine.processFollowUp(wa, h.clock, fuCfg);
  assert.strictEqual(result.sent, true);
  assert.ok(
    String(h.messages[h.messages.length - 1].text).includes(copy.follow_up_repeat)
  );

  h.advance(FOUR_HOURS);
  result = await h.engine.processFollowUp(wa, h.clock, fuCfg);
  assert.strictEqual(result.exhausted, true);
  assert.ok(h.agentEvents.some((e) => e.type === 'follow_up_exhausted'));
  // eslint-disable-next-line no-console
  console.log('✓ follow-up cadence');
}

async function testFollowUpSkippedOnTerminalAndScheduler() {
  const fuCfg = {
    enabled: true,
    firstDelayMs: THIRTY_MIN,
    intervalMs: FOUR_HOURS,
    maxCount: 3,
    includePrompt: true,
    notifyAgentOnExhausted: false,
  };

  const h = createHarness('follow_up_terminal');
  const wa = '27000000015';
  await h.say(wa, 'hi');
  await h.say(wa, 'qualify me');
  await h.say(wa, 'no'); // not ready → soft terminal
  h.advance(THIRTY_MIN + 1000);
  const result = await h.engine.processFollowUp(wa, h.clock, fuCfg);
  assert.strictEqual(result.sent, false);

  const h2 = createHarness('follow_up_scheduler');
  const wa2 = '27000000016';
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
  // eslint-disable-next-line no-console
  console.log('Running Melrose FSM manual tests…\n');

  await testFullQualifyPath();
  await testInteractiveQualifyPath();
  await testQualifyMeWithoutPriorGreetingSession();
  await testQualifyMeAfterSoftClose();
  await testNotReadyEndChat();
  await testLicenseNoHandover();
  await testCreditBadHandover();
  await testConsentNoHandover();
  await testOptOutFromGreeting();
  await testInvalidRetryThenEscalate();
  await testOffMenuWhenSessionMissingOrSoftClosed();
  await testHelpIntentFromTwoStates();
  await testReleaseResumesWhereLeftOff();
  await testSpecialsMenuThenQualify();
  await testFollowUpCadence();
  await testFollowUpSkippedOnTerminalAndScheduler();

  const sample = buildRecord({
    waNumber: '0',
    exitReason: 'test',
    path: ['GREETING'],
  });
  assert.ok(sample.timestamp);
  assert.strictEqual(config.followUp.firstDelayMs, THIRTY_MIN);
  assert.strictEqual(config.followUp.intervalMs, FOUR_HOURS);

  // eslint-disable-next-line no-console
  console.log('\nAll Melrose FSM scenarios passed.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('\nManual test failed:', err);
  process.exit(1);
});
