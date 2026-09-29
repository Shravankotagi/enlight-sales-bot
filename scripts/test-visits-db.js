const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { supabase } = require('../src/supabase');

async function testVisits() {
  const { data, error } = await supabase.from('customer_visits').select('*');
  console.log('Error:', error);
  console.log('Data length:', data ? data.length : 0);
  if (data && data.length > 0) {
    console.log('Sample visit:', JSON.stringify(data[0], null, 2));
  } else {
    // Check kra_logs for visit logs
    const { data: kraLogs } = await supabase.from('kra_logs').select('*').eq('kra_number', 9);
    console.log('KRA 9 logs length:', kraLogs ? kraLogs.length : 0);
    if (kraLogs && kraLogs.length > 0) {
      console.log('Sample KRA 9 log:', JSON.stringify(kraLogs[0], null, 2));
    }
  }
}

testVisits();
