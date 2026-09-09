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
const { createChatReadStore } = require('../src/agent/chatReadStore');
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
  const chatReadsPath = path.join(dir, 'chat_reads.json');
  const messageStore = createMessageStore(dir);
  const shortcutStore = createShortcutStore(shortcutsPath);
  const labelStore = createLabelStore(labelsPath);
  const chatReadStore = createChatReadStore(chatReadsPath);
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
      chatReadStore,
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
    assert.strictEqual(chats.chats[0].unreadCount, 1);

    const threadOpen = await fetch(`http://127.0.0.1:${port}/agent/api/chats/27821234567`, {
      headers: { Authorization: 'Bearer desk-secret' },
    }).then((r) => r.json());
    assert.ok(threadOpen.lastReadAt);
    assert.strictEqual(threadOpen.messages.length, 1);

    const chatsAfterRead = await fetch(`http://127.0.0.1:${port}/agent/api/chats`, {
      headers: { Authorization: 'Bearer desk-secret' },
    }).then((r) => r.json());
    assert.strictEqual(chatsAfterRead.chats[0].unreadCount, 0);

    await messageStore.append({
      waNumber: '27821234567',
      direction: 'in',
      source: 'customer',
      text: 'still here',
      at: new Date(Date.now() + 1000).toISOString(),
    });
    await messageStore.append({
      waNumber: '27829998877',
      direction: 'in',
      source: 'customer',
      text: 'another lead',
    });
    const chatsUnread = await fetch(`http://127.0.0.1:${port}/agent/api/chats`, {
      headers: { Authorization: 'Bearer desk-secret' },
    }).then((r) => r.json());
    const primary = chatsUnread.chats.find((c) => c.waNumber === '27821234567');
    const other = chatsUnread.chats.find((c) => c.waNumber === '27829998877');
    assert.strictEqual(primary.unreadCount, 1);
    assert.strictEqual(other.unreadCount, 1);

    // Bot reply must not clear unread on a chat the agent has not opened.
    await messageStore.append({
      waNumber: '27829998877',
      direction: 'out',
      source: 'bot',
      text: 'Welcome menu',
      at: new Date(Date.now() + 2000).toISOString(),
    });
    const chatsAfterBot = await fetch(`http://127.0.0.1:${port}/agent/api/chats`, {
      headers: { Authorization: 'Bearer desk-secret' },
    }).then((r) => r.json());
    const otherAfterBot = chatsAfterBot.chats.find((c) => c.waNumber === '27829998877');
    assert.strictEqual(otherAfterBot.lastSource, 'bot');
    assert.ok(otherAfterBot.unreadCount >= 1);

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

    // Collapsed one-line bodies (from the old text input) are repaired on load.
    const collapsed =
      "How vehicle finance works 🏛️ The dealership doesn't decide your instalment or interest rate — that's entirely up to the bank. 📊 Your instalment depends heavily on your credit profile. This isn't just your credit score — it includes things like: 👉 Your age 👉 Whether you pay your accounts on time each month 👉 How much of your available credit you're using (ideally under 50%) 👉 How diverse your credit accounts are 👉 How long you've been employed 🚗 It also depends on the vehicle you choose: 👉 New and used vehicles fall into different risk categories 👉 Banks apply different scoring criteria to each, which affects the interest rate you're offered Because of all these variables, we won't know your exact instalment until the bank runs your inquiry 📋. What I can do is get the ball rolling by inquiring so we can see exactly what you qualify for";
    const existing = JSON.parse(fs.readFileSync(shortcutsPath, 'utf8'));
    existing.shortcuts.push({
      id: 'sc_collapsed_finance',
      key: 'financehelp',
      text: collapsed,
      updatedAt: '2026-09-09T00:00:00.000Z',
    });
    fs.writeFileSync(shortcutsPath, `${JSON.stringify(existing, null, 2)}\n`);
    const repairedList = await fetch(`http://127.0.0.1:${port}/agent/api/shortcuts`, {
      headers: { Authorization: 'Bearer desk-secret' },
    }).then((r) => r.json());
    const repaired = repairedList.shortcuts.find((s) => s.key === 'financehelp');
    assert.ok(repaired, 'repaired finance shortcut present');
    assert.ok(repaired.text.includes('\n🏛️ '));
    assert.ok(repaired.text.includes('\n👉 Your age\n👉 Whether you pay'));
    assert.ok(repaired.text.includes('\n🚗 It also depends'));
    assert.ok(repaired.text.includes('\nBecause of all these variables'));
    assert.ok(repaired.text.includes('\nWhat I can do is get the ball rolling'));
    assert.strictEqual(repaired.text.includes(' 👉 '), false);
    await fetch(
      `http://127.0.0.1:${port}/agent/api/shortcuts/${repaired.id}`,
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

    // Recreate after delete (same name) — desk must be able to add again.
    await fetch(`http://127.0.0.1:${port}/agent/api/labels/${newLabel.label.id}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer desk-secret' },
    }).then((r) => assert.strictEqual(r.status, 200));
    const recreated = await fetch(`http://127.0.0.1:${port}/agent/api/labels`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ name: 'Trade-in', color: '#067647' }),
    }).then(async (r) => {
      assert.strictEqual(r.status, 201);
      return r.json();
    });
    assert.strictEqual(recreated.label.name, 'Trade-in');
    assert.notStrictEqual(recreated.label.id, newLabel.label.id);

    const assign = await fetch(
      `http://127.0.0.1:${port}/agent/api/chats/27821234567/labels`,
      {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ labelIds: [vip.id, recreated.label.id] }),
      }
    ).then((r) => r.json());
    assert.strictEqual(assign.labelIds.length, 2);

    const chatsLabeled = await fetch(`http://127.0.0.1:${port}/agent/api/chats`, {
      headers: { Authorization: 'Bearer desk-secret' },
    }).then((r) => r.json());
    const labeled = chatsLabeled.chats.find((c) => c.waNumber === '27821234567');
    assert.ok(labeled);
    assert.strictEqual(labeled.labels.length, 2);
    assert.ok(labeled.labels.some((l) => l.name === 'VIP'));

    const thread = await fetch(
      `http://127.0.0.1:${port}/agent/api/chats/27821234567`,
      { headers: { Authorization: 'Bearer desk-secret' } }
    ).then((r) => r.json());
    assert.deepStrictEqual(thread.labelIds.sort(), [vip.id, recreated.label.id].sort());

    // eslint-disable-next-line no-console
    console.log('✓ agent desk auth, reply, shortcuts, and labels');
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

  // Start a normal funnel, then staff takes over.
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

  // Only Release to bot hands control back (resume prior step when possible).
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
        (o.payload.meta.promptKey === 'session_resume_notice' ||
          o.payload.meta.promptKey === 'session_restart_notice')
    ),
    'release should send resume or restart notice'
  );

  // eslint-disable-next-line no-console
  console.log('✓ agent takeover holds until explicit release');
}

async function testAgentReplySendsOnceThroughLoggingSend() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tx-once-'));
  const messageStore = createMessageStore(dir);
  const sessionStore = new MemorySessionStore();
  const graphCalls = [];

  const baseSend = async (to, payload) => {
    graphCalls.push({ to, payload });
    return { messages: [{ id: `wamid.graph.${graphCalls.length}` }] };
  };

  // Mirror production: loggingSend wraps Graph send and appends once.
  const loggingSend = async (to, payload = {}) => {
    const result = await baseSend(to, payload);
    await messageStore.append({
      waNumber: to,
      direction: 'out',
      source:
        payload.meta && payload.meta.source === 'agent' ? 'agent' : 'bot',
      text: payload.text || '',
      wamid:
        result && result.messages && result.messages[0]
          ? result.messages[0].id
          : null,
    });
    return result;
  };

  const engine = new FsmEngine({
    sessionStore,
    leadLogger: new CapturingLogger(),
    sendMessage: loggingSend,
    notifyAgent: async () => ({ delivered: false }),
  });

  const app = express();
  app.use(express.json());
  app.use(
    '/agent',
    createAgentRouter({
      engine,
      sessionStore,
      messageStore,
      shortcutStore: createShortcutStore(path.join(dir, 'shortcuts.json')),
      labelStore: createLabelStore(path.join(dir, 'labels.json')),
      chatReadStore: createChatReadStore(path.join(dir, 'reads.json')),
      sendMessage: loggingSend,
    })
  );

  const { server, port } = await listen(app);
  try {
    const reply = await fetch(
      `http://127.0.0.1:${port}/agent/api/chats/27825550123/reply`,
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ text: 'Only once please' }),
      }
    );
    assert.strictEqual(reply.status, 200);

    const agentSends = graphCalls.filter(
      (c) => c.payload && c.payload.meta && c.payload.meta.source === 'agent'
    );
    assert.strictEqual(
      agentSends.length,
      1,
      `expected one Graph send for agent reply, got ${agentSends.length}`
    );

    const messages = await messageStore.listMessages('27825550123');
    const agentRows = messages.filter((m) => m.source === 'agent');
    assert.strictEqual(
      agentRows.length,
      1,
      `expected one transcript row for agent reply, got ${agentRows.length}`
    );
    assert.strictEqual(agentRows[0].text, 'Only once please');

    // eslint-disable-next-line no-console
    console.log('✓ agent reply hits Graph + transcript exactly once');
  } finally {
    server.close();
  }
}

async function main() {
  await testMessageStoreAndApis();
  await testAgentTakeoverHoldsUntilRelease();
  await testAgentReplySendsOnceThroughLoggingSend();
  // eslint-disable-next-line no-console
  console.log('\nagent desk tests passed.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
