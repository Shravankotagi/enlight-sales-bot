const assert = require('assert');
const {
  mergeDraft,
  forwardCustomerDetailsToParentDraft,
  validateMandatoryFields,
} = require('../src/core/catalogFlow');

function run() {
  const initialVisit = {
    company_name: 'Test Co 1',
    city_location: 'Nashik',
    visit_outcome: 'Positive',
    customer_probability: 'Hot',
  };

  const remarksOnly = mergeDraft(
    'LOG_VISIT',
    initialVisit,
    {
      visit_outcome: 'Negative',
      meeting_remarks: 'nothing went right',
    },
    'nothing went right',
  );
  assert.strictEqual(
    remarksOnly.visit_outcome,
    'Positive',
    'Remarks must not overwrite an explicitly captured visit outcome',
  );
  assert.strictEqual(remarksOnly.customer_probability, 'Hot');
  assert.strictEqual(remarksOnly.meeting_remarks, 'nothing went right');

  const explicitOutcomeChange = mergeDraft(
    'LOG_VISIT',
    initialVisit,
    { visit_outcome: 'Negative' },
    'Visit Outcome: Negative',
  );
  assert.strictEqual(
    explicitOutcomeChange.visit_outcome,
    'Negative',
    'An explicitly supplied outcome must be accepted',
  );

  const remarksOnlyUpdate = mergeDraft(
    'UPDATE_VISIT',
    { company_name: 'Test Co 1', updates: {} },
    {
      updates: {
        visit_outcome: 'Negative',
        meeting_remarks: 'nothing went right',
      },
    },
    'nothing went right',
  );
  assert.strictEqual(
    remarksOnlyUpdate.updates.visit_outcome,
    undefined,
    'Remarks-only visit updates must not contain an inferred outcome update',
  );
  assert.strictEqual(remarksOnlyUpdate.updates.meeting_remarks, 'nothing went right');

  const cityOnlyParent = { city_location: 'Nashik' };
  forwardCustomerDetailsToParentDraft(
    'LOG_VISIT',
    cityOnlyParent,
    { company_name: 'Test Co 1' },
  );
  assert.strictEqual(
    cityOnlyParent.delivery_location,
    undefined,
    'A visit city must not populate delivery location during onboarding',
  );
  const onboardingMissing = validateMandatoryFields('LOG_NEW_CUSTOMER', {
    company_name: 'Test Co 1',
    contact_person: 'Test Co 1 Person',
    mobile_number: '7898767876',
    _parentDraft: cityOnlyParent,
  });
  assert(
    onboardingMissing.includes('Delivery Location'),
    'City-only onboarding must request a separate delivery location',
  );

  const explicitDeliveryParent = { city_location: 'Nashik' };
  forwardCustomerDetailsToParentDraft(
    'LOG_VISIT',
    explicitDeliveryParent,
    {
      company_name: 'Test Co 1',
      delivery_location: 'Bhosari Pune',
    },
  );
  assert.strictEqual(explicitDeliveryParent.city_location, 'Nashik');
  assert.strictEqual(explicitDeliveryParent.delivery_location, 'Bhosari Pune');

  console.log('Visit field authority tests passed.');
}

run();
