require('dotenv').config();
const { handleCatalogFlow } = require('../src/core/catalogFlow');
const { getFullActiveSession, saveActiveSession, supabase } = require('../src/supabase');

async function runTest() {
  console.log('================================================================');
  console.log('--- TEST: Subsequent Retrieval Queries & Resume Prompt Preservation ---');
  console.log('================================================================\n');

  const testPhone = '919876543210';
  let totalTests = 0;
  let passedTests = 0;

  function assert(name, condition, details = '') {
    totalTests++;
    if (condition) {
      passedTests++;
      console.log(`✅ [PASS] ${name}`);
    } else {
      console.error(`❌ [FAIL] ${name}`);
      if (details) console.error(`   Details: ${details}`);
    }
  }

  // Step 1: Open Update Inquiry
  console.log('\n[Step 1] Opening Update Inquiry module...');
  const openRes = await handleCatalogFlow('update inquiry', testPhone);
  assert('1.1 Update Inquiry list is displayed',
    openRes.handled === true && openRes.reply.includes('Update Inquiry'),
    openRes.reply
  );

  const sess1 = await getFullActiveSession(testPhone);
  assert('1.2 Session state is catalog_update_select|UPDATE_INQUIRY',
    sess1?.last_intent?.startsWith('catalog_update_select|UPDATE_INQUIRY|'),
    sess1?.last_intent
  );

  // Step 2: First Retrieval Query: "shoe the inquiries made for Lexi Metal Works" (with typo 'shoe')
  console.log('\n[Step 2] User sends 1st retrieval query: "shoe the inquiries made for Lexi Metal Works"...');
  const ret1 = await handleCatalogFlow('shoe the inquiries made for Lexi Metal Works', testPhone);
  assert('2.1 First retrieval query is answered',
    ret1.handled === true,
    ret1.reply
  );
  assert('2.2 First retrieval query attaches resume prompt',
    ret1.reply.includes('You were in the middle of updating an Inquiry — do you want to continue?'),
    ret1.reply
  );
  assert('2.3 First retrieval query includes resume buttons',
    Array.isArray(ret1.interactiveButtons) && ret1.interactiveButtons.some(b => b.id === 'btn_resume_yes'),
    JSON.stringify(ret1.interactiveButtons)
  );

  const sess2 = await getFullActiveSession(testPhone);
  assert('2.4 Session state is catalog_resume_ask|catalog_update_select|UPDATE_INQUIRY',
    sess2?.last_intent?.startsWith('catalog_resume_ask|catalog_update_select|UPDATE_INQUIRY|'),
    sess2?.last_intent
  );

  // Step 3: Second Retrieval Query: "INQ-27D7BD,show this inquiry in more detail"
  console.log('\n[Step 3] User sends 2nd retrieval query: "INQ-27D7BD,show this inquiry in more detail"...');
  const ret2 = await handleCatalogFlow('INQ-27D7BD,show this inquiry in more detail', testPhone);
  assert('3.1 Second retrieval query is answered',
    ret2.handled === true,
    ret2.reply
  );
  assert('3.2 Second retrieval query STILL attaches resume prompt',
    ret2.reply.includes('You were in the middle of updating an Inquiry — do you want to continue?'),
    ret2.reply
  );
  assert('3.3 Second retrieval query includes resume buttons',
    Array.isArray(ret2.interactiveButtons) && ret2.interactiveButtons.some(b => b.id === 'btn_resume_yes'),
    JSON.stringify(ret2.interactiveButtons)
  );

  const sess3 = await getFullActiveSession(testPhone);
  assert('3.4 Session state remains catalog_resume_ask|catalog_update_select|UPDATE_INQUIRY',
    sess3?.last_intent?.startsWith('catalog_resume_ask|catalog_update_select|UPDATE_INQUIRY|'),
    sess3?.last_intent
  );

  // Step 4: Third Retrieval Query: "INQ-27D7BD details"
  console.log('\n[Step 4] User sends 3rd retrieval query: "INQ-27D7BD details"...');
  const ret3 = await handleCatalogFlow('INQ-27D7BD details', testPhone);
  assert('4.1 Third retrieval query is answered',
    ret3.handled === true,
    ret3.reply
  );
  assert('4.2 Third retrieval query STILL attaches resume prompt',
    ret3.reply.includes('You were in the middle of updating an Inquiry — do you want to continue?'),
    ret3.reply
  );
  assert('4.3 Third retrieval query includes resume buttons',
    Array.isArray(ret3.interactiveButtons) && ret3.interactiveButtons.some(b => b.id === 'btn_resume_yes'),
    JSON.stringify(ret3.interactiveButtons)
  );

  const sess4 = await getFullActiveSession(testPhone);
  assert('4.4 Session state remains catalog_resume_ask|catalog_update_select|UPDATE_INQUIRY',
    sess4?.last_intent?.startsWith('catalog_resume_ask|catalog_update_select|UPDATE_INQUIRY|'),
    sess4?.last_intent
  );

  // Step 5: User provides inquiry selection using index "1" or candidate display ID
  const rawDraft = sess4?.last_intent?.split('|').slice(3).join('|') || '{}';
  const parsedDraft = JSON.parse(rawDraft);
  const targetCandidateId = parsedDraft?.cachedRecords?.[0]?.displayId || '1';

  console.log(`\n[Step 5] User sends selection "${targetCandidateId}" to proceed with update...`);
  const selectRes = await handleCatalogFlow(targetCandidateId, testPhone);
  assert('5.1 Inquiry ID selection is handled directly',
    selectRes.handled === true,
    selectRes.reply
  );
  assert('5.2 Inquiry edit prompt is presented to user',
    selectRes.reply.includes('Selected Inquiry') || selectRes.reply.includes('What changes would you like to make') || selectRes.reply.includes('Current Line Items'),
    selectRes.reply
  );

  const sess5 = await getFullActiveSession(testPhone);
  assert('5.3 Session transitioned to catalog_flow|UPDATE_INQUIRY',
    sess5?.last_intent?.startsWith('catalog_flow|UPDATE_INQUIRY|'),
    sess5?.last_intent
  );

  // Clean up
  await saveActiveSession(testPhone, 'Unknown', 'general');

  console.log('\n================================================================');
  console.log(`--- AUDIT COMPLETE: ${passedTests}/${totalTests} TESTS PASSED ---`);
  console.log('================================================================\n');

  if (passedTests === totalTests) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

runTest().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
