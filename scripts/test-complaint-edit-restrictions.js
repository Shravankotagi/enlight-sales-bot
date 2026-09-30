const assert = require('assert');
const {
  mergeDraft,
  validateMandatoryFields,
  buildConfirmationSummary,
} = require('../src/core/catalogFlow');

const baseDraft = {
  action: 'UPDATE_COMPLAINT',
  company_name: 'Test Metals',
  updates: {},
};

const lockedOnly = mergeDraft(
  'UPDATE_COMPLAINT',
  baseDraft,
  {
    updates: {
      complaint_date: '30-09-2026',
      challan_no: 'INV-123',
      corrective_action: 'Replacement dispatched',
    },
  },
  'Change complaint date and challan number',
);

assert.deepStrictEqual(lockedOnly.updates, {});
assert.deepStrictEqual(
  lockedOnly._locked_complaint_update_fields,
  ['Complaint Date', 'Invoice / Challan No.', 'Corrective Action'],
);
assert(
  validateMandatoryFields('UPDATE_COMPLAINT', lockedOnly).some((message) =>
    message.includes('Locked fields cannot be updated after logging'),
  ),
);

const allowedOnly = mergeDraft(
  'UPDATE_COMPLAINT',
  baseDraft,
  {
    updates: {
      raised_by: 'Amit Shah',
      complaint_type: 'Quality Defect',
      complaint_description: 'Material has rust marks.',
      status: 'In Progress',
      resolution_notes: 'Inspection scheduled for tomorrow.',
    },
  },
  'Update complaint contact, type, description, status, and resolution notes',
);

assert.deepStrictEqual(allowedOnly.updates, {
  raised_by: 'Amit Shah',
  complaint_type: 'Quality Defect',
  complaint_description: 'Material has rust marks.',
  status: 'In Progress',
  resolution_notes: 'Inspection scheduled for tomorrow.',
});
assert.strictEqual(allowedOnly._locked_complaint_update_fields, undefined);

const mixedUpdate = mergeDraft(
  'UPDATE_COMPLAINT',
  baseDraft,
  {
    updates: {
      description: 'Updated rust details.',
      affected_product: 'HR Coil',
      resolution_date: '01-10-2026',
    },
  },
  'Update the description and product',
);

assert.deepStrictEqual(mixedUpdate.updates, {
  description: 'Updated rust details.',
});
assert.deepStrictEqual(
  mixedUpdate._locked_complaint_update_fields,
  ['Product / Material', 'Resolution Date'],
);

const rawLockedMixedUpdate = mergeDraft(
  'UPDATE_COMPLAINT',
  baseDraft,
  {
    updates: {
      description: 'Updated rust details.',
    },
  },
  'Update company name to Test Metals 2, company PO number to PO-999, and complaint description to Updated rust details.',
);

assert.deepStrictEqual(rawLockedMixedUpdate.updates, {
  description: 'Updated rust details.',
});
assert.deepStrictEqual(
  rawLockedMixedUpdate._locked_complaint_update_fields,
  ['Customer / Company Name', 'Linked Inquiry / PO'],
);
const summary = buildConfirmationSummary('UPDATE_COMPLAINT', rawLockedMixedUpdate);
assert(summary.includes('Permission Notice'));
assert(summary.includes('You are not allowed to edit these fields'));

console.log('Complaint edit restriction tests passed.');
