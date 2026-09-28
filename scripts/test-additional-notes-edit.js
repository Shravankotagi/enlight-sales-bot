const assert = require('assert');
const {
  detectOutOfScopeActionAttempt,
  detectNonEditableFieldAttempt,
  extractVerbatimNotes,
  mergeDraft,
  buildConfirmationSummary,
  handleCatalogFlow,
  buildResumePrompt,
} = require('../src/core/catalogFlow');

async function runTests() {
  console.log('=== Running Additional Notes & Edit Flow Tests ===\n');

  // Test 1: detectOutOfScopeActionAttempt does not falsely trigger on notes containing "order", "visit", "complaint"
  console.log('Test 1: detectOutOfScopeActionAttempt');
  const scopeTest1 = detectOutOfScopeActionAttempt('LOG_INQUIRY', 'change additional notes to we are iquiryng to place the order.');
  assert.strictEqual(scopeTest1, null, 'Should not trigger out-of-scope for notes edit');

  const scopeTest2 = detectOutOfScopeActionAttempt('LOG_INQUIRY', 'additional notes: client will place an order next week');
  assert.strictEqual(scopeTest2, null, 'Should not trigger out-of-scope for notes edit with colon');

  const scopeTest3 = detectOutOfScopeActionAttempt('LOG_INQUIRY', 'notes: customer mentioned prior complaint regarding delivery');
  assert.strictEqual(scopeTest3, null, 'Should not trigger out-of-scope for complaint mention in notes');

  const scopeTest4 = detectOutOfScopeActionAttempt('LOG_INQUIRY', 'i want to log order');
  assert.strictEqual(scopeTest4, 'LOG_ORDER', 'Should correctly identify explicit action switch to LOG_ORDER');

  const scopeTest5 = detectOutOfScopeActionAttempt('UPDATE_INQUIRY', 'change additional notes to we are iquiryng to place the order.');
  assert.strictEqual(scopeTest5, null, 'Should not trigger out-of-scope for UPDATE_INQUIRY notes edit');
  console.log('  -> PASS: Out-of-scope preemption tests passed.\n');

  // Test 2: detectNonEditableFieldAttempt does not falsely flag notes mentioning "customer" / "party" / "inquiry"
  console.log('Test 2: detectNonEditableFieldAttempt');
  const nonEditTest1 = detectNonEditableFieldAttempt('LOG_INQUIRY', 'change additional notes to we are iquiryng to place the order.');
  assert.strictEqual(nonEditTest1.isNonEditable, false, 'LOG_INQUIRY notes edit should be editable');

  const nonEditTest2 = detectNonEditableFieldAttempt('UPDATE_INQUIRY', 'change additional notes to customer wants discount');
  assert.strictEqual(nonEditTest2.isNonEditable, false, 'UPDATE_INQUIRY notes mentioning customer should be editable');

  const nonEditTest3 = detectNonEditableFieldAttempt('UPDATE_INQUIRY', 'change notes to client requested urgent delivery');
  assert.strictEqual(nonEditTest3.isNonEditable, false, 'UPDATE_INQUIRY notes mentioning client should be editable');

  const nonEditTest4 = detectNonEditableFieldAttempt('UPDATE_INQUIRY', 'change additional notes to this party is good');
  assert.strictEqual(nonEditTest4.isNonEditable, false, 'UPDATE_INQUIRY notes mentioning party should be editable');

  const nonEditTest5 = detectNonEditableFieldAttempt('UPDATE_INQUIRY', 'change customer to ABC Corp');
  assert.strictEqual(nonEditTest5.isNonEditable, true, 'Real customer name change in update flow should be blocked');
  console.log('  -> PASS: Non-editable field check tests passed.\n');

  // Test 3: extractVerbatimNotes verbatim extraction
  console.log('Test 3: extractVerbatimNotes');
  const rawNote1 = 'change additional notes to we are iquiryng to place the order.';
  const extracted1 = extractVerbatimNotes(rawNote1);
  assert.strictEqual(extracted1, 'we are iquiryng to place the order.', 'Extracted note 1 must match verbatim');

  const rawNote2 = 'additional notes: Customer wants 10% discount on 25 MT.';
  const extracted2 = extractVerbatimNotes(rawNote2);
  assert.strictEqual(extracted2, 'Customer wants 10% discount on 25 MT.', 'Extracted note 2 must match verbatim');

  const rawNote3 = 'notes = will confirm PO by tomorrow 5 PM';
  const extracted3 = extractVerbatimNotes(rawNote3);
  assert.strictEqual(extracted3, 'will confirm PO by tomorrow 5 PM', 'Extracted note 3 must match verbatim');
  console.log('  -> PASS: Verbatim notes extractor tests passed.\n');

  // Test 4: mergeDraft preserves verbatim notes in draft
  console.log('Test 4: mergeDraft verbatim notes');
  const baseInqDraft = {
    company_name: 'Mahavir Steel',
    delivery_location: 'Pune',
    payment_terms: '30 Days Credit',
    line_items: [{ sku_text: 'HR Sheet', quantity: 25, unit: 'MT', rate: 54000, amount: 1350000 }]
  };
  const mergedInq = mergeDraft('LOG_INQUIRY', baseInqDraft, {}, rawNote1);
  assert.strictEqual(mergedInq.additional_notes, 'we are iquiryng to place the order.', 'LOG_INQUIRY merged draft must have verbatim additional_notes');

  const baseUpdateInqDraft = {
    inquiry_id: 'INQ-1BB6F1',
    company_name: 'Mahavir Steel',
    updates: { rate: 52000 }
  };
  const mergedUpdateInq = mergeDraft('UPDATE_INQUIRY', baseUpdateInqDraft, {}, rawNote1);
  assert.strictEqual(mergedUpdateInq.updates.additional_notes, 'we are iquiryng to place the order.', 'UPDATE_INQUIRY updates.additional_notes must have verbatim notes');
  console.log('  -> PASS: Draft merge tests passed.\n');

  // Test 5: buildConfirmationSummary renders verbatim notes correctly
  console.log('Test 5: buildConfirmationSummary');
  const summaryLog = buildConfirmationSummary('LOG_INQUIRY', mergedInq);
  assert(summaryLog.includes('• *Additional Notes:* we are iquiryng to place the order.'), 'LOG_INQUIRY summary must contain exact verbatim additional notes');

  const summaryUpdate = buildConfirmationSummary('UPDATE_INQUIRY', mergedUpdateInq);
  assert(summaryUpdate.includes('• *Additional Notes* → we are iquiryng to place the order.'), 'UPDATE_INQUIRY summary must contain exact verbatim additional notes');
  console.log('  -> PASS: Confirmation card summary rendering tests passed.\n');

  // Test 6: buildResumePrompt contextual resume prompts
  console.log('Test 6: buildResumePrompt');
  const rPrompt1 = buildResumePrompt('UPDATE_INQUIRY', { inquiry_id: 'INQ-8E15BC', company_name: 'Menon Industries' });
  assert.strictEqual(rPrompt1, 'You were in the middle of updating *INQ-8E15BC* for *Menon Industries* — do you want to continue?');

  const rPrompt2 = buildResumePrompt('UPDATE_INQUIRY', { inquiry_id: '8e15bc', company_name: 'Menon Industries' });
  assert.strictEqual(rPrompt2, 'You were in the middle of updating *INQ-8E15BC* for *Menon Industries* — do you want to continue?');

  const rPrompt3 = buildResumePrompt('UPDATE_INQUIRY', { _inquiry_display_id: 'INQ-D013D7' });
  assert.strictEqual(rPrompt3, 'You were in the middle of updating *INQ-D013D7* — do you want to continue?');

  const rPrompt4 = buildResumePrompt('UPDATE_INQUIRY', { company_name: 'Menon Industries' });
  assert.strictEqual(rPrompt4, 'You were in the middle of updating inquiry for *Menon Industries* — do you want to continue?');

  const rPrompt5 = buildResumePrompt('LOG_INQUIRY', { company_name: 'Menon Industries' });
  assert.strictEqual(rPrompt5, 'You were in the middle of logging an Inquiry for *Menon Industries* — do you want to continue?');

  const rPrompt6 = buildResumePrompt('UPDATE_ORDER', { po_number: 'PO-99123', company_name: 'Menon Industries' });
  assert.strictEqual(rPrompt6, 'You were in the middle of updating order *PO-99123* for *Menon Industries* — do you want to continue?');

  const rPrompt7 = buildResumePrompt('LOG_ORDER', { company_name: 'Menon Industries' });
  assert.strictEqual(rPrompt7, 'You were in the middle of logging an Order for *Menon Industries* — do you want to continue?');

  const rPrompt8 = buildResumePrompt('LOG_VISIT', { company_name: 'Menon Industries' });
  assert.strictEqual(rPrompt8, 'You were in the middle of logging a Field Visit for *Menon Industries* — do you want to continue?');

  const rPrompt9 = buildResumePrompt('LOG_COMPLAINT', { company_name: 'Menon Industries' });
  assert.strictEqual(rPrompt9, 'You were in the middle of logging a Complaint for *Menon Industries* — do you want to continue?');

  const rPrompt10 = buildResumePrompt('LOG_NEW_CUSTOMER', { company_name: 'Menon Industries' });
  assert.strictEqual(rPrompt10, 'You were in the middle of onboarding *Menon Industries* — do you want to continue?');

  console.log('  -> PASS: buildResumePrompt contextual prompt tests passed.\n');

  console.log('🎉 ALL TESTS PASSED SUCCESSFULLY!');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
