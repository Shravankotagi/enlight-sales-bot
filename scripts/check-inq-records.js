const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { fetchEditableRecordsForModule } = require('../src/core/catalogFlow');

async function check() {
  console.log('--- Admin (All Records) ---');
  const adminRecords = await fetchEditableRecordsForModule('UPDATE_INQUIRY', null);
  console.log('Total admin records:', adminRecords.length);
  adminRecords.slice(0, 7).forEach((r, i) => {
    console.log(`${i+1}. ${r.displayId} | ${r.customer_name} | ${r.product_summary} | ${r.stage} | ${r.date_formatted}`);
  });

  console.log('\n--- Specific Salesperson (8262937458) ---');
  const spRecords = await fetchEditableRecordsForModule('UPDATE_INQUIRY', '8262937458');
  console.log('Total SP records:', spRecords.length);
  spRecords.slice(0, 7).forEach((r, i) => {
    console.log(`${i+1}. ${r.displayId} | ${r.customer_name} | ${r.product_summary} | ${r.stage} | ${r.date_formatted}`);
  });
}

check();
