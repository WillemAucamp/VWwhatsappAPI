#!/usr/bin/env node
'use strict';

/**
 * Set the WhatsApp Cloud API business profile picture from the bundled JPG.
 *
 * Usage:
 *   npm run profile:picture
 *   npm run profile:picture -- /path/to/photo.jpg
 *
 * Requires in .env:
 *   WHATSAPP_TOKEN
 *   WHATSAPP_PHONE_NUMBER_ID
 *   WHATSAPP_APP_ID   (Meta App Dashboard → Settings → Basic → App ID)
 */

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const {
  setProfilePictureFromFile,
  getBusinessProfile,
  defaultProfilePicturePath,
} = require('../src/transport/businessProfile');

async function main() {
  const argPath = process.argv[2];
  const filePath = argPath
    ? path.resolve(argPath)
    : defaultProfilePicturePath();

  if (!fs.existsSync(filePath)) {
    // eslint-disable-next-line no-console
    console.error(`Profile picture not found: ${filePath}`);
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log(`[profile] Uploading ${filePath} …`);
  const result = await setProfilePictureFromFile(filePath);
  // eslint-disable-next-line no-console
  console.log('[profile] Business profile picture updated');
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ handle: result.handle, updated: result.updated }, null, 2));

  try {
    const profile = await getBusinessProfile();
    // eslint-disable-next-line no-console
    console.log('\n[profile] Current business profile:');
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(profile, null, 2));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[profile] Could not re-fetch profile (non-fatal):', err.message);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[profile] FAILED:', err.message);
  if (err.response) {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify(err.response, null, 2));
  }
  process.exit(1);
});
