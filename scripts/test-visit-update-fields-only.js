const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const assert = require('assert');
const { handleCatalogFlow } = require('../src/core/catalogFlow');
const { saveActiveSession, supabase } = require('../src/supabase');

async function run() {
  const senderPhone = '910000000095';
  await saveActiveSession(senderPhone, 'Unknown', 'general');

  // Insert isolated test visit
  await supabase.from('customer_visits').delete().eq('salesperson_phone', senderPhone);
  const { data: testVisit } = await supabase.from('customer_visits').insert({
    salesperson_phone: senderPhone,
    customer_name: 'Maurya Industries',
    person_met: 'Anil Maurya',
    contact_no: '9820011223',
    customer_address: 'Pune',
    remarks: '[Outcome: Positive] [Location: Pune] Good meeting',
    visited_at: new Date().toISOString(),
  }).select().single();

  console.log('--- Step 1: User chooses 6. Update Field Visit ---');
  const res1 = await handleCatalogFlow('menu_6', senderPhone);
  console.log('Bot Response 1 (Recent Visits List):');
  console.log(res1.reply);
  assert(res1.handled, 'Menu 6 should be handled');

  console.log('\n--- Step 2: User selects visit 1 (Maurya Industries) ---');
  const res2 = await handleCatalogFlow('1', senderPhone);
  console.log('Bot Response 2 (Selected Visit Prompt):');
  console.log(res2.reply);
  assert(res2.handled, 'Selection 1 should be handled');
  assert(res2.reply.includes('Selected Field Visit for Maurya Industries') || res2.reply.includes('Maurya'), 'Should show selected visit');

  console.log('\n--- Step 3: User replies: "upadte the contact person phone to 5612788945" ---');
  const res3 = await handleCatalogFlow('upadte the contact person phone to 5612788945', senderPhone);
  console.log('Bot Response 3 (Confirmation Summary):');
  console.log(res3.reply);
  assert(res3.handled, 'Update should be handled');
  assert(res3.reply.includes('Contact Phone'), 'Should show Contact Phone in updating fields');
  assert(res3.reply.includes('5612788945'), 'Should show new phone 5612788945');
  assert(!res3.reply.includes('Visit Date →'), 'Should NOT show Visit Date under updating fields');
  assert(res3.interactiveButtons, 'Should provide confirmation buttons');

  console.log('\n--- Step 4: User clicks Confirm button ---');
  const res4 = await handleCatalogFlow('btn_confirm_yes', senderPhone);
  console.log('Bot Response 4 (Success Response):');
  console.log(res4.reply);
  assert(res4.handled, 'Confirm should be handled');
  assert(res4.reply.includes('Field Visit Updated Successfully'), 'Should confirm visit update');
  assert(res4.reply.includes('5612788945'), 'Should show updated phone number');
  assert(!res4.reply.includes('Visit Date:'), 'Should NOT list Visit Date as an updated field');

  console.log('\n--- Step 5: Verify database record updated in customer_visits ---');
  const { data: visits } = await supabase
    .from('customer_visits')
    .select('*')
    .ilike('customer_name', '%Maurya%')
    .order('visited_at', { ascending: false })
    .limit(1);

  const updatedVisit = visits[0];
  console.log('Updated Visit in DB:');
  console.log(`- Visit ID: ${updatedVisit.id}`);
  console.log(`- Customer: ${updatedVisit.customer_name}`);
  console.log(`- Contact No: ${updatedVisit.contact_no}`);
  console.log(`- Visited At: ${updatedVisit.visited_at}`);

  assert.strictEqual(updatedVisit.contact_no, '5612788945', 'Contact number should be updated to 5612788945 in DB');

  // Clean up test data
  if (testVisit) await supabase.from('customer_visits').delete().eq('id', testVisit.id);
  await saveActiveSession(senderPhone, 'Unknown', 'general');

  console.log('\n========================================');
  console.log('ALL TESTS PASSED! VISIT UPDATE FLOW VERIFIED 100%');
  console.log('========================================\n');
}

run().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
