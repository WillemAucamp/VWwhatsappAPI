'use strict';

const config = require('./config');
const { createApp } = require('./app');
const { FollowUpScheduler } = require('./followup/scheduler');
const { createLabelBackfill } = require('./agent/labelBackfill');
const { formatReadinessReport, getMetaReadiness } = require('./meta/readiness');

const app = createApp();
const followUpScheduler = new FollowUpScheduler({
  engine: app.locals.engine,
  sessionStore: app.locals.sessionStore,
});

app.locals.followUpScheduler = followUpScheduler;

const labelBackfill = createLabelBackfill({
  labelStore: app.locals.labelStore,
  messageStore: app.locals.messageStore,
  sessionStore: app.locals.sessionStore,
});
app.locals.labelBackfill = labelBackfill;

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
  labelBackfill.start();

  // Link Meta catalog to this WABA (when WABA id is set) and show it on the number.
  if (config.whatsapp.token && config.whatsapp.phoneNumberId) {
    const { prepareCatalogForMessaging } = require('./transport/whatsapp');
    prepareCatalogForMessaging()
      .then((result) => {
        // eslint-disable-next-line no-console
        console.log(
          '[wa-prequal] catalog prepare:',
          JSON.stringify({
            linkError: result.linkError,
            linkedAlready: result.link && result.link.already,
            catalogs: result.link && result.link.catalogs,
            commerce: result.commerce
              ? {
                  linked: result.commerce.linked,
                  is_catalog_visible: result.commerce.is_catalog_visible,
                  is_cart_enabled: result.commerce.is_cart_enabled,
                }
              : null,
            commerceError: result.commerceError,
          })
        );
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error(
          '[wa-prequal] prepareCatalogForMessaging FAILED — See our cars may fall back until the catalog is linked + visible:',
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
  if (labelBackfill && typeof labelBackfill.stop === 'function') {
    labelBackfill.stop();
  }
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
