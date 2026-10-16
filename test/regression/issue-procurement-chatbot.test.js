/**
 * Procurement can use the assistant inside their inquiry scope, and a
 * salesperson log no longer stores a sell rate before the base price exists.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSupabaseMock } = require('../helpers/supabaseMock');
const { loadCatalogFlow } = require('../helpers/catalogFlowHarness');
const {
  matchesProcurementScope,
  scopeFromEmployees,
  deriveProcurementLines,
  formatInquiryLine,
  listReply,
  handleProcurementChat,
} = require('../../src/core/procurementChat');
const {
  customerTargetNote,
  parseSalesPrices,
  calculateSellRate,
  prematureUpdateReply,
  orderRateReply,
  handleSalesPriceChat,
} = require('../../src/core/salesPriceFlow');

const person = {
  id: 'proc-a',
  name: 'Asha',
  phone: '9811111111',
  role: 'procurement_person',
  is_active: true,
};
const report = {
  id: 'proc-b',
  name: 'Bina',
  phone: '9822222222',
  role: 'procurement_person',
  is_active: true,
  manager_id: 'mgr-1',
};
const manager = {
  id: 'mgr-1',
  name: 'Meera',
  phone: '9833333333',
  role: 'procurement_manager',
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
    procurement_number: 'PR-10041',
    procurement_employee_id: 'proc-b',
    status: 'new_inquiry',
    pricing_status: 'awaiting_price',
    salesperson_phone: '9844444444',
    delivery_location: 'Pune',
    customer_name: 'Secret Mills',
    ai_extraction_json: {
      customer_name: 'Secret Mills',
      line_items: [{ sku_text: 'HR Coil', quantity: 10, unit: 'MT' }],
    },
    ...overrides,
  };
}

function chat(caller, rows, intent, extraTables) {
  const db = createSupabaseMock({
    tables: {
      employees: extraTables?.employees || [person, report, manager, salesperson],
      inquiries: rows,
      inquiry_line_pricing: extraTables?.inquiry_line_pricing || [],
    },
  });
  const sessions = new Map();
  if (intent) sessions.set(caller.phone, { last_intent: intent, customer_name: caller.name });
  return {
    db,
    sessions,
    handle(text) {
      return handleProcurementChat(text, caller.phone, {
        supabase: db.client,
        getEmployeeByPhone: async () => caller,
        getFullActiveSession: async () => sessions.get(caller.phone) || null,
        saveActiveSession: async (phone, name, next) => {
          sessions.set(phone, { last_intent: next, customer_name: name });
        },
      });
    },
  };
}

test('the procurement menu is an interactive list', async () => {
  const personMenu = await chat(person, []).handle('hi');
  const personIds = personMenu.interactiveList.sections[0].rows.map((row) => row.id);
  assert.deepEqual(personIds, ['proc_1', 'proc_2', 'proc_3']);
  assert.equal(personMenu.interactiveType, 'list');

  const managerMenu = await chat(manager, []).handle('menu');
  const managerIds = managerMenu.interactiveList.sections[0].rows.map((row) => row.id);
  assert.deepEqual(managerIds, ['proc_1', 'proc_2', 'proc_3', 'proc_4']);
});

test('log a base price lists seven procurement numbers and points to the inquiries tab', async () => {
  const rows = Array.from({ length: 8 }, (_, index) => inquiry({
    id: `inq-${index + 1}`,
    procurement_number: `PR-${10001 + index}`,
    procurement_employee_id: 'proc-a',
    pricing_status: 'awaiting_price',
    created_at: `2026-10-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
    customer_name: 'Secret Mills',
  }));
  const eight = await chat(person, rows).handle('proc_3');
  assert.match(eight.reply, /PR-10008/);
  assert.match(eight.reply, /PR-10002/);
  assert.doesNotMatch(eight.reply, /PR-10001/);
  assert.match(eight.reply, /View the rest in the Inquiries tab/);
  assert.match(eight.reply, /PR-10008 · 8 Oct 2026, 5:30 am/);
  assert.doesNotMatch(eight.reply, /Secret Mills/);
  assert.equal(eight.interactiveList, undefined);

  const threeRows = rows.slice(0, 3);
  const three = await chat(person, threeRows).handle('log a base price');
  assert.match(three.reply, /PR-10001/);
  assert.match(three.reply, /PR-10003/);
  assert.doesNotMatch(three.reply, /Inquiries tab/);
  assert.equal(three.interactiveList, undefined);
  const copied = three.reply.split('\n').find((line) => line.startsWith('PR-10003'));
  const fromLine = await chat(person, threeRows).handle(copied);
  assert.match(fromLine.reply, /PR-10003/);
  assert.match(fromLine.reply, /one base price per line/);
});

test('a blank pricing status is not awaiting a price', async () => {
  const rows = [
    inquiry({ id: 'inq-blank', procurement_number: 'PR-10050', procurement_employee_id: 'proc-a', pricing_status: null }),
    inquiry({ id: 'inq-ready', procurement_number: 'PR-10051', procurement_employee_id: 'proc-a', pricing_status: 'awaiting_price' }),
  ];
  const pending = await chat(person, rows).handle('pending prices');
  assert.match(pending.reply, /PR-10051/);
  assert.doesNotMatch(pending.reply, /PR-10050/);
  const base = await chat(person, rows).handle('proc_3');
  assert.match(base.reply, /PR-10051/);
  assert.doesNotMatch(base.reply, /PR-10050/);
});

test('cancel ends the procurement step and hi shows the menu', async () => {
  const { handle } = chat(person, [inquiry({ procurement_employee_id: 'proc-a' })], 'procurement|base|PR-10041');
  const cancelled = await handle('cancel');
  assert.match(cancelled.reply, /Activity cancelled/);
  assert.equal(cancelled.interactiveType, 'list');
  const menu = await handle('hi');
  const ids = menu.interactiveList.sections[0].rows.map((row) => row.id);
  assert.deepEqual(ids, ['proc_1', 'proc_2', 'proc_3']);
});

test('asking for details returns the inquiry and does not open base pricing', async () => {
  const rows = [inquiry({
    id: 'inq-details',
    procurement_number: 'PR-10226',
    procurement_employee_id: 'proc-a',
    pricing_status: 'unavailable',
    delivery_location: 'Mumbai, Maharashtra',
    created_at: '2026-10-15T04:16:00.000Z',
    customer_name: 'Secret Mills',
    ai_extraction_json: {
      customer_name: 'Secret Mills',
      line_items: [
        { line_key: 'hr', sku_text: 'HR Coil', quantity: 10, unit: 'MT' },
        { line_key: 'cr', sku_text: 'CR Coil', quantity: 20, unit: 'MT' },
        { line_key: 'tmt', sku_text: 'TMT Bar', quantity: 20, unit: 'MT' },
      ],
    },
  })];
  const pricing = [
    { inquiry_id: 'inq-details', line_key: 'hr', line_status: 'cannot_price', procurement_line_note: 'not in stock', procurement_base_price_per_mt: null },
    { inquiry_id: 'inq-details', line_key: 'cr', line_status: 'priced', procurement_base_price_per_mt: 62000 },
    { inquiry_id: 'inq-details', line_key: 'tmt', line_status: 'needs_price' },
  ];
  const opened = chat(person, rows, 'procurement|menu', { inquiry_line_pricing: pricing });
  const details = await opened.handle('give me the details for this inquiry PR-10226');
  assert.match(details.reply, /PR-10226 · 15 Oct 2026, 9:46 am/);
  assert.match(details.reply, /Ravi · Mumbai, Maharashtra · Unavailable/);
  assert.match(details.reply, /1\. HR Coil 10 MT — Unavailable: not in stock/);
  assert.match(details.reply, /2\. CR Coil 20 MT — ₹62000\/MT/);
  assert.match(details.reply, /3\. TMT Bar 20 MT — Awaiting price/);
  assert.doesNotMatch(details.reply, /one base price per line/);
  assert.doesNotMatch(details.reply, /Secret Mills/);
  assert.equal(String(opened.sessions.get(person.phone)?.last_intent || '').startsWith('procurement|base|'), false);

  const priced = await opened.handle('PR-10226');
  assert.match(priced.reply, /one base price per line/);
  assert.match(opened.sessions.get(person.phone).last_intent, /^procurement\|base\|PR-10226$/);
});

test('a procurement person can ask how many inquiries a salesperson has left to price', async () => {
  const kiran = {
    id: 'sales-2',
    name: 'Kiran Shah',
    phone: '9855555555',
    role: 'salesperson',
    is_active: true,
    assigned_procurement_employee_id: 'proc-b',
  };
  const employees = [person, report, manager, salesperson, kiran];
  const rows = [
    inquiry({ id: 'inq-r1', procurement_employee_id: 'proc-a', pricing_status: 'awaiting_price', customer_name: 'Secret Mills' }),
    inquiry({
      id: 'inq-r2',
      procurement_number: 'PR-10042',
      procurement_employee_id: 'proc-a',
      pricing_status: 'awaiting_price',
      customer_name: 'Secret Mills',
    }),
    inquiry({
      id: 'inq-r3',
      procurement_number: 'PR-10043',
      procurement_employee_id: 'proc-a',
      pricing_status: 'price_ready',
      customer_name: 'Secret Mills',
    }),
    inquiry({
      id: 'inq-k',
      procurement_number: 'PR-10099',
      procurement_employee_id: 'proc-b',
      salesperson_phone: '9855555555',
      pricing_status: 'awaiting_price',
      customer_name: 'Secret Mills',
    }),
  ];
  const own = await chat(person, rows, null, { employees }).handle('How many inquiries for Ravi are left to price?');
  assert.equal(own.reply, 'Ravi has 2 inquiries left to price.');
  assert.doesNotMatch(own.reply, /Secret Mills/);

  const refused = await chat(person, rows, null, { employees }).handle('How many inquiries for Kiran Shah are left to price?');
  assert.equal(refused.reply, 'That salesperson is not in your list.');

  const managerCount = await chat(manager, rows, null, { employees }).handle('How many inquiries for Kiran Shah are left to price?');
  assert.equal(managerCount.reply, 'Kiran Shah has 1 inquiry left to price.');
});

test('a procurement person cannot read another person procurement number', async () => {
  const { handle } = chat(person, [inquiry()]);
  const result = await handle('PR-10041');
  assert.match(result.reply, /not in your inquiries/);
  assert.doesNotMatch(result.reply, /Secret Mills/);
  const team = await handle('4');
  assert.match(team.reply, /procurement manager/);
});

test('a procurement manager can read a report procurement number', async () => {
  const { handle } = chat(manager, [inquiry()]);
  const result = await handle('1');
  assert.match(result.reply, /PR-10041/);
  assert.match(result.reply, /Ravi/);
  assert.match(result.reply, /HR Coil/);
  assert.doesNotMatch(result.reply, /Secret Mills/);
});

test('scope keeps a stamped inquiry with its owner and opens the unassigned pool to a manager', () => {
  const employees = [person, report, manager, salesperson];
  const personScope = scopeFromEmployees(person, employees);
  const managerScope = scopeFromEmployees(manager, employees);
  const ownedByReport = inquiry();
  const unassigned = inquiry({
    id: 'inq-2',
    procurement_number: 'PR-10042',
    procurement_employee_id: null,
    customer_name: 'Secret Mills',
  });
  assert.equal(matchesProcurementScope(ownedByReport, personScope), false);
  assert.equal(matchesProcurementScope(unassigned, personScope), true);
  assert.equal(matchesProcurementScope(ownedByReport, managerScope), true);
  assert.equal(matchesProcurementScope(unassigned, managerScope), true);
  const line = formatInquiryLine(ownedByReport, 'Ravi');
  assert.doesNotMatch(line, /Secret Mills/);
  assert.doesNotMatch(listReply('Pending', [ownedByReport], employees), /Secret Mills/);
});

test('a base price of 500 makes the line price ready and a blank base makes it unavailable', async () => {
  const owned = inquiry({ procurement_employee_id: 'proc-a' });
  const existing = [{
    inquiry_id: 'inq-1',
    line_key: '0:HR Coil',
    credit_per_mt: 200,
    transport_per_mt: 1000,
    loading_per_mt: 500,
    margin_per_mt: 1500,
  }];
  const ready = chat(person, [owned], 'procurement|base|PR-10041', { inquiry_line_pricing: existing });
  const priced = await ready.handle('500');
  assert.match(priced.reply, /Price ready/);
  assert.doesNotMatch(priced.reply, /Secret Mills/);
  const saved = ready.db.store.inquiry_line_pricing.find((row) => row.line_status === 'priced');
  assert.equal(saved.procurement_base_price_per_mt, 500);
  assert.equal(saved.credit_per_mt, 200);
  assert.equal(saved.transport_per_mt, 1000);
  assert.equal(ready.db.store.inquiries[0].pricing_status, 'price_ready');

  const blank = chat(person, [inquiry({ procurement_employee_id: 'proc-a' })], 'procurement|base|PR-10041', {
    inquiry_line_pricing: existing,
  });
  const unavailable = await blank.handle('unavailable: not in stock');
  assert.match(unavailable.reply, /Unavailable/);
  const closed = blank.db.store.inquiry_line_pricing.find((row) => row.line_status === 'cannot_price');
  assert.equal(closed.procurement_base_price_per_mt, null);
  assert.equal(closed.procurement_line_note, 'not in stock');
  assert.equal(closed.credit_per_mt, 200);
  assert.equal(blank.db.store.inquiries[0].pricing_status, 'unavailable');
});

test('a missing credit column is left off the retry', async () => {
  const payloads = [];
  const employees = [person, salesperson];
  const inquiries = [inquiry({ procurement_employee_id: 'proc-a' })];
  const supabase = {
    from(table) {
      const api = {
        select() { return api; },
        order() { return api; },
        limit() { return api; },
        eq() { return api; },
        update() { return api; },
        upsert(payload) {
          payloads.push(payload);
          if (payloads.length === 1) {
            return Promise.resolve({ error: { message: 'column credit_per_mt does not exist' } });
          }
          return Promise.resolve({ error: null });
        },
        then(resolve, reject) {
          const data = table === 'employees'
            ? employees
            : table === 'inquiry_line_pricing'
              ? [{ inquiry_id: 'inq-1', line_key: '0:HR Coil', credit_per_mt: 200 }]
              : inquiries;
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        },
      };
      return api;
    },
  };
  const result = await handleProcurementChat('500', person.phone, {
    supabase,
    getEmployeeByPhone: async () => person,
    getFullActiveSession: async () => ({ last_intent: 'procurement|base|PR-10041' }),
    saveActiveSession: async () => {},
  });
  assert.match(result.reply, /Price ready/);
  assert.equal(payloads.length, 2);
  assert.equal(Object.hasOwn(payloads[1][0], 'credit_per_mt'), false);
  assert.equal(payloads[1][0].procurement_base_price_per_mt, 500);
});

test('deriveProcurementLines keeps a later base-price save from wiping sales components', () => {
  const next = deriveProcurementLines(
    [{ line_key: 'a', credit_per_mt: 200, margin_per_mt: 1500 }],
    [{ line_key: 'a', sku_text: 'HR Coil', base_price_per_mt: 500 }],
  );
  assert.equal(next[0].line_status, 'priced');
  assert.equal(next[0].credit_per_mt, 200);
  assert.equal(next[0].margin_per_mt, 1500);
});

test('a salesperson log keeps a typed price as a customer target and does not save a sell rate', async () => {
  const note = customerTargetNote({
    rate: '54000',
    additional_notes: 'urgent',
    line_items: [{ rate: 54000 }],
  });
  assert.match(note, /Customer target: ₹54,000\/MT/);
  assert.doesNotMatch(note, /rate_per_mt/);

  const h = loadCatalogFlow({
    tables: {
      employees: [{
        id: 'sales-9',
        phone: '9844444444',
        role: 'salesperson',
        is_active: true,
        assigned_procurement_employee_id: 'proc-a',
      }],
      inquiries: [],
    },
  });
  try {
    const reply = await h.catalogFlow.executeAction('LOG_INQUIRY', {
      company_name: 'Secret Mills',
      rate: '54000',
      line_items: [{ sku_text: 'HR Coil', description: 'HR Coil', quantity: 10, unit: 'MT', rate: 54000 }],
      payment_terms: '30 days',
      delivery_location: 'Pune',
      additional_notes: 'urgent',
    }, '9844444444');
    const saved = h.db.store.inquiries[0];
    const item = h.db.store.inquiry_items[0];
    assert.equal(saved.pricing_status, 'awaiting_price');
    assert.equal(saved.procurement_number, 'PR-10001');
    assert.equal(saved.procurement_employee_id, 'proc-a');
    assert.equal(h.db.store.deal_items[0].rate, null);
    assert.equal(saved.total_amount, null);
    assert.equal(saved.ai_extraction_json.rate, null);
    assert.match(saved.ai_extraction_json.additional_notes, /Customer target/);
    assert.equal(item.rate, null);
    assert.equal(item.amount, null);
    assert.match(reply, /PR-10001/);
    assert.match(reply, /base price is still waiting/);
    assert.doesNotMatch(reply, /Quotation Total/);
  } finally {
    h.restore();
  }
});

test('sales price uses base plus transport loading credit and margin', async () => {
  const parsed = parseSalesPrices('1000, 500, 1500', 1);
  assert.equal(parsed.rows[0].credit_per_mt, 0);
  assert.equal(calculateSellRate({
    procurement_base_price_per_mt: 62000,
    transport_per_mt: 1000,
    loading_per_mt: 500,
    credit_per_mt: 200,
    margin_per_mt: 1500,
  }), 65200);

  const db = createSupabaseMock({
    tables: {
      inquiries: [{
        id: 'inq-9',
        procurement_number: 'PR-10050',
        pricing_status: 'price_ready',
        salesperson_phone: '9844444444',
        delivery_location: 'Pune',
        ai_extraction_json: {},
      }],
      inquiry_line_pricing: [{
        inquiry_id: 'inq-9',
        line_key: '0:HR Coil',
        sku_text: 'HR Coil',
        quantity: 2,
        unit: 'MT',
        procurement_base_price_per_mt: 62000,
        line_status: 'priced',
      }],
    },
  });
  const result = await handleSalesPriceChat('1000, 500, 200, 1500', '9844444444', 'sales_price|lines|{"number":"PR-10050","count":1}', {
    supabase: db.client,
    saveActiveSession: async () => {},
    getAccessibleSalespersonPhonesForBot: async () => ({ phones: ['9844444444'], isAdmin: true }),
    expandPhoneVariants: (phones) => phones,
  });
  assert.match(result.reply, /sales priced/);
  assert.match(result.reply, /65,200/);
  assert.equal(db.store.inquiries[0].pricing_status, 'sales_priced');
  const savedLine = db.calls.find((call) => call.table === 'inquiry_line_pricing' && call.op === 'upsert');
  assert.equal(savedLine.payload[0].rate_per_mt, 65200);
  assert.equal(savedLine.payload[0].credit_per_mt, 200);
  assert.equal(prematureUpdateReply({ pricingStatus: 'price_ready', stage: 'won', hasRate: false }), 'The base price is ready. Reply *Price this inquiry* and send transport, loading, credit, and margin. Quoted, Won, and Lost stay closed until that sales price is saved.');
  assert.equal(orderRateReply(null), null);
  assert.match(orderRateReply('awaiting_price'), /saved sales rate/);
});
