const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { supabase, getAccessibleSalespersonPhonesForBot, expandPhoneVariants, isPhoneInScope } = require('../src/supabase');

async function debugOrders() {
  const senderPhone = '8262937458';
  const scope = await getAccessibleSalespersonPhonesForBot(senderPhone);
  const targetPhones = expandPhoneVariants(scope.phones || (senderPhone ? [senderPhone] : []));

  console.log('--- ALL WON / PO DEALS IN DB ---');
  const { data: allDeals } = await supabase
    .from('deals')
    .select('id, inquiry_id, customer_name, customer_phone, po_number, po_date, stage, delivery_location, payment_terms, total_amount, won_at, created_at, salesperson_phone, deal_items(id, sku_text, grade, dimensions, quantity, unit, rate, amount)')
    .order('created_at', { ascending: false });

  const ordersAll = (allDeals || [])
    .filter(d => (d.stage || '').toLowerCase() === 'won' || Boolean(d.po_number))
    .sort((a, b) => {
      const timeA = new Date(a.won_at || a.created_at || 0).getTime();
      const timeB = new Date(b.won_at || b.created_at || 0).getTime();
      return timeB - timeA;
    });

  console.log(`Total orders in DB: ${ordersAll.length}`);
  console.log('\nTop 10 Orders in DB (Overall):');
  ordersAll.slice(0, 10).forEach((d, i) => {
    console.log(`  ${i+1}. ${d.customer_name} | PO=${d.po_number} | created_at=${d.created_at} | won_at=${d.won_at} | sp_phone=${d.salesperson_phone}`);
  });

  const filterByScope = (items) => {
    if (scope.isAdmin || scope.phones === null) return items || [];
    return (items || []).filter(item => {
      if (!item.salesperson_phone) return false;
      return isPhoneInScope(item.salesperson_phone, targetPhones);
    });
  };

  const scopedOrders = filterByScope(ordersAll);
  console.log(`\nTotal scoped orders for 8262937458: ${scopedOrders.length}`);
  console.log('Top 10 Scoped Orders for 8262937458:');
  scopedOrders.slice(0, 10).forEach((d, i) => {
    console.log(`  ${i+1}. ${d.customer_name} | PO=${d.po_number} | created_at=${d.created_at} | won_at=${d.won_at} | sp_phone=${d.salesperson_phone}`);
  });
}

debugOrders();
