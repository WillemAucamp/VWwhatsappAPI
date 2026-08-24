'use strict';

/**
 * Regression: session TTL must not delete a soft_closed/quiet session that
 * still holds pendingTerminalOutbound after the lead was flushed.
 *
 * Trigger: QUALIFIED_LINK Graph send fails → soft_closed + pendingTerminalOutbound
 * + pendingLead. Scheduler (or inbound) flushes the lead, clearing pendingLead
 * and refreshing updatedAt. Customer does not return within SESSION_TTL_MS
 * (or keeps retrying while Graph is down — failed retries do not persist a
 * touched updatedAt). Old isSessionExpired only pinned pendingLead, so
 * get()/listAll() purged the session and the next inbound started GREETING
 * instead of re-sending the application link.
 *
 * Run: node tests/pending-terminal-outbound-ttl.test.js
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
  await engine.handleInbound(wa, 'hi');
  await engine.handleInbound(wa, '3');
  await engine.handleInbound(wa, 'yes');
  await engine.handleInbound(wa, '2');
  await engine.handleInbound(wa, 'great');
  const session = await engine.sessionStore.get(wa);
  assert.strictEqual(session.currentState, 'CONFIRM_QUALIFY');
}

async function testIsSessionExpiredSkipsPendingTerminalOutbound() {
  const stale = {
    waNumber: '1',
    updatedAt: Date.now() - config.session.ttlMs - 1000,
    pendingLead: null,
    pendingTerminalOutbound: null,
  };
  assert.strictEqual(isSessionExpired(stale), true);

  const waitingRetry = {
    waNumber: '1',
    updatedAt: Date.now() - config.session.ttlMs - 1000,
    pendingLead: null,
    pendingTerminalOutbound: {
      stateId: 'QUALIFIED_LINK',
      promptKey: 'qualified_link_body',
    },
  };
  assert.strictEqual(
    isSessionExpired(waitingRetry),
    false,
    'pendingTerminalOutbound must pin the session past TTL'
  );

  // eslint-disable-next-line no-console
  console.log('✓ isSessionExpired preserves sessions with pendingTerminalOutbound');
}

async function testFileStoreDoesNotPurgePendingTerminalOutbound() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-pto-ttl-'));
  const store = new FileSessionStore(dir);
  const wa = '27827770001';
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
    pendingLead: null,
    pendingTerminalOutbound: {
      stateId: 'QUALIFIED_LINK',
      promptKey: 'qualified_link_body',
    },
    lastBotMessageAt: null,
    lastFollowUpAt: null,
    followUpCount: 0,
    followUpsExhausted: false,
  });

  const file = path.join(dir, `${wa}.json`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.updatedAt = past;
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));

  const listed = await store.listAll();
  assert.strictEqual(
    listed.length,
    1,
    'listAll must keep pendingTerminalOutbound session'
  );
  assert.ok(listed[0].pendingTerminalOutbound);

  const got = await store.get(wa);
  assert.ok(got, 'get must not TTL-delete pendingTerminalOutbound session');
  assert.ok(got.pendingTerminalOutbound);
  assert.strictEqual(got.currentState, 'QUALIFIED_LINK');

  fs.rmSync(dir, { recursive: true, force: true });

  // eslint-disable-next-line no-console
  console.log('✓ FileSessionStore listAll/get keep past-TTL pendingTerminalOutbound');
}

async function testInboundRetriesAfterTtlOnceLeadFlushed() {
  const store = new MemorySessionStore();
  const logger = new CapturingLogger();
  const sent = [];
  let failSend = false;

  const engine = new FsmEngine({
    sessionStore: store,
    leadLogger: logger,
    sendMessage: async (to, payload) => {
      if (failSend) throw new Error('simulated Graph API failure');
      sent.push({ to, meta: payload && payload.meta });
      return { ok: true };
    },
    notifyAgent: async () => ({ delivered: false }),
    options: { stubMarker: true },
  });

  const wa = '27827770002';
  await driveToConfirmQualify(engine, wa);

  failSend = true;
  await assert.rejects(() => engine.handleInbound(wa, 'yes'));

  let session = await store.get(wa);
  assert.strictEqual(session.status, 'soft_closed');
  assert.ok(session.pendingTerminalOutbound);
  // Lead already logged; pendingLead cleared — this is the TTL hole.
  assert.strictEqual(session.pendingLead, null);
  assert.strictEqual(logger.leads.length, 1);

  // Age past TTL while only pendingTerminalOutbound remains.
  const aged = {
    ...session,
    path: [...session.path],
    pendingTerminalOutbound: { ...session.pendingTerminalOutbound },
    updatedAt: Date.now() - config.session.ttlMs - 60_000,
  };
  store.map.set(wa, aged);

  failSend = false;
  const result = await engine.handleInbound(wa, 'hello');
  assert.strictEqual(
    result.resentTerminal,
    true,
    'past-TTL soft_closed must still retry undelivered terminal outbound'
  );

  session = await store.get(wa);
  assert.strictEqual(session.status, 'soft_closed');
  assert.strictEqual(session.currentState, 'QUALIFIED_LINK');
  assert.strictEqual(session.pendingTerminalOutbound, null);
  assert.ok(
    session.path.includes('CONFIRM_QUALIFY'),
    'completed path must not be wiped by TTL'
  );
  const last = sent[sent.length - 1];
  assert.strictEqual(last.meta && last.meta.stateId, 'QUALIFIED_LINK');

  // eslint-disable-next-line no-console
  console.log('✓ inbound retries QUALIFIED_LINK after TTL with pendingTerminalOutbound');
}

async function main() {
  // eslint-disable-next-line no-console
  console.log('Running pendingTerminalOutbound TTL regression tests…\n');
  await testIsSessionExpiredSkipsPendingTerminalOutbound();
  await testFileStoreDoesNotPurgePendingTerminalOutbound();
  await testInboundRetriesAfterTtlOnceLeadFlushed();
  // eslint-disable-next-line no-console
  console.log('\nAll pendingTerminalOutbound TTL regression tests passed.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('\nTest failed:', err);
  process.exit(1);
});
