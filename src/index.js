'use strict';

const config = require('./config');
const { createApp } = require('./app');

const app = createApp();

app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(
    `[wa-prequal] listening on :${config.port} (webhook /webhook, Coexistence Cloud API)`
  );
});
