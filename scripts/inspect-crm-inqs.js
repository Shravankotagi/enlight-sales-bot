const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { supabase } = require('../src/supabase');

async function inspectCrmInquiries() {
  // Query all inquiries as inquiries.service.ts does
  const { data: allInqs, error } = await supabase
    .from('inquiries')
    .select('id, sender_name, sender_phone, raw_text, inquiry_type, status, source_channel, ai_extraction_json, created_at, salesperson_phone, customer_name, stage')
    .order('created_at', { ascending: false });

  console.log(`Total inquiries in DB: ${allInqs?.length || 0}`);

  // Also query deals
  const { data: deals } = await supabase.from('deals').select('id, inquiry_id, customer_name, stage, po_number, created_at, salesperson_phone');

  console.log('\nTop 25 Inquiries in DB:');
  allInqs?.slice(0, 25).forEach((inq, i) => {
    const ai = inq.ai_extraction_json || {};
    const custName = inq.customer_name || inq.sender_name || ai.companyName || ai.customer_name || 'Customer';
    const linkedDeal = deals?.find(d => d.inquiry_id === inq.id);
    console.log(`  ${i+1}. ID=${inq.id.slice(0, 6).toUpperCase()} | cust=${custName} | status=${inq.status} | dealStage=${linkedDeal?.stage || 'none'} | po=${linkedDeal?.po_number || 'none'} | inq_type=${inq.inquiry_type} | channel=${inq.source_channel} | created_at=${inq.created_at} | sp_phone=${inq.salesperson_phone}`);
  });
}

inspectCrmInquiries();
