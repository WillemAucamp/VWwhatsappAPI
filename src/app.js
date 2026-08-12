'use strict';

const express = require('express');
const config = require('./config');
const { createSessionStore } = require('./session/store');
const { createLeadLogger } = require('./logger/leadLogger');
const { FsmEngine } = require('./engine/fsmEngine');
const { createWebhookRouter } = require('./routes/webhook');
const { sendMessage } = require('./transport/whatsapp');

function createApp(overrides = {}) {
  const sessionStore = overrides.sessionStore || createSessionStore();
  const leadLogger = overrides.leadLogger || createLeadLogger();
  const engine =
    overrides.engine ||
    new FsmEngine({
      sessionStore,
      leadLogger,
      sendMessage: overrides.sendMessage || sendMessage,
      notifyAgent: overrides.notifyAgent,
      options: overrides.engineOptions,
    });

  const app = express();
  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        // Preserve bytes for X-Hub-Signature-256 verification
        req.rawBody = Buffer.from(buf);
      },
    })
  );

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'wa-prequal-fsm' });
  });

  app.use('/webhook', createWebhookRouter({ engine }));

  app.locals.engine = engine;
  app.locals.sessionStore = sessionStore;
  app.locals.leadLogger = leadLogger;

  return app;
}

module.exports = { createApp };
