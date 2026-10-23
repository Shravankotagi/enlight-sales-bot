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
  assert.match(listed.reply, /\*PR-10235\*/);
  assert.match(listed.reply, /Ravi/);
  assert.match(listed.reply, /\*1\. MS SHEET\*/);
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
  assert.match(opened.reply, /1 - 2300/);
  assert.match(opened.reply, /1 2300, 2 2500, 4 unavailable: not in stock/);
  assert.equal(opened.interactiveList, undefined);
});

test('a base price is saved on the chosen line and the other lines stay as they were', async () => {
  const session = chat();
  await session.handle('log a base price');
  await session.handle('PR-10235');
  const ignored = await session.handle('51000');
  assert.match(ignored.reply, /line number/);
  assert.equal(upserts(session.db).length, 0);
  assert.equal(session.db.store.inquiries[0].pricing_status, 'awaiting_price');

  const preview = await session.handle('2 51000');
  assert.match(preview.reply, /Save this base price/);
  assert.match(preview.reply, /TMT Bar/);
  assert.match(preview.reply, /₹51000\/MT/);
  assert.deepEqual(preview.interactiveButtons.map((button) => button.id), ['btn_price_save', 'btn_confirm_cancel']);
  assert.equal(upserts(session.db).length, 0);
  assert.equal(session.db.store.inquiries[0].pricing_status, 'awaiting_price');
  assert.equal(String(session.sessions.get(person.phone).last_intent || '').startsWith('procurement|base|confirm|'), true);

  const saved = await session.handle('btn_price_save');
  assert.match(saved.reply, /is now Price ready/);
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

  const picked = await session.handle('1');
  assert.match(picked.reply, /Only an awaiting price inquiry can take a base price/);
  assert.equal(upserts(session.db).length, 1);

  const again = chat();
  await again.handle('PR-10235');
  const line = await again.handle('1');
  assert.match(line.reply, /MS SHEET/);
  assert.match(line.reply, /Reply with the base price/);
  assert.equal(line.interactiveButtons, undefined);
  const closed = await again.handle('unavailable: mill closed');
  assert.match(closed.reply, /Save this base price/);
  assert.match(closed.reply, /Unavailable: mill closed/);
  assert.equal(upserts(again.db).length, 0);
  const written = await again.handle('yes');
  assert.match(written.reply, /Unavailable: mill closed/);
  const sheetWrite = upserts(again.db).at(-1);
  assert.equal(sheetWrite.payload.length, 1);
  assert.equal(sheetWrite.payload[0].line_key, 'sheet');
  assert.equal(sheetWrite.payload[0].procurement_base_price_per_mt, null);
  assert.equal(sheetWrite.payload[0].procurement_line_note, 'mill closed');
  assert.equal(sheetWrite.payload[0].line_status, 'cannot_price');
});

function scopedInquiry(overrides) {
  return {
    id: 'inq-x',
    procurement_number: 'PR-30000',
    procurement_employee_id: null,
    status: 'new_inquiry',
    pricing_status: 'awaiting_price',
    salesperson_phone: null,
    sender_phone: null,
    delivery_location: 'Pune',
    customer_name: 'Hidden Buyer',
    created_at: '2026-10-20T00:00:00.000Z',
    ai_extraction_json: {
      customer_name: 'Hidden Buyer',
      line_items: [{ sku_text: 'HR Coil', quantity: 1, unit: 'MT' }],
    },
    ...overrides,
  };
}

function chatRows(inquiries, customers) {
  const db = createSupabaseMock({
    tables: {
      employees: [person, salesperson],
      inquiries,
      inquiry_line_pricing: [],
      recurring_customers: customers || [],
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

test('log a base price lists the dashboard awaiting set without line buttons', async () => {
  const session = chatRows([
    scopedInquiry({
      id: 'inq-sender',
      procurement_number: 'PR-30001',
      sender_phone: '9844444444',
      customer_name: 'Hidden Buyer',
    }),
    scopedInquiry({
      id: 'inq-owner',
      procurement_number: 'PR-30002',
      salesperson_phone: 'unassigned',
      customer_name: 'Acme Steel',
      ai_extraction_json: {
        customer_name: 'Acme Steel',
        line_items: [{ sku_text: 'HR Coil', quantity: 1, unit: 'MT' }],
      },
    }),
    scopedInquiry({
      id: 'inq-old',
      procurement_number: 'PR-30003',
      procurement_employee_id: 'proc-a',
      created_at: '2026-10-01T00:00:00.000Z',
    }),
    scopedInquiry({
      id: 'inq-other',
      procurement_number: 'PR-30004',
      procurement_employee_id: 'proc-b',
      salesperson_phone: '9844444444',
    }),
  ], [{
    customer_name: 'Acme Steel',
    assigned_salesperson_phone: '9844444444',
    updated_at: '2026-10-20T00:00:00.000Z',
  }]);
  const listed = await session.handle('log a base price');
  assert.match(listed.reply, /PR-30001/);
  assert.match(listed.reply, /PR-30002/);
  assert.match(listed.reply, /Ravi/);
  assert.doesNotMatch(listed.reply, /PR-30003/);
  assert.doesNotMatch(listed.reply, /PR-30004/);
  assert.doesNotMatch(listed.reply, /Acme Steel/);
  assert.doesNotMatch(listed.reply, /Hidden Buyer/);
  assert.equal(listed.interactiveList, undefined);
  const inquiryCalls = session.db.calls.filter((call) => call.table === 'inquiries');
  assert.ok(inquiryCalls.some((call) => (call.modifiers || []).some(([name]) => name === 'range')));
  assert.equal(inquiryCalls.some((call) => (call.modifiers || []).some(([name, args]) => name === 'limit' && Number(args[0]) === 500)), false);

  const opened = await session.handle('PR-30001');
  assert.match(opened.reply, /Reply with the base price/);
  assert.equal(opened.interactiveList, undefined);
});

test('a dash and a comma list save only the named lines', async () => {
  const session = chat();
  await session.handle('log a base price');
  await session.handle('PR-10235');
  const dashed = await session.handle('1 - 2300');
  assert.match(dashed.reply, /Save this base price/);
  assert.match(dashed.reply, /₹2300\/MT/);
  assert.deepEqual(dashed.interactiveButtons.map((button) => button.id), ['btn_price_save', 'btn_confirm_cancel']);
  assert.equal(upserts(session.db).length, 0);
  const cancelled = await session.handle('btn_confirm_cancel');
  assert.match(cancelled.reply, /Activity cancelled/);
  assert.equal(upserts(session.db).length, 0);

  await session.handle('PR-10235');
  await session.handle('1 - 2300');
  await session.handle('btn_price_save');
  const first = upserts(session.db);
  assert.equal(first.length, 1);
  assert.equal(first[0].payload.length, 1);
  assert.equal(first[0].payload[0].line_key, 'sheet');
  assert.equal(first[0].payload[0].procurement_base_price_per_mt, 2300);

  const locked = await session.handle('1 48000, 2 51000, 4 unavailable: mill closed');
  assert.match(locked.reply, /Only an awaiting price inquiry can take a base price/);
  assert.equal(upserts(session.db).length, 1);

  const fresh = chat();
  await fresh.handle('PR-10235');
  const listed = await fresh.handle('1 48000, 2 51000, 4 unavailable: mill closed');
  assert.match(listed.reply, /Save this base price/);
  assert.match(listed.reply, /₹48000\/MT/);
  assert.match(listed.reply, /₹51000\/MT/);
  assert.match(listed.reply, /Unavailable: mill closed/);
  assert.match(listed.reply, /₹62000\/MT/);
  assert.equal(upserts(fresh.db).length, 0);
  await fresh.handle('yes');
  const second = upserts(fresh.db).at(-1);
  assert.equal(second.payload.length, 3);
  const byKey = Object.fromEntries(second.payload.map((row) => [row.line_key, row]));
  assert.equal(byKey.sheet.procurement_base_price_per_mt, 48000);
  assert.equal(byKey.tmt.procurement_base_price_per_mt, 51000);
  assert.equal(byKey.tmt.credit_per_mt, 200);
  assert.equal(byKey.cr.procurement_base_price_per_mt, null);
  assert.equal(byKey.cr.procurement_line_note, 'mill closed');
  assert.equal(byKey.cr.margin_per_mt, 800);
  assert.equal(byKey.hr, undefined);
  const hr = fresh.db.store.inquiry_line_pricing.find((row) => row.line_key === 'hr' && row.procurement_base_price_per_mt === 62000);
  assert.equal(hr.credit_per_mt, 50);
  const cr = fresh.db.store.inquiry_line_pricing.find((row) => row.line_key === 'cr' && row.procurement_line_note === 'not in stock');
  assert.equal(cr.margin_per_mt, 800);
});

test('a price-ready number does not open or save a base price', async () => {
  const session = chatRows([
    scopedInquiry({
      id: 'inq-ready',
      procurement_number: 'PR-30011',
      procurement_employee_id: 'proc-a',
      pricing_status: 'price_ready',
      salesperson_phone: '9844444444',
    }),
  ]);
  const opened = await session.handle('PR-30011');
  assert.match(opened.reply, /Only an awaiting price inquiry can take a base price/);
  assert.doesNotMatch(opened.reply, /Reply with the base price/);
  assert.equal(upserts(session.db).length, 0);

  session.sessions.set(person.phone, { last_intent: 'procurement|base|PR-30011' });
  const priced = await session.handle('51000');
  assert.match(priced.reply, /Only an awaiting price inquiry can take a base price/);
  assert.equal(upserts(session.db).length, 0);

  session.sessions.set(person.phone, {
    last_intent: `procurement|base|confirm|${JSON.stringify({
      n: 'PR-30011',
      pairs: [{ line: 1, price: 51000, note: null }],
    })}`,
  });
  const saved = await session.handle('btn_price_save');
  assert.match(saved.reply, /Only an awaiting price inquiry can take a base price/);
  assert.equal(upserts(session.db).length, 0);
});
