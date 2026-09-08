'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const config = require('../src/config');
const { cloudApiSendMessage } = require('../src/transport/whatsapp');
const { extractInboundMessage } = require('../src/routes/webhook');
const {
  isSellableProduct,
  buildProductListInteractive,
  listProductsForProductList,
} = require('../src/catalog/products');
const { FsmEngine } = require('../src/engine/fsmEngine');
const { FileSessionStore } = require('../src/session/store');
const { createLeadLogger } = require('../src/logger/leadLogger');

function restoreWhatsapp(snap) {
  Object.assign(config.whatsapp, snap);
}

async function withFakeFetch(run) {
  const snap = { ...config.whatsapp };
  config.whatsapp.token = 'test-token';
  config.whatsapp.phoneNumberId = '123456';
  config.whatsapp.catalogId = '1067415159340072';
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    const entry = { url: String(url), options };
    if (options && options.body) {
      entry.body = JSON.parse(options.body);
    }
    calls.push(entry);
    return {
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: 'wamid.test' }] }),
    };
  };
  try {
    await run(calls);
  } finally {
    global.fetch = originalFetch;
    restoreWhatsapp(snap);
  }
}

async function testProductListGraphBody() {
  await withFakeFetch(async (calls) => {
    await cloudApiSendMessage('27821234567', {
      text: 'Here is our current stock.',
      interactive: {
        type: 'product_list',
        header: 'Our cars',
        catalogId: '1067415159340072',
        sections: [
          {
            title: 'Available now',
            product_items: [
              { product_retailer_id: 'polo-2022' },
              { product_retailer_id: 'tiguan-2021' },
            ],
          },
        ],
      },
    });
    const body = calls[0].body;
    assert.strictEqual(body.type, 'interactive');
    assert.strictEqual(body.interactive.type, 'product_list');
    assert.strictEqual(body.interactive.header.type, 'text');
    assert.strictEqual(body.interactive.header.text, 'Our cars');
    assert.strictEqual(body.interactive.body.text, 'Here is our current stock.');
    assert.strictEqual(body.interactive.action.catalog_id, '1067415159340072');
    assert.strictEqual(
      body.interactive.action.sections[0].product_items[0].product_retailer_id,
      'polo-2022'
    );
    // eslint-disable-next-line no-console
    console.log('✓ product_list Graph body');
  });
}

function testBuildProductListInteractive() {
  const interactive = buildProductListInteractive({
    catalogId: '1067415159340072',
    products: [{ retailer_id: 'a' }, { retailer_id: 'b' }],
    header: 'Our cars',
  });
  assert.strictEqual(interactive.type, 'product_list');
  assert.strictEqual(interactive.sections[0].product_items.length, 2);
  assert.ok(isSellableProduct({ retailer_id: 'x', availability: 'in stock' }));
  assert.ok(!isSellableProduct({ retailer_id: 'x', availability: 'out of stock' }));
  // eslint-disable-next-line no-console
  console.log('✓ catalog helpers filter + build product_list');
}

function testExtractProductInquiry() {
  const inbound = extractInboundMessage({
    from: '27821111111',
    type: 'text',
    text: { body: 'Interested in this one' },
    context: {
      referred_product: {
        catalog_id: '1067415159340072',
        product_retailer_id: 'polo-2022',
      },
    },
  });
  assert.strictEqual(inbound.productRetailerId, 'polo-2022');
  assert.strictEqual(inbound.catalogId, '1067415159340072');
  assert.strictEqual(inbound.text, 'Interested in this one');
  // eslint-disable-next-line no-console
  console.log('✓ webhook extracts referred_product inquiry');
}

function testExtractOrder() {
  const inbound = extractInboundMessage({
    from: '27821111111',
    type: 'order',
    order: {
      catalog_id: '1067415159340072',
      text: 'Please hold',
      product_items: [{ product_retailer_id: 'tiguan-2021', quantity: 1 }],
    },
  });
  assert.strictEqual(inbound.productRetailerId, 'tiguan-2021');
  assert.strictEqual(inbound.catalogId, '1067415159340072');
  // eslint-disable-next-line no-console
  console.log('✓ webhook extracts order product selection');
}

async function testListProductsForProductList() {
  const snap = { ...config.whatsapp };
  config.whatsapp.token = 'test-token';
  config.whatsapp.phoneNumberId = '123456';
  config.whatsapp.catalogId = '1067415159340072';
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      data: [
        { retailer_id: 'in-1', name: 'Polo', availability: 'in stock' },
        { retailer_id: 'out-1', name: 'Sold', availability: 'out of stock' },
        { retailer_id: 'in-2', name: 'Tiguan', availability: 'in stock' },
      ],
    }),
  });
  try {
    const products = await listProductsForProductList();
    assert.strictEqual(products.length, 2);
    assert.strictEqual(products[0].retailer_id, 'in-1');
    assert.strictEqual(products[1].retailer_id, 'in-2');
    // eslint-disable-next-line no-console
    console.log('✓ listProductsForProductList skips out-of-stock');
  } finally {
    global.fetch = originalFetch;
    restoreWhatsapp(snap);
  }
}

async function testSeeCarsSendsProductListAndSelectionAdvances() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-catalog-'));
  const snap = { ...config.whatsapp };
  config.whatsapp.token = 'test-token';
  config.whatsapp.phoneNumberId = '123456';
  config.whatsapp.catalogId = '1067415159340072';

  const sent = [];
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/products')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            { retailer_id: 'polo-2022', name: 'Polo', availability: 'in stock' },
            {
              retailer_id: 'tiguan-2021',
              name: 'Tiguan',
              availability: 'in stock',
            },
          ],
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: 'wamid.test' }] }),
    };
  };

  try {
    const store = new FileSessionStore(dir);
    const engine = new FsmEngine({
      sessionStore: store,
      leadLogger: createLeadLogger('console'),
      sendMessage: async (to, payload) => {
        sent.push({ to, payload });
        return { messages: [{ id: `wamid.${sent.length}` }] };
      },
    });

    await engine.handleInbound('27829990001', 'hi');
    await engine.handleInbound('27829990001', 'See our cars', {
      replyId: 'see_cars',
    });

    const stockSend = sent.find(
      (s) =>
        s.payload &&
        s.payload.interactive &&
        s.payload.interactive.type === 'product_list'
    );
    assert.ok(stockSend, 'expected product_list after See our cars');
    assert.strictEqual(
      stockSend.payload.interactive.catalogId,
      '1067415159340072'
    );
    assert.strictEqual(
      stockSend.payload.interactive.sections[0].product_items.length,
      2
    );

    await engine.handleInbound('27829990001', 'Interested', {
      productRetailerId: 'polo-2022',
      catalogId: '1067415159340072',
    });

    const session = await store.get('27829990001');
    assert.strictEqual(session.currentState, 'EMPLOYED_INCOME_CHECK');
    assert.strictEqual(session.selectedProductRetailerId, 'polo-2022');
    assert.strictEqual(session.selectedCatalogId, '1067415159340072');
    // eslint-disable-next-line no-console
    console.log('✓ See our cars → product_list → product pick → qualify');
  } finally {
    global.fetch = originalFetch;
    restoreWhatsapp(snap);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testCatalogMessageFallbackWhenProductReadDenied() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-catalog-msg-'));
  const snap = { ...config.whatsapp };
  config.whatsapp.token = 'test-token';
  config.whatsapp.phoneNumberId = '123456';
  config.whatsapp.catalogId = '1067415159340072';

  const sent = [];
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('/products')) {
      return {
        ok: false,
        status: 400,
        json: async () => ({
          error: {
            message:
              '(#100) This application has not been approved to use this api.',
            code: 100,
          },
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: 'wamid.test' }] }),
    };
  };

  try {
    const store = new FileSessionStore(dir);
    const engine = new FsmEngine({
      sessionStore: store,
      leadLogger: createLeadLogger('console'),
      sendMessage: async (to, payload) => {
        sent.push({ to, payload });
        return { messages: [{ id: `wamid.${sent.length}` }] };
      },
    });

    await engine.handleInbound('27829990003', 'hi');
    await engine.handleInbound('27829990003', 'see_cars', {
      replyId: 'see_cars',
    });

    const stockSend = sent[sent.length - 1];
    assert.ok(stockSend.payload.interactive);
    assert.strictEqual(stockSend.payload.interactive.type, 'catalog_message');
    assert.strictEqual(
      stockSend.payload.meta.catalogMode,
      'catalog_message'
    );
    // eslint-disable-next-line no-console
    console.log('✓ catalog read denied → catalog_message View catalog');
  } finally {
    global.fetch = originalFetch;
    restoreWhatsapp(snap);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testCatalogMessageGraphBody() {
  await withFakeFetch(async (calls) => {
    await cloudApiSendMessage('27821234567', {
      text: 'Here is our current stock.',
      interactive: { type: 'catalog_message' },
    });
    const body = calls[0].body;
    assert.strictEqual(body.type, 'interactive');
    assert.strictEqual(body.interactive.type, 'catalog_message');
    assert.strictEqual(body.interactive.action.name, 'catalog_message');
    assert.strictEqual(body.interactive.body.text, 'Here is our current stock.');
    // eslint-disable-next-line no-console
    console.log('✓ catalog_message Graph body');
  });
}

async function testEmptyCatalogUsesCatalogMessage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-catalog-empty-'));
  const snap = { ...config.whatsapp };
  const linksSnap = { ...config.links };
  config.whatsapp.token = 'test-token';
  config.whatsapp.phoneNumberId = '123456';
  config.whatsapp.catalogId = '1067415159340072';
  config.links.stockLink = 'https://example.com/stock';

  const sent = [];
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('/products')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: 'wamid.test' }] }),
    };
  };

  try {
    const store = new FileSessionStore(dir);
    const engine = new FsmEngine({
      sessionStore: store,
      leadLogger: createLeadLogger('console'),
      sendMessage: async (to, payload) => {
        sent.push({ to, payload });
        return { messages: [{ id: `wamid.${sent.length}` }] };
      },
    });

    await engine.handleInbound('27829990002', 'hi');
    await engine.handleInbound('27829990002', 'see_cars', {
      replyId: 'see_cars',
    });

    const stockSend = sent[sent.length - 1];
    assert.ok(stockSend.payload.interactive);
    assert.strictEqual(stockSend.payload.interactive.type, 'catalog_message');
    // eslint-disable-next-line no-console
    console.log('✓ empty product read still sends catalog_message');
  } finally {
    global.fetch = originalFetch;
    restoreWhatsapp(snap);
    Object.assign(config.links, linksSnap);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  await testProductListGraphBody();
  await testCatalogMessageGraphBody();
  testBuildProductListInteractive();
  testExtractProductInquiry();
  testExtractOrder();
  await testListProductsForProductList();
  await testSeeCarsSendsProductListAndSelectionAdvances();
  await testCatalogMessageFallbackWhenProductReadDenied();
  await testEmptyCatalogUsesCatalogMessage();
  // eslint-disable-next-line no-console
  console.log('\ncatalog product list tests passed.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
