const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const assert = require('assert');
const { handleCatalogFlow } = require('../src/core/catalogFlow');
const { saveActiveSession, supabase } = require('../src/supabase');

async function testDisambiguationResolutionLogic() {
  console.log('=== Test 1: Direct Disambiguation Helper Logic Verification ===');
  // We can test by invoking handleCatalogFlow with synthetic state or test the core flow
  console.log('Tested via handleCatalogFlow flow below.');
}

async function run() {
  const senderPhone = '8262937458';

  console.log('\n--- Step 1: User enters 4. Update Order ---');
  await saveActiveSession(senderPhone, 'Unknown', 'general');
  const res1 = await handleCatalogFlow('menu_4', senderPhone);
  console.log('Bot Response 1:');
  console.log(res1.reply);
  assert(res1.handled, 'Menu 4 should be handled');
  assert(res1.reply.includes('Update Order'), 'Header must be Update Order');

  console.log('\n--- Step 2: User selects an order from the list ---');
  // Let's select order 1 or whichever order is first
  const res2 = await handleCatalogFlow('1', senderPhone);
  console.log('Bot Response 2:');
  console.log(res2.reply);
  assert(res2.handled, 'Order selection should be handled');
  assert(res2.reply.includes('Selected Order'), 'Must show Selected Order');

  console.log('\n--- Step 3: User inputs uncataloged product "line item to MS plate 22MT 4mm" ---');
  const res3 = await handleCatalogFlow('line item to MS plate 22MT 4mm', senderPhone);
  console.log('Bot Response 3:');
  console.log(res3.reply);
  assert(res3.handled, 'Disambiguation prompt should be handled');
  assert(res3.reply.includes('not present in our product list') || res3.reply.includes('isn\'t in the catalog') || res3.reply.includes('Which one did you mean'), 'Should ask for disambiguation');
  assert(res3.reply.includes('HR Plate'), 'Should list HR Plate as option');
  assert(res3.reply.includes('HR Sheet'), 'Should list HR Sheet as option');
  assert(res3.reply.includes('Chequered Sheet'), 'Should list Chequered Sheet as option');

  console.log('\n--- Step 4: User replies with conversational resolution "same configuration for HR plate" ---');
  let res4 = await handleCatalogFlow('same configuration for HR plate', senderPhone);
  console.log('Bot Response 4:');
  console.log(res4.reply);
  assert(res4.handled, 'Disambiguation reply should be handled');

  if (res4.reply.includes('Add this as a new line item') || res4.reply.includes('Replace an existing line item')) {
    console.log('\n--- Step 4b: User selects option 2 (Replace) ---');
    res4 = await handleCatalogFlow('2', senderPhone);
    console.log('Bot Response 4b:');
    console.log(res4.reply);
  }

  assert(res4.reply.includes('HR Plate'), 'Summary must show HR Plate');
  assert(res4.reply.includes('4mm') || res4.reply.includes('4MM'), 'Summary must retain 4mm thickness');
  assert(res4.reply.includes('22 MT') || res4.reply.includes('22MT'), 'Summary must retain 22 MT quantity');
  assert(res4.interactiveButtons, 'Should show confirmation buttons');

  console.log('\n--- Step 5: User confirms update by clicking Save / Yes ---');
  const res5 = await handleCatalogFlow('btn_confirm_yes', senderPhone);
  console.log('Bot Response 5:');
  console.log(res5.reply);
  assert(res5.handled, 'Confirmation should be handled');
  assert(res5.reply.includes('Order Updated Successfully'), 'Should succeed without "Failed to update product" error');

  console.log('\n========================================');
  console.log('ALL TESTS PASSED! UPDATE ORDER PRODUCT DISAMBIGUATION FLOW VERIFIED 100%');
  console.log('========================================\n');
}

run().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
