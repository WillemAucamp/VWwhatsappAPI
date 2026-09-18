'use strict';

/**
 * Regression: desk soft-delete must not permanently orphan customers.
 *
 * Trigger:
 * 1. Staff takeOver a chat (quiet + agentTakenOver).
 * 2. Soft-delete the chat (inbox hides it; undo window is only ~10s).
 * 3. Without a fix, inbound is swallowed forever and staff cannot open/Release.
 *
 * Also: a later customer message must revive soft-deleted / archived meta so
 * the thread reappears on the desk instead of landing in a black hole.
 *
 * Run: node tests/soft-delete-hold-revive.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

process.env.AGENT_DESK_ENABLED = 'true';
process.env.AGENT_DESK_PASSWORD = 'desk-secret';

const config = require('../src/config');
config.agent.deskEnabled = true;
config.agent.deskPassword = 'desk-secret';

const { createMessageStore } = require('../src/agent/messageStore');
const { createShortcutStore } = require('../src/agent/shortcutStore');
const { createLabelStore } = require('../src/agent/labelStore');
const { createChatReadStore } = require('../src/agent/chatReadStore');
const {
  createChatMetaStore,
  applyChatMeta,
  reviveChatMetaOnInbound,
} = require('../src/agent/chatMetaStore');
const { createUndoTokenStore } = require('../src/agent/undoTokenStore');
const { createAgentRouter } = require('../src/agent/routes');
const { createWebhookRouter } = require('../src/routes/webhook');
const { MemorySessionStore, createEmptySession } = require('../src/session/store');
const { FsmEngine } = require('../src/engine/fsmEngine');

class CapturingLogger {
  async logLead() {
    return {};
  }
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () =>
      resolve({ server, port: server.address().port })
    );
  });
}

function authHeaders() {
  return {
    Authorization: 'Bearer desk-secret',
    'Content-Type': 'application/json',
  };
}

async function json(res) {
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function testClearAgentHoldHelper() {
  const store = new MemorySessionStore();
  const wa = '27824440001';
  const engine = new FsmEngine({
    sessionStore: store,
    leadLogger: new CapturingLogger(),
    sendMessage: async () => ({ ok: true }),
    notifyAgent: async () => ({ delivered: true }),
  });

  await store.set(wa, {
    ...createEmptySession(wa),
    currentState: 'EMPLOYED_INCOME_CHECK',
    path: ['GREETING', 'EMPLOYED_INCOME_CHECK'],
    status: 'active',
  });
  await engine.takeOver(wa, { silent: true });

  let session = await store.get(wa);
  assert.strictEqual(session.agentTakenOver, true);
  assert.strictEqual(session.status, 'quiet');

  const cleared = await engine.clearAgentHold(wa);
  assert.strictEqual(cleared.cleared, true);
  session = await store.get(wa);
  assert.strictEqual(session.agentTakenOver, false);
  assert.strictEqual(session.status, 'quiet');
  assert.strictEqual(session.currentState, 'EMPLOYED_INCOME_CHECK');

  const inbound = await engine.handleInbound(wa, 'hello');
  assert.ok(!inbound.agentHeld, 'cleared hold must not swallow reopen');
  session = await store.get(wa);
  assert.strictEqual(session.status, 'active');
  assert.strictEqual(session.currentState, 'GREETING');

  // eslint-disable-next-line no-console
  console.log('✓ clearAgentHold drops silent hold without wiping funnel path');
}

async function testSoftDeleteClearsHoldAndThreadStaysOpenable() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soft-del-hold-'));
  const messageStore = createMessageStore(dir);
  const chatMetaStore = createChatMetaStore(path.join(dir, 'chat_meta.json'));
  const sessionStore = new MemorySessionStore();
  const wa = '27824440002';

  await messageStore.append({
    waNumber: wa,
    direction: 'in',
    source: 'customer',
    text: 'hi',
  });

  const engine = new FsmEngine({
    sessionStore,
    leadLogger: new CapturingLogger(),
    sendMessage: async () => ({ messages: [{ id: 'wamid.out' }] }),
    notifyAgent: async () => ({ delivered: false }),
  });

  await sessionStore.set(wa, {
    ...createEmptySession(wa),
    currentState: 'LICENSE_CHECK',
    path: ['GREETING', 'EMPLOYED_INCOME_CHECK', 'LICENSE_CHECK'],
    status: 'active',
  });
  await engine.takeOver(wa, { silent: true });

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
      chatReadStore: createChatReadStore(path.join(dir, 'chat_reads.json')),
      chatMetaStore,
      undoTokenStore: createUndoTokenStore({ ttlMs: 10_000 }),
      sendMessage: async () => ({ messages: [{ id: 'wamid.agent' }] }),
    })
  );

  const { server, port } = await listen(app);
  const base = `http://127.0.0.1:${port}/agent`;

  try {
    const del = await json(
      await fetch(base + '/api/chats/bulk-action', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          action: 'delete',
          chatIds: [wa],
          payload: {},
        }),
      })
    );
    assert.strictEqual(del.status, 200);

    const session = await sessionStore.get(wa);
    assert.strictEqual(
      session.agentTakenOver,
      false,
      'soft-delete must clear agentTakenOver'
    );

    const list = await json(
      await fetch(base + '/api/chats', { headers: authHeaders() })
    );
    assert.ok(
      !list.data.chats.some((c) => c.waNumber === wa),
      'deleted chat stays hidden from inbox'
    );

    const thread = await json(
      await fetch(base + `/api/chats/${wa}`, { headers: authHeaders() })
    );
    assert.strictEqual(thread.status, 200, 'thread must remain openable');
    assert.ok(thread.data.deletedAt);

    const inbound = await engine.handleInbound(wa, 'hi');
    assert.ok(!inbound.agentHeld, 'customer must not stay silently held');
  } finally {
    server.close();
  }

  // eslint-disable-next-line no-console
  console.log('✓ soft-delete clears hold; thread remains openable');
}

async function testInboundRevivesDeletedAndArchived() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soft-del-revive-'));
  const messageStore = createMessageStore(dir);
  const chatMetaStore = createChatMetaStore(path.join(dir, 'chat_meta.json'));
  const sessionStore = new MemorySessionStore();
  const wa = '27824440003';

  const engine = new FsmEngine({
    sessionStore,
    leadLogger: new CapturingLogger(),
    sendMessage: async () => ({ messages: [{ id: 'wamid.bot' }] }),
    notifyAgent: async () => ({ delivered: false }),
  });

  await chatMetaStore.softDeleteMany([wa]);
  await chatMetaStore.archiveMany([wa]);

  let map = await chatMetaStore.getMap();
  assert.strictEqual(
    applyChatMeta(
      { waNumber: wa, lastText: 'x', lastAt: new Date().toISOString() },
      map
    ),
    null
  );

  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        req.rawBody = Buffer.from(buf);
      },
    })
  );
  app.use(
    '/webhook',
    createWebhookRouter({
      engine,
      messageStore,
      chatMetaStore,
      requireSignature: false,
      appSecret: '',
    })
  );

  const { server, port } = await listen(app);
  try {
    const body = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: wa,
                    id: 'wamid.revive.1',
                    type: 'text',
                    text: { body: 'still here' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const res = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.strictEqual(res.status, 200);
    // Async webhook processing — wait briefly for revive.
    for (let i = 0; i < 20; i += 1) {
      map = await chatMetaStore.getMap();
      const row = map[wa];
      if (row && !row.deletedAt && !row.archivedAt) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 25));
    }
  } finally {
    server.close();
  }

  const row = await chatMetaStore.get(wa);
  assert.strictEqual(row.deletedAt, null, 'inbound must undelete');
  assert.strictEqual(row.archivedAt, null, 'inbound must unarchive');
  const visible = applyChatMeta(
    { waNumber: wa, lastText: 'still here', lastAt: new Date().toISOString() },
    { [wa]: row }
  );
  assert.ok(visible, 'revived chat must be listable again');

  const direct = await reviveChatMetaOnInbound(chatMetaStore, wa);
  assert.strictEqual(direct.revived, false);

  // eslint-disable-next-line no-console
  console.log('✓ inbound undeletes + unarchives hidden chats');
}

async function main() {
  // eslint-disable-next-line no-console
  console.log('Running soft-delete hold / revive regression tests…\n');
  await testClearAgentHoldHelper();
  await testSoftDeleteClearsHoldAndThreadStaysOpenable();
  await testInboundRevivesDeletedAndArchived();
  // eslint-disable-next-line no-console
  console.log('\nAll soft-delete hold / revive regression tests passed.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('\nTest failed:', err);
  process.exit(1);
});
