const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { supabase } = require('../src/supabase');

async function inspectVisits() {
  const { data: visits } = await supabase
    .from('customer_visits')
    .select('*')
    .order('visited_at', { ascending: false });

  console.log('Top 20 visits in DB:');
  visits.slice(0, 20).forEach((v, i) => {
    console.log(`${i+1}. ${v.customer_name} | visited_at=${v.visited_at} | sp_phone=${v.salesperson_phone} | person_met=${v.person_met} | loc=${v.customer_address} | remarks=${v.remarks?.slice(0, 50)}`);
  });
}

inspectVisits();
