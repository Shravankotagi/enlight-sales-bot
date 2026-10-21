const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCatalogFlow } = require('./helpers/catalogFlowHarness');

test('customer match score calculation and threshold handling', () => {
  const { calculateCustomerMatchPercentage, buildCustomerMatchValidationMessage } = loadCatalogFlow().catalogFlow;

  // 1. Exact match returns 100%
  assert.equal(calculateCustomerMatchPercentage('PQR Steel Industries', 'PQR Steel Industries'), 100);

  // 2. Minor typo returns > 70% (no validation needed)
  const typoScore = calculateCustomerMatchPercentage('PQR Steel Industriess', 'PQR Steel Industries');
  assert.ok(typoScore >= 70, `Expected typo score >= 70, got ${typoScore}`);

  // 3. Match ignoring corporate suffixes (Pvt Ltd) returns 100%
  assert.equal(calculateCustomerMatchPercentage('PQR Steel Industries', 'PQR Steel Industries Pvt Ltd'), 100);

  // 4. Shorthand entry like "PQR" against "PQR Steel Industries" is < 70%
  const shortScore = calculateCustomerMatchPercentage('PQR', 'PQR Steel Industries');
  assert.ok(shortScore < 70, `Expected short score < 70, got ${shortScore}`);

  // 5. Short prefix "PQR" against "PQR Super Alloys Private Limited" is < 70%
  const shortAlloyScore = calculateCustomerMatchPercentage('PQR', 'PQR Super Alloys Private Limited');
  assert.ok(shortAlloyScore < 70, `Expected short alloy score < 70, got ${shortAlloyScore}`);

  // 6. Validation message builder formats up to 3 candidates cleanly
  const msg3 = buildCustomerMatchValidationMessage('PQR', 'PQR Steel Industries', [
    'PQR Steel Industries',
    'PQR Alloys Ltd',
    'PQR Tubes Pvt Ltd',
  ]);
  assert.ok(msg3.includes('Do you want to continue with the fetched customer name: *PQR Steel Industries*?'));
  assert.ok(msg3.includes('1. *PQR Steel Industries*'));
  assert.ok(msg3.includes('2. *PQR Alloys Ltd*'));
  assert.ok(msg3.includes('3. *PQR Tubes Pvt Ltd*'));
  assert.ok(msg3.includes('reply with *1*, *2*, or *3*'));

  // 7. Validation message builder with only 1 candidate does not show extra numbers
  const msg1 = buildCustomerMatchValidationMessage('PQR', 'PQR Steel Industries', [
    'PQR Steel Industries',
  ]);
  assert.ok(msg1.includes('1. *PQR Steel Industries*'));
  assert.ok(!msg1.includes('2. *'));
  assert.ok(msg1.includes('reply with *1*'));
});
