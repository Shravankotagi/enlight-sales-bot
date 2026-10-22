const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCatalogFlow } = require('./helpers/catalogFlowHarness');

test('inquiry payment terms and brands accept only the listed options, including close typos', () => {
  const { matchInquiryOption, pickInquiryOptionFromReply } = loadCatalogFlow().catalogFlow;
  const terms = ['Immediate', 'Advance', '30 Days', '45 Days', '60 Days', 'LC', 'BG', 'PDC'];
  const termsWith90 = ['Immediate', 'Advance', '30 Days', '45 Days', '60 Days', '90 Days', 'LC', 'BG', 'PDC'];
  const makes = ['TATA', 'JSW', 'AM/NS India', 'SAIL', 'NMDC', 'Apollo', 'Others'];

  assert.equal(matchInquiryOption('Imedite', terms), 'Immediate');
  assert.equal(matchInquiryOption('30 days credit', terms), '30 Days');
  assert.equal(matchInquiryOption('LC', terms), 'LC');
  assert.equal(matchInquiryOption('net 90', terms), null);
  assert.equal(matchInquiryOption('cash', terms), null);

  // 90 days must NEVER fuzzy match to 30 days
  assert.equal(matchInquiryOption('90 days', terms), null);
  assert.equal(matchInquiryOption('90 dyas', terms), null);

  // 90 days must match cleanly when in the options list, even with typo "dyas"
  assert.equal(matchInquiryOption('90 days', termsWith90), '90 Days');
  assert.equal(matchInquiryOption('90 dyas', termsWith90), '90 Days');
  assert.equal(matchInquiryOption('90 days credit', termsWith90), '90 Days');

  // Multi-item comma-separated replies must detect payment terms chunk
  const commaReply = 'Rajesh company industry, xyz@gmail.com,HR plate 3*250*2500,90 days,satara';
  assert.equal(pickInquiryOptionFromReply(commaReply, termsWith90), '90 Days');

  assert.equal(matchInquiryOption('apolo', makes), 'Apollo');
  assert.equal(matchInquiryOption('AM/NS', makes), 'AM/NS India');
  assert.equal(matchInquiryOption('SAILMA', makes), null);
  assert.equal(matchInquiryOption('tata steel and jsw', makes), null);
});
