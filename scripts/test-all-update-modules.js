const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { handleCatalogFlow } = require('../src/core/catalogFlow');
const { saveActiveSession, getFullActiveSession, supabase } = require('../src/supabase');

const TEST_PHONE = '910000000097';

async function runAllModulesTest() {
  console.log('================================================================');
  console.log('--- TESTING ALL UPDATE MODULES & CROSS-FLOW PREEMPTION ---');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  async function assert(condition, name, details = '') {
    if (condition) {
      console.log(`✅ PASS: ${name}`);
      passed++;
    } else {
      console.error(`❌ FAIL: ${name}`);
      if (details) console.error(`   Details: ${details}`);
      failed++;
    }
  }

  try {
    // -------------------------------------------------------------
    // MODULE 1: UPDATE_INQUIRY (menu_2)
    // -------------------------------------------------------------
    console.log('\n--- 1. Testing UPDATE_INQUIRY Flow ---');
    await saveActiveSession(TEST_PHONE, 'Unknown', 'general');
    const inqRes = await handleCatalogFlow('menu_2', TEST_PHONE);
    console.log('Update Inquiry Prompt:\n', inqRes.reply?.slice(0, 200));

    await assert(inqRes.handled === true, '1.1 menu_2 handled by catalog flow');
    await assert(inqRes.reply.includes('Update Inquiry'), '1.2 Displays Update Inquiry header');

    // Select record #1 from mock/real list
    const mockInqState = {
      action: 'UPDATE_INQUIRY',
      page: 1,
      totalCount: 2,
      cachedRecords: [
        {
          index: 1,
          id: 'inq-test-01',
          deal_id: 'deal-test-01',
          inquiry_id: 'INQ-9911AA',
          displayId: 'INQ-9911AA',
          customer_name: 'Apex Precision Ltd',
          product_summary: '50 MT HR Plates',
          stage: 'Quoted',
          date_formatted: '25-09-2026',
          payment_terms: '30 Days',
          delivery_location: 'Pune',
        },
      ],
    };
    await saveActiveSession(TEST_PHONE, 'Apex Precision Ltd', `catalog_update_select|UPDATE_INQUIRY|${JSON.stringify(mockInqState)}`);
    const inqSel = await handleCatalogFlow('1', TEST_PHONE);
    console.log('Inquiry Record #1 Selected:\n', inqSel.reply);

    await assert(inqSel.handled === true, '1.3 Record selection handled');
    await assert(inqSel.reply.includes('INQ-9911AA'), '1.4 Displays Selected Inquiry ID');
    await assert(inqSel.reply.includes('Apex Precision Ltd'), '1.5 Displays Customer Name');
    await assert(inqSel.reply.includes('What details would you like to update?'), '1.6 Prompts for fields to update');
    await assert(!inqSel.reply.includes('Please provide the Inquiry ID'), '1.7 Does NOT re-ask Inquiry ID');

    // Provide field update
    const inqUpd = await handleCatalogFlow('Payment terms: 45 Days Credit, Rate: 56000 per MT', TEST_PHONE);
    console.log('Inquiry Update Output:\n', inqUpd.reply);

    await assert(inqUpd.handled === true, '1.8 Field update processed');
    await assert(inqUpd.interactiveType === 'buttons', '1.9 Returned confirmation buttons');
    await assert(inqUpd.reply.includes('INQ-9911AA'), '1.10 Confirmation retains Inquiry ID');
    await assert(inqUpd.reply.includes('45 Days Credit'), '1.11 Confirmation has updated payment terms');
    await assert(inqUpd.reply.includes('56,000'), '1.12 Confirmation has updated rate');

    // -------------------------------------------------------------
    // MODULE 2: UPDATE_ORDER (menu_4)
    // -------------------------------------------------------------
    console.log('\n--- 2. Testing UPDATE_ORDER Flow ---');
    await saveActiveSession(TEST_PHONE, 'Unknown', 'general');
    const ordRes = await handleCatalogFlow('menu_4', TEST_PHONE);
    console.log('Update Order Prompt:\n', ordRes.reply?.slice(0, 200));

    await assert(ordRes.handled === true, '2.1 menu_4 handled by catalog flow');
    await assert(ordRes.reply.includes('Update Order') || ordRes.reply.includes('recent orders') || ordRes.reply.includes('No Orders Found'), '2.2 Displays Update Order header / records');

    // Select record #1
    const mockOrdState = {
      action: 'UPDATE_ORDER',
      page: 1,
      totalCount: 2,
      cachedRecords: [
        {
          index: 1,
          id: 'deal-ord-01',
          deal_id: 'deal-ord-01',
          inquiry_id: 'inq-ord-01',
          displayId: 'PO-2026-8801',
          po_number: 'PO-2026-8801',
          deal_code: 'INQ-8801AA',
          customer_name: 'Bhushan Power & Steel',
          product_summary: '100 MT CR Coil',
          stage: 'Won',
          date_formatted: '25-09-2026',
          delivery_location: 'Mumbai',
          payment_terms: '100% Advance',
          total_amount: 5500000,
        },
      ],
    };
    await saveActiveSession(TEST_PHONE, 'Bhushan Power & Steel', `catalog_update_select|UPDATE_ORDER|${JSON.stringify(mockOrdState)}`);
    const ordSel = await handleCatalogFlow('1', TEST_PHONE);
    console.log('Order Record #1 Selected:\n', ordSel.reply);

    await assert(ordSel.handled === true, '2.3 Order selection handled');
    await assert(ordSel.reply.includes('PO-2026-8801'), '2.4 Displays Selected PO Number');
    await assert(ordSel.reply.includes('Bhushan Power & Steel'), '2.5 Displays Customer Name');
    await assert(ordSel.reply.includes('What changes would you like to make to the line items?') || ordSel.reply.includes('What details would you like to update?'), '2.6 Prompts for fields to update');
    await assert(!ordSel.reply.includes('To identify the order, please provide'), '2.7 Does NOT ask for PO number / ID again');

    // Provide field update
    const ordUpd = await handleCatalogFlow('Delivery Location: MIDC Taloja Navi Mumbai, Delivery Date: 30-09-2026', TEST_PHONE);
    console.log('Order Update Output:\n', ordUpd.reply);

    await assert(ordUpd.handled === true, '2.8 Order update processed');
    await assert(ordUpd.interactiveType === 'buttons', '2.9 Returned confirmation buttons');
    await assert(ordUpd.reply.includes('PO-2026-8801'), '2.10 Retains PO number');
    await assert(ordUpd.reply.includes('MIDC Taloja Navi Mumbai') || ordUpd.reply.includes('Taloja'), '2.11 Retains delivery location update');

    // -------------------------------------------------------------
    // MODULE 3: UPDATE_VISIT (menu_6)
    // -------------------------------------------------------------
    console.log('\n--- 3. Testing UPDATE_VISIT Flow ---');
    await saveActiveSession(TEST_PHONE, 'Unknown', 'general');
    const visRes = await handleCatalogFlow('menu_6', TEST_PHONE);
    console.log('Update Visit Prompt:\n', visRes.reply?.slice(0, 200));

    await assert(visRes.handled === true, '3.1 menu_6 handled by catalog flow');
    await assert(visRes.reply.includes('Update Field Visit') || visRes.reply.includes('recent field visits') || visRes.reply.includes('No Field Visits Found'), '3.2 Displays Update Visit header / records');

    // Select record #1
    const mockVisState = {
      action: 'UPDATE_VISIT',
      page: 1,
      totalCount: 2,
      cachedRecords: [
        {
          index: 1,
          id: 'vis-test-01',
          customer_name: 'Supreme Infrastructure Ltd',
          location: 'Thane West',
          outcome: 'Positive',
          date_formatted: '24-09-2026',
          person_met: 'Mr. Arvind Gupta',
          remarks: 'Discussed upcoming Q3 quarterly requirement',
        },
      ],
    };
    await saveActiveSession(TEST_PHONE, 'Supreme Infrastructure Ltd', `catalog_update_select|UPDATE_VISIT|${JSON.stringify(mockVisState)}`);
    const visSel = await handleCatalogFlow('1', TEST_PHONE);
    console.log('Visit Record #1 Selected:\n', visSel.reply);

    await assert(visSel.handled === true, '3.3 Visit selection handled');
    await assert(visSel.reply.includes('Supreme Infrastructure Ltd'), '3.4 Displays Customer Name');
    await assert(visSel.reply.includes('Mr. Arvind Gupta'), '3.5 Displays Person Met');
    await assert(visSel.reply.includes('What details would you like to update?'), '3.6 Prompts for fields to update');
    await assert(!visSel.reply.includes('Customer / Company Name'), '3.7 Does NOT re-ask customer name');

    // Provide field update
    const visUpd = await handleCatalogFlow('Person Met: Mr. Arvind Gupta (Director), Outcome: Positive, Remarks: Agreed on 75 MT trial order for HR Coil', TEST_PHONE);
    console.log('Visit Update Output:\n', visUpd.reply);

    await assert(visUpd.handled === true, '3.8 Visit update processed');
    await assert(visUpd.interactiveType === 'buttons', '3.9 Returned confirmation buttons');
    await assert(visUpd.reply.includes('Supreme Infrastructure Ltd'), '3.10 Retains Customer Name');
    await assert(visUpd.reply.includes('Arvind Gupta') || visUpd.reply.includes('Trial order'), '3.11 Retains visit updates');

    // -------------------------------------------------------------
    // MODULE 4: UPDATE_COMPLAINT (menu_9)
    // -------------------------------------------------------------
    console.log('\n--- 4. Testing UPDATE_COMPLAINT Flow ---');
    await saveActiveSession(TEST_PHONE, 'Unknown', 'general');
    const cmpRes = await handleCatalogFlow('menu_9', TEST_PHONE);
    console.log('Update Complaint Prompt:\n', cmpRes.reply?.slice(0, 200));

    await assert(cmpRes.handled === true, '4.1 menu_9 handled by catalog flow');
    await assert(cmpRes.reply.includes('Update Complaint') || cmpRes.reply.includes('active complaints') || cmpRes.reply.includes('No Active Complaints Found'), '4.2 Displays Update Complaint header / records');

    // Select record #1
    const mockCmpState = {
      action: 'UPDATE_COMPLAINT',
      page: 1,
      totalCount: 2,
      cachedRecords: [
        {
          index: 1,
          id: 'cmp-test-01',
          displayId: 'COMP-771122',
          customer_name: 'Kirloskar Pneumatic Co',
          complaint_type: 'Specification Mismatch',
          status: 'Open',
          date_formatted: '25-09-2026',
          description: 'Thickness variance on 12mm plates',
          po_number: 'PO-KIR-9090',
        },
      ],
    };
    await saveActiveSession(TEST_PHONE, 'Kirloskar Pneumatic Co', `catalog_update_select|UPDATE_COMPLAINT|${JSON.stringify(mockCmpState)}`);
    const cmpSel = await handleCatalogFlow('1', TEST_PHONE);
    console.log('Complaint Record #1 Selected:\n', cmpSel.reply);

    await assert(cmpSel.handled === true, '4.3 Complaint selection handled');
    await assert(cmpSel.reply.includes('COMP-771122'), '4.4 Displays Complaint ID');
    await assert(cmpSel.reply.includes('Kirloskar Pneumatic Co'), '4.5 Displays Customer Name');
    await assert(cmpSel.reply.includes('What details would you like to update?'), '4.6 Prompts for fields to update');
    await assert(!cmpSel.reply.includes('Customer Name OR Linked PO Number'), '4.7 Does NOT re-ask for ID / Customer');

    // Provide resolution update
    const cmpUpd = await handleCatalogFlow('Mark as Resolved, resolution notes: Replaced 10 MT plates with calibrated tolerance coils from plant', TEST_PHONE);
    console.log('Complaint Update Output:\n', cmpUpd.reply);

    await assert(cmpUpd.handled === true, '4.8 Complaint update processed');
    await assert(cmpUpd.interactiveType === 'buttons', '4.9 Returned confirmation buttons');
    await assert(cmpUpd.reply.includes('Kirloskar Pneumatic Co'), '4.10 Retains Customer Name');
    await assert(cmpUpd.reply.includes('Resolved'), '4.11 Retains status Resolved');
    await assert(cmpUpd.reply.includes('Replaced 10 MT plates'), '4.12 Retains resolution notes');

    // -------------------------------------------------------------
    // MODULE 5: CROSS-MODULE PREEMPTION MATRIX
    // -------------------------------------------------------------
    console.log('\n--- 5. Cross-Module Preemption Matrix ---');
    // Scenario 5.1: In LOG_ORDER -> click menu_6 (Update Visit)
    await saveActiveSession(TEST_PHONE, 'Apex Steel', 'catalog_flow|LOG_ORDER|{}');
    const p1 = await handleCatalogFlow('menu_6', TEST_PHONE);
    await assert(p1.handled === true && !p1.reply.includes('You are currently in the Order flow'), '5.1 LOG_ORDER -> menu_6 switches cleanly');

    // Scenario 5.2: In UPDATE_VISIT -> click menu_4 (Update Order)
    await saveActiveSession(TEST_PHONE, 'Apex Steel', 'catalog_flow|UPDATE_VISIT|{}');
    const p2 = await handleCatalogFlow('menu_4', TEST_PHONE);
    await assert(p2.handled === true && !p2.reply.includes('You are currently in the Field Visit flow'), '5.2 UPDATE_VISIT -> menu_4 switches cleanly');

    // Scenario 5.3: In LOG_COMPLAINT -> click menu_2 (Update Inquiry)
    await saveActiveSession(TEST_PHONE, 'Apex Steel', 'catalog_flow|LOG_COMPLAINT|{}');
    const p3 = await handleCatalogFlow('menu_2', TEST_PHONE);
    await assert(p3.handled === true && !p3.reply.includes('You are currently in the Complaint flow'), '5.3 LOG_COMPLAINT -> menu_2 switches cleanly');

    // Scenario 5.4: In UPDATE_INQUIRY -> click menu_1 (Log Inquiry)
    await saveActiveSession(TEST_PHONE, 'Apex Steel', 'catalog_flow|UPDATE_INQUIRY|{}');
    const p4 = await handleCatalogFlow('menu_1', TEST_PHONE);
    await assert(p4.handled === true && p4.reply.includes('Log New Inquiry'), '5.4 UPDATE_INQUIRY -> menu_1 launches Log New Inquiry');

    // Scenario 5.5: In LOG_NEW_CUSTOMER -> click menu_9 (Update Complaint)
    await saveActiveSession(TEST_PHONE, 'Apex Steel', 'catalog_flow|LOG_NEW_CUSTOMER|{}');
    const p5 = await handleCatalogFlow('menu_9', TEST_PHONE);
    await assert(p5.handled === true && !p5.reply.includes('You are currently in the Customer Acquisition flow'), '5.5 LOG_NEW_CUSTOMER -> menu_9 switches cleanly');

    // Scenario 5.6: In active flow -> click menu_10 (General Query)
    await saveActiveSession(TEST_PHONE, 'Apex Steel', 'catalog_flow|LOG_INQUIRY|{}');
    const p6 = await handleCatalogFlow('menu_10', TEST_PHONE);
    await assert(p6.handled === true && p6.reply.includes('SalesOS Search & Intelligence'), '5.6 LOG_INQUIRY -> menu_10 opens search intelligence');

    // -------------------------------------------------------------
    // MODULE 6: CANCEL & RESET CONTROLS
    // -------------------------------------------------------------
    console.log('\n--- 6. Cancel & Reset Controls in Selection State ---');
    await saveActiveSession(TEST_PHONE, 'Apex Steel', `catalog_update_select|UPDATE_INQUIRY|${JSON.stringify(mockInqState)}`);
    const c1 = await handleCatalogFlow('cancel', TEST_PHONE);
    await assert(c1.handled === true && c1.reply.includes('Activity cancelled'), '6.1 "cancel" cancels update selection and shows menu');

    const finalSession = await getFullActiveSession(TEST_PHONE);
    await assert(finalSession?.last_intent === 'general', '6.2 Session reset to general');

    // Cleanup
    await saveActiveSession(TEST_PHONE, 'Unknown', 'general');

  } catch (err) {
    console.error('Test execution error:', err);
    failed++;
  }

  console.log(`\n================================================================`);
  console.log(`FINAL SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log(`================================================================\n`);
  if (failed > 0) process.exit(1);
}

runAllModulesTest();
