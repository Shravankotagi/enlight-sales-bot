/**
 * Update Order was listing another salesperson's won deals when a shorter
 * customer name fuzzy-matched, and hiding the caller's own won deal when that
 * customer was assigned to someone else.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCatalogFlow } = require('../helpers/catalogFlowHarness');

const SENDER = '919811111111';
const OTHER = '919822222222';

test('update order lists the caller won deals and skips fuzzy and open deals', async () => {
  const h = loadCatalogFlow({
    scope: { isAdmin: false, phones: [SENDER] },
    tables: {
      deals: [
        {
          id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          customer_name: 'Apex Steel',
          salesperson_phone: SENDER,
          stage: 'won',
          po_number: 'PO-OWN',
          won_at: '2026-10-20T00:00:00.000Z',
          created_at: '2026-10-20T00:00:00.000Z',
          deal_items: [{ sku_text: 'HR Coil', quantity: 10, unit: 'MT' }],
        },
        {
          id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
          customer_name: 'Apex Steel Structures',
          salesperson_phone: OTHER,
          stage: 'won',
          po_number: 'PO-OTHER',
          won_at: '2026-10-21T00:00:00.000Z',
          created_at: '2026-10-21T00:00:00.000Z',
          deal_items: [{ sku_text: 'MS Beam', quantity: 5, unit: 'MT' }],
        },
        {
          id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
          customer_name: 'Quoted Mills',
          salesperson_phone: SENDER,
          stage: 'quoted',
          po_number: 'PO-QUOTE',
          created_at: '2026-10-22T00:00:00.000Z',
          deal_items: [],
        },
        {
          id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
          customer_name: 'Owned Mills',
          salesperson_phone: OTHER,
          stage: 'won',
          po_number: 'PO-ASSIGNED',
          won_at: '2026-10-19T00:00:00.000Z',
          created_at: '2026-10-19T00:00:00.000Z',
          deal_items: [{ sku_text: 'Plate', quantity: 2, unit: 'MT' }],
        },
      ],
      recurring_customers: [
        { customer_name: 'Apex Steel', assigned_salesperson_phone: OTHER, is_active: true },
        { customer_name: 'Apex', assigned_salesperson_phone: SENDER, is_active: true },
        { customer_name: 'Owned Mills', assigned_salesperson_phone: SENDER, is_active: true },
      ],
    },
  });

  const records = await h.catalogFlow.fetchEditableRecordsForModule('UPDATE_ORDER', SENDER);
  const numbers = records.map((row) => row.po_number).sort();
  assert.deepEqual(numbers, ['PO-ASSIGNED', 'PO-OWN']);
  h.restore();
});
