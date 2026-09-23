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
  // 7. VERIFY COMPLAINT PO AUTO-FETCH & RESOLUTION
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n--- SECTION 7: Complaint PO Auto-Fetch & Resolution ---');

  const testPoPhone = '8262937458';
  const testPoNumber = 'PO-20260923-9085';

  // Ensure test deal exists in won stage
  await supabase.from('deals').delete().eq('po_number', testPoNumber);
  await supabase.from('complaints').delete().eq('po_number', testPoNumber);

  const { data: testDeal, error: dealErr } = await supabase.from('deals').insert({
    customer_name: 'Shiv Steel',
    po_number: testPoNumber,
    stage: 'won',
    total_amount: 236000,
    delivery_location: 'Mumbai',
    payment_terms: '10 Days',
    salesperson_phone: testPoPhone,
    created_at: new Date().toISOString()
  }).select().single();

  if (dealErr) {
    console.error('Error creating test deal:', dealErr);
  }

  const testDealId = testDeal ? testDeal.id : null;

  if (testDealId) {
    await supabase.from('deal_items').insert({
      deal_id: testDealId,
      sku_text: 'HR Sheet',
      dimensions: '2.50 mm',
      quantity: 15,
      unit: 'MT',
      rate: 55000,
      amount: 200000
    });
  }

  // Step 1: User selects option 8 (Log Customer Complaint)
  await saveActiveSession(testPoPhone, 'Unknown', 'general');
  const compStep1 = await handleCatalogFlow('8', testPoPhone);
  assert('7.1 Menu option 8 starts LOG_COMPLAINT flow',
    compStep1.handled === true && compStep1.reply.includes('Log Customer Complaint'),
    compStep1.reply
  );

  // Step 2: User provides PO number and complaint details without company name
  const compStep2 = await handleCatalogFlow('For this PO - PO: PO-20260923-9085 log a complaint about HR sheet was damaged', testPoPhone);
  assert('7.2 Auto-fetches customer and order details from PO number without asking company name',
    compStep2.handled === true &&
    compStep2.reply.includes('Shiv Steel') &&
    compStep2.reply.includes('PO-20260923-9085') &&
    compStep2.reply.includes('HR Sheet') &&
    !compStep2.reply.includes('Please provide the remaining mandatory details') &&
    compStep2.interactiveButtons && compStep2.interactiveButtons.length > 0,
    compStep2.reply
  );

  // Step 3: User confirms with "yes"
  const compStep3 = await handleCatalogFlow('yes', testPoPhone);
  assert('7.3 Complaint saved successfully with auto-fetched customer and deal details',
    compStep3.handled === true &&
    compStep3.reply.includes('Customer Complaint Logged Successfully!') &&
    compStep3.reply.includes('Shiv Steel'),
    compStep3.reply
  );

  // Clean up test data
  await supabase.from('complaints').delete().eq('po_number', testPoNumber);
  if (testDealId) await supabase.from('deal_items').delete().eq('deal_id', testDealId);
  await supabase.from('deals').delete().eq('po_number', testPoNumber);

  // ─────────────────────────────────────────────────────────────────────────────
  // 8. VERIFY COMPLAINT RESOLUTION NOTES VALIDATION & FLOW COMPLETION
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('\n--- SECTION 8: Complaint Resolution Notes Validation & Flow Completion ---');

  const testCmpPhone = '8262937458';
  const testCustomer = 'Mehta Steel';

  // Clean up any old test complaints for Mehta Steel
  await supabase.from('complaints').delete().eq('customer_name', testCustomer);

  // Insert an open test complaint for Mehta Steel
  const { data: testCmp, error: cmpInsertErr } = await supabase.from('complaints').insert({
    customer_name: testCustomer,
    complaint_type: 'Quality Defect',
    description: '10 MT HR Plates had surface rust and dimensional variance',
    status: 'open',
    reported_by: testCmpPhone,
    reported_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2 hours ago
  }).select().single();

  if (cmpInsertErr) {
    console.error('Error creating test complaint for Mehta Steel:', cmpInsertErr);
  }

  // 8.1 Start UPDATE_COMPLAINT flow
  await saveActiveSession(testCmpPhone, 'Unknown', 'general');
  const updCompStep1 = await handleCatalogFlow('9', testCmpPhone);
  assert('8.1 Menu option 9 starts UPDATE_COMPLAINT flow',
    updCompStep1.handled === true && updCompStep1.reply.includes('Update Complaint'),
    updCompStep1.reply
  );

  // 8.2 User requests to resolve complaint without resolution notes
  const updCompStep2 = await handleCatalogFlow('resolve my last complaint of Mehta Steel', testCmpPhone);
  assert('8.2 Reject command fragment as notes and prompt for Resolution Notes',
    updCompStep2.handled === true &&
    updCompStep2.reply.includes('Resolution Notes') &&
    !updCompStep2.reply.includes('my last complaint of'),
    updCompStep2.reply
  );

  // 8.3 User provides valid resolution notes
  const updCompStep3 = await handleCatalogFlow('10 MT replacement material delivered and accepted by customer', testCmpPhone);
  assert('8.3 Captures exact resolution notes and displays confirmation summary',
    updCompStep3.handled === true &&
    updCompStep3.reply.includes('Mehta Steel') &&
    updCompStep3.reply.includes('10 MT replacement material delivered and accepted by customer') &&
    updCompStep3.reply.includes('Resolved'),
    updCompStep3.reply
  );

  // 8.4 User confirms resolution with "yes"
  const updCompStep4 = await handleCatalogFlow('yes', testCmpPhone);
  assert('8.4 Complaint resolved cleanly without resume prompt loop',
    updCompStep4.handled === true &&
    updCompStep4.reply.includes('Customer Complaint Resolved Successfully!') &&
    updCompStep4.reply.includes('10 MT replacement material delivered and accepted by customer') &&
    !updCompStep4.reply.includes('You were in the middle of complaint update — do you want to continue?') &&
    !updCompStep4.reply.includes('You were in the middle of Update Customer Complaint'),
    updCompStep4.reply
  );

  // 8.5 Verify DB record is resolved and KRA 8 log was created
  const { data: resolvedCmp } = await supabase.from('complaints').select('*').eq('id', testCmp.id).single();
  assert('8.5 Complaint status in DB is resolved with resolution notes',
    resolvedCmp?.status === 'resolved' &&
    resolvedCmp?.resolution_notes === '10 MT replacement material delivered and accepted by customer' &&
    resolvedCmp?.resolved_at !== null,
    JSON.stringify(resolvedCmp)
  );

  const { data: kra8Logs } = await supabase.from('kra_logs')
    .select('*')
    .eq('customer_name', testCustomer)
    .eq('kra_number', 8)
    .order('created_at', { ascending: false })
    .limit(1);
  assert('8.6 KRA 8 log inserted into kra_logs table',
    kra8Logs && kra8Logs.length > 0 && kra8Logs[0].kra_type === 'complaint_resolved',
    JSON.stringify(kra8Logs)
  );

  // 8.6b Test specific command prompt: "update this po PO: PO-20260923-9085 compliant and mark it resolved"
  const testPoCustomer = 'Shiv Steel';
  const testPoRef = 'PO-20260923-9085';
  await supabase.from('complaints').delete().eq('po_number', testPoRef);

  const { data: testPoCmp } = await supabase.from('complaints').insert({
    customer_name: testPoCustomer,
    po_number: testPoRef,
    complaint_type: 'Physical Damage',
    description: 'HR Sheet was damaged during transport',
    status: 'open',
    reported_by: testCmpPhone,
    reported_at: new Date().toISOString(),
  }).select().single();

  await saveActiveSession(testCmpPhone, 'Unknown', 'general');
  await handleCatalogFlow('9', testCmpPhone);

  const poUpdStep1 = await handleCatalogFlow('update this po PO: PO-20260923-9085 compliant and mark it resolved', testCmpPhone);
  assert('8.6b Rejects command string as resolution notes for PO resolution command and asks for Resolution Notes',
    poUpdStep1.handled === true &&
    poUpdStep1.reply.includes('Resolution Notes') &&
    !poUpdStep1.reply.includes('update this po PO: PO-20260923-9085 compliant and mark it resolved') &&
    !poUpdStep1.reply.includes('Resolution Notes → update this po'),
    poUpdStep1.reply
  );

  const poUpdStep2 = await handleCatalogFlow('5 MT replacement coils dispatched and accepted by customer', testCmpPhone);
  assert('8.6c Captures exact resolution notes and displays confirmation summary for Shiv Steel',
    poUpdStep2.handled === true &&
    poUpdStep2.reply.includes('Shiv Steel') &&
    poUpdStep2.reply.includes('PO-20260923-9085') &&
    poUpdStep2.reply.includes('5 MT replacement coils dispatched and accepted by customer') &&
    poUpdStep2.reply.includes('Resolved'),
    poUpdStep2.reply
  );

  const poUpdStep3 = await handleCatalogFlow('yes', testCmpPhone);
  assert('8.6d Shiv Steel complaint resolved in DB with KRA 8 log and clean post-activity buttons',
    poUpdStep3.handled === true &&
    poUpdStep3.reply.includes('Customer Complaint Resolved Successfully!') &&
    poUpdStep3.reply.includes('Shiv Steel') &&
    !poUpdStep3.reply.includes('You were in the middle of'),
    poUpdStep3.reply
  );

  // Clean up test PO complaint
  await supabase.from('complaints').delete().eq('po_number', testPoRef);

  // 8.7 Direct resolution prompt validation in KRA 8 module
  const { handleComplaintResolution } = require('../src/kra8');
  // Insert a second open complaint
  await supabase.from('complaints').insert({
    customer_name: testCustomer,
    complaint_type: 'Billing Mismatch',
    description: 'Invoice rate differed by ₹500/MT',
    status: 'open',
    reported_by: testCmpPhone,
    reported_at: new Date().toISOString(),
  });

  const directReqNoNotes = await handleComplaintResolution('resolve complaint for Mehta Steel', testCmpPhone);
  assert('8.7 Direct resolution command without notes requests resolution notes',
    typeof directReqNoNotes === 'string' &&
    directReqNoNotes.includes('Resolution Notes Required for Mehta Steel'),
    directReqNoNotes
  );

  const directReqWithNotes = await handleComplaintResolution('resolve complaint for Mehta Steel - Credit note CN-2026-99 issued for ₹45,000', testCmpPhone);
  assert('8.8 Direct resolution command with valid notes resolves complaint and shows resolution summary',
    typeof directReqWithNotes === 'string' &&
    directReqWithNotes.includes('Complaint Resolved') &&
    directReqWithNotes.includes('Credit note CN-2026-99 issued for ₹45,000'),
    directReqWithNotes
  );

  // 8.9 Mid-flow complaint resolution while in Visit flow
  await saveActiveSession(testCmpPhone, 'Tech Industries', 'catalog_flow|LOG_VISIT|{"company_name":"Tech Industries"}');
  // Insert third open complaint for Mehta Steel
  await supabase.from('complaints').insert({
    customer_name: testCustomer,
    complaint_type: 'Physical Damage',
    description: 'Bending damage on 5 MT coils',
    status: 'open',
    reported_by: testCmpPhone,
    reported_at: new Date().toISOString(),
  });

  const midFlowRes = await handleCatalogFlow('resolve complaint for Mehta Steel - replacement coils delivered', testCmpPhone);
  assert('8.9 Mid-flow resolution resolves complaint and asks to resume Visit flow',
    midFlowRes.handled === true &&
    midFlowRes.reply.includes('Complaint Resolved') &&
    midFlowRes.reply.includes('Tech Industries') &&
    midFlowRes.reply.includes('do you want to continue?'),
    midFlowRes.reply
  );

  // Clean up test data
  await supabase.from('complaints').delete().eq('customer_name', testCustomer);
  await supabase.from('kra_logs').delete().eq('customer_name', testCustomer);

  // ─────────────────────────────────────────────────────────────────────────────
  // 9. CLEANUP & FINAL TEST SUMMARY
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
