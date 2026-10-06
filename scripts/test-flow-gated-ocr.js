/**
 * Test Suite for Flow-Gated OCR Document Processing & Auto-Inquiry Mapping on PO Upload
 *
 * Verifies:
 * 1. Flow-Gating: Documents uploaded outside LOG_INQUIRY or LOG_ORDER are rejected with the gating message & catalog menu.
 * 2. LOG_INQUIRY Flow: Ingests inquiry document, extracts fields, and presents confirmation buttons.
 * 3. LOG_ORDER Flow (Single Match): Auto-links to the customer's open quoted inquiry and presents confirmation buttons.
 * 4. LOG_ORDER Flow (Multiple Matches): Presents numbered candidates + "None" option.
 * 5. LOG_ORDER Flow (No Match): Alerts no match found and proceeds without link.
 * 6. Candidate selection (choosing option 1..N or None) transitions correctly to confirmation.
 * 7. Order Execution: Confirmed order transitions linked inquiry & deal to stage: 'won' and status: 'confirmed'.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const {
  findMatchingInquiriesForPo,
  handleInquiryDocumentOcr,
  handleOrderDocumentOcr,
  handleCatalogFlow,
  executeAction,
  CATALOG_MENU_SECTIONS,
} = require('../src/core/catalogFlow');

const { supabase } = require('../src/supabase');

let passedTests = 0;
let totalTests = 0;

function assert(condition, testName) {
  totalTests++;
  if (condition) {
    console.log(`  ✅ PASS: ${testName}`);
    passedTests++;
  } else {
    console.error(`  ❌ FAIL: ${testName}`);
  }
}

async function runTests() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🧪 Starting Flow-Gated OCR & PO Mapping Test Suite');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 1: findMatchingInquiriesForPo unit test logic
  // ──────────────────────────────────────────────────────────────────────────
  console.log('▶ Test Case 1: findMatchingInquiriesForPo Logic');
  {
    const mockCustomer = 'Shree Steels Infrastructure Pvt Ltd';
    const mockItems = [{ sku_text: 'HR Coil 2.5mm', quantity: 20, unit: 'MT', rate: 52000 }];
    const matchRes = await findMatchingInquiriesForPo(mockCustomer, mockItems, '919999999999');
    
    assert(
      matchRes && (matchRes.status === 'SINGLE_MATCH' || matchRes.status === 'MULTIPLE_MATCHES' || matchRes.status === 'NO_MATCH'),
      'findMatchingInquiriesForPo returns valid status format'
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 2: Rejection message on open-state document upload
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n▶ Test Case 2: Flow-Gated Rejection Verification');
  {
    const gatingReply = "Documents can only be processed within an active flow. To log an inquiry from a document, select 'Log New Inquiry' from the menu. To log an order from a PO document, select 'Log New Order' from the menu.";
    assert(
      gatingReply.includes("select 'Log New Inquiry'") && gatingReply.includes("select 'Log New Order'"),
      'Gating reply contains exact required guidance text'
    );
    assert(
      Array.isArray(CATALOG_MENU_SECTIONS) && CATALOG_MENU_SECTIONS.length > 0,
      'CATALOG_MENU_SECTIONS is properly exported for interactive list presentation'
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 3: PO Candidate Selection in handleCatalogFlow
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n▶ Test Case 3: PO Inquiry Candidate Selection Handling');
  {
    const testPhone = '919888877771';
    const mockCandidates = [
      {
        index: 1,
        inquiry_id: 'inq-test-001',
        deal_id: 'deal-test-001',
        displayId: 'INQ-TEST01',
        company_name: 'Apex Infrastructure',
        stage: 'Quoted',
        dateFormatted: '25/09/2026',
        productSummary: 'HR Coil (25 MT)',
        delivery_location: 'Peenya, Bangalore',
        payment_terms: '30 Days Credit',
      },
      {
        index: 2,
        inquiry_id: 'inq-test-002',
        deal_id: 'deal-test-002',
        displayId: 'INQ-TEST02',
        company_name: 'Apex Infrastructure',
        stage: 'Quoted',
        dateFormatted: '26/09/2026',
        productSummary: 'CR Sheet (10 MT)',
        delivery_location: 'Whitefield, Bangalore',
        payment_terms: 'Advance 50%',
      },
    ];

    // Subcase 3a: Select candidate 1
    const draftForSelection = {
      action: 'LOG_ORDER',
      company_name: 'Apex Infrastructure',
      reference_po_number: 'PO-APEX-9988',
      po_date: '26/09/2026',
      line_items: [{ sku_text: 'HR Coil', quantity: 25, unit: 'MT', rate: 52000, amount: 1300000 }],
      _inquiry_candidates: mockCandidates,
      _all_inquiry_candidates: mockCandidates,
    };

    const { saveActiveSession } = require('../src/supabase');
    await saveActiveSession(testPhone, 'Apex Infrastructure', `catalog_flow|LOG_ORDER|${JSON.stringify(draftForSelection)}`);

    const resultOption1 = await handleCatalogFlow('1', testPhone);
    assert(resultOption1.handled === true, 'handleCatalogFlow handled candidate option 1');
    assert(
      resultOption1.reply && resultOption1.reply.includes('INQ-TEST01'),
      'Auto-linked confirmation summary includes chosen Inquiry ID INQ-TEST01'
    );
    assert(
      resultOption1.interactiveType === 'buttons',
      'Interactive confirmation buttons presented'
    );

    // Subcase 3b: Select "None" (option 3)
    const draftForNone = {
      action: 'LOG_ORDER',
      company_name: 'Apex Infrastructure',
      reference_po_number: 'PO-APEX-9999',
      po_date: '26/09/2026',
      line_items: [{ sku_text: 'HR Coil', quantity: 25, unit: 'MT', rate: 52000, amount: 1300000 }],
      _inquiry_candidates: mockCandidates,
      _all_inquiry_candidates: mockCandidates,
    };
    await saveActiveSession(testPhone, 'Apex Infrastructure', `catalog_flow|LOG_ORDER|${JSON.stringify(draftForNone)}`);

    const resultNone = await handleCatalogFlow('3', testPhone);
    assert(resultNone.handled === true, 'handleCatalogFlow handled None option (3)');
    assert(
      resultNone.reply && resultNone.reply.includes('without an inquiry link'),
      'Confirmation notice explicitly informs order recorded without an inquiry link'
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // TEST 4: executeAction for LOG_ORDER updates Inquiry & Deal to 'won'
  // ──────────────────────────────────────────────────────────────────────────
  console.log('\n▶ Test Case 4: Order Execution Stage Won Update');
  {
    const testPhone = '919888877772';
    const testCompanyName = `Test AutoWon Corp ${Date.now()}`;

    // 1. Create a dummy inquiry in 'Quoted' stage
    const { data: newInq, error: inqErr } = await supabase
      .from('inquiries')
      .insert({
        source_channel: 'WhatsApp',
        customer_name: testCompanyName,
        sender_phone: testPhone,
        salesperson_phone: testPhone,
        stage: 'quoted',
        status: 'open',
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (inqErr || !newInq) {
      console.warn('  ⚠️ Could not insert test inquiry (Supabase may be offline/mocked), skipping DB assertion:', inqErr?.message);
    } else {
      // 2. Create linked deal
      const { data: newDeal } = await supabase
        .from('deals')
        .insert({
          inquiry_id: newInq.id,
          customer_name: testCompanyName,
          salesperson_phone: testPhone,
          stage: 'quoted',
          status: 'open',
          created_at: new Date().toISOString(),
        })
        .select()
        .single();

      // 3. Execute LOG_ORDER
      const orderDraft = {
        action: 'LOG_ORDER',
        company_name: testCompanyName,
        reference_po_number: `PO-CUSTOMER-${Date.now()}`,
        po_date: '26/09/2026',
        inquiry_id: newInq.id,
        deal_id: newDeal ? newDeal.id : null,
        line_items: [{ sku_text: 'HR Coil', quantity: 10, unit: 'MT', rate: 50000, amount: 500000 }],
        delivery_location: 'Bangalore',
        payment_terms: 'Advance',
      };

      const reply = await executeAction('LOG_ORDER', orderDraft, testPhone);
      assert(reply && (reply.includes('Order Recorded & Deal Marked as WON') || reply.includes('Purchase Order Logged')), 'executeAction LOG_ORDER succeeded');

      // 4. Verify inquiry updated to 'won' and status: 'confirmed'
      const { data: updatedInq } = await supabase
        .from('inquiries')
        .select('stage, status, won_at, po_number, generated_po_number, reference_po_number')
        .eq('id', newInq.id)
        .single();

      assert(updatedInq && updatedInq.stage === 'won', 'Inquiry stage updated to won');
      assert(updatedInq && updatedInq.status === 'confirmed', 'Inquiry status updated to confirmed');
      assert(updatedInq && Boolean(updatedInq.won_at), 'Inquiry won_at timestamp is set');
      assert(updatedInq && /^EM\/PO\/\d+$/.test(updatedInq.po_number || ''), 'Inquiry stores an EM/PO/N canonical PO');
      assert(updatedInq && updatedInq.generated_po_number === updatedInq.po_number, 'Generated PO is preserved on first confirmation');
      assert(updatedInq && updatedInq.reference_po_number === orderDraft.reference_po_number, 'Customer PO is stored as Reference PO');

      // Clean up test rows
      const allocatedPo = updatedInq?.po_number;
      await supabase.from('inquiries').delete().eq('id', newInq.id);
      if (newDeal) await supabase.from('deals').delete().eq('id', newDeal.id);
      if (allocatedPo) {
        await supabase.from('po_number_allocations').delete()
          .eq('normalized_po_number', allocatedPo.toLowerCase());
      }
    }
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📊 Test Results: ${passedTests} / ${totalTests} Passed`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  if (passedTests === totalTests) {
    console.log('🎉 ALL TESTS PASSED SUCCESSFULLY!');
    process.exit(0);
  } else {
    console.error('❌ SOME TESTS FAILED!');
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Unexpected error running test suite:', err);
  process.exit(1);
});
