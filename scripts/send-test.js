#!/usr/bin/env node
'use strict';

/**
 * Send one WhatsApp Cloud API test message.
 *
 * Text (only works inside the 24h customer-care window, or if they messaged you):
 *   node scripts/send-test.js --to 27821234567 --text "Hello from the bot"
 *
 * Template (works even if they have not messaged you — needs an approved template):
 *   node scripts/send-test.js --to 27821234567 --template hello_world --lang en_US
 */

require('dotenv').config();

const {
  cloudApiSendMessage,
  cloudApiSendTemplate,
} = require('../src/transport/whatsapp');

function arg(name, fallback) {
  const flag = `--${name}`;
  const i = process.argv.indexOf(flag);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
    return process.argv[i + 1];
  }
  return fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const to = arg('to');
  const text = arg('text');
  const template = arg('template');
  const lang = arg('lang', 'en_US');

  if (!to || (!text && !template) || hasFlag('help')) {
    // eslint-disable-next-line no-console
    console.error(`Usage:
  node scripts/send-test.js --to 2782XXXXXXXX --text "Hello"
  node scripts/send-test.js --to 2782XXXXXXXX --template hello_world --lang en_US`);
    process.exit(hasFlag('help') ? 0 : 1);
  }

  const result = template
    ? await cloudApiSendTemplate(to, { name: template, language: lang })
    : await cloudApiSendMessage(to, { text });

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err.message);
  if (err.response) {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify(err.response, null, 2));
  }
  process.exit(1);
});
