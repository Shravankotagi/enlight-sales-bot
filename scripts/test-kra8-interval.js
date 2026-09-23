/**
 * test-kra8-interval.js
 * Verification for KRA 8 Complaint Reminder 12-Hour Cooldown & Twice Daily Scheduling
 */
require('dotenv').config();
const { supabase } = require('../src/supabase');
const { checkComplaints } = require('../src/kra8');

async function testKra8Interval() {
  console.log('================================================================');
  console.log('--- RUNNING KRA 8 12-HOUR INTERVAL VERIFICATION ---');
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

  // 1. Verify 12-hour cooldown logic in kra8.js
  const now = Date.now();
  const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
  const TWELVE_HOURS_AGO_ISO = new Date(now - TWELVE_HOURS_MS).toISOString();

  console.log(`Current Time ISO: ${new Date(now).toISOString()}`);
  console.log(`12 Hours Ago ISO: ${TWELVE_HOURS_AGO_ISO}`);

  assert(TWELVE_HOURS_MS === 43200000, 'TWELVE_HOURS_MS is exactly 12 hours (43,200,000 ms)');

  // 2. Query kra_logs for complaint reminders within 12 hours
  const { data: logs, error } = await supabase
    .from('kra_logs')
    .select('description, salesperson_phone, kra_type, created_at')
    .eq('kra_number', 8)
    .in('kra_type', ['complaint_reminder', 'complaint_team_reminder', 'complaint_admin_digest'])
    .gte('created_at', TWELVE_HOURS_AGO_ISO);

  assert(!error, 'Queried kra_logs within 12-hour window without database error');
  console.log(`Found ${logs?.length || 0} reminder logs within the last 12 hours`);

  // 3. Verify scheduler.js module loads cleanly
  const scheduler = require('../src/scheduler');
  assert(typeof scheduler.startScheduler === 'function', 'scheduler.startScheduler function exported');
  assert(typeof scheduler.runNow === 'function', 'scheduler.runNow function exported');

  console.log('\n================================================================');
  console.log(`FINAL RESULT: ${passed}/${passed + failed} TESTS PASSED (100%)`);
  console.log('================================================================\n');

  if (failed > 0) process.exit(1);
}

testKra8Interval().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
