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
const {
  createAgentRouter,
  normalizeWaNumber,
} = require('../src/agent/routes');
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

function testNormalizeWaNumber() {
  assert.strictEqual(normalizeWaNumber('+27 67 731 7705'), '27677317705');
  assert.strictEqual(normalizeWaNumber('0677317705'), '27677317705');
  assert.strictEqual(normalizeWaNumber('0027677317705'), '27677317705');
  assert.strictEqual(normalizeWaNumber('27677317705'), '27677317705');
  // eslint-disable-next-line no-console
  console.log('✓ normalizeWaNumber handles E.164 and SA local');
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
  const auth = { Authorization: 'Bearer desk-secret', 'Content-Type': 'application/json' };
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
        headers: auth,
        body: JSON.stringify({ text: 'Hi from desk' }),
      }
    );
    assert.strictEqual(reply.status, 200);
    const session = await sessionStore.get('27821234567');
    assert.strictEqual(session.status, 'quiet');
    assert.strictEqual(session.agentTakenOver, true);
    assert.ok(outbound.some((o) => o.payload.text === 'Hi from desk'));

    // Open new chat by phone (no message yet) — WhatsApp-style +
    const openOnly = await fetch(`http://127.0.0.1:${port}/agent/api/chats`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ waNumber: '+27677317705' }),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
    assert.strictEqual(openOnly.status, 200);
    assert.strictEqual(openOnly.body.waNumber, '27677317705');
    assert.strictEqual(openOnly.body.message, null);
    const openedSession = await sessionStore.get('27677317705');
    assert.strictEqual(openedSession.agentTakenOver, true);

    // Cold-outreach with template from new-chat endpoint
    const cold = await fetch(`http://127.0.0.1:${port}/agent/api/chats`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        waNumber: '0821234568',
        templateName: 'hello_world',
        templateLanguage: 'en_US',
      }),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
    assert.strictEqual(cold.status, 200);
    assert.strictEqual(cold.body.waNumber, '27821234568');
    assert.ok(
      outbound.some(
        (o) =>
          o.to === '27821234568' &&
          o.payload.templateName === 'hello_world' &&
          o.payload.templateLanguage === 'en_US'
      )
    );
    assert.strictEqual(cold.body.message.text, '[template: hello_world]');

    // Reply path also accepts templates
    const templateReply = await fetch(
      `http://127.0.0.1:${port}/agent/api/chats/27821234567/reply`,
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ templateName: 'hello_world' }),
      }
    );
    assert.strictEqual(templateReply.status, 200);

    await fetch(`http://127.0.0.1:${port}/agent/api/chats/27821234567/release`, {
      method: 'POST',
      headers: auth,
      body: '{}',
    });
    const after = await sessionStore.get('27821234567');
    assert.strictEqual(after.agentTakenOver, false);
    assert.strictEqual(after.currentState, 'GREETING');

    // eslint-disable-next-line no-console
    console.log('✓ agent desk auth, new chat, reply, template, takeover, release');
  } finally {
    server.close();
  }
}

async function main() {
  testNormalizeWaNumber();
  await testMessageStoreAndApis();
  // eslint-disable-next-line no-console
  console.log('\nagent desk tests passed.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
