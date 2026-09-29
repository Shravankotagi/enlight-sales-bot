const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { supabase } = require('../src/supabase');

async function checkDeal() {
  const { data, error } = await supabase
    .from('deals')
    .select('*, deal_items(*)')
    .eq('id', '5346ded9-f952-4d40-acef-338906c52a15');
  console.log('Deal:', JSON.stringify(data, null, 2));

  // Also check inquiry 1daa9e6e-5875-40a1-99b9-506da068b815
  const { data: inq } = await supabase
    .from('inquiries')
    .select('*')
    .eq('id', '1daa9e6e-5875-40a1-99b9-506da068b815');
  console.log('Inquiry:', JSON.stringify(inq, null, 2));
}

checkDeal();
