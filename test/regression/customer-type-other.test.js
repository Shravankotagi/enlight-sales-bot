// Issue: <add GitHub issue link>
// Customer type Other requires the typed type and keeps it on the visit row.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  nextVisitPrompts,
  visitRowColumns,
} = require('../../src/core/visitRequirements');

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
    next_purchase_expected: '01-11-2026',
    delivery_location: 'Chakan',
    preferred_make: 'TATA',
    payment_terms: '30 days credit',
    followup_action: 'Send quote',
    follow_up_date: calendarShift(7).dmy,
    meeting_remarks: 'Discussed rates',
    gps_photo_url: 'data:image/jpeg;base64,abc',
    gps_latitude: 18.52,
    gps_longitude: 73.86,
    verification_token: 'token',
    ...overrides,
  };
}

test('customer type choices include Other', () => {
  const prompts = nextVisitPrompts(completeDraft({ customer_type: '' }));
  const customerType = prompts.find((prompt) => prompt.startsWith('Customer Type:'));
  assert.match(customerType, /\bOther\b/);
});

test('Other without a typed type is still missing', () => {
  const prompts = nextVisitPrompts(completeDraft({ customer_type: 'Other' }));
  assert.ok(prompts.includes('Other customer type'));
});

test('Other with a typed type is kept on the visit row', () => {
  const other = visitRowColumns(completeDraft({
    customer_type: 'Other',
    customer_type_other: 'Contractor',
  }));
  assert.equal(other.customer_type, 'Other');
  assert.equal(other.customer_type_other, 'Contractor');
  assert.equal(
    nextVisitPrompts(completeDraft({
      customer_type: 'Other',
      customer_type_other: 'Contractor',
    })).includes('Other customer type'),
    false,
  );

  const listed = visitRowColumns(completeDraft({
    customer_type: 'OEM',
    customer_type_other: 'Contractor',
  }));
  assert.equal(listed.customer_type, 'OEM');
  assert.equal(listed.customer_type_other, null);
});
