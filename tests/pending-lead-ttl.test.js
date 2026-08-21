'use strict';

/**
 * Regression: session TTL must not delete a soft_closed session that still
 * holds pendingLead. Otherwise listAll()/get() (follow-up scheduler ticks)
 * permanently drop a qualification lead after logLead failed and the customer
 * does not return within SESSION_TTL_MS.
 *
 * Also: scheduler tick should flush pendingLead when CRM is healthy again.
 *
 * Run: node tests/pending-lead-ttl.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../src/config');
const {
  FileSessionStore,
  MemorySessionStore,
  isSessionExpired,
} = require('../src/session/store');
const { FsmEngine } = require('../src/engine/fsmEngine');
const { FollowUpScheduler } = require('../src/followup/scheduler');

class FlakyLeadLogger {
  constructor() {
    this.leads = [];
    this.failNext = false;
  }

  async logLead(record) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('simulated lead log failure');
    }
    this.leads.push(record);
    return record;
  }
}

async function driveToConfirmQualify(engine, wa) {
  await engine.handleInbound(wa, 'hi');
  await engine.handleInbound(wa, '3');
  await engine.handleInbound(wa, 'yes');
  await engine.handleInbound(wa, '2');
  await engine.handleInbound(wa, 'great');
  const session = await engine.sessionStore.get(wa);
  assert.strictEqual(session.currentState, 'CONFIRM_QUALIFY');
}

async function testIsSessionExpiredSkipsPendingLead() {
  const fresh = {
    waNumber: '1',
    updatedAt: Date.now() - config.session.ttlMs - 1000,
    pendingLead: null,
  };
  assert.strictEqual(isSessionExpired(fresh), true);

  const queued = {
    waNumber: '1',
    updatedAt: Date.now() - config.session.ttlMs - 1000,
    pendingLead: {
      waNumber: '1',
      exitReason: 'qualified_self_serve',
      path: ['GREETING'],
      timestamp: new Date().toISOString(),
    },
  };
  assert.strictEqual(
    isSessionExpired(queued),
    false,
    'pendingLead must pin the session past TTL'
  );

  // eslint-disable-next-line no-console
  console.log('✓ isSessionExpired preserves sessions with pendingLead');
}

async function testFileStoreListAllDoesNotPurgePendingLead() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-pending-ttl-'));
  const store = new FileSessionStore(dir);
  const wa = '27825550001';
  const past = Date.now() - config.session.ttlMs - 60_000;

  await store.set(wa, {
    waNumber: wa,
    currentState: 'QUALIFIED_LINK',
    path: ['GREETING', 'QUALIFIED_LINK'],
    invalidAttempts: 0,
    status: 'soft_closed',
    interruptedFrom: null,
    createdAt: past,
    updatedAt: past,
    lastExitReason: 'qualified_self_serve',
    pendingLead: {
      waNumber: wa,
      exitReason: 'qualified_self_serve',
      path: ['GREETING', 'QUALIFIED_LINK'],
      timestamp: new Date(past).toISOString(),
      meta: {},
    },
    lastBotMessageAt: null,
    lastFollowUpAt: null,
    followUpCount: 0,
    followUpsExhausted: false,
  });

  // Force updatedAt back past TTL (set() refreshes it).
  const file = path.join(dir, `${wa}.json`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.updatedAt = past;
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));

  const listed = await store.listAll();
  assert.strictEqual(listed.length, 1, 'listAll must keep pendingLead session');
  assert.ok(listed[0].pendingLead);

  const got = await store.get(wa);
  assert.ok(got, 'get must not TTL-delete pendingLead session');
  assert.ok(got.pendingLead);

  fs.rmSync(dir, { recursive: true, force: true });

  // eslint-disable-next-line no-console
  console.log('✓ FileSessionStore listAll/get keep past-TTL pendingLead');
}

async function testSchedulerFlushesPendingLeadWithoutInbound() {
  const store = new MemorySessionStore();
  const logger = new FlakyLeadLogger();
  const engine = new FsmEngine({
    sessionStore: store,
    leadLogger: logger,
    sendMessage: async () => ({ ok: true }),
    notifyAgent: async () => ({ delivered: false }),
    options: { stubMarker: true },
  });

  const wa = '27825550002';
  await driveToConfirmQualify(engine, wa);

  logger.failNext = true;
  await engine.handleInbound(wa, 'yes');

  let session = await store.get(wa);
  assert.strictEqual(session.status, 'soft_closed');
  assert.ok(session.pendingLead);
  assert.strictEqual(logger.leads.length, 0);

  // Age the session past TTL while pendingLead remains.
  session.updatedAt = Date.now() - config.session.ttlMs - 60_000;
  store.map.set(wa, { ...session, path: [...session.path], pendingLead: { ...session.pendingLead } });

  const scheduler = new FollowUpScheduler({
    engine,
    sessionStore: store,
    followUpConfig: { ...config.followUp, enabled: true },
  });

  const result = await scheduler.tick();
  assert.strictEqual(result.flushed, 1, 'tick must flush queued pendingLead');
  assert.strictEqual(logger.leads.length, 1);
  assert.strictEqual(logger.leads[0].exitReason, 'qualified_self_serve');

  session = await store.get(wa);
  assert.strictEqual(session.pendingLead, null);
  assert.strictEqual(session.status, 'soft_closed');

  // eslint-disable-next-line no-console
  console.log('✓ scheduler tick flushes pendingLead without customer inbound');
}

async function main() {
  // eslint-disable-next-line no-console
  console.log('Running pendingLead TTL / scheduler flush regression tests…\n');
  await testIsSessionExpiredSkipsPendingLead();
  await testFileStoreListAllDoesNotPurgePendingLead();
  await testSchedulerFlushesPendingLeadWithoutInbound();
  // eslint-disable-next-line no-console
  console.log('\nAll pendingLead TTL regression tests passed.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('\nTest failed:', err);
  process.exit(1);
});
