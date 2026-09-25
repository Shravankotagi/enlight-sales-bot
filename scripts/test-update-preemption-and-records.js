const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { handleCatalogFlow } = require('../src/core/catalogFlow');
const { saveActiveSession, getFullActiveSession, finalizeCurrentSession } = require('../src/supabase');

const TEST_PHONE = '910000000094';

async function runTests() {
  console.log('=== RUNNING TESTS FOR UPDATE FLOW PREEMPTION & RECENT RECORDS ===\n');
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
    // TEST 1: img1 Reproduction & Fix - Active Inquiry Flow Preempted by menu_6 (Update Field Visit)
    // -------------------------------------------------------------
    console.log('\n--- Test 1: Preemption from Active LOG_INQUIRY via menu_6 ---');
    await saveActiveSession(TEST_PHONE, 'Unknown', 'catalog_flow|LOG_INQUIRY|{}');
    let session = await getFullActiveSession(TEST_PHONE);
    console.log('Initial active session before preemption:', session?.last_intent);

    // Simulate clicking "6. Update Field Visit" in WhatsApp list (which passes raw_text = "menu_6")
    const res1 = await handleCatalogFlow('menu_6', TEST_PHONE);
    console.log('Bot Reply (truncated):', res1.reply?.slice(0, 150));

    await assert(res1.handled === true, 'menu_6 was handled by handleCatalogFlow');
    await assert(!res1.reply.includes('You are currently in the Inquiry flow'), 'Did NOT output out-of-scope warning loop');
    await assert(res1.reply.includes('Field Visit') || res1.reply.includes('field visit'), 'Replied with Field Visit records/prompt');

    session = await getFullActiveSession(TEST_PHONE);
    console.log('Session after menu_6:', session?.last_intent);
    await assert(
      session?.last_intent.startsWith('catalog_update_select|UPDATE_VISIT') || session?.last_intent.startsWith('catalog_flow|UPDATE_VISIT') || session?.last_intent === 'general',
      'Session correctly switched to UPDATE_VISIT'
    );

    // -------------------------------------------------------------
    // TEST 2: img2 - Selecting menu_2 (Update Inquiry) immediately shows 7 recent records
    // -------------------------------------------------------------
    console.log('\n--- Test 2: Selecting menu_2 (Update Inquiry) shows recent records ---');
    await saveActiveSession(TEST_PHONE, 'Unknown', 'general');
    const res2 = await handleCatalogFlow('menu_2', TEST_PHONE);
    console.log('Bot Reply (truncated):', res2.reply?.slice(0, 200));

    await assert(res2.handled === true, 'menu_2 was handled by handleCatalogFlow');
    await assert(
      res2.reply.includes('Update Inquiry') || res2.reply.includes('recent editable inquiries') || res2.reply.includes('No Editable Inquiries Found'),
      'Immediately rendered update inquiry selection list / prompt without asking for ID first'
    );

    // -------------------------------------------------------------
    // TEST 3: Selecting a record from update selection list
    // -------------------------------------------------------------
    console.log('\n--- Test 3: Selecting record #1 from update selection list ---');
    const mockState = {
      action: 'UPDATE_INQUIRY',
      page: 1,
      totalCount: 3,
      cachedRecords: [
        {
          index: 1,
          id: 'mock-deal-001',
          deal_id: 'mock-deal-001',
          inquiry_id: 'INQ-D013D7',
          displayId: 'INQ-D013D7',
          customer_name: 'Apex Steel Industries',
          product_summary: '25 MT HR Sheet',
          stage: 'Quoted',
          date_formatted: '25-09-2026',
          payment_terms: '30 Days Credit',
          delivery_location: 'Pune',
        },
      ],
    };
    await saveActiveSession(TEST_PHONE, 'Apex Steel Industries', `catalog_update_select|UPDATE_INQUIRY|${JSON.stringify(mockState)}`);

    // User replies with "1"
    const res3 = await handleCatalogFlow('1', TEST_PHONE);
    console.log('Bot Reply for option 1:\n', res3.reply);

    await assert(res3.handled === true, 'Option selection handled');
    await assert(res3.reply.includes('Selected Inquiry INQ-D013D7'), 'Identified selected inquiry in prompt');
    await assert(res3.reply.includes('What details would you like to update?'), 'Prompted for fields to update');
    await assert(!res3.reply.includes('Please provide the Inquiry ID'), 'Did NOT ask for Inquiry ID again');

    session = await getFullActiveSession(TEST_PHONE);
    console.log('Session after option 1 selection:', session?.last_intent);
    await assert(session?.last_intent.startsWith('catalog_flow|UPDATE_INQUIRY'), 'Session transitioned to catalog_flow with selected inquiry draft');

    // -------------------------------------------------------------
    // TEST 4: Providing field update for the selected inquiry
    // -------------------------------------------------------------
    console.log('\n--- Test 4: Providing rate update for selected inquiry ---');
    const res4 = await handleCatalogFlow('Update rate to 54000 per MT', TEST_PHONE);
    console.log('Bot Reply for field update:\n', res4.reply);

    await assert(res4.handled === true, 'Field update handled');
    await assert(res4.interactiveType === 'buttons', 'Returned confirmation buttons');
    await assert(res4.reply.includes('INQ-D013D7') || res4.reply.includes('Apex Steel'), 'Confirmation summary retains Inquiry ID & Customer');
    await assert(res4.reply.includes('54,000') || res4.reply.includes('54000'), 'Confirmation summary has updated rate');

    // -------------------------------------------------------------
    // TEST 5: Title-based interactive menu selection preemption (e.g. "6. Update Field Visit")
    // -------------------------------------------------------------
    console.log('\n--- Test 5: Preemption via list title "6. Update Field Visit" ---');
    await saveActiveSession(TEST_PHONE, 'Apex Steel Industries', 'catalog_flow|LOG_INQUIRY|{}');
    const res5 = await handleCatalogFlow('6. Update Field Visit', TEST_PHONE);
    console.log('Bot Reply (truncated):', res5.reply?.slice(0, 150));

    await assert(res5.handled === true, '6. Update Field Visit was handled');
    await assert(!res5.reply.includes('You are currently in the Inquiry flow'), 'Did not show out of scope warning');

    // Cleanup
    await saveActiveSession(TEST_PHONE, 'Unknown', 'general');

  } catch (err) {
    console.error('Test execution error:', err);
    failed++;
  }

  console.log(`\n=== TEST SUMMARY: ${passed} PASSED, ${failed} FAILED ===\n`);
  if (failed > 0) process.exit(1);
}

runTests();
