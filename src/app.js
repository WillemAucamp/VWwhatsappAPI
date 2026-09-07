'use strict';

const express = require('express');
const path = require('path');
const config = require('./config');
const { createSessionStore } = require('./session/store');
const { createLeadLogger } = require('./logger/leadLogger');
const { FsmEngine } = require('./engine/fsmEngine');
const { createWebhookRouter } = require('./routes/webhook');
const { sendMessage } = require('./transport/whatsapp');
const { getMetaReadiness } = require('./meta/readiness');
const webhookDiagnostics = require('./webhook/diagnostics');
const { createMessageStore } = require('./agent/messageStore');
const { createAgentRouter } = require('./agent/routes');

function createApp(overrides = {}) {
  const sessionStore = overrides.sessionStore || createSessionStore();
  const leadLogger = overrides.leadLogger || createLeadLogger();
  const messageStore = overrides.messageStore || createMessageStore();

  const baseSend = overrides.sendMessage || sendMessage;
  const loggingSend = async (to, payload = {}) => {
    const result = await baseSend(to, payload);
    if (messageStore) {
      try {
        const text = [payload.text, payload.link].filter(Boolean).join('\n\n');
        const source =
          (payload.meta && payload.meta.source) ||
          (payload.meta && payload.meta.quiet ? 'bot' : 'bot');
        await messageStore.append({
          waNumber: to,
          direction: 'out',
          source: source === 'agent' ? 'agent' : 'bot',
          text,
          wamid:
            result &&
            result.messages &&
            result.messages[0] &&
            result.messages[0].id
              ? result.messages[0].id
              : null,
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[transcript] outbound append failed', err.message);
      }
    }
    return result;
  };

  const engine =
    overrides.engine ||
    new FsmEngine({
      sessionStore,
      leadLogger,
      sendMessage: loggingSend,
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
      webhook: webhookDiagnostics.snapshot(),
      agentDesk: {
        enabled: Boolean(config.agent.deskEnabled && config.agent.deskPassword),
        path: '/agent',
      },
    });
  });

  app.use(
    '/webhook',
    createWebhookRouter({
      engine,
      inboundDedupe: overrides.inboundDedupe,
      messageStore,
    })
  );

  app.use(
    '/agent',
    createAgentRouter({
      engine,
      sessionStore,
      messageStore,
      sendMessage: loggingSend,
    })
  );

  app.use('/agent/static', express.static(path.join(__dirname, '../public/agent')));

  app.locals.engine = engine;
  app.locals.sessionStore = sessionStore;
  app.locals.leadLogger = leadLogger;
  app.locals.messageStore = messageStore;
  app.locals.config = config;

  if (overrides.followUpScheduler) {
    app.locals.followUpScheduler = overrides.followUpScheduler;
  }

  return app;
}

module.exports = { createApp };
