'use strict';

const config = require('./config');
const { createApp } = require('./app');
const { FollowUpScheduler } = require('./followup/scheduler');

const app = createApp();
const followUpScheduler = new FollowUpScheduler({
  engine: app.locals.engine,
  sessionStore: app.locals.sessionStore,
});

app.locals.followUpScheduler = followUpScheduler;

const server = app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(
    `[wa-prequal] listening on :${config.port} (webhook /webhook, Coexistence Cloud API)`
  );
  followUpScheduler.start();
});

function shutdown(signal) {
  // eslint-disable-next-line no-console
  console.log(`[wa-prequal] ${signal} — shutting down`);
  followUpScheduler.stop();
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
