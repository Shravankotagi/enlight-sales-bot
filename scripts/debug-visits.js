const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { supabase, getAccessibleSalespersonPhonesForBot, expandPhoneVariants, isPhoneInScope } = require('../src/supabase');

async function testVisits() {
  const senderPhone = '8262937458';
  const scope = await getAccessibleSalespersonPhonesForBot(senderPhone);
  const targetPhones = expandPhoneVariants(scope.phones || (senderPhone ? [senderPhone] : []));

  let visitQuery = supabase
    .from('customer_visits')
    .select('*')
    .order('visited_at', { ascending: false, nullsFirst: false });

  if (!scope.isAdmin && targetPhones.length > 0) {
    visitQuery = visitQuery.in('salesperson_phone', targetPhones);
  }

  const { data: allVisits, error } = await visitQuery.limit(500);
  console.log('Error:', error);
  console.log('Found visits:', allVisits?.length);

  const filterByScope = (items) => {
    if (scope.isAdmin || scope.phones === null) return items || [];
    return (items || []).filter(item => {
      if (!item.salesperson_phone) return false;
      return isPhoneInScope(item.salesperson_phone, targetPhones);
    });
  };

  let scopedVisits = filterByScope(allVisits);
  scopedVisits = scopedVisits.filter(v => !(v.remarks && v.remarks.startsWith('Contact Synced from Zoho Bigin')));
  scopedVisits.sort((a, b) => new Date(b.visited_at || 0) - new Date(a.visited_at || 0));

  console.log('Scoped and filtered visits count:', scopedVisits.length);
  scopedVisits.slice(0, 7).forEach((v, i) => {
    console.log(`  ${i+1}. ${v.customer_name} | visited_at=${v.visited_at} | person_met=${v.person_met} | loc=${v.customer_address}`);
  });
}

testVisits();
