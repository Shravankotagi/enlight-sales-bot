const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { supabase, getAccessibleSalespersonPhonesForBot, expandPhoneVariants } = require('../src/supabase');

async function testWonDeals() {
  const senderPhone = '8262937458';
  const scope = await getAccessibleSalespersonPhonesForBot(senderPhone);
  const targetPhones = expandPhoneVariants(scope.phones || (senderPhone ? [senderPhone] : []));

  // Query exactly as backend deals.service.ts does
  let query = supabase
    .from('deals')
    .select(`
      id, inquiry_id, stage, po_number, po_date, customer_name, customer_phone, delivery_location, payment_terms, total_amount, created_at, won_at, salesperson_phone,
      deal_items (*)
    `)
    .eq('stage', 'won')
    .order('won_at', { ascending: false, nullsFirst: false });

  if (targetPhones.length > 0) {
    query = query.in('salesperson_phone', targetPhones);
  }

  const { data: wonDeals, error } = await query;
  console.log('Error:', error);
  console.log('Won deals count:', wonDeals?.length);
  console.log('\nTop 10 Won Deals (sorted by won_at DESC):');
  wonDeals?.slice(0, 10).forEach((d, i) => {
    console.log(`  ${i+1}. ${d.customer_name} | PO=${d.po_number} | won_at=${d.won_at} | created_at=${d.created_at}`);
  });
}

testWonDeals();
