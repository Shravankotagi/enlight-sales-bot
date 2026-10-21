const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCatalogFlow } = require('./helpers/catalogFlowHarness');

test('inquiry payment terms and brands accept only the listed options, including close typos', () => {
  const { matchInquiryOption } = loadCatalogFlow().catalogFlow;
  const terms = ['Immediate', 'Advance', '30 Days', '45 Days', '60 Days', 'LC', 'BG', 'PDC'];
  const makes = ['TATA', 'JSW', 'AM/NS India', 'SAIL', 'NMDC', 'Apollo', 'Others'];

  assert.equal(matchInquiryOption('Imedite', terms), 'Immediate');
  assert.equal(matchInquiryOption('30 days credit', terms), '30 Days');
  assert.equal(matchInquiryOption('LC', terms), 'LC');
  assert.equal(matchInquiryOption('net 90', terms), null);
  assert.equal(matchInquiryOption('cash', terms), null);

  assert.equal(matchInquiryOption('apolo', makes), 'Apollo');
  assert.equal(matchInquiryOption('AM/NS', makes), 'AM/NS India');
  assert.equal(matchInquiryOption('SAILMA', makes), null);
  assert.equal(matchInquiryOption('tata steel and jsw', makes), null);
});
