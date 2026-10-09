const test = require('node:test');
const assert = require('node:assert/strict');

const { buildDuplicateCustomerResponse } = require('./catalogFlow');

test('duplicate customer response only offers discard draft', () => {
  const response = buildDuplicateCustomerResponse(
    '*Customer Already Registered!*\n\nAssigned Representative: Vedant Goel',
  );

  assert.equal(response.handled, true);
  assert.match(response.reply, /Customer Already Registered/);
  assert.doesNotMatch(response.reply, /What would you like to do/i);
  assert.doesNotMatch(response.reply, /different customer name/i);
  assert.doesNotMatch(response.reply, /reply .*cancel/i);
  assert.deepEqual(response.interactiveButtons, [
    { id: 'btn_confirm_cancel', title: 'Discard Draft' },
  ]);
});
