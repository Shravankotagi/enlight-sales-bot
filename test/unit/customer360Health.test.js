const test = require('node:test');
const assert = require('node:assert/strict');
const { customersMatch, dashboardChurnRisk } = require('../../src/core/retrievalTools');

const now = new Date('2026-10-28T00:00:00Z');

test('customer health uses the dashboard 35 to 45 day cadence', () => {
  assert.equal(dashboardChurnRisk({ last_order_date: '2026-09-16' }, [], now), 'at_risk');
  assert.equal(dashboardChurnRisk({ created_at: '2026-09-21' }, [], now), 'at_risk');
  assert.equal(dashboardChurnRisk({ created_at: '2026-10-10' }, [], now), 'active');
  assert.equal(dashboardChurnRisk({ created_at: '2026-08-01' }, [], now), 'churning');
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
