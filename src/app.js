'use strict';

const express = require('express');
const config = require('./config');
const { createSessionStore } = require('./session/store');
const { createLeadLogger } = require('./logger/leadLogger');
const { FsmEngine } = require('./engine/fsmEngine');
const { createWebhookRouter } = require('./routes/webhook');
const { sendMessage } = require('./transport/whatsapp');
const { getMetaReadiness } = require('./meta/readiness');

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
        req.rawBody = Buffer.from(buf);
      },
    })
  );

  app.get('/health', (_req, res) => {
    const meta = getMetaReadiness();
    res.json({
      ok: true,
      service: 'vw-whatsapp-prequal',
      meta: {
        canSend: meta.canSend,
        canVerifyWebhook: meta.canVerifyWebhook,
        webhookSignatureRequired: meta.webhookSignatureRequired,
        webhookUrl: meta.webhookUrl,
        copyFilled: `${meta.copy.filled}/${meta.copy.total}`,
        readyToPlugIn: meta.readyToPlugIn,
        missing: meta.missing,
      },
    });
  });

  app.use(
    '/webhook',
    createWebhookRouter({
      engine,
      inboundDedupe: overrides.inboundDedupe,
    })
  );

  app.locals.engine = engine;
  app.locals.sessionStore = sessionStore;
  app.locals.leadLogger = leadLogger;
  app.locals.config = config;

  if (overrides.followUpScheduler) {
    app.locals.followUpScheduler = overrides.followUpScheduler;
  }

  return app;
}

module.exports = { createApp };
