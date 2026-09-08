'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createMessageStore } = require('../src/agent/messageStore');

async function testFileBackendStillDefaultForPathArg() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-store-'));
  const store = createMessageStore(dir);
  assert.strictEqual(store.backend, 'file');

  await store.append({
    waNumber: '27820001111',
    direction: 'in',
    source: 'customer',
    text: 'ping',
  });
  await store.append({
    waNumber: '27820001111',
    direction: 'out',
    source: 'bot',
    text: 'pong',
  });

  const messages = await store.listMessages('27820001111');
  assert.strictEqual(messages.length, 2);
  assert.strictEqual(messages[0].text, 'ping');
  assert.strictEqual(messages[1].text, 'pong');

  const chats = await store.listChats();
  assert.strictEqual(chats.length, 1);
  assert.strictEqual(chats[0].waNumber, '27820001111');
  assert.strictEqual(chats[0].lastText, 'pong');
  assert.strictEqual(chats[0].messageCount, 2);

  // eslint-disable-next-line no-console
  console.log('✓ file message store append / list / chats');
}

async function testPostgresRequiresUrl() {
  assert.throws(
    () => createMessageStore({ backend: 'postgres', databaseUrl: '' }),
    /DATABASE_URL/
  );
  // eslint-disable-next-line no-console
  console.log('✓ postgres store rejects missing DATABASE_URL');
}

async function main() {
  await testFileBackendStillDefaultForPathArg();
  await testPostgresRequiresUrl();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
