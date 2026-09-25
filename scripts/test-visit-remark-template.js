const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const assert = require('assert');
const { handleCatalogFlow } = require('../src/core/catalogFlow');
const { saveActiveSession, supabase } = require('../src/supabase');

async function run() {
  const senderPhone = '910000000095';
  await saveActiveSession(senderPhone, 'Unknown', 'general');

  // Clean up any old test data for this phone
  await supabase.from('customer_visits').delete().eq('salesperson_phone', senderPhone);

  // 1. Insert Visit A: Has raw tags in remarks + follow-up details
  const insertPayloadA = {
    salesperson_phone: senderPhone,
    customer_name: 'Apex Precision Tools',
    person_met: 'Mr. Karthik',
    contact_no: '9876543210',
    customer_address: 'Bhosari, Pune',
    remarks: '[Outcome: Positive] [Location: Bhosari, Pune] [FollowUp: Call next week regarding rate revision] [FollowUpDate: 2026-09-28] [FollowUpStatus: pending] Discussed 25 MT MS Plate requirement. Client asked for commercial quotation.',
    visited_at: new Date('2026-09-25T10:00:00Z').toISOString(),
  };
  const { data: visitA, error: errA } = await supabase.from('customer_visits').insert(insertPayloadA).select().single();
  if (errA) console.error('Error inserting Visit A:', errA);

  // 2. Insert Visit B: Clean visit without follow-up
  const insertPayloadB = {
    salesperson_phone: senderPhone,
    customer_name: 'Suraj Techno Systems',
    person_met: 'Suresh Patil',
    contact_no: '9811223344',
    customer_address: 'Chakan, Pune',
    remarks: 'Routine relationship meeting. Everything running smoothly.',
    visited_at: new Date('2026-09-24T10:00:00Z').toISOString(),
  };
  const { data: visitB, error: errB } = await supabase.from('customer_visits').insert(insertPayloadB).select().single();
  if (errB) console.error('Error inserting Visit B:', errB);

  console.log('--- Test 1: Fetch and select Visit A (With Follow-up & Tags) ---');
  const res1 = await handleCatalogFlow('menu_6', senderPhone);
  console.log('Bot Response 1 (Visits List):');
  console.log(res1.reply);
  assert(res1.handled, 'Menu 6 should be handled');
  assert(res1.reply.includes('Apex Precision Tools'), 'Should list Apex Precision Tools');

  console.log('\n--- Test 2: Select Option 1 (Apex Precision Tools) ---');
  const res2 = await handleCatalogFlow('1', senderPhone);
  console.log('Bot Response 2 (Selected Visit Prompt for Visit A):');
  console.log(res2.reply);

  assert(res2.handled, 'Selection should be handled');
  assert(res2.reply.includes('Selected Field Visit for Apex Precision Tools'), 'Should have header');
  assert(res2.reply.includes('• *Person Met:* Mr. Karthik'), 'Should display Person Met');
  assert(res2.reply.includes('• *Location:* Bhosari, Pune'), 'Should display Location');
  assert(res2.reply.includes('• *Outcome:* Positive'), 'Should display Outcome');
  assert(res2.reply.includes('• *Follow-up Action:* Call next week regarding rate revision'), 'Should display Follow-up Action');
  assert(res2.reply.includes('• *Follow-up Date:* 28-09-2026'), 'Should display Follow-up Date formatted');
  assert(res2.reply.includes('• *Follow-up Status:* Pending'), 'Should display Follow-up Status');
  assert(res2.reply.includes('• *Remarks:* Discussed 25 MT MS Plate requirement. Client asked for commercial quotation.'), 'Should have clean remarks without tags');
  assert(!res2.reply.includes('[Outcome:'), 'Remarks must not contain [Outcome: ...]');
  assert(!res2.reply.includes('[Location:'), 'Remarks must not contain [Location: ...]');
  assert(!res2.reply.includes('[FollowUp:'), 'Remarks must not contain [FollowUp: ...]');
  assert(!res2.reply.includes('[FollowUpDate:'), 'Remarks must not contain [FollowUpDate: ...]');
  assert(!res2.reply.includes('[FollowUpStatus:'), 'Remarks must not contain [FollowUpStatus: ...]');

  console.log('\n--- Test 3: Select Visit B (Without Follow-up) ---');
  await saveActiveSession(senderPhone, 'Unknown', 'general');
  await handleCatalogFlow('menu_6', senderPhone);
  const res3 = await handleCatalogFlow('2', senderPhone);
  console.log('Bot Response 3 (Selected Visit Prompt for Visit B):');
  console.log(res3.reply);

  assert(res3.handled, 'Selection 2 should be handled');
  assert(res3.reply.includes('Selected Field Visit for Suraj Techno Systems'), 'Should have header');
  assert(res3.reply.includes('• *Person Met:* Suresh Patil'), 'Should display Person Met');
  assert(res3.reply.includes('• *Location:* Chakan, Pune'), 'Should display Location');
  assert(res3.reply.includes('• *Outcome:* Positive'), 'Should display Outcome');
  assert(!res3.reply.includes('• *Follow-up Action:*'), 'Should not display Follow-up Action when absent');
  assert(!res3.reply.includes('• *Follow-up Date:*'), 'Should not display Follow-up Date when absent');
  assert(!res3.reply.includes('• *Follow-up Status:*'), 'Should not display Follow-up Status when absent');
  assert(res3.reply.includes('• *Remarks:* Routine relationship meeting. Everything running smoothly.'), 'Should display clean remarks');

  // Clean up
  await supabase.from('customer_visits').delete().eq('salesperson_phone', senderPhone);
  await saveActiveSession(senderPhone, 'Unknown', 'general');

  console.log('\n========================================');
  console.log('ALL TESTS PASSED! FIELD VISIT & REMARK TEMPLATE VERIFIED 100%');
  console.log('========================================\n');
}

run().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
