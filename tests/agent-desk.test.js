'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

// Ensure desk password before config is first required by app modules in this process.
process.env.AGENT_DESK_ENABLED = 'true';
process.env.AGENT_DESK_PASSWORD = 'desk-secret';

const config = require('../src/config');
config.agent.deskEnabled = true;
config.agent.deskPassword = 'desk-secret';

const { createMessageStore } = require('../src/agent/messageStore');
const { createAgentRouter } = require('../src/agent/routes');
const { MemorySessionStore } = require('../src/session/store');
const { FsmEngine } = require('../src/engine/fsmEngine');

class CapturingLogger {
  async logLead() { return {}; }
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

async function testMessageStoreAndApis() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tx-'));
  const messageStore = createMessageStore(dir);
  const sessionStore = new MemorySessionStore();
  const outbound = [];

  const engine = new FsmEngine({
    sessionStore,
    leadLogger: new CapturingLogger(),
    sendMessage: async (to, payload) => {
      outbound.push({ to, payload });
      return { messages: [{ id: 'wamid.out' }] };
    },
    notifyAgent: async () => ({ delivered: false }),
  });

  await messageStore.append({
    waNumber: '27821234567',
    direction: 'in',
    source: 'customer',
    text: 'hello',
  });

  const app = express();
  app.use(express.json());
  app.use(
    '/agent',
    createAgentRouter({
      engine,
      sessionStore,
      messageStore,
      sendMessage: async (to, payload) => {
        outbound.push({ to, payload });
        return { messages: [{ id: 'wamid.agent' }] };
      },
    })
  );

  const { server, port } = await listen(app);
  try {
    const unauthorized = await fetch(`http://127.0.0.1:${port}/agent/api/chats`);
    assert.strictEqual(unauthorized.status, 401);

    const login = await fetch(`http://127.0.0.1:${port}/agent/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'desk-secret' }),
    });
    assert.strictEqual(login.status, 200);

    const chats = await fetch(`http://127.0.0.1:${port}/agent/api/chats`, {
      headers: { Authorization: 'Bearer desk-secret' },
    }).then((r) => r.json());
    assert.strictEqual(chats.chats.length, 1);
    assert.strictEqual(chats.chats[0].waNumber, '27821234567');

    const reply = await fetch(
      `http://127.0.0.1:${port}/agent/api/chats/27821234567/reply`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer desk-secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: 'Hi from desk' }),
      }
    );
    assert.strictEqual(reply.status, 200);
    const session = await sessionStore.get('27821234567');
    assert.strictEqual(session.status, 'quiet');
    assert.strictEqual(session.agentTakenOver, true);
    assert.ok(outbound.some((o) => o.payload.text === 'Hi from desk'));

    await fetch(`http://127.0.0.1:${port}/agent/api/chats/27821234567/release`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer desk-secret',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    const after = await sessionStore.get('27821234567');
    assert.strictEqual(after.agentTakenOver, false);
    assert.strictEqual(after.currentState, 'GREETING');

    // eslint-disable-next-line no-console
    console.log('✓ agent desk auth, reply takeover, and release');
  } finally {
    server.close();
  }
}

async function testAgentTakeoverHoldsUntilRelease() {
  const sessionStore = new MemorySessionStore();
  const outbound = [];

  const engine = new FsmEngine({
    sessionStore,
    leadLogger: new CapturingLogger(),
    sendMessage: async (to, payload) => {
      outbound.push({ to, payload });
      return { messages: [{ id: `wamid.${outbound.length}` }] };
    },
    notifyAgent: async () => ({ delivered: false }),
  });

  // Start a normal funnel, then staff takes over and replies "Hello".
  await engine.handleInbound('27829990001', 'hi');
  await engine.takeOver('27829990001');
  const held = await sessionStore.get('27829990001');
  assert.strictEqual(held.status, 'quiet');
  assert.strictEqual(held.agentTakenOver, true);

  const beforeCount = outbound.length;

  // Customer (or mirrored) reopen keywords must NOT restart during takeover.
  for (const text of ['Hello', 'hi', 'restart', 'start', 'anything else']) {
    // eslint-disable-next-line no-await-in-loop
    const result = await engine.handleInbound('27829990001', text);
    assert.strictEqual(result.agentTakenOver, true);
    assert.strictEqual(result.quiet, true);
    // eslint-disable-next-line no-await-in-loop
    const session = await sessionStore.get('27829990001');
    assert.strictEqual(session.agentTakenOver, true);
    assert.strictEqual(session.status, 'quiet');
  }

  // Bot must stay silent — no restart notice, no quiet_thread_notice, no menu.
  const afterInbound = outbound.slice(beforeCount);
  assert.strictEqual(
    afterInbound.length,
    0,
    `expected no bot outbound during agent takeover, got ${JSON.stringify(afterInbound)}`
  );

  // Only Release to bot hands control back and restarts greeting.
  await engine.releaseToBot('27829990001');
  const released = await sessionStore.get('27829990001');
  assert.strictEqual(released.agentTakenOver, false);
  assert.strictEqual(released.status, 'active');
  assert.strictEqual(released.currentState, 'GREETING');
  assert.ok(
    outbound.some(
      (o) =>
        o.payload &&
        o.payload.meta &&
        o.payload.meta.promptKey === 'session_restart_notice'
    ),
    'release should send session_restart_notice'
  );

  // eslint-disable-next-line no-console
  console.log('✓ agent takeover holds until explicit release');
}

async function main() {
  await testMessageStoreAndApis();
  await testAgentTakeoverHoldsUntilRelease();
  // eslint-disable-next-line no-console
  console.log('\nagent desk tests passed.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
