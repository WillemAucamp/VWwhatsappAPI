'use strict';

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
const { createChatMetaStore } = require('../src/agent/chatMetaStore');
const { createUndoTokenStore } = require('../src/agent/undoTokenStore');
const { createAgentRouter } = require('../src/agent/routes');
const { MemorySessionStore } = require('../src/session/store');
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

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bulk-'));
  const messageStore = createMessageStore(dir);
  const shortcutStore = createShortcutStore(path.join(dir, 'shortcuts.json'));
  const labelStore = createLabelStore(path.join(dir, 'labels.json'));
  const chatReadStore = createChatReadStore(path.join(dir, 'chat_reads.json'));
  const chatMetaStore = createChatMetaStore(path.join(dir, 'chat_meta.json'));
  const undoTokenStore = createUndoTokenStore({ ttlMs: 10_000 });
  const sessionStore = new MemorySessionStore();

  const engine = new FsmEngine({
    sessionStore,
    leadLogger: new CapturingLogger(),
    sendMessage: async () => ({ messages: [{ id: 'wamid.out' }] }),
    notifyAgent: async () => ({ delivered: false }),
  });

  for (const wa of ['27821111111', '27822222222', '27823333333']) {
    await messageStore.append({
      waNumber: wa,
      direction: 'in',
      source: 'customer',
      text: 'hello ' + wa.slice(-2),
    });
  }

  const label = await labelStore.createLabel({ name: 'Bulk Test', color: '#027eb5' });

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
      chatMetaStore,
      undoTokenStore,
      sendMessage: async () => ({ messages: [{ id: 'wamid.agent' }] }),
    })
  );

  const { server, port } = await listen(app);
  const base = `http://127.0.0.1:${port}/agent`;
  return {
    server,
    base,
    label,
    chatMetaStore,
    undoTokenStore,
    chatReadStore,
    labelStore,
    messageStore,
  };
}

async function json(res) {
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function testBulkMarkReadAndLabels() {
  const ctx = await setup();
  try {
    const mark = await json(
      await fetch(ctx.base + '/api/chats/bulk-action', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          action: 'mark_read',
          chatIds: ['27821111111', '27822222222'],
          payload: {},
        }),
      })
    );
    assert.strictEqual(mark.status, 200);
    assert.strictEqual(mark.data.success, true);
    assert.strictEqual(mark.data.updatedCount, 2);
    assert.strictEqual(mark.data.undoToken, undefined);

    const list = await json(
      await fetch(ctx.base + '/api/chats', { headers: authHeaders() })
    );
    assert.strictEqual(list.status, 200);
    const a = list.data.chats.find((c) => c.waNumber === '27821111111');
    assert.ok(a);
    assert.strictEqual(a.unreadCount, 0);

    const labeled = await json(
      await fetch(ctx.base + '/api/chats/bulk-action', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          action: 'add_label',
          chatIds: ['27821111111', '27822222222'],
          payload: { labelId: ctx.label.id },
        }),
      })
    );
    assert.strictEqual(labeled.status, 200);
    assert.strictEqual(labeled.data.updatedCount, 2);

    const list2 = await json(
      await fetch(ctx.base + '/api/chats', { headers: authHeaders() })
    );
    const labeledChat = list2.data.chats.find((c) => c.waNumber === '27821111111');
    assert.ok((labeledChat.labels || []).some((l) => l.id === ctx.label.id));
  } finally {
    ctx.server.close();
  }
}

async function testSoftDeleteArchiveClearWithUndo() {
  const ctx = await setup();
  try {
    const del = await json(
      await fetch(ctx.base + '/api/chats/bulk-action', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          action: 'delete',
          chatIds: ['27821111111'],
          payload: {},
        }),
      })
    );
    assert.strictEqual(del.status, 200);
    assert.ok(del.data.undoToken);

    let list = await json(
      await fetch(ctx.base + '/api/chats', { headers: authHeaders() })
    );
    assert.ok(!list.data.chats.some((c) => c.waNumber === '27821111111'));

    const undone = await json(
      await fetch(ctx.base + '/api/chats/undo', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ undoToken: del.data.undoToken }),
      })
    );
    assert.strictEqual(undone.status, 200);
    assert.strictEqual(undone.data.restoredCount, 1);

    list = await json(
      await fetch(ctx.base + '/api/chats', { headers: authHeaders() })
    );
    assert.ok(list.data.chats.some((c) => c.waNumber === '27821111111'));

    const arch = await json(
      await fetch(ctx.base + '/api/chats/bulk-action', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          action: 'archive',
          chatIds: ['27822222222'],
          payload: {},
        }),
      })
    );
    assert.strictEqual(arch.status, 200);
    list = await json(
      await fetch(ctx.base + '/api/chats', { headers: authHeaders() })
    );
    assert.ok(!list.data.chats.some((c) => c.waNumber === '27822222222'));

    const clear = await json(
      await fetch(ctx.base + '/api/chats/bulk-action', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          action: 'clear',
          chatIds: ['27823333333'],
          payload: {},
        }),
      })
    );
    assert.strictEqual(clear.status, 200);
    list = await json(
      await fetch(ctx.base + '/api/chats', { headers: authHeaders() })
    );
    const cleared = list.data.chats.find((c) => c.waNumber === '27823333333');
    assert.ok(cleared);
    assert.strictEqual(cleared.lastText, '');

    const thread = await json(
      await fetch(ctx.base + '/api/chats/27823333333', { headers: authHeaders() })
    );
    assert.strictEqual(thread.status, 200);
    assert.strictEqual((thread.data.messages || []).length, 0);

    const undoClear = await json(
      await fetch(ctx.base + '/api/chats/undo', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ undoToken: clear.data.undoToken }),
      })
    );
    assert.strictEqual(undoClear.status, 200);
    const thread2 = await json(
      await fetch(ctx.base + '/api/chats/27823333333', { headers: authHeaders() })
    );
    assert.ok((thread2.data.messages || []).length > 0);
  } finally {
    ctx.server.close();
  }
}

async function testUndoExpiryAndValidation() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bulk-ttl-'));
  const messageStore = createMessageStore(dir);
  await messageStore.append({
    waNumber: '27829999999',
    direction: 'in',
    source: 'customer',
    text: 'ttl',
  });
  const shortUndo = createUndoTokenStore({ ttlMs: 30 });
  const app = express();
  app.use(express.json());
  app.use(
    '/agent',
    createAgentRouter({
      engine: new FsmEngine({
        sessionStore: new MemorySessionStore(),
        leadLogger: new CapturingLogger(),
        sendMessage: async () => ({ messages: [{ id: 'x' }] }),
        notifyAgent: async () => ({ delivered: false }),
      }),
      sessionStore: new MemorySessionStore(),
      messageStore,
      shortcutStore: createShortcutStore(path.join(dir, 's.json')),
      labelStore: createLabelStore(path.join(dir, 'l.json')),
      chatReadStore: createChatReadStore(path.join(dir, 'r.json')),
      chatMetaStore: createChatMetaStore(path.join(dir, 'm.json')),
      undoTokenStore: shortUndo,
      sendMessage: async () => ({ messages: [{ id: 'x' }] }),
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
          chatIds: ['27829999999'],
          payload: {},
        }),
      })
    );
    assert.strictEqual(del.status, 200);
    await new Promise((r) => setTimeout(r, 50));
    const gone = await json(
      await fetch(base + '/api/chats/undo', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ undoToken: del.data.undoToken }),
      })
    );
    assert.strictEqual(gone.status, 410);

    const bad = await json(
      await fetch(base + '/api/chats/bulk-action', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          action: 'add_label',
          chatIds: ['27829999999'],
          payload: { labelId: 'missing' },
        }),
      })
    );
    // Soft-deleted chat should 404 before label lookup
    assert.strictEqual(bad.status, 404);
  } finally {
    server.close();
  }
}

async function testRemoveLabelUndo() {
  const ctx = await setup();
  try {
    await json(
      await fetch(ctx.base + '/api/chats/bulk-action', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          action: 'add_label',
          chatIds: ['27821111111'],
          payload: { labelId: ctx.label.id },
        }),
      })
    );
    const removed = await json(
      await fetch(ctx.base + '/api/chats/bulk-action', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          action: 'remove_label',
          chatIds: ['27821111111'],
          payload: { labelId: ctx.label.id },
        }),
      })
    );
    assert.strictEqual(removed.status, 200);
    assert.ok(removed.data.undoToken);
    let list = await json(
      await fetch(ctx.base + '/api/chats', { headers: authHeaders() })
    );
    let chat = list.data.chats.find((c) => c.waNumber === '27821111111');
    assert.ok(!(chat.labels || []).some((l) => l.id === ctx.label.id));

    await json(
      await fetch(ctx.base + '/api/chats/undo', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ undoToken: removed.data.undoToken }),
      })
    );
    list = await json(
      await fetch(ctx.base + '/api/chats', { headers: authHeaders() })
    );
    chat = list.data.chats.find((c) => c.waNumber === '27821111111');
    assert.ok((chat.labels || []).some((l) => l.id === ctx.label.id));
  } finally {
    ctx.server.close();
  }
}

async function main() {
  await testBulkMarkReadAndLabels();
  console.log('✓ bulk mark_read + add_label');
  await testSoftDeleteArchiveClearWithUndo();
  console.log('✓ soft delete / archive / clear + undo');
  await testUndoExpiryAndValidation();
  console.log('✓ undo TTL + invalid label');
  await testRemoveLabelUndo();
  console.log('✓ remove_label undo');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
