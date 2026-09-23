/**
 * test-activity-logging.js
 * Comprehensive verification for activity logging across Inquiries, Orders, Visits, Complaints, and Customers.
 */
require('dotenv').config();
const { supabase } = require('../src/supabase');
const { logBotActivity } = require('../src/utils/activityLogger');
const { executeAction } = require('../src/core/catalogFlow');

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runActivityLoggingTests() {
  console.log('================================================================');
  console.log('--- RUNNING ACTIVITY LOGGING VERIFICATION TEST SUITE ---');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`✅ [PASS] ${message}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${message}`);
      failed++;
    }
  }

  // 1. Direct logBotActivity test for each module
  console.log('--- TEST 1: Direct logBotActivity for all 5 modules with phone name resolution ---');
  const testPhone = '918262937458'; // Shravan

  const testStamp = Date.now();
  const testCust = `Test Log Corp ${testStamp}`;

  logBotActivity({
    salesperson_phone: testPhone,
    description: `Direct Inquiry test for ${testCust}`,
    module: 'inquiries',
    customer_name: testCust,
  });

  logBotActivity({
    salesperson_phone: testPhone,
    description: `Direct Order test for ${testCust} PO: PO-TEST-${testStamp}`,
    module: 'orders',
    customer_name: testCust,
  });

  logBotActivity({
    salesperson_phone: testPhone,
    description: `Direct Visit test for ${testCust}`,
    module: 'visits',
    customer_name: testCust,
  });

  logBotActivity({
    salesperson_phone: testPhone,
    description: `Direct Complaint test for ${testCust}`,
    module: 'complaints',
    customer_name: testCust,
  });

  logBotActivity({
    salesperson_phone: testPhone,
    description: `Direct Customer acquisition test for ${testCust}`,
    module: 'customers',
    customer_name: testCust,
  });

  // Wait for non-blocking inserts
  await sleep(2500);

  const { data: directLogs, error: dErr } = await supabase
    .from('activity_logs')
    .select('*')
    .ilike('customer_name', testCust);

  assert(!dErr && directLogs && directLogs.length === 5, `All 5 direct activity logs inserted (count=${directLogs?.length})`);

  if (directLogs) {
    const modulesFound = directLogs.map((l) => l.module);
    assert(modulesFound.includes('Inquiries'), 'Inquiries module normalized to TitleCase');
    assert(modulesFound.includes('Orders'), 'Orders module normalized to TitleCase');
    assert(modulesFound.includes('Visits'), 'Visits module normalized to TitleCase');
    assert(modulesFound.includes('Complaints'), 'Complaints module normalized to TitleCase');
    assert(modulesFound.includes('Customers'), 'Customers module normalized to TitleCase');

    const repName = directLogs[0]?.salesperson_name;
    assert(repName && repName.toLowerCase().includes('shravan'), `Salesperson name resolved from phone (name="${repName}")`);
  }

  // 2. Test executeAction('LOG_INQUIRY') emits activity log
  console.log('\n--- TEST 2: executeAction(LOG_INQUIRY) emits activity log ---');
  const inqDraft = {
    company_name: `Inquiry Act Corp ${testStamp}`,
    delivery_location: 'Pune',
    payment_terms: '30 days',
    product_description: 'HR Coil 2.5mm',
    rate: 52000,
    line_items: [{ sku_text: 'HR Coil', dimensions: '2.5mm', quantity: 10, unit: 'MT', rate: 52000, amount: 520000 }],
  };

  const inqRes = await executeAction('LOG_INQUIRY', inqDraft, testPhone);
  assert(inqRes.includes('Inquiry Successfully Created'), 'LOG_INQUIRY executed successfully');
  await sleep(1500);

  const { data: inqLogs } = await supabase
    .from('activity_logs')
    .select('*')
    .ilike('customer_name', inqDraft.company_name);

  assert(inqLogs && inqLogs.length >= 1, `LOG_INQUIRY recorded in activity_logs (count=${inqLogs?.length})`);
  assert(inqLogs && inqLogs[0]?.module === 'Inquiries', `LOG_INQUIRY module is Inquiries (${inqLogs?.[0]?.module})`);

  // 3. Test executeAction('LOG_VISIT') emits activity log
  console.log('\n--- TEST 3: executeAction(LOG_VISIT) emits activity log ---');
  const visitDraft = {
    company_name: `Visit Act Corp ${testStamp}`,
    person_met: 'Mr Rajesh',
    contact_phone: '9822112233',
    city_location: 'Chakan Pune',
    visit_date: '23-09-2026',
    visit_outcome: 'Positive',
    meeting_remarks: 'Discussed quarterly requirement',
  };

  const visRes = await executeAction('LOG_VISIT', visitDraft, testPhone);
  assert(visRes.includes('Field Visit Logged Successfully'), 'LOG_VISIT executed successfully');
  await sleep(1500);

  const { data: visLogs } = await supabase
    .from('activity_logs')
    .select('*')
    .ilike('customer_name', visitDraft.company_name);

  assert(visLogs && visLogs.length >= 1, `LOG_VISIT recorded in activity_logs (count=${visLogs?.length})`);
  assert(visLogs && visLogs[0]?.module === 'Visits', `LOG_VISIT module is Visits (${visLogs?.[0]?.module})`);

  // 4. Test executeAction('LOG_NEW_CUSTOMER') emits activity log
  console.log('\n--- TEST 4: executeAction(LOG_NEW_CUSTOMER) emits activity log ---');
  const custDraft = {
    company_name: `Cust Act Corp ${testStamp}`,
    contact_person: 'Mr Sharma',
    mobile_number: '9822998877',
    delivery_location: 'Bhosari',
  };

  const custRes = await executeAction('LOG_NEW_CUSTOMER', custDraft, testPhone);
  assert(custRes.includes('New Customer Successfully Added'), 'LOG_NEW_CUSTOMER executed successfully');
  await sleep(1500);

  const { data: custLogs } = await supabase
    .from('activity_logs')
    .select('*')
    .ilike('customer_name', custDraft.company_name);

  assert(custLogs && custLogs.length >= 1, `LOG_NEW_CUSTOMER recorded in activity_logs (count=${custLogs?.length})`);
  assert(custLogs && custLogs[0]?.module === 'Customers', `LOG_NEW_CUSTOMER module is Customers (${custLogs?.[0]?.module})`);

  // 5. Clean up test records
  console.log('\n--- Cleaning up test records ---');
  await supabase.from('activity_logs').delete().ilike('customer_name', `%${testStamp}%`);
  await supabase.from('inquiries').delete().ilike('customer_name', `%${testStamp}%`);
  await supabase.from('deals').delete().ilike('customer_name', `%${testStamp}%`);
  await supabase.from('customer_visits').delete().ilike('customer_name', `%${testStamp}%`);
  await supabase.from('recurring_customers').delete().ilike('customer_name', `%${testStamp}%`);

  console.log('\n================================================================');
  console.log(`FINAL RESULT: ${passed}/${passed + failed} TESTS PASSED (${Math.round((passed / (passed + failed)) * 100)}%)`);
  console.log('================================================================\n');

  if (failed > 0) process.exit(1);
}

runActivityLoggingTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
