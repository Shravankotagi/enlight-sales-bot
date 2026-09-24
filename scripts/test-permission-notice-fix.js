const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const {
  mergeDraft,
  buildConfirmationSummary,
  detectTotalValueUpdateAttempt
} = require('../src/core/catalogFlow');

async function runTests() {
  console.log('===============================================================');
  console.log('🧪 RUNNING PERMISSION NOTICE & FIELD EDIT VERIFICATION TESTS');
  console.log('===============================================================\n');

  let allPassed = true;

  // --------------------------------------------------------------------------
  // TEST 1: Company Name Edit in UPDATE_ORDER
  // --------------------------------------------------------------------------
  console.log('--- TEST 1: Company Name Edit in UPDATE_ORDER ("Edit company name to Shin Company") ---');
  const baseDraft1 = {
    action: 'UPDATE_ORDER',
    company_name: 'Company 2',
    po_number: 'PO87475',
    inquiry_id: 'INQ-E7F070',
    total_amount: 50000,
  };

  const extracted1 = {
    action: 'UPDATE_ORDER',
    company_name: 'Shin Company',
  };

  const userInput1 = 'Edit company name to Shin Company';
  const merged1 = mergeDraft('UPDATE_ORDER', baseDraft1, extracted1, userInput1);
  const summary1 = buildConfirmationSummary('UPDATE_ORDER', merged1);

  console.log('Merged Draft 1:', JSON.stringify(merged1, null, 2));
  console.log('Summary 1:\n' + summary1);

  const t1_company = merged1.company_name === 'Shin Company';
  const t1_noNotice = merged1._permissionNotice === undefined;
  const t1_summaryHasCompany = summary1.includes('• *Customer / Company:* Shin Company');
  const t1_summaryHasPO = summary1.includes('• *PO Number:* PO87475');
  const t1_summaryHasInq = summary1.includes('• *Inquiry ID:* INQ-E7F070');
  const t1_summaryNoNotice = !summary1.includes('Permission Notice') && !summary1.includes('Total Order Value');

  const pass1 = t1_company && t1_noNotice && t1_summaryHasCompany && t1_summaryHasPO && t1_summaryHasInq && t1_summaryNoNotice;
  console.log('Test 1 Result:', pass1 ? '✅ PASS' : '❌ FAIL');
  if (!pass1) allPassed = false;

  // --------------------------------------------------------------------------
  // TEST 2: Non-Monetary Field Edits (PO Number, Delivery Location, Payment Terms)
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 2: Non-Monetary Field Edits ---');
  const baseDraft2 = {
    action: 'UPDATE_ORDER',
    company_name: 'Shin Company',
    po_number: 'PO87475',
    inquiry_id: 'INQ-E7F070',
  };

  const poMerged = mergeDraft('UPDATE_ORDER', baseDraft2, { updates: { po_number: 'PO-99881' } }, 'Change PO number to PO-99881');
  const locMerged = mergeDraft('UPDATE_ORDER', baseDraft2, { updates: { delivery_location: 'Pune' } }, 'Update delivery location to Pune');
  const payMerged = mergeDraft('UPDATE_ORDER', baseDraft2, { updates: { payment_terms: '30 days' } }, 'Change payment terms to 30 days');

  const pass2 = poMerged._permissionNotice === undefined &&
                locMerged._permissionNotice === undefined &&
                payMerged._permissionNotice === undefined &&
                poMerged.updates.po_number === 'PO-99881' &&
                locMerged.updates.delivery_location === 'Pune' &&
                payMerged.updates.payment_terms === '30 days';

  console.log('Test 2 Result:', pass2 ? '✅ PASS' : '❌ FAIL');
  if (!pass2) allPassed = false;

  // --------------------------------------------------------------------------
  // TEST 3: Combined Prompt for Company Name and Total Value Edit
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 3: Combined Prompt (Company Name + Total Value Edit Attempt) ---');
  const baseDraft3 = {
    action: 'UPDATE_ORDER',
    company_name: 'Company 2',
    po_number: 'PO87475',
    inquiry_id: 'INQ-E7F070',
    total_amount: 50000,
  };

  const extracted3 = {
    action: 'UPDATE_ORDER',
    company_name: 'Shin Company',
    updates: {
      total_amount: 250000,
    },
  };

  const userInput3 = 'Change company name to Shin Company and update total order value to 2,50,000';
  const merged3 = mergeDraft('UPDATE_ORDER', baseDraft3, extracted3, userInput3);
  const summary3 = buildConfirmationSummary('UPDATE_ORDER', merged3);

  console.log('Merged Draft 3:', JSON.stringify(merged3, null, 2));
  console.log('Summary 3:\n' + summary3);

  const t3_company = merged3.company_name === 'Shin Company';
  const t3_hasNotice = typeof merged3._permissionNotice === 'string' && merged3._permissionNotice.includes('Permission Notice');
  const t3_noDirectTotalInUpdates = merged3.updates?.total_amount === undefined;
  const t3_summaryHasNotice = summary3.includes('Permission Notice');
  const t3_summaryHasCompany = summary3.includes('• *Customer / Company:* Shin Company');

  const pass3 = t3_company && t3_hasNotice && t3_noDirectTotalInUpdates && t3_summaryHasNotice && t3_summaryHasCompany;
  console.log('Test 3 Result:', pass3 ? '✅ PASS' : '❌ FAIL');
  if (!pass3) allPassed = false;

  // --------------------------------------------------------------------------
  // TEST 4: Explicit Unauthorized Total Value Attempt Only
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 4: Explicit Unauthorized Total Value Attempt Only ---');
  const baseDraft4 = {
    action: 'UPDATE_ORDER',
    company_name: 'Shin Company',
    po_number: 'PO87475',
    inquiry_id: 'INQ-E7F070',
  };

  const extracted4 = {
    action: 'UPDATE_ORDER',
    updates: {
      total_amount: 250000,
    },
  };

  const userInput4 = 'Change the total order value to 2,50,000';
  const merged4 = mergeDraft('UPDATE_ORDER', baseDraft4, extracted4, userInput4);
  const summary4 = buildConfirmationSummary('UPDATE_ORDER', merged4);

  const pass4 = typeof merged4._permissionNotice === 'string' &&
                merged4._permissionNotice.includes('Permission Notice') &&
                merged4.updates?.total_amount === undefined &&
                summary4.includes('Permission Notice');

  console.log('Test 4 Result:', pass4 ? '✅ PASS' : '❌ FAIL');
  if (!pass4) allPassed = false;

  // --------------------------------------------------------------------------
  // TEST 5: Multi-Turn Stale Notice Clearance
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 5: Multi-Turn Stale Notice Clearance ---');
  // Draft from turn 1 with permission notice attached
  const turn1Draft = {
    action: 'UPDATE_ORDER',
    company_name: 'Company 2',
    po_number: 'PO87475',
    inquiry_id: 'INQ-E7F070',
    _permissionNotice: '⚠️ *Permission Notice:* Previous turn notice',
  };

  // Turn 2: User says "Edit company name to Shin Company"
  const turn2Extracted = {
    action: 'UPDATE_ORDER',
    company_name: 'Shin Company',
  };

  const turn2Merged = mergeDraft('UPDATE_ORDER', turn1Draft, turn2Extracted, 'Edit company name to Shin Company');
  const turn2Summary = buildConfirmationSummary('UPDATE_ORDER', turn2Merged);

  const pass5 = turn2Merged._permissionNotice === undefined &&
                !turn2Summary.includes('Permission Notice') &&
                turn2Merged.company_name === 'Shin Company';

  console.log('Test 5 Result:', pass5 ? '✅ PASS' : '❌ FAIL');
  if (!pass5) allPassed = false;

  // --------------------------------------------------------------------------
  // TEST 6: Combined Prompt for Company Name and Tonnage/Quantity Edit
  // --------------------------------------------------------------------------
  console.log('\n--- TEST 6: Combined Prompt (Company Name + Tonnage/Quantity Edit) ---');
  const baseDraft6 = {
    action: 'UPDATE_ORDER',
    company_name: 'Company 2',
    po_number: 'PO87475',
    inquiry_id: 'INQ-E7F070',
    line_items: [{ sku_text: 'HR Sheet', quantity: 10, unit: 'MT', rate: 50000 }],
  };

  const extracted6 = {
    action: 'UPDATE_ORDER',
    company_name: 'Shin Company',
    line_item_updates: [
      { item_reference: 'HR Sheet', quantity: 25, unit: 'MT' }
    ],
  };

  const userInput6 = 'Change company name to Shin Company and total tonnage to 25 MT';
  const merged6 = mergeDraft('UPDATE_ORDER', baseDraft6, extracted6, userInput6);
  const summary6 = buildConfirmationSummary('UPDATE_ORDER', merged6);

  const pass6 = merged6.company_name === 'Shin Company' &&
                merged6._permissionNotice === undefined &&
                !summary6.includes('Permission Notice') &&
                Array.isArray(merged6.line_item_updates) &&
                merged6.line_item_updates[0].quantity === 25;

  console.log('Test 6 Result:', pass6 ? '✅ PASS' : '❌ FAIL');
  if (!pass6) allPassed = false;

  console.log('\n===============================================================');
  console.log(allPassed ? '🎉 ALL 6 VERIFICATION TESTS PASSED SUCCESSFULLY!' : '❌ SOME TESTS FAILED');
  console.log('===============================================================');

  process.exit(allPassed ? 0 : 1);
}

runTests().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
