'use strict';

const config = require('../config');
const { graphGet } = require('../transport/whatsapp');

/** WhatsApp multi-product messages allow at most 30 items. */
const PRODUCT_LIST_MAX = 30;

/**
 * @param {object} product Graph catalog product row
 * @returns {boolean}
 */
function isSellableProduct(product) {
  if (!product || !product.retailer_id) return false;
  const availability = String(product.availability || '')
    .trim()
    .toLowerCase();
  // Meta uses "in stock" when available; exclude out of stock / discontinued.
  if (availability && availability !== 'in stock') return false;
  return true;
}

/**
 * Fetch catalog products for a WhatsApp product_list message.
 * @param {{catalogId?: string, limit?: number}} [options]
 * @returns {Promise<Array<{retailer_id:string,name?:string,availability?:string}>>}
 */
async function listProductsForProductList(options = {}) {
  const catalogId = options.catalogId || config.whatsapp.catalogId;
  if (!catalogId) {
    const err = new Error('WHATSAPP_CATALOG_ID missing');
    err.code = 'CATALOG_ID_MISSING';
    throw err;
  }

  const limit = Math.min(
    Math.max(1, options.limit || PRODUCT_LIST_MAX),
    PRODUCT_LIST_MAX
  );

  const fields = 'retailer_id,name,availability,image_url';
  // Request a cushion then trim — Graph may return unavailable rows.
  const path = `${catalogId}/products?limit=${limit * 2}`;
  const data = await graphGet(path, fields);
  const rows = Array.isArray(data && data.data) ? data.data : [];

  return rows
    .filter(isSellableProduct)
    .slice(0, limit)
    .map((row) => ({
      retailer_id: String(row.retailer_id),
      name: row.name != null ? String(row.name) : undefined,
      availability: row.availability != null ? String(row.availability) : undefined,
      image_url: row.image_url != null ? String(row.image_url) : undefined,
    }));
}

/**
 * Build Cloud API product_list interactive spec from retailer ids.
 * @param {object} opts
 * @param {string} opts.catalogId
 * @param {Array<{retailer_id:string}|string>} opts.products
 * @param {string} [opts.header]
 * @param {string} [opts.sectionTitle]
 * @param {string} [opts.footer]
 */
function buildProductListInteractive({
  catalogId,
  products,
  header = 'Our cars',
  sectionTitle = 'Available now',
  footer,
} = {}) {
  if (!catalogId) {
    const err = new Error('catalogId required for product_list');
    err.code = 'CATALOG_ID_MISSING';
    throw err;
  }
  const items = (products || [])
    .map((p) => {
      const id =
        typeof p === 'string'
          ? p
          : p && p.retailer_id != null
            ? String(p.retailer_id)
            : '';
      return id ? { product_retailer_id: id } : null;
    })
    .filter(Boolean)
    .slice(0, PRODUCT_LIST_MAX);

  if (!items.length) {
    const err = new Error('product_list requires at least one product');
    err.code = 'CATALOG_EMPTY';
    throw err;
  }

  return {
    type: 'product_list',
    header: String(header).slice(0, 60),
    footer: footer ? String(footer).slice(0, 60) : undefined,
    catalogId: String(catalogId),
    sections: [
      {
        title: String(sectionTitle || 'Available now').slice(0, 24),
        product_items: items,
      },
    ],
  };
}

module.exports = {
  PRODUCT_LIST_MAX,
  isSellableProduct,
  listProductsForProductList,
  buildProductListInteractive,
};
