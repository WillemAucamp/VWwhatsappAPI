'use strict';

/**
 * Regression: a single processFollowUp throw must not abort the scheduler tick.
 * Otherwise every later waiting session in listAll() order is starved forever
 * when one recipient permanently fails (blocked / invalid WhatsApp number).
 *
 * Run: node tests/followup-tick-isolation.test.js
 */

const assert = require('assert');
const { MemorySessionStore } = require('../src/session/store');
const { FsmEngine } = require('../src/engine/fsmEngine');
const { FollowUpScheduler } = require('../src/followup/scheduler');

const FIRST_DELAY = 30 * 60 * 1000;

async function testFailingRecipientDoesNotStarveLaterSessions() {
  const store = new MemorySessionStore();
  let clock = 1_000_000;
  const followUps = [];

  const engine = new FsmEngine({
    sessionStore: store,
    leadLogger: {
      async logLead(record) {
        return record;
      },
    },
    sendMessage: async (to, payload) => {
      if (payload.meta && payload.meta.type === 'follow_up') {
        if (to === '27820000002') {
          throw new Error('simulated permanent Graph failure');
        }
        followUps.push(to);
      }
      return { ok: true };
    },
    notifyAgent: async () => ({ delivered: false }),
    options: {
      stubMarker: true,
      nowFn: () => clock,
    },
  });

  // Lexicographic order: 27820000001, 27820000002 (bad), 27820000003
  for (const wa of ['27820000001', '27820000002', '27820000003']) {
    await engine.handleInbound(wa, 'hi');
  }

  clock += FIRST_DELAY + 1;

  const scheduler = new FollowUpScheduler({
    engine,
    sessionStore: store,
    followUpConfig: {
      enabled: true,
      firstDelayMs: FIRST_DELAY,
      intervalMs: 4 * 60 * 60 * 1000,
      maxCount: 3,
      pollMs: 60_000,
      includePrompt: true,
      notifyAgentOnExhausted: false,
    },
    nowFn: () => clock,
  });

  const result = await scheduler.tick(clock);

  assert.strictEqual(result.sent, 2, 'two healthy recipients should get follow-ups');
  assert.ok(result.errors && result.errors.length === 1, 'one isolated error');
  assert.strictEqual(result.errors[0].waNumber, '27820000002');
  assert.deepStrictEqual(
    followUps.sort(),
    ['27820000001', '27820000003'],
    'later session must not be starved by earlier failure'
  );

  const bad = await store.get('27820000002');
  const late = await store.get('27820000003');
  assert.strictEqual(bad.followUpCount, 0, 'failed send must not advance counter');
  assert.strictEqual(late.followUpCount, 1, 'later session counter must advance');

  // eslint-disable-next-line no-console
  console.log('✓ failing follow-up recipient does not starve later sessions');
}

async function main() {
  // eslint-disable-next-line no-console
  console.log('Running follow-up tick isolation regression…\n');
  await testFailingRecipientDoesNotStarveLaterSessions();
  // eslint-disable-next-line no-console
  console.log('\nAll follow-up tick isolation tests passed.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('\nTest failed:', err);
  process.exit(1);
});
