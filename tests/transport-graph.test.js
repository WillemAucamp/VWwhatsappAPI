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

async function testInteractiveButtonGraphBody() {
  await withFakeFetch(async (getBody) => {
    await cloudApiSendMessage('27821234567', {
      text: 'Pick one',
      interactive: {
        type: 'button',
        buttons: [
          { id: 'employed_yes', title: 'Yes' },
          { id: 'employed_no', title: 'No' },
        ],
      },
      mediaSlot: 'ignored',
      meta: { stateId: 'EMPLOYMENT_CHECK' },
    });
    const body = getBody();
    assert.strictEqual(body.type, 'interactive');
    assert.strictEqual(body.interactive.type, 'button');
    assert.strictEqual(body.interactive.body.text, 'Pick one');
    assert.strictEqual(body.interactive.action.buttons.length, 2);
    assert.strictEqual(body.interactive.action.buttons[0].type, 'reply');
    assert.strictEqual(
      body.interactive.action.buttons[0].reply.id,
      'employed_yes'
    );
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(body, 'mediaSlot'),
      false
    );
    assert.strictEqual(Object.prototype.hasOwnProperty.call(body, 'meta'), false);
    // eslint-disable-next-line no-console
    console.log('✓ interactive button Graph body omits internal fields');
  });
}

async function testInteractiveListGraphBody() {
  await withFakeFetch(async (getBody) => {
    await cloudApiSendMessage('27821234567', {
      text: 'What can I help you with?',
      interactive: {
        type: 'list',
        button: 'Choose',
        sections: [
          {
            title: 'Options',
            rows: [
              { id: 'see_cars', title: 'See our cars' },
              { id: 'qualify_me', title: 'Qualify Me' },
              { id: 'promotions', title: 'Promotions' },
              { id: 'opt_out', title: 'Opt-Out' },
            ],
          },
        ],
      },
    });
    const body = getBody();
    assert.strictEqual(body.type, 'interactive');
    assert.strictEqual(body.interactive.type, 'list');
    assert.strictEqual(body.interactive.action.sections[0].rows.length, 4);
    assert.strictEqual(
      body.interactive.action.sections[0].rows[1].id,
      'qualify_me'
    );
    // eslint-disable-next-line no-console
    console.log('✓ interactive list Graph body for greeting menu');
  });
}

async function testAuthErrorIncludesTokenHint() {
  const snap = { ...config.whatsapp };
  config.whatsapp.token = 'bad-token';
  config.whatsapp.phoneNumberId = '123456';
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 401,
    json: async () => ({
      error: {
        message: 'Authentication Error',
        code: 190,
        type: 'OAuthException',
      },
    }),
  });
  try {
    let thrown = null;
    try {
      await cloudApiSendMessage('27821234567', { text: 'hi' });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, 'expected send to throw');
    assert.match(thrown.message, /401/);
    assert.match(thrown.message, /190/);
    assert.match(thrown.message, /WHATSAPP_TOKEN/);
    // eslint-disable-next-line no-console
    console.log('✓ 401 Graph auth error includes token hint');
  } finally {
    global.fetch = originalFetch;
    restore(snap);
  }
}

async function main() {
  await testTemplateGraphBody();
  await testTextViaTemplateNameOnSendMessage();
  await testInteractiveButtonGraphBody();
  await testInteractiveListGraphBody();
  await testAuthErrorIncludesTokenHint();
  // eslint-disable-next-line no-console
  console.log('\ntransport graph tests passed.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
