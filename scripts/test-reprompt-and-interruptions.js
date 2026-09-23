const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { handleCatalogFlow, classifyActiveSessionIntent } = require('../src/core/catalogFlow');
const { saveActiveSession, getFullActiveSession, supabase } = require('../src/supabase');

async function runComprehensiveInterruptionAudit() {
  console.log('================================================================');
  console.log('--- COMPREHENSIVE RE-PROMPT & INTERRUPTION RESILIENCE AUDIT ---');
  console.log('================================================================\n');

  const testPhone = '8262937458';
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

  // ─────────────────────────────────────────────────────────────────────────────
  // SECTION 1: USER'S EXACT INQUIRY -> VISIT BLOCK -> "45 DAYS" COMPLETION
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n--- SECTION 1: Catalog Re-Prompt Session State Preservation ---');

  // Step 1.1: Start Inquiry with partial fields
  await saveActiveSession(testPhone, 'Unknown', 'catalog_flow|LOG_INQUIRY|{}');
  const step1 = await handleCatalogFlow('maurya industries,Ms round pipe 3mm, 45 MT, gokul shirgaon, kolhapur', testPhone);
  assert('1.1 Initial inquiry prompt identifies Payment Terms as missing',
    step1.handled === true && step1.reply.includes('Payment Terms'),
    step1.reply
  );

  // Step 1.2: Send different activity (Visit logging) mid-flow
  const step2 = await handleCatalogFlow('plz log visit with menon indsutries, met rajesh,dicussed about Hr coil,follow up in next 3 days', testPhone);
  assert('1.2 Cross-module visit logging blocked with out-of-scope catalog re-prompt',
    step2.handled === true && step2.reply.includes('currently in the *Inquiry* flow') && step2.reply.includes('To log a field visit'),
    step2.reply
  );

  // Verify session in DB is still 100% intact after the re-prompt
  const sessAfterBlock = await getFullActiveSession(testPhone);
  assert('1.3 Session state remained intact in DB across the catalog re-prompt',
    sessAfterBlock?.last_intent?.startsWith('catalog_flow|LOG_INQUIRY|') &&
    sessAfterBlock?.last_intent?.includes('Maurya Industries') &&
    sessAfterBlock?.last_intent?.includes('Gokul Shirgaon, Kolhapur'),
    sessAfterBlock?.last_intent
  );

  // Step 1.3: User sends "45 days" (Payment Terms)
  const step3 = await handleCatalogFlow('45 days', testPhone);
  assert('1.4 "45 days" accepted as Payment Terms and completes Inquiry Confirmation Summary',
    step3.handled === true &&
    step3.reply.includes('Maurya Industries') &&
    step3.reply.includes('MS Round Pipe') &&
    step3.reply.includes('45 Days') &&
    step3.reply.includes('Gokul Shirgaon, Kolhapur'),
    step3.reply
  );
  assert('1.4b Confirmation summary has Save/Yes, Edit Details, Cancel interactive buttons',
    Array.isArray(step3.interactiveButtons) && step3.interactiveButtons.some(b => b.id === 'btn_confirm_yes'),
    JSON.stringify(step3.interactiveButtons)
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // SECTION 2: NESTED CUSTOMER ONBOARDING (UNRECOGNIZED CUSTOMER -> TARAK MEHTA)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n--- SECTION 2: Nested Customer Onboarding ---');

  const uniqueUnrecogCompany = `Krypton Dynamics ${Date.now().toString().slice(-4)}`;
  // Ensure not in DB
  await supabase.from('recurring_customers').delete().ilike('customer_name', '%Krypton Dynamics%');

  // Step 2.1: Inquiry with unrecognized customer
  await saveActiveSession(testPhone, 'Unknown', 'catalog_flow|LOG_INQUIRY|{}');
  const custStep1 = await handleCatalogFlow(`${uniqueUnrecogCompany}, ferry tail, 400, online, 50 days term, mumbai, HR coil 4mm - 44 MT`, testPhone);
  assert('2.1 Unrecognized customer triggers new customer onboarding ask',
    custStep1.handled === true &&
    custStep1.reply.includes('not in your customer list'),
    custStep1.reply
  );

  // Step 2.2: Confirm "Yes, Add Customer"
  const custStep2 = await handleCatalogFlow('Yes, Add Customer', testPhone);
  assert('2.2 Confirming Yes prompts for Contact Person & Mobile Number',
    custStep2.handled === true && custStep2.reply.includes('Contact Person') && custStep2.reply.includes('Mobile Number'),
    custStep2.reply
  );

  // Step 2.3: Provide contact details "tarak mehta,8945561223"
  const custStep3 = await handleCatalogFlow('tarak mehta,8945561223', testPhone);
  assert('2.3 Providing "tarak mehta,8945561223" creates customer and returns Inquiry confirmation summary',
    custStep3.handled === true &&
    (custStep3.reply.includes('Successfully Created') || custStep3.reply.includes('Created')) &&
    custStep3.reply.includes('Krypton Dynamics') &&
    custStep3.reply.includes('HR Coil'),
    custStep3.reply
  );

  // Clean up
  await supabase.from('recurring_customers').delete().ilike('customer_name', '%Krypton Dynamics%');

  // ─────────────────────────────────────────────────────────────────────────────
  // SECTION 3: MID-FLOW COMPLAINT RESOLUTION (RESOLVED ...)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n--- SECTION 3: Mid-Flow Complaint Resolution & Resumption ---');

  // Create a dummy open complaint in Supabase for recognized customer
  const dummyCust = 'Apex Precision Ltd';
  const { data: dummyCmp } = await supabase.from('complaints').insert({
    reported_by: '+918262937458',
    customer_name: dummyCust,
    description: 'Defective test sheet with surface damage',
    complaint_type: 'Quality Defect',
    status: 'open',
    reported_at: new Date().toISOString(),
  }).select().single();

  // User is in middle of an inquiry draft
  await saveActiveSession(testPhone, 'Acme Fab', 'catalog_flow|LOG_INQUIRY|{"action":"LOG_INQUIRY","company_name":"Acme Fab","product_description":"CR Sheet 2mm 10 MT"}');
  
  // User sends mid-flow complaint resolution
  const cmpRes = await handleCatalogFlow(`RESOLVED ${dummyCust} replaced defective sheet`, testPhone);
  assert('3.1 Mid-flow RESOLVED command marks complaint resolved and provides resume prompt',
    cmpRes.handled === true &&
    (cmpRes.reply.includes('Customer Complaint Resolved') || cmpRes.reply.includes('Resolved') || cmpRes.reply.includes('Status: resolved')) &&
    cmpRes.reply.includes('You were in the middle of') &&
    cmpRes.reply.includes('Acme Fab'),
    cmpRes.reply
  );

  // Resuming with "Yes, Continue" restores the inquiry draft
  const resumeRes = await handleCatalogFlow('btn_resume_yes', testPhone);
  assert('3.2 Resuming with Yes, Continue restores Acme Fab inquiry draft',
    resumeRes.handled === true &&
    (resumeRes.reply.includes('Acme Fab') || resumeRes.reply.includes('remaining mandatory details')),
    resumeRes.reply
  );

  // Clean up dummy complaint
  if (dummyCmp?.id) {
    await supabase.from('complaints').delete().eq('id', dummyCmp.id);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SECTION 4: RESUME DIRECT FIELD VALUE INGESTION
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n--- SECTION 4: Direct Field Input Mid-Resume ---');

  // Set session in catalog_resume_ask for known customer Maurya Industries
  await saveActiveSession(testPhone, 'Maurya Industries', 'catalog_resume_ask|catalog_flow|LOG_INQUIRY|{"action":"LOG_INQUIRY","company_name":"Maurya Industries","product_description":"CR Sheet 2mm 10 MT","delivery_location":"Pune","_customer_verified":true}');

  // Instead of clicking "Yes", user directly sends "30 days credit" (Payment terms)
  const directFieldRes = await handleCatalogFlow('30 days credit', testPhone);
  assert('4.1 Directly sending field value "30 days credit" in resume state immediately advances the form',
    directFieldRes.handled === true &&
    directFieldRes.reply.includes('Maurya Industries') &&
    directFieldRes.reply.includes('30 Days Credit') &&
    directFieldRes.reply.includes('CR Sheet'),
    directFieldRes.reply
  );

  console.log('\n================================================================');
  console.log(`--- AUDIT COMPLETE: ${passedTests}/${totalTests} TESTS PASSED ---`);
  console.log('================================================================\n');

  if (passedTests === totalTests) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

runComprehensiveInterruptionAudit();
