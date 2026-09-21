const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { handleCatalogFlow } = require('../src/core/catalogFlow');
const { saveActiveSession, supabase } = require('../src/supabase');

async function testUpdateVisit() {
  const testPhone = '918262937458';
  console.log('--- Testing UPDATE_VISIT flow for Apex Precision Ltd ---');

  // 1. Reset Apex Precision visit record to test state
  await supabase.from('customer_visits').update({
    outcome: 'positive',
    customer_address: 'Bhosari Pune',
    follow_up_action: 'Send official price quotation by Friday',
    follow_up_date: '2026-09-25',
    follow_up_status: 'pending',
    follow_up_completed_at: null,
    remarks: '[Outcome: Positive] [Location: Bhosari Pune] [FollowUp: Send official price quotation by Friday] [FollowUpDate: 2026-09-25] [FollowUpStatus: pending] Met procurement team. Discussed pricing.'
  }).eq('id', '5b5a3b02-0975-4b47-a981-eb54c786d4fe');

  // 2. Start UPDATE_VISIT session
  await saveActiveSession(testPhone, 'Apex Precision Ltd', 'catalog_flow|UPDATE_VISIT|{"company_name":"Apex Precision Ltd"}');

  // 3. User provides updated remarks
  const res1 = await handleCatalogFlow('meeting remarks: Quote sent and client approved trial lot', testPhone);
  console.log('\n[Capture Response]:\n', res1.reply);

  // 4. User confirms
  const res2 = await handleCatalogFlow('confirm', testPhone);
  console.log('\n[Confirm Response]:\n', res2.reply);

  // 5. Inspect DB row
  const { data: updated } = await supabase.from('customer_visits').select('*').eq('id', '5b5a3b02-0975-4b47-a981-eb54c786d4fe').single();
  console.log('\n[Updated DB Record in customer_visits]:\n', updated);

  const passOutcome = updated.remarks.includes('[Outcome: Positive]');
  const passLocation = updated.remarks.includes('[Location: Bhosari Pune]');
  const passFollowUp = updated.follow_up_action === 'Send official price quotation by Friday';
  const passStatus = updated.follow_up_status === 'completed';
  const passRemarks = updated.remarks.includes('Quote sent and client approved trial lot');

  console.log('\nVerification:');
  console.log('- Outcome preserved in remarks:', passOutcome);
  console.log('- Location preserved in remarks:', passLocation);
  console.log('- FollowUp preserved:', passFollowUp);
  console.log('- FollowUp status marked completed:', passStatus);
  console.log('- New remarks saved:', passRemarks);

  if (passOutcome && passLocation && passFollowUp && passStatus && passRemarks) {
    console.log('\n🎉 ALL UPDATE_VISIT VERIFICATIONS PASSED SUCCESSFULLY!');
  } else {
    console.error('\n❌ UPDATE_VISIT VERIFICATION FAILED!');
    process.exit(1);
  }
}

testUpdateVisit().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
