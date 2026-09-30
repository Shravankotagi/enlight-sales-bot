const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { supabase } = require('../src/supabase');
const { getAccessibleSalespersonPhonesForBot, expandPhoneVariants } = require('../src/supabase');

async function diagnose() {
  console.log('================ DIAGNOSING 3 MODULES ================');

  // Check what phones/employees exist
  const { data: employees } = await supabase.from('employees').select('id, name, phone, role');
  console.log('\n--- EMPLOYEES ---');
  console.log(employees);

  const testPhone = '8262937458';
  const scope = await getAccessibleSalespersonPhonesForBot(testPhone);
  console.log('\n--- SCOPE for 8262937458 ---');
  console.log(scope);

  // 1. VISITS
  console.log('\n--- 1. CUSTOMER VISITS IN DB ---');
  const { data: allVisits } = await supabase
    .from('customer_visits')
    .select('id, customer_name, customer_address, person_met, contact_no, remarks, visited_at, created_at, salesperson_phone')
    .order('visited_at', { ascending: false });
  console.log(`Total visits in DB: ${allVisits?.length || 0}`);
  allVisits?.slice(0, 10).forEach((v, i) => {
    console.log(`  ${i+1}. ${v.customer_name} | visited_at=${v.visited_at} | created_at=${v.created_at} | salesperson_phone=${v.salesperson_phone} | remarks=${v.remarks}`);
  });

  // 2. ORDERS (Deals in frontend Orders page)
  console.log('\n--- 2. ORDERS (DEALS) IN DB ---');
  const { data: allDeals } = await supabase
    .from('deals')
    .select('id, inquiry_id, customer_name, customer_phone, po_number, po_date, stage, total_amount, won_at, created_at, salesperson_phone, deal_items(sku_text, quantity, unit)')
    .order('created_at', { ascending: false });
  console.log(`Total deals in DB: ${allDeals?.length || 0}`);
  const orders = (allDeals || []).filter(d => d.stage === 'won' || Boolean(d.po_number));
  console.log(`Total won/po deals: ${orders.length}`);
  orders.slice(0, 10).forEach((d, i) => {
    console.log(`  ${i+1}. ${d.customer_name} | po_number=${d.po_number} | po_date=${d.po_date} | won_at=${d.won_at} | created_at=${d.created_at} | sp_phone=${d.salesperson_phone}`);
  });

  // 3. INQUIRIES
  console.log('\n--- 3. INQUIRIES IN DB ---');
  const { data: allInqs } = await supabase
    .from('inquiries')
    .select('id, sender_name, sender_phone, raw_text, status, inquiry_type, created_at, salesperson_phone, ai_extraction_json')
    .order('created_at', { ascending: false });
  console.log(`Total inquiries in DB: ${allInqs?.length || 0}`);
  allInqs?.slice(0, 15).forEach((inq, i) => {
    console.log(`  ${i+1}. ID=${inq.id.slice(0, 8)} | ${inq.sender_name} | status=${inq.status} | inq_type=${inq.inquiry_type} | created_at=${inq.created_at} | sp_phone=${inq.salesperson_phone}`);
  });
}

diagnose();
