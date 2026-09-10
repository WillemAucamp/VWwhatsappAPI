'use strict';

/**
 * Regression: session TTL must not delete a quiet session that staff still
 * holds via agentTakenOver. Desk Take over / reply auto-takeOver leave no
 * pendingLead / pendingTerminalOutbound, and inbound while held returns
 * without rewriting the session — so updatedAt freezes at takeover.
 *
 * Without pinning agentTakenOver, FileSessionStore get()/listAll() (and Redis
 * EX) delete the hold after SESSION_TTL_MS. The next customer message then
 * starts a fresh GREETING and wipes funnel progress — breaking "hold until
 * Release to bot".
 *
 * Run: node tests/agent-takeover-ttl.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../src/config');
const {
  FileSessionStore,
  createEmptySession,
  isSessionExpired,
} = require('../src/session/store');
const { FsmEngine } = require('../src/engine/fsmEngine');

async function testIsSessionExpiredSkipsAgentTakenOver() {
  const idle = {
    waNumber: '1',
    updatedAt: Date.now() - config.session.ttlMs - 1000,
    agentTakenOver: false,
    pendingLead: null,
    pendingTerminalOutbound: null,
  };
  assert.strictEqual(isSessionExpired(idle), true);

  const held = {
    waNumber: '1',
    updatedAt: Date.now() - config.session.ttlMs - 1000,
    status: 'quiet',
    agentTakenOver: true,
    pendingLead: null,
    pendingTerminalOutbound: null,
  };
  assert.strictEqual(
    isSessionExpired(held),
    false,
    'agentTakenOver must pin the session past TTL'
  );

  // eslint-disable-next-line no-console
  console.log('✓ isSessionExpired preserves sessions with agentTakenOver');
}

async function testFileStoreDoesNotPurgeHeldTakeover() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-hold-ttl-'));
  const store = new FileSessionStore(dir);
  const past = Date.now() - config.session.ttlMs - 60_000;
  const session = createEmptySession('27820001111');
  session.status = 'quiet';
  session.agentTakenOver = true;
  session.currentState = 'EMPLOYED_INCOME_CHECK';
  session.interruptedFrom = 'EMPLOYED_INCOME_CHECK';
  session.path = ['GREETING', 'EMPLOYED_INCOME_CHECK'];

  await store.set(session.waNumber, session);
  const file = path.join(dir, '27820001111.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.updatedAt = past;
  fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);

  const got = await store.get(session.waNumber);
  assert.ok(got, 'get must not TTL-delete agentTakenOver session');
  assert.strictEqual(got.agentTakenOver, true);
  assert.strictEqual(got.currentState, 'EMPLOYED_INCOME_CHECK');

  const listed = await store.listAll();
  assert.strictEqual(listed.length, 1);
  assert.strictEqual(listed[0].agentTakenOver, true);

  // eslint-disable-next-line no-console
  console.log('✓ FileSessionStore listAll/get keep past-TTL agentTakenOver');
}

async function testInboundStaysHeldAfterTtl() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-hold-inbound-'));
  const store = new FileSessionStore(dir);
  const past = Date.now() - config.session.ttlMs - 60_000;
  const wa = '27820001112';
  const session = createEmptySession(wa);
  session.status = 'quiet';
  session.agentTakenOver = true;
  session.currentState = 'EMPLOYED_INCOME_CHECK';
  session.interruptedFrom = 'EMPLOYED_INCOME_CHECK';
  session.path = ['GREETING', 'EMPLOYED_INCOME_CHECK'];

  await store.set(wa, session);
  const file = path.join(dir, `${wa}.json`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.updatedAt = past;
  fs.writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);

  const outbound = [];
  const engine = new FsmEngine({
    sessionStore: store,
    leadLogger: { logLead: async () => {} },
    sendMessage: async (_to, payload) => {
      outbound.push(payload);
      return { messages: [{ id: 'wamid.test' }] };
    },
  });

  const result = await engine.handleInbound(wa, 'hello still waiting');
  assert.strictEqual(result.agentHeld, true);
  assert.strictEqual(outbound.length, 0, 'bot must stay silent while held');

  const after = await store.get(wa);
  assert.ok(after, 'held session must survive get after inbound');
  assert.strictEqual(after.agentTakenOver, true);
  assert.strictEqual(after.status, 'quiet');
  assert.strictEqual(after.currentState, 'EMPLOYED_INCOME_CHECK');
  assert.strictEqual(after.interruptedFrom, 'EMPLOYED_INCOME_CHECK');

  // eslint-disable-next-line no-console
  console.log('✓ inbound after TTL still holds takeover (no GREETING restart)');
}

async function main() {
  // eslint-disable-next-line no-console
  console.log('Running agentTakenOver TTL regression tests…\n');
  await testIsSessionExpiredSkipsAgentTakenOver();
  await testFileStoreDoesNotPurgeHeldTakeover();
  await testInboundStaysHeldAfterTtl();
  // eslint-disable-next-line no-console
  console.log('\nAll agentTakenOver TTL regression tests passed.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
