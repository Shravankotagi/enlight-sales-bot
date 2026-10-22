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
  visitOtpTemplatePayload,
  addressFromNominatim,
  addressFromGoogleGeocode,
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

const futureFollowUp = calendarShift(7);

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
    follow_up_date: futureFollowUp.dmy,
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
  assert.ok(prompts.some((item) => item.includes('Share a WhatsApp location pin.')));

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
  let sentPayload = null;
  const sent = await requestVisitCode(db.client, '9822012345', async (_to, payload) => {
    sentPayload = payload;
  });
  assert.equal(sent.ok, true);
  assert.equal(sentPayload.type, 'template');
  const otp = sentPayload.template.components[0].parameters[0].text;
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
  assert.equal(visits[0].follow_up_date, futureFollowUp.iso);
  assert.equal(readyForCode.follow_up_date, futureFollowUp.dmy);
  assert.equal(visits.length, 1);
});

test('sends the visit code as an authentication template', () => {
  const payload = visitOtpTemplatePayload(
    '919822012345',
    '123456',
    'visit_verification_code',
  );
  assert.equal(payload.type, 'template');
  assert.equal(payload.template.name, 'visit_verification_code');
  assert.equal(payload.template.language.code, 'en');
  assert.equal(payload.template.components[0].parameters[0].text, '123456');
  assert.equal(payload.template.components[1].parameters[0].text, '123456');
  assert.equal(payload.text, undefined);
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
  assert.equal(
    addressFromNominatim({
      display_name: 'Pune, Maharashtra, India',
      name: 'Phoenix Marketcity',
      address: {
        building: 'Phoenix Marketcity',
        road: 'Nagar Road',
        city: 'Pune',
        state: 'Maharashtra',
      },
    }),
    'Phoenix Marketcity, Nagar Road, Pune, Maharashtra',
  );
  assert.equal(
    addressFromNominatim({
      address: {
        pedestrian: 'Laxmi Road',
        city: 'Pune',
      },
    }),
    'Laxmi Road, Pune',
  );
});

test('reads a building and street from a Google geocode response', () => {
  const girgaon = {
    results: [
      {
        formatted_address:
          'Girgaon, D Ward, Mumbai Zone 1, Mumbai City District, Maharashtra, 400004, India',
        types: ['neighborhood', 'political'],
        address_components: [
          { long_name: 'Girgaon', types: ['neighborhood', 'political'] },
          { long_name: 'Mumbai', types: ['locality', 'political'] },
        ],
      },
      {
        formatted_address:
          'Girgaon Court, 12, Girgaon Road, Girgaon, Mumbai, Maharashtra 400004, India',
        types: ['premise', 'street_address'],
        geometry: { location_type: 'ROOFTOP' },
        address_components: [
          { long_name: 'Girgaon Court', types: ['premise'] },
          { long_name: '12', types: ['street_number'] },
          { long_name: 'Girgaon Road', types: ['route'] },
          { long_name: 'Girgaon', types: ['sublocality_level_1', 'sublocality'] },
          { long_name: 'Mumbai', types: ['locality', 'political'] },
          { long_name: 'Maharashtra', types: ['administrative_area_level_1', 'political'] },
          { long_name: '400004', types: ['postal_code'] },
        ],
      },
    ],
  };
  assert.equal(
    addressFromGoogleGeocode(girgaon),
    'Girgaon Court, 12 Girgaon Road, Girgaon, Mumbai, Maharashtra, 400004',
  );
  assert.equal(
    addressFromGoogleGeocode({
      results: [
        {
          formatted_address: 'Girgaon Road, Girgaon, Mumbai, Maharashtra 400004, India',
          types: ['route'],
          address_components: [
            { long_name: 'Girgaon Road', types: ['route'] },
            { long_name: 'Girgaon', types: ['neighborhood'] },
            { long_name: 'Mumbai', types: ['locality'] },
            { long_name: 'Maharashtra', types: ['administrative_area_level_1'] },
            { long_name: '400004', types: ['postal_code'] },
          ],
        },
      ],
    }),
    'Girgaon Road, Girgaon, Mumbai, Maharashtra, 400004',
  );
  assert.equal(
    addressFromGoogleGeocode({
      results: [
        {
          formatted_address: 'Mumbai, Maharashtra, India',
          types: ['locality', 'political'],
          address_components: [
            { long_name: 'Mumbai', types: ['locality'] },
            { long_name: 'Maharashtra', types: ['administrative_area_level_1'] },
          ],
        },
      ],
    }),
    'Mumbai, Maharashtra, India',
  );
});

test('a day-first follow-up date is stored as a calendar date', () => {
  const fifth = visitRowColumns(completeDraft({ follow_up_date: '05-10-2026' }));
  assert.equal(fifth.follow_up_date, '2026-10-05');
  const existing = visitRowColumns(completeDraft({ follow_up_date: '2026-10-20' }));
  assert.equal(existing.follow_up_date, '2026-10-20');
});
