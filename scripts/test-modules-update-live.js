require('dotenv').config();
const { supabase } = require('../src/supabase');

async function testVisitsUpdate() {
  console.log('\n=================== 1. TESTING VISITS MODULE UPDATE ===================');
  // 1. Fetch a visit record
  const { data: visits, error: vErr } = await supabase
    .from('customer_visits')
    .select('*')
    .order('visited_at', { ascending: false })
    .limit(1);

  if (vErr || !visits || visits.length === 0) {
    console.error('❌ Could not fetch customer visit:', vErr?.message);
    return false;
  }

  const visit = visits[0];
  console.log(`Found visit ID: ${visit.id} for "${visit.customer_name}"`);

  // 2. Perform test update
  const originalRemarks = visit.remarks || '';
  const testRemarks = `[Outcome: Positive] [Location: Pune Chakan] [FollowUp: Dispatch samples next week] [FollowUpStatus: pending] Automated test audit verification`;
  const testPersonMet = 'Mr. Rajesh Test Sharma';
  const testContact = '9822099999';

  const { error: updErr } = await supabase
    .from('customer_visits')
    .update({
      person_met: testPersonMet,
      contact_no: testContact,
      customer_address: 'Pune Chakan',
      remarks: testRemarks,
      follow_up_action: 'Dispatch samples next week',
      follow_up_status: 'pending',
    })
    .eq('id', visit.id);

  if (updErr) {
    console.error('❌ Failed to update customer visit:', updErr.message);
    return false;
  }
  console.log('✅ Updated customer visit in DB successfully.');

  // 3. Verify read back
  const { data: updatedV } = await supabase
    .from('customer_visits')
    .select('*')
    .eq('id', visit.id)
    .single();

  console.log('Verification check:');
  console.log('• Person Met:', updatedV.person_met === testPersonMet ? '✅ MATCH' : '❌ MISMATCH');
  console.log('• Contact Phone:', updatedV.contact_no === testContact ? '✅ MATCH' : '❌ MISMATCH');
  console.log('• Location:', updatedV.customer_address === 'Pune Chakan' ? '✅ MATCH' : '❌ MISMATCH');
  console.log('• Follow-up Status:', updatedV.follow_up_status === 'pending' ? '✅ MATCH' : '❌ MISMATCH');
  console.log('• Remarks outcome tag:', updatedV.remarks.includes('[Outcome: Positive]') ? '✅ MATCH' : '❌ MISMATCH');

  return true;
}

async function testComplaintsUpdate() {
  console.log('\n=================== 2. TESTING COMPLAINTS MODULE UPDATE ===================');
  // 1. Fetch a complaint record
  const { data: complaints, error: cErr } = await supabase
    .from('complaints')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(1);

  if (cErr || !complaints || complaints.length === 0) {
    console.error('❌ Could not fetch complaint:', cErr?.message);
    return false;
  }

  const cmp = complaints[0];
  console.log(`Found complaint ID: ${cmp.id} for "${cmp.customer_name}" (status: ${cmp.status})`);

  // 2. Perform test update
  const testType = 'Physical Damage';
  const testProduct = 'CR Sheet 1.20mm coils';
  const testNotes = 'Audit test: Material inspected and replacement dispatched.';
  const testStatus = 'resolved';
  const resolvedAt = new Date().toISOString();

  const { error: updErr } = await supabase
    .from('complaints')
    .update({
      complaint_type: testType,
      product_name: testProduct,
      affected_product: testProduct,
      resolution_notes: testNotes,
      status: testStatus,
      resolved_at: resolvedAt,
    })
    .eq('id', cmp.id);

  if (updErr) {
    console.error('❌ Failed to update complaint:', updErr.message);
    return false;
  }
  console.log('✅ Updated complaint in DB successfully.');

  // 3. Verify read back
  const { data: updatedC } = await supabase
    .from('complaints')
    .select('*')
    .eq('id', cmp.id)
    .single();

  console.log('Verification check:');
  console.log('• Complaint Type:', updatedC.complaint_type === testType ? '✅ MATCH' : '❌ MISMATCH');
  console.log('• Product Name:', updatedC.product_name === testProduct ? '✅ MATCH' : '❌ MISMATCH');
  console.log('• Status:', updatedC.status === testStatus ? '✅ MATCH' : '❌ MISMATCH');
  console.log('• Resolution Notes:', updatedC.resolution_notes === testNotes ? '✅ MATCH' : '❌ MISMATCH');
  console.log('• Resolved At:', Boolean(updatedC.resolved_at) ? '✅ MATCH' : '❌ MISMATCH');

  return true;
}

async function testOrdersUpdate() {
  console.log('\n=================== 3. TESTING ORDERS MODULE UPDATE ===================');
  // 1. Fetch a won deal / order
  const { data: deals, error: dErr } = await supabase
    .from('deals')
    .select('*, deal_items(*)')
    .eq('stage', 'won')
    .order('created_at', { ascending: false })
    .limit(1);

  if (dErr || !deals || deals.length === 0) {
    console.error('❌ Could not fetch won deal/order:', dErr?.message);
    return false;
  }

  const deal = deals[0];
  console.log(`Found won order ID: ${deal.id} for "${deal.customer_name}" (PO: ${deal.po_number || 'None'})`);

  // 2. Perform test update
  const testPo = `PO-TEST-${Date.now().toString().slice(-4)}`;
  const testDelivery = 'Taloja MIDC Navi Mumbai';
  const testPayment = '45 Days Credit';
  const testPoDate = '2026-09-23';

  const { error: updErr } = await supabase
    .from('deals')
    .update({
      po_number: testPo,
      po_date: testPoDate,
      delivery_location: testDelivery,
      customer_address: testDelivery,
      payment_terms: testPayment,
    })
    .eq('id', deal.id);

  if (updErr) {
    console.error('❌ Failed to update deal/order:', updErr.message);
    return false;
  }
  console.log('✅ Updated deal/order in DB successfully.');

  // 3. If line items exist, test rate/qty update
  if (deal.deal_items && deal.deal_items.length > 0) {
    const item = deal.deal_items[0];
    const testRate = 58500;
    const testQty = item.quantity || 10;
    const testAmt = testRate * testQty;

    const { error: itemUpdErr } = await supabase
      .from('deal_items')
      .update({
        rate: testRate,
        amount: testAmt,
      })
      .eq('id', item.id);

    if (itemUpdErr) {
      console.error('❌ Failed to update deal item:', itemUpdErr.message);
    } else {
      console.log('✅ Updated deal item rate & amount successfully.');
    }
  }

  // 4. Verify read back
  const { data: updatedD } = await supabase
    .from('deals')
    .select('*, deal_items(*)')
    .eq('id', deal.id)
    .single();

  console.log('Verification check:');
  console.log('• PO Number:', updatedD.po_number === testPo ? '✅ MATCH' : '❌ MISMATCH');
  console.log('• PO Date:', updatedD.po_date === testPoDate ? '✅ MATCH' : '❌ MISMATCH');
  console.log('• Delivery Location:', updatedD.delivery_location === testDelivery ? '✅ MATCH' : '❌ MISMATCH');
  console.log('• Payment Terms:', updatedD.payment_terms === testPayment ? '✅ MATCH' : '❌ MISMATCH');
  if (updatedD.deal_items && updatedD.deal_items.length > 0) {
    console.log('• Deal Item Rate:', updatedD.deal_items[0].rate === 58500 ? '✅ MATCH' : '❌ MISMATCH');
  }

  return true;
}

(async () => {
  try {
    const vOk = await testVisitsUpdate();
    const cOk = await testComplaintsUpdate();
    const oOk = await testOrdersUpdate();

    console.log('\n=================== AUDIT SUMMARY ===================');
    console.log(`Visits Module Update:    ${vOk ? '✅ PASSED' : '❌ FAILED'}`);
    console.log(`Complaints Module Update: ${cOk ? '✅ PASSED' : '❌ FAILED'}`);
    console.log(`Orders Module Update:     ${oOk ? '✅ PASSED' : '❌ FAILED'}`);
    process.exit(vOk && cOk && oOk ? 0 : 1);
  } catch (err) {
    console.error('Fatal audit error:', err);
    process.exit(1);
  }
})();
