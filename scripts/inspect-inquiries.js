const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { supabase } = require('../src/supabase');

async function inspect() {
  console.log('--- Checking for INQ-1DAA9E or 1DAA9E in database ---');

  // Search in inquiries table
  const { data: inqs, error: inqErr } = await supabase
    .from('inquiries')
    .select('id, sender_name, sender_phone, raw_text, status, inquiry_type, created_at, salesperson_phone, ai_extraction_json')
    .limit(100);

  const matchingInqs = (inqs || []).filter(i => 
    (i.id || '').toLowerCase().includes('1daa9e') || 
    JSON.stringify(i).toLowerCase().includes('1daa9e') ||
    (i.sender_name || '').toLowerCase().includes('apex precision')
  );
  console.log('Matching Inquiries:', JSON.stringify(matchingInqs, null, 2));

  // Search in deals table
  const { data: deals, error: dealErr } = await supabase
    .from('deals')
    .select('id, inquiry_id, customer_name, customer_phone, stage, total_amount, created_at, salesperson_phone, deal_items(*)')
    .limit(100);

  const matchingDeals = (deals || []).filter(d => 
    (d.id || '').toLowerCase().includes('1daa9e') || 
    (d.inquiry_id || '').toLowerCase().includes('1daa9e') ||
    (d.customer_name || '').toLowerCase().includes('apex precision')
  );
  console.log('Matching Deals:', JSON.stringify(matchingDeals, null, 2));
}

inspect();
