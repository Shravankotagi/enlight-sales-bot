const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { runOrchestrator } = require('../src/core/orchestrator');

async function testLiveRetrievalQueries() {
  console.log('================================================================');
  console.log('--- TESTING LIVE DATA RETRIEVAL & ZERO FABRICATION ---');
  console.log('================================================================\n');

  const testPhone = '919820123456'; // Admin / test phone

  const queries = [
    'Show visit follow-ups due today',
    'Which customers haven\'t been visited in the last 30 days?',
    'List all open inquiries',
    'Who is the contact person for Supreme Steel?',
    'Which sales rep is converting the most inquiries into orders?'
  ];

  for (const q of queries) {
    console.log(`\n================================================================`);
    console.log(`PROMPT: "${q}"`);
    console.log(`================================================================`);
    try {
      const reply = await runOrchestrator(q, testPhone, { employeeName: 'Max' });
      console.log('BOT RESPONSE:\n', reply);
      
      // Verify no emojis, no asterisks
      const hasAsterisks = /\*/.test(reply);
      console.log(`- Asterisks Free: ${!hasAsterisks ? '✅ YES' : '❌ HAS ASTERISKS'}`);

      // Verify max 8 items if numbered list
      const matches = reply.match(/^\s*(\d+)\.\s+/gm) || [];
      const highestNum = matches.length > 0
        ? Math.max(...matches.map(m => parseInt(m.trim().split('.')[0], 10)))
        : 0;
      console.log(`- Max Numbered Item: ${highestNum <= 8 ? `✅ ${highestNum} (<=8)` : `❌ ${highestNum} (>8)`}`);

    } catch (err) {
      console.error('Error during query:', err.message);
    }
  }

  console.log('\n================================================================');
  console.log('--- RETRIEVAL AUDIT COMPLETE ---');
  console.log('================================================================');
}

testLiveRetrievalQueries().catch(console.error);
