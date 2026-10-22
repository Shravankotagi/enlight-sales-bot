// Issue: <add GitHub issue link>
// A new visit's captured location cannot be changed on the confirmation or edit step.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { loadCatalogFlow } = require('../helpers/catalogFlowHarness');
const { preserveVisitLocation } = require('../../src/core/visitRequirements');

const lock = { lockVisitLocation: true };

test('a log visit edit cannot change the captured location', (t) => {
  const h = loadCatalogFlow();
  t.after(h.restore);
  const { detectNonEditableFieldAttempt, getAllowedFieldsListForAction } = h.catalogFlow;

  const location = detectNonEditableFieldAttempt('LOG_VISIT', 'change location to Pune', {}, lock);
  const city = detectNonEditableFieldAttempt('LOG_VISIT', 'city: Mumbai', {}, lock);
  const address = detectNonEditableFieldAttempt('LOG_VISIT', 'update the address', {}, lock);
  const hinglish = detectNonEditableFieldAttempt('LOG_VISIT', 'location badlo', {}, lock);
  assert.equal(location.isNonEditable, true);
  assert.equal(city.isNonEditable, true);
  assert.equal(address.isNonEditable, true);
  assert.equal(hinglish.isNonEditable, true);
  assert.match(location.message, /cannot be edited before the visit is saved/);

  const delivery = detectNonEditableFieldAttempt('LOG_VISIT', 'change delivery location to Chakan', {}, lock);
  const person = detectNonEditableFieldAttempt('LOG_VISIT', 'change person met to Amit', {}, lock);
  const duringCollection = detectNonEditableFieldAttempt('LOG_VISIT', 'change location to Pune', {});
  const savedVisit = detectNonEditableFieldAttempt('UPDATE_VISIT', 'change location to Pune', {}, lock);
  assert.equal(delivery.isNonEditable, false);
  assert.equal(person.isNonEditable, false);
  assert.equal(duringCollection.isNonEditable, false);
  assert.equal(savedVisit.isNonEditable, false);

  const allowed = getAllowedFieldsListForAction('LOG_VISIT');
  assert.equal(allowed.includes('City / Location'), false);
  assert.match(allowed, /Person Met/);
});

test('an edit keeps the captured visit address', () => {
  const original = {
    city_location: 'Enlight Office, Plot 12, Bhosari, Pune, Maharashtra 411026, India',
    gps_latitude: 18.63,
    gps_longitude: 73.8,
    location_source: 'gps',
  };
  const updated = {
    ...original,
    city_location: 'Mumbai',
    city: 'Mumbai',
    meeting_remarks: 'Discussed rates',
  };

  preserveVisitLocation(updated, original);

  assert.equal(updated.city_location, original.city_location);
  assert.equal(updated.gps_latitude, 18.63);
  assert.equal(updated.meeting_remarks, 'Discussed rates');
});
