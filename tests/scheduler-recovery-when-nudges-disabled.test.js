'use strict';

/**
 * Regression: FOLLOW_UP_ENABLED=false must still flush pendingLead and retry
 * pendingTerminalOutbound. That flag only disables no-reply nudges.
 *
 * Trigger: qualify → SEND_LINK Graph + CRM fail → soft_closed with both
 * pending flags. Operator sets FOLLOW_UP_ENABLED=false (stop reminders).
 * Old scheduler start()/tick() no-op'd entirely, so the application link and
 * CRM lead never recovered while the customer waited silently.
 *
 * Run: node tests/scheduler-recovery-when-nudges-disabled.test.js
 */

const assert = require('assert');
const { MemorySessionStore } = require('../src/session/store');
const { FsmEngine } = require('../src/engine/fsmEngine');
const { FollowUpScheduler } = require('../src/followup/scheduler');
const { driveToFinalConsent } = require('./melrose-path');

class CapturingLogger {
  constructor() {
    this.leads = [];
    this.fail = false;
  }

  async logLead(record) {
    if (this.fail) throw new Error('simulated CRM failure');
    this.leads.push(record);
    return record;
  }
}

function nudgeDisabledConfig() {
  return {
    enabled: false,
    firstDelayMs: 1,
    intervalMs: 1,
    maxCount: 3,
    pollMs: 1000,
    includePrompt: true,
    notifyAgentOnExhausted: false,
  };
}

async function testStartStillPollsWhenNudgesDisabled() {
  const store = new MemorySessionStore();
  const engine = new FsmEngine({
    sessionStore: store,
    leadLogger: new CapturingLogger(),
    sendMessage: async () => ({ ok: true }),
    notifyAgent: async () => ({ delivered: true }),
  });

  let intervalMs = null;
  const scheduler = new FollowUpScheduler({
    engine,
    sessionStore: store,
    followUpConfig: nudgeDisabledConfig(),
    setIntervalFn: (fn, ms) => {
      intervalMs = ms;
      return { unref() {} };
    },
    clearIntervalFn: () => {},
  });

  scheduler.start();
  assert.ok(scheduler._timer, 'recovery poll must start when nudges are disabled');
  assert.strictEqual(intervalMs, 1000);
  scheduler.stop();
  // eslint-disable-next-line no-console
  console.log('✓ start() still schedules recovery poll when FOLLOW_UP_ENABLED=false');
}

async function testTickFlushesLeadAndRetriesTerminalWhenNudgesDisabled() {
  const store = new MemorySessionStore();
  const logger = new CapturingLogger();
  const sent = [];
  let failSend = false;
  let clock = 1_000_000;

  const engine = new FsmEngine({
    sessionStore: store,
    leadLogger: logger,
    sendMessage: async (to, payload) => {
      if (failSend) throw new Error('simulated Graph API failure');
      sent.push({ to, meta: payload && payload.meta });
      return { ok: true };
    },
    notifyAgent: async () => ({ delivered: true }),
    options: {
      stubMarker: true,
      nowFn: () => clock,
    },
  });

  const wa = '27828880001';
  await driveToFinalConsent(engine, wa);

  logger.fail = true;
  failSend = true;
  await assert.rejects(
    () => engine.handleInbound(wa, 'yes'),
    /simulated Graph API failure/
  );

  let session = await store.get(wa);
  assert.strictEqual(session.status, 'soft_closed');
  assert.ok(session.pendingLead, 'CRM failure must queue pendingLead');
  assert.ok(
    session.pendingTerminalOutbound,
    'Graph failure must queue pendingTerminalOutbound'
  );
  assert.strictEqual(logger.leads.length, 0);

  logger.fail = false;
  failSend = false;
  const beforeSent = sent.length;

  // Leave an active waiting session that would get a nudge if enabled.
  const activeWa = '27828880002';
  await engine.handleInbound(activeWa, 'hi');
  const active = await store.get(activeWa);
  assert.strictEqual(active.status, 'active');
  clock = active.lastBotMessageAt + 60 * 60 * 1000;

  const scheduler = new FollowUpScheduler({
    engine,
    sessionStore: store,
    followUpConfig: nudgeDisabledConfig(),
    nowFn: () => clock,
  });

  const result = await scheduler.tick(clock);
  assert.strictEqual(
    result.skipped,
    undefined,
    'tick must not no-op when nudges are disabled'
  );
  assert.strictEqual(result.nudgesEnabled, false);
  assert.strictEqual(result.flushed, 1, 'pendingLead must flush with nudges off');
  assert.strictEqual(
    result.resentTerminal,
    1,
    'pendingTerminalOutbound must retry with nudges off'
  );
  assert.strictEqual(result.sent, 0, 'no-reply nudges must stay off');

  session = await store.get(wa);
  assert.strictEqual(session.pendingLead, null);
  assert.strictEqual(session.pendingTerminalOutbound, null);
  assert.strictEqual(logger.leads.length, 1);
  assert.strictEqual(logger.leads[0].exitReason, 'qualified_self_serve');

  const terminalSends = sent
    .slice(beforeSent)
    .filter((s) => s.meta && s.meta.stateId === 'SEND_LINK');
  assert.ok(terminalSends.length >= 1, 'application link must be re-sent');

  const activeAfter = await store.get(activeWa);
  assert.strictEqual(
    activeAfter.followUpCount,
    0,
    'active sessions must not receive nudges when disabled'
  );

  // eslint-disable-next-line no-console
  console.log(
    '✓ tick flushes pendingLead + retries terminal outbound with FOLLOW_UP_ENABLED=false'
  );
}

async function main() {
  // eslint-disable-next-line no-console
  console.log('Running scheduler recovery-when-nudges-disabled tests…\n');
  await testStartStillPollsWhenNudgesDisabled();
  await testTickFlushesLeadAndRetriesTerminalWhenNudgesDisabled();
  // eslint-disable-next-line no-console
  console.log('\nAll scheduler recovery-when-nudges-disabled tests passed.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
