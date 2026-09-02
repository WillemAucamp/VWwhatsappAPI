'use strict';

/**
 * Regression: CRM (logLead) failure must not block pendingTerminalOutbound retry.
 *
 * Trigger: FINAL_CONSENT → SEND_LINK where Graph send fails AND CRM fails.
 * Session is soft_closed with both pendingLead and pendingTerminalOutbound.
 * Graph recovers; CRM stays down. Old scheduler tick shared one try/catch so
 * flushPendingLead throw skipped terminal retry — customer never got the
 * application link while WhatsApp was healthy. Same ordering on inbound.
 *
 * Run: node tests/crm-down-terminal-retry.test.js
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

function followUpConfig() {
  return {
    enabled: true,
    firstDelayMs: 30 * 60 * 1000,
    intervalMs: 4 * 60 * 60 * 1000,
    maxCount: 3,
    pollMs: 60_000,
    includePrompt: true,
    notifyAgentOnExhausted: false,
  };
}

async function seedSoftClosedWithBothPending() {
  const store = new MemorySessionStore();
  const logger = new CapturingLogger();
  const sent = [];
  let failSendLink = false;
  let clock = 1_000_000;

  const engine = new FsmEngine({
    sessionStore: store,
    leadLogger: logger,
    sendMessage: async (to, payload) => {
      const stateId = payload && payload.meta && payload.meta.stateId;
      if (failSendLink && stateId === 'SEND_LINK') {
        throw new Error('simulated Graph API failure');
      }
      sent.push({ to, ...payload });
      return { ok: true };
    },
    notifyAgent: async () => ({ delivered: true }),
    options: { nowFn: () => clock },
  });

  const wa = '27821110001';
  await driveToFinalConsent(engine, wa);

  logger.fail = true;
  failSendLink = true;

  let threw = false;
  try {
    await engine.handleInbound(wa, 'yes');
  } catch (err) {
    threw = true;
    assert.match(String(err.message), /Graph API failure/);
  }
  assert.ok(threw, 'SEND_LINK Graph failure should surface');

  const session = await store.get(wa);
  assert.strictEqual(session.status, 'soft_closed');
  assert.ok(session.pendingLead, 'pendingLead queued');
  assert.ok(session.pendingTerminalOutbound, 'pendingTerminalOutbound queued');
  assert.strictEqual(logger.leads.length, 0);

  return {
    store,
    logger,
    engine,
    sent,
    wa,
    setFailSendLink: (v) => {
      failSendLink = v;
    },
  };
}

async function testSchedulerRetriesTerminalWhileCrmDown() {
  const { store, logger, engine, sent, wa, setFailSendLink } =
    await seedSoftClosedWithBothPending();
  logger.fail = true;
  setFailSendLink(false);

  const scheduler = new FollowUpScheduler({
    engine,
    sessionStore: store,
    followUpConfig: followUpConfig(),
  });

  const result = await scheduler.tick(1_000_000);
  assert.ok(
    result.errors.some((e) => /CRM failure/.test(e.message)),
    'CRM flush error should be recorded'
  );
  assert.strictEqual(
    result.resentTerminal,
    1,
    'terminal outbound must retry despite CRM still down'
  );
  assert.ok(
    sent.some((m) => m.meta && m.meta.stateId === 'SEND_LINK'),
    'application-link SEND_LINK body must be delivered'
  );

  const session = await store.get(wa);
  assert.ok(session.pendingLead, 'pendingLead remains until CRM recovers');
  assert.strictEqual(
    session.pendingTerminalOutbound,
    null,
    'pendingTerminalOutbound cleared after successful Graph retry'
  );
  assert.strictEqual(logger.leads.length, 0);

  // eslint-disable-next-line no-console
  console.log('✓ scheduler retries terminal WhatsApp while CRM flush fails');
}

async function testInboundRetriesTerminalWhileCrmDown() {
  const { store, logger, engine, sent, wa, setFailSendLink } =
    await seedSoftClosedWithBothPending();
  logger.fail = true;
  setFailSendLink(false);
  sent.length = 0;

  const result = await engine.handleInbound(wa, 'bump');
  assert.ok(result.resentTerminal, 'inbound must retry terminal despite CRM down');
  assert.ok(
    sent.some((m) => m.meta && m.meta.stateId === 'SEND_LINK'),
    'SEND_LINK delivered on inbound while CRM down'
  );

  const session = await store.get(wa);
  assert.ok(session.pendingLead, 'must not _restart and wipe pendingLead');
  assert.strictEqual(session.status, 'soft_closed');
  assert.strictEqual(session.pendingTerminalOutbound, null);
  assert.strictEqual(logger.leads.length, 0);

  // eslint-disable-next-line no-console
  console.log('✓ inbound retries terminal WhatsApp while CRM flush fails');
}

async function main() {
  // eslint-disable-next-line no-console
  console.log('Running CRM-down terminal retry tests…\n');
  await testSchedulerRetriesTerminalWhileCrmDown();
  await testInboundRetriesTerminalWhileCrmDown();
  // eslint-disable-next-line no-console
  console.log('\nAll CRM-down terminal retry tests passed.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
