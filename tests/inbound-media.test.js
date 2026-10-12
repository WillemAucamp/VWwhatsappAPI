'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const {
  extractInboundMessage,
  createWebhookRouter,
} = require('../src/routes/webhook');
const { createInboundDedupe } = require('../src/webhook/inboundDedupe');
const { createMessageStore } = require('../src/agent/messageStore');
const { MemorySessionStore } = require('../src/session/store');

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

async function postJson(port, urlPath, body) {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res;
}

function testExtractImageAndDocument() {
  const image = extractInboundMessage({
    from: '27821234567',
    type: 'image',
    image: { id: 'media.img', mime_type: 'image/jpeg', caption: 'My car' },
  });
  assert.strictEqual(image.mediaKind, 'image');
  assert.strictEqual(image.mediaId, 'media.img');
  assert.strictEqual(image.text, 'My car');

  const doc = extractInboundMessage({
    from: '27821234567',
    type: 'document',
    document: {
      id: 'media.doc',
      mime_type: 'application/pdf',
      filename: 'quote.pdf',
    },
  });
  assert.strictEqual(doc.mediaKind, 'document');
  assert.strictEqual(doc.filename, 'quote.pdf');
  assert.strictEqual(doc.mediaId, 'media.doc');

  assert.strictEqual(
    extractInboundMessage({ from: '27821234567', type: 'audio', audio: { id: 'x' } }).text,
    '[Audio]'
  );
  assert.strictEqual(
    extractInboundMessage({ from: '27821234567', type: 'audio', audio: { id: 'x' } }).skipFsm,
    true
  );
  const loc = extractInboundMessage({
    from: '27821234567',
    type: 'location',
    location: { name: 'Melrose Arch' },
  });
  assert.strictEqual(loc.text, '[Location: Melrose Arch]');
  assert.strictEqual(loc.skipFsm, true);
  // eslint-disable-next-line no-console
  console.log('✓ extractInboundMessage stores image/document and placeholder types');
}

async function testWebhookStoresMediaAndSkipsFsm() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbound-media-'));
  const messageStore = createMessageStore(dir);
  const handled = [];
  const engine = {
    handleInbound: async (from, text) => {
      handled.push({ from, text });
    },
  };
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  const app = express();
  app.use(express.json({
    verify: (req, _res, buf) => {
      req.rawBody = Buffer.from(buf);
    },
  }));
  app.use(
    '/webhook',
    createWebhookRouter({
      engine,
      requireSignature: false,
      inboundDedupe: createInboundDedupe(),
      messageStore,
      downloadMediaFn: async () => ({
        buffer: png,
        mimeType: 'image/png',
        fileSize: png.length,
      }),
    })
  );

  const { server, port } = await listen(app);
  try {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: 'wamid.media.1',
                    from: '27829990001',
                    type: 'image',
                    image: { id: 'mid.1', mime_type: 'image/png' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const res = await postJson(port, '/webhook', payload);
    assert.strictEqual(res.status, 200);
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(handled.length, 0, 'FSM must not run for inbound media');
    const messages = await messageStore.listMessages('27829990001');
    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0].mediaKind, 'image');
    assert.strictEqual(messages[0].hasMedia, true);
    assert.strictEqual(messages[0].text, '[Image]');
    assert.strictEqual(messages[0].mediaGraphId, 'mid.1');
    const media = await messageStore.readMedia('27829990001', messages[0].id);
    assert.ok(media);
    assert.ok(media.buffer.length > 0);
    // eslint-disable-next-line no-console
    console.log('✓ webhook stores inbound image and skips FSM');
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testWebhookStoresAudioWithoutFsm() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbound-audio-'));
  const messageStore = createMessageStore(dir);
  const handled = [];
  const engine = {
    handleInbound: async (from, text) => {
      handled.push({ from, text });
    },
  };
  const app = express();
  app.use(express.json({
    verify: (req, _res, buf) => {
      req.rawBody = Buffer.from(buf);
    },
  }));
  app.use(
    '/webhook',
    createWebhookRouter({
      engine,
      requireSignature: false,
      inboundDedupe: createInboundDedupe(),
      messageStore,
    })
  );

  const { server, port } = await listen(app);
  try {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: 'wamid.audio.1',
                    from: '27829990009',
                    type: 'audio',
                    audio: { id: 'mid.audio', mime_type: 'audio/ogg' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const res = await postJson(port, '/webhook', payload);
    assert.strictEqual(res.status, 200);
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(handled.length, 0, 'FSM must not run for audio placeholders');
    const messages = await messageStore.listMessages('27829990009');
    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0].text, '[Audio]');
    // eslint-disable-next-line no-console
    console.log('✓ webhook stores inbound audio placeholder and skips FSM');
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testPersistRetriesWithoutExtras() {
  const saved = [];
  let calls = 0;
  const messageStore = {
    append: async (row) => {
      calls += 1;
      if (calls === 1) {
        throw new Error('column media_kind does not exist');
      }
      saved.push(row);
      return row;
    },
  };
  const engine = { handleInbound: async () => {} };
  const app = express();
  app.use(express.json({
    verify: (req, _res, buf) => {
      req.rawBody = Buffer.from(buf);
    },
  }));
  app.use(
    '/webhook',
    createWebhookRouter({
      engine,
      requireSignature: false,
      inboundDedupe: createInboundDedupe(),
      messageStore,
    })
  );
  const { server, port } = await listen(app);
  try {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: 'wamid.retry.1',
                    from: '27829990008',
                    type: 'text',
                    text: { body: 'hi' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const res = await postJson(port, '/webhook', payload);
    assert.strictEqual(res.status, 200);
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(calls >= 2, 'append retries after first failure');
    assert.ok(saved.length >= 1, 'retry without extras is stored');
    assert.ok(String(saved[0].text).includes('hi'));
    // eslint-disable-next-line no-console
    console.log('✓ webhook retries transcript persist without extras');
  } finally {
    server.close();
  }
}

async function testFailedPlaceholderPersistAllowsMetaRetry() {
  const attempts = [];
  const messageStore = {
    append: async (row) => {
      attempts.push(row);
      throw new Error('postgres unavailable');
    },
  };
  const engine = { handleInbound: async () => {} };
  const dedupe = createInboundDedupe();
  const app = express();
  app.use(express.json({
    verify: (req, _res, buf) => {
      req.rawBody = Buffer.from(buf);
    },
  }));
  app.use(
    '/webhook',
    createWebhookRouter({
      engine,
      requireSignature: false,
      inboundDedupe: dedupe,
      messageStore,
    })
  );
  const { server, port } = await listen(app);
  try {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: 'wamid.audio.lost',
                    from: '27829990007',
                    type: 'audio',
                    audio: { id: 'mid.lost', mime_type: 'audio/ogg' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    await postJson(port, '/webhook', payload);
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(attempts.length >= 1, 'append was attempted');
    assert.ok(
      dedupe.begin('wamid.audio.lost'),
      'failed placeholder must stay unclaimed so a Meta retry can store it'
    );
    // eslint-disable-next-line no-console
    console.log('✓ failed placeholder persist leaves wamid open for Meta retry');
  } finally {
    server.close();
  }
}

async function testWebhookRetriesTransientMediaDownload() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbound-media-retry-'));
  const messageStore = createMessageStore(dir);
  const handled = [];
  const engine = {
    handleInbound: async (from, text) => {
      handled.push({ from, text });
    },
  };
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcJSAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  let downloads = 0;
  const app = express();
  app.use(express.json({
    verify: (req, _res, buf) => {
      req.rawBody = Buffer.from(buf);
    },
  }));
  app.use(
    '/webhook',
    createWebhookRouter({
      engine,
      requireSignature: false,
      inboundDedupe: createInboundDedupe(),
      messageStore,
      inboundMediaRetries: { attempts: 3, delayMs: 5 },
      downloadMediaFn: async () => {
        downloads += 1;
        if (downloads < 2) {
          const err = new Error('WhatsApp media download failed: 502');
          err.code = 'WHATSAPP_MEDIA_DOWNLOAD_FAILED';
          err.status = 502;
          throw err;
        }
        return {
          buffer: png,
          mimeType: 'image/png',
          fileSize: png.length,
        };
      },
    })
  );

  const { server, port } = await listen(app);
  try {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: 'wamid.media.retry',
                    from: '27829990002',
                    type: 'image',
                    image: { id: 'mid.retry', mime_type: 'image/png' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const res = await postJson(port, '/webhook', payload);
    assert.strictEqual(res.status, 200);
    await new Promise((r) => setTimeout(r, 80));
    assert.strictEqual(handled.length, 0);
    assert.ok(downloads >= 2, 'must retry Graph download after transient failure');
    const messages = await messageStore.listMessages('27829990002');
    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0].mediaKind, 'image');
    assert.strictEqual(messages[0].hasMedia, true);
    assert.strictEqual(messages[0].mediaGraphId, 'mid.retry');
    const media = await messageStore.readMedia('27829990002', messages[0].id);
    assert.ok(media && media.buffer.length > 0);
    // eslint-disable-next-line no-console
    console.log('✓ webhook retries transient Graph media download after early 200');
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testWebhookKeepsMediaGraphIdWhenDownloadExhausted() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbound-media-keep-id-'));
  const messageStore = createMessageStore(dir);
  const engine = { handleInbound: async () => {} };
  let downloads = 0;
  const app = express();
  app.use(express.json({
    verify: (req, _res, buf) => {
      req.rawBody = Buffer.from(buf);
    },
  }));
  app.use(
    '/webhook',
    createWebhookRouter({
      engine,
      requireSignature: false,
      inboundDedupe: createInboundDedupe(),
      messageStore,
      inboundMediaRetries: { attempts: 2, delayMs: 5 },
      downloadMediaFn: async () => {
        downloads += 1;
        const err = new Error('WhatsApp media download failed: 503');
        err.code = 'WHATSAPP_MEDIA_DOWNLOAD_FAILED';
        err.status = 503;
        throw err;
      },
    })
  );

  const { server, port } = await listen(app);
  try {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: 'wamid.media.lost',
                    from: '27829990003',
                    type: 'document',
                    document: {
                      id: 'mid.keep',
                      mime_type: 'application/pdf',
                      filename: 'license.pdf',
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const res = await postJson(port, '/webhook', payload);
    assert.strictEqual(res.status, 200);
    await new Promise((r) => setTimeout(r, 80));
    assert.strictEqual(downloads, 2);
    const messages = await messageStore.listMessages('27829990003');
    assert.strictEqual(messages.length, 1);
    assert.ok(
      String(messages[0].text).includes('media unavailable'),
      'staff must see unavailable placeholder'
    );
    assert.strictEqual(
      messages[0].mediaGraphId,
      'mid.keep',
      'Graph media id must survive so recovery can re-download after early 200'
    );
    assert.ok(!messages[0].hasMedia, 'unavailable row must not advertise bytes');
    // eslint-disable-next-line no-console
    console.log('✓ exhausted media download keeps mediaGraphId on placeholder');
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  testExtractImageAndDocument();
  await testWebhookStoresMediaAndSkipsFsm();
  await testWebhookStoresAudioWithoutFsm();
  await testPersistRetriesWithoutExtras();
  await testFailedPlaceholderPersistAllowsMetaRetry();
  await testWebhookRetriesTransientMediaDownload();
  await testWebhookKeepsMediaGraphIdWhenDownloadExhausted();
  // eslint-disable-next-line no-console
  console.log('\ninbound media tests passed.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
