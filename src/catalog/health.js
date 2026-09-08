'use strict';

const config = require('../config');
const {
  listProductsForProductList,
} = require('./products');
const {
  getCommerceSettings,
  ensureCatalogVisible,
} = require('../transport/whatsapp');

const CACHE_MS = 60 * 1000;
let cache = null;

/**
 * Best-effort catalog probe for /health (cached).
 * Does not throw — returns ok:false with error detail when Graph fails.
 */
async function getCatalogHealth(options = {}) {
  const now = Date.now();
  const force = Boolean(options.force);
  if (!force && cache && now - cache.at < CACHE_MS) {
    return { ...cache.value, cached: true };
  }

  const catalogId = config.whatsapp.catalogId || null;
  if (!catalogId) {
    const value = {
      ok: false,
      catalogId: null,
      productCount: 0,
      commerce: null,
      error: 'WHATSAPP_CATALOG_ID unset',
    };
    cache = { at: now, value };
    return { ...value, cached: false };
  }

  if (!config.whatsapp.token || !config.whatsapp.phoneNumberId) {
    const value = {
      ok: false,
      catalogId,
      productCount: 0,
      commerce: null,
      error: 'WhatsApp credentials missing',
    };
    cache = { at: now, value };
    return { ...value, cached: false };
  }

  let commerce = null;
  let commerceError = null;
  try {
    if (options.ensureVisible) {
      commerce = await ensureCatalogVisible();
    } else {
      commerce = await getCommerceSettings();
    }
  } catch (err) {
    commerceError = err && err.message ? String(err.message) : String(err);
  }

  try {
    const products = await listProductsForProductList({ catalogId });
    const value = {
      ok: true,
      catalogId,
      productCount: products.length,
      sample: products.slice(0, 5).map((p) => ({
        retailer_id: p.retailer_id,
        name: p.name || null,
      })),
      commerce,
      commerceError,
      error: null,
      // Catalog browse can work via catalog_message even when product read fails.
      canBrowseViaCatalogMessage: Boolean(
        commerce && commerce.is_catalog_visible
      ),
    };
    cache = { at: now, value };
    return { ...value, cached: false };
  } catch (err) {
    const graph =
      err && err.response && err.response.error ? err.response.error : null;
    const value = {
      ok: false,
      catalogId,
      productCount: 0,
      sample: [],
      commerce,
      commerceError,
      error: err && err.message ? String(err.message) : String(err),
      graphCode: graph && graph.code != null ? graph.code : null,
      graphMessage: graph && graph.message ? String(graph.message) : null,
      canBrowseViaCatalogMessage: Boolean(
        commerce && commerce.is_catalog_visible
      ),
    };
    cache = { at: now, value };
    return { ...value, cached: false };
  }
}

function clearCatalogHealthCache() {
  cache = null;
}

module.exports = {
  getCatalogHealth,
  clearCatalogHealthCache,
};
