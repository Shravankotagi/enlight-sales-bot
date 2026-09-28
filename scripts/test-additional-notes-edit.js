const assert = require('assert');
const {
  detectOutOfScopeActionAttempt,
  detectNonEditableFieldAttempt,
  extractVerbatimNotes,
  mergeDraft,
  buildConfirmationSummary,
  handleCatalogFlow,
  buildResumePrompt,
  formatAttributeValue,
  extractInquiryAttributes,
  formatDetailedInquiryItemsList,
  formatSelectedInquiryPrompt,
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

  // Test 7: Selected Inquiry prompt format & attributes
  console.log('Test 7: formatSelectedInquiryPrompt & extractInquiryAttributes');
  assert.strictEqual(formatAttributeValue(null), '-');
  assert.strictEqual(formatAttributeValue(undefined), '-');
  assert.strictEqual(formatAttributeValue('Not specified'), '-');
  assert.strictEqual(formatAttributeValue('None'), '-');
  assert.strictEqual(formatAttributeValue('Tata steel'), 'Tata steel');
  assert.strictEqual(formatAttributeValue('90 days terms'), '90 days terms');

  const fullInquiryRecord = {
    displayId: 'INQ-8E15BC',
    customer_name: 'Menon Industries',
    date_formatted: '28-09-2026',
    stage: 'New Inquiry',
    preferred_make: 'Tata steel',
    payment_terms: '90 days terms',
    delivery_location: 'maharastra',
    additional_notes: 'we are inquirying about the product so we can get more detais',
  };
  const itemsText = '1. *HR Coil (9mm)* — 89 MT';
  const formattedPrompt = formatSelectedInquiryPrompt(fullInquiryRecord, itemsText);

  assert(formattedPrompt.includes('✏️ *Selected Inquiry INQ-8E15BC (Menon Industries):*'));
  assert(formattedPrompt.includes('• *Date:* 28-09-2026'));
  assert(formattedPrompt.includes('• *Stage:* New Inquiry'));
  assert(formattedPrompt.includes('• *Preferred Make:* Tata steel'));
  assert(formattedPrompt.includes('• *Payment Terms:* 90 days terms'));
  assert(formattedPrompt.includes('• *Delivery Location:* maharastra'));
  assert(formattedPrompt.includes('• *Additional Notes:* we are inquirying about the product so we can get more detais'));
  assert(formattedPrompt.includes('*Current Line Items:*\n\n1. *HR Coil (9mm)* — 89 MT'));

  // Test missing fields fallback to '-'
  const sparseInquiryRecord = {
    displayId: 'INQ-8E15BC',
    customer_name: 'Menon Industries',
    date_formatted: '22-09-2026',
    stage: 'New Inquiry',
    payment_terms: '60 Days',
    delivery_location: 'Chakan Pune',
  };
  const sparsePrompt = formatSelectedInquiryPrompt(sparseInquiryRecord, itemsText);
  assert(sparsePrompt.includes('• *Preferred Make:* -'), 'Missing preferred make must display -');
  assert(sparsePrompt.includes('• *Additional Notes:* -'), 'Missing additional notes must display -');
  assert(sparsePrompt.includes('• *Payment Terms:* 60 Days'));
  assert(sparsePrompt.includes('• *Delivery Location:* Chakan Pune'));

  // Test extractInquiryAttributes from raw_text
  const rawTextInq = {
    raw_text: 'Customer: ABC Corp\nPreferred Make: JSW Steel\nPayment Terms: 45 Days\nDelivery Location: Mumbai\nNotes: Urgent requirement',
    ai_extraction_json: {}
  };
  const extractedAttrs = extractInquiryAttributes(rawTextInq);
  assert.strictEqual(extractedAttrs.preferred_make, 'JSW Steel');
  assert.strictEqual(extractedAttrs.payment_terms, '45 Days');
  assert.strictEqual(extractedAttrs.delivery_location, 'Mumbai');
  assert.strictEqual(extractedAttrs.additional_notes, 'Urgent requirement');

  console.log('  -> PASS: formatSelectedInquiryPrompt & extractInquiryAttributes tests passed.\n');

  // Test 8: Stale Draft Button & Inactive Session Feedback
  console.log('Test 8: Stale Draft Button & Inactive Session Feedback');
  const {
    isStaleDraftButtonAction,
    isStaleResumeNoAction,
    formatDraftContextLabel,
    getModuleCatalogName,
    recordInactiveDraft,
    handleStaleDraftButton,
    handleResumeMenuButton,
  } = require('../src/core/catalogFlow');

  // 8a. Helper functions
  assert.strictEqual(isStaleDraftButtonAction('btn_confirm_yes'), true);
  assert.strictEqual(isStaleDraftButtonAction('save / yes'), true);
  assert.strictEqual(isStaleDraftButtonAction('save yes'), true);
  assert.strictEqual(isStaleDraftButtonAction('yes'), true);
  assert.strictEqual(isStaleDraftButtonAction('btn_confirm_edit'), true);
  assert.strictEqual(isStaleDraftButtonAction('edit details'), true);
  assert.strictEqual(isStaleDraftButtonAction('btn_confirm_cancel'), true);
  assert.strictEqual(isStaleDraftButtonAction('discard draft'), true);
  assert.strictEqual(isStaleDraftButtonAction('btn_resume_yes'), true);
  assert.strictEqual(isStaleDraftButtonAction('yes continue'), true);
  assert.strictEqual(isStaleDraftButtonAction('update inquiry'), false);
  assert.strictEqual(isStaleDraftButtonAction('1'), false);

  assert.strictEqual(isStaleResumeNoAction('btn_resume_no'), true);
  assert.strictEqual(isStaleResumeNoAction('no go to menu'), true);
  assert.strictEqual(isStaleResumeNoAction('save / yes'), false);

  assert.strictEqual(formatDraftContextLabel({ inquiry_id: 'INQ-B63652', company_name: 'Sanjay Motors', action: 'UPDATE_INQUIRY' }), 'for INQ-B63652 (Sanjay Motors)');
  assert.strictEqual(formatDraftContextLabel({ inquiry_id: 'b63652', company_name: 'Sanjay Motors', action: 'UPDATE_INQUIRY' }), 'for INQ-B63652 (Sanjay Motors)');
  assert.strictEqual(formatDraftContextLabel({ company_name: 'Sanjay Motors', action: 'LOG_INQUIRY' }), 'for Sanjay Motors');
  assert.strictEqual(formatDraftContextLabel({ po_number: 'PO-99123', company_name: 'Menon Industries', action: 'LOG_ORDER' }), 'for PO-99123 (Menon Industries)');
  assert.strictEqual(formatDraftContextLabel({}), '');

  assert.strictEqual(getModuleCatalogName('LOG_INQUIRY'), 'Log New Inquiry');
  assert.strictEqual(getModuleCatalogName('UPDATE_INQUIRY'), 'Update Inquiry');
  assert.strictEqual(getModuleCatalogName('LOG_ORDER'), 'Log New Order');
  assert.strictEqual(getModuleCatalogName('UPDATE_ORDER'), 'Update Order');
  assert.strictEqual(getModuleCatalogName('LOG_VISIT'), 'Log Field Visit');
  assert.strictEqual(getModuleCatalogName('UPDATE_VISIT'), 'Update Field Visit');
  assert.strictEqual(getModuleCatalogName('LOG_COMPLAINT'), 'Log Complaint');
  assert.strictEqual(getModuleCatalogName('UPDATE_COMPLAINT'), 'Update Complaint');
  assert.strictEqual(getModuleCatalogName(null), 'the relevant activity');

  // 8b. Discarded draft feedback
  const testPhone1 = '919876543210';
  recordInactiveDraft(testPhone1, 'UPDATE_INQUIRY', {
    inquiry_id: 'INQ-B63652',
    company_name: 'Sanjay Motors',
  }, 'discarded');

  const staleDiscardRes1 = await handleStaleDraftButton('btn_confirm_yes', testPhone1, true);
  assert.strictEqual(staleDiscardRes1.handled, true);
  assert(staleDiscardRes1.reply.includes('This draft for INQ-B63652 (Sanjay Motors) was already discarded, so nothing was saved. To make these changes, please start again with Update Inquiry.'));
  assert(staleDiscardRes1.reply.includes('Here is the menu to start a new activity:'));
  assert.strictEqual(staleDiscardRes1.interactiveType, 'list');

  const staleDiscardRes2 = await handleStaleDraftButton('btn_confirm_edit', testPhone1, true);
  assert(staleDiscardRes2.reply.includes('This draft for INQ-B63652 (Sanjay Motors) was already discarded, so nothing was saved. To make these changes, please start again with Update Inquiry.'));

  // 8c. Saved draft feedback
  const testPhone2 = '919876543211';
  recordInactiveDraft(testPhone2, 'UPDATE_INQUIRY', {
    inquiry_id: 'INQ-B63652',
    company_name: 'Sanjay Motors',
  }, 'saved');

  const staleSavedRes = await handleStaleDraftButton('btn_confirm_yes', testPhone2, true);
  assert.strictEqual(staleSavedRes.handled, true);
  assert(staleSavedRes.reply.includes('This draft for INQ-B63652 (Sanjay Motors) was already saved. To make further changes, please start again with Update Inquiry.'));
  assert(staleSavedRes.reply.includes('Here is the menu to start a new activity:'));

  // 8d. Unknown/expired draft feedback
  const testPhone3 = '919876543299';
  const staleExpiredRes = await handleStaleDraftButton('btn_confirm_yes', testPhone3, true);
  assert.strictEqual(staleExpiredRes.handled, true);
  assert(staleExpiredRes.reply.includes('This draft was already discarded or expired, so nothing was saved. To make these changes, please start again with the relevant activity.'));
  assert(staleExpiredRes.reply.includes('Here is the menu to start a new activity:'));

  // 8e. Resume No / Menu button
  const resumeNoRes = await handleResumeMenuButton('btn_resume_no', testPhone1, true);
  assert.strictEqual(resumeNoRes.handled, true);
  assert(resumeNoRes.reply.includes('Activity cancelled.'));

  console.log('  -> PASS: Stale Draft Button & Inactive Session Feedback tests passed.\n');

  // Test 9: Rate, Line Total & Quotation Total Display across Inquiry Views
  console.log('Test 9: Rate, Line Total & Quotation Total Display across Inquiry Views');

  // 9a. formatDetailedInquiryItemsList with rated single item
  const ratedSingleItem = [
    { sku_text: 'HR Coil', dimensions: '7mm', quantity: 45, unit: 'MT', rate: 88, amount: 3960 }
  ];
  const formattedRatedSingle = formatDetailedInquiryItemsList(ratedSingleItem);
  assert.strictEqual(formattedRatedSingle, 'HR Coil (7mm) | 45 MT | ₹88 /MT | Line Total: ₹3,960', 'Rated single item must format with rate and line total');

  // 9b. formatDetailedInquiryItemsList with multiple items (some rated, some unrated)
  const mixedItems = [
    { sku_text: 'HR Coil', dimensions: '7mm', quantity: 45, unit: 'MT', rate: 88, amount: 3960 },
    { sku_text: 'CR Sheet', dimensions: '2mm', quantity: 20, unit: 'MT', rate: 90, amount: 1800 }
  ];
  const formattedMixed = formatDetailedInquiryItemsList(mixedItems);
  assert.strictEqual(
    formattedMixed,
    '1. HR Coil (7mm) | 45 MT | ₹88 /MT | Line Total: ₹3,960\n2. CR Sheet (2mm) | 20 MT | ₹90 /MT | Line Total: ₹1,800',
    'Multiple rated items must include line numbers, rates, and line totals'
  );

  // 9c. formatDetailedInquiryItemsList with unrated item
  const unratedItem = [
    { sku_text: 'HR Coil', dimensions: '9mm', quantity: 89, unit: 'MT', rate: 0, amount: 0 }
  ];
  const formattedUnrated = formatDetailedInquiryItemsList(unratedItem);
  assert.strictEqual(formattedUnrated, '*HR Coil (9mm)* — 89 MT', 'Unrated item must format as *Name (Spec)* — Qty Unit');

  // 9d. formatSelectedInquiryPrompt with rate, line total, and quotation total (e.g. INQ-4535CA Sana Shah)
  const sanaShahInqRecord = {
    displayId: 'INQ-4535CA',
    customer_name: 'Sana Shah',
    date_formatted: '28-09-2026',
    stage: 'Quoted',
    preferred_make: 'Tata steel',
    payment_terms: '70 Days',
    delivery_location: 'Satara',
    additional_notes: null,
    total_amount: 3960,
    deal_items: ratedSingleItem,
  };
  const sanaShahPrompt = formatSelectedInquiryPrompt(sanaShahInqRecord, formattedRatedSingle);
  assert(sanaShahPrompt.includes('✏️ *Selected Inquiry INQ-4535CA (Sana Shah):*'));
  assert(sanaShahPrompt.includes('• *Date:* 28-09-2026'));
  assert(sanaShahPrompt.includes('• *Stage:* Quoted'));
  assert(sanaShahPrompt.includes('• *Preferred Make:* Tata steel'));
  assert(sanaShahPrompt.includes('• *Payment Terms:* 70 Days'));
  assert(sanaShahPrompt.includes('• *Delivery Location:* Satara'));
  assert(sanaShahPrompt.includes('• *Additional Notes:* -'));
  assert(sanaShahPrompt.includes('*Current Line Items:*\n\nHR Coil (7mm) | 45 MT | ₹88 /MT | Line Total: ₹3,960'));
  assert(sanaShahPrompt.includes('Quotation Total: ₹3,960'));
  assert(sanaShahPrompt.includes('Want to update Stage (Negotiation, Won, Lost, On Hold), Rate, Quantity or other details?'));

  // 9e. formatSelectedInquiryPrompt when total_amount needs to be calculated from items
  const inqWithoutHeaderTotal = {
    displayId: 'INQ-4535CA',
    customer_name: 'Sana Shah',
    date_formatted: '28-09-2026',
    stage: 'Quoted',
    deal_items: mixedItems,
  };
  const promptCalcTotal = formatSelectedInquiryPrompt(inqWithoutHeaderTotal, formattedMixed);
  assert(promptCalcTotal.includes('Quotation Total: ₹5,760'), 'Quotation total must be computed from line items (3960 + 1800 = 5760)');
  assert(promptCalcTotal.includes('Want to update Stage (Negotiation, Won, Lost, On Hold), Rate, Quantity or other details?'));

  console.log('  -> PASS: Rate, Line Total & Quotation Total Display tests passed.\n');

  console.log('🎉 ALL TESTS PASSED SUCCESSFULLY!');
}

runTests().then(() => {
  process.exit(0);
}).catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
