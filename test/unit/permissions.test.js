const test = require('node:test');
const assert = require('node:assert/strict');

const {
  mergePermissions,
  normalizeRoleId,
  can,
  denyView,
  denialReply,
  setMockPermissions,
  invalidateBotPermissions,
  builtinFor,
} = require('../../src/utils/permissions');
const builtin = require('../../src/utils/builtinRoles.json');

test('bot permission merge matches the dashboard rule', () => {
  assert.equal(normalizeRoleId('manager'), 'sales_manager');
  const merged = mergePermissions(builtin.templates.salesperson, {
    'visits.update': true,
    'not.a.key': true,
  });
  assert.equal(merged['visits.update'], true);
  assert.equal(merged['not.a.key'], undefined);
  assert.equal(merged['staff.manage_acl'], false);
});

test('can() and denialReply() enforce permission gating for all modules', async () => {
  const testPhone = '9990001111';

  // 1. When permitted as standard salesperson
  setMockPermissions(testPhone, builtinFor('salesperson'));
  assert.equal(await can(testPhone, 'inquiries.manage'), true);
  assert.equal(await can(testPhone, 'orders.create'), true);
  assert.equal(await can(testPhone, 'visits.log'), true);
  assert.equal(await can(testPhone, 'complaints.log'), true);
  assert.equal(await can(testPhone, 'customers.create'), true);
  assert.equal(await can(testPhone, 'inquiries.fill_base_prices'), false);

  assert.equal(await denialReply(testPhone, 'LOG_INQUIRY'), null);
  assert.equal(await denialReply(testPhone, 'LOG_ORDER'), null);
  assert.equal(await denialReply(testPhone, 'LOG_VISIT'), null);
  assert.equal(await denialReply(testPhone, 'LOG_COMPLAINT'), null);
  assert.equal(await denialReply(testPhone, 'LOG_NEW_CUSTOMER'), null);
  assert.equal(await denialReply(testPhone, 'ADD_PRICE'), null);

  // 2. When permissions are revoked by admin (override inquiries.manage = false)
  const restricted = builtinFor('salesperson', {
    'inquiries.manage': false,
    'inquiries.edit': false,
    'inquiries.send_quote': false,
    'orders.create': false,
    'visits.log': false,
  });
  setMockPermissions(testPhone, restricted);

  assert.equal(await can(testPhone, 'inquiries.manage'), false);
  assert.equal(await can(testPhone, 'orders.create'), false);
  assert.equal(await can(testPhone, 'visits.log'), false);

  assert.match(
    await denialReply(testPhone, 'LOG_INQUIRY'),
    /do not have permission to log inquiries/i,
  );
  assert.match(
    await denialReply(testPhone, 'LOG_ORDER'),
    /do not have permission to log orders/i,
  );
  assert.match(
    await denialReply(testPhone, 'LOG_VISIT'),
    /do not have permission to log visits/i,
  );
  assert.match(
    await denialReply(testPhone, 'ADD_PRICE'),
    /do not have permission to add inquiry prices/i,
  );

  // 3. A disabled view permission is a denial, not missing data
  const noCustomers = builtinFor('salesperson', { 'customers.view': false });
  setMockPermissions(testPhone, noCustomers);
  assert.match(
    await denyView(testPhone, 'customers.view'),
    /customers view is disabled/i,
  );
  assert.equal(await denyView(testPhone, 'orders.view'), null);

  // 4. Invalidate cache flushes correctly
  invalidateBotPermissions(testPhone);
});
