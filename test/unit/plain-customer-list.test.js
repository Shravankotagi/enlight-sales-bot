const test = require('node:test');
const assert = require('node:assert/strict');
const { isPlainCustomerList } = require('../../src/queryhandler');

test('plain customer list phrases skip the model', () => {
  assert.equal(isPlainCustomerList('my customers'), true);
  assert.equal(isPlainCustomerList('Show all my customers!'), true);
  assert.equal(isPlainCustomerList('my customers in pune'), false);
  assert.equal(isPlainCustomerList('my customer'), false);
});
