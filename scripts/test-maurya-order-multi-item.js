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

  console.log('\n--- Step 2: User selects order 5 (Maurya Industries: PO-MAU-2109) ---');
  const res2 = await handleCatalogFlow('5', senderPhone);
  console.log('Bot Response 2 (Selected Order & Line Items Prompt):');
  console.log(res2.reply);
  assert(res2.handled, 'Selection 5 should be handled');
  assert(res2.reply.includes('PO-MAU-2109') || res2.reply.includes('Maurya'), 'Should show Maurya / PO-MAU-2109');
  assert(res2.reply.includes('HR Plate'), 'Should show HR Plate');
  assert(res2.reply.includes('MS Channel'), 'Should show MS Channel');
  assert(res2.reply.includes('Chequered Sheet'), 'Should show Chequered Sheet');

  console.log('\n--- Step 3: User replies: "Update quantity to 35 MT for MS Channel and update the rate of HR plate to 50000/MT" ---');
  const res3 = await handleCatalogFlow('Update quantity to 35 MT for MS Channel and update the rate of HR plate to 50000/MT', senderPhone);
  console.log('Bot Response 3 (Confirmation Summary with Calculated Values):');
  console.log(res3.reply);
  assert(res3.handled, 'Multi-item update should be handled');
  assert(res3.interactiveButtons, 'Should provide confirmation buttons');

  // Verify Item 1 (HR Plate): Qty should stay 50 MT, Rate should be 50,000, Amount = 25,00,000
  assert(res3.reply.includes('50 MT @ ₹50,000/MT = ₹25,00,000'), 'HR Plate should have 50 MT @ 50,000 = 25,00,000');

  // Verify Item 2 (MS Channel): Qty should be 35 MT, Rate should stay 53,500, Amount = 18,72,500
  assert(res3.reply.includes('35 MT @ ₹53,500/MT = ₹18,72,500'), 'MS Channel should have 35 MT @ 53,500 = 18,72,500');

  // Verify Item 3 (Chequered Sheet): Qty 15 MT, Rate 57,000, Amount = 8,55,000
  assert(res3.reply.includes('15 MT @ ₹57,000/MT = ₹8,55,000'), 'Chequered sheet should remain 15 MT @ 57,000 = 8,55,000');

  // Verify Subtotal, GST, Grand Total
  assert(res3.reply.includes('₹52,27,500'), 'Subtotal should be 52,27,500');
  assert(res3.reply.includes('₹9,40,950'), 'GST 18% should be 9,40,950');
  assert(res3.reply.includes('₹61,68,450'), 'New Total Order Value should be 61,68,450');

  console.log('\n--- Step 4: User clicks Confirm button ---');
  const res4 = await handleCatalogFlow('btn_confirm_yes', senderPhone);
  console.log('Bot Response 4 (Success Response):');
  console.log(res4.reply);
  assert(res4.handled, 'Confirm should be handled');
  assert(res4.reply.includes('Order Updated Successfully'), 'Should confirm update');

  console.log('\n--- Step 5: Verify database record updated in deals and deal_items ---');
  const { data: updatedDeals } = await supabase
    .from('deals')
    .select('*, deal_items(*)')
    .ilike('po_number', '%PO-MAU-2109%')
    .limit(1);

  const updatedDeal = updatedDeals[0];
  console.log('Updated Deal in DB:');
  console.log(`- Deal ID: ${updatedDeal.id}`);
  console.log(`- PO Number: ${updatedDeal.po_number}`);
  console.log(`- Total Amount: ₹${updatedDeal.total_amount}`);
  for (const item of updatedDeal.deal_items) {
    console.log(`  * ${item.sku_text}: ${item.quantity} ${item.unit} @ ₹${item.rate} = ₹${item.amount}`);
  }

  assert.strictEqual(Number(updatedDeal.total_amount), 6168450, 'Deal total_amount should be 61,68,450 in DB');

  const hrPlate = updatedDeal.deal_items.find(i => (i.sku_text || '').toLowerCase().includes('plate'));
  assert(hrPlate, 'HR Plate should exist in deal_items');
  assert.strictEqual(Number(hrPlate.quantity), 50, 'HR Plate quantity should be 50 in DB');
  assert.strictEqual(Number(hrPlate.rate), 50000, 'HR Plate rate should be 50,000 in DB');
  assert.strictEqual(Number(hrPlate.amount), 2500000, 'HR Plate amount should be 25,00,000 in DB');

  const msChannel = updatedDeal.deal_items.find(i => (i.sku_text || '').toLowerCase().includes('channel'));
  assert(msChannel, 'MS Channel should exist in deal_items');
  assert.strictEqual(Number(msChannel.quantity), 35, 'MS Channel quantity should be 35 in DB');
  assert.strictEqual(Number(msChannel.rate), 53500, 'MS Channel rate should be 53,500 in DB');
  assert.strictEqual(Number(msChannel.amount), 1872500, 'MS Channel amount should be 18,72,500 in DB');

  console.log('\n========================================');
  console.log('ALL TESTS PASSED! MULTI-ITEM ORDER UPDATE VERIFIED 100%');
  console.log('========================================\n');
}

run().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
