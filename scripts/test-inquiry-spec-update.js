const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const assert = require('assert');
const {
  extractFieldsWithLLM,
  mergeDraft,
  buildConfirmationSummary,
  getAllowedFieldsListForAction,
  getEditPromptForAction,
} = require('../src/core/catalogFlow');

async function runTests() {
  console.log('=== Starting Inquiry Specification & Thickness Update Test Suite ===\n');

  // Test 1: Check allowed fields and edit prompts
  console.log('--- Test 1: Allowed fields & edit prompt advertise specifications / dimensions ---');
  const allowed = getAllowedFieldsListForAction('UPDATE_INQUIRY');
  console.log('Allowed fields:\n' + allowed);
  assert(allowed.includes('Specifications') || allowed.includes('Dimensions'), 'Allowed fields must mention Specifications/Dimensions');

  const editPrompt = getEditPromptForAction('UPDATE_INQUIRY');
  console.log('\nEdit prompt:\n' + editPrompt);
  assert(editPrompt.includes('Spec') || editPrompt.includes('8mm'), 'Edit prompt must mention Spec / dimensions');
  console.log('✅ Test 1 Passed\n');

  // Test 2: LLM Field Extraction with multi-field update including spec
  console.log('--- Test 2: LLM extraction from combined message: Delivery location, Payment terms, Line item 78MT 8mm ---');
  const userInput = `Update delivery location to mumbai\nPayment terms to 80 days\nLine item: 78MT 8mm`;
  const existingDraft = {
    inquiry_id: 'INQ-B63652',
    company_name: 'Sanjay Motors',
    existing_items: [
      {
        id: 'item-1',
        sku_text: 'HR Coil',
        dimensions: '6mm',
        quantity: 45,
        unit: 'MT',
        rate: 54000,
      }
    ],
  };

  const extracted = await extractFieldsWithLLM('UPDATE_INQUIRY', userInput, existingDraft);
  console.log('Extracted output:', JSON.stringify(extracted, null, 2));

  assert(extracted.updates?.delivery_location || extracted.delivery_location, 'Delivery location should be extracted');
  assert(extracted.updates?.payment_terms || extracted.payment_terms, 'Payment terms should be extracted');
  assert(Array.isArray(extracted.line_item_updates) && extracted.line_item_updates.length > 0, 'line_item_updates should be present');

  const lineUpd = extracted.line_item_updates[0];
  console.log('Line item update:', lineUpd);
  assert.strictEqual(Number(lineUpd.quantity), 78, 'Quantity should be 78');
  assert(lineUpd.spec === '8mm' || lineUpd.dimensions === '8mm', 'Spec / dimensions should be 8mm');
  console.log('✅ Test 2 Passed\n');

  // Test 3: Draft merging
  console.log('--- Test 3: Merging extracted updates into existing draft ---');
  const merged = mergeDraft('UPDATE_INQUIRY', existingDraft, extracted, userInput);
  console.log('Merged draft:', JSON.stringify(merged, null, 2));

  assert.strictEqual(merged.updates?.delivery_location?.toLowerCase(), 'mumbai', 'Delivery location should be mumbai');
  assert(merged.updates?.payment_terms?.includes('80'), 'Payment terms should include 80');
  assert(Array.isArray(merged.line_item_updates) && merged.line_item_updates.length > 0, 'Merged line_item_updates should exist');
  assert.strictEqual(Number(merged.line_item_updates[0].quantity), 78, 'Merged quantity should be 78');
  assert(merged.line_item_updates[0].spec === '8mm' || merged.line_item_updates[0].dimensions === '8mm', 'Merged spec should be 8mm');
  console.log('✅ Test 3 Passed\n');

  // Test 4: Confirmation summary display
  console.log('--- Test 4: Confirmation summary shows updated spec (6mm → 8mm) and quantity ---');
  const summary = buildConfirmationSummary('UPDATE_INQUIRY', merged);
  console.log('Generated Confirmation Summary:\n' + summary);

  assert(summary.includes('Mumbai') || summary.includes('mumbai'), 'Summary should show delivery location Mumbai');
  assert(summary.includes('80'), 'Summary should show 80 days payment terms');
  assert(summary.includes('6mm → 8mm') || summary.includes('8mm'), 'Summary should display spec transition 6mm → 8mm or 8mm');
  assert(summary.includes('78 MT') || summary.includes('78'), 'Summary should display Qty: 78 MT');
  assert(!summary.includes('HR Coil (6mm) → Qty: 78 MT'), 'Summary must NOT keep stale 6mm without showing 8mm update');
  console.log('✅ Test 4 Passed\n');

  // Test 5: Fallback regex extraction when LLM returns minimal line items
  console.log('--- Test 5: Fallback extraction for single line item inquiry ---');
  const fallbackDraft = {
    inquiry_id: 'INQ-B63652',
    company_name: 'Sanjay Motors',
    existing_items: [
      {
        id: 'item-1',
        sku_text: 'HR Coil',
        dimensions: '6mm',
        quantity: 45,
        unit: 'MT',
      }
    ],
  };
  const emptyExtracted = {
    action: 'UPDATE_INQUIRY',
    updates: { delivery_location: 'mumbai' },
  };
  const fallbackMerged = mergeDraft('UPDATE_INQUIRY', fallbackDraft, emptyExtracted, 'Update line item: 78MT 8mm');
  console.log('Fallback Merged line_item_updates:', fallbackMerged.line_item_updates);
  assert(Array.isArray(fallbackMerged.line_item_updates) && fallbackMerged.line_item_updates.length > 0, 'Fallback should extract line update');
  assert.strictEqual(fallbackMerged.line_item_updates[0].quantity, 78, 'Fallback qty should be 78');
  assert(fallbackMerged.line_item_updates[0].spec === '8mm' || fallbackMerged.line_item_updates[0].dimensions === '8mm', 'Fallback spec should be 8mm');
  console.log('✅ Test 5 Passed\n');

  console.log('====================================================');
  console.log('🎉 ALL INQUIRY SPECIFICATION UPDATE TESTS PASSED! 🎉');
  console.log('====================================================');
}

runTests().catch(err => {
  console.error('❌ Test Failed:', err);
  process.exit(1);
});
