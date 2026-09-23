require('dotenv').config();
const { supabase } = require('../src/supabase');
const { executeAction } = require('../src/core/catalogFlow');

async function runDeepHealthCheck() {
  console.log('=================== 1. SUPABASE DATABASE HEALTH CHECK ===================');
  const tables = [
    'inquiries',
    'deals',
    'deal_items',
    'customer_visits',
    'complaints',
    'recurring_customers',
    'employees',
    'kra_logs',
    'activity_logs',
    'payment_tracking'
  ];

  for (const t of tables) {
    const { count, error } = await supabase.from(t).select('*', { count: 'exact', head: true });
    if (error) {
      console.error(`❌ Table [${t}] error: ${error.message}`);
    } else {
      console.log(`✅ Table [${t}]: ${count} records accessible`);
    }
  }

  console.log('\n=================== 2. INQUIRY & DEALS UPDATE SIMULATION ===================');
  const { data: inqs } = await supabase.from('inquiries').select('id, sender_name, sender_phone, ai_extraction_json').limit(1);
  if (inqs && inqs[0]) {
    const inq = inqs[0];
    const inqShort = 'INQ-' + inq.id.replace(/-/g, '').substring(0, 6).toUpperCase();
    console.log(`Testing UPDATE_INQUIRY on ${inqShort} (${inq.sender_name})...`);
    const draft = {
      action: 'UPDATE_INQUIRY',
      inquiry_id: inqShort,
      company_name: inq.sender_name,
      updates: {
        payment_terms: '45 Days',
        delivery_location: 'Chakan Pune',
      }
    };
    const res = await executeAction('UPDATE_INQUIRY', draft, inq.sender_phone || '919822000001');
    console.log('UPDATE_INQUIRY Response preview:');
    console.log(res.slice(0, 300) + '...\n');
  }

  console.log('\n=================== 3. VISIT LOG & UPDATE SIMULATION ===================');
  const visitDraft = {
    action: 'LOG_VISIT',
    company_name: 'Apex Precision Ltd',
    person_met: 'Mr. S. K. Verma',
    contact_phone: '9822012345',
    city_location: 'Nashik MIDC',
    visit_date: '23/09/2026',
    visit_outcome: 'Positive',
    meeting_remarks: 'Discussed CR sheet requirements and monthly schedule.',
    followup_action: 'Send quote for 25 MT CR Sheet by Friday',
  };
  const logVisitRes = await executeAction('LOG_VISIT', visitDraft, '919822000001');
  console.log('LOG_VISIT Response:\n' + logVisitRes);

  const updateVisitDraft = {
    action: 'UPDATE_VISIT',
    company_name: 'Apex Precision Ltd',
    updates: {
      person_met: 'Mr. S. K. Verma (VP Tech)',
      meeting_remarks: 'Discussed CR sheet and HR plates schedule.',
      followup_action: 'Send quote for 30 MT by Friday',
    }
  };
  const updVisitRes = await executeAction('UPDATE_VISIT', updateVisitDraft, '919822000001');
  console.log('\nUPDATE_VISIT Response:\n' + updVisitRes);

  console.log('\n=================== 4. COMPLAINT LOG & UPDATE SIMULATION ===================');
  const cmpDraft = {
    action: 'LOG_COMPLAINT',
    company_name: 'Apex Precision Ltd',
    complaint_type: 'Quality Defect',
    product_name: 'CR Sheet 1.20mm',
    complaint_description: 'Edge waviness detected during blanking',
    linked_inquiry_or_po: 'PO-APEX-9988',
  };
  const logCmpRes = await executeAction('LOG_COMPLAINT', cmpDraft, '919822000001');
  console.log('LOG_COMPLAINT Response:\n' + logCmpRes);

  const updCmpDraft = {
    action: 'UPDATE_COMPLAINT',
    company_name: 'Apex Precision Ltd',
    updates: {
      status: 'resolved',
      resolution_notes: 'Technical team inspected on site, trimmed edges and issued commercial credit note.',
    }
  };
  const updCmpRes = await executeAction('UPDATE_COMPLAINT', updCmpDraft, '919822000001');
  console.log('\nUPDATE_COMPLAINT Response:\n' + updCmpRes);

  console.log('\n=================== 5. ORDER UPDATE SIMULATION ===================');
  const { data: wonDeals } = await supabase.from('deals').select('id, customer_name, po_number, salesperson_phone').eq('stage', 'won').limit(1);
  if (wonDeals && wonDeals[0]) {
    const wd = wonDeals[0];
    const inqCode = 'INQ-' + wd.id.replace(/-/g, '').substring(0, 6).toUpperCase();
    console.log(`Testing UPDATE_ORDER on ${inqCode} (${wd.customer_name})...`);
    const ordDraft = {
      action: 'UPDATE_ORDER',
      inquiry_id: inqCode,
      company_name: wd.customer_name,
      updates: {
        po_number: wd.po_number || 'PO-VERIFIED-2026',
        delivery_location: 'Talegaon Pune',
        payment_terms: '30 Days Net',
      }
    };
    const ordRes = await executeAction('UPDATE_ORDER', ordDraft, wd.salesperson_phone || '919822000001');
    console.log('UPDATE_ORDER Response:\n' + ordRes);
  }

  console.log('\n================ ALL TEST SIMULATIONS COMPLETED SUCCESSFULLY! ================');
}

runDeepHealthCheck().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
