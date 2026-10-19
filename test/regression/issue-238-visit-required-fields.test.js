const test = require('node:test');
const assert = require('node:assert/strict');
const { createSupabaseMock } = require('../helpers/supabaseMock');
const { loadCatalogFlow } = require('../helpers/catalogFlowHarness');
const {
  nextVisitPrompts,
  assertReadyToSave,
  visitRowColumns,
  requestVisitCode,
  verifyVisitCode,
  addressFromNominatim,
} = require('../../src/core/visitRequirements');

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
    preferred_make: 'TATA, Others',
    preferred_make_other: 'Local mill',
    payment_terms: '30 days credit',
    followup_action: 'Send quote',
    follow_up_date: '20-10-2026',
    meeting_remarks: 'Discussed rates',
    gps_photo_url: 'data:image/jpeg;base64,abc',
    gps_latitude: 18.5,
    gps_longitude: 73.8,
    ...overrides,
  };
}

test('follow-up required is not a visit outcome', () => {
  const prompts = nextVisitPrompts(completeDraft({ visit_outcome: 'Follow-up Required' }));
  assert.ok(prompts.some((item) => item.includes('Visit Outcome: Positive, Neutral, Negative')));
  assert.equal(prompts.some((item) => item.includes('Follow-up Required')), false);
});

test('a new visit asks for every missing field together', () => {
  const prompts = nextVisitPrompts({});
  assert.ok(prompts.some((item) => item.includes('Customer / Company Name')));
  assert.ok(prompts.some((item) => item.includes('Email')));
  assert.ok(prompts.some((item) => item.includes('Payment Terms')));
  assert.ok(prompts.some((item) => item.includes('Visit photo')));
  assert.ok(prompts.some((item) => item.includes('Location pin or city')));

  const remaining = nextVisitPrompts(completeDraft({ email: '', payment_terms: '' }));
  assert.deepEqual(remaining, ['Email', 'Payment Terms: Immediate, Advance, 30 Days, 45 Days, 60 Days, LC, BG, PDC']);
});

test('LOG_VISIT validation asks for every missing field together', (t) => {
  const h = loadCatalogFlow();
  t.after(h.restore);
  const missing = h.catalogFlow.validateMandatoryFields('LOG_VISIT', {});
  assert.ok(missing.some((item) => item.includes('Customer / Company Name')));
  assert.ok(missing.some((item) => item.includes('Payment Terms')));
  assert.ok(missing.some((item) => item.includes('Visit photo')));
});

test('a visit is not inserted until the fields, photo, and correct code are present', async () => {
  const visits = [];
  const saveIfReady = (draft) => {
    const ready = assertReadyToSave(draft);
    if (!ready.ok) return false;
    visits.push(visitRowColumns(draft));
    return true;
  };

  const partial = completeDraft({ gps_photo_url: '', gps_latitude: null, gps_longitude: null, city_location: '' });
  assert.equal(saveIfReady(partial), false);
  assert.ok(nextVisitPrompts(partial).some((item) => item.includes('Visit photo')));

  const readyForCode = completeDraft();
  const blocked = assertReadyToSave(readyForCode);
  assert.equal(blocked.ok, false);
  assert.match(blocked.message, /visit code/);
  assert.equal(saveIfReady(readyForCode), false);

  const db = createSupabaseMock({ tables: { visit_phone_verifications: [] } });
  let sentBody = '';
  const sent = await requestVisitCode(db.client, '9822012345', async (_to, body) => {
    sentBody = body;
  });
  assert.equal(sent.ok, true);
  const otp = sentBody.match(/\*(\d{6})\*/)[1];
  const wrongCode = otp === '000000' ? '111111' : '000000';
  const wrong = await verifyVisitCode(db.client, '98220 12345', wrongCode);
  assert.equal(wrong.ok, false);
  assert.equal(db.store.visit_phone_verifications[0].consumed_at, undefined);
  assert.equal(saveIfReady(readyForCode), false);

  const verified = await verifyVisitCode(db.client, '9822012345', otp);
  assert.equal(verified.ok, true);
  readyForCode.verification_token = verified.token;
  assert.equal(saveIfReady(readyForCode), true);
  assert.equal(visits[0].phone_verified, true);
  assert.equal(visits[0].location_source, 'gps');
  assert.equal(visits[0].preferred_make, 'TATA, Others');
  assert.equal(visits[0].preferred_make_other, 'Local mill');
  assert.equal(visits[0].payment_terms, '30 Days');
  assert.equal(visits[0].follow_up_date, '2026-10-20');
  assert.equal(readyForCode.follow_up_date, '20-10-2026');
  assert.equal(visits.length, 1);
});

test('reads a full address from a reverse-geocode response', () => {
  assert.equal(
    addressFromNominatim({
      display_name: '12, MG Road, Camp, Pune, Maharashtra, 411001, India',
      address: { city: 'Pune' },
    }),
    '12, MG Road, Camp, Pune, Maharashtra, 411001, India',
  );
  assert.equal(
    addressFromNominatim({
      address: {
        house_number: '12',
        road: 'MG Road',
        suburb: 'Camp',
        city: 'Pune',
        state: 'Maharashtra',
        postcode: '411001',
      },
    }),
    '12, MG Road, Camp, Pune, Maharashtra, 411001',
  );
  assert.equal(addressFromNominatim({ address: {} }), '');
});

test('a day-first follow-up date is stored as a calendar date', () => {
  const fifth = visitRowColumns(completeDraft({ follow_up_date: '05-10-2026' }));
  assert.equal(fifth.follow_up_date, '2026-10-05');
  const existing = visitRowColumns(completeDraft({ follow_up_date: '2026-10-20' }));
  assert.equal(existing.follow_up_date, '2026-10-20');
});
