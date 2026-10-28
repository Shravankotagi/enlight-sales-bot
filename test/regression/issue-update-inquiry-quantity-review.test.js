/**
 * Regression: Update Inquiry stores the open card badge on the draft. Price
 * Ready contains the word "price", so a quantity save was treated as a move
 * to Quoted and refused before the weight or the procurement review was written.
 * Issue: <add GitHub issue link>
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCatalogFlow } = require('../helpers/catalogFlowHarness');
const { setMockPermissions, builtinFor, invalidateBotPermissions } = require('../../src/utils/permissions');

const SENDER = '919811111111';
const INQUIRY_ID = 'plate40-1111-4111-8111-111111111111';

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
        raw_text: 'HR PLATE 40 MT',
        payment_terms: '30 days',
        created_at: '2026-10-27T04:00:00.000Z',
        ai_extraction_json: {
          customer_name: 'Om Fabricators',
          delivery_location: 'Pune',
          payment_terms: '30 days',
          line_items: [{
            sku_text: 'HR PLATE',
            dimensions: '05X1500X6300MM',
            quantity: 40,
            unit: 'MT',
            original_quantity: 40,
            original_unit: 'MT',
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
      deal_items: [{
        id: 'plate-item',
        deal_id: INQUIRY_ID,
        sku_text: 'HR PLATE',
        dimensions: '05X1500X6300MM',
        quantity: 40,
        unit: 'MT',
        rate: 10000,
        amount: 400000,
      }],
    },
    scope: { isAdmin: false, isManager: false, phones: ['9811111111'] },
    llm: () => '{"action":"UPDATE_INQUIRY","updates":{}}',
  });
}

test('a Price Ready card badge does not block a quantity change or the procurement review', async () => {
  const h = load();
  setMockPermissions(SENDER, builtinFor('salesperson'));
  try {
    const reply = await h.catalogFlow.executeAction('UPDATE_INQUIRY', {
      inquiry_id: INQUIRY_ID,
      company_name: 'Om Fabricators',
      stage: 'Price Ready',
      line_item_updates: [{ sku_text: 'HR PLATE', quantity: 50, unit: 'MT' }],
    }, SENDER);
    assert.doesNotMatch(String(reply), /base price is ready|Price this inquiry/i);
    const inquiry = h.db.store.inquiries.find((row) => row.id === INQUIRY_ID);
    const deal = h.db.store.deals.find((row) => row.id === INQUIRY_ID);
    const item = h.db.store.deal_items.find((row) => row.id === 'plate-item');
    assert.equal(Number(item.quantity), 50);
    assert.equal(inquiry.ai_extraction_json.line_items[0].quantity, 50);
    assert.equal(inquiry.pricing_status, 'awaiting_price');
    assert.equal(inquiry.tonnage_review_open, true);
    assert.equal(deal.stage, 'new_inquiry');
  } finally {
    h.restore();
    invalidateBotPermissions();
  }
});
