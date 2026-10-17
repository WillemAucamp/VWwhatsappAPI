'use strict';

/**
 * Graph-OK agent replies must not return ok:true when the desk transcript
 * append fails — otherwise of-record messages disappear after refresh.
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

const { createApp } = require('../src/app');
const { createMessageStore } = require('../src/agent/messageStore');
const { createShortcutStore } = require('../src/agent/shortcutStore');
const { createLabelStore } = require('../src/agent/labelStore');
const { createChatReadStore } = require('../src/agent/chatReadStore');
const { MemorySessionStore } = require('../src/session/store');

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

async function testReplyFailsClosedWhenTranscriptAppendFails() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'out-tx-'));
  const inner = createMessageStore(dir);
  let failAppend = false;
  const messageStore = {
    ...inner,
    append: async (...args) => {
      if (failAppend) throw new Error('postgres append boom');
      return inner.append(...args);
    },
    listMessages: (...args) => inner.listMessages(...args),
    listChats: (...args) => inner.listChats(...args),
    searchChats: (...args) => inner.searchChats(...args),
    countChats: (...args) => inner.countChats(...args),
    listWaNumbers: (...args) => inner.listWaNumbers(...args),
    readMedia: (...args) => inner.readMedia(...args),
    backend: 'file',
  };

  const graphSent = [];
  const app = createApp({
    sessionStore: new MemorySessionStore(),
    messageStore,
    shortcutStore: createShortcutStore(path.join(dir, 'shortcuts.json')),
    labelStore: createLabelStore(path.join(dir, 'labels.json')),
    chatReadStore: createChatReadStore(path.join(dir, 'reads.json')),
    sendMessage: async (to, payload) => {
      graphSent.push({ to, payload });
      return { messages: [{ id: 'wamid.agent.1' }] };
    },
    notifyAgent: async () => ({ delivered: false }),
  });

  const { server, port } = await listen(app);
  try {
    failAppend = true;
    const res = await fetch(
      `http://127.0.0.1:${port}/agent/api/chats/27825550123/reply`,
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ text: 'Quote attached' }),
      }
    );
    const body = await res.json();
    assert.strictEqual(res.status, 503, JSON.stringify(body));
    assert.strictEqual(body.error, 'transcript_append_failed');
    assert.strictEqual(body.wamid, 'wamid.agent.1');
    assert.strictEqual(graphSent.length, 1, 'Graph send still happened');
    assert.strictEqual(body.ok, undefined);

    const rows = await inner.listMessages('27825550123');
    assert.strictEqual(
      rows.filter((r) => r.text === 'Quote attached').length,
      0,
      'failed append must leave desk empty'
    );

    failAppend = false;
    const ok = await fetch(
      `http://127.0.0.1:${port}/agent/api/chats/27825550123/reply`,
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ text: 'Follow-up after store recovery' }),
      }
    );
    const okBody = await ok.json();
    assert.strictEqual(ok.status, 200, JSON.stringify(okBody));
    assert.strictEqual(okBody.ok, true);
    const saved = await inner.listMessages('27825550123');
    assert.ok(
      saved.some((r) => r.text === 'Follow-up after store recovery'),
      'successful reply must land in the of-record transcript'
    );
  } finally {
    server.close();
  }
  // eslint-disable-next-line no-console
  console.log('✓ agent reply returns 503 when transcript append fails after Graph OK');
}

async function testReplyMediaFailsClosedWhenTranscriptAppendFails() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'out-media-tx-'));
  const inner = createMessageStore(dir);
  const messageStore = {
    ...inner,
    append: async () => {
      throw new Error('postgres append boom');
    },
    listMessages: (...args) => inner.listMessages(...args),
    listChats: (...args) => inner.listChats(...args),
    searchChats: (...args) => inner.searchChats(...args),
    countChats: (...args) => inner.countChats(...args),
    listWaNumbers: (...args) => inner.listWaNumbers(...args),
    readMedia: (...args) => inner.readMedia(...args),
    backend: 'file',
  };

  const app = createApp({
    sessionStore: new MemorySessionStore(),
    messageStore,
    shortcutStore: createShortcutStore(path.join(dir, 'shortcuts.json')),
    labelStore: createLabelStore(path.join(dir, 'labels.json')),
    chatReadStore: createChatReadStore(path.join(dir, 'reads.json')),
    sendMessage: async () => ({ messages: [{ id: 'wamid.media.1' }] }),
    notifyAgent: async () => ({ delivered: false }),
  });

  const { server, port } = await listen(app);
  try {
    const tinyPngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const res = await fetch(
      `http://127.0.0.1:${port}/agent/api/chats/27825550999/reply-media`,
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          imageBase64: tinyPngBase64,
          mimeType: 'image/png',
          caption: 'stock',
        }),
      }
    );
    const body = await res.json();
    assert.strictEqual(res.status, 503, JSON.stringify(body));
    assert.strictEqual(body.error, 'transcript_append_failed');
    assert.strictEqual(body.wamid, 'wamid.media.1');
  } finally {
    server.close();
  }
  // eslint-disable-next-line no-console
  console.log('✓ agent reply-media returns 503 when transcript append fails after Graph OK');
}

async function main() {
  await testReplyFailsClosedWhenTranscriptAppendFails();
  await testReplyMediaFailsClosedWhenTranscriptAppendFails();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
