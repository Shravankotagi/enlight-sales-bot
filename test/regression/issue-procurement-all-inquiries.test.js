/**
 * All inquiries lists every status badge, ten at a time, and opens details
 * when a procurement line is pasted back.
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

function inquiry(overrides) {
  return {
    id: 'inq-1',
    procurement_number: 'PR-10001',
    procurement_employee_id: 'proc-a',
    status: 'new_inquiry',
    pricing_status: null,
    salesperson_phone: '9844444444',
    delivery_location: 'Pune',
    customer_name: 'Secret Mills',
    created_at: '2026-10-01T00:00:00.000Z',
    ai_extraction_json: {
      customer_name: 'Secret Mills',
      line_items: [{ sku_text: 'HR Coil', quantity: 10, unit: 'MT' }],
    },
    ...overrides,
  };
}

function chat(rows, intent, extraTables) {
  const db = createSupabaseMock({
    tables: {
      employees: [person, salesperson],
      inquiries: rows,
      inquiry_line_pricing: extraTables?.inquiry_line_pricing || [],
      deals: extraTables?.deals || [],
    },
  });
  const sessions = new Map();
  if (intent) sessions.set(person.phone, { last_intent: intent, customer_name: person.name });
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

function ownedSet() {
  const rows = [
    inquiry({
      id: 'inq-12',
      procurement_number: 'PR-10012',
      pricing_status: 'awaiting_price',
      created_at: '2026-10-20T00:00:00.000Z',
      ai_extraction_json: {
        line_items: [{ sku_text: 'MS SHEET', quantity: 150, unit: 'Nos', dimensions: '5 mm' }],
      },
    }),
    inquiry({
      id: 'inq-11',
      procurement_number: 'PR-10011',
      pricing_status: 'price_ready',
      created_at: '2026-10-11T00:00:00.000Z',
    }),
    inquiry({
      id: 'inq-10',
      procurement_number: 'PR-10010',
      pricing_status: 'unavailable',
      created_at: '2026-10-10T00:00:00.000Z',
    }),
    inquiry({
      id: 'inq-09',
      procurement_number: 'PR-10009',
      status: 'won',
      pricing_status: 'sales_priced',
      created_at: '2026-10-09T00:00:00.000Z',
    }),
    inquiry({
      id: 'inq-01',
      procurement_number: 'PR-10001',
      status: 'quoted',
      pricing_status: null,
      created_at: '2026-10-01T00:00:00.000Z',
    }),
  ];
  for (let day = 2; day <= 8; day += 1) {
    rows.push(inquiry({
      id: `inq-0${day}`,
      procurement_number: `PR-1000${day}`,
      status: 'new_inquiry',
      pricing_status: null,
      created_at: `2026-10-0${day}T00:00:00.000Z`,
    }));
  }
  rows.push(inquiry({
    id: 'inq-other',
    procurement_number: 'PR-19999',
    procurement_employee_id: 'proc-b',
    pricing_status: 'price_ready',
    created_at: '2026-10-20T00:00:00.000Z',
  }));
  return rows;
}

test('the menu calls the action All inquiries', async () => {
  const opened = await chat([]).handle('hi');
  const row = opened.interactiveList.sections[0].rows.find((item) => item.id === 'proc_2');
  assert.equal(row.title, '2. All inquiries');
  assert.equal(row.description, 'Every status, newest first');
  assert.doesNotMatch(opened.reply, /Current inquiries/);
});

test('all inquiries summarizes every badge and pages the newest ten', async () => {
  const session = chat(ownedSet());
  const first = await session.handle('all inquiries');
  assert.match(first.reply, /Awaiting Price: 1/);
  assert.match(first.reply, /Price Ready: 1/);
  assert.match(first.reply, /Unavailable: 1/);
  assert.match(first.reply, /New Inquiry: 7/);
  assert.match(first.reply, /Price Quote: 1/);
  assert.match(first.reply, /Negotiation: 0/);
  assert.match(first.reply, /On Hold: 0/);
  assert.match(first.reply, /Won: 1/);
  assert.match(first.reply, /Lost: 0/);
  const lines = first.reply.split('\n');
  const numberAt = lines.indexOf('*PR-10012*');
  assert.ok(numberAt >= 0);
  assert.equal(lines[numberAt + 1], 'Awaiting Price');
  assert.match(lines[numberAt + 2], /Ravi/);
  assert.match(lines[numberAt + 3], /MS SHEET 150 Nos/);
  assert.equal(lines[numberAt + 4], 'Pune');
  assert.doesNotMatch(lines[numberAt], /Pune|Awaiting Price/);
  assert.doesNotMatch(first.reply, /PR-10001/);
  assert.doesNotMatch(first.reply, /PR-19999/);
  assert.doesNotMatch(first.reply, /Secret Mills/);
  assert.match(first.reply, /Type next to see the next set of inquiries/);
  assert.match(session.sessions.get(person.phone).last_intent, /^procurement\|all\|0$/);

  const second = await session.handle('next');
  assert.match(second.reply, /PR-10001/);
  assert.match(second.reply, /Price Quote/);
  assert.doesNotMatch(second.reply, /PR-10012/);
  assert.doesNotMatch(second.reply, /Type next to see the next set of inquiries/);
  assert.match(second.reply, /There are no more inquiries/);
  assert.match(session.sessions.get(person.phone).last_intent, /^procurement\|all\|10$/);

  const stayed = await session.handle('next');
  assert.match(stayed.reply, /There are no more inquiries/);
  assert.doesNotMatch(stayed.reply, /Type next to see the next set of inquiries/);
});

test('the old current inquiries phrase opens the same list', async () => {
  const opened = await chat(ownedSet()).handle('current inquiries');
  assert.match(opened.reply, /PR-10012/);
  assert.match(opened.reply, /Awaiting Price: 1/);
  assert.doesNotMatch(opened.reply, /PR-10001/);
});

test('pasting a listed line opens that inquiry and does not ask for a base price', async () => {
  const session = chat(ownedSet(), null, {
    inquiry_line_pricing: [{
      inquiry_id: 'inq-12',
      line_key: '0:MS SHEET',
      line_status: 'needs_price',
    }],
  });
  const first = await session.handle('proc_2');
  const copied = first.reply.split('\n').find((line) => line.includes('PR-10012'));
  const details = await session.handle(copied);
  assert.match(details.reply, /PR-10012/);
  assert.match(details.reply, /MS SHEET/);
  assert.match(details.reply, /150 Nos/);
  assert.match(details.reply, /Awaiting price/);
  assert.doesNotMatch(details.reply, /one base price per line/);
  assert.doesNotMatch(details.reply, /Secret Mills/);
  assert.equal(String(session.sessions.get(person.phone).last_intent || '').startsWith('procurement|base|'), false);
});

test('a historical awaiting price uses the deal-stage badge', async () => {
  const opened = await chat([
    inquiry({
      id: 'inq-old',
      procurement_number: 'PR-10050',
      status: 'won',
      pricing_status: 'awaiting_price',
      created_at: '2026-10-01T00:00:00.000Z',
    }),
  ]).handle('2');
  assert.match(opened.reply, /Awaiting Price: 0/);
  assert.match(opened.reply, /Won: 1/);
  assert.match(opened.reply, /PR-10050/);
  assert.match(opened.reply, /Won/);
  const numberLine = opened.reply.split('\n').find((line) => line.includes('PR-10050'));
  assert.equal(numberLine, '*PR-10050*');
  assert.doesNotMatch(numberLine, /Awaiting Price/);
  assert.equal(opened.reply.split('\n')[opened.reply.split('\n').indexOf('*PR-10050*') + 1], 'Won');
});
