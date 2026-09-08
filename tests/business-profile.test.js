'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.WHATSAPP_TOKEN = 'test-token';
process.env.WHATSAPP_PHONE_NUMBER_ID = 'phone-123';
process.env.WHATSAPP_APP_ID = 'app-999';
process.env.WHATSAPP_API_VERSION = 'v21.0';
process.env.WHATSAPP_GRAPH_BASE_URL = 'https://graph.facebook.com';

const config = require('../src/config');
config.whatsapp.token = 'test-token';
config.whatsapp.phoneNumberId = 'phone-123';
config.whatsapp.appId = 'app-999';
config.whatsapp.apiVersion = 'v21.0';
config.whatsapp.graphBaseUrl = 'https://graph.facebook.com';

const {
  createUploadSession,
  uploadFileBytes,
  updateBusinessProfilePicture,
  setProfilePictureFromFile,
  defaultProfilePicturePath,
} = require('../src/transport/businessProfile');

async function withMockFetch(handler, fn) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const entry = { url: String(url), options };
    calls.push(entry);
    return handler(entry);
  };
  try {
    await fn(calls);
  } finally {
    global.fetch = original;
  }
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

async function testDefaultAssetExists() {
  const file = defaultProfilePicturePath();
  assert.ok(fs.existsSync(file), `expected profile asset at ${file}`);
  const stat = fs.statSync(file);
  assert.ok(stat.size > 1000, 'profile.jpg should be a real image');
  // eslint-disable-next-line no-console
  console.log('✓ bundled public/agent/profile.jpg present');
}

async function testSetProfilePictureFlow() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'profile-pic-'));
  const file = path.join(dir, 'avatar.jpg');
  fs.writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff, 0xd9, 1, 2, 3, 4]));

  await withMockFetch(async (entry) => {
    const url = entry.url;
    if (url.includes('/app-999/uploads')) {
      return jsonResponse(200, { id: 'upload:SESSION1' });
    }
    if (url.includes('/upload:SESSION1')) {
      assert.strictEqual(entry.options.headers.Authorization, 'OAuth test-token');
      assert.strictEqual(entry.options.headers.file_offset, '0');
      return jsonResponse(200, { h: '4::HANDLE==:abc' });
    }
    if (url.includes('/phone-123/whatsapp_business_profile')) {
      const body = JSON.parse(entry.options.body);
      assert.strictEqual(body.messaging_product, 'whatsapp');
      assert.strictEqual(body.profile_picture_handle, '4::HANDLE==:abc');
      return jsonResponse(200, { success: true });
    }
    throw new Error(`unexpected fetch ${url}`);
  }, async (calls) => {
    const result = await setProfilePictureFromFile(file);
    assert.strictEqual(result.handle, '4::HANDLE==:abc');
    assert.strictEqual(result.updated.success, true);
    assert.strictEqual(calls.length, 3);
    // eslint-disable-next-line no-console
    console.log('✓ resumable upload + business profile picture update');
  });
}

async function testMissingAppId() {
  const prev = config.whatsapp.appId;
  config.whatsapp.appId = '';
  try {
    await createUploadSession({
      fileName: 'x.jpg',
      fileLength: 10,
      token: 'test-token',
    });
    assert.fail('expected missing app id error');
  } catch (err) {
    assert.strictEqual(err.code, 'WHATSAPP_APP_ID_MISSING');
    // eslint-disable-next-line no-console
    console.log('✓ WHATSAPP_APP_ID required for upload session');
  } finally {
    config.whatsapp.appId = prev;
  }
}

async function main() {
  await testDefaultAssetExists();
  await testSetProfilePictureFlow();
  await testMissingAppId();
  // Keep uploadFileBytes / updateBusinessProfilePicture imported for coverage clarity.
  assert.strictEqual(typeof uploadFileBytes, 'function');
  assert.strictEqual(typeof updateBusinessProfilePicture, 'function');
  // eslint-disable-next-line no-console
  console.log('\nbusiness profile picture tests passed.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
