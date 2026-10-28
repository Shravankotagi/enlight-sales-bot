const test = require('node:test');
const assert = require('node:assert/strict');
const { mergePartialAddProductInput } = require('../../src/core/catalogFlow');

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
