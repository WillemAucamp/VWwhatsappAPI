#!/usr/bin/env node
'use strict';

/**
 * List sellable products from the configured Meta Commerce catalog.
 * Usage: node scripts/check-catalog.js
 */

require('dotenv').config();

const config = require('../src/config');
const { listProductsForProductList } = require('../src/catalog/products');

async function main() {
  const catalogId = config.whatsapp.catalogId;
  if (!config.whatsapp.token) {
    // eslint-disable-next-line no-console
    console.error('WHATSAPP_TOKEN missing');
    process.exit(1);
  }
  if (!catalogId) {
    // eslint-disable-next-line no-console
    console.error('WHATSAPP_CATALOG_ID missing');
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log(`[catalog] fetching products for ${catalogId}…`);
  try {
    const products = await listProductsForProductList({ catalogId });
    // eslint-disable-next-line no-console
    console.log(`[catalog] ${products.length} sellable product(s)`);
    for (const p of products) {
      // eslint-disable-next-line no-console
      console.log(`  - ${p.retailer_id}${p.name ? ` · ${p.name}` : ''}`);
    }
    if (!products.length) {
      // eslint-disable-next-line no-console
      console.warn(
        '[catalog] empty — add in-stock products in Commerce Manager before "See our cars" can show a live list'
      );
      process.exit(2);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[catalog] FAILED:', err.message);
    if (err.response) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify(err.response, null, 2));
    }
    process.exit(1);
  }
}

main();
