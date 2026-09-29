require('dotenv').config();
const assert = require('assert');
const {
  executeAction,
  handleCatalogFlow,
  validateOrderInquiryStage,
} = require('../src/core/catalogFlow');
const { supabase } = require('../src/supabase');

async function testOrderAtomicityAndRevalidation() {
  console.log('================================================================');
  console.log('🚀 TESTING ORDER ATOMICITY & SAVE-TIME RE-VALIDATION');
  console.log('================================================================\n');

  let passed = 0;
  let total = 0;

  async function runTest(name, fn) {
    total++;
    try {
      await fn();
      console.log(`✅ [PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`❌ [FAIL] ${name}: ${err.message}`);
    }
  }

  // Helper to create a dummy test inquiry in DB
  async function createTestInquiry(stage = 'quoted', customerName = 'Atomicity Test Corp') {
    const { data, error } = await supabase
      .from('inquiries')
      .insert({
        source_channel: 'WhatsApp',
        customer_name: customerName,
        sender_name: customerName,
        raw_text: `Test requirement for ${customerName}`,
        sender_phone: '919975003940',
        salesperson_phone: '919975003940',
        status: stage === 'quoted' ? 'quoted' : stage,
        stage: stage,
        delivery_location: 'Pune',
        payment_terms: '30 Days',
        total_amount: 150000,
        ai_extraction_json: {
          customer_name: customerName,
          companyName: customerName,
          line_items: [
            {
              sku_text: 'HR Sheet',
              description: 'HR Sheet 2.5mm',
              dimensions: '2.5mm',
              quantity: 3,
              unit: 'MT',
              rate: 50000,
              amount: 150000,
            }
          ]
        },
        inquiry_type: 'inquiry',
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error || !data) throw new Error(`Failed to seed test inquiry: ${error?.message}`);

    // Create matching deal
    await supabase.from('deals').insert({
      id: data.id,
      inquiry_id: data.id,
      stage: stage,
      customer_name: customerName,
      customer_address: 'Pune',
      delivery_location: 'Pune',
      payment_terms: '30 Days',
      total_amount: 150000,
      inquiry_type: 'inquiry',
      status: 'auto_created',
      salesperson_phone: '919975003940',
      created_at: new Date().toISOString(),
    });

    return data;
  }

  async function cleanupTestInquiry(inqId) {
    if (!inqId) return;
    try {
      await supabase.from('deal_items').delete().eq('deal_id', inqId);
      await supabase.from('deals').delete().eq('id', inqId);
      await supabase.from('inquiry_items').delete().eq('inquiry_id', inqId);
      await supabase.from('inquiries').delete().eq('id', inqId);
      await supabase.from('kra_logs').delete().eq('customer_name', 'Atomicity Test Corp');
    } catch (e) {}
  }

  // 1. TEST: Save-time rejection when inquiry is changed to 'lost' concurrently
  await runTest('LOG_ORDER rejects save if inquiry was changed to "lost" concurrently', async () => {
    const seeded = await createTestInquiry('quoted');
    const inqCode = `INQ-${seeded.id.replace(/-/g, '').slice(0, 6).toUpperCase()}`;

    // Simulate draft prepared while inquiry was quoted
    const draft = {
      action: 'LOG_ORDER',
      inquiry_id: inqCode,
      company_name: seeded.customer_name,
      po_number: 'PO-TEST-LOST-01',
      po_date: '29-09-2026',
      delivery_location: 'Pune',
      payment_terms: '30 Days',
      line_items: [
        { sku_text: 'HR Sheet', quantity: 3, unit: 'MT', rate: 50000, amount: 150000 }
      ],
    };

    // Concurrently change stage to 'lost' in DB
    await supabase.from('inquiries').update({ stage: 'lost', status: 'lost' }).eq('id', seeded.id);
    await supabase.from('deals').update({ stage: 'lost' }).eq('id', seeded.id);

    // Now execute save activity
    const reply = await executeAction('LOG_ORDER', draft, '919975003940');

    assert.ok(reply.includes('Order Cannot Be Created') || reply.includes('Lost'), `Reply should explain lost inquiry: ${reply}`);

    // Verify DB was NOT updated to 'won'
    const { data: checkInq } = await supabase.from('inquiries').select('stage').eq('id', seeded.id).single();
    assert.strictEqual(checkInq.stage, 'lost', 'Inquiry must remain in lost stage');

    await cleanupTestInquiry(seeded.id);
  });

  // 2. TEST: Save-time rejection when inquiry is changed to 'new_inquiry' concurrently
  await runTest('LOG_ORDER rejects save if inquiry is in "new_inquiry" stage at save time', async () => {
    const seeded = await createTestInquiry('new_inquiry');
    const inqCode = `INQ-${seeded.id.replace(/-/g, '').slice(0, 6).toUpperCase()}`;

    const draft = {
      action: 'LOG_ORDER',
      inquiry_id: inqCode,
      company_name: seeded.customer_name,
      po_number: 'PO-TEST-NEW-02',
      po_date: '29-09-2026',
      delivery_location: 'Pune',
      payment_terms: '30 Days',
      line_items: [
        { sku_text: 'HR Sheet', quantity: 3, unit: 'MT', rate: 50000, amount: 150000 }
      ],
    };

    const reply = await executeAction('LOG_ORDER', draft, '919975003940');
    assert.ok(reply.includes('Order Cannot Be Created') || reply.includes('New Inquiry'), `Reply should block new inquiry: ${reply}`);

    const { data: checkInq } = await supabase.from('inquiries').select('stage').eq('id', seeded.id).single();
    assert.strictEqual(checkInq.stage, 'new_inquiry', 'Inquiry must remain in new_inquiry stage');

    await cleanupTestInquiry(seeded.id);
  });

  // 3. TEST: Save-time rejection when inquiry is already marked as 'won'
  await runTest('LOG_ORDER detects already converted inquiry and prevents duplicate overwrite', async () => {
    const seeded = await createTestInquiry('won');
    await supabase.from('inquiries').update({ po_number: 'PO-ORIGINAL-99' }).eq('id', seeded.id);
    await supabase.from('deals').update({ po_number: 'PO-ORIGINAL-99' }).eq('id', seeded.id);

    const inqCode = `INQ-${seeded.id.replace(/-/g, '').slice(0, 6).toUpperCase()}`;

    const draft = {
      action: 'LOG_ORDER',
      inquiry_id: inqCode,
      company_name: seeded.customer_name,
      po_number: 'PO-DUPLICATE-03',
      po_date: '29-09-2026',
      delivery_location: 'Pune',
      payment_terms: '30 Days',
      line_items: [
        { sku_text: 'HR Sheet', quantity: 3, unit: 'MT', rate: 50000, amount: 150000 }
      ],
    };

    const reply = await executeAction('LOG_ORDER', draft, '919975003940');
    assert.ok(reply.includes('Order Already Recorded') || reply.includes('PO-ORIGINAL-99') || reply.includes('4. Update Order'), `Reply should explain inquiry already won: ${reply}`);

    const { data: checkInq } = await supabase.from('inquiries').select('po_number').eq('id', seeded.id).single();
    assert.strictEqual(checkInq.po_number, 'PO-ORIGINAL-99', 'PO Number must not be overwritten');

    await cleanupTestInquiry(seeded.id);
  });

  // 4. TEST: Successful atomic order creation when inquiry is quoted
  await runTest('LOG_ORDER successfully converts quoted inquiry to WON atomically', async () => {
    const seeded = await createTestInquiry('quoted');
    const inqCode = `INQ-${seeded.id.replace(/-/g, '').slice(0, 6).toUpperCase()}`;

    const draft = {
      action: 'LOG_ORDER',
      inquiry_id: inqCode,
      company_name: seeded.customer_name,
      po_number: 'PO-SUCCESS-04',
      po_date: '29-09-2026',
      delivery_location: 'Pune MIDC',
      payment_terms: '45 Days',
      line_items: [
        { sku_text: 'HR Sheet', quantity: 5, unit: 'MT', rate: 52000, amount: 260000 }
      ],
    };

    const reply = await executeAction('LOG_ORDER', draft, '919975003940');
    assert.ok(reply.includes('Order Recorded & Deal Marked as WON'), `Reply should confirm won order: ${reply}`);
    assert.ok(reply.includes('PO-SUCCESS-04'), 'Reply should include PO number');

    // Verify Inquiries, Deals, Inquiry Items, Deal Items
    const { data: checkInq } = await supabase.from('inquiries').select('stage, status, po_number').eq('id', seeded.id).single();
    assert.strictEqual(checkInq.stage, 'won', 'Inquiry stage must be won');
    assert.strictEqual(checkInq.po_number, 'PO-SUCCESS-04', 'Inquiry po_number must be saved');

    const { data: checkDeal } = await supabase.from('deals').select('stage, po_number').eq('id', seeded.id).single();
    assert.strictEqual(checkDeal.stage, 'won', 'Deal stage must be won');
    assert.strictEqual(checkDeal.po_number, 'PO-SUCCESS-04', 'Deal po_number must be saved');

    const { data: inqItems } = await supabase.from('inquiry_items').select('*').eq('inquiry_id', seeded.id);
    assert.ok(inqItems && inqItems.length > 0, 'Inquiry items must be present');

    const { data: dealItems } = await supabase.from('deal_items').select('*').eq('deal_id', seeded.id);
    assert.ok(dealItems && dealItems.length > 0, 'Deal items must be present');

    await cleanupTestInquiry(seeded.id);
  });

  console.log('\n================================================================');
  console.log(`📊 TEST RESULTS: ${passed} / ${total} PASSED`);
  console.log('================================================================\n');

  if (passed !== total) {
    process.exit(1);
  }
}

testOrderAtomicityAndRevalidation().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
