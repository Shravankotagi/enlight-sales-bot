const assert = require('assert');
const {
  formatSelectedComplaintPrompt,
  formatSelectedVisitPrompt,
} = require('../src/core/catalogFlow');

const complaint = {
  customer_name: 'Makwana Industries',
  complaint_date: '29-09-2026',
  raised_by: 'Rishabh',
  po_number: 'PO-6789',
  product_name: 'HR Coil',
  complaint_type: 'Specification Mismatch',
  challan_no: null,
  description: 'billing details are different',
  status: 'Open',
  resolution_notes: null,
};

const complaintCard = formatSelectedComplaintPrompt(complaint);
assert.match(complaintCard, /^\*Selected Customer Complaint: Makwana Industries\*/);
assert.match(complaintCard, /\*Complaint Details:\*/);
assert.match(complaintCard, /\*Fields to Update:\*/);
for (const field of [
  'Complaint Raised By',
  'Complaint Type',
  'Complaint Description',
  'Status',
  'Resolution Notes',
]) {
  assert.match(complaintCard, new RegExp(`\\*${field}\\*`));
}
assert.doesNotMatch(complaintCard, /What details would you like to update\?/);
assert.doesNotMatch(complaintCard, /You were in the middle of updating/);

const visitCard = formatSelectedVisitPrompt({
  customer_name: 'Test Co 1',
  person_met: 'Test Co 1 Person',
  contact_phone: '7898767876',
  location: 'Nashik',
  visit_date: '30-09-2026',
  outcome: 'Positive',
  remarks: 'Everything discussed',
});
assert.match(visitCard, /Test Co 1/);
assert.match(visitCard, /Which fields would you like to update\?/);

console.log('Update response format tests passed.');
