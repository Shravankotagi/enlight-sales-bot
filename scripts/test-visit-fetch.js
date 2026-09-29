const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { fetchEditableRecordsForModule } = require('../src/core/catalogFlow');

async function test() {
  console.log('Testing UPDATE_VISIT for 8262937458:');
  const records = await fetchEditableRecordsForModule('UPDATE_VISIT', '8262937458');
  console.log('Returned records count:', records.length);
  records.forEach((r, i) => {
    console.log(`${i+1}. ${r.customer_name} | ${r.location} | ${r.outcome} | ${r.date_formatted} | id=${r.id}`);
  });

  console.log('\nTesting UPDATE_VISIT for 918262937458:');
  const records2 = await fetchEditableRecordsForModule('UPDATE_VISIT', '918262937458');
  console.log('Returned records count:', records2.length);
  records2.forEach((r, i) => {
    console.log(`${i+1}. ${r.customer_name} | ${r.location} | ${r.outcome} | ${r.date_formatted} | id=${r.id}`);
  });
}

test();
