'use strict';

/**
 * Regression: Meta webhook retries must not re-apply the same message.id.
 *
 * Concrete failure without dedupe: after soft-close (qualify), a retried
 * "yes" restarts the session back to GREETING.
 */

const assert = require('assert');
const express = require('express');
const { createWebhookRouter } = require('../src/routes/webhook');
const { createInboundDedupe } = require('../src/webhook/inboundDedupe');
const { MemorySessionStore } = require('../src/session/store');
const { FsmEngine } = require('../src/engine/fsmEngine');

class CapturingLogger {
  constructor() {
    this.leads = [];
  }

  async logLead(record) {
    this.leads.push(record);
    return record;
  }
}

function buildTextWebhook({ from, text, id }) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                {
                  id,
                  from,
                  type: 'text',
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

async function postJson(port, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  // Webhook ACKs immediately then processes async — wait for handler to finish
  await new Promise((r) => setTimeout(r, 75));
  return { status: res.status };
}

async function testDedupeClaim() {
  const dedupe = createInboundDedupe({ ttlMs: 60_000 });
  assert.strictEqual(dedupe.claim('wamid.A'), true);
  assert.strictEqual(dedupe.claim('wamid.A'), false);
  assert.strictEqual(dedupe.claim('wamid.B'), true);
  assert.strictEqual(dedupe.claim(null), true);
  assert.strictEqual(dedupe.claim(''), true);
  // eslint-disable-next-line no-console
  console.log('✓ inbound dedupe claim is once-only per id');
}

async function testDuplicateWebhookDoesNotRestartSoftClosed() {
  const store = new MemorySessionStore();
  const logger = new CapturingLogger();
  const engine = new FsmEngine({
    sessionStore: store,
    leadLogger: logger,
    sendMessage: async () => ({ ok: true }),
    notifyAgent: async () => ({ delivered: false }),
    options: { stubMarker: true },
  });

  const wa = '27009990001';
  // Drive to CONFIRM_QUALIFY — the next "yes" soft-closes as qualified
  await engine.handleInbound(wa, 'hi');
  await engine.handleInbound(wa, '3');
  await engine.handleInbound(wa, 'yes');
  await engine.handleInbound(wa, '2');
  await engine.handleInbound(wa, 'great');

  let session = await store.get(wa);
  assert.strictEqual(session.currentState, 'CONFIRM_QUALIFY');

  const dedupe = createInboundDedupe();
  const app = express();
  app.use(express.json());
  app.use('/webhook', createWebhookRouter({ engine, inboundDedupe: dedupe }));

  // Meta often redelivers the same wamid. Without dedupe the retry sees
  // soft_closed and _restart()s back to GREETING after a successful qualify.
  const payload = buildTextWebhook({
    from: wa,
    text: 'yes',
    id: 'wamid.duplicate-qualify-yes',
  });

  const { server, port } = await listen(app);
  try {
    const first = await postJson(port, '/webhook', payload);
    assert.strictEqual(first.status, 200);

    session = await store.get(wa);
    assert.strictEqual(session.status, 'soft_closed');
    assert.strictEqual(session.currentState, 'QUALIFIED_LINK');
    assert.strictEqual(logger.leads.length, 1);

    const second = await postJson(port, '/webhook', payload);
    assert.strictEqual(second.status, 200);

    session = await store.get(wa);
    assert.strictEqual(
      session.status,
      'soft_closed',
      'duplicate qualify wamid must not reopen soft_closed session'
    );
    assert.strictEqual(session.currentState, 'QUALIFIED_LINK');
    assert.strictEqual(logger.leads.length, 1);
  } finally {
    server.close();
  }
  // eslint-disable-next-line no-console
  console.log('✓ duplicate qualify wamid does not restart soft_closed session');
}

async function testDuplicateDoesNotDoubleAdvanceInfoState() {
  const store = new MemorySessionStore();
  const logger = new CapturingLogger();
  const engine = new FsmEngine({
    sessionStore: store,
    leadLogger: logger,
    sendMessage: async () => ({ ok: true }),
    notifyAgent: async () => ({ delivered: false }),
    options: { stubMarker: true },
  });

  const wa = '27009990002';
  await engine.handleInbound(wa, 'hi');
  let session = await store.get(wa);
  assert.strictEqual(session.currentState, 'GREETING');

  const dedupe = createInboundDedupe();
  const app = express();
  app.use(express.json());
  app.use('/webhook', createWebhookRouter({ engine, inboundDedupe: dedupe }));

  // Simulate Meta delivering the same "2" twice (retry). Without dedupe the
  // second delivery would treat STOCK_LIST as info and jump to LICENSE_CHECK.
  const payload = buildTextWebhook({
    from: wa,
    text: '2',
    id: 'wamid.stock-choice',
  });

  const { server, port } = await listen(app);
  try {
    const a = await postJson(port, '/webhook', payload);
    const b = await postJson(port, '/webhook', payload);
    assert.strictEqual(a.status, 200);
    assert.strictEqual(b.status, 200);

    session = await store.get(wa);
    assert.strictEqual(
      session.currentState,
      'STOCK_LIST',
      'retry of GREETING "2" must not auto-advance info state to LICENSE_CHECK'
    );
    assert.deepStrictEqual(session.path, ['GREETING', 'STOCK_LIST']);
  } finally {
    server.close();
  }
  // eslint-disable-next-line no-console
  console.log('✓ duplicate GREETING choice does not skip STOCK_LIST');
}

async function main() {
  await testDedupeClaim();
  await testDuplicateWebhookDoesNotRestartSoftClosed();
  await testDuplicateDoesNotDoubleAdvanceInfoState();
  // eslint-disable-next-line no-console
  console.log('\nAll webhook dedupe tests passed.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('\nWebhook dedupe test failed:', err);
  process.exit(1);
});
