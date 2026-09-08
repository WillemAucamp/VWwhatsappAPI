'use strict';

/**
 * Regression tests for critical correctness / security bugs.
 * Run: npm test
 */

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const { createApp } = require('../src/app');
const { MemorySessionStore } = require('../src/session/store');
const { FsmEngine } = require('../src/engine/fsmEngine');
const { verifyWhatsAppSignature } = require('../src/routes/webhook');
const {
  cloudApiSendMessage,
} = require('../src/transport/whatsapp');
const config = require('../src/config');

class CapturingLogger {
  constructor() {
    this.leads = [];
  }
  async logLead(record) {
    this.leads.push(record);
    return record;
  }
}

function restoreWhatsAppConfig(snapshot) {
  Object.assign(config.whatsapp, snapshot);
}

async function testGraphBodyOmitsMediaSlot() {
  const snap = { ...config.whatsapp };
  config.whatsapp.token = 'test-token';
  config.whatsapp.phoneNumberId = '123456';

  let parsedBody;
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => {
    parsedBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: 'wamid.test' }] }),
    };
  };

  try {
    await cloudApiSendMessage('27821234567', {
      text: 'stock list',
      link: 'https://example.com/stock',
      mediaSlot: 'stock_list',
      meta: { stateId: 'STOCKLIST_CAROUSEL' },
    });

    assert.ok(parsedBody, 'fetch was called');
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(parsedBody, '_mediaSlot'),
      false,
      'Graph body must not include _mediaSlot'
    );
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(parsedBody, 'mediaSlot'),
      false,
      'Graph body must not include mediaSlot'
    );
    assert.strictEqual(parsedBody.type, 'text');
    assert.ok(String(parsedBody.text.body).includes('stock list'));
    // eslint-disable-next-line no-console
    console.log('✓ Graph API payload omits internal mediaSlot');
  } finally {
    global.fetch = originalFetch;
    restoreWhatsAppConfig(snap);
  }
}

async function testSignatureHelpers() {
  const secret = 'test-app-secret';
  const rawBody = Buffer.from('{"object":"whatsapp_business_account"}');
  const good =
    'sha256=' +
    crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  assert.strictEqual(verifyWhatsAppSignature(rawBody, good, secret), true);
  assert.strictEqual(verifyWhatsAppSignature(rawBody, 'sha256=deadbeef', secret), false);
  assert.strictEqual(verifyWhatsAppSignature(rawBody, undefined, secret), false);
  assert.strictEqual(verifyWhatsAppSignature(rawBody, good, ''), false);
  // eslint-disable-next-line no-console
  console.log('✓ X-Hub-Signature-256 helper accepts only valid HMAC');
}

function postWebhook(port, { body, signature, appSecret }) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  };
  if (signature !== null) {
    const sig =
      signature ||
      'sha256=' +
        crypto
          .createHmac('sha256', appSecret)
          .update(payload)
          .digest('hex');
    headers['X-Hub-Signature-256'] = sig;
  }

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/webhook',
        method: 'POST',
        headers,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => {
          data += c;
        });
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function testWebhookRejectsForgedRequests() {
  const appSecret = 'critical-bug-app-secret';
  const inboundCalls = [];
  const store = new MemorySessionStore();
  const logger = new CapturingLogger();
  const engine = new FsmEngine({
    sessionStore: store,
    leadLogger: logger,
    sendMessage: async () => ({ ok: true }),
    notifyAgent: async () => ({ delivered: false }),
    options: { stubMarker: true },
  });
  const original = engine.handleInbound.bind(engine);
  engine.handleInbound = async (from, text) => {
    inboundCalls.push({ from, text });
    return original(from, text);
  };

  const snap = {
    appSecret: config.whatsapp.appSecret,
    nodeEnv: config.nodeEnv,
  };
  config.whatsapp.appSecret = appSecret;
  config.nodeEnv = 'development';

  const app = createApp({
    engine,
    sessionStore: store,
    leadLogger: logger,
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;

  const waBody = {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                {
                  type: 'text',
                  from: '27829999999',
                  text: { body: 'hi' },
                },
              ],
            },
          },
        ],
      },
    ],
  };

  try {
    const forged = await postWebhook(port, {
      body: waBody,
      signature:
        'sha256=0000000000000000000000000000000000000000000000000000000000000000',
      appSecret,
    });
    assert.strictEqual(forged.status, 403, 'forged signature must be rejected');
    assert.strictEqual(inboundCalls.length, 0, 'engine must not run on forged POST');

    const missing = await postWebhook(port, {
      body: waBody,
      signature: null,
      appSecret,
    });
    assert.strictEqual(missing.status, 403, 'missing signature must be rejected');
    assert.strictEqual(inboundCalls.length, 0);

    const ok = await postWebhook(port, { body: waBody, appSecret });
    assert.strictEqual(ok.status, 200, 'valid signature accepted');
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(inboundCalls.length, 1);
    assert.strictEqual(inboundCalls[0].from, '27829999999');
    // eslint-disable-next-line no-console
    console.log('✓ webhook rejects forged/missing signatures; accepts valid HMAC');
  } finally {
    await new Promise((r) => server.close(r));
    config.whatsapp.appSecret = snap.appSecret;
    config.nodeEnv = snap.nodeEnv;
  }
}

async function testConcurrentInboundSerialization() {
  const store = new MemorySessionStore();
  const logger = new CapturingLogger();
  let delaySend = false;
  const sendOrder = [];

  const engine = new FsmEngine({
    sessionStore: store,
    leadLogger: logger,
    sendMessage: async (to, payload) => {
      sendOrder.push(payload.meta && payload.meta.stateId);
      if (delaySend) {
        await new Promise((r) => setTimeout(r, 40));
      }
      return { ok: true };
    },
    notifyAgent: async () => ({ delivered: false }),
    options: { stubMarker: true },
  });

  const wa = '27821112222';
  delaySend = true;
  // First message starts GREETING (slow send); second should wait then advance
  const p1 = engine.handleInbound(wa, 'hello');
  const p2 = engine.handleInbound(wa, 'qualify me');
  await Promise.all([p1, p2]);

  const session = await store.get(wa);
  assert.strictEqual(
    session.currentState,
    'QUALIFY_CONSENT',
    'serialized handling must apply both transitions in order'
  );
  assert.deepStrictEqual(session.path, ['GREETING', 'QUALIFY_CONSENT']);
  // eslint-disable-next-line no-console
  console.log('✓ concurrent inbound messages serialize per WhatsApp number');
}

async function main() {
  // eslint-disable-next-line no-console
  console.log('Running critical-bug regression tests…\n');
  await testGraphBodyOmitsMediaSlot();
  await testSignatureHelpers();
  await testWebhookRejectsForgedRequests();
  await testConcurrentInboundSerialization();
  // eslint-disable-next-line no-console
  console.log('\nAll critical-bug regression tests passed.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('\nCritical-bug test failed:', err);
  process.exit(1);
});
