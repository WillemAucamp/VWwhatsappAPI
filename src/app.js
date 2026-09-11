'use strict';

const express = require('express');
const path = require('path');
const config = require('./config');
const { createSessionStore } = require('./session/store');
const { createLeadLogger } = require('./logger/leadLogger');
const { FsmEngine } = require('./engine/fsmEngine');
const { createWebhookRouter } = require('./routes/webhook');
const { sendMessage, joinTextAndLink } = require('./transport/whatsapp');
const { getMetaReadiness } = require('./meta/readiness');
const { getCatalogHealth } = require('./catalog/health');
const webhookDiagnostics = require('./webhook/diagnostics');
const { createMessageStore } = require('./agent/messageStore');
const { createShortcutStore } = require('./agent/shortcutStore');
const { createLabelStore } = require('./agent/labelStore');
const { createChatReadStore } = require('./agent/chatReadStore');
const { createAgentRouter } = require('./agent/routes');

function createApp(overrides = {}) {
  const sessionStore = overrides.sessionStore || createSessionStore();
  const leadLogger = overrides.leadLogger || createLeadLogger();
  const messageStore = overrides.messageStore || createMessageStore();
  const shortcutStore = overrides.shortcutStore || createShortcutStore();
  const labelStore = overrides.labelStore || createLabelStore();
  const chatReadStore = overrides.chatReadStore || createChatReadStore();

  const baseSend = overrides.sendMessage || sendMessage;
  const loggingSend = async (to, payload = {}) => {
    const result = await baseSend(to, payload);
    if (messageStore) {
      try {
        const isImage =
          payload.type === 'image' ||
          Boolean(payload.mediaId) ||
          Boolean(payload.mediaBuffer) ||
          Boolean(payload.imageBase64);
        const joined = joinTextAndLink(payload.text, payload.link);
        const text = isImage
          ? joined && String(joined).trim()
            ? String(joined).trim()
            : '[Image]'
          : joined;
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
        webhookDiagnostics.recordTranscriptAppendError(err);
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
      labelStore,
    });

  const app = express();
  app.use(
    express.json({
      // Agent desk paste-image sends base64 (~4/3 of binary; desk allows up to 16MB).
      limit: '24mb',
      verify: (req, _res, buf) => {
        req.rawBody = Buffer.from(buf);
      },
    })
  );

  app.get('/health', async (_req, res) => {
    const meta = getMetaReadiness();
    let catalog = {
      ok: false,
      catalogId: meta.catalogId,
      productCount: 0,
      error: 'not_checked',
    };
    try {
      catalog = await getCatalogHealth({ ensureVisible: true, force: true });
    } catch (err) {
      catalog = {
        ok: false,
        catalogId: meta.catalogId,
        productCount: 0,
        error: err && err.message ? err.message : String(err),
      };
    }
    res.json({
      ok: true,
      service: 'vw-whatsapp-prequal',
      build: {
        // Bumped when SEND_LINK no longer duplicates the form URL.
        fsm: 'fix-dup-form-link-2026-09-09',
        copyKeys: meta.copy.total,
        commit:
          process.env.RENDER_GIT_COMMIT ||
          process.env.GIT_COMMIT ||
          process.env.COMMIT_SHA ||
          null,
      },
      meta: {
        canSend: meta.canSend,
        canVerifyWebhook: meta.canVerifyWebhook,
        webhookSignatureRequired: meta.webhookSignatureRequired,
        webhookUrl: meta.webhookUrl,
        wabaId: config.whatsapp.wabaId || null,
        catalogId: meta.catalogId,
        copyFilled: `${meta.copy.filled}/${meta.copy.total}`,
        readyToPlugIn: meta.readyToPlugIn,
        missing: meta.missing,
      },
      catalog,
      webhook: webhookDiagnostics.snapshot(),
      agentDesk: {
        enabled: Boolean(config.agent.deskEnabled && config.agent.deskPassword),
        path: '/agent',
        messageStore: messageStore && messageStore.backend ? messageStore.backend : 'unknown',
        // Agent composer emoji picker (desk UI only).
        emojiPicker: 'agent-emoji-picker-2026-09-09',
        // Paste image from clipboard → WhatsApp media send.
        pasteImage: 'agent-multi-image-2026-09-10',
        // Inbound customer image/document → desk transcript.
        inboundMedia: 'agent-inbound-media-2026-09-10',
        settingsStore:
          labelStore && labelStore.backend ? labelStore.backend : 'file',
        labelsCatalog: 'cemented-2026-09-10',
        // Inbox list must not scan every transcript (blank desk on timeout).
        inboxList: 'raw-list-2026-09-10',
        emergency: Boolean(config.agent.deskEmergency),
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
      shortcutStore,
      labelStore,
      chatReadStore,
      sendMessage: loggingSend,
    })
  );

  app.use('/agent/static', express.static(path.join(__dirname, '../public/agent')));

  app.locals.engine = engine;
  app.locals.sessionStore = sessionStore;
  app.locals.leadLogger = leadLogger;
  app.locals.messageStore = messageStore;
  app.locals.shortcutStore = shortcutStore;
  app.locals.labelStore = labelStore;
  app.locals.chatReadStore = chatReadStore;
  app.locals.config = config;

  // Rewrite any shortcuts that were flattened by the old single-line editor.
  Promise.resolve()
    .then(() => shortcutStore.list())
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[shortcuts] startup repair failed', err && err.message);
    });

  if (overrides.followUpScheduler) {
    app.locals.followUpScheduler = overrides.followUpScheduler;
  }

  return app;
}

module.exports = { createApp };
