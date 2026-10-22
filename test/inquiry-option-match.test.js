const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCatalogFlow } = require('./helpers/catalogFlowHarness');

test('inquiry payment terms and brands accept only the listed options, including close typos', () => {
  const { matchInquiryOption, formatMissingFieldItem, formatMissingFieldBullet, INQUIRY_PAYMENT_TERMS } = loadCatalogFlow().catalogFlow;
  const terms = INQUIRY_PAYMENT_TERMS || ['Immediate', 'Advance', '30 Days', '45 Days', '60 Days', 'LC', 'BG', 'PDC'];
  const makes = ['TATA', 'JSW', 'AM/NS India', 'SAIL', 'NMDC', 'Apollo', 'Others'];

  // Valid terms and aliases
  assert.equal(matchInquiryOption('Imedite', terms), 'Immediate');
  assert.equal(matchInquiryOption('immediate', terms), 'Immediate');
  assert.equal(matchInquiryOption('advance', terms), 'Advance');
  assert.equal(matchInquiryOption('30', terms), '30 Days');
  assert.equal(matchInquiryOption('30 days', terms), '30 Days');
  assert.equal(matchInquiryOption('30 days credit', terms), '30 Days');
  assert.equal(matchInquiryOption('45', terms), '45 Days');
  assert.equal(matchInquiryOption('45 days', terms), '45 Days');
  assert.equal(matchInquiryOption('60', terms), '60 Days');
  assert.equal(matchInquiryOption('60 days', terms), '60 Days');
  assert.equal(matchInquiryOption('LC', terms), 'LC');
  assert.equal(matchInquiryOption('BG', terms), 'BG');
  assert.equal(matchInquiryOption('PDC', terms), 'PDC');

  // Invalid terms must NEVER match or fabricate
  assert.equal(matchInquiryOption('90 days', terms), null, '90 days must not match 30 Days');
  assert.equal(matchInquiryOption('90', terms), null, '90 must not match 30 Days');
  assert.equal(matchInquiryOption('15 days', terms), null, '15 days must not match 45 Days');
  assert.equal(matchInquiryOption('20 days', terms), null);
  assert.equal(matchInquiryOption('10 days', terms), null);
  assert.equal(matchInquiryOption('50 days', terms), null);
  assert.equal(matchInquiryOption('75 days', terms), null);
  assert.equal(matchInquiryOption('net 90', terms), null);
  assert.equal(matchInquiryOption('cash', terms), null);
  assert.equal(matchInquiryOption('credit', terms), null);

  // Preferred brands
  assert.equal(matchInquiryOption('apolo', makes), 'Apollo');
  assert.equal(matchInquiryOption('AM/NS', makes), 'AM/NS India');
  assert.equal(matchInquiryOption('SAILMA', makes), null);
  assert.equal(matchInquiryOption('tata steel and jsw', makes), null);

  // Formatting helpers for missing fields prompt
  assert.equal(
    formatMissingFieldItem('Payment Terms', '-'),
    '- **Payment Terms: Immediate, Advance, 30 Days, 45 Days, 60 Days, LC, BG, PDC**'
  );
  assert.equal(
    formatMissingFieldBullet('Payment Terms'),
    '• *Payment Terms: Immediate, Advance, 30 Days, 45 Days, 60 Days, LC, BG, PDC*'
  );
});
