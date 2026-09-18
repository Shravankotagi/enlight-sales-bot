const readline = require('readline');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { handleCatalogFlow } = require('../src/core/catalogFlow');
const { getFullActiveSession, saveActiveSession, supabase } = require('../src/supabase');

async function startCli() {
  console.log('================================================================');
  console.log('       🤖 ENLIGHT SALES OS — WHATSAPP BOT LOCAL TEST CLI       ');
  console.log('================================================================\n');

  const { data: employees } = await supabase.from('employees').select('name, phone, role').order('name');
  
  let currentPhone = '917977088031'; // Default: akruti
  let currentName = 'Akruti';

  if (employees && employees.length > 0) {
    const defaultEmp = employees.find(e => e.phone === '917977088031') || employees[0];
    currentPhone = defaultEmp.phone;
    currentName = defaultEmp.name;
    console.log(`📋 Available Reps:`);
    employees.forEach((e, idx) => {
      console.log(`  [${idx + 1}] ${e.name} (${e.phone}) - Role: ${e.role || 'Sales Rep'}`);
    });
    console.log(`\n👉 Current Active Tester: ${currentName} (${currentPhone})`);
  }

  console.log(`\n💡 Commands:`);
  console.log(`  • Type any message (e.g. "Hi", "1", "Western Fabricators 20 MT HR Sheet @ 52000...", "Yes", "Cancel")`);
  console.log(`  • Type "session" to inspect current session state`);
  console.log(`  • Type "reset" to clear active session`);
  console.log(`  • Type "exit" or "quit" to stop\n`);
  console.log('────────────────────────────────────────────────────────────────\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `👤 ${currentName} > `,
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();

    if (!input) {
      rl.prompt();
      return;
    }

    if (input.toLowerCase() === 'exit' || input.toLowerCase() === 'quit') {
      console.log('\n👋 Exiting CLI. Have a great day!');
      process.exit(0);
    }

    if (input.toLowerCase() === 'session') {
      const sess = await getFullActiveSession(currentPhone);
      console.log('\n🔍 CURRENT SESSION:');
      console.log(JSON.stringify(sess, null, 2));
      console.log();
      rl.prompt();
      return;
    }

    if (input.toLowerCase() === 'reset') {
      await saveActiveSession(currentPhone, 'Unknown', 'general');
      console.log('\n🔄 Session reset to general (Unknown customer).\n');
      rl.prompt();
      return;
    }

    try {
      const result = await handleCatalogFlow(input, currentPhone);
      console.log(`\n🤖 BOT REPLY:\n${result.reply}\n`);
      if (result.interactiveButtons && result.interactiveButtons.length > 0) {
        console.log(`[🔘 Buttons: ${result.interactiveButtons.map(b => b.title || b.id).join(' | ')}]\n`);
      }
    } catch (err) {
      console.error('\n❌ ERROR:', err.message, '\n');
    }

    rl.prompt();
  });
}

startCli().catch(err => {
  console.error('Fatal CLI Error:', err);
  process.exit(1);
});
