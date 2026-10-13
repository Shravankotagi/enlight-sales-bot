const test = require('node:test');
const assert = require('node:assert/strict');

const catalogFlow = require('../../src/core/catalogFlow');

test('matchActionFromInput maps menu numbers, ids and phrases to actions', () => {
  assert.equal(catalogFlow.matchActionFromInput('1'), 'LOG_INQUIRY');
  assert.equal(catalogFlow.matchActionFromInput('menu_2'), 'UPDATE_INQUIRY');
  assert.equal(catalogFlow.matchActionFromInput('Log Order'), 'LOG_ORDER');
  assert.equal(catalogFlow.matchActionFromInput('update order'), 'UPDATE_ORDER');
  assert.equal(catalogFlow.matchActionFromInput('field visit'), 'LOG_VISIT');
  assert.equal(catalogFlow.matchActionFromInput('10'), 'GENERAL_QUERY');
  assert.equal(catalogFlow.matchActionFromInput('hello'), null);
});

test('bare numbers are field input, not menu selections, inside an active flow', () => {
  assert.equal(catalogFlow.matchActionFromInput('1', true), null);
  assert.equal(catalogFlow.isExplicitMenuSelection('1', true, true), null);
  assert.equal(catalogFlow.isExplicitMenuSelection('menu_2', true, true), 'UPDATE_INQUIRY');
});

test('validateMandatoryFields lists missing inquiry fields', () => {
  assert.deepEqual(catalogFlow.validateMandatoryFields('LOG_INQUIRY', {}), [
    'Company Name',
    'Product Description / Quantity',
    'Payment Terms',
    'Delivery Location',
  ]);
});

test('validateMandatoryFields lists missing new-customer fields', () => {
  assert.deepEqual(catalogFlow.validateMandatoryFields('LOG_NEW_CUSTOMER', {}), [
    'Company Name',
    'Contact Person',
    'Mobile Number',
    'Delivery Location',
  ]);
  assert.deepEqual(
    catalogFlow.validateMandatoryFields('LOG_NEW_CUSTOMER', {
      company_name: 'Acme Steel',
      contact_person: 'Ravi',
      mobile_number: '9876543210',
      delivery_location: 'Pune',
    }),
    [],
  );
});

test('mergeDraft fills missing fields and lets new values win', () => {
  assert.deepEqual(
    catalogFlow.mergeDraft('LOG_INQUIRY', { company_name: 'A', payment_terms: null }, { payment_terms: '30 days', company_name: null }),
    { company_name: 'A', payment_terms: '30 days', action: 'LOG_INQUIRY' },
  );
  assert.equal(catalogFlow.mergeDraft('LOG_INQUIRY', { company_name: 'A' }, { company_name: 'B' }).company_name, 'B');
});

test('buildConfirmationSummary lists captured new-customer fields', () => {
  const summary = catalogFlow.buildConfirmationSummary('LOG_NEW_CUSTOMER', {
    company_name: 'Acme Steel',
    contact_person: 'Ravi',
    mobile_number: '9876543210',
    delivery_location: 'Pune',
  });
  assert.match(summary, /Company Name:\* Acme Steel/);
  assert.match(summary, /Contact Person:\* Ravi/);
  assert.match(summary, /Delivery Location:\* Pune/);
});

test('isDiscardOrCancelIntent recognizes discard buttons and phrases only', () => {
  for (const text of ['btn_confirm_cancel', 'cancel', 'Discard', 'discard draft', 'Cancel draft']) {
    assert.equal(catalogFlow.isDiscardOrCancelIntent(text), true, text);
  }
  for (const text of ['Dynamic Industries', 'MS Plate 10mm', '30 days credit', '']) {
    assert.equal(catalogFlow.isDiscardOrCancelIntent(text), false, text);
  }
});

test('stale button helpers recognize their button ids', () => {
  assert.equal(catalogFlow.isStaleDraftButtonAction('btn_confirm_yes'), true);
  assert.equal(catalogFlow.isStaleDraftButtonAction('hello'), false);
  assert.equal(catalogFlow.isStaleResumeNoAction('btn_resume_no'), true);
});

test('cleanLegalSuffixes strips company legal suffixes', () => {
  assert.equal(catalogFlow.cleanLegalSuffixes('Dynamic Industries Pvt Ltd'), 'dynamic industries');
  assert.equal(catalogFlow.cleanLegalSuffixes('ABC Steel Private Limited'), 'abc steel');
});
