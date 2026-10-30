/**
 * Regression: Update Inquiry copied the existing pricing row's id and replaced
 * its line key with the deal item id, so Postgres rejected the save on
 * inquiry_line_pricing_pkey. The confirmation also hid the new components.
 * Issue: <add GitHub issue link>
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCatalogFlow } = require('../helpers/catalogFlowHarness');
const { setMockPermissions, builtinFor, invalidateBotPermissions } = require('../../src/utils/permissions');

const SENDER = '919811111111';
const INQUIRY_ID = 'plate6b-f9a5-4111-8111-111111111111';
const ITEM_ID = 'plate-item';
const PRICE_ID = 'price-row-1';

const savedPrice = {
  id: PRICE_ID,
  inquiry_id: INQUIRY_ID,
  line_key: '0:HR PLATE',
  sku_text: 'HR PLATE',
  procurement_base_price_per_mt: 10000,
  sales_base_price_per_mt: null,
  transport_per_mt: 0,
  loading_per_mt: 0,
  credit_per_mt: 0,
  margin_per_mt: 0,
  rate_per_mt: 10000,
  line_status: 'priced',
  created_at: '2026-10-27T04:00:00.000Z',
};

const plate = {
  id: ITEM_ID,
  deal_id: INQUIRY_ID,
  sku_text: 'HR PLATE',
  dimensions: '05X1500X6300MM',
  quantity: 40,
  unit: 'MT',
  rate: 10000,
  amount: 400000,
};

const priceUpdate = {
  sku_text: 'HR PLATE',
  dimensions: '05X1500X6300MM',
  transport: 200,
  loading: 200,
  credit: 0,
  margin: 200,
};

function load() {
  return loadCatalogFlow({
    tables: {
      employees: [],
      recurring_customers: [],
      inquiries: [{
        id: INQUIRY_ID,
        sender_name: 'Om Fabricators',
        sender_phone: SENDER,
        salesperson_phone: SENDER,
        status: 'review',
        pricing_status: 'price_ready',
        inquiry_type: 'inquiry',
        delivery_address: 'Pune',
        created_at: '2026-10-27T04:00:00.000Z',
        ai_extraction_json: {
          customer_name: 'Om Fabricators',
          delivery_location: 'Pune',
          line_items: [{
            sku_text: 'HR PLATE',
            dimensions: '05X1500X6300MM',
            quantity: 40,
            unit: 'MT',
          }],
        },
      }],
      deals: [{
        id: INQUIRY_ID,
        inquiry_id: INQUIRY_ID,
        customer_name: 'Om Fabricators',
        salesperson_phone: SENDER,
        stage: 'new_inquiry',
        payment_terms: '30 days',
        delivery_location: 'Pune',
        total_amount: 400000,
        created_at: '2026-10-27T04:00:00.000Z',
      }],
      deal_items: [plate],
      inquiry_line_pricing: [savedPrice],
    },
    scope: { isAdmin: false, isManager: false, phones: ['9811111111'] },
    llm: () => '{"action":"UPDATE_INQUIRY","updates":{}}',
  });
}

test('the save card shows the resulting price before the row is updated in place', async () => {
  const h = load();
  setMockPermissions(SENDER, builtinFor('salesperson'));
  try {
    const summary = h.catalogFlow.buildConfirmationSummary('UPDATE_INQUIRY', {
      inquiry_id: INQUIRY_ID,
      company_name: 'Om Fabricators',
      _inquiry_display_id: 'INQ-6BF9A5',
      delivery_location: 'Pune',
      existing_items: [plate],
      line_pricing: [savedPrice],
      line_item_updates: [priceUpdate],
    });
    assert.match(summary, /Base ₹10,000 \+ Transport ₹200 \+ Loading ₹200 \+ Credit ₹0 \+ Margin ₹200 = Rate ₹10,600\/MT/);

    const reply = await h.catalogFlow.executeAction('UPDATE_INQUIRY', {
      inquiry_id: INQUIRY_ID,
      company_name: 'Om Fabricators',
      delivery_location: 'Pune',
      line_item_updates: [priceUpdate],
    }, SENDER);
    assert.doesNotMatch(String(reply), /inquiry_line_pricing_pkey|duplicate key/i);
    assert.match(String(reply), /Transport ₹200 \+ Loading ₹200 \+ Credit ₹0 \+ Margin ₹200 = Rate ₹10,600\/MT/);
    const upsert = h.db.calls.find((call) => call.table === 'inquiry_line_pricing' && call.op === 'upsert');
    const row = [].concat(upsert.payload)[0];
    assert.equal(Object.prototype.hasOwnProperty.call(row, 'id'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(row, 'created_at'), false);
    assert.equal(row.line_key, '0:HR PLATE');
    assert.equal(row.procurement_base_price_per_mt, 10000);
    assert.equal(row.transport_per_mt, 200);
    assert.equal(row.loading_per_mt, 200);
    assert.equal(row.credit_per_mt, 0);
    assert.equal(row.margin_per_mt, 200);
    assert.equal(row.rate_per_mt, 10600);
  } finally {
    h.restore();
    invalidateBotPermissions();
  }
});
