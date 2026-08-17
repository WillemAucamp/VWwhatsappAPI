'use strict';

/**
 * Regression: no-reply follow-up must not race inbound replies.
 *
 * Trigger: processFollowUp loads a waiting session and awaits a slow Graph send;
 * meanwhile the customer replies and advances (or opts out). Without a shared
 * per-number lock, the follow-up's later sessionStore.set overwrites that
 * progress — lost answers / undone opt-out.
 *
 * Run: node tests/followup-inbound-race.test.js
 */

const assert = require('assert');
const { MemorySessionStore } = require('../src/session/store');
const { FsmEngine } = require('../src/engine/fsmEngine');

const THIRTY_MIN = 30 * 60 * 1000;

class CapturingLogger {
  constructor() {
    this.leads = [];
  }

  async logLead(record) {
    this.leads.push(record);
    return record;
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function testFollowUpDoesNotOverwriteInboundAdvance() {
  const store = new MemorySessionStore();
  const logger = new CapturingLogger();
  let clock = Date.now();
  const releaseSend = deferred();
  let sendStarted = deferred();
  let blocking = false;

  const engine = new FsmEngine({
    sessionStore: store,
    leadLogger: logger,
    sendMessage: async () => {
      if (blocking) {
        sendStarted.resolve();
        await releaseSend.promise;
      }
      return { ok: true };
    },
    notifyAgent: async () => ({ delivered: false, reason: 'test' }),
    options: {
      stubMarker: true,
      nowFn: () => clock,
    },
  });

  const wa = '27829990001';
  const fuCfg = {
    enabled: true,
    firstDelayMs: THIRTY_MIN,
    intervalMs: 4 * 60 * 60 * 1000,
    maxCount: 3,
    includePrompt: true,
    notifyAgentOnExhausted: false,
  };

  await engine.handleInbound(wa, 'hi'); // GREETING
  await engine.handleInbound(wa, '3'); // LICENSE_CHECK
  clock += THIRTY_MIN;

  blocking = true;
  sendStarted = deferred();
  const followUpPromise = engine.processFollowUp(wa, clock, fuCfg);
  await sendStarted.promise;

  // Customer answers while follow-up Graph call is in flight
  const inboundPromise = engine.handleInbound(wa, 'yes'); // → INCOME_CHECK
  // Give inbound a turn to queue behind the session lock
  await new Promise((r) => setImmediate(r));

  releaseSend.resolve();
  await followUpPromise;
  await inboundPromise;

  const session = await store.get(wa);
  assert.strictEqual(
    session.currentState,
    'INCOME_CHECK',
    'inbound answer must not be rolled back by a late follow-up write'
  );
  assert.ok(
    session.path.includes('INCOME_CHECK'),
    'path must retain the advanced state'
  );
  assert.strictEqual(
    session.followUpCount,
    0,
    'advancing state must re-arm follow-ups (count reset)'
  );

  // eslint-disable-next-line no-console
  console.log('✓ follow-up does not overwrite concurrent inbound advance');
}

async function testFollowUpDoesNotUndoOptOut() {
  const store = new MemorySessionStore();
  const logger = new CapturingLogger();
  let clock = Date.now();
  const releaseSend = deferred();
  let sendStarted = deferred();
  let blocking = false;

  const engine = new FsmEngine({
    sessionStore: store,
    leadLogger: logger,
    sendMessage: async () => {
      if (blocking) {
        sendStarted.resolve();
        await releaseSend.promise;
      }
      return { ok: true };
    },
    notifyAgent: async () => ({ delivered: false, reason: 'test' }),
    options: {
      stubMarker: true,
      nowFn: () => clock,
    },
  });

  const wa = '27829990002';
  const fuCfg = {
    enabled: true,
    firstDelayMs: THIRTY_MIN,
    intervalMs: 4 * 60 * 60 * 1000,
    maxCount: 3,
    includePrompt: true,
    notifyAgentOnExhausted: false,
  };

  await engine.handleInbound(wa, 'hi');
  await engine.handleInbound(wa, '3');
  clock += THIRTY_MIN;

  blocking = true;
  sendStarted = deferred();
  const followUpPromise = engine.processFollowUp(wa, clock, fuCfg);
  await sendStarted.promise;

  const inboundPromise = engine.handleInbound(wa, 'stop');
  await new Promise((r) => setImmediate(r));

  releaseSend.resolve();
  await followUpPromise;
  await inboundPromise;

  const session = await store.get(wa);
  assert.strictEqual(session.status, 'quiet');
  assert.strictEqual(session.currentState, 'HUMAN_HANDOVER');
  assert.strictEqual(logger.leads[0].exitReason, 'human_requested');

  // eslint-disable-next-line no-console
  console.log('✓ follow-up does not undo concurrent opt-out / help');
}

async function main() {
  await testFollowUpDoesNotOverwriteInboundAdvance();
  await testFollowUpDoesNotUndoOptOut();
  // eslint-disable-next-line no-console
  console.log('\nAll follow-up / inbound race tests passed.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('\nTest failed:', err);
  process.exit(1);
});
