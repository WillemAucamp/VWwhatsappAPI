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
const { createShortcutStore } = require('../src/agent/shortcutStore');
const { createLabelStore } = require('../src/agent/labelStore');
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

function authHeaders() {
  return {
    Authorization: 'Bearer desk-secret',
    'Content-Type': 'application/json',
  };
}

async function testMessageStoreAndApis() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tx-'));
  const shortcutsPath = path.join(dir, 'shortcuts.json');
  const labelsPath = path.join(dir, 'labels.json');
  const messageStore = createMessageStore(dir);
  const shortcutStore = createShortcutStore(shortcutsPath);
  const labelStore = createLabelStore(labelsPath);
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
      shortcutStore,
      labelStore,
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
    assert.deepStrictEqual(chats.chats[0].labelIds, []);

    const reply = await fetch(
      `http://127.0.0.1:${port}/agent/api/chats/27821234567/reply`,
      {
        method: 'POST',
        headers: authHeaders(),
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
      headers: authHeaders(),
      body: '{}',
    });
    const after = await sessionStore.get('27821234567');
    assert.strictEqual(after.agentTakenOver, false);
    assert.strictEqual(after.currentState, 'GREETING');

    // Shortcuts
    const shortcuts = await fetch(`http://127.0.0.1:${port}/agent/api/shortcuts`, {
      headers: { Authorization: 'Bearer desk-secret' },
    }).then((r) => r.json());
    assert.ok(shortcuts.shortcuts.length >= 3);
    assert.ok(shortcuts.shortcuts.some((s) => s.key === 'greeting'));

    const created = await fetch(`http://127.0.0.1:${port}/agent/api/shortcuts`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ key: '/Thanks', text: 'Thank you for contacting VW Melrose.' }),
    }).then(async (r) => {
      assert.strictEqual(r.status, 201);
      return r.json();
    });
    assert.strictEqual(created.shortcut.key, 'thanks');

    const multilineBody = [
      'How vehicle finance works',
      '',
      '🏛️ The dealership doesn\'t decide your instalment.',
      '',
      '👉 Your age',
      '👉 Whether you pay on time',
    ].join('\n');
    const multi = await fetch(`http://127.0.0.1:${port}/agent/api/shortcuts`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ key: 'finance', text: multilineBody + '\r\n' }),
    }).then(async (r) => {
      assert.strictEqual(r.status, 201);
      return r.json();
    });
    assert.ok(multi.shortcut.text.includes('\n\n'));
    assert.ok(multi.shortcut.text.includes('👉 Your age\n👉 Whether you pay on time'));
    assert.strictEqual(multi.shortcut.text.includes('\r'), false);

    const updated = await fetch(
      `http://127.0.0.1:${port}/agent/api/shortcuts/${created.shortcut.id}`,
      {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ text: 'Thanks — chat soon!' }),
      }
    ).then((r) => r.json());
    assert.strictEqual(updated.shortcut.text, 'Thanks — chat soon!');

    const del = await fetch(
      `http://127.0.0.1:${port}/agent/api/shortcuts/${created.shortcut.id}`,
      { method: 'DELETE', headers: { Authorization: 'Bearer desk-secret' } }
    );
    assert.strictEqual(del.status, 200);
    await fetch(
      `http://127.0.0.1:${port}/agent/api/shortcuts/${multi.shortcut.id}`,
      { method: 'DELETE', headers: { Authorization: 'Bearer desk-secret' } }
    );

    // Labels
    const labels = await fetch(`http://127.0.0.1:${port}/agent/api/labels`, {
      headers: { Authorization: 'Bearer desk-secret' },
    }).then((r) => r.json());
    assert.ok(labels.labels.length >= 4);
    const vip = labels.labels.find((l) => l.name === 'VIP');
    assert.ok(vip);

    const newLabel = await fetch(`http://127.0.0.1:${port}/agent/api/labels`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ name: 'Trade-in', color: '#067647' }),
    }).then(async (r) => {
      assert.strictEqual(r.status, 201);
      return r.json();
    });
    assert.strictEqual(newLabel.label.name, 'Trade-in');

    const assign = await fetch(
      `http://127.0.0.1:${port}/agent/api/chats/27821234567/labels`,
      {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ labelIds: [vip.id, newLabel.label.id] }),
      }
    ).then((r) => r.json());
    assert.strictEqual(assign.labelIds.length, 2);

    const chatsLabeled = await fetch(`http://127.0.0.1:${port}/agent/api/chats`, {
      headers: { Authorization: 'Bearer desk-secret' },
    }).then((r) => r.json());
    assert.strictEqual(chatsLabeled.chats[0].labels.length, 2);
    assert.ok(chatsLabeled.chats[0].labels.some((l) => l.name === 'VIP'));

    const thread = await fetch(
      `http://127.0.0.1:${port}/agent/api/chats/27821234567`,
      { headers: { Authorization: 'Bearer desk-secret' } }
    ).then((r) => r.json());
    assert.deepStrictEqual(thread.labelIds.sort(), [vip.id, newLabel.label.id].sort());

    // eslint-disable-next-line no-console
    console.log('✓ agent desk auth, reply, shortcuts, and labels');
  } finally {
    server.close();
  }
}

async function main() {
  await testMessageStoreAndApis();
  // eslint-disable-next-line no-console
  console.log('\nagent desk tests passed.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
