const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { handleCatalogFlow } = require('../src/core/catalogFlow');
const { saveActiveSession } = require('../src/supabase');

async function runTests() {
  const testPhone = '919999988888';
  console.log('--- STARTING NON-EDITABLE & SYSTEM-GENERATED FIELDS TESTS ---');

  // TEST 1: Inquiry ID edit attempt in UPDATE_INQUIRY (User says "change inquiry id to IN879")
  console.log('\n[TEST 1] UPDATE_INQUIRY: Block Inquiry ID modification during edit mode');
  await saveActiveSession(testPhone, 'Jinal Industries', 'catalog_editing|UPDATE_INQUIRY|{"inquiry_id":"INQ-DFE122","company_name":"Jinal Industries","updates":{"payment_terms":"90 Days"}}');
  const res1 = await handleCatalogFlow('change inquiry id to IN879', testPhone);
  console.log('Reply:', res1.reply);
  const pass1 = res1.handled === true &&
    res1.reply.includes('Inquiry ID is system-generated and cannot be edited') &&
    res1.reply.includes('Editable fields for this inquiry update') &&
    res1.reply.includes('Rate / Target Price');
  console.log('Test 1 Passed:', pass1);

  // TEST 2: Inquiry ID edit attempt directly during confirmation (inline edit)
  console.log('\n[TEST 2] UPDATE_INQUIRY: Block Inquiry ID modification in catalog_confirm');
  await saveActiveSession(testPhone, 'Jinal Industries', 'catalog_confirm|UPDATE_INQUIRY|{"inquiry_id":"INQ-DFE122","company_name":"Jinal Industries","updates":{"payment_terms":"90 Days"}}');
  const res2 = await handleCatalogFlow('change inq id to INQ-999', testPhone);
  console.log('Reply 2:', res2.reply);
  const pass2 = res2.handled === true && res2.reply.includes('Inquiry ID is system-generated and cannot be edited');
  console.log('Test 2 Passed:', pass2);

  // TEST 3: Total Order Value modification in UPDATE_ORDER
  console.log('\n[TEST 3] UPDATE_ORDER: Block Total Order Value modification');
  await saveActiveSession(testPhone, 'Apex Steel', 'catalog_editing|UPDATE_ORDER|{"inquiry_id":"INQ-123456","company_name":"Apex Steel","po_number":"PO-2026-001"}');
  const res3 = await handleCatalogFlow('change total value to 5,00,000', testPhone);
  console.log('Reply 3:', res3.reply);
  const pass3 = res3.handled === true && res3.reply.includes('Total Order Value is system-calculated and cannot be edited directly');
  console.log('Test 3 Passed:', pass3);

  // TEST 4: Customer Name modification during UPDATE_INQUIRY
  console.log('\n[TEST 4] UPDATE_INQUIRY: Block Customer Name change for existing inquiry update');
  await saveActiveSession(testPhone, 'Jinal Industries', 'catalog_editing|UPDATE_INQUIRY|{"inquiry_id":"INQ-DFE122","company_name":"Jinal Industries","updates":{"rate":55000}}');
  const res4 = await handleCatalogFlow('change customer name to Tata Motors', testPhone);
  console.log('Reply 4:', res4.reply);
  const pass4 = res4.handled === true && res4.reply.includes('Customer Name cannot be edited for an existing record') && res4.reply.includes('Jinal Industries');
  console.log('Test 4 Passed:', pass4);

  // TEST 5: Order ID modification
  console.log('\n[TEST 5] UPDATE_ORDER: Block Order ID modification');
  await saveActiveSession(testPhone, 'Apex Steel', 'catalog_editing|UPDATE_ORDER|{"inquiry_id":"INQ-123456","company_name":"Apex Steel"}');
  const res5 = await handleCatalogFlow('change order id to ORD-888', testPhone);
  console.log('Reply 5:', res5.reply);
  const pass5 = res5.handled === true && res5.reply.includes('Order ID is system-generated and cannot be edited');
  console.log('Test 5 Passed:', pass5);

  // TEST 6: Visit ID modification
  console.log('\n[TEST 6] UPDATE_VISIT: Block Visit ID modification');
  await saveActiveSession(testPhone, 'Shree Ram Steels', 'catalog_editing|UPDATE_VISIT|{"company_name":"Shree Ram Steels","visit_date":"20-09-2026"}');
  const res6 = await handleCatalogFlow('change visit id to VST-001', testPhone);
  console.log('Reply 6:', res6.reply);
  const pass6 = res6.handled === true && res6.reply.includes('Visit ID is system-generated and cannot be edited');
  console.log('Test 6 Passed:', pass6);

  // TEST 7: Complaint Ticket ID modification
  console.log('\n[TEST 7] UPDATE_COMPLAINT: Block Complaint ID modification');
  await saveActiveSession(testPhone, 'Mehta Engineering', 'catalog_editing|UPDATE_COMPLAINT|{"company_name":"Mehta Engineering","linked_inquiry_or_po":"PO-123"}');
  const res7 = await handleCatalogFlow('change complaint id to CMP-999', testPhone);
  console.log('Reply 7:', res7.reply);
  const pass7 = res7.handled === true && res7.reply.includes('Complaint Ticket ID is system-generated and cannot be edited');
  console.log('Test 7 Passed:', pass7);

  // TEST 8: Linked PO modification in UPDATE_COMPLAINT
  console.log('\n[TEST 8] UPDATE_COMPLAINT: Block Linked PO / Inquiry modification');
  await saveActiveSession(testPhone, 'Mehta Engineering', 'catalog_editing|UPDATE_COMPLAINT|{"company_name":"Mehta Engineering","linked_inquiry_or_po":"PO-123"}');
  const res8 = await handleCatalogFlow('change linked po to PO-999', testPhone);
  console.log('Reply 8:', res8.reply);
  const pass8 = res8.handled === true && res8.reply.includes('Linked Inquiry/PO cannot be changed for an existing complaint');
  console.log('Test 8 Passed:', pass8);

  // TEST 9: Customer ID in LOG_NEW_CUSTOMER
  console.log('\n[TEST 9] LOG_NEW_CUSTOMER: Block Customer ID modification');
  await saveActiveSession(testPhone, 'New Horizon', 'catalog_editing|LOG_NEW_CUSTOMER|{"company_name":"New Horizon"}');
  const res9 = await handleCatalogFlow('change customer id to CUST-101', testPhone);
  console.log('Reply 9:', res9.reply);
  const pass9 = res9.handled === true && res9.reply.includes('Customer ID is system-generated and cannot be edited');
  console.log('Test 9 Passed:', pass9);

  // TEST 10: GST / Tax modification
  console.log('\n[TEST 10] LOG_ORDER: Block GST / Tax rate modification');
  await saveActiveSession(testPhone, 'Apex Steel', 'catalog_editing|LOG_ORDER|{"company_name":"Apex Steel"}');
  const res10 = await handleCatalogFlow('change GST to 12%', testPhone);
  console.log('Reply 10:', res10.reply);
  const pass10 = res10.handled === true && res10.reply.includes('GST and Tax calculations are computed automatically');
  console.log('Test 10 Passed:', pass10);

  // TEST 11: Valid Editable Field (e.g. Payment terms: 45 Days Credit) continues to work smoothly!
  console.log('\n[TEST 11] UPDATE_INQUIRY: Valid edit field (Payment terms: 45 Days) updates successfully');
  await saveActiveSession(testPhone, 'Jinal Industries', 'catalog_editing|UPDATE_INQUIRY|{"inquiry_id":"INQ-DFE122","company_name":"Jinal Industries","updates":{"rate":54000}}');
  const res11 = await handleCatalogFlow('payment terms: 45 days credit', testPhone);
  console.log('Reply 11:', res11.reply);
  const pass11 = res11.handled === true && res11.reply.includes('45 days credit') || res11.reply.includes('45 Days Credit');
  console.log('Test 11 Passed:', pass11);

  const allPassed = pass1 && pass2 && pass3 && pass4 && pass5 && pass6 && pass7 && pass8 && pass9 && pass10 && pass11;
  console.log('\n========================================');
  console.log(`ALL 11 TESTS PASSED: ${allPassed ? '✅ YES' : '❌ NO'}`);
  console.log('========================================');
  process.exit(allPassed ? 0 : 1);
}

runTests().catch(err => {
  console.error('Test execution error:', err);
  process.exit(1);
});
