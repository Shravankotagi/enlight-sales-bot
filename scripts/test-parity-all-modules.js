const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { supabase } = require('../src/supabase');

async function testParity() {
  console.log('=== TESTING PARITY FOR ALL 4 MODULES ===\n');

  // 1. INQUIRIES
  console.log('--- 1. INQUIRIES ---');
  const { data: allInqs } = await supabase
    .from('inquiries')
    .select('id, sender_name, raw_text, status, inquiry_type, created_at, salesperson_phone, ai_extraction_json')
    .neq('inquiry_type', 'purchase_order')
    .order('created_at', { ascending: false });

  const { data: allDeals } = await supabase
    .from('deals')
    .select('id, inquiry_id, customer_name, stage, po_number, created_at, salesperson_phone, deal_items(*)')
    .order('created_at', { ascending: false });

  const wonInqIds = new Set(
    (allDeals || [])
      .filter(d => d.stage === 'won' || d.po_number)
      .map(d => d.inquiry_id)
      .filter(Boolean)
  );

  const terminalStatuses = new Set(['won', 'lost', 'closed', 'completed', 'cancelled', 'auto_created']);
  const validInqs = (allInqs || []).filter(i => {
    if (wonInqIds.has(i.id)) return false;
    if (terminalStatuses.has((i.status || '').toLowerCase())) return false;
    const raw = (i.raw_text || '').toLowerCase();
    if (raw.startsWith('[po document attached:') || raw.includes('po number:')) return false;
    return true;
  });

  console.log(`Found ${validInqs.length} open editable inquiries (PO audit records excluded).`);
  validInqs.slice(0, 7).forEach((inq, idx) => {
    const cleanCode = (inq.id || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toUpperCase();
    console.log(`  ${idx + 1}. INQ-${cleanCode} | ${inq.sender_name || 'Customer'} | ${inq.status} | ${inq.created_at}`);
  });

  // Check if 1DAA9E is in validInqs
  const has1DAA9E = validInqs.some(i => i.id.toLowerCase().includes('1daa9e'));
  console.log(`  INQ-1DAA9E in Inquiries: ${has1DAA9E} (Expected: false)`);

  // 2. ORDERS
  console.log('\n--- 2. ORDERS ---');
  const wonDeals = (allDeals || []).filter(d => d.stage === 'won' || d.po_number);
  console.log(`Found ${wonDeals.length} orders.`);
  wonDeals.slice(0, 7).forEach((d, idx) => {
    console.log(`  ${idx + 1}. ${d.po_number || d.id} | ${d.customer_name} | ${d.stage} | ${d.created_at}`);
  });

  // 3. VISITS
  console.log('\n--- 3. VISITS ---');
  const { data: visits } = await supabase
    .from('customer_visits')
    .select('id, customer_name, visited_at, created_at, remarks')
    .order('visited_at', { ascending: false });
  const cleanVisits = (visits || []).filter(v => !(v.remarks && v.remarks.startsWith('Contact Synced from Zoho Bigin')));
  console.log(`Found ${cleanVisits.length} visits.`);
  cleanVisits.slice(0, 7).forEach((v, idx) => {
    console.log(`  ${idx + 1}. ${v.customer_name} | ${v.visited_at || v.created_at}`);
  });

  // 4. COMPLAINTS
  console.log('\n--- 4. COMPLAINTS ---');
  const { data: complaints } = await supabase
    .from('complaints')
    .select('id, customer_name, status, complaint_type, reported_at, created_at')
    .order('created_at', { ascending: false });
  const openComplaints = (complaints || []).filter(c => !['resolved', 'closed', 'cancelled'].includes(String(c.status || '').toLowerCase().trim()));
  console.log(`Found ${openComplaints.length} open complaints.`);
  openComplaints.slice(0, 7).forEach((c, idx) => {
    const cleanId = (c.id || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toUpperCase();
    console.log(`  ${idx + 1}. COMP-${cleanId} | ${c.customer_name} | ${c.status} | ${c.reported_at || c.created_at}`);
  });
}

testParity();
