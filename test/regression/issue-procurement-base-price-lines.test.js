/**
 * Logging a base price lists every line and saves a price on only the line
 * the user picks.
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

const pricing = [
  {
    inquiry_id: 'inq-10235',
    line_key: 'tmt',
    sku_text: 'TMT Bar',
    quantity: 20,
    unit: 'MT',
    credit_per_mt: 200,
    transport_per_mt: 1000,
    loading_per_mt: 500,
    margin_per_mt: 1500,
    rate_per_mt: 0,
    line_status: 'needs_price',
  },
  {
    inquiry_id: 'inq-10235',
    line_key: 'hr',
    sku_text: 'HR Coil',
    procurement_base_price_per_mt: 62000,
    line_status: 'priced',
    credit_per_mt: 50,
  },
  {
    inquiry_id: 'inq-10235',
    line_key: 'cr',
    sku_text: 'CR Coil',
    procurement_base_price_per_mt: null,
    procurement_line_note: 'not in stock',
    line_status: 'cannot_price',
    margin_per_mt: 800,
  },
];

function chat() {
  const db = createSupabaseMock({
    tables: {
      employees: [person, salesperson],
      inquiries: [inquiry],
      inquiry_line_pricing: pricing,
      deals: [],
    },
  });
  const sessions = new Map();
  return {
    db,
    sessions,
    handle(text) {
      return handleProcurementChat(text, person.phone, {
        supabase: db.client,
        getEmployeeByPhone: async () => person,
        getFullActiveSession: async () => sessions.get(person.phone) || null,
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

test('log a base price lists every line instead of a collapsed summary', async () => {
  const session = chat();
  const listed = await session.handle('log a base price');
  assert.match(listed.reply, /PR-10235/);
  assert.match(listed.reply, /Ravi/);
  assert.match(listed.reply, /MS SHEET/);
  assert.match(listed.reply, /5 mm/);
  assert.match(listed.reply, /150 Nos/);
  assert.match(listed.reply, /7\.359 MT/);
  assert.match(listed.reply, /TMT Bar/);
  assert.match(listed.reply, /20 MT/);
  assert.match(listed.reply, /HR Coil/);
  assert.match(listed.reply, /₹62000\/MT/);
  assert.match(listed.reply, /CR Coil/);
  assert.match(listed.reply, /IS 2062/);
  assert.match(listed.reply, /Unavailable: not in stock/);
  assert.match(listed.reply, /Awaiting price/);
  assert.doesNotMatch(listed.reply, /\+\d+ more/);
  assert.doesNotMatch(listed.reply, /Secret Mills/);
  assert.equal(listed.interactiveList, undefined);

  const opened = await session.handle('PR-10235');
  assert.match(opened.reply, /MS SHEET/);
  assert.match(opened.reply, /TMT Bar/);
  assert.match(opened.reply, /HR Coil/);
  assert.match(opened.reply, /CR Coil/);
  assert.match(opened.reply, /Reply with the line number/);
  assert.deepEqual(opened.interactiveList.sections[0].rows.map((row) => row.id), [
    'proc_line_1',
    'proc_line_2',
    'proc_line_3',
    'proc_line_4',
  ]);
});

test('a base price is saved on the chosen line and the other lines stay as they were', async () => {
  const session = chat();
  await session.handle('log a base price');
  await session.handle('PR-10235');
  const ignored = await session.handle('51000');
  assert.match(ignored.reply, /line number/);
  assert.equal(upserts(session.db).length, 0);
  assert.equal(session.db.store.inquiries[0].pricing_status, 'awaiting_price');

  const saved = await session.handle('2 51000');
  assert.match(saved.reply, /Price ready/);
  assert.match(saved.reply, /TMT Bar/);
  assert.match(saved.reply, /₹51000\/MT/);
  const writes = upserts(session.db);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].payload.length, 1);
  assert.equal(writes[0].payload[0].line_key, 'tmt');
  assert.equal(writes[0].payload[0].procurement_base_price_per_mt, 51000);
  assert.equal(writes[0].payload[0].credit_per_mt, 200);
  assert.equal(writes[0].payload[0].transport_per_mt, 1000);
  assert.equal(writes[0].payload[0].loading_per_mt, 500);
  assert.equal(writes[0].payload[0].margin_per_mt, 1500);
  assert.equal(session.db.store.inquiries[0].pricing_status, 'price_ready');
  const hr = session.db.store.inquiry_line_pricing.find((row) => row.line_key === 'hr' && row.procurement_base_price_per_mt === 62000);
  const cr = session.db.store.inquiry_line_pricing.find((row) => row.line_key === 'cr');
  assert.ok(hr);
  assert.equal(hr.credit_per_mt, 50);
  assert.equal(cr.procurement_line_note, 'not in stock');
  assert.equal(cr.margin_per_mt, 800);
  assert.equal(String(session.sessions.get(person.phone).last_intent || '').startsWith('procurement|base|PR-10235'), true);

  const picked = await session.handle('proc_line_1');
  assert.match(picked.reply, /MS SHEET/);
  assert.match(picked.reply, /Reply with the base price/);
  const closed = await session.handle('unavailable: mill closed');
  assert.match(closed.reply, /Unavailable: mill closed/);
  const sheetWrite = upserts(session.db).at(-1);
  assert.equal(sheetWrite.payload.length, 1);
  assert.equal(sheetWrite.payload[0].line_key, 'sheet');
  assert.equal(sheetWrite.payload[0].procurement_base_price_per_mt, null);
  assert.equal(sheetWrite.payload[0].procurement_line_note, 'mill closed');
  assert.equal(sheetWrite.payload[0].line_status, 'cannot_price');
});
