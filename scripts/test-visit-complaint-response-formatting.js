#!/usr/bin/env node

const assert = require('assert');
const {
  formatSelectedComplaintPrompt,
  formatSelectedRecordPrompt,
  formatVisitSelectionLine,
  formatComplaintSelectionLine,
} = require('../src/core/catalogFlow');

const visit = {
  customer_name: 'Acme Steel',
  date_formatted: '30-09-2026',
  person_met: 'Ramesh',
  location: 'Nashik',
  outcome: 'Positive',
};
const complaint = {
  customer_name: 'Acme Steel',
  complaint_date: '30-09-2026',
  raised_by: 'Ramesh',
  complaint_type: 'Physical Damage',
  description: 'Damaged coils',
  status: 'Open',
  resolution_notes: 'Pending review',
};

const visitLine = formatVisitSelectionLine(visit, 1);
assert.strictEqual(
  visitLine,
  '1. *Acme Steel* | Date: 30-09-2026 | Person: Ramesh | Location: Nashik | Outcome: Positive'
);

const complaintLine = formatComplaintSelectionLine(complaint, 1);
assert.strictEqual(
  complaintLine,
  '1. *Acme Steel* | Date: 30-09-2026 | Type: Physical Damage | Status: Open'
);

const complaintCard = formatSelectedComplaintPrompt(complaint);
assert.ok(complaintCard.startsWith('*Selected Customer Complaint: Acme Steel*'));
assert.ok(complaintCard.includes('• *Complaint Raised By:* Ramesh'));
assert.ok(complaintCard.includes('• *Complaint Type:* Physical Damage'));
assert.ok(complaintCard.includes('• *Description:* Damaged coils'));
assert.ok(complaintCard.includes('• *Status:* Open'));
assert.ok(complaintCard.includes('• *Resolution Notes:* Pending review'));

// Numeric and full-line selection paths must use the same dispatcher.
assert.strictEqual(
  formatSelectedRecordPrompt('UPDATE_COMPLAINT', complaint),
  formatSelectedComplaintPrompt(complaint)
);

console.log('Visit and complaint response formatting tests passed.');
