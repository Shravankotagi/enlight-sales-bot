const test = require('node:test');
const assert = require('node:assert/strict');
const { customersMatch, dashboardChurnRisk, resolveCustomerSegment } = require('../../src/core/retrievalTools');

const now = new Date('2026-10-28T00:00:00Z');

test('customer health uses the dashboard 35 to 45 day cadence', () => {
  assert.equal(dashboardChurnRisk({ last_order_date: '2026-09-16' }, [], now), 'at_risk');
  assert.equal(dashboardChurnRisk({ created_at: '2026-09-21' }, [], now), 'at_risk');
  assert.equal(dashboardChurnRisk({ created_at: '2026-10-10' }, [], now), 'active');
  assert.equal(dashboardChurnRisk({ created_at: '2026-08-01' }, [], now), 'churning');
});

test('key accounts use the customer list rule, not a loose label', () => {
  assert.equal(resolveCustomerSegment('Key Account', 0, 0, 0), 'new');
  assert.equal(resolveCustomerSegment('key_account', 0, 0, 0), 'key_account');
  assert.equal(resolveCustomerSegment('', 150, 0, 1), 'key_account');
  assert.equal(resolveCustomerSegment('growth', 150, 0, 1), 'growth');
});

test('a won deal still matches when the name only differs by a legal suffix', () => {
  assert.equal(
    customersMatch({ customer_name: 'Gaar company', customer_phone: '' }, 'Gaar Company Pvt Ltd', ''),
    true,
  );
  assert.equal(
    customersMatch({ customer_name: 'Ankush Traders', customer_phone: '' }, 'Totally Different Mills', ''),
    false,
  );
});
