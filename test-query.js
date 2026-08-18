const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { isQuery, handleQuery } = require('./src/queryhandler');

const testMessages = [
  'my sales this month',
  'meri sales batao is mahine',
  'pending deals',
  'my kra status',
  'deals this week',
  'pending inquiries',
  'need 10 MT HR coil 2mm',  // should NOT be detected as query
  'Dynamic Industries ka PO aaya'  // should NOT be detected as query
];

async function test() {
  console.log('=== QUERY DETECTION TEST ===\n');
  
  for (const msg of testMessages) {
    const query = isQuery(msg);
    console.log(`"${msg}"`);
    console.log(`→ Is query: ${query}\n`);
  }

  console.log('\n=== QUERY RESPONSE TEST ===\n');

  const queries = [
    'Customer 360 for Supreme Steel',
    'What is our MOQ policy?',
    'Which customers are due for reorder?',
    'Show churn radar',
    'my sales this month',
    'pending deals'
  ];

  for (const q of queries) {
    console.log(`Query: "${q}"`);
    const response = await handleQuery(q, '919187305823');
    console.log('Response:\n' + response);
    console.log('\n' + '='.repeat(50) + '\n');
  }
}

test().catch(console.error);
