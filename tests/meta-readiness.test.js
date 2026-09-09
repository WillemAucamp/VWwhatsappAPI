'use strict';

const assert = require('assert');
const { getMetaReadiness, copyStatus } = require('../src/meta/readiness');
const config = require('../src/config');

function testCopyStatusCountsFilledKeys() {
  const status = copyStatus();
  assert.ok(status.total > 0);
  assert.strictEqual(status.filled + status.blank, status.total);
  assert.strictEqual(status.greetingFilled, true);
  assert.strictEqual(status.blank, 0);
  // eslint-disable-next-line no-console
  console.log('✓ copy status reports filled launch keys');
}

function testReadinessWithoutSecrets() {
  const snap = {
    token: config.whatsapp.token,
    phoneNumberId: config.whatsapp.phoneNumberId,
    verifyToken: config.whatsapp.verifyToken,
    appSecret: config.whatsapp.appSecret,
    nodeEnv: config.nodeEnv,
    publicBaseUrl: config.publicBaseUrl,
  };

  config.whatsapp.token = '';
  config.whatsapp.phoneNumberId = '';
  config.whatsapp.verifyToken = 'change-me-verify-token';
  config.whatsapp.appSecret = '';
  config.nodeEnv = 'development';
  config.publicBaseUrl = '';

  try {
    const readiness = getMetaReadiness();
    assert.strictEqual(readiness.canSend, false);
    assert.strictEqual(readiness.canVerifyWebhook, false);
    assert.strictEqual(readiness.readyToPlugIn, false);
    assert.ok(readiness.missing.includes('WHATSAPP_TOKEN'));
    assert.ok(readiness.missing.includes('WHATSAPP_PHONE_NUMBER_ID'));
    assert.ok(readiness.missing.includes('WHATSAPP_VERIFY_TOKEN'));
    // eslint-disable-next-line no-console
    console.log('✓ readiness lists missing Meta env when unset');
  } finally {
    config.whatsapp.token = snap.token;
    config.whatsapp.phoneNumberId = snap.phoneNumberId;
    config.whatsapp.verifyToken = snap.verifyToken;
    config.whatsapp.appSecret = snap.appSecret;
    config.nodeEnv = snap.nodeEnv;
    config.publicBaseUrl = snap.publicBaseUrl;
  }
}

function testReadinessReadyWhenConfigured() {
  const snap = {
    token: config.whatsapp.token,
    phoneNumberId: config.whatsapp.phoneNumberId,
    verifyToken: config.whatsapp.verifyToken,
    appSecret: config.whatsapp.appSecret,
    nodeEnv: config.nodeEnv,
    publicBaseUrl: config.publicBaseUrl,
  };

  config.whatsapp.token = 'EAAB-test';
  config.whatsapp.phoneNumberId = '123456789';
  config.whatsapp.verifyToken = 'unique-verify-token';
  config.whatsapp.appSecret = 'app-secret';
  config.nodeEnv = 'production';
  config.publicBaseUrl = 'https://bot.example.com';

  try {
    const readiness = getMetaReadiness();
    assert.strictEqual(readiness.canSend, true);
    assert.strictEqual(readiness.canVerifyWebhook, true);
    assert.strictEqual(readiness.webhookSignatureRequired, true);
    assert.strictEqual(readiness.webhookUrl, 'https://bot.example.com/webhook');
    assert.strictEqual(readiness.readyToPlugIn, true);
    assert.deepStrictEqual(readiness.missing, []);
    // eslint-disable-next-line no-console
    console.log('✓ readiness is ready when token, phone id, verify token, secret, URL set');
  } finally {
    config.whatsapp.token = snap.token;
    config.whatsapp.phoneNumberId = snap.phoneNumberId;
    config.whatsapp.verifyToken = snap.verifyToken;
    config.whatsapp.appSecret = snap.appSecret;
    config.nodeEnv = snap.nodeEnv;
    config.publicBaseUrl = snap.publicBaseUrl;
  }
}

async function main() {
  testCopyStatusCountsFilledKeys();
  testReadinessWithoutSecrets();
  testReadinessReadyWhenConfigured();
  // eslint-disable-next-line no-console
  console.log('\nmeta-readiness tests passed.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
