'use strict';

const config = require('./config');
const { createApp } = require('./app');
const { FollowUpScheduler } = require('./followup/scheduler');
const { formatReadinessReport, getMetaReadiness } = require('./meta/readiness');

const app = createApp();
const followUpScheduler = new FollowUpScheduler({
  engine: app.locals.engine,
  sessionStore: app.locals.sessionStore,
});

app.locals.followUpScheduler = followUpScheduler;

const server = app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(
    `[wa-prequal] listening on :${config.port}  GET /health  GET|POST /webhook  GET /agent`
  );
  const store = app.locals.messageStore;
  const backend = (store && store.backend) || 'unknown';
  // eslint-disable-next-line no-console
  console.log(`[wa-prequal] transcript store: ${backend}`);
  if (store && typeof store.ping === 'function') {
    store
      .ping()
      .then(() => {
        // eslint-disable-next-line no-console
        console.log('[wa-prequal] postgres transcript store reachable');
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error(
          '[wa-prequal] postgres transcript store FAILED — check DATABASE_URL (URL-encode special chars in the password, e.g. ! → %21):',
          err.message
        );
      });
  }
  // eslint-disable-next-line no-console
  console.log(formatReadinessReport(getMetaReadiness()));
  followUpScheduler.start();

  // Show linked Meta catalog on this WhatsApp number (View catalog / storefront).
  if (config.whatsapp.token && config.whatsapp.phoneNumberId) {
    const { ensureCatalogVisible } = require('./transport/whatsapp');
    ensureCatalogVisible()
      .then((settings) => {
        // eslint-disable-next-line no-console
        console.log(
          '[wa-prequal] commerce settings:',
          JSON.stringify({
            is_catalog_visible: settings.is_catalog_visible,
            is_cart_enabled: settings.is_cart_enabled,
          })
        );
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error(
          '[wa-prequal] ensureCatalogVisible FAILED — See our cars may fall back until catalog is visible on this number:',
          err.message,
          err.response ? JSON.stringify(err.response) : ''
        );
      });
  }
});

function shutdown(signal) {
  // eslint-disable-next-line no-console
  console.log(`[wa-prequal] ${signal} — shutting down`);
  followUpScheduler.stop();
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
