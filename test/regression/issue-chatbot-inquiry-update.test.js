/**
 * Regression: Update Inquiry on the assistant and WhatsApp only loaded rows
 * whose salesperson phone was already stored, so a Price Ready inquiry the
 * dashboard shows through the sender or the customer owner could not be opened.
 * A quantity change then has to follow the commercial-weight rules and leave
 * the deal stage where it is.
 * Issue: <add GitHub issue link>
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { applyCommercialLines, tonnageReviewPatch } = require('../../src/core/tonnageReview');
const { loadCatalogFlow } = require('../helpers/catalogFlowHarness');
const { createSupabaseMock } = require('../helpers/supabaseMock');
const { loadWithMocks } = require('../helpers/loadWithMocks');
const { setMockPermissions, builtinFor, invalidateBotPermissions } = require('../../src/utils/permissions');

const SENDER = '919811111111';
const HIDDEN_ID = 'ccbe2a11-1111-1111-1111-111111111111';
const OWNER_ID = 'acme1111-2222-2222-2222-222222222222';
const STRANGER_ID = 'bbbb2222-3333-3333-3333-333333333333';
const WON_ID = 'cccc3333-4444-4444-4444-444444444444';

const line = {
  sku_text: 'HR Coil',
  dimensions: '2 mm',
  quantity: 12,
  unit: 'MT',
  original_quantity: 12,
  original_unit: 'MT',
  rate: 50000,
  amount: 600000,
};

function seed() {
  return {
    employees: [],
    recurring_customers: [{
      customer_name: 'Acme Steel',
      assigned_salesperson_phone: '919811111111',
      is_active: true,
    }],
    inquiries: [
      {
        id: HIDDEN_ID,
        sender_name: 'Hidden Mills',
        sender_phone: '919811111111',
        salesperson_phone: null,
        status: 'review',
        pricing_status: 'price_ready',
        inquiry_type: 'inquiry',
        raw_text: 'HR Coil 12 MT',
        payment_terms: '30 days',
        created_at: '2026-10-21T04:00:00.000Z',
        ai_extraction_json: {
          customer_name: 'Hidden Mills',
          delivery_location: 'Pune',
          payment_terms: '30 days',
          line_items: [{ ...line }],
        },
      },
      {
        id: OWNER_ID,
        sender_name: 'Acme Steel',
        sender_phone: null,
        salesperson_phone: null,
        status: 'new_inquiry',
        pricing_status: 'awaiting_price',
        inquiry_type: 'inquiry',
        raw_text: 'Plate',
        created_at: '2026-10-20T04:00:00.000Z',
        ai_extraction_json: { customer_name: 'Acme Steel', line_items: [{ ...line, sku_text: 'Plate' }] },
      },
      {
        id: STRANGER_ID,
        sender_name: 'Other Mills',
        sender_phone: '919222222222',
        salesperson_phone: '919222222222',
        status: 'new_inquiry',
        inquiry_type: 'inquiry',
        raw_text: 'Wire',
        created_at: '2026-10-22T04:00:00.000Z',
        ai_extraction_json: { line_items: [{ ...line, sku_text: 'Wire' }] },
      },
      {
        id: WON_ID,
        sender_name: 'Closed Mills',
        sender_phone: '919811111111',
        salesperson_phone: '919811111111',
        status: 'won',
        inquiry_type: 'inquiry',
        raw_text: 'Closed',
        created_at: '2026-10-19T04:00:00.000Z',
        ai_extraction_json: { line_items: [{ ...line }] },
      },
    ],
    deals: [{
      id: HIDDEN_ID,
      inquiry_id: HIDDEN_ID,
      customer_name: 'Hidden Mills',
      salesperson_phone: '919811111111',
      stage: 'new_inquiry',
      payment_terms: '30 days',
      delivery_location: 'Pune',
      total_amount: 600000,
      created_at: '2026-10-21T04:00:00.000Z',
    }],
    deal_items: [{
      id: 'item-1',
      deal_id: HIDDEN_ID,
      sku_text: 'HR Coil',
      dimensions: '2 mm',
      quantity: 12,
      unit: 'MT',
      rate: 50000,
      amount: 600000,
    }],
  };
}

function harness() {
  return loadCatalogFlow({
    tables: seed(),
    scope: { isAdmin: false, isManager: false, phones: ['9811111111'] },
    llm: () => '{"action":"UPDATE_INQUIRY","updates":{}}',
  });
}

test('Update Inquiry includes a sender-only row and a customer-owner row', async () => {
  const h = harness();
  try {
    const records = await h.catalogFlow.fetchEditableRecordsForModule('UPDATE_INQUIRY', SENDER);
    const names = records.map((row) => row.customer_name);
    assert.ok(names.includes('Hidden Mills'));
    assert.ok(names.includes('Acme Steel'));
    assert.equal(names.includes('Other Mills'), false);
    assert.equal(names.includes('Closed Mills'), true);
    assert.equal(records.find((row) => row.customer_name === 'Hidden Mills').displayId, 'INQ-CCBE2A');
  } finally {
    h.restore();
  }
});

test('an INQ code opens that inquiry from the menu and from a sentence', async () => {
  const h = harness();
  try {
    const state = { page: 1, totalCount: 0, cachedRecords: [], customerFilter: null };
    const opened = await h.catalogFlow.handleUpdateSelectionState('INQ-CCBE2A', SENDER, 'UPDATE_INQUIRY', state);
    assert.equal(opened.handled, true);
    assert.match(opened.reply, /Hidden Mills/);
    assert.doesNotMatch(opened.reply, /No editable/i);

    const sentence = await h.catalogFlow.handleUpdateSelectionState(
      'update inquiry INQ-CCBE2A',
      SENDER,
      'UPDATE_INQUIRY',
      state,
    );
    assert.match(sentence.reply, /Hidden Mills/);
    assert.doesNotMatch(sentence.reply, /No editable/i);

    const missing = await h.catalogFlow.handleUpdateSelectionState('INQ-ZZZZZZ', SENDER, 'UPDATE_INQUIRY', state);
    assert.match(missing.reply, /No editable inquiry records found for "INQ-ZZZZZZ"/i);
    assert.doesNotMatch(missing.reply, /Other Mills|Acme Steel/);

    const found = await h.catalogFlow.checkInquiriesForUpdate(
      'UPDATE_INQUIRY',
      { inquiry_id: 'INQ-CCBE2A' },
      SENDER,
      'update inquiry INQ-CCBE2A',
    );
    assert.equal(found.draft.company_name, 'Hidden Mills');
    assert.notEqual(found.status, 'ID_NOT_FOUND');
  } finally {
    h.restore();
  }
});

test('a Price Ready quantity change reopens Awaiting Price and leaves the deal stage', async () => {
  const h = harness();
  setMockPermissions(SENDER, builtinFor('salesperson'));
  try {
    const reply = await h.catalogFlow.executeAction('UPDATE_INQUIRY', {
      inquiry_id: HIDDEN_ID,
      company_name: 'Hidden Mills',
      line_item_updates: [{ quantity: 18, sku_text: 'HR Coil' }],
    }, SENDER);
    assert.doesNotMatch(String(reply), /Could not find/i);
    const inquiry = h.db.store.inquiries.find((row) => row.id === HIDDEN_ID);
    const deal = h.db.store.deals.find((row) => row.id === HIDDEN_ID);
    assert.equal(inquiry.pricing_status, 'awaiting_price');
    assert.equal(inquiry.tonnage_review_open, true);
    assert.equal(inquiry.ai_extraction_json.line_items[0].quantity, 18);
    assert.equal(inquiry.ai_extraction_json.line_items[0].original_unit, 'MT');
    assert.equal(deal.stage, 'new_inquiry');
  } finally {
    h.restore();
    invalidateBotPermissions();
  }
});

test('a weight change does not copy Price Quote onto the inquiry', async () => {
  const db = createSupabaseMock({
    tables: {
      inquiries: [{
        id: HIDDEN_ID,
        pricing_status: 'price_ready',
        sender_name: 'Hidden Mills',
        stage: 'new_inquiry',
        status: 'review',
        ai_extraction_json: { line_items: [{ ...line }] },
      }],
    },
  });
  const loaded = loadWithMocks('agents/salesAgent', {
    supabase: {
      supabase: db.client,
      verifyAndGetCustomerName: async () => null,
      saveActiveSession: async () => {},
      getActiveSession: async () => null,
    },
  });
  try {
    await loaded.mod.syncInquiryFromDeal(
      HIDDEN_ID,
      { customer_name: 'Hidden Mills', stage: 'quoted' },
      [{ sku_text: 'HR Coil', quantity: 18, unit: 'MT', rate: 50000, dimensions: '2 mm' }],
    );
    const row = db.store.inquiries[0];
    assert.equal(row.pricing_status, 'awaiting_price');
    assert.equal(row.tonnage_review_open, true);
    assert.equal(row.stage, 'new_inquiry');
    assert.equal(row.ai_extraction_json.line_items[0].original_unit, 'MT');
    assert.equal(row.ai_extraction_json.line_items[0].quantity, 18);
  } finally {
    loaded.restore();
  }
});

test('a kilogram quantity that is the same weight does not reopen, and a manual weight stays', () => {
  const before = [{ ...line, quantity: 1, original_quantity: 1 }];
  const same = applyCommercialLines(before, [{ sku_text: 'HR Coil', quantity: 1000, unit: 'KG' }]);
  assert.equal(same[0].original_unit, 'KG');
  assert.equal(tonnageReviewPatch({
    pricingStatus: 'price_ready',
    beforeLines: before,
    afterLines: same,
  }), null);

  const pieces = [{
    sku_text: 'Plate',
    quantity: 10,
    unit: 'nos',
    original_unit: 'nos',
    is_manual_mt: true,
    converted_mt: 4,
  }];
  const counted = applyCommercialLines(pieces, [{ sku_text: 'Plate', quantity: 12, unit: 'nos' }]);
  assert.equal(counted[0].is_manual_mt, true);
  assert.equal(counted[0].converted_mt, 4);
  assert.equal(tonnageReviewPatch({
    pricingStatus: 'price_ready',
    beforeLines: pieces,
    afterLines: counted,
  }), null);
});

test('Update Inquiry lists seven rows, paginates, and includes terminal statuses', async () => {
  const tables = seed();
  for (let index = 0; index < 4; index += 1) {
    tables.inquiries.push({
      id: `page-${index}-1111-2222-3333-444444444444`,
      sender_name: `Page Customer ${index}`,
      sender_phone: SENDER,
      salesperson_phone: SENDER,
      status: index === 0 ? 'won' : index === 1 ? 'lost' : 'new_inquiry',
      inquiry_type: 'inquiry',
      raw_text: `Page ${index}`,
      created_at: `2026-10-${String(10 - index).padStart(2, '0')}T04:00:00.000Z`,
      ai_extraction_json: { line_items: [{ ...line, sku_text: `Page Wire ${index}` }] },
    });
  }
  const h = loadCatalogFlow({
    tables,
    scope: { isAdmin: false, isManager: false, phones: ['9811111111'] },
    llm: () => '{"action":"UPDATE_INQUIRY","updates":{}}',
  });
  try {
    const first = await h.catalogFlow.fetchAndRenderUpdateSelection('UPDATE_INQUIRY', SENDER, { page: 1 });
    assert.equal(first.hasRecords, true);
    assert.equal((first.reply.match(/INQ-/g) || []).length, 7);
    assert.match(first.reply, /Next/);
    assert.match(first.reply, /Won|Lost/);
    const second = await h.catalogFlow.fetchAndRenderUpdateSelection('UPDATE_INQUIRY', SENDER, { page: 2 });
    assert.ok((second.reply.match(/INQ-/g) || []).length >= 1);
    assert.match(second.reply, /Page Customer/);
  } finally {
    h.restore();
  }
});
