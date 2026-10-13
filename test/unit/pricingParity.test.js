const test = require('node:test');
const assert = require('node:assert/strict');

const pricing = require('../../src/utils/pricingEngine');
const hsn = require('../../src/utils/hsnDetector');
const fixture = require('../fixtures/pricing-parity.json');

test('HSN detection and catalog normalization match the shared parity fixture', () => {
  for (const c of fixture.hsn) {
    assert.equal(hsn.detectHsnCode(c.product) || null, c.hsn, `HSN for "${c.product}"`);
    assert.equal(hsn.normalizeProductToCatalog(c.product).catalogName ?? null, c.catalogName, `catalog name for "${c.product}"`);
  }
});

test('unit normalization matches the shared parity fixture', () => {
  for (const c of fixture.units) {
    assert.equal(pricing.normalizeUnit(c.input), c.unit, `unit "${c.input}"`);
  }
});

test('line item calculation matches the shared parity fixture', () => {
  for (const c of fixture.lineItems) {
    const result = pricing.calculateLineItem(c.input);
    assert.equal(result.quantity, c.quantity);
    assert.equal(result.unit, c.unit);
    assert.equal(result.rate, c.rate);
    assert.equal(result.amount, c.amount);
  }
});

test('pricing summary matches the shared parity fixture', () => {
  const s = pricing.calculatePricingSummary(fixture.pricingSummary.input);
  assert.equal(s.subtotal, fixture.pricingSummary.subtotal);
  assert.equal(s.gstAmount, fixture.pricingSummary.gstAmount);
  assert.equal(s.grandTotal, fixture.pricingSummary.grandTotal);
});

test('quotation breakdown matches the shared parity fixture', () => {
  for (const c of fixture.quotationBreakdown) {
    const r = pricing.calculateQuotationBreakdown(c.baseAmount, c.lineItems || undefined);
    assert.deepEqual(
      { subtotal: r.subtotal, CGST: r.CGST, SGST: r.SGST, rounding: r.rounding, grandTotal: r.grandTotal },
      { subtotal: c.subtotal, CGST: c.CGST, SGST: c.SGST, rounding: c.rounding, grandTotal: c.grandTotal },
      `breakdown for ${c.baseAmount}`,
    );
  }
});

test('GST at the default rate matches the shared parity fixture', () => {
  assert.equal(pricing.calculateGst(fixture.gst.baseAmount), fixture.gst.gst);
  assert.equal(pricing.calculateGrandTotal(fixture.gst.baseAmount), fixture.gst.grandTotal);
});

for (const divergence of fixture.knownDivergences) {
  test(`known parity divergence: ${divergence.id}`, { todo: divergence.summary }, () => {});
}
