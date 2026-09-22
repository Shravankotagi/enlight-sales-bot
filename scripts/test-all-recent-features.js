const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { handleCatalogFlow, buildConfirmationSummary, classifyActiveSessionIntent } = require('../src/core/catalogFlow');
const { saveActiveSession, getFullActiveSession, supabase } = require('../src/supabase');
const { calculateQuotationBreakdown } = require('../src/utils/pricingEngine');

async function runComprehensiveAudit() {
  console.log('================================================================');
  console.log('--- COMPREHENSIVE RECENT CHANGES & WORKFLOW VERIFICATION ---');
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
  // 1. VERIFY AI INTENT CLASSIFICATION IN ACTIVE SESSION
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n--- SECTION 1: AI Intent Classification for Active Session Scope ---');

  // 1.1 Field data for active activity
  const intent1 = await classifyActiveSessionIntent('LOG_VISIT', 'Met with Rajesh Sharma at Bhosari plant, outcome positive, follow up next week');
  assert('1.1 Visit field input classified as SAME_ACTIVITY', intent1.classification === 'SAME_ACTIVITY', JSON.stringify(intent1));

  // 1.2 Cross-module write attempt: Complaint while in Visit flow
  const intent2 = await classifyActiveSessionIntent('LOG_VISIT', 'log a complaint for defective 10 MT HR coil');
  assert('1.2 Cross-module complaint in visit flow classified as DIFFERENT_ACTIVITY', 
    intent2.classification === 'DIFFERENT_ACTIVITY' && (intent2.targetAction === 'LOG_COMPLAINT' || intent2.targetAction === 'UPDATE_COMPLAINT'),
    JSON.stringify(intent2)
  );

  // 1.3 Read query while in active session
  const intent3 = await classifyActiveSessionIntent('LOG_ORDER', 'What was the last rate quoted to Horizon Sheet Metal?');
  assert('1.3 Read query in order flow classified as RETRIEVAL_QUERY', intent3.classification === 'RETRIEVAL_QUERY', JSON.stringify(intent3));

  // 1.4 Stage update prompt while in active session
  const intent4 = await classifyActiveSessionIntent('LOG_ORDER', 'update the stage to price quote for above inquiry');
  assert('1.4 Stage update prompt in order flow classified as STAGE_UPDATE', intent4.classification === 'STAGE_UPDATE', JSON.stringify(intent4));

  // 1.5 Direct ID field input in active session
  const intent5 = await classifyActiveSessionIntent('LOG_ORDER', 'INQ-D013D7');
  assert('1.5 Pure Inquiry ID classified as SAME_ACTIVITY for active form', intent5.classification === 'SAME_ACTIVITY', JSON.stringify(intent5));

  // ─────────────────────────────────────────────────────────────────────────────
  // 2. VERIFY REAL DB INQUIRY LOOKUP & MID-FLOW STAGE UPDATE (INQ-D013D7)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n--- SECTION 2: Real Database Inquiry Lookup & Stage Update ---');

  // Reset INQ-D013D7 in Supabase to auto_created for clean deterministic test
  await supabase.from('inquiries').update({ status: 'auto_created', stage: 'new_inquiry' }).eq('id', 'd013d712-c64e-448f-b5da-5f328348ee61');
  await supabase.from('deals').update({ stage: 'new_inquiry', won_at: null }).or('inquiry_id.eq.d013d712-c64e-448f-b5da-5f328348ee61,id.eq.d013d712-c64e-448f-b5da-5f328348ee61');

  // 2.1 Test Order Gate blocks when inquiry is in New Inquiry stage with user-provided rate and PO
  await saveActiveSession(testPhone, 'Unknown', 'catalog_flow|LOG_ORDER|{}');
  const gateRes = await handleCatalogFlow('INQ-D013D7,recevied the Po for this inquiry with rate 50000/MT, PO number is PO-CRM-9089', testPhone);
  assert('2.1 Order creation blocked for INQ-D013D7 in New Inquiry stage', 
    gateRes.handled === true && gateRes.reply.includes('Order cannot be created') && gateRes.reply.includes('New Inquiry stage'),
    gateRes.reply
  );

  // 2.2 Test mid-flow stage update: "upadte the stage of INQ-D013D7 to quoted stage"
  const stageUpdRes = await handleCatalogFlow('upadte the stage of INQ-D013D7 to quoted stage', testPhone);
  assert('2.2 Mid-flow stage update finds INQ-D013D7 and confirms Price Quote',
    stageUpdRes.handled === true && stageUpdRes.reply.includes('Stage for INQ-D013D7 has been updated to Price Quote') && stageUpdRes.reply.includes('You were in the middle of the Order flow — do you want to continue?'),
    stageUpdRes.reply
  );
  assert('2.2b Stage update includes resume Yes/No interactive buttons',
    Array.isArray(stageUpdRes.interactiveButtons) && stageUpdRes.interactiveButtons.length === 2 && stageUpdRes.interactiveButtons[0].id === 'btn_resume_yes',
    JSON.stringify(stageUpdRes.interactiveButtons)
  );

  // 2.3 Verify DB row actually updated in inquiries table
  const { data: verifiedInq } = await supabase.from('inquiries').select('id, status').eq('id', 'd013d712-c64e-448f-b5da-5f328348ee61').single();
  assert('2.3 Database status for d013d712 is quoted', verifiedInq?.status === 'quoted', `Status: ${verifiedInq?.status}`);

  // 2.4 Verify resuming with "Yes, Continue" auto-loads DB inquiry data merged with session rate & PO, and shows confirmation summary
  const resumeRes = await handleCatalogFlow('btn_resume_yes', testPhone);
  const sessionAfterResume = await getFullActiveSession(testPhone);
  assert('2.4 Resuming with Yes auto-loads inquiry and shows pre-filled confirmation summary',
    resumeRes.handled === true &&
    resumeRes.reply.includes('INQ-D013D7') &&
    resumeRes.reply.includes('CrossMAT Ltd') &&
    resumeRes.reply.includes('PO-CRM-9089') &&
    resumeRes.reply.includes('50,000') &&
    resumeRes.reply.includes('Total Order Value:') &&
    sessionAfterResume?.last_intent?.startsWith('catalog_confirm|LOG_ORDER|'),
    resumeRes.reply
  );

  // 2.5 Confirm order with "save / yes"
  const orderConfirmRes = await handleCatalogFlow('save / yes', testPhone);
  assert('2.5 Confirming order records order and marks deal as Won',
    orderConfirmRes.handled === true &&
    orderConfirmRes.reply.includes('Order Recorded & Deal Marked as WON!') &&
    orderConfirmRes.reply.includes('INQ-D013D7'),
    orderConfirmRes.reply
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // 3. VERIFY STAGE TRANSITION VALIDATION RULES
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n--- SECTION 3: Stage Transition Gate Rules ---');

  await supabase.from('inquiries').update({ status: 'auto_created', stage: 'new_inquiry' }).eq('id', 'd013d712-c64e-448f-b5da-5f328348ee61');
  await supabase.from('deals').update({ stage: 'new_inquiry', won_at: null }).or('inquiry_id.eq.d013d712-c64e-448f-b5da-5f328348ee61,id.eq.d013d712-c64e-448f-b5da-5f328348ee61');
  const orderDraft = {
    company_name: 'CrossMAT Ltd',
    inquiry_id: 'INQ-D013D7',
    po_number: 'PO-2026-901',
    po_date: '22/09/2026'
  };
  await saveActiveSession(testPhone, 'CrossMAT Ltd', `catalog_flow|LOG_ORDER|${JSON.stringify(orderDraft)}`);
  
  const invalidTransRes = await handleCatalogFlow('mark INQ-D013D7 as won', testPhone);
  assert('3.1 Invalid transition directly from New Inquiry to Won is blocked with rule explanation',
    invalidTransRes.handled === true && invalidTransRes.reply.includes('Order cannot be marked as Won directly from New Inquiry stage'),
    invalidTransRes.reply
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // 4. VERIFY WORKFLOW ISOLATION ACROSS CORE MODULES
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n--- SECTION 4: Cross-Module Workflow Isolation ---');

  // 4.1 In Inquiry flow -> Block Order logging
  await saveActiveSession(testPhone, 'Acme Steel', 'catalog_flow|LOG_INQUIRY|{"company_name":"Acme Steel"}');
  const cross1 = await handleCatalogFlow('create a purchase order PO-1234 for 50 MT HR Coil', testPhone);
  assert('4.1 In Inquiry flow -> Block Order logging with clear prompt',
    cross1.handled === true && cross1.reply.includes('You are currently in the *Inquiry* flow') && cross1.reply.includes('To log an order'),
    cross1.reply
  );

  // 4.2 In Visit flow -> Block Complaint logging
  await saveActiveSession(testPhone, 'Acme Steel', 'catalog_flow|LOG_VISIT|{"company_name":"Acme Steel"}');
  const cross2 = await handleCatalogFlow('raise a complaint for material rejection and rust', testPhone);
  assert('4.2 In Visit flow -> Block Complaint logging with clear prompt',
    cross2.handled === true && cross2.reply.includes('You are currently in the *Field Visit* flow') && cross2.reply.includes('To log a complaint'),
    cross2.reply
  );

  // 4.3 In Complaint flow -> Block Visit logging
  await saveActiveSession(testPhone, 'Acme Steel', 'catalog_flow|LOG_COMPLAINT|{"company_name":"Acme Steel"}');
  const cross3 = await handleCatalogFlow('log a site visit for Acme Steel met Mr Rao', testPhone);
  assert('4.3 In Complaint flow -> Block Visit logging with clear prompt',
    cross3.handled === true && cross3.reply.includes('You are currently in the *Complaint* flow') && cross3.reply.includes('To log a field visit'),
    cross3.reply
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // 5. VERIFY DIRECT EXPLICIT MENU SELECTION PREEMPTION
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n--- SECTION 5: Explicit Menu Selection Preemption ---');

  // 5.1 Switching from active Visit draft to Menu 1 via interactive ID or explicit title
  await saveActiveSession(testPhone, 'Acme Steel', 'catalog_flow|LOG_VISIT|{"company_name":"Acme Steel"}');
  const menuSwitchRes = await handleCatalogFlow('menu_1', testPhone);
  const switchedSess = await getFullActiveSession(testPhone);
  assert('5.1 "menu_1" immediately switches active flow to LOG_INQUIRY',
    menuSwitchRes.handled === true && menuSwitchRes.reply.includes('Log New Inquiry') && switchedSess?.last_intent?.startsWith('catalog_flow|LOG_INQUIRY|'),
    menuSwitchRes.reply
  );

  // 5.1b In idle session, single digit "1" selects Menu 1
  await saveActiveSession(testPhone, 'Unknown', 'general');
  const digit1Res = await handleCatalogFlow('1', testPhone);
  const digit1Sess = await getFullActiveSession(testPhone);
  assert('5.1b In idle session, single digit "1" starts LOG_INQUIRY',
    digit1Res.handled === true && digit1Res.reply.includes('Log New Inquiry') && digit1Sess?.last_intent?.startsWith('catalog_flow|LOG_INQUIRY|'),
    digit1Res.reply
  );

  // 5.2 Switching via interactive menu ID "menu_5" (Log Field Visit)
  const menu5Res = await handleCatalogFlow('menu_5', testPhone);
  const sess5 = await getFullActiveSession(testPhone);
  assert('5.2 "menu_5" switches flow to LOG_VISIT',
    menu5Res.handled === true && menu5Res.reply.includes('Log Customer Field Visit') && sess5?.last_intent?.startsWith('catalog_flow|LOG_VISIT|'),
    menu5Res.reply
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // 6. VERIFY PRICING ENGINE BREAKDOWN & CONFIRMATION SUMMARY
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n--- SECTION 6: Pricing Engine & Summary Breakdown ---');

  const multiItemDraft = {
    company_name: 'Precision Fabricators Ltd',
    delivery_location: 'Sanand Gujarat',
    payment_terms: '30 Days Net',
    line_items: [
      { sku_text: 'HR Sheet 2.50 mm', spec: '2.50 mm', quantity: 20, unit: 'MT', rate: 55000, amount: 1100000 },
      { sku_text: 'CR Coil 1.20 mm', spec: '1.20 mm', quantity: 10, unit: 'MT', rate: 62000, amount: 620000 },
    ]
  };

  const quoteBreakdown = calculateQuotationBreakdown(1720000);
  assert('6.1 Pricing Engine: Subtotal calculation', quoteBreakdown.subtotal === 1720000, `Subtotal: ${quoteBreakdown.subtotal}`);
  assert('6.2 Pricing Engine: 18% GST calculation', quoteBreakdown.GST === 309600, `GST: ${quoteBreakdown.GST}`);
  assert('6.3 Pricing Engine: Grand Total calculation', quoteBreakdown.grandTotal === 2029600, `Grand Total: ${quoteBreakdown.grandTotal}`);

  const summaryText = buildConfirmationSummary('LOG_INQUIRY', multiItemDraft);
  assert('6.4 Summary renders formatted Multi-Item Breakdown with 18% GST',
    summaryText.includes('HR Sheet 2.50 mm') && summaryText.includes('CR Coil 1.20 mm') && summaryText.includes('18% GST') && summaryText.includes('20,29,600'),
    summaryText
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // 7. CLEANUP & FINAL TEST SUMMARY
  // ─────────────────────────────────────────────────────────────────────────────
  await saveActiveSession(testPhone, 'Unknown', 'general');

  console.log('\n================================================================');
  console.log(`FINAL RESULT: ${passedTests}/${totalTests} TESTS PASSED (${Math.round((passedTests / totalTests) * 100)}%)`);
  console.log('================================================================\n');

  if (passedTests === totalTests) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

runComprehensiveAudit().catch(err => {
  console.error('Fatal audit error:', err);
  process.exit(1);
});
