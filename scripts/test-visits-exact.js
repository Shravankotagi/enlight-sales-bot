const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { supabase, getAccessibleSalespersonPhonesForBot, expandPhoneVariants, isPhoneInScope } = require('../src/supabase');
const { formatDateDDMMYYYY } = require('../src/core/catalogFlow');

async function getVisitsExact(senderPhone) {
  const scope = senderPhone ? await getAccessibleSalespersonPhonesForBot(senderPhone) : { phones: null, isAdmin: true };
  const targetPhones = expandPhoneVariants(scope.phones || (senderPhone ? [senderPhone] : []));

  let visitQuery = supabase
    .from('customer_visits')
    .select('*')
    .order('visited_at', { ascending: false, nullsFirst: false });

  if (!scope.isAdmin && targetPhones.length > 0) {
    visitQuery = visitQuery.in('salesperson_phone', targetPhones);
  }

  const { data: allVisits, error } = await visitQuery.limit(500);
  if (error) console.error('Visits Query Error:', error);

  const filterByScope = (items) => {
    if (scope.isAdmin || scope.phones === null) return items || [];
    return (items || []).filter(item => {
      if (!item.salesperson_phone) return false;
      return isPhoneInScope(item.salesperson_phone, targetPhones);
    });
  };

  let scopedVisits = filterByScope(allVisits);

  // Exclude synthetic Bigin sync logs
  scopedVisits = scopedVisits.filter(v => !(v.remarks && v.remarks.startsWith('Contact Synced from Zoho Bigin')));

  // Sort newest first by visited_at DESC strictly matching CRM Visits tab
  scopedVisits.sort((a, b) => new Date(b.visited_at || 0) - new Date(a.visited_at || 0));

  const list = scopedVisits.map((v, i) => {
    const vDate = v.visited_at ? new Date(v.visited_at) : new Date();
    const dateFormatted = formatDateDDMMYYYY(vDate);
    const outTagMatch = (v.remarks || '').match(/\[Outcome:\s*([^\]]+)\]/i);
    const outcome = outTagMatch ? outTagMatch[1] : (v.outcome || 'Positive');
    const locTagMatch = (v.remarks || '').match(/\[Location:\s*([^\]]+)\]/i);
    const location = v.customer_address || (locTagMatch ? locTagMatch[1] : 'Not specified');

    return `${i+1}. ${v.customer_name || 'Customer'} | ${location} | ${outcome} | ${dateFormatted}`;
  });

  return list;
}

async function run() {
  const senderPhone = '8262937458';
  const list = await getVisitsExact(senderPhone);
  console.log(`Visits for ${senderPhone} (${list.length} total):`);
  list.slice(0, 7).forEach(line => console.log(line));
}

run();
