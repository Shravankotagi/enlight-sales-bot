/**
 * Regression: Update Inquiry must use the dashboard status precedence and
 * display the new sales pricing components.
 * Issue: <add GitHub issue link>
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  visiblePricingStatus,
  displayStageFor,
  inquiryStatusLabel,
  pricingBreakdownLines,
} = require('../../src/core/inquiryStatus');

test('dashboard pricing statuses override pipeline stage', () => {
  assert.equal(inquiryStatusLabel({
    id: 'a',
    pricing_status: 'awaiting_price',
    stage: 'new_inquiry',
    created_at: '2026-10-20T00:00:00Z',
  }), 'Awaiting Price');
  assert.equal(inquiryStatusLabel({
    id: 'b',
    pricing_status: 'price_ready',
    stage: 'new_inquiry',
  }), 'Price Ready');
  assert.equal(inquiryStatusLabel({
    id: 'c',
    pricing_status: 'unavailable',
    stage: 'new_inquiry',
  }), 'Unavailable');
});

test('historical awaiting price is hidden unless tonnage review is open', () => {
  const inquiry = {
    pricing_status: 'awaiting_price',
    created_at: '2026-10-01T00:00:00Z',
  };
  assert.equal(visiblePricingStatus(inquiry), null);
  assert.equal(visiblePricingStatus({ ...inquiry, tonnage_review_open: true }), 'awaiting_price');
});

test('sales pricing breakdown includes all commercial components', () => {
  const lines = pricingBreakdownLines({
    ai_extraction_json: {
      line_items: [{ sku_text: 'HR Coil', quantity: 2, unit: 'MT' }],
    },
  }, [{
    line_key: '0:HR Coil',
    procurement_base_price_per_mt: 62000,
    sales_base_price_per_mt: 62000,
    transport_per_mt: 1000,
    loading_per_mt: 500,
    credit_per_mt: 0,
    margin_per_mt: 1500,
    rate_per_mt: 65000,
  }]);
  assert.match(lines[0], /Base ₹62,000/);
  assert.match(lines[0], /Transport ₹1,000/);
  assert.match(lines[0], /Loading ₹500/);
  assert.match(lines[0], /Credit ₹0/);
  assert.match(lines[0], /Margin ₹1,500/);
  assert.match(lines[0], /Rate ₹65,000\/MT/);
});

test('display stage normalizes qualified and hold', () => {
  assert.equal(displayStageFor({ stage: 'qualified' }), 'quoted');
  assert.equal(displayStageFor({ stage: 'hold' }), 'on_hold');
});
