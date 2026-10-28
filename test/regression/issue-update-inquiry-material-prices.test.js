/**
 * Regression: Update Inquiry listed one rate, or no price, for materials that
 * live only on the deal, and a later price change wrote deal_items.rate while
 * leaving Base, Transport, Loading, Credit, and Margin untouched. Sales-priced
 * and Price Quote rows were also refused. Won and Lost stay read-only.
 * Issue: <add GitHub issue link>
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCatalogFlow } = require('../helpers/catalogFlowHarness');
const { setMockPermissions, builtinFor, invalidateBotPermissions } = require('../../src/utils/permissions');

const SENDER = '919811111111';
const QUOTE_ID = 'quote111-1111-4111-8111-111111111111';
const WON_ID = 'won11111-1111-4111-8111-111111111111';
const LOST_ID = 'lost1111-1111-4111-8111-111111111111';
const HR_ID = 'hr-item-0001';
const PLATE_ID = 'plate-item-0001';

const hrPrice = {
  inquiry_id: QUOTE_ID,
  line_key: HR_ID,
  sku_text: 'HR Coil',
  procurement_base_price_per_mt: 62000,
  sales_base_price_per_mt: null,
  transport_per_mt: 1000,
  loading_per_mt: 500,
  credit_per_mt: 0,
  margin_per_mt: 1500,
  rate_per_mt: 65000,
  line_status: 'priced',
};

const platePrice = {
  inquiry_id: QUOTE_ID,
  line_key: PLATE_ID,
  sku_text: 'Plate',
  procurement_base_price_per_mt: 70000,
  sales_base_price_per_mt: null,
  transport_per_mt: 800,
  loading_per_mt: 200,
  credit_per_mt: null,
  margin_per_mt: 1000,
  rate_per_mt: 72000,
  line_status: 'priced',
};

function inquiry(id, status) {
  return {
    id,
    sender_name: 'Dash Mills',
    sender_phone: SENDER,
    salesperson_phone: SENDER,
    status,
    pricing_status: 'sales_priced',
    inquiry_type: 'inquiry',
    delivery_address: 'Pune',
    created_at: '2026-10-27T04:00:00.000Z',
    ai_extraction_json: { customer_name: 'Dash Mills', line_items: [] },
  };
}

function deal(id, stage) {
  return {
    id,
    inquiry_id: id,
    customer_name: 'Dash Mills',
    stage,
    salesperson_phone: SENDER,
    payment_terms: '30 days',
    delivery_location: 'Pune',
    total_amount: 0,
    created_at: '2026-10-27T04:00:00.000Z',
  };
}

function items(inquiryId) {
  return [
    { id: HR_ID, deal_id: inquiryId, sku_text: 'HR Coil', quantity: 10, unit: 'MT', rate: 65000, amount: 650000 },
    { id: PLATE_ID, deal_id: inquiryId, sku_text: 'Plate', quantity: 4, unit: 'MT', rate: 72000, amount: 288000 },
  ];
}

function prices(inquiryId) {
  return [
    { ...hrPrice, inquiry_id: inquiryId },
    { ...platePrice, inquiry_id: inquiryId },
  ];
}

function load() {
  return loadCatalogFlow({
    tables: {
      employees: [],
      recurring_customers: [],
      inquiries: [
        inquiry(QUOTE_ID, 'quoted'),
        inquiry(WON_ID, 'won'),
        inquiry(LOST_ID, 'lost'),
      ],
      deals: [
        deal(QUOTE_ID, 'quoted'),
        deal(WON_ID, 'won'),
        deal(LOST_ID, 'lost'),
      ],
      deal_items: [...items(QUOTE_ID), ...items(WON_ID), ...items(LOST_ID)],
      inquiry_line_pricing: [...prices(QUOTE_ID), ...prices(WON_ID), ...prices(LOST_ID)],
    },
    scope: { isAdmin: false, isManager: false, phones: ['9811111111'] },
    llm: () => '{"action":"UPDATE_INQUIRY","updates":{}}',
  });
}

test('every deal material shows base, transport, loading, credit, margin, and rate', async () => {
  const h = load();
  try {
    const quote = h.catalogFlow.formatSelectedInquiryPrompt({
      displayId: 'INQ-QUOTE1',
      customer_name: 'Dash Mills',
      stage: 'Price Quote',
      deal_items: items(QUOTE_ID),
      line_pricing: prices(QUOTE_ID),
    }, '');
    assert.match(quote, /HR Coil 10 MT — Base ₹62,000 \+ Transport ₹1,000 \+ Loading ₹500 \+ Credit ₹0 \+ Margin ₹1,500 = Rate ₹65,000\/MT/);
    assert.match(quote, /Plate 4 MT — Base ₹70,000 \+ Transport ₹800 \+ Loading ₹200 \+ Credit ₹0 \+ Margin ₹1,000 = Rate ₹72,000\/MT/);
    assert.match(quote, /base, transport, loading, credit, or margin/i);

    const won = h.catalogFlow.formatSelectedInquiryPrompt({
      displayId: 'INQ-WON111',
      customer_name: 'Dash Mills',
      stage: 'Won',
      deal_items: items(WON_ID),
      line_pricing: prices(WON_ID),
    }, '');
    assert.match(won, /HR Coil 10 MT — Base ₹62,000/);
    assert.match(won, /dashboard/i);
  } finally {
    h.restore();
  }
});

test('a Price Quote inquiry saves a transport change and keeps the procurement base', async () => {
  const h = load();
  setMockPermissions(SENDER, builtinFor('salesperson'));
  try {
    const reply = await h.catalogFlow.executeAction('UPDATE_INQUIRY', {
      inquiry_id: QUOTE_ID,
      line_item_updates: [{ sku_text: 'HR Coil', transport: 2000 }],
    }, SENDER);
    assert.doesNotMatch(String(reply), /read-only|Price this inquiry|already sales priced/i);
    assert.match(String(reply), /HR Coil 10 MT — Base ₹62,000 \+ Transport ₹2,000 \+ Loading ₹500 \+ Credit ₹0 \+ Margin ₹1,500 = Rate ₹66,000\/MT/);
    const saved = h.db.store.inquiry_line_pricing.filter((row) => row.inquiry_id === QUOTE_ID && row.line_key === HR_ID);
    const written = saved[saved.length - 1];
    assert.equal(written.procurement_base_price_per_mt, 62000);
    assert.equal(written.sales_base_price_per_mt ?? null, null);
    assert.equal(written.transport_per_mt, 2000);
    assert.equal(written.rate_per_mt, 66000);
    const inquiryRow = h.db.store.inquiries.find((row) => row.id === QUOTE_ID);
    assert.equal(inquiryRow.pricing_status, 'sales_priced');
    const dealItem = h.db.store.deal_items.find((row) => row.id === HR_ID && row.deal_id === QUOTE_ID);
    assert.equal(Number(dealItem.rate), 66000);
  } finally {
    h.restore();
    invalidateBotPermissions();
  }
});

test('Won and Lost inquiries still refuse a price change', async () => {
  const h = load();
  setMockPermissions(SENDER, builtinFor('salesperson'));
  try {
    for (const id of [WON_ID, LOST_ID]) {
      const before = h.db.store.inquiry_line_pricing.filter((row) => row.inquiry_id === id).length;
      const reply = await h.catalogFlow.executeAction('UPDATE_INQUIRY', {
        inquiry_id: id,
        line_item_updates: [{ sku_text: 'HR Coil', transport: 2000 }],
      }, SENDER);
      assert.match(String(reply), /read-only/i);
      const after = h.db.store.inquiry_line_pricing.filter((row) => row.inquiry_id === id);
      assert.equal(after.length, before);
      assert.equal(after.find((row) => row.line_key === HR_ID).transport_per_mt, 1000);
    }
  } finally {
    h.restore();
    invalidateBotPermissions();
  }
});

test('a rate below the other components asks which component to change', async () => {
  const h = load();
  setMockPermissions(SENDER, builtinFor('salesperson'));
  try {
    const reply = await h.catalogFlow.executeAction('UPDATE_INQUIRY', {
      inquiry_id: QUOTE_ID,
      line_item_updates: [{ sku_text: 'HR Coil', rate: 1000 }],
    }, SENDER);
    assert.match(String(reply), /which component/i);
    const saved = h.db.store.inquiry_line_pricing.filter((row) => row.inquiry_id === QUOTE_ID && row.line_key === HR_ID);
    assert.ok(saved.every((row) => Number(row.margin_per_mt) >= 0));
    assert.ok(saved.every((row) => Number(row.rate_per_mt) !== 1000));
    const dealItem = h.db.store.deal_items.find((row) => row.id === HR_ID && row.deal_id === QUOTE_ID);
    assert.equal(Number(dealItem.rate), 65000);
  } finally {
    h.restore();
    invalidateBotPermissions();
  }
});
