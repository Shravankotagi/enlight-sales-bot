require('dotenv').config();
const { handleCatalogFlow } = require('../src/core/catalogFlow');
const { getFullActiveSession, saveActiveSession, supabase } = require('../src/supabase');

async function runTest() {
  console.log('=== TEST: Switch from Field Visit to Update Inquiry & Resume Prompt Verification ===\n');

  const testPhone = '919876543210';

  // Step 1: Start in a Field Visit flow
  console.log('[Step 1] Setup active Field Visit flow...');
  const visitDraft = {
    action: 'LOG_VISIT',
    company_name: 'Apex Precision Ltd',
    person_met: 'Rajesh Sharma',
  };
  await saveActiveSession(testPhone, 'Apex Precision Ltd', `catalog_flow|LOG_VISIT|${JSON.stringify(visitDraft)}`);
  
  const sess1 = await getFullActiveSession(testPhone);
  console.log('Session 1 intent:', sess1?.last_intent);
  if (!sess1?.last_intent?.startsWith('catalog_flow|LOG_VISIT|')) {
    throw new Error('Failed to setup initial Field Visit session');
  }

  // Step 2: User chooses "2. Update Inquiry" from Menu or sends "menu_2" / "update inquiry"
  console.log('\n[Step 2] User chooses Update Inquiry (menu_2 / "update inquiry")...');
  const switchRes = await handleCatalogFlow('menu_2', testPhone);
  console.log('Switch Response:\n', switchRes.reply);

  const sess2 = await getFullActiveSession(testPhone);
  console.log('Session 2 intent:', sess2?.last_intent);

  if (!switchRes.handled || !switchRes.reply.includes('Update Inquiry')) {
    throw new Error('Switch response did not open Update Inquiry module');
  }
  if (!sess2?.last_intent?.startsWith('catalog_update_select|UPDATE_INQUIRY|')) {
    throw new Error(`Expected session intent to start with catalog_update_select|UPDATE_INQUIRY|, got: ${sess2?.last_intent}`);
  }
  console.log('✅ Step 2 Passed: Successfully switched to Update Inquiry selection screen');

  // Step 3: User enters an inquiry query / reference "inquiry id to 898978"
  console.log('\n[Step 3] User sends "inquiry id to 898978"...');
  const queryRes = await handleCatalogFlow('inquiry id to 898978', testPhone);
  console.log('Query Response:\n', queryRes.reply);

  if (!queryRes.handled) {
    throw new Error('Expected query to be handled mid-flow');
  }
  if (queryRes.reply.includes('Field Visit')) {
    throw new Error('BUG REPRODUCED: Bot said "Field Visit" instead of "Inquiry"!');
  }
  if (!queryRes.reply.includes('You were in the middle of *Inquiry* — do you want to continue?')) {
    throw new Error(`Expected resume prompt with *Inquiry*, got: ${queryRes.reply}`);
  }
  console.log('✅ Step 3 Passed: Query answered and resume prompt correctly says *Inquiry* (NOT Field Visit)!');

  // Step 4: User clicks "Yes, Continue"
  console.log('\n[Step 4] User clicks "Yes, Continue" (btn_resume_yes)...');
  const resumeRes = await handleCatalogFlow('btn_resume_yes', testPhone);
  console.log('Resume Response:\n', resumeRes.reply);

  const sess4 = await getFullActiveSession(testPhone);
  console.log('Session 4 intent:', sess4?.last_intent);

  if (!resumeRes.handled || !resumeRes.reply.includes('Update Inquiry')) {
    throw new Error('Expected resume to re-render Update Inquiry list');
  }
  if (!sess4?.last_intent?.startsWith('catalog_update_select|UPDATE_INQUIRY|')) {
    throw new Error(`Expected session 4 intent to be catalog_update_select|UPDATE_INQUIRY|, got: ${sess4?.last_intent}`);
  }
  console.log('✅ Step 4 Passed: Successfully resumed Update Inquiry candidate selection list');

  // Step 5: Clean up session
  await saveActiveSession(testPhone, 'Unknown', 'general');
  console.log('\n========================================');
  console.log('ALL SWITCH & RESUME TESTS PASSED SUCCESSFULLY! ✅');
  console.log('========================================');
}

runTest().catch((err) => {
  console.error('\n❌ TEST FAILED:', err.message);
  process.exit(1);
});
