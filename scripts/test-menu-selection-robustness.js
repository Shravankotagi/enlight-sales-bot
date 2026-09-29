require('dotenv').config();
const assert = require('assert');
const { handleCatalogFlow } = require('../src/core/catalogFlow');
const { getFullActiveSession } = require('../src/supabase');

const REAL_SP_PHONE = '8262937458';

async function runTests() {
  console.log('================================================================');
  console.log('🧪 TESTING MENU SELECTION ROBUSTNESS & CANDIDATE RESOLUTION');
  console.log('================================================================\n');

  // Test 1: From idle/general, sending "menu_2" opens Update Inquiry list
  console.log('--- Test 1: "menu_2" from clean session ---');
  await handleCatalogFlow('cancel', REAL_SP_PHONE);
  const resMenu2 = await handleCatalogFlow('menu_2', REAL_SP_PHONE);
  console.log('resMenu2 reply preview:\n' + resMenu2.reply?.slice(0, 150) + '...\n');
  assert(resMenu2.handled === true);
  assert(resMenu2.reply.includes('Update Inquiry') && resMenu2.reply.includes('recent editable inquiries'));
  console.log('✅ Test 1 Passed: "menu_2" opens Update Inquiry list.');

  // Test 2: While IN catalog_update_select, clicking "2. Update Inquiry" re-renders list, does NOT select candidate 2
  console.log('\n--- Test 2: "2. Update Inquiry" while already in catalog_update_select ---');
  let session = await getFullActiveSession(REAL_SP_PHONE);
  assert(session?.last_intent?.startsWith('catalog_update_select|UPDATE_INQUIRY'));

  const res2Title = await handleCatalogFlow('2. Update Inquiry', REAL_SP_PHONE);
  console.log('res2Title reply preview:\n' + res2Title.reply?.slice(0, 150) + '...\n');
  assert(res2Title.handled === true);
  assert(res2Title.reply.includes('Update Inquiry') && res2Title.reply.includes('recent editable inquiries'), 'Must re-render 7 inquiries list');
  assert(!res2Title.reply.includes('Selected Inquiry INQ-27D7BD'), 'Must NOT select item 2');
  console.log('✅ Test 2 Passed: "2. Update Inquiry" re-renders list without selecting item 2.');

  // Test 3: While IN catalog_update_select, clicking "menu_2" re-renders list, does NOT select candidate 2
  console.log('\n--- Test 3: "menu_2" while already in catalog_update_select ---');
  const resMenu2Again = await handleCatalogFlow('menu_2', REAL_SP_PHONE);
  assert(resMenu2Again.handled === true);
  assert(resMenu2Again.reply.includes('Update Inquiry') && resMenu2Again.reply.includes('recent editable inquiries'));
  assert(!resMenu2Again.reply.includes('Selected Inquiry INQ-27D7BD'));
  console.log('✅ Test 3 Passed: "menu_2" re-renders list.');

  // Test 4: While IN catalog_update_select, sending bare "2" SELECTS candidate #2
  console.log('\n--- Test 4: Bare "2" in catalog_update_select picks candidate #2 ---');
  const resPick2 = await handleCatalogFlow('2', REAL_SP_PHONE);
  console.log('resPick2 reply preview:\n' + resPick2.reply?.slice(0, 150) + '...\n');
  assert(resPick2.handled === true);
  assert(resPick2.reply.includes('Selected Inquiry') && (resPick2.reply.includes('INQ-27D7BD') || resPick2.reply.includes('Lexi Metal Works')));
  console.log('✅ Test 4 Passed: Bare "2" accurately selects candidate #2.');

  // Test 5: While viewing selected inquiry, clicking "4. Update Order" or "menu_4" switches to Update Order list
  console.log('\n--- Test 5: Switching to "4. Update Order" / "menu_4" from active draft ---');
  const resSwitch4 = await handleCatalogFlow('menu_4', REAL_SP_PHONE);
  console.log('resSwitch4 reply preview:\n' + resSwitch4.reply?.slice(0, 150) + '...\n');
  assert(resSwitch4.handled === true);
  assert(resSwitch4.reply.includes('Update Order') && resSwitch4.reply.includes('recent orders'));
  console.log('✅ Test 5 Passed: Switch to "menu_4" smoothly renders recent orders list.');

  // Test 6: While in UPDATE_ORDER list, selecting Option 1 shows full Selected Order card
  console.log('\n--- Test 6: Selecting Option 1 in Update Order shows rich order card ---');
  const resOrder1 = await handleCatalogFlow('1', REAL_SP_PHONE);
  console.log('resOrder1 reply preview:\n' + resOrder1.reply?.slice(0, 200) + '...\n');
  assert(resOrder1.handled === true);
  assert(resOrder1.reply.includes('Selected Order'));
  assert(resOrder1.reply.includes('Linked Inquiry'));
  assert(resOrder1.reply.includes('Total Order Value'));
  console.log('✅ Test 6 Passed: Option 1 renders rich Selected Order card.');

  await handleCatalogFlow('cancel', REAL_SP_PHONE);
  console.log('\n🎉 ALL ROBUSTNESS TESTS PASSED 100%!');
}

runTests().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
