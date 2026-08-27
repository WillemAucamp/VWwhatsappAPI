'use strict';

/**
 * Regression: failed agent handover webhooks must be retried by the scheduler
 * (and must survive session TTL), not only when the customer messages again.
 *
 * Trigger: HUMAN_HANDOVER / AGENT_SOFT_HANDOVER notifyAgent returns
 * { delivered: false } (HTTP/network failure) without throwing. The customer
 * is quiet / soft_closed and often never inbounds. Old behavior ignored the
 * return value, so staff never learned the customer asked for a human.
 *
 * Run: node tests/scheduler-agent-notify-retry.test.js
 */

const assert = require('assert');
const {
  MemorySessionStore,
  isSessionExpired,
} = require('../src/session/store');
const { FsmEngine } = require('../src/engine/fsmEngine');
const { FollowUpScheduler } = require('../src/followup/scheduler');

class CapturingLogger {
  constructor() {
    this.leads = [];
  }

  async logLead(record) {
    this.leads.push(record);
    return record;
  }
}

async function testSchedulerRetriesFailedHumanHandoverNotify() {
  const store = new MemorySessionStore();
  const logger = new CapturingLogger();
  const agentEvents = [];
  let deliverAgent = false;
  let clock = 1_000_000;

  const engine = new FsmEngine({
    sessionStore: store,
    leadLogger: logger,
    sendMessage: async () => ({ ok: true }),
    notifyAgent: async (event) => {
      agentEvents.push(event);
      if (!deliverAgent) {
        return { delivered: false, reason: 'webhook_500' };
      }
      return { delivered: true, status: 200 };
    },
    options: {
      stubMarker: true,
      nowFn: () => clock,
    },
  });

  const wa = '27828880001';
  await engine.handleInbound(wa, 'hi');
  await engine.handleInbound(wa, '3');
  await engine.handleInbound(wa, 'stop');

  let session = await store.get(wa);
  assert.strictEqual(session.status, 'quiet');
  assert.strictEqual(session.currentState, 'HUMAN_HANDOVER');
  assert.ok(
    session.pendingAgentNotify,
    'failed handover notify must queue pendingAgentNotify'
  );
  assert.strictEqual(session.pendingAgentNotify.type, 'handover');
  assert.strictEqual(session.pendingAgentNotify.exitReason, 'human_requested');
  assert.strictEqual(agentEvents.length, 1);
  assert.strictEqual(logger.leads.length, 1);

  const scheduler = new FollowUpScheduler({
    engine,
    sessionStore: store,
    followUpConfig: {
      enabled: true,
      firstDelayMs: 30 * 60 * 1000,
      intervalMs: 4 * 60 * 60 * 1000,
      maxCount: 3,
      pollMs: 60_000,
      includePrompt: true,
      notifyAgentOnExhausted: false,
    },
    nowFn: () => clock,
  });

  // Webhook still down — tick must keep the queue and not claim success.
  let result = await scheduler.tick(clock);
  assert.strictEqual(result.notifiedAgent, 0);
  session = await store.get(wa);
  assert.ok(session.pendingAgentNotify);
  assert.strictEqual(agentEvents.length, 2);

  // Webhook recovers — no inbound required.
  deliverAgent = true;
  result = await scheduler.tick(clock);
  assert.strictEqual(result.notifiedAgent, 1);
  session = await store.get(wa);
  assert.strictEqual(session.pendingAgentNotify, null);
  assert.strictEqual(agentEvents.length, 3);
  assert.strictEqual(agentEvents[2].exitReason, 'human_requested');

  // eslint-disable-next-line no-console
  console.log('✓ scheduler retries failed HUMAN_HANDOVER agent notify');
}

async function testNoWebhookDoesNotQueueForever() {
  const store = new MemorySessionStore();
  const logger = new CapturingLogger();

  const engine = new FsmEngine({
    sessionStore: store,
    leadLogger: logger,
    sendMessage: async () => ({ ok: true }),
    notifyAgent: async () => ({ delivered: false, reason: 'no_webhook' }),
    options: { stubMarker: true },
  });

  const wa = '27828880002';
  await engine.handleInbound(wa, 'hi');
  await engine.handleInbound(wa, '3');
  await engine.handleInbound(wa, 'stop');

  const session = await store.get(wa);
  assert.strictEqual(session.status, 'quiet');
  assert.strictEqual(
    session.pendingAgentNotify,
    null,
    'missing AGENT_NOTIFY_WEBHOOK_URL must not queue forever'
  );

  // eslint-disable-next-line no-console
  console.log('✓ no_webhook does not queue pendingAgentNotify');
}

async function testPendingAgentNotifyExemptFromTtl() {
  const stale = {
    waNumber: '1',
    updatedAt: Date.now() - 24 * 60 * 60 * 1000 - 1000,
    pendingLead: null,
    pendingTerminalOutbound: null,
    pendingAgentNotify: null,
  };
  assert.strictEqual(isSessionExpired(stale), true);

  const waitingNotify = {
    waNumber: '1',
    updatedAt: Date.now() - 24 * 60 * 60 * 1000 - 1000,
    pendingLead: null,
    pendingTerminalOutbound: null,
    pendingAgentNotify: {
      type: 'handover',
      exitReason: 'human_requested',
      waNumber: '1',
    },
  };
  assert.strictEqual(
    isSessionExpired(waitingNotify),
    false,
    'pendingAgentNotify must pin the session past TTL'
  );

  const store = new MemorySessionStore();
  const logger = new CapturingLogger();
  const engine = new FsmEngine({
    sessionStore: store,
    leadLogger: logger,
    sendMessage: async () => ({ ok: true }),
    notifyAgent: async () => ({ delivered: false, reason: 'webhook_down' }),
    options: { stubMarker: true },
  });

  const wa = '27828880003';
  await engine.handleInbound(wa, 'hi');
  await engine.handleInbound(wa, '3');
  await engine.handleInbound(wa, 'stop');

  const session = await store.get(wa);
  assert.ok(session.pendingAgentNotify);
  // Simulate clock skew past TTL on the stored copy.
  const stored = store.map.get(wa);
  stored.updatedAt = Date.now() - 24 * 60 * 60 * 1000 - 60_000;
  const listed = await store.listAll();
  assert.strictEqual(
    listed.length,
    1,
    'listAll must keep pendingAgentNotify session past TTL'
  );
  const got = await store.get(wa);
  assert.ok(got && got.pendingAgentNotify, 'get must not purge pendingAgentNotify');

  // eslint-disable-next-line no-console
  console.log('✓ pendingAgentNotify exempts session from TTL purge');
}

async function testSoftHandoverNotifyQueuedAndFlushed() {
  const store = new MemorySessionStore();
  const logger = new CapturingLogger();
  const agentEvents = [];
  let deliverAgent = false;
  let clock = 2_000_000;

  const engine = new FsmEngine({
    sessionStore: store,
    leadLogger: logger,
    sendMessage: async () => ({ ok: true }),
    notifyAgent: async (event) => {
      agentEvents.push(event);
      if (!deliverAgent) return { delivered: false, status: 503 };
      return { delivered: true, status: 200 };
    },
    options: {
      stubMarker: true,
      nowFn: () => clock,
    },
  });

  const wa = '27828880004';
  await engine.handleInbound(wa, 'hi');
  await engine.handleInbound(wa, '3'); // qualify path
  await engine.handleInbound(wa, 'yes');
  await engine.handleInbound(wa, '2');
  await engine.handleInbound(wa, 'great');
  await engine.handleInbound(wa, 'no'); // AGENT_SOFT_HANDOVER

  let session = await store.get(wa);
  assert.strictEqual(session.status, 'soft_closed');
  assert.strictEqual(session.currentState, 'AGENT_SOFT_HANDOVER');
  assert.ok(session.pendingAgentNotify);
  assert.strictEqual(
    session.pendingAgentNotify.exitReason,
    'declined_self_serve'
  );

  deliverAgent = true;
  const scheduler = new FollowUpScheduler({
    engine,
    sessionStore: store,
    followUpConfig: {
      enabled: true,
      firstDelayMs: 30 * 60 * 1000,
      intervalMs: 4 * 60 * 60 * 1000,
      maxCount: 3,
      pollMs: 60_000,
      includePrompt: true,
      notifyAgentOnExhausted: false,
    },
    nowFn: () => clock,
  });

  const result = await scheduler.tick(clock);
  assert.strictEqual(result.notifiedAgent, 1);
  session = await store.get(wa);
  assert.strictEqual(session.pendingAgentNotify, null);

  // eslint-disable-next-line no-console
  console.log('✓ scheduler flushes failed AGENT_SOFT_HANDOVER notify');
}

async function main() {
  // eslint-disable-next-line no-console
  console.log('Running agent-notify retry regression tests…\n');
  await testSchedulerRetriesFailedHumanHandoverNotify();
  await testNoWebhookDoesNotQueueForever();
  await testPendingAgentNotifyExemptFromTtl();
  await testSoftHandoverNotifyQueuedAndFlushed();
  // eslint-disable-next-line no-console
  console.log('\nAll agent-notify retry regression tests passed.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('\nTest failed:', err);
  process.exit(1);
});
