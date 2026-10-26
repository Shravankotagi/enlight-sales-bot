/**
 * A view-only procurement user cannot open or save a base price.
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
  permissions: {
    'inquiries.view': true,
    'inquiries.edit': false,
    'inquiries.fill_base_prices': true,
  },
};

const inquiry = {
  id: 'inq-1',
  procurement_number: 'PR-30011',
  procurement_employee_id: 'proc-a',
  status: 'review',
  pricing_status: 'awaiting_price',
  salesperson_phone: '9844444444',
  delivery_location: 'Pune',
  created_at: '2026-10-20T00:00:00.000Z',
  ai_extraction_json: {
    line_items: [{ sku_text: 'HR Coil', quantity: 10, unit: 'MT' }],
  },
};

function chat(intent) {
  const db = createSupabaseMock({
    tables: {
      employees: [person],
      inquiries: [inquiry],
      inquiry_line_pricing: [],
      recurring_customers: [],
      deals: [],
    },
  });
  const sessions = new Map();
  if (intent) sessions.set(person.phone, { last_intent: intent, customer_name: person.name });
  return {
    db,
    handle(text) {
      return handleProcurementChat(text, person.phone, {
        supabase: db.client,
        getEmployeeByPhone: async () => person,
        getFullActiveSession: async () => sessions.get(person.phone) || null,
        loadCanonicalInquiries: async () => [inquiry],
        saveActiveSession: async (phone, name, next) => {
          sessions.set(phone, { last_intent: next, customer_name: name });
        },
      });
    },
  };
}

test('a view-only procurement user cannot open or save a base price', async () => {
  const session = chat();
  const listed = await session.handle('log a base price');
  assert.match(listed.reply, /cannot enter a base price/);
  assert.doesNotMatch(listed.reply, /PR-30011/);

  const opened = await session.handle('PR-30011');
  assert.match(opened.reply, /cannot enter a base price/);

  const pricedSession = chat('procurement|base|PR-30011');
  const priced = await pricedSession.handle('51000');
  assert.match(priced.reply, /cannot enter a base price/);
  assert.equal(pricedSession.db.calls.some((call) => call.op === 'upsert' || call.op === 'update'), false);
});

test('pending prices and all inquiries still open for a view-only user', async () => {
  const session = chat();
  const pending = await session.handle('pending prices');
  assert.match(pending.reply, /PR-30011/);
  const all = await session.handle('all inquiries');
  assert.match(all.reply, /Awaiting Price: 1/);
});
