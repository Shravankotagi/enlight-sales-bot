// Issue: <add GitHub issue link>
// A new visit cannot use a past next purchase date or follow-up date.
const test = require('node:test');
const assert = require('node:assert/strict');
const { nextVisitPrompts } = require('../../src/core/visitRequirements');

function calendarShift(days) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const year = Number(parts.find((part) => part.type === 'year').value);
  const month = Number(parts.find((part) => part.type === 'month').value);
  const day = Number(parts.find((part) => part.type === 'day').value);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return { iso: `${y}-${m}-${d}`, dmy: `${d}-${m}-${y}` };
}

function completeDraft(overrides = {}) {
  const today = calendarShift(0);
  return {
    company_name: 'Acme',
    person_met: 'Ravi',
    designation: 'Buyer',
    contact_phone: '9822012345',
    email: 'ravi@acme.com',
    city_location: 'Pune',
    visit_date: '15-10-2026',
    customer_type: 'OEM',
    visit_type: 'First Visit',
    visit_outcome: 'Positive',
    customer_probability: 'Hot',
    product_details: 'HR Coil',
    monthly_consumption: '50 MT',
    current_requirement: '10 MT',
    next_purchase_expected: today.dmy,
    delivery_location: 'Chakan',
    preferred_make: 'TATA',
    payment_terms: '30 days credit',
    followup_action: 'Send quote',
    follow_up_date: today.dmy,
    meeting_remarks: 'Discussed rates',
    gps_photo_url: 'data:image/jpeg;base64,abc',
    gps_latitude: 18.52,
    gps_longitude: 73.86,
    verification_token: 'token',
    ...overrides,
  };
}

test('a past next purchase or follow-up is still missing', () => {
  const yesterday = calendarShift(-1);
  const today = calendarShift(0);
  const pastPurchase = nextVisitPrompts(completeDraft({
    next_purchase_expected: yesterday.dmy,
    follow_up_date: today.dmy,
  }));
  assert.ok(pastPurchase.includes('Next Purchase Expected (today or later)'));
  assert.equal(pastPurchase.some((item) => item.includes('Follow-up Date')), false);

  const pastFollowUp = nextVisitPrompts(completeDraft({
    next_purchase_expected: today.iso,
    follow_up_date: yesterday.iso,
  }));
  assert.ok(pastFollowUp.includes('Follow-up Date (today or later, e.g. tomorrow or DD-MM-YYYY)'));
  assert.equal(pastFollowUp.some((item) => item.includes('Next Purchase')), false);
});

test('today is enough for the next purchase and follow-up', () => {
  const today = calendarShift(0);
  const prompts = nextVisitPrompts(completeDraft({
    next_purchase_expected: today.iso,
    follow_up_date: today.dmy,
  }));
  assert.equal(prompts.some((item) => item.includes('Next Purchase')), false);
  assert.equal(prompts.some((item) => item.includes('Follow-up Date')), false);
});
