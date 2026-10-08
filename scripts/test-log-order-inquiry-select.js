require('dotenv').config();
const assert = require('assert');
const {
  fetchEditableRecordsForModule,
  formatRecordLineForModule,
  fetchAndRenderUpdateSelection,
  formatSelectedInquiryForOrderPrompt,
  handleCatalogFlow,
} = require('../src/core/catalogFlow');

async function testLogOrderInquirySelect() {
  console.log('================================================================');
  console.log('🚀 TESTING LOG NEW ORDER INQUIRY SELECTION & STAGE FILTERING');
  console.log('================================================================\n');

  let passedTests = 0;
  let totalTests = 0;

  function runTest(name, fn) {
    totalTests++;
    try {
      fn();
      console.log(`✅ [PASS] ${name}`);
      passedTests++;
    } catch (err) {
      console.error(`❌ [FAIL] ${name}: ${err.message}`);
    }
  }

  async function runAsyncTest(name, fn) {
    totalTests++;
    try {
      await fn();
      console.log(`✅ [PASS] ${name}`);
      passedTests++;
    } catch (err) {
      console.error(`❌ [FAIL] ${name}: ${err.message}`);
    }
  }

  // 1. UNIT TEST: formatRecordLineForModule for LOG_ORDER
  runTest('formatRecordLineForModule formats LOG_ORDER line correctly with pricing and stage', () => {
    const mockRecord = {
      displayId: 'INQ-7E426C',
      customer_name: 'sheets trades industries',
      product_summary: '87 MT HR Coil (7MM)',
      total_amount: 5829,
      stage: 'Price Quote',
      raw_stage: 'quoted',
      date_formatted: '28-09-2026',
    };
    const line = formatRecordLineForModule('LOG_ORDER', mockRecord, 1);
    assert.strictEqual(
      line,
      '1. INQ-7E426C | sheets trades industries | 87 MT HR Coil (7MM) | ₹5,829 | Price Quote | 28-09-2026'
    );

    const mockUnpricedRecord = {
      displayId: 'INQ-F2785B',
      customer_name: 'Rajeshwari Shah Industries',
      product_summary: '89 MT HR Coil (9MM)',
      total_amount: 0,
      stage: 'Negotiation',
      raw_stage: 'negotiation',
      date_formatted: '28-09-2026',
    };
    const line2 = formatRecordLineForModule('LOG_ORDER', mockUnpricedRecord, 2);
    assert.strictEqual(
      line2,
      '2. INQ-F2785B | Rajeshwari Shah Industries | 89 MT HR Coil (9MM) | Rate not set | Negotiation | 28-09-2026'
    );
  });

  // 2. UNIT TEST: formatSelectedInquiryForOrderPrompt card
  runTest('formatSelectedInquiryForOrderPrompt generates pre-filled summary and PO prompts', () => {
    const mockSelected = {
      displayId: 'INQ-4535CA',
      customer_name: 'Sana Shah',
      delivery_location: 'Satara',
      payment_terms: '70 Days',
      deal_items: [
        {
          sku_text: 'HR Coil',
          dimensions: '7mm',
          quantity: 45,
          unit: 'MT',
          rate: 88,
          amount: 3960,
        },
      ],
    };

    const prompt = formatSelectedInquiryForOrderPrompt(mockSelected);
    assert.ok(prompt.includes('Creating order for INQ-4535CA (Sana Shah)'), 'Prompt must show header with INQ ID and customer');
    assert.ok(prompt.includes('HR Coil (7mm) | 45 MT | ₹88 /MT | Total: ₹3,960'), 'Prompt must show line item breakdown');
    assert.ok(prompt.includes('Delivery Location') && prompt.includes('Satara'), 'Prompt must show delivery location');
    assert.ok(prompt.includes('Payment Terms') && prompt.includes('70 Days'), 'Prompt must show payment terms');
    assert.ok(prompt.includes('*System PO Number* (editable)'), 'Prompt must identify the editable system PO');
    assert.ok(prompt.includes('*Reference PO* (optional customer/document PO)'), 'Prompt must separate the customer/document PO');
    assert.ok(prompt.includes('*PO Date* (or "Today")'), 'Prompt must ask for PO Date with Today hint');
  });

  // 3. INTEGRATION TEST: fetchEditableRecordsForModule('LOG_ORDER') strictly includes quoted, negotiation, on_hold and excludes new_inquiry
  await runAsyncTest('fetchEditableRecordsForModule strictly filters to quoted, negotiation, and on_hold stages', async () => {
    const records = await fetchEditableRecordsForModule('LOG_ORDER', null);
    assert.ok(Array.isArray(records), 'Records should be an array');
    
    // Validate that NO record in the list has new_inquiry, review, won, lost, or cancelled
    for (const r of records) {
      const st = (r.raw_stage || '').toLowerCase();
      assert.notStrictEqual(st, 'new_inquiry', `Record ${r.displayId} has disallowed stage 'new_inquiry'`);
      assert.notStrictEqual(st, 'review', `Record ${r.displayId} has disallowed stage 'review'`);
      assert.notStrictEqual(st, 'won', `Record ${r.displayId} has disallowed stage 'won'`);
      assert.notStrictEqual(st, 'lost', `Record ${r.displayId} has disallowed stage 'lost'`);
      assert.notStrictEqual(st, 'cancelled', `Record ${r.displayId} has disallowed stage 'cancelled'`);
      assert.ok(
        ['quoted', 'price_quote', 'price quote', 'qualified', 'confirmed', 'proposal', 'saved', 'negotiation', 'on_hold', 'hold'].includes(st),
        `Record ${r.displayId} stage '${st}' is not in allowed order stages`
      );
    }
  });

  // 4. INTEGRATION TEST: fetchAndRenderUpdateSelection('LOG_ORDER') headers and footers
  await runAsyncTest('fetchAndRenderUpdateSelection renders correct header and footer for LOG_ORDER', async () => {
    const rendered = await fetchAndRenderUpdateSelection('LOG_ORDER', null, { page: 1, pageSize: 7 });
    if (rendered.hasRecords) {
      assert.ok(rendered.reply.includes('Log New Order'), 'Reply should include "Log New Order"');
      assert.ok(rendered.reply.includes('inquiries ready for an order'), 'Reply should state inquiries ready for an order');
      assert.ok(rendered.reply.includes('Reply with the serial number or Inquiry ID to create an order'), 'Footer should instruct user how to proceed');
    } else {
      assert.ok(rendered.reply.includes('No Eligible Inquiries Found'), 'Empty state should explain no eligible inquiries');
    }
  });

  // 5. FLOW TEST: Menu 3 -> Selection -> Auto Today PO generation
  await runAsyncTest('Menu option 3 -> Choose Inquiry -> "Auto Today" generates PO and creates order', async () => {
    const testPhone = '919975003940';
    await handleCatalogFlow('cancel', testPhone);

    // Step 1: User chooses 3. Log New Order
    const step1 = await handleCatalogFlow('3. Log New Order', testPhone);
    assert.ok(step1.handled, 'Step 1 should be handled');
    assert.ok(step1.reply.includes('Log New Order') || step1.reply.includes('inquiries ready for an order'), 'Step 1 should show eligible inquiries list');

    // Step 2: User selects option 1 from the list
    const step2 = await handleCatalogFlow('1', testPhone);
    assert.ok(step2.handled, 'Step 2 should be handled');
    assert.ok(step2.reply.includes('Creating order for INQ-') || step2.reply.includes('Please provide:'), 'Step 2 should show creating order card');
    assert.ok(step2.reply.includes('PO Number'), 'Step 2 should prompt for PO Number');

    // Step 3: User replies "Auto Today"
    const step3 = await handleCatalogFlow('Auto Today', testPhone);
    assert.ok(step3.handled, 'Step 3 should be handled');
    assert.ok(step3.reply.includes('EM/PO/'), 'Step 3 should have a system-generated EM/PO/N number');
    assert.ok(
      step3.reply.includes('Order Confirmation') || step3.reply.includes('Order Value') || step3.reply.includes('GST (18%)'),
      'Step 3 should move to interactive order confirmation'
    );

    await handleCatalogFlow('cancel', testPhone);
  });

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passedTests} / ${totalTests} PASSED`);
  console.log('================================================================\n');

  if (passedTests !== totalTests) {
    process.exit(1);
  }
}

testLogOrderInquirySelect().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
