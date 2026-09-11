'use strict';

/**
 * Read vs unread on the agent desk.
 *
 * 1. Bot replies leave the chat unread (staff must review what the bot said).
 * 2. Opening the chat marks it read, takeover or not.
 * 3. A manual "mark unread" sticks until the chat is opened again.
 *
 * WhatsApp has no mark-chat-unread API, so rule 3 is the desk's own flag.
 * The cursors themselves must survive a redeploy, which is why the store
 * prefers Postgres whenever DATABASE_URL is set.
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

const { createAgentRouter } = require('../src/agent/routes');
const { createLabelStore } = require('../src/agent/labelStore');
const { createShortcutStore } = require('../src/agent/shortcutStore');
const { MemorySessionStore } = require('../src/session/store');

const {
  createChatReadStore,
  createFileChatReadStore,
} = require('../src/agent/chatReadStore');
const { createMessageStore } = require('../src/agent/messageStore');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function testBotRepliesCountAsUnread() {
  const dir = tmpDir('desk-unread-bot-');
  const store = createMessageStore(dir);
  const wa = '27612642189';
  const at = (minute) => `2026-09-11T06:${String(minute).padStart(2, '0')}:00.000Z`;

  await store.append({
    waNumber: wa, direction: 'in', source: 'customer', text: 'Hi', at: at(40),
  });
  await store.append({
    waNumber: wa, direction: 'out', source: 'bot', text: 'Menu', at: at(41),
  });
  await store.append({
    waNumber: wa, direction: 'in', source: 'customer', text: 'Ok', at: at(43),
  });

  const never = await store.listChats();
  assert.strictEqual(never[0].unreadCount, 3, 'customer + bot messages all await review');

  const openedAt = at(45);
  const afterOpen = await store.listChats({ lastReadByWa: { [wa]: openedAt } });
  assert.strictEqual(afterOpen[0].unreadCount, 0);

  // A bot reply after the agent looked at the chat makes it unread again.
  await store.append({
    waNumber: wa, direction: 'out', source: 'bot', text: 'Follow-up', at: at(50),
  });
  const afterBot = await store.listChats({ lastReadByWa: { [wa]: openedAt } });
  assert.strictEqual(afterBot[0].unreadCount, 1);

  // What the agent sent themselves never counts.
  await store.append({
    waNumber: wa, direction: 'out', source: 'agent', text: 'On it', at: at(52),
  });
  const afterAgent = await store.listChats({ lastReadByWa: { [wa]: at(51) } });
  assert.strictEqual(afterAgent[0].unreadCount, 0);

  fs.rmSync(dir, { recursive: true, force: true });
  // eslint-disable-next-line no-console
  console.log('✓ bot replies count as unread; agent sends do not');
}

async function testReadCursorAndStickyUnread() {
  const dir = tmpDir('desk-unread-store-');
  const reads = createFileChatReadStore(path.join(dir, 'chat_reads.json'));
  const wa = '27612642189';

  assert.strictEqual(await reads.get(wa), null);
  assert.strictEqual(await reads.isForcedUnread(wa), false);

  const opened = await reads.markRead(wa);
  assert.ok(opened.lastReadAt);
  assert.strictEqual(opened.forcedUnread, false);

  // Marking unread flags the chat for follow-up; it does not rewind the
  // cursor, so the badge stays a nudge instead of the whole history.
  const forced = await reads.markUnread(wa);
  assert.strictEqual(forced.forcedUnread, true);
  assert.strictEqual(forced.lastReadAt, opened.lastReadAt);
  assert.strictEqual(await reads.isForcedUnread(wa), true);

  const state = await reads.getState();
  assert.strictEqual(state.forcedUnread[wa], true);
  assert.strictEqual(state.reads[wa], opened.lastReadAt);

  // Opening the chat again clears the manual flag.
  await reads.markRead(wa);
  assert.strictEqual(await reads.isForcedUnread(wa), false);

  fs.rmSync(dir, { recursive: true, force: true });
  // eslint-disable-next-line no-console
  console.log('✓ read cursor clears manual unread only on an explicit open');
}

/**
 * The inbox badge for a manually unread chat comes from the router, which
 * floors the store's count at 1 for a flagged chat. Nine read messages must
 * still show a badge of 1, the way WhatsApp shows a single dot.
 */
async function testForcedUnreadShowsInInbox() {
  const dir = tmpDir('desk-unread-inbox-');
  const messageStore = createMessageStore(dir);
  const chatReadStore = createFileChatReadStore(path.join(dir, 'chat_reads.json'));
  const wa = '27612642189';

  for (let i = 0; i < 8; i += 1) {
    await messageStore.append({
      waNumber: wa,
      direction: 'in',
      source: 'customer',
      text: `Message ${i}`,
      at: `2026-09-10T06:${String(30 + i).padStart(2, '0')}:00.000Z`,
    });
  }
  await messageStore.append({
    waNumber: wa,
    direction: 'out',
    source: 'agent',
    text: 'Replied',
    at: '2026-09-10T06:40:00.000Z',
  });

  const app = express();
  app.use(
    '/agent',
    createAgentRouter({
      engine: { handleInbound: async () => {} },
      sessionStore: new MemorySessionStore(),
      messageStore,
      shortcutStore: createShortcutStore(path.join(dir, 'shortcuts.json')),
      labelStore: createLabelStore(path.join(dir, 'labels.json')),
      chatReadStore,
      sendMessage: async () => ({ messages: [{ id: 'wamid.out' }] }),
    })
  );
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = server.address().port;
  const call = (url, init) =>
    fetch(`http://127.0.0.1:${port}/agent${url}`, {
      ...init,
      headers: {
        Authorization: 'Bearer desk-secret',
        'Content-Type': 'application/json',
        ...((init && init.headers) || {}),
      },
    }).then((r) => r.json());
  const chatFor = async () => {
    const listed = await call('/api/chats');
    return listed.chats.find((c) => c.waNumber === wa);
  };

  try {
    await call(`/api/chats/${wa}/read`, {
      method: 'POST',
      body: JSON.stringify({ force: true }),
    });
    const read = await chatFor();
    assert.strictEqual(read.unreadCount, 0);
    assert.strictEqual(read.forcedUnread, false);

    await call(`/api/chats/${wa}/unread`, { method: 'POST' });
    const unread = await chatFor();
    assert.strictEqual(unread.forcedUnread, true);
    assert.strictEqual(
      unread.unreadCount,
      1,
      'a manual unread is a nudge, not the whole history'
    );

    // Opening the chat again clears it.
    await call(`/api/chats/${wa}/read`, {
      method: 'POST',
      body: JSON.stringify({ force: true }),
    });
    const reopened = await chatFor();
    assert.strictEqual(reopened.unreadCount, 0);
    assert.strictEqual(reopened.forcedUnread, false);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // eslint-disable-next-line no-console
  console.log('✓ manual unread shows a single-message badge, cleared on open');
}

function testReadStoreBackendSelection() {
  const dir = tmpDir('desk-unread-backend-');
  const fileStore = createChatReadStore(path.join(dir, 'chat_reads.json'));
  assert.strictEqual(fileStore.backend, 'file');

  const pgStore = createChatReadStore({
    backend: 'postgres',
    databaseUrl: 'postgresql://u:p@localhost:5432/postgres',
  });
  assert.strictEqual(pgStore.backend, 'postgres');
  ['getAll', 'getState', 'get', 'isForcedUnread', 'markRead', 'markUnread'].forEach(
    (fn) => {
      assert.strictEqual(
        typeof pgStore[fn],
        'function',
        `postgres read store must expose ${fn}`
      );
    }
  );

  // Render wipes the disk on deploy, so a configured database always wins.
  const auto = createChatReadStore({
    databaseUrl: 'postgresql://u:p@localhost:5432/postgres',
  });
  assert.strictEqual(auto.backend, 'postgres');

  fs.rmSync(dir, { recursive: true, force: true });
  // eslint-disable-next-line no-console
  console.log('✓ read cursors go to Postgres whenever DATABASE_URL is set');
}

function testDeskUiWiresExplicitRead() {
  const html = fs.readFileSync(
    path.join(__dirname, '../public/agent/index.html'),
    'utf8'
  );
  assert.ok(html.includes('markChatRead'), 'desk must mark read explicitly');
  assert.ok(
    html.includes("markChatRead(next, true)"),
    'clicking a chat is an explicit open'
  );
  assert.ok(
    html.includes('forcedUnread'),
    'desk must respect a manually unread chat'
  );
  assert.ok(
    !/chat\.unreadCount = 0;\s*\n\s*chat\.lastReadAt = data\.lastReadAt/.test(html),
    'loadThread must not clear unread by itself'
  );
  // eslint-disable-next-line no-console
  console.log('✓ desk UI marks read on open, not on every poll');
}

/**
 * Opt-in parity with WhatsApp's own read receipts: marking a chat read on the
 * desk can tell Meta to show the customer blue ticks. Per the Cloud API docs
 * that is POST /{phone-number-id}/messages with status=read and the inbound
 * wamid, and marking one message read also covers earlier ones.
 */
async function testOpeningChatCanSendWhatsAppReadReceipt() {
  const dir = tmpDir('desk-unread-receipt-');
  const messageStore = createMessageStore(dir);
  const chatReadStore = createFileChatReadStore(path.join(dir, 'chat_reads.json'));
  const wa = '27612642189';
  const receipts = [];

  await messageStore.append({
    waNumber: wa,
    direction: 'in',
    source: 'customer',
    text: 'Ok',
    wamid: 'wamid.inbound.last',
  });
  await messageStore.append({
    waNumber: wa,
    direction: 'out',
    source: 'bot',
    text: 'Menu',
    wamid: 'wamid.outbound.bot',
  });

  const app = express();
  app.use(
    '/agent',
    createAgentRouter({
      engine: { handleInbound: async () => {} },
      sessionStore: new MemorySessionStore(),
      messageStore,
      shortcutStore: createShortcutStore(path.join(dir, 'shortcuts.json')),
      labelStore: createLabelStore(path.join(dir, 'labels.json')),
      chatReadStore,
      sendMessage: async () => ({ messages: [{ id: 'wamid.out' }] }),
      markMessageRead: async (wamid) => {
        receipts.push(wamid);
        return { success: true };
      },
    })
  );
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = server.address().port;
  const postRead = () =>
    fetch(`http://127.0.0.1:${port}/agent/api/chats/${wa}/read`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer desk-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ force: true }),
    }).then((r) => r.json());

  try {
    const off = await postRead();
    assert.strictEqual(off.ok, true);
    assert.strictEqual(receipts.length, 0, 'read receipts stay opt-in');
    assert.strictEqual(off.receipt, null);

    config.agent.sendReadReceipts = true;
    const on = await postRead();
    assert.strictEqual(on.ok, true);
    assert.deepStrictEqual(receipts, ['wamid.inbound.last']);
    assert.strictEqual(on.receipt.sent, true);
  } finally {
    config.agent.sendReadReceipts = false;
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // eslint-disable-next-line no-console
  console.log('✓ opening a chat can send the customer a read receipt when enabled');
}

async function main() {
  await testBotRepliesCountAsUnread();
  await testOpeningChatCanSendWhatsAppReadReceipt();
  await testReadCursorAndStickyUnread();
  await testForcedUnreadShowsInInbox();
  testReadStoreBackendSelection();
  testDeskUiWiresExplicitRead();
  // eslint-disable-next-line no-console
  console.log('\ndesk unread tests passed.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
