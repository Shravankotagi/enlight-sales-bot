const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { supabase } = require('../src/supabase');

function getAssignedPhoneFromCustomerMap(customerName, customerOwnerMap) {
  if (!customerName || !customerOwnerMap || customerOwnerMap.size === 0) return null;
  const clean = customerName.toLowerCase().trim();
  if (customerOwnerMap.has(clean)) return customerOwnerMap.get(clean);

  const stripped = clean
    .replace(/\b(private\s+limited|pvt\s+ltd|pvt\s+limited|private\s+ltd|co\s+ltd|co\s+limited|llp|limited|pvt|ltd|inc|corp|co|corporation)\b/gi, '')
    .replace(/[^a-z0-9]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!stripped) return null;

  for (const [name, phone] of customerOwnerMap.entries()) {
    if (name === clean) return phone;
    const mapStripped = name
      .replace(/\b(private\s+limited|pvt\s+ltd|pvt\s+limited|private\s+ltd|co\s+ltd|co\s+limited|llp|limited|pvt|ltd|inc|corp|co|corporation)\b/gi, '')
      .replace(/[^a-z0-9]/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (mapStripped && (stripped === mapStripped || stripped.startsWith(mapStripped) || mapStripped.startsWith(stripped))) {
      return phone;
    }
  }
  return null;
}

async function inspect() {
  const [dealsRes, customersRes] = await Promise.all([
    supabase.from('deals').select('id, inquiry_id, customer_name, customer_phone, po_number, po_date, stage, delivery_location, payment_terms, total_amount, won_at, created_at, salesperson_phone').order('won_at', { ascending: false, nullsFirst: false }),
    supabase.from('recurring_customers').select('customer_name, assigned_salesperson_phone').eq('is_active', true),
  ]);

  const customerOwnerMap = new Map();
  customersRes.data?.forEach(c => {
    if (c.customer_name && c.assigned_salesperson_phone) {
      customerOwnerMap.set(c.customer_name.trim().toLowerCase(), c.assigned_salesperson_phone);
    }
  });

  const wonDeals = (dealsRes.data || []).filter(d => (d.stage || '').toLowerCase() === 'won' || Boolean(d.po_number));

  console.log('Total won/PO deals in DB:', wonDeals.length);

  // Apply backend effective salesperson phone:
  const withEffectivePhone = wonDeals.map(d => {
    const assignedOwnerPhone = getAssignedPhoneFromCustomerMap(d.customer_name, customerOwnerMap);
    const effectivePhone = assignedOwnerPhone || d.salesperson_phone || '';
    return { ...d, assignedOwnerPhone, effectivePhone };
  });

  const shravanPhoneClean = '8262937458';

  const shravanOrders = withEffectivePhone.filter(d => {
    const pClean = (d.effectivePhone || '').replace(/\D/g, '').slice(-10);
    return pClean === shravanPhoneClean;
  });

  console.log('Shravan orders count with customer ownership mapping (Frontend Count):', shravanOrders.length);
  console.log('--- Shravan Orders List (Frontend Parity): ---');
  shravanOrders.forEach((o, i) => {
    console.log(`${i+1}. PO: ${o.po_number || 'N/A'} | ${o.customer_name} | won_at: ${o.won_at || o.created_at} | raw_salesperson_phone: ${o.salesperson_phone} | effectivePhone: ${o.effectivePhone}`);
  });
}
inspect();
