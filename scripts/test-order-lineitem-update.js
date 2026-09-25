const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const assert = require('assert');
const { handleCatalogFlow } = require('../src/core/catalogFlow');
const { saveActiveSession, supabase } = require('../src/supabase');

async function run() {
  const senderPhone = '8262937458';
  await saveActiveSession(senderPhone, 'Unknown', 'general');

  console.log('--- Step 1: User chooses 4. Update Order ---');
  const res1 = await handleCatalogFlow('menu_4', senderPhone);
  console.log('Bot Response 1 (Recent Orders List):');
  console.log(res1.reply);
  assert(res1.handled, 'Menu 4 should be handled');
  assert(res1.reply.includes('Update Order'), 'Should have Update Order header');

  console.log('\n--- Step 2: User selects order 7 (Local Industries) ---');
  const res2 = await handleCatalogFlow('7', senderPhone);
  console.log('Bot Response 2 (Selected Order & Line Items Prompt):');
  console.log(res2.reply);
  assert(res2.handled, 'Selection 7 should be handled');
  assert(res2.reply.includes('Selected Order'), 'Should indicate selected order');
  assert(res2.reply.includes('Local Industries'), 'Should show Local Industries');
  assert(res2.reply.includes('Current Line Items:'), 'Should display Current Line Items section');
  assert(res2.reply.includes('HR Sheet'), 'Should show product name HR Sheet');

  console.log('\n--- Step 3: User replies with updated rate and quantity "Change rate to 52000 and quantity to 35 MT" ---');
  const res3 = await handleCatalogFlow('Change rate to 52000 and quantity to 35 MT', senderPhone);
  console.log('Bot Response 3 (Confirmation Summary with Calculated Values):');
  console.log(res3.reply);
  assert(res3.handled, 'Rate change should be handled');
  assert(res3.reply.includes('Local Industries'), 'Should retain Local Industries');
  assert(res3.reply.includes('52,000'), 'Should show new rate 52000');
  assert(res3.reply.includes('35 MT'), 'Should show new quantity 35 MT');
  assert(res3.reply.includes('Subtotal:'), 'Should show Subtotal calculation');
  assert(res3.reply.includes('GST (18%):'), 'Should show GST 18% calculation');
  assert(res3.reply.includes('New Total Order Value:'), 'Should show New Total Order Value');
  assert(res3.interactiveButtons, 'Should have confirmation buttons');

  console.log('\n--- Step 4: User clicks Confirm button ---');
  const res4 = await handleCatalogFlow('btn_confirm_yes', senderPhone);
  console.log('Bot Response 4 (Success Response):');
  console.log(res4.reply);
  assert(res4.handled, 'Confirm should be handled');
  assert(res4.reply.includes('Order Updated Successfully'), 'Should confirm order updated successfully');

  console.log('\n--- Step 5: Verify database record updated in deals and deal_items ---');
  const { data: updatedDeals } = await supabase
    .from('deals')
    .select('*, deal_items(*)')
    .eq('id', 'f4d98227-496e-4cb7-92d8-7cfba310d554');

  const updatedDeal = updatedDeals[0];
  console.log('Updated Deal in DB:');
  console.log(`- Deal ID: ${updatedDeal.id}`);
  console.log(`- PO Number: ${updatedDeal.po_number}`);
  console.log(`- Total Amount: ₹${updatedDeal.total_amount}`);
  console.log(`- Deal Item Rate: ₹${updatedDeal.deal_items[0].rate}`);
  console.log(`- Deal Item Quantity: ${updatedDeal.deal_items[0].quantity} ${updatedDeal.deal_items[0].unit}`);
  console.log(`- Deal Item Amount: ₹${updatedDeal.deal_items[0].amount}`);

  assert.strictEqual(Number(updatedDeal.deal_items[0].rate), 52000, 'Rate should be updated to 52000 in DB');
  assert.strictEqual(Number(updatedDeal.deal_items[0].quantity), 35, 'Quantity should be updated to 35 in DB');
  assert.strictEqual(Number(updatedDeal.deal_items[0].amount), 1820000, 'Deal item amount should be 35 * 52000 = 1820000 in DB');
  assert.strictEqual(Number(updatedDeal.total_amount), 2147600, 'Deal total_amount should be 1820000 + 18% GST = 2147600 in DB');

  console.log('\n========================================');
  console.log('ALL TESTS PASSED! ORDER LINE ITEMS FLOW VERIFIED 100%');
  console.log('========================================\n');
}

run().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
