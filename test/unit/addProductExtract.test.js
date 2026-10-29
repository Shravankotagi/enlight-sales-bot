const test = require('node:test');
const assert = require('node:assert/strict');
const { mergePartialAddProductInput, restoreStarredDimensions } = require('../../src/core/catalogFlow');

test('add product keeps thickness and size on one spec line', () => {
  const parsed = mergePartialAddProductInput({}, [
    '*Product Name : MS Sheet',
    '*Specifications : 5MM THK, 1250 × 2500 mm',
    '*HSN/SAC Code : 565456',
  ].join('\n'));
  assert.equal(parsed.product_name, 'MS Sheet');
  assert.equal(parsed.dimensions, '5MM THK, 1250 × 2500 mm');
  assert.equal(parsed.hsn_code, '565456');
});

test('add product keeps the full specs line when the label is Specs / Dimensions', () => {
  const parsed = mergePartialAddProductInput({}, [
    '*Product Name : MS Sheet',
    '*Specs / Dimensions : 5MM THK, 1250 × 2500 mm',
    '*HSN/SAC Code : 565456',
  ].join('\n'));
  assert.equal(parsed.product_name, 'MS Sheet');
  assert.match(parsed.dimensions, /5MM THK/i);
  assert.match(parsed.dimensions, /1250/);
  assert.match(parsed.dimensions, /2500/);
  assert.equal(parsed.hsn_code, '565456');
});

test('order lines keep thickness, width, and length separated by stars', () => {
  const text = [
    'sigma industries,PO-1234,today,chakan,pune,30 days',
    'MS pistons - 5*250*3000 100nos,100/MT',
    'MS bush - 6*250*3000 200 nos,500/MT',
  ].join('\n');
  const restored = restoreStarredDimensions(text, [
    { sku_text: 'MS pistons', dimensions: '52503000', spec: '52503000' },
    { sku_text: 'MS bush', dimensions: '6250*3000', spec: '6250*3000' },
  ]);
  assert.equal(restored[0].dimensions, '5*250*3000');
  assert.equal(restored[1].dimensions, '6*250*3000');
  const withX = restoreStarredDimensions('HR Plate - 5x250x3000', [
    { sku_text: 'HR Plate', dimensions: '5x250x3000', spec: '5x250x3000' },
  ]);
  assert.equal(withX[0].dimensions, '5x250x3000');
});
