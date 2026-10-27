/**
 * Regression: a WhatsApp quantity change on a Price Ready inquiry did not
 * reopen it, and the procurement list did not say which one changed.
 * Issue: <add GitHub issue link>
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { tonnageReviewPatch } = require('../../src/core/tonnageReview');
const { createSupabaseMock } = require('../helpers/supabaseMock');
const { loadWithMocks } = require('../helpers/loadWithMocks');
const { handleProcurementChat } = require('../../src/core/procurementChat');

const person = {
  id: 'proc-a',
  name: 'Asha',
  phone: '9811111111',
  role: 'procurement_person',
  is_active: true,
};

test('a kilogram quantity that is already that weight in MT does not open a review', () => {
  const same = tonnageReviewPatch({
    pricingStatus: 'price_ready',
    beforeLines: [{ sku_text: 'HR Coil', quantity: 1, unit: 'MT' }],
    afterLines: [{ sku_text: 'HR Coil', quantity: 1000, unit: 'KG' }],
  });
  assert.equal(same, null);

  const changed = tonnageReviewPatch({
    pricingStatus: 'price_ready',
    beforeLines: [{ sku_text: 'HR Coil', quantity: 12, unit: 'MT' }],
    afterLines: [{ sku_text: 'HR Coil', quantity: 18, unit: 'MT' }],
    now: '2026-10-21T04:30:00.000Z',
  });
  assert.equal(changed.pricing_status, 'awaiting_price');
  assert.equal(changed.tonnage_review_open, true);
  assert.equal(changed.tonnage_review.previous_total_mt, 12);
  assert.equal(changed.tonnage_review.next_total_mt, 18);

  const manual = tonnageReviewPatch({
    pricingStatus: 'price_ready',
    beforeLines: [{ sku_text: 'HR Coil', quantity: 5000, unit: 'KG' }],
    afterLines: [{
      sku_text: 'HR Coil',
      quantity: 5000,
      unit: 'KG',
      is_manual_mt: true,
      converted_mt: 8,
    }],
  });
  assert.equal(manual.pricing_status, 'awaiting_price');
  assert.equal(manual.tonnage_review.previous_total_mt, 5);
  assert.equal(manual.tonnage_review.next_total_mt, 8);
});

test('a Price Ready quantity sync reopens the inquiry for procurement', async () => {
  const db = createSupabaseMock({
    tables: {
      inquiries: [{
        id: '11111111-1111-4111-8111-111111111111',
        pricing_status: 'price_ready',
        procurement_number: 'PR-10041',
        sender_name: 'Secret Mills',
        ai_extraction_json: {
          line_items: [{ sku_text: 'HR Coil', quantity: 12, unit: 'MT' }],
        },
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
      '11111111-1111-4111-8111-111111111111',
      { customer_name: 'Secret Mills' },
      [{ sku_text: 'HR Coil', quantity: 18, unit: 'MT', rate: 0 }],
    );
    const row = db.store.inquiries[0];
    assert.equal(row.pricing_status, 'awaiting_price');
    assert.equal(row.tonnage_review_open, true);
    assert.equal(row.tonnage_review.previous_total_mt, 12);
    assert.equal(row.tonnage_review.next_total_mt, 18);
  } finally {
    loaded.restore();
  }
});

test('the awaiting-price reply marks only an open tonnage review', async () => {
  const shared = {
    procurement_employee_id: 'proc-a',
    status: 'review',
    pricing_status: 'awaiting_price',
    salesperson_phone: '9844444444',
    delivery_location: 'Pune',
    ai_extraction_json: {
      line_items: [{ sku_text: 'HR Coil', quantity: 12, unit: 'MT' }],
    },
  };
  const db = createSupabaseMock({
    tables: {
      employees: [person, { id: 'sales-1', name: 'Ravi', phone: '9844444444', role: 'salesperson', is_active: true }],
      inquiries: [
        { ...shared, id: 'inq-flag', procurement_number: 'PR-20001', created_at: '2026-10-21T04:00:00.000Z', tonnage_review_open: true },
        { ...shared, id: 'inq-plain', procurement_number: 'PR-20002', created_at: '2026-10-20T04:00:00.000Z', tonnage_review_open: false },
      ],
      inquiry_line_pricing: [],
      recurring_customers: [],
    },
  });
  const listed = await handleProcurementChat('log a base price', person.phone, {
    supabase: db.client,
    getEmployeeByPhone: async () => person,
    getFullActiveSession: async () => null,
    loadCanonicalInquiries: async () => db.store.inquiries,
    saveActiveSession: async () => {},
  });
  const [flagged, plain] = listed.reply.split('*PR-20002*');
  assert.match(flagged, /Tonnage updated/);
  assert.doesNotMatch(plain, /Tonnage updated/);
});
