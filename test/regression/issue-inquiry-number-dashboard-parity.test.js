/**
 * Regression: Update Inquiry showed a different inquiry code and a smaller
 * set than the salesperson dashboard. The dashboard code is the first six
 * characters of the inquiry id, and the list includes the same genuine rows.
 * Issue: <add GitHub issue link>
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCatalogFlow } = require('../helpers/catalogFlowHarness');

const SENDER = '919811111111';
const DASH_ID = 'ab-c12def-9999-aaaa-bbbbbbbbbbbb';
const NULL_ID = 'c7b9f811-1111-4111-8111-111111111111';
const PO_TYPE_ID = 'f57702bb-2222-4222-8222-222222222222';
const PO_TEXT_ID = '029376cc-3333-4333-8333-333333333333';
const OTHER_ID = '6bf9a5dd-4444-4444-8444-444444444444';
const DEAL_ONLY_ID = 'zz-only-9999-aaaa-bbbb-cccccccccccc';

function inquiry(overrides) {
  return {
    sender_phone: SENDER,
    salesperson_phone: SENDER,
    status: 'new_inquiry',
    stage: 'new_inquiry',
    inquiry_type: 'inquiry',
    source_channel: 'dashboard',
    raw_text: 'HR Coil 10 MT',
    ai_extraction_json: { line_items: [{ sku_text: 'HR Coil', quantity: 10, unit: 'MT' }] },
    ...overrides,
  };
}

function seed() {
  const inquiries = [
    inquiry({
      id: DASH_ID,
      sender_name: 'Dash Mills',
      procurement_number: 'PR-10268',
      created_at: '2026-10-28T05:00:00.000Z',
    }),
    inquiry({
      id: NULL_ID,
      sender_name: 'Null Type Mills',
      procurement_number: 'PR-10267',
      inquiry_type: null,
      created_at: '2026-10-27T05:00:00.000Z',
    }),
    inquiry({
      id: PO_TYPE_ID,
      sender_name: 'Purchase Mills',
      procurement_number: 'PR-10266',
      inquiry_type: 'purchase_order',
      created_at: '2026-10-26T05:00:00.000Z',
    }),
    inquiry({
      id: PO_TEXT_ID,
      sender_name: 'Po Text Mills',
      procurement_number: 'PR-10265',
      raw_text: 'PO Number: 55 HR Coil 10 MT',
      created_at: '2026-10-25T05:00:00.000Z',
    }),
    inquiry({
      id: OTHER_ID,
      sender_name: 'Stranger Mills',
      sender_phone: '919222222222',
      salesperson_phone: '919222222222',
      procurement_number: 'PR-10264',
      created_at: '2026-10-28T06:00:00.000Z',
    }),
  ];
  for (let index = 0; index < 4; index += 1) {
    inquiries.push(inquiry({
      id: `older${index}11-1111-4111-8111-111111111111`,
      sender_name: `Older Mills ${index}`,
      procurement_number: `PR-1020${index}`,
      created_at: `2026-10-0${index + 1}T05:00:00.000Z`,
    }));
  }
  return {
    employees: [],
    recurring_customers: [],
    inquiries,
    deals: [{
      id: DEAL_ONLY_ID,
      inquiry_id: null,
      customer_name: 'Standalone Deal',
      salesperson_phone: SENDER,
      stage: 'new_inquiry',
      created_at: '2026-10-28T08:00:00.000Z',
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

test('Update Inquiry uses the dashboard inquiry code, procurement number, and row set', async () => {
  const h = harness();
  try {
    const page = await h.catalogFlow.fetchAndRenderUpdateSelection('UPDATE_INQUIRY', SENDER, { page: 1 });
    assert.equal(page.hasRecords, true);
    assert.match(page.reply, /1\. PR-10268 \| INQ-AB-C12 \| Dash Mills \|/);
    assert.doesNotMatch(page.reply, /INQ-ABC12D/);
    assert.match(page.reply, /Null Type Mills/);
    assert.match(page.reply, /Purchase Mills/);
    assert.match(page.reply, /Po Text Mills/);
    assert.doesNotMatch(page.reply, /Stranger Mills/);
    assert.doesNotMatch(page.reply, /Standalone Deal/);
    assert.doesNotMatch(page.reply, /INQ-ZZONLY|INQ-ZZ-ONL/);
    assert.match(page.reply, /1–7 of 8/);
    const newest = page.reply.indexOf('PR-10268');
    const next = page.reply.indexOf('PR-10267');
    assert.ok(newest >= 0 && next > newest);

    const state = { page: 1, totalCount: 8, cachedRecords: [], customerFilter: null };
    const byCode = await h.catalogFlow.handleUpdateSelectionState('INQ-AB-C12', SENDER, 'UPDATE_INQUIRY', state);
    assert.match(byCode.reply, /Dash Mills/);
    assert.match(byCode.reply, /INQ-AB-C12/);
    assert.doesNotMatch(byCode.reply, /INQ-ABC12D/);

    const byPr = await h.catalogFlow.handleUpdateSelectionState('PR-10268', SENDER, 'UPDATE_INQUIRY', state);
    assert.match(byPr.reply, /Dash Mills/);
    assert.match(byPr.reply, /INQ-AB-C12/);

    const pasted = await h.catalogFlow.handleUpdateSelectionState(
      'PR-10268 | INQ-AB-C12 | Dash Mills | 10 MT HR Coil | New Inquiry | 28-10-2026',
      SENDER,
      'UPDATE_INQUIRY',
      state,
    );
    assert.match(pasted.reply, /Dash Mills/);
    assert.match(pasted.reply, /INQ-AB-C12/);
    assert.doesNotMatch(pasted.reply, /No editable/i);
  } finally {
    h.restore();
  }
});
