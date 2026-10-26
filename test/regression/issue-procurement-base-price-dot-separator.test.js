/**
 * Regression: a numbered-list reply "1. 500" was parsed as 0.5/MT while
 * "1-500" saved 500/MT.
 * Issue: <add GitHub issue link>
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSupabaseMock } = require('../helpers/supabaseMock');
const { handleProcurementChat } = require('../../src/core/procurementChat');

const person = {
  id: 'proc-a',
  name: 'Asha',
  phone: '9811111111',
  role: 'procurement_person',
  is_active: true,
};
const salesperson = {
  id: 'sales-1',
  name: 'Ravi',
  phone: '9844444444',
  role: 'salesperson',
  is_active: true,
  assigned_procurement_employee_id: 'proc-a',
};

const inquiry = {
  id: 'inq-10235',
  procurement_number: 'PR-10235',
  procurement_employee_id: 'proc-a',
  status: 'new_inquiry',
  pricing_status: 'awaiting_price',
  salesperson_phone: '9844444444',
  delivery_location: 'Pune',
  customer_name: 'Secret Mills',
  created_at: '2026-10-20T04:16:00.000Z',
  ai_extraction_json: {
    customer_name: 'Secret Mills',
    line_items: [
      { line_key: 'sheet', sku_text: 'MS SHEET', dimensions: '5 mm', quantity: 150, unit: 'Nos', weight_mt: 7.359 },
      { line_key: 'tmt', sku_text: 'TMT Bar', quantity: 20, unit: 'MT' },
      { line_key: 'hr', sku_text: 'HR Coil', quantity: 10, unit: 'MT' },
      { line_key: 'cr', sku_text: 'CR Coil', grade: 'IS 2062', quantity: 5, unit: 'MT' },
    ],
  },
};

function chat() {
  const db = createSupabaseMock({
    tables: {
      employees: [person, salesperson],
      inquiries: [inquiry],
      inquiry_line_pricing: [],
      deals: [],
    },
  });
  const sessions = new Map();
  return {
    db,
    handle(text) {
      return handleProcurementChat(text, person.phone, {
        supabase: db.client,
        getEmployeeByPhone: async () => person,
        getFullActiveSession: async () => sessions.get(person.phone) || null,
        loadCanonicalInquiries: async () => db.store.inquiries,
        saveActiveSession: async (phone, name, next) => {
          sessions.set(phone, { last_intent: next, customer_name: name });
        },
      });
    },
  };
}

function upserts(db) {
  return db.calls.filter((call) => call.table === 'inquiry_line_pricing' && call.op === 'upsert');
}

test('a dotted line number and a hyphen save the same rupees per MT', async () => {
  const session = chat();
  await session.handle('log a base price');
  await session.handle('PR-10235');

  const dotted = await session.handle('1. 500');
  assert.match(dotted.reply, /Save this base price/);
  assert.match(dotted.reply, /₹500\/MT/);
  assert.doesNotMatch(dotted.reply, /₹0\.5\/MT/);
  assert.equal(upserts(session.db).length, 0);

  const cancelled = await session.handle('btn_confirm_cancel');
  assert.match(cancelled.reply, /Activity cancelled/);
  assert.equal(upserts(session.db).length, 0);

  await session.handle('PR-10235');
  const dashed = await session.handle('1-500');
  assert.match(dashed.reply, /Save this base price/);
  assert.match(dashed.reply, /₹500\/MT/);
  assert.equal(upserts(session.db).length, 0);

  await session.handle('btn_confirm_cancel');
  await session.handle('PR-10235');
  await session.handle('1. 500');
  await session.handle('btn_price_save');
  const writes = upserts(session.db);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].payload.length, 1);
  assert.equal(writes[0].payload[0].line_key, 'sheet');
  assert.equal(writes[0].payload[0].procurement_base_price_per_mt, 500);
});
