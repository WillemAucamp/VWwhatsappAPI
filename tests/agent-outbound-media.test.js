'use strict';

/**
 * Agent reply-media must persist image bytes via loggingSend (desk of record).
 * Regression: caption-only append left hasMedia/readMedia empty after Graph OK.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.AGENT_DESK_ENABLED = 'true';
process.env.AGENT_DESK_PASSWORD = 'desk-secret';

const config = require('../src/config');
config.agent.deskEnabled = true;
config.agent.deskPassword = 'desk-secret';

const { createApp } = require('../src/app');
const { createMessageStore } = require('../src/agent/messageStore');
const { MemorySessionStore } = require('../src/session/store');

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () =>
      resolve({ server, port: server.address().port })
    );
  });
}

async function testLoggingSendPersistsAgentImage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-out-media-'));
  const messageStore = createMessageStore(dir);
  const sessionStore = new MemorySessionStore();
  const outbound = [];

  const app = createApp({
    sessionStore,
    messageStore,
    sendMessage: async (to, payload) => {
      outbound.push({ to, payload });
      return { messages: [{ id: 'wamid.agent.img' }] };
    },
  });

  const { server, port } = await listen(app);
  try {
    const res = await fetch(
      `http://127.0.0.1:${port}/agent/api/chats/27825550123/reply-media`,
      {
        method: 'POST',
        headers: {
          Authorization: 'Bearer desk-secret',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          imageBase64: TINY_PNG_B64,
          mimeType: 'image/png',
          filename: 'stock.png',
          caption: 'Stock photo for customer',
        }),
      }
    );
    const body = await res.json();
    assert.strictEqual(res.status, 200, JSON.stringify(body));
    assert.strictEqual(body.ok, true);
    assert.strictEqual(outbound.length, 1);
    assert.strictEqual(outbound[0].payload.type, 'image');

    const messages = await messageStore.listMessages('27825550123');
    const agentImg = messages.find(
      (m) =>
        m.direction === 'out' &&
        m.source === 'agent' &&
        m.text === 'Stock photo for customer'
    );
    assert.ok(agentImg, 'transcript must include agent media reply');
    assert.strictEqual(
      agentImg.hasMedia,
      true,
      'loggingSend must persist mediaKind/bytes, not caption-only'
    );
    assert.strictEqual(agentImg.mediaKind, 'image');
    assert.strictEqual(agentImg.wamid, 'wamid.agent.img');

    const media = await messageStore.readMedia('27825550123', agentImg.id);
    assert.ok(media, 'readMedia must return agent-sent image after refresh');
    assert.strictEqual(media.mimeType, 'image/png');
    assert.deepStrictEqual(media.buffer, Buffer.from(TINY_PNG_B64, 'base64'));

    // eslint-disable-next-line no-console
    console.log('✓ loggingSend persists agent reply-media image bytes');
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  await testLoggingSendPersistsAgentImage();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
