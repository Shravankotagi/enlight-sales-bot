const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { supabase, getAccessibleSalespersonPhonesForBot, expandPhoneVariants, isPhoneInScope } = require('../src/supabase');
const { formatDateDDMMYYYY } = require('../src/core/catalogFlow');

function formatProductSummaryCompact(record) {
  if (Array.isArray(record.deal_items) && record.deal_items.length > 0) {
    const totalQty = record.deal_items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
    const unit = record.deal_items[0].unit || 'MT';
    const mainProduct = record.deal_items[0].sku_text || 'Steel Item';
    if (record.deal_items.length === 1) {
      const dim = record.deal_items[0].dimensions ? ` (${record.deal_items[0].dimensions})` : '';
      return `${totalQty} ${unit} ${mainProduct}${dim}`.trim();
    }
    const products = Array.from(new Set(record.deal_items.map(i => i.sku_text).filter(Boolean))).join(', ');
    return `${record.deal_items.length} Items (${totalQty} ${unit}) — ${products}`;
  }
  return 'Steel Material';
}

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

async function fetchOrdersExact(senderPhone) {
  const scope = senderPhone ? await getAccessibleSalespersonPhonesForBot(senderPhone) : { phones: null, isAdmin: true };
  const targetPhones = expandPhoneVariants(scope.phones || (senderPhone ? [senderPhone] : []));

  const [dealsRes, customersRes] = await Promise.all([
    supabase
      .from('deals')
      .select('id, inquiry_id, customer_name, customer_phone, po_number, po_date, stage, delivery_location, payment_terms, total_amount, won_at, created_at, salesperson_phone, deal_items(id, sku_text, grade, dimensions, quantity, unit, rate, amount)')
      .eq('stage', 'won')
      .order('won_at', { ascending: false, nullsFirst: false })
      .limit(500),
    supabase
      .from('recurring_customers')
      .select('customer_name, assigned_salesperson_phone')
      .eq('is_active', true)
  ]);

  const customerOwnerMap = new Map();
  customersRes.data?.forEach(c => {
    if (c.customer_name && c.assigned_salesperson_phone) {
      customerOwnerMap.set(c.customer_name.trim().toLowerCase(), c.assigned_salesperson_phone);
    }
  });

  const allDeals = dealsRes.data || [];

  const filterByScope = (items) => {
    if (scope.isAdmin || scope.phones === null) return items || [];
    return (items || []).filter(item => {
      const assignedOwnerPhone = getAssignedPhoneFromCustomerMap(item.customer_name, customerOwnerMap);
      const effectivePhone = assignedOwnerPhone || item.salesperson_phone;
      if (!effectivePhone) return false;
      return isPhoneInScope(effectivePhone, targetPhones);
    });
  };

  const scopedDeals = filterByScope(allDeals);

  return scopedDeals.map((d, i) => {
    const cleanCode = (d.id || '').replace(/^(?:INQ|DEAL)-/i, '').replace(/[^a-zA-Z0-9]/g, '').substring(0, 6).toUpperCase();
    const displayInq = `INQ-${cleanCode}`;
    const displayId = d.po_number ? d.po_number : displayInq;
    const dateFormatted = d.po_date ? formatDateDDMMYYYY(d.po_date) : (d.won_at ? formatDateDDMMYYYY(d.won_at) : (d.created_at ? formatDateDDMMYYYY(d.created_at) : formatDateDDMMYYYY(new Date())));

    return `${i+1}. ${displayId} | ${d.customer_name} | ${formatProductSummaryCompact(d)} | ${dateFormatted}`;
  });
}

async function run() {
  const senderPhone = '8262937458';
  const orders = await fetchOrdersExact(senderPhone);
  console.log(`Orders for ${senderPhone} (Total: ${orders.length}):`);
  orders.slice(0, 7).forEach(line => console.log(line));
}
run();
