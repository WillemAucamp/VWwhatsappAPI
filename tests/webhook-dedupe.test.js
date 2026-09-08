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
const { driveToFinalConsent } = require('./melrose-path');

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

function buildInteractiveButtonWebhook({ from, id, replyId, title }) {
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
                  type: 'interactive',
                  interactive: {
                    type: 'button_reply',
                    button_reply: {
                      id: replyId,
                      title: title || replyId,
                    },
                  },
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

async function testBeginCommitRelease() {
  const dedupe = createInboundDedupe({ ttlMs: 60_000 });

  assert.strictEqual(dedupe.begin('wamid.in-flight'), true);
  assert.strictEqual(
    dedupe.begin('wamid.in-flight'),
    false,
    'concurrent delivery must not double-process while in flight'
  );
  assert.strictEqual(dedupe.inFlightSize(), 1);

  dedupe.release('wamid.in-flight');
  assert.strictEqual(dedupe.inFlightSize(), 0);
  assert.strictEqual(
    dedupe.begin('wamid.in-flight'),
    true,
    'release after failure must allow Meta retry of the same wamid'
  );

  dedupe.commit('wamid.in-flight');
  assert.strictEqual(dedupe.begin('wamid.in-flight'), false);
  assert.strictEqual(dedupe.size(), 1);
  // eslint-disable-next-line no-console
  console.log('✓ begin/commit/release allows retry only after failure');
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
  // Drive to FINAL_CONSENT — the next "yes" soft-closes as qualified
  await driveToFinalConsent(engine, wa);

  let session = await store.get(wa);
  assert.strictEqual(session.currentState, 'FINAL_CONSENT');

  const dedupe = createInboundDedupe();
  const app = express();
  app.use(express.json());
  app.use(
    '/webhook',
    createWebhookRouter({
      engine,
      inboundDedupe: dedupe,
      requireSignature: false,
    })
  );

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
    assert.strictEqual(session.currentState, 'SEND_LINK');
    assert.strictEqual(logger.leads.length, 1);

    const second = await postJson(port, '/webhook', payload);
    assert.strictEqual(second.status, 200);

    session = await store.get(wa);
    assert.strictEqual(
      session.status,
      'soft_closed',
      'duplicate qualify wamid must not reopen soft_closed session'
    );
    assert.strictEqual(session.currentState, 'SEND_LINK');
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
  app.use(
    '/webhook',
    createWebhookRouter({
      engine,
      inboundDedupe: dedupe,
      requireSignature: false,
    })
  );

  // Simulate Meta delivering the same "see our cars" twice (retry).
  // Without dedupe the second delivery would advance past STOCKLIST.
  const payload = buildTextWebhook({
    from: wa,
    text: 'see our cars',
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
      'STOCKLIST_CAROUSEL',
      'retry of GREETING "see our cars" must not advance past stocklist'
    );
    assert.deepStrictEqual(session.path, ['GREETING', 'STOCKLIST_CAROUSEL']);
  } finally {
    server.close();
  }
  // eslint-disable-next-line no-console
  console.log('✓ duplicate GREETING choice does not skip STOCKLIST_CAROUSEL');
}

async function testFailedHandleInboundReleasesClaimForRetry() {
  const store = new MemorySessionStore();
  const logger = new CapturingLogger();
  let sendCount = 0;
  const engine = new FsmEngine({
    sessionStore: store,
    leadLogger: logger,
    sendMessage: async () => {
      sendCount += 1;
      if (sendCount === 1) {
        const err = new Error('WhatsApp send failed: 500');
        err.status = 500;
        throw err;
      }
      return { ok: true };
    },
    notifyAgent: async () => ({ delivered: false }),
    options: { stubMarker: true },
  });

  const wa = '27009990003';
  const dedupe = createInboundDedupe();
  const app = express();
  app.use(express.json());
  app.use(
    '/webhook',
    createWebhookRouter({
      engine,
      inboundDedupe: dedupe,
      requireSignature: false,
    })
  );

  // First delivery: Graph send fails after begin(). Old claim-before-process
  // marked the wamid done, so Meta's retry was skipped and GREETING never
  // persisted. begin/release must let the retry complete.
  const payload = buildTextWebhook({
    from: wa,
    text: 'hi',
    id: 'wamid.send-fail-then-retry',
  });

  const { server, port } = await listen(app);
  try {
    const first = await postJson(port, '/webhook', payload);
    assert.strictEqual(first.status, 200);
    assert.strictEqual(sendCount, 1);

    let session = await store.get(wa);
    assert.ok(
      !session || session.currentState !== 'GREETING',
      'failed first delivery must not leave a committed GREETING session'
    );
    assert.strictEqual(
      dedupe.size(),
      0,
      'failed processing must not commit the wamid'
    );

    const second = await postJson(port, '/webhook', payload);
    assert.strictEqual(second.status, 200);
    assert.strictEqual(sendCount, 2);

    session = await store.get(wa);
    assert.strictEqual(
      session.currentState,
      'GREETING',
      'Meta retry after send failure must advance session to GREETING'
    );
    assert.strictEqual(dedupe.size(), 1);
  } finally {
    server.close();
  }
  // eslint-disable-next-line no-console
  console.log('✓ send failure releases wamid so Meta retry can complete');
}

async function testOneFailedMessageDoesNotAbortSiblingInBatch() {
  const store = new MemorySessionStore();
  const logger = new CapturingLogger();
  const engine = new FsmEngine({
    sessionStore: store,
    leadLogger: logger,
    sendMessage: async (to) => {
      if (to === '27009990004') {
        throw new Error('WhatsApp send failed: 500');
      }
      return { ok: true };
    },
    notifyAgent: async () => ({ delivered: false }),
    options: { stubMarker: true },
  });

  const dedupe = createInboundDedupe();
  const app = express();
  app.use(express.json());
  app.use(
    '/webhook',
    createWebhookRouter({
      engine,
      inboundDedupe: dedupe,
      requireSignature: false,
    })
  );

  const body = {
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                {
                  id: 'wamid.batch-fail',
                  from: '27009990004',
                  type: 'text',
                  text: { body: 'hi' },
                },
                {
                  id: 'wamid.batch-ok',
                  from: '27009990005',
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

  const { server, port } = await listen(app);
  try {
    const res = await postJson(port, '/webhook', body);
    assert.strictEqual(res.status, 200);

    const failed = await store.get('27009990004');
    const ok = await store.get('27009990005');
    assert.ok(
      !failed || failed.currentState !== 'GREETING',
      'failing number must not commit GREETING'
    );
    assert.strictEqual(
      ok.currentState,
      'GREETING',
      'sibling message after a throw must still be processed'
    );
  } finally {
    server.close();
  }
  // eslint-disable-next-line no-console
  console.log('✓ one failed message does not abort later messages in batch');
}

async function testInteractiveButtonReplyAdvancesMenu() {
  const store = new MemorySessionStore();
  const logger = new CapturingLogger();
  const engine = new FsmEngine({
    sessionStore: store,
    leadLogger: logger,
    sendMessage: async () => ({ ok: true }),
    notifyAgent: async () => ({ delivered: false }),
    options: { stubMarker: true },
  });

  const wa = '27009990077';
  await engine.handleInbound(wa, 'hi');
  let session = await store.get(wa);
  assert.strictEqual(session.currentState, 'GREETING');

  const dedupe = createInboundDedupe();
  const app = express();
  app.use(express.json());
  app.use(
    '/webhook',
    createWebhookRouter({
      engine,
      inboundDedupe: dedupe,
      requireSignature: false,
    })
  );

  const { server, port } = await listen(app);
  try {
    const res = await postJson(
      port,
      '/webhook',
      buildInteractiveButtonWebhook({
        from: wa,
        id: 'wamid.button-qualify',
        replyId: 'qualify_me',
        title: 'Qualify Me',
      })
    );
    assert.strictEqual(res.status, 200);
    session = await store.get(wa);
    assert.strictEqual(session.currentState, 'QUALIFY_CONSENT');
  } finally {
    server.close();
  }
  // eslint-disable-next-line no-console
  console.log('✓ interactive button_reply advances GREETING → QUALIFY_CONSENT');
}

async function main() {
  await testDedupeClaim();
  await testBeginCommitRelease();
  await testDuplicateWebhookDoesNotRestartSoftClosed();
  await testDuplicateDoesNotDoubleAdvanceInfoState();
  await testFailedHandleInboundReleasesClaimForRetry();
  await testOneFailedMessageDoesNotAbortSiblingInBatch();
  await testInteractiveButtonReplyAdvancesMenu();
  // eslint-disable-next-line no-console
  console.log('\nAll webhook dedupe tests passed.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('\nWebhook dedupe test failed:', err);
  process.exit(1);
});
