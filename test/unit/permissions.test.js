const test = require('node:test');
const assert = require('node:assert/strict');

const { mergePermissions, normalizeRoleId } = require('../../src/utils/permissions');
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
