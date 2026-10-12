const test = require('node:test');
const assert = require('node:assert/strict');

const pricing = require('../../src/utils/pricingEngine');

test('default GST rate is 18%', () => {
  assert.equal(pricing.DEFAULT_GST_RATE, 0.18);
});

test('convertToMt converts kilograms and quintals and rejects pieces', () => {
  assert.equal(pricing.convertToMt(500, 'kg'), 0.5);
  assert.equal(pricing.convertToMt(2, 'MT'), 2);
  assert.equal(pricing.convertToMt(3, 'quintal'), 3);
  assert.equal(pricing.convertToMt(5, 'nos'), null);
});

test('calculateLineItem splits GST equally into CGST and SGST', () => {
  const r = pricing.calculateLineItem({ product: 'HR Coil', quantity: 10, unit: 'MT', rate: 55000 });
  assert.equal(r.amount, 550000);
  assert.equal(r.cgst_rate, 9);
  assert.equal(r.sgst_rate, 9);
  assert.equal(r.cgst_amount, 49500);
  assert.equal(r.sgst_amount, 49500);
  assert.equal(r.total_gst, 99000);
  assert.equal(r.final_amount, 649000);
});

test('calculateLineItem treats rate as Rs/MT on a KG line', () => {
  const r = pricing.calculateLineItem({ product: 'MS Angle', quantity: 500, unit: 'kg', rate: 60 });
  assert.equal(r.quantity, 0.5);
  assert.equal(r.unit, 'MT');
  assert.equal(r.rate, 60);
  assert.equal(r.amount, 30);
  assert.equal(r.original_quantity, 500);
  assert.equal(r.original_unit, 'KG');
});

test('calculateLineItem tolerates a missing item', () => {
  const r = pricing.calculateLineItem(null);
  assert.equal(r.amount, 0);
  assert.equal(r.final_amount, 0);
});

test('calculateTotalTonnageMt sums MT and KG lines', () => {
  const r = pricing.calculateTotalTonnageMt([
    { quantity: 10, unit: 'MT' },
    { quantity: 500, unit: 'kg' },
  ]);
  assert.equal(r.totalMt, 10.5);
  assert.equal(r.hasUnconvertible, false);
});

test('formatIndianCurrency uses Indian digit grouping', () => {
  assert.equal(pricing.formatIndianCurrency(1234567.5), '12,34,567');
  assert.equal(pricing.formatMoneyValue(1234567.5), '12,34,567.50');
});
