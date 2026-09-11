'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createMessageStore } = require('../src/agent/messageStore');
const { normalizeDatabaseUrl } = require('../src/agent/postgresMessageStore');

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
  // Never opened: inbound customer messages stay unread even after a bot reply.
  assert.strictEqual(chats[0].unreadCount, 1);

  const afterRead = await store.listChats({
    lastReadByWa: { '27820001111': new Date().toISOString() },
  });
  assert.strictEqual(afterRead[0].unreadCount, 0);

  // eslint-disable-next-line no-console
  console.log('✓ file message store append / list / chats');
}

async function testFileStoreFindsPlusAndSuffixFilenames() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-store-plus-'));
  const store = createMessageStore(dir);
  const plusFile = path.join(dir, '+27820002222.jsonl');
  fs.writeFileSync(
    plusFile,
    `${JSON.stringify({
      id: 'legacy-1',
      waNumber: '+27820002222',
      direction: 'in',
      source: 'customer',
      text: 'legacy plus file',
      at: new Date().toISOString(),
    })}\n`,
    'utf8'
  );
  const byDigits = await store.listMessages('27820002222');
  assert.strictEqual(byDigits.length, 1);
  assert.strictEqual(byDigits[0].text, 'legacy plus file');
  const bySuffix = await store.listMessages('820002222');
  assert.strictEqual(bySuffix.length, 1);
  const mediaId = 'legacy-1';
  const found = await store.listMessages('+27820002222');
  assert.strictEqual(found[0].id, mediaId);
  fs.rmSync(dir, { recursive: true, force: true });
  // eslint-disable-next-line no-console
  console.log('✓ file store reads +prefix and suffix lookups');
}

async function testPostgresRequiresUrl() {
  assert.throws(
    () => createMessageStore({ backend: 'postgres', databaseUrl: '' }),
    /DATABASE_URL/
  );
  // eslint-disable-next-line no-console
  console.log('✓ postgres store rejects missing DATABASE_URL');
}

function testNormalizeDatabaseUrlEncodesPassword() {
  const out = normalizeDatabaseUrl(
    'postgresql://postgres.ref:Leendert316!@aws-1-eu-west-1.pooler.supabase.com:5432/postgres'
  );
  assert.ok(out.includes('Leendert316%21@'));
  assert.ok(!out.includes('Leendert316!@'));
  const already = normalizeDatabaseUrl(
    'postgresql://u:Leendert316%21@host:5432/postgres'
  );
  assert.ok(already.includes('Leendert316%21@'));
  // eslint-disable-next-line no-console
  console.log('✓ normalizeDatabaseUrl percent-encodes password special chars');
}

async function main() {
  await testFileBackendStillDefaultForPathArg();
  await testFileStoreFindsPlusAndSuffixFilenames();
  await testPostgresRequiresUrl();
  testNormalizeDatabaseUrlEncodesPassword();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
