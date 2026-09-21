const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { handleCatalogFlow } = require('../src/core/catalogFlow');
const { saveActiveSession, supabase } = require('../src/supabase');

async function testComplaintProductLinking() {
  const testPhone = '918262937458';
  console.log('--- Testing Complaint Product Linking & Formatting ---');

  // Clear previous session
  await saveActiveSession(testPhone, 'Apex Precision Ltd', 'catalog_flow|LOG_COMPLAINT|{"company_name":"Apex Precision Ltd"}');

  // Input matching the user's exact screenshot message
  const userMsg = 'Apex Precision Ltd, Issue: Quality Defect, Description: Rust on the upper surface of 2 coils received on 21st Sep';
  const res = await handleCatalogFlow(userMsg, testPhone);

  console.log('\n[Bot Capture Reply]:\n', res.reply);

  const passCustomer = res.reply.includes('Apex Precision Ltd');
  const passLinkedOrder = res.reply.includes('PO: PO-Apex-4567');
  const passProduct = res.reply.includes('HR Coil') && !res.reply.includes('Product / Material: 2 coils');
  const passDesc = res.reply.includes('Rust on the upper surface of 2 coils received on 21st Sep');
  const passCorrective = res.reply.includes('• *Corrective Action:* -');
  const passStatus = res.reply.includes('Open (48-Hour SLA Clock Started)');

  console.log('\nVerification Checks:');
  console.log('1. Correct Customer:', passCustomer);
  console.log('2. Linked Order PO attached:', passLinkedOrder);
  console.log('3. Product resolved to catalog (HR Coil) and NOT "2 coils":', passProduct);
  console.log('4. Description captured:', passDesc);
  console.log('5. Optional Corrective Action filled with "-":', passCorrective);
  console.log('6. Status 48-Hour SLA active:', passStatus);

  if (passCustomer && passLinkedOrder && passProduct && passDesc && passCorrective && passStatus) {
    console.log('\n🎉 COMPLAINT PRODUCT RESOLUTION & OPTIONAL FIELD TEST PASSED!');
  } else {
    console.error('\n❌ COMPLAINT PRODUCT RESOLUTION TEST FAILED!');
    process.exit(1);
  }
}

testComplaintProductLinking().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
