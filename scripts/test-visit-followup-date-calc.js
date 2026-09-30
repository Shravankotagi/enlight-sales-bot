const assert = require('assert');
const { extractFollowUpDate, buildConfirmationSummary } = require('../src/core/catalogFlow');

async function runTests() {
  console.log('=== Running Tests for Follow-up Date Calculation ===\n');

  // Test 1: extractFollowUpDate with 17-09-2026 string
  const test1 = extractFollowUpDate('add a follow up within 15 days for quotation', '17-09-2026');
  console.log('Test 1 (15 days from 17-09-2026):', test1);
  assert.strictEqual(test1, '2026-10-02', '15 days from 17-09-2026 should be 2026-10-02');

  // Test 2: extractFollowUpDate with 7 days from 17-09-2026
  const test2 = extractFollowUpDate('add a follow up within 7 days for quotation', '17-09-2026');
  console.log('Test 2 (7 days from 17-09-2026):', test2);
  assert.strictEqual(test2, '2026-09-24', '7 days from 17-09-2026 should be 2026-09-24');

  // Test 3: extractFollowUpDate with Date object
  const test3 = extractFollowUpDate('add a follow up within 7 days for quotation', new Date('2026-09-17T00:00:00.000Z'));
  console.log('Test 3 (7 days from Date object):', test3);
  assert.strictEqual(test3, '2026-09-24', '7 days from Date object should be 2026-09-24');

  // Test 4: buildConfirmationSummary for UPDATE_VISIT (15 days)
  const draftUpdate15 = {
    action: 'UPDATE_VISIT',
    visit_id: 'a5f0b66d-1234-5678-90ab-cdef12345678',
    company_name: 'Maurya Industries',
    visit_date: '17-09-2026',
    updates: {
      followup_action: 'follow up within 15 days for quotation',
    },
  };
  const summary15 = buildConfirmationSummary('UPDATE_VISIT', draftUpdate15);
  console.log('\n--- UPDATE_VISIT Summary (15 days) ---');
  console.log(summary15);
  assert.ok(summary15.includes('• *Follow-up Date* → 02-10-2026'), 'Summary must contain Follow-up Date → 02-10-2026');

  // Test 5: buildConfirmationSummary for UPDATE_VISIT (7 days)
  const draftUpdate7 = {
    action: 'UPDATE_VISIT',
    visit_id: 'a5f0b66d-1234-5678-90ab-cdef12345678',
    company_name: 'Maurya Industries',
    visit_date: '17-09-2026',
    updates: {
      followup_action: 'follow up within 7 days for quotation',
    },
  };
  const summary7 = buildConfirmationSummary('UPDATE_VISIT', draftUpdate7);
  console.log('\n--- UPDATE_VISIT Summary (7 days) ---');
  console.log(summary7);
  assert.ok(summary7.includes('• *Follow-up Date* → 24-09-2026'), 'Summary must contain Follow-up Date → 24-09-2026');

  // Test 6: buildConfirmationSummary for LOG_VISIT (7 days)
  const draftLog7 = {
    action: 'LOG_VISIT',
    company_name: 'Maurya Industries',
    person_met: 'Mr. Anand Kulkarni',
    visit_date: '17-09-2026',
    visit_outcome: 'Positive',
    followup_action: 'follow up within 7 days for quotation',
  };
  const summaryLog7 = buildConfirmationSummary('LOG_VISIT', draftLog7);
  console.log('\n--- LOG_VISIT Summary (7 days) ---');
  console.log(summaryLog7);
  assert.ok(summaryLog7.includes('• *Follow-up Date:* 24-09-2026'), 'LOG_VISIT summary must contain Follow-up Date: 24-09-2026');

  console.log('\n✅ ALL 6 TESTS PASSED PERFECTLY!');
}

runTests().catch(err => {
  console.error('\n❌ Test failed:', err);
  process.exit(1);
});
