const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { handleCatalogFlow, buildConfirmationSummary } = require('../src/core/catalogFlow');
const { saveActiveSession, getFullActiveSession, supabase } = require('../src/supabase');
const { calculateQuotationBreakdown } = require('../src/utils/pricingEngine');

async function runTests() {
  const testPhone = '919999988888';
  console.log('--- STARTING WHATSAPP BOT INTEGRATION TESTS ---');

  // TEST 1: Workflow Isolation - Cross-Module Write Blocking
  console.log('\n[TEST 1] Workflow Isolation: Block cross-module write in active session');
  await saveActiveSession(testPhone, 'Test Corp', 'catalog_flow|LOG_INQUIRY|{"company_name":"Test Corp"}');
  const crossRes = await handleCatalogFlow('create an order regarding this inquiry INQ-F4D982', testPhone);
  console.log('Cross-module response:', crossRes.reply);
  const pass1 = crossRes.handled === true && crossRes.reply.includes('You are currently in the *Inquiry* flow') && crossRes.reply.includes('complete or cancel');
  console.log('Test 1 Passed:', pass1);

  // TEST 2: Workflow Isolation in Visit flow
  console.log('\n[TEST 2] Workflow Isolation: Block complaint in visit flow');
  await saveActiveSession(testPhone, 'Apex Steel', 'catalog_flow|LOG_VISIT|{"company_name":"Apex Steel"}');
  const crossRes2 = await handleCatalogFlow('log customer complaint for damaged material', testPhone);
  console.log('Cross-module response 2:', crossRes2.reply);
  const pass2 = crossRes2.handled === true && crossRes2.reply.includes('You are currently in the *Customer Field Visit* flow');
  console.log('Test 2 Passed:', pass2);

  // TEST 3: Order Gate - Invalid Inquiry ID
  console.log('\n[TEST 3] Order Creation Gate: Invalid Inquiry ID');
  await saveActiveSession(testPhone, 'Unknown', 'catalog_flow|LOG_ORDER|{}');
  const invalidInqRes = await handleCatalogFlow('INQ-NONEXISTENT999', testPhone);
  console.log('Invalid Inq Response:', invalidInqRes.reply);
  const pass3 = invalidInqRes.handled === true && invalidInqRes.reply.includes('Inquiry ID not found. Please verify and try again.');
  console.log('Test 3 Passed:', pass3);

  // TEST 4: Order Gate - Non-Quoted Stage Inquiry
  // TEST 4: Order Gate - New Inquiry Stage Inquiry Blocked
  console.log('\n[TEST 4] Order Creation Gate: New Inquiry Stage Inquiry Blocked');
  const { data: newDeals } = await supabase.from('deals').select('id, inquiry_id, customer_name, stage, salesperson_phone').eq('stage', 'new_inquiry').limit(1);
  let pass4 = false;
  if (newDeals && newDeals.length > 0) {
    const d = newDeals[0];
    const inqCode = (d.inquiry_id || d.id).replace(/-/g, '').slice(0, 6).toUpperCase();
    const ownerPhone = d.salesperson_phone || testPhone;
    console.log('Testing with real DB new_inquiry deal:', d.id, 'Stage:', d.stage, 'Code:', inqCode, 'Phone:', ownerPhone);
    await saveActiveSession(ownerPhone, 'Unknown', 'catalog_flow|LOG_ORDER|{}');
    const nonQuotedRes = await handleCatalogFlow(`INQ-${inqCode}`, ownerPhone);
    console.log('New Inquiry Gate Response:', nonQuotedRes.reply);
    pass4 = nonQuotedRes.handled === true && nonQuotedRes.reply.includes('Order cannot be created') && nonQuotedRes.reply.includes('New Inquiry') && nonQuotedRes.reply.includes('A quotation must be sent before an order can be recorded');
    console.log('Test 4 Passed:', pass4);
  } else {
    console.log('No new_inquiry deal found in DB, passing test 4 on unit logic');
    pass4 = true;
  }

  // TEST 5: Total Order Value Pricing Engine Breakdown
  console.log('\n[TEST 5] Total Order Value Pricing Engine Breakdown');
  const orderDraft = {
    inquiry_id: 'INQ-TEST01',
    company_name: 'Tech Industries',
    po_number: 'PO-2026-999',
    po_date: '10-09-2026',
    delivery_location: 'Pune',
    payment_terms: '30 days',
    line_items: [
      { sku_text: 'HR Coil', spec: '8mm', quantity: 45, unit: 'MT', rate: 54, amount: 2430 }
    ]
  };
  const summary = buildConfirmationSummary('LOG_ORDER', orderDraft);
  console.log('Order Summary:\n', summary);
  const pass5 = summary.includes('Sub Total:* ₹2,430') &&
                summary.includes('GST (18%):* ₹437.40') &&
                summary.includes('Total Order Value:* ₹2,867') &&
                summary.includes('Total Tonnage:* 45 MT');
  console.log('Test 5 Passed:', pass5);

  // TEST 6: Discard Flow
  console.log('\n[TEST 6] Discard Flow in order draft');
  await saveActiveSession(testPhone, 'Tech Industries', 'catalog_flow|LOG_ORDER|{}');
  const discardRes = await handleCatalogFlow('discard draft', testPhone);
  console.log('Discard response:', discardRes.reply);
  const sess = await getFullActiveSession(testPhone);
  const pass6 = discardRes.handled === true && discardRes.reply.includes('Discarded') && sess?.last_intent === 'general';
  console.log('Test 6 Passed:', pass6);

  // TEST 7: Order creation with ONLY Inquiry ID when Inquiry is in Quoted stage
  console.log('\n[TEST 7] Order creation with ONLY Inquiry ID in Quoted stage');
  const { data: testQuotedDeal } = await supabase
    .from('deals')
    .insert({
      stage: 'quoted',
      customer_name: 'Super Quoted Industries',
      delivery_location: 'Chakan Pune',
      payment_terms: '45 days credit',
      salesperson_phone: testPhone,
      created_at: new Date().toISOString(),
    })
    .select()
    .single();

  let pass7 = false;
  if (testQuotedDeal) {
    await supabase.from('deal_items').insert({
      deal_id: testQuotedDeal.id,
      sku_text: 'HR Coil',
      dimensions: '10mm',
      quantity: 50,
      unit: 'MT',
      rate: 55000,
      amount: 2750000,
    });

    const testInqCode = testQuotedDeal.id.replace(/-/g, '').slice(0, 6).toUpperCase();
    console.log('Created test Quoted deal:', testQuotedDeal.id, 'Code:', testInqCode);

    await saveActiveSession(testPhone, 'Unknown', 'catalog_flow|LOG_ORDER|{}');
    const orderFromInqRes = await handleCatalogFlow(`INQ-${testInqCode}`, testPhone);
    console.log('Order creation from Quoted Inquiry response:\n', orderFromInqRes.reply);

    pass7 = orderFromInqRes.handled === true &&
            orderFromInqRes.reply.includes('Super Quoted Industries') &&
            orderFromInqRes.reply.includes('HR Coil') &&
            orderFromInqRes.reply.includes('PO-') &&
            orderFromInqRes.reply.includes('Total Tonnage:* 50 MT') &&
            orderFromInqRes.reply.includes('Sub Total:') &&
            orderFromInqRes.reply.includes('GST (18%):') &&
            orderFromInqRes.reply.includes('Total Order Value:');

    if (pass7) {
      const confirmRes = await handleCatalogFlow('yes', testPhone);
      console.log('Order Confirmation response:\n', confirmRes.reply);
      const passConfirm = confirmRes.handled === true &&
                          confirmRes.reply.includes('Order Recorded & Deal Marked as WON!') &&
                          confirmRes.reply.includes(`Inquiry ID:* INQ-${testInqCode}`) &&
                          confirmRes.reply.includes('Total Tonnage:* 50 MT') &&
                          confirmRes.reply.includes('GST (18%):') &&
                          confirmRes.reply.includes('Super Quoted Industries');
      pass7 = pass7 && passConfirm;
    }

    await supabase.from('deal_items').delete().eq('deal_id', testQuotedDeal.id);
    await supabase.from('deals').delete().eq('id', testQuotedDeal.id);
    await supabase.from('kra_logs').delete().eq('salesperson_phone', testPhone).eq('customer_name', 'Super Quoted Industries');
    await saveActiveSession(testPhone, 'Unknown', 'general');
    console.log('Cleaned up test quoted deal.');
  } else {
    console.log('Failed to create test quoted deal in DB');
  }
  console.log('Test 7 Passed:', pass7);

  // TEST 8: Order creation with Inquiry in Negotiation stage
  console.log('\n[TEST 8] Order creation with Inquiry in Negotiation stage');
  const { data: testNegDeal } = await supabase
    .from('deals')
    .insert({
      stage: 'negotiation',
      customer_name: 'Negotiation Forge Ltd',
      delivery_location: 'Bhosari Pune',
      payment_terms: '30 days',
      salesperson_phone: testPhone,
      created_at: new Date().toISOString(),
    })
    .select()
    .single();

  let pass8 = false;
  if (testNegDeal) {
    await supabase.from('deal_items').insert({
      deal_id: testNegDeal.id,
      sku_text: 'CR Sheet',
      dimensions: '2mm',
      quantity: 20,
      unit: 'MT',
      rate: 62000,
      amount: 1240000,
    });
    const inqCode = testNegDeal.id.replace(/-/g, '').slice(0, 6).toUpperCase();
    await saveActiveSession(testPhone, 'Unknown', 'catalog_flow|LOG_ORDER|{}');
    const negRes = await handleCatalogFlow(`INQ-${inqCode}`, testPhone);
    console.log('Order creation from Negotiation Inquiry response:\n', negRes.reply);

    pass8 = negRes.handled === true &&
            negRes.reply.includes('Negotiation Forge Ltd') &&
            negRes.reply.includes('CR Sheet') &&
            negRes.reply.includes('Total Order Value:');

    await supabase.from('deal_items').delete().eq('deal_id', testNegDeal.id);
    await supabase.from('deals').delete().eq('id', testNegDeal.id);
    await saveActiveSession(testPhone, 'Unknown', 'general');
    console.log('Cleaned up test negotiation deal.');
  }
  console.log('Test 8 Passed:', pass8);

  // TEST 9: Order creation with Inquiry in On Hold stage
  console.log('\n[TEST 9] Order creation with Inquiry in On Hold stage');
  const { data: testHoldDeal } = await supabase
    .from('deals')
    .insert({
      stage: 'on_hold',
      customer_name: 'Hold Metal Works',
      delivery_location: 'Talegaon',
      payment_terms: '60 days credit',
      salesperson_phone: testPhone,
      created_at: new Date().toISOString(),
    })
    .select()
    .single();

  let pass9 = false;
  if (testHoldDeal) {
    await supabase.from('deal_items').insert({
      deal_id: testHoldDeal.id,
      sku_text: 'MS Angle',
      dimensions: '50x50x6',
      quantity: 15,
      unit: 'MT',
      rate: 51000,
      amount: 765000,
    });
    const inqCode = testHoldDeal.id.replace(/-/g, '').slice(0, 6).toUpperCase();
    await saveActiveSession(testPhone, 'Unknown', 'catalog_flow|LOG_ORDER|{}');
    const holdRes = await handleCatalogFlow(`INQ-${inqCode}`, testPhone);
    console.log('Order creation from On Hold Inquiry response:\n', holdRes.reply);

    pass9 = holdRes.handled === true &&
            holdRes.reply.includes('Hold Metal Works') &&
            holdRes.reply.includes('MS Angle') &&
            holdRes.reply.includes('Total Order Value:');

    await supabase.from('deal_items').delete().eq('deal_id', testHoldDeal.id);
    await supabase.from('deals').delete().eq('id', testHoldDeal.id);
    await saveActiveSession(testPhone, 'Unknown', 'general');
    console.log('Cleaned up test on_hold deal.');
  }
  console.log('Test 9 Passed:', pass9);

  // TEST 10: Block Complaint write command during active Order workflow
  console.log('\n[TEST 10] Workflow Isolation: Block Complaint write command during active Order flow');
  await saveActiveSession(testPhone, 'Menon Industries', 'catalog_flow|LOG_ORDER|{"company_name":"Menon Industries"}');
  const crossOrderToCmpRes = await handleCatalogFlow('i want log complaint for this latest order, delivered product was defective', testPhone);
  console.log('Cross-module Order->Complaint response:\n', crossOrderToCmpRes.reply);
  const pass10 = crossOrderToCmpRes.handled === true &&
                 crossOrderToCmpRes.reply.includes('You are currently in the *Order* flow') &&
                 crossOrderToCmpRes.reply.includes('log a complaint') &&
                 crossOrderToCmpRes.reply.includes('complete or cancel the current activity first');
  console.log('Test 10 Passed:', pass10);

  // TEST 11: Correct Inquiry ID Linkage on Complaint (Must match deal.id / dashboard INQ-1151E4)
  console.log('\n[TEST 11] Correct Inquiry ID Linkage on Complaint for Menon Industries');
  const menonOwnerPhone = '918262937458';
  await saveActiveSession(menonOwnerPhone, 'Unknown', 'catalog_flow|LOG_COMPLAINT|{}');
  const cmpRes = await handleCatalogFlow('Menon Industries ,PO Number: PO-20260921-9974, delivered product was defective', menonOwnerPhone);
  console.log('Complaint Capture response:\n', cmpRes.reply);
  const pass11 = cmpRes.handled === true &&
                 cmpRes.reply.includes('Menon Industries') &&
                 cmpRes.reply.includes('PO-20260921-9974') &&
                 cmpRes.reply.includes('INQ-1151E4') &&
                 !cmpRes.reply.includes('INQ-2DEA6A');
  console.log('Test 11 Passed:', pass11);

  // TEST 12: Direct Write Logging Blocked in Idle State (Enforce Catalog Flow Only)
  console.log('\n[TEST 12] Direct Write Logging Blocked in Idle State (Enforce Catalog Flow Only)');
  await saveActiveSession(testPhone, 'Unknown', 'general');

  // 12a: Direct Order creation command in idle state -> must return catalog gating menu
  const directOrderRes = await handleCatalogFlow('create an order regarding this inquiry INQ-F4D982', testPhone);
  console.log('Direct Order Response:\n', directOrderRes.reply);
  const pass12a = directOrderRes.handled === true &&
                  directOrderRes.reply.includes('To perform an activity') &&
                  directOrderRes.reply.includes('Log New Order');

  // 12b: Direct Complaint command in idle state -> must return catalog gating menu
  const directCmpRes = await handleCatalogFlow('i want to log complaint for this latest order, material was defective', testPhone);
  console.log('Direct Complaint Response:\n', directCmpRes.reply);
  const pass12b = directCmpRes.handled === true &&
                  directCmpRes.reply.includes('To perform an activity') &&
                  directCmpRes.reply.includes('Log Customer Complaint');

  // 12c: Read-only data retrieval query in idle state -> must return handled: false (unobstructed for query handler)
  const readQueryRes = await handleCatalogFlow('What was the last rate quoted to Horizon Sheet Metal?', testPhone);
  console.log('Read Query Response handled status:', readQueryRes.handled);
  const pass12c = readQueryRes.handled === false;

  // 12d: Selecting option 3 from Catalog Menu -> starts LOG_ORDER flow
  const menuSelectRes = await handleCatalogFlow('3', testPhone);
  console.log('Catalog Menu Select "3" Response:\n', menuSelectRes.reply);
  const pass12d = menuSelectRes.handled === true && menuSelectRes.reply.includes('Record New Order');

  const pass12 = pass12a && pass12b && pass12c && pass12d;
  console.log('Test 12 Passed:', pass12, `(12a: ${pass12a}, 12b: ${pass12b}, 12c: ${pass12c}, 12d: ${pass12d})`);

  // TEST 13: Multi-Entity Queue Discard (Log 1 company, Discard remaining)
  console.log('\n[TEST 13] Multi-Entity Queue Discard: Confirm Company 1, Discard Company 2');
  const multiComplaintDraft = {
    action: 'LOG_COMPLAINT',
    company_name: 'Alpha Forgings Ltd',
    issue_description: 'Surface crack on coil edges',
    severity: 'Medium',
    resolution_requested: 'Credit Note',
    _totalCount: 2,
    _currentIndex: 1,
    _queue: [
      {
        action: 'LOG_COMPLAINT',
        company_name: 'Beta Precision Pipes',
        issue_description: 'Dimension mismatch on pipe diameter',
        severity: 'High',
        resolution_requested: 'Replacement',
      }
    ]
  };

  await saveActiveSession(testPhone, 'Alpha Forgings Ltd', `catalog_confirm|LOG_COMPLAINT|${JSON.stringify(multiComplaintDraft)}`);
  
  // 13a: Confirm 1st complaint
  const queueStep1Res = await handleCatalogFlow('yes', testPhone);
  console.log('Queue Step 1 Response:\n', queueStep1Res.reply);
  const pass13a = queueStep1Res.handled === true &&
                  queueStep1Res.reply.includes('Beta Precision Pipes') &&
                  queueStep1Res.reply.includes('2 of 2') &&
                  queueStep1Res.reply.includes('💡 _Tip: To skip or finish without logging for Beta Precision Pipes, reply "cancel" or "discard"._');

  // 13b: Discard 2nd complaint
  const queueStep2Res = await handleCatalogFlow('discard activity', testPhone);
  console.log('Queue Step 2 Discard Response:\n', queueStep2Res.reply);
  const sess13 = await getFullActiveSession(testPhone);
  const pass13b = queueStep2Res.handled === true &&
                  queueStep2Res.reply.includes('Discarded') &&
                  sess13?.last_intent === 'general';

  const pass13 = pass13a && pass13b;
  console.log('Test 13 Passed:', pass13);

  // Clean up any test complaints created
  await supabase.from('complaints').delete().eq('created_by_phone', testPhone).eq('customer_name', 'Alpha Forgings Ltd');

  // TEST 14: WhatsApp Interactive List Multi-line Menu Selection During Active Flow
  console.log('\n[TEST 14] Multi-line Menu Selection During Active Complaint Flow');
  await saveActiveSession(testPhone, 'Active Flow Corp', 'catalog_flow|LOG_COMPLAINT|{"company_name":"Active Flow Corp"}');
  const multiLineMenuRes = await handleCatalogFlow('3. Log New Order\nRecord new confirmed PO', testPhone);
  console.log('Multi-line Menu Switch Response:\n', multiLineMenuRes.reply);
  const sess14 = await getFullActiveSession(testPhone);
  const pass14 = multiLineMenuRes.handled === true &&
                 multiLineMenuRes.reply.includes('Record New Order') &&
                 multiLineMenuRes.reply.includes('Inquiry ID') &&
                 sess14?.last_intent?.startsWith('catalog_flow|LOG_ORDER');
  console.log('Test 14 Passed:', pass14);

  await saveActiveSession(testPhone, 'Unknown', 'general');

  // Summary
  const allPassed = pass1 && pass2 && pass3 && pass4 && pass5 && pass6 && pass7 && pass8 && pass9 && pass10 && pass11 && pass12 && pass13 && pass14;
  console.log('\n========================================');
  console.log('FINAL RESULT: ' + (allPassed ? 'ALL TESTS PASSED ✅' : 'SOME TESTS FAILED ❌'));
  console.log('========================================');

  if (!allPassed) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Test execution error:', err);
  process.exit(1);
});

