/**
 * Regression: a sales price used piece quantity instead of weight in MT.
 * Issue: <add GitHub issue link>
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { priceSalesLine } = require('../../src/core/salesPriceFlow');

const parts = {
  transport_per_mt: 0,
  loading_per_mt: 0,
  credit_per_mt: 0,
  margin_per_mt: 0,
};

test('a per-MT sales rate uses the line weight in MT, not the Nos count', () => {
  const priced = priceSalesLine(
    {
      sku_text: 'CR Sheet',
      dimensions: '1250 x 2500 x 1',
      quantity: 300,
      unit: 'Nos',
      weight_mt: 7.359,
      procurement_base_price_per_mt: 200,
    },
    parts,
    'Ahmedabad, Gujarat',
  );

  assert.equal(priced.rate_per_mt, 200);
  assert.equal(priced.taxable_amount, 1471.8);
  assert.equal(priced.igst_amount, 264.92);
  assert.equal(priced.final_amount, 1736.72);
  assert.equal(priced.quantity, 300);
  assert.equal(priced.unit, 'Nos');
});

test('an MT line still multiplies the rate by its tonnage', () => {
  const priced = priceSalesLine(
    {
      sku_text: 'HR Coil',
      quantity: 2,
      unit: 'MT',
      procurement_base_price_per_mt: 50000,
    },
    parts,
    'Ahmedabad, Gujarat',
  );

  assert.equal(priced.taxable_amount, 100000);
});
