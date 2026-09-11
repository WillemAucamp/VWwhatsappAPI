#!/usr/bin/env node
'use strict';

/**
 * Validate local env and ping Graph for the configured phone number.
 * Usage: node scripts/check-meta.js
 */

require('dotenv').config();

const { getMetaReadiness, formatReadinessReport } = require('../src/meta/readiness');
const config = require('../src/config');
const { graphGet } = require('../src/transport/whatsapp');

async function main() {
  const readiness = getMetaReadiness();
  // eslint-disable-next-line no-console
  console.log(formatReadinessReport(readiness));

  if (!readiness.canSend) {
    // eslint-disable-next-line no-console
    console.error(
      '\nFill WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID in .env — see docs/META_SETUP.md'
    );
    process.exit(1);
  }

  const fields =
    'display_phone_number,verified_name,quality_rating,platform_type,is_official_business_account';
  try {
    const phone = await graphGet(config.whatsapp.phoneNumberId, fields);
    // eslint-disable-next-line no-console
    console.log('\n[meta] Graph phone lookup OK');
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(phone, null, 2));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('\n[meta] Graph phone lookup FAILED');
    // eslint-disable-next-line no-console
    console.error(err.message);
    if (err.response) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify(err.response, null, 2));
    }
    process.exit(1);
  }

  if (config.whatsapp.wabaId) {
    try {
      const waba = await graphGet(
        config.whatsapp.wabaId,
        'id,name,account_review_status,business_verification_status'
      );
      // eslint-disable-next-line no-console
      console.log('\n[meta] WABA lookup OK');
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(waba, null, 2));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('\n[meta] WABA lookup failed (non-fatal):', err.message);
    }
  }

  if (config.whatsapp.catalogId) {
    try {
      const { listProductsForProductList } = require('../src/catalog/products');
      const products = await listProductsForProductList({
        catalogId: config.whatsapp.catalogId,
      });
      // eslint-disable-next-line no-console
      console.log(
        `\n[meta] Catalog ${config.whatsapp.catalogId}: ${products.length} sellable product(s)`
      );
      for (const p of products.slice(0, 5)) {
        // eslint-disable-next-line no-console
        console.log(`  - ${p.retailer_id}${p.name ? ` · ${p.name}` : ''}`);
      }
      if (products.length > 5) {
        // eslint-disable-next-line no-console
        console.log(`  … +${products.length - 5} more`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('\n[meta] Catalog lookup failed (non-fatal):', err.message);
      if (err.response) {
        // eslint-disable-next-line no-console
        console.error(JSON.stringify(err.response, null, 2));
      }
    }
  }

  if (readiness.webhookUrl) {
    // eslint-disable-next-line no-console
    console.log(
      `\nIn Meta Developer > WhatsApp > Configuration, set Callback URL:\n  ${readiness.webhookUrl}\nVerify token:\n  ${config.whatsapp.verifyToken}\nSubscribe to: messages`
    );
  } else {
    // eslint-disable-next-line no-console
    console.log(
      '\nSet PUBLIC_BASE_URL to your public https origin, then paste {PUBLIC_BASE_URL}/webhook into Meta.'
    );
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
