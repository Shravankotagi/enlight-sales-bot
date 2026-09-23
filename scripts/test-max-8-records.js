/**
 * test-max-8-records.js - Verification of Max 8 Records Per Message + Dashboard Prompt
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const {
  resolveCallerContext,
  executeGetInquiries,
  executeGetVisits,
  executeGetComplaints,
  executeGetCustomer360,
  executeGetMyOpenDeals,
  executeGetReorderQueue,
  executeGetTeamPipeline,
  executeGetLossAnalytics,
} = require('../src/core/retrievalTools');

async function runAudit() {
  console.log('================================================================');
  console.log('--- AUDITING MAX 8 RECORDS RETRIEVAL & DASHBOARD NOTICE ---');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  // Admin context has global access to all DB records (guarantees > 8 records)
  const adminContext = {
    userId: 'admin-test',
    role: 'admin',
    name: 'Admin User',
    phone: '918262937458',
    allUserIds: ['918262937458'],
  };

  console.log(`Testing with Admin Context (Global DB scope)...\n`);

  // Test 1: executeGetInquiries standard list
  console.log('--- TEST 1: executeGetInquiries ---');
  const inqRes = await executeGetInquiries({ mode: 'list' }, adminContext);
  const inqs = inqRes.data.inquiries || [];
  const totalInqs = inqRes.data.total_records;
  console.log(`Total inquiries in DB: ${totalInqs}, Showing: ${inqs.length}`);
  console.log(`Dashboard notice: "${inqRes.data.dashboard_notice}"`);
  if (inqs.length <= 8 && totalInqs > 8 && inqRes.data.dashboard_notice && inqRes.data.dashboard_notice.includes('navigate to the dashboard')) {
    console.log('✅ [PASS] executeGetInquiries correctly caps at 8 items and generates dashboard redirect notice\n');
    passed++;
  } else {
    console.error('❌ [FAIL] executeGetInquiries failed limit or notice check\n');
    failed++;
  }

  // Test 2: executeGetVisits (unvisited mode)
  console.log('--- TEST 2: executeGetVisits (Unvisited Mode) ---');
  const unvisRes = await executeGetVisits({ mode: 'not_visited', date_range: 'last_30_days' }, adminContext);
  const unvis = unvisRes.data.customers || [];
  const totalUnvis = unvisRes.data.total_records;
  console.log(`Total unvisited: ${totalUnvis}, Showing: ${unvis.length}`);
  console.log(`Dashboard notice: "${unvisRes.data.dashboard_notice}"`);
  if (unvis.length <= 8 && totalUnvis > 8 && unvisRes.data.dashboard_notice && unvisRes.data.dashboard_notice.includes('navigate to the dashboard')) {
    console.log('✅ [PASS] executeGetVisits (unvisited) correctly caps at 8 items and generates dashboard notice\n');
    passed++;
  } else {
    console.error('❌ [FAIL] executeGetVisits unvisited failed limits\n');
    failed++;
  }

  // Test 3: executeGetVisits (pending follow-ups)
  console.log('--- TEST 3: executeGetVisits (Pending Follow-up Mode) ---');
  const fuRes = await executeGetVisits({ mode: 'pending_followup' }, adminContext);
  const fuVisits = fuRes.data.visits || [];
  const totalFu = fuRes.data.total_records;
  console.log(`Total pending followups: ${totalFu}, Showing: ${fuVisits.length}`);
  console.log(`Dashboard notice: "${fuRes.data.dashboard_notice}"`);
  if (fuVisits.length <= 8 && (totalFu <= 8 || fuRes.data.dashboard_notice)) {
    console.log('✅ [PASS] executeGetVisits (pending followups) caps at 8 items and handles dashboard notice\n');
    passed++;
  } else {
    console.error('❌ [FAIL] executeGetVisits pending followups failed limits\n');
    failed++;
  }

  // Test 4: executeGetCustomer360 (Directory)
  console.log('--- TEST 4: executeGetCustomer360 (Directory) ---');
  const custRes = await executeGetCustomer360({ mode: 'directory' }, adminContext);
  const custs = custRes.data.customers || [];
  const totalCusts = custRes.data.total_records;
  console.log(`Total customers: ${totalCusts}, Showing: ${custs.length}`);
  console.log(`Dashboard notice: "${custRes.data.dashboard_notice}"`);
  if (custs.length <= 8 && totalCusts > 8 && custRes.data.dashboard_notice && custRes.data.dashboard_notice.includes('navigate to the dashboard')) {
    console.log('✅ [PASS] executeGetCustomer360 correctly caps at 8 items and generates dashboard notice\n');
    passed++;
  } else {
    console.error('❌ [FAIL] executeGetCustomer360 directory failed limits\n');
    failed++;
  }

  // Test 5: executeGetMyOpenDeals (Deals List)
  console.log('--- TEST 5: executeGetMyOpenDeals ---');
  const dealsRes = await executeGetMyOpenDeals({ stage_filter: 'all' }, adminContext);
  const deals = dealsRes.data.deals || [];
  const totalDeals = dealsRes.data.total_records;
  console.log(`Total deals: ${totalDeals}, Showing: ${deals.length}`);
  console.log(`Dashboard notice: "${dealsRes.data.dashboard_notice}"`);
  if (deals.length <= 8 && totalDeals > 8 && dealsRes.data.dashboard_notice && dealsRes.data.dashboard_notice.includes('navigate to the dashboard')) {
    console.log('✅ [PASS] executeGetMyOpenDeals correctly caps at 8 items and generates dashboard notice\n');
    passed++;
  } else {
    console.error('❌ [FAIL] executeGetMyOpenDeals failed limits\n');
    failed++;
  }

  // Test 6: executeGetComplaints
  console.log('--- TEST 6: executeGetComplaints ---');
  const compRes = await executeGetComplaints({ status_filter: 'all' }, adminContext);
  const comps = compRes.data.complaints || [];
  const totalComps = compRes.data.total_records;
  console.log(`Total complaints: ${totalComps}, Showing: ${comps.length}`);
  console.log(`Dashboard notice: "${compRes.data.dashboard_notice}"`);
  if (comps.length <= 8 && (totalComps <= 8 || compRes.data.dashboard_notice)) {
    console.log('✅ [PASS] executeGetComplaints correctly caps at 8 items and handles dashboard notice\n');
    passed++;
  } else {
    console.error('❌ [FAIL] executeGetComplaints failed limits\n');
    failed++;
  }

  // Test 7: executeGetReorderQueue
  console.log('--- TEST 7: executeGetReorderQueue ---');
  const rqRes = await executeGetReorderQueue({ mode: 'list' }, adminContext);
  const queue = rqRes.data.reorder_queue || [];
  const totalQueue = rqRes.data.total_records;
  console.log(`Total reorder queue accounts: ${totalQueue}, Showing: ${queue.length}`);
  console.log(`Dashboard notice: "${rqRes.data.dashboard_notice}"`);
  if (queue.length <= 8 && totalQueue > 8 && rqRes.data.dashboard_notice && rqRes.data.dashboard_notice.includes('navigate to the dashboard')) {
    console.log('✅ [PASS] executeGetReorderQueue correctly caps at 8 items and generates dashboard notice\n');
    passed++;
  } else {
    console.error('❌ [FAIL] executeGetReorderQueue failed limits\n');
    failed++;
  }

  console.log('================================================================');
  console.log(`--- AUDIT COMPLETE: ${passed}/${passed + failed} TESTS PASSED ---`);
  console.log('================================================================\n');

  if (failed > 0) process.exit(1);
}

runAudit().catch((err) => {
  console.error('Fatal audit error:', err);
  process.exit(1);
});
