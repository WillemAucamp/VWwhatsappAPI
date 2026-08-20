'use strict';

const assert = require('assert');
const {
  cloudApiSendMessage,
  cloudApiSendTemplate,
} = require('../src/transport/whatsapp');
const config = require('../src/config');

function restore(snap) {
  Object.assign(config.whatsapp, snap);
}

async function withFakeFetch(run) {
  const snap = { ...config.whatsapp };
  config.whatsapp.token = 'test-token';
  config.whatsapp.phoneNumberId = '123456';
  const originalFetch = global.fetch;
  let parsedBody;
  global.fetch = async (_url, options) => {
    parsedBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: 'wamid.test' }] }),
    };
  };
  try {
    await run(() => parsedBody);
  } finally {
    global.fetch = originalFetch;
    restore(snap);
  }
}

async function testTemplateGraphBody() {
  await withFakeFetch(async (getBody) => {
    await cloudApiSendTemplate('27821234567', {
      name: 'hello_world',
      language: 'en_US',
    });
    const body = getBody();
    assert.strictEqual(body.type, 'template');
    assert.strictEqual(body.template.name, 'hello_world');
    assert.strictEqual(body.template.language.code, 'en_US');
    assert.strictEqual(body.to, '27821234567');
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(body, '_mediaSlot'),
      false
    );
    // eslint-disable-next-line no-console
    console.log('✓ template send uses Graph type=template');
  });
}

async function testTextViaTemplateNameOnSendMessage() {
  await withFakeFetch(async (getBody) => {
    await cloudApiSendMessage('+27 82 123 4567', {
      templateName: 'hello_world',
      templateLanguage: 'en_US',
    });
    const body = getBody();
    assert.strictEqual(body.type, 'template');
    assert.strictEqual(body.to, '27821234567');
    // eslint-disable-next-line no-console
    console.log('✓ sendMessage templateName digits-only recipient');
  });
}

async function main() {
  await testTemplateGraphBody();
  await testTextViaTemplateNameOnSendMessage();
  // eslint-disable-next-line no-console
  console.log('\ntransport graph tests passed.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
