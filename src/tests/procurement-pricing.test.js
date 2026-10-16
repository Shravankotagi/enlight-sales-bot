const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  nextProcurementNumberFromRows,
  procurementOwnerFromEmployees,
} = require('../supabase');

test('new bot inquiries start awaiting a price and procurement reaches the assistant', () => {
  const supabase = fs.readFileSync(path.join(__dirname, '../supabase.js'), 'utf8');
  const webhook = fs.readFileSync(path.join(__dirname, '../webhook.js'), 'utf8');
  const webChat = fs.readFileSync(path.join(__dirname, '../api/webChat.js'), 'utf8');
  assert.match(supabase, /pricing_status:\s*'awaiting_price'/);
  assert.match(supabase, /procurement_number/);
  assert.match(supabase, /assigned_procurement_employee_id/);
  assert.match(webhook, /handleProcurementChat/);
  assert.doesNotMatch(webhook, /not enabled yet/);
  assert.match(webChat, /handleProcurementChat/);
  assert.doesNotMatch(webChat, /procurementBlocked/);
});

test('bot procurement number is independent of the inquiry id and follows the salesperson route', () => {
  assert.equal(nextProcurementNumberFromRows([]), 'PR-10001');
  assert.equal(
    nextProcurementNumberFromRows([{ procurement_number: 'PR-10007' }]),
    'PR-10008',
  );
  assert.equal(
    procurementOwnerFromEmployees(
      [
        {
          role: 'salesperson',
          phone: '919811111111',
          is_active: true,
          assigned_procurement_employee_id: 'proc-1',
        },
      ],
      '9811111111',
    ),
    'proc-1',
  );
});
