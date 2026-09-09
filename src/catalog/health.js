'use strict';

const config = require('../config');
const { listProductsForProductList } = require('./products');
const {
  getCommerceSettings,
  listWabaProductCatalogs,
  prepareCatalogForMessaging,
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
  const wabaId = config.whatsapp.wabaId || null;

  if (!catalogId) {
    const value = {
      ok: false,
      catalogId: null,
      wabaId,
      productCount: 0,
      commerce: null,
      wabaCatalogs: [],
      error: 'WHATSAPP_CATALOG_ID unset',
    };
    cache = { at: now, value };
    return { ...value, cached: false };
  }

  if (!config.whatsapp.token || !config.whatsapp.phoneNumberId) {
    const value = {
      ok: false,
      catalogId,
      wabaId,
      productCount: 0,
      commerce: null,
      wabaCatalogs: [],
      error: 'WhatsApp credentials missing',
    };
    cache = { at: now, value };
    return { ...value, cached: false };
  }

  let prepare = null;
  let commerce = null;
  let commerceError = null;
  let wabaCatalogs = [];
  let wabaCatalogsError = null;
  let linkError = null;

  if (options.ensureVisible) {
    try {
      prepare = await prepareCatalogForMessaging();
      commerce = prepare.commerce;
      commerceError = prepare.commerceError || null;
      linkError = prepare.linkError || null;
      if (prepare.link && prepare.link.catalogs) {
        wabaCatalogs = prepare.link.catalogs;
      }
    } catch (err) {
      commerceError = err && err.message ? String(err.message) : String(err);
    }
  } else {
    try {
      commerce = await getCommerceSettings();
    } catch (err) {
      commerceError = err && err.message ? String(err.message) : String(err);
    }
  }

  if (!wabaCatalogs.length && wabaId) {
    try {
      wabaCatalogs = await listWabaProductCatalogs();
    } catch (err) {
      wabaCatalogsError = err && err.message ? String(err.message) : String(err);
    }
  }

  const catalogLinkedToWaba = wabaCatalogs.some(
    (c) => c && String(c.id) === String(catalogId)
  );

  try {
    const products = await listProductsForProductList({ catalogId });
    const value = {
      ok: true,
      catalogId,
      wabaId,
      productCount: products.length,
      sample: products.slice(0, 5).map((p) => ({
        retailer_id: p.retailer_id,
        name: p.name || null,
      })),
      commerce,
      commerceError,
      linkError,
      wabaCatalogs,
      wabaCatalogsError,
      catalogLinkedToWaba,
      canBrowseViaCatalogMessage: Boolean(
        commerce && commerce.linked && commerce.is_catalog_visible
      ),
      error: null,
      prepare,
    };
    cache = { at: now, value };
    return { ...value, cached: false };
  } catch (err) {
    const graph =
      err && err.response && err.response.error ? err.response.error : null;
    const value = {
      ok: false,
      catalogId,
      wabaId,
      productCount: 0,
      sample: [],
      commerce,
      commerceError,
      linkError,
      wabaCatalogs,
      wabaCatalogsError,
      catalogLinkedToWaba,
      canBrowseViaCatalogMessage: Boolean(
        commerce && commerce.linked && commerce.is_catalog_visible
      ),
      error: err && err.message ? String(err.message) : String(err),
      graphCode: graph && graph.code != null ? graph.code : null,
      graphMessage: graph && graph.message ? String(graph.message) : null,
      prepare,
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
