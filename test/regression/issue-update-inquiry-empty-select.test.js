/**
 * Regression: selecting display_stage from inquiries fails because that value
 * is computed after the query. The failure was treated as an empty portfolio.
 * Issue: <add GitHub issue link>
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { inquiriesForSalesScope } = require('../../src/core/inquiryScope');
const { loadCatalogFlow } = require('../helpers/catalogFlowHarness');

const SENDER = '919811111111';
const OWN_ID = 'own11111-1111-1111-1111-111111111111';
const DEAL_ID = 'deal2222-2222-2222-2222-222222222222';
const OTHER_ID = 'othe3333-3333-3333-3333-333333333333';

function failingSelectClient() {
  const inquiries = [
    {
      id: OWN_ID,
      sender_name: 'Own Mills',
      salesperson_phone: SENDER,
      inquiry_type: 'inquiry',
      created_at: '2026-10-20T04:00:00.000Z',
    },
    {
      id: DEAL_ID,
      sender_name: 'Deal Mills',
      salesperson_phone: null,
      sender_phone: null,
      inquiry_type: 'inquiry',
      created_at: '2026-10-21T04:00:00.000Z',
    },
    {
      id: OTHER_ID,
      sender_name: 'Other Mills',
      salesperson_phone: '919222222222',
      inquiry_type: 'inquiry',
      created_at: '2026-10-22T04:00:00.000Z',
    },
  ];
  const deals = [{
    id: 'linked-deal',
    inquiry_id: DEAL_ID,
    salesperson_phone: SENDER,
    customer_name: 'Deal Mills',
    created_at: '2026-10-21T04:00:00.000Z',
  }];

  function builder(table) {
    const state = { columns: '', filters: [] };
    const api = {
      select(columns) { state.columns = columns; return api; },
      neq() { return api; },
      order() { return api; },
      range() { return api; },
      in(column, values) {
        state.filters.push((row) => values.includes(row[column]));
        return api;
      },
      then(resolve, reject) {
        const finish = () => {
          if (table === 'inquiries' && String(state.columns).includes('display_stage')) {
            return { data: null, error: { message: 'column inquiries.display_stage does not exist' } };
          }
          const source = table === 'inquiries' ? inquiries : table === 'deals' ? deals : [];
          return { data: source.filter((row) => state.filters.every((filter) => filter(row))), error: null };
        };
        return Promise.resolve().then(finish).then(resolve, reject);
      },
    };
    return api;
  }

  return { from: builder };
}

test('a display_stage select falls back and keeps a deal-assigned inquiry', async () => {
  const rows = await inquiriesForSalesScope(
    failingSelectClient(),
    { isAdmin: false, phones: ['9811111111'] },
    SENDER,
    'id, sender_name, salesperson_phone, sender_phone, display_stage, pricing_status, tonnage_review_open, procurement_number',
  );
  const ids = rows.map((row) => row.id);
  assert.ok(ids.includes(OWN_ID));
  assert.ok(ids.includes(DEAL_ID));
  assert.equal(ids.includes(OTHER_ID), false);
});

test('Update Inquiry does not select display_stage and lists a deal-assigned inquiry', async () => {
  const h = loadCatalogFlow({
    tables: {
      inquiries: [
        {
          id: DEAL_ID,
          sender_name: 'Deal Mills',
          salesperson_phone: null,
          sender_phone: null,
          status: 'new_inquiry',
          inquiry_type: 'inquiry',
          raw_text: 'Plate',
          created_at: '2026-10-21T04:00:00.000Z',
          ai_extraction_json: { line_items: [{ sku_text: 'Plate', quantity: 1, unit: 'MT' }] },
        },
        {
          id: OTHER_ID,
          sender_name: 'Other Mills',
          salesperson_phone: '919222222222',
          sender_phone: '919222222222',
          status: 'new_inquiry',
          inquiry_type: 'inquiry',
          raw_text: 'Wire',
          created_at: '2026-10-22T04:00:00.000Z',
          ai_extraction_json: { line_items: [{ sku_text: 'Wire', quantity: 1, unit: 'MT' }] },
        },
      ],
      deals: [{
        id: 'linked-deal',
        inquiry_id: DEAL_ID,
        customer_name: 'Deal Mills',
        salesperson_phone: SENDER,
        stage: 'new_inquiry',
        created_at: '2026-10-21T04:00:00.000Z',
      }],
      recurring_customers: [],
    },
    scope: { isAdmin: false, isManager: false, phones: ['9811111111'] },
    llm: () => '{"action":"UPDATE_INQUIRY","updates":{}}',
  });
  try {
    const records = await h.catalogFlow.fetchEditableRecordsForModule('UPDATE_INQUIRY', SENDER);
    assert.ok(records.some((row) => row.customer_name === 'Deal Mills'));
    assert.equal(records.some((row) => row.customer_name === 'Other Mills'), false);
    const selects = h.db.calls
      .filter((call) => call.table === 'inquiries')
      .flatMap((call) => call.modifiers.filter((modifier) => modifier[0] === 'select').map((modifier) => modifier[1][0]));
    assert.ok(selects.length > 0);
    assert.ok(selects.every((columns) => !String(columns).includes('display_stage')));
    const rendered = await h.catalogFlow.fetchAndRenderUpdateSelection('UPDATE_INQUIRY', SENDER, { page: 1 });
    assert.equal(rendered.hasRecords, true);
    assert.match(rendered.reply, /Deal Mills/);
  } finally {
    h.restore();
  }
});
