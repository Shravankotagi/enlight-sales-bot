const { createClient } = require('@supabase/supabase-js');
const { getPaymentSummary } = require('./kra5');
const { getComplaintSummary } = require('./kra8');
const { generateFullKRAReport } = require('./kraReport');
const { getNewCustomerSummary } = require('./kra2');
const { handleConversationalQuery } = require('./agents/assistantAgent');
const { getAccessibleSalespersonPhonesForBot } = require('./supabase');

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

// Detect if message is a query or an inquiry
function isQuery(text) {
  const lowerText = text.toLowerCase();

  // If it looks like a steel order/inquiry (e.g. contains quantity and units or pricing request), it is NOT a dashboard query!
  const hasInquiryPatterns = 
    /\b\d+\s*(mt|kg|ton|pcs|sheet|coil|bar|flat|plate|mm|mtr)\b/i.test(lowerText) || 
    lowerText.includes('rate is') || 
    lowerText.includes('price is') ||
    lowerText.includes('target rate') ||
    /\b\d+\s*x\s*\d+/i.test(lowerText);
    
  if (hasInquiryPatterns) {
    return false;
  }

  const queryKeywords = [
    // Sales queries
    'my sales', 'meri sales', 'kitni sales', 'sales this month',
    'is mahine', 'this month', 'last month', 'pichle mahine',
    'team sales', 'all sales', 'company sales', 'total sales',
    // Deal queries  
    'pending deals', 'open deals', 'meri deals', 'team deals',
    'my deals', 'deals this week', 'is hafte',
    'active deals', 'current deals', 'won deals', 'won customers',
    'lost deals', 'rejected deals',
    // Customer queries
    'customer list', 'which customers', 'kaun se customer',
    'not ordered', 'order nahi', 'inactive customers',
    'my customers', 'all customers', 'team customers', 'client list', 'client directory',
    // Payment queries
    'outstanding', 'overdue', 'due payment',
    'pending payment', 'baaki payment', 'baaki list',
    'who hasn\'t paid', 'payment aging', 'collection due',
    // Performance & Summary queries
    'my performance', 'performance report', 'target achievements',
    'performance', 'performace', 'status report', 'performance status',
    'target status', 'sales achievement', 'my target', 'my status',
    'kra status', 'kra report', 'my kra', 'team kra', 'team status',
    // Visit queries
    'my visits', 'visit log', 'who did i visit', 'field visits',
    'customer visits', 'site visits', 'team visits',
    // Rate / Price queries
    'rate sheet', 'current rates', 'today\'s rates', 'steel rates',
    'bhav', 'price list', 'rate list',
    // Inquiry queries
    'my inquiries', 'meri inquiries', 'pending inquiries',
    'review queue', 'kitni inquiries', 'team inquiries',
    // General / Command phrases
    'monthly report', 'sales report', 'status report', 'show me sales',
    'my reports', 'my report', 'all reports', 'show reports', 'report card',
    'report', 'reports', 'dashboard', 'login', 'link', 'website', 'portal', 'url',
    'new customers', 'onboarded customers', 'kra 2',
    // General conversational & date/pricing query triggers
    'date', 'time', 'today', 'aaj', 'din', 'tarikh', 'time kya',
    'what is', 'tell me', 'help', 'how to', 'bot', 'give me', 'show me', 'list',
    'assistant', 'hello', 'hi', 'hey', 'namaste', 'joke', 'who are you', 'kaise ho'
  ];

  return queryKeywords.some(keyword => lowerText.includes(keyword));
}

// Get current month date range
function getMonthRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    monthName: now.toLocaleString('en-IN', { month: 'long' }),
    year: now.getFullYear()
  };
}

function getMonthRangeFromQuery(text) {
  if (!text) return getMonthRange();
  const lower = text.toLowerCase();
  const months = [
    { name: 'january', aliases: ['january', 'jan', 'januari'] },
    { name: 'february', aliases: ['february', 'feb', 'februari'] },
    { name: 'march', aliases: ['march', 'mar', 'murch'] },
    { name: 'april', aliases: ['april', 'apr'] },
    { name: 'may', aliases: ['may'] },
    { name: 'june', aliases: ['june', 'jun'] },
    { name: 'july', aliases: ['july', 'jul'] },
    { name: 'august', aliases: ['august', 'aug'] },
    { name: 'september', aliases: ['september', 'sep', 'sept'] },
    { name: 'october', aliases: ['october', 'oct'] },
    { name: 'november', aliases: ['november', 'nov'] },
    { name: 'december', aliases: ['december', 'dec'] }
  ];

  const now = new Date();
  let targetMonth = now.getMonth();
  let targetYear = now.getFullYear();

  for (let idx = 0; idx < months.length; idx++) {
    const m = months[idx];
    if (m.aliases.some(alias => lower.includes(alias))) {
      targetMonth = idx;
      break;
    }
  }

  const start = new Date(targetYear, targetMonth, 1);
  const end = new Date(targetYear, targetMonth + 1, 0, 23, 59, 59);

  return {
    start: start.toISOString(),
    end: end.toISOString(),
    monthName: start.toLocaleString('en-IN', { month: 'long' }),
    year: targetYear
  };
}

// Get current week date range
function getWeekRange() {
  const now = new Date();
  const start = new Date(now);
  start.setDate(now.getDate() - now.getDay());
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  return { start: start.toISOString(), end: end.toISOString() };
}

// Format number as Indian currency
function formatINR(amount) {
  if (!amount) return '₹0';
  return '₹' + Number(amount).toLocaleString('en-IN');
}

/**
 * Applies role-scoped salesperson phone filters to a Supabase query builder.
 * - phones === null (Admin) -> unrestricted / company-wide
 * - phones.length === 0 (Sales Manager with 0 reps) -> impossible filter
 * - phones.length === 1 -> exact equality match
 * - phones.length > 1 -> in array match
 */
function applySalespersonFilter(query, phones, fieldName = 'salesperson_phone') {
  if (phones === null) {
    return query;
  }
  if (!phones || phones.length === 0) {
    return query.eq(fieldName, '__NO_ACCESSIBLE_REPS__');
  }
  if (phones.length === 1) {
    return query.eq(fieldName, phones[0]);
  }
  return query.in(fieldName, phones);
}

// ── QUERY HANDLERS ────────────────────────────────────────────────────────

async function getSalesThisMonth(scopeOrPhone, text = '') {
  try {
    const supabase = getSupabase();
    const { start, end, monthName, year } = getMonthRangeFromQuery(text);

    const scope = typeof scopeOrPhone === 'object' && scopeOrPhone !== null
      ? scopeOrPhone
      : await getAccessibleSalespersonPhonesForBot(scopeOrPhone);

    if (scope.isManager && (!scope.phones || scope.phones.length === 0)) {
      return `📊 *Team Sales Summary - ${monthName} ${year}*\n\n📋 No sales data found. You currently have no salespersons assigned to your team.`;
    }

    let query = supabase
      .from('deals')
      .select('*, deal_items(*)')
      .gte('created_at', start)
      .lte('created_at', end);

    query = applySalespersonFilter(query, scope.phones, 'salesperson_phone');

    const { data: deals, error } = await query;
    if (error) throw error;

    const totalDeals = deals?.length || 0;
    const wonDeals = deals?.filter(d => d.stage === 'won').length || 0;
    const totalAmount = deals?.reduce((sum, d) => sum + (Number(d.total_amount) || 0), 0) || 0;
    const totalItems = deals?.reduce((sum, d) => sum + (d.deal_items?.length || 0), 0) || 0;

    const title = scope.targetRepName
      ? `${scope.targetRepName}'s Sales Summary`
      : (scope.isAdmin ? 'Company Sales Summary' : (scope.isManager ? 'Team Sales Summary' : 'Sales Summary'));

    return `📊 *${title} - ${monthName} ${year}*\n\n` +
      `📋 Total Created Deals: ${totalDeals}\n` +
      `✅ Won: ${wonDeals}\n` +
      `📦 Total Line Items: ${totalItems}\n` +
      `💰 Total Value: ${formatINR(totalAmount)}\n\n` +
      `_Data from Enlight Sales OS_`;
  } catch (error) {
    console.error('getSalesThisMonth error:', error);
    return '❌ Could not fetch sales data. Please try again.';
  }
}

async function getPendingDeals(scopeOrPhone) {
  try {
    const supabase = getSupabase();
    const scope = typeof scopeOrPhone === 'object' && scopeOrPhone !== null
      ? scopeOrPhone
      : await getAccessibleSalespersonPhonesForBot(scopeOrPhone);

    if (scope.isManager && (!scope.phones || scope.phones.length === 0)) {
      return '✅ No pending deals found. You currently have no salespersons assigned to your team.';
    }

    let query = supabase
      .from('deals')
      .select('*')
      .not('stage', 'in', '("won","lost")')
      .order('created_at', { ascending: false })
      .limit(10);

    query = applySalespersonFilter(query, scope.phones, 'salesperson_phone');

    const { data: deals, error } = await query;
    if (error) throw error;

    if (!deals || deals.length === 0) {
      return '✅ No pending deals right now!';
    }

    const dealList = deals.map((d, i) => 
      `${i + 1}. ${d.customer_name || 'Unknown'}\n` +
      `   Stage: ${d.stage} | ${d.inquiry_type}\n` +
      `   ${d.total_amount ? formatINR(d.total_amount) : 'Amount TBD'}`
    ).join('\n\n');

    const title = scope.targetRepName
      ? `${scope.targetRepName}'s Pending Deals`
      : (scope.isAdmin ? 'Company Pending Deals' : (scope.isManager ? 'Team Pending Deals' : 'Pending Deals'));

    return `📋 *${title} (${deals.length})*\n\n${dealList}\n\n_Showing latest 10_`;
  } catch (error) {
    console.error('getPendingDeals error:', error);
    return '❌ Could not fetch pending deals.';
  }
}

async function getPendingInquiries(scopeOrPhone) {
  try {
    const supabase = getSupabase();
    const scope = typeof scopeOrPhone === 'object' && scopeOrPhone !== null
      ? scopeOrPhone
      : await getAccessibleSalespersonPhonesForBot(scopeOrPhone);

    if (scope.isManager && (!scope.phones || scope.phones.length === 0)) {
      return '✅ No inquiries pending review. You currently have no salespersons assigned to your team.';
    }

    let query = supabase
      .from('inquiries')
      .select('*')
      .eq('status', 'review')
      .order('created_at', { ascending: false })
      .limit(10);

    query = applySalespersonFilter(query, scope.phones, 'salesperson_phone');

    const { data: inquiries, error } = await query;
    if (error) throw error;

    if (!inquiries || inquiries.length === 0) {
      return '✅ No inquiries pending review!';
    }

    const list = inquiries.map((inq, i) =>
      `${i + 1}. ${inq.sender_name || inq.sender_phone}\n` +
      `   "${inq.raw_text?.substring(0, 50)}..."\n` +
      `   Confidence: ${Math.round((inq.overall_confidence || 0) * 100)}%`
    ).join('\n\n');

    const title = scope.targetRepName
      ? `${scope.targetRepName}'s Inquiries Needing Review`
      : (scope.isAdmin ? 'Company Inquiries Needing Review' : (scope.isManager ? 'Team Inquiries Needing Review' : 'Inquiries Needing Review'));

    return `⚠️ *${title} (${inquiries.length})*\n\n${list}`;
  } catch (error) {
    console.error('getPendingInquiries error:', error);
    return '❌ Could not fetch inquiries.';
  }
}

async function getDealsThisWeek(scopeOrPhone) {
  try {
    const supabase = getSupabase();
    const { start, end } = getWeekRange();
    const scope = typeof scopeOrPhone === 'object' && scopeOrPhone !== null
      ? scopeOrPhone
      : await getAccessibleSalespersonPhonesForBot(scopeOrPhone);

    if (scope.isManager && (!scope.phones || scope.phones.length === 0)) {
      return '📋 No deals logged this week. You currently have no salespersons assigned to your team.';
    }

    let query = supabase
      .from('deals')
      .select('*, deal_items(*)')
      .gte('created_at', start)
      .lte('created_at', end)
      .order('created_at', { ascending: false });

    query = applySalespersonFilter(query, scope.phones, 'salesperson_phone');

    const { data: deals, error } = await query;
    if (error) throw error;

    if (!deals || deals.length === 0) {
      return '📋 No deals logged this week yet.';
    }

    const totalAmount = deals.reduce((sum, d) => sum + (d.total_amount || 0), 0);
    const list = deals.map((d, i) =>
      `${i + 1}. ${d.customer_name || 'Unknown'} - ${d.inquiry_type}\n` +
      `   ${d.deal_items?.length || 0} items | ${formatINR(d.total_amount)}`
    ).join('\n\n');

    const title = scope.targetRepName
      ? `${scope.targetRepName}'s Deals This Week`
      : (scope.isAdmin ? "Company This Week's Deals" : (scope.isManager ? "Team This Week's Deals" : "This Week's Deals"));

    return `📊 *${title} (${deals.length})*\n\n${list}\n\n` +
      `💰 *Total: ${formatINR(totalAmount)}*`;
  } catch (error) {
    console.error('getDealsThisWeek error:', error);
    return '❌ Could not fetch this week deals.';
  }
}

async function getKRAStatus(scopeOrPhone, text = '') {
  try {
    const supabase = getSupabase();
    const { start, end, monthName, year } = getMonthRangeFromQuery(text);
    const scope = typeof scopeOrPhone === 'object' && scopeOrPhone !== null
      ? scopeOrPhone
      : await getAccessibleSalespersonPhonesForBot(scopeOrPhone);

    if (scope.isManager && (!scope.phones || scope.phones.length === 0)) {
      return `🎯 *Team KRA Status - ${monthName} ${year}*\n\n📋 You currently have no salespersons assigned to your team. Contact an administrator to assign sales team members.`;
    }

    let dealsQuery = supabase
      .from('deals')
      .select('*, deal_items(*)')
      .gte('created_at', start)
      .lte('created_at', end);
    dealsQuery = applySalespersonFilter(dealsQuery, scope.phones, 'salesperson_phone');

    let inqQuery = supabase
      .from('inquiries')
      .select('*')
      .gte('created_at', start)
      .lte('created_at', end);
    inqQuery = applySalespersonFilter(inqQuery, scope.phones, 'salesperson_phone');

    const resolvedMonth = new Date(start).getMonth() + 1;
    const resolvedYear  = new Date(start).getFullYear();

    let kra2Query = supabase
      .from('kra_logs')
      .select('id')
      .eq('kra_number', 2)
      .eq('kra_type', 'new_customer')
      .eq('month', resolvedMonth)
      .eq('year', resolvedYear);
    kra2Query = applySalespersonFilter(kra2Query, scope.phones, 'salesperson_phone');

    const [dealsRes, inqRes, kra2Res] = await Promise.all([
      dealsQuery,
      inqQuery,
      kra2Query
    ]);

    const deals = dealsRes.data || [];
    const inquiries = inqRes.data || [];
    const kra2Logs = kra2Res.data || [];

    const totalDeals = deals.length;
    const wonDeals = deals.filter(d => d.stage === 'won') || [];
    const wonCount = wonDeals.length;
    const wonValue = wonDeals.reduce((sum, d) => sum + (Number(d.total_amount) || 0), 0);

    const totalInquiries = inquiries.length;
    const conversionRate = totalInquiries > 0 
      ? Math.round((wonCount / totalInquiries) * 100) 
      : 0;

    const newCustomersCount = kra2Logs.length;
    const title = scope.targetRepName
      ? `${scope.targetRepName}'s KRA Status`
      : (scope.isAdmin ? 'Company KRA Status' : (scope.isManager ? 'Team KRA Status' : 'KRA Status'));

    return `🎯 *${title} - ${monthName} ${year}*\n\n` +
      `📋 *KRA 1 - Sales Achievement*\n` +
      `   Won Deals: ${wonCount} | Value: ${formatINR(wonValue)} (Total Created: ${totalDeals})\n\n` +
      `👥 *KRA 2 - New Customers*\n` +
      `   POs received: ${newCustomersCount} (target: 3)\n\n` +
      `🔄 *KRA 4 - Enquiry Conversion*\n` +
      `   Inquiries: ${totalInquiries} | Won: ${wonCount}\n` +
      `   Rate: ${conversionRate}% (target: 70-80%)\n\n` +
      `📊 *KRA 6 - CRM Compliance*\n` +
      `   Logged today via WhatsApp bot ✅\n\n` +
      `_Full KRA report available on Portal_`;
  } catch (error) {
    console.error('getKRAStatus error:', error);
    return '❌ Could not fetch KRA status.';
  }
}

/** Won customer names + product + qty breakdown */
async function getWonCustomers(scopeOrPhone, text = '') {
  try {
    const supabase = getSupabase();
    const { start, end, monthName, year } = getMonthRangeFromQuery(text);
    const scope = typeof scopeOrPhone === 'object' && scopeOrPhone !== null
      ? scopeOrPhone
      : await getAccessibleSalespersonPhonesForBot(scopeOrPhone);

    if (scope.isManager && (!scope.phones || scope.phones.length === 0)) {
      return `📋 No won deals found for ${monthName} ${year}. You currently have no salespersons assigned to your team.`;
    }

    let query = supabase
      .from('deals')
      .select('*, deal_items(*)')
      .eq('stage', 'won')
      .gte('created_at', start)
      .lte('created_at', end);
    query = applySalespersonFilter(query, scope.phones, 'salesperson_phone');

    const { data: deals } = await query;

    if (!deals || deals.length === 0) {
      return `📋 No won deals found for ${monthName} ${year}.`;
    }

    let srNo = 1;
    const lines = [];
    for (const deal of deals) {
      const items = deal.deal_items || [];
      if (items.length === 0) {
        lines.push(`${srNo++}. *${deal.customer_name}* — Amount: ${formatINR(deal.total_amount)}`);
      } else {
        for (const item of items) {
          lines.push(`${srNo++}. *${deal.customer_name}*\n   Product: ${item.sku_text || 'N/A'}\n   Qty: ${item.quantity || 0} ${item.unit || 'MT'} | Rate: ${formatINR(item.rate)} | Amt: ${formatINR(item.amount)}`);
        }
      }
    }

    const totalValue = deals.reduce((s, d) => s + (Number(d.total_amount) || 0), 0);
    const title = scope.targetRepName
      ? `${scope.targetRepName}'s Won Customers`
      : (scope.isAdmin ? 'Company Won Customers' : (scope.isManager ? 'Team Won Customers' : 'Won Customers'));

    return `🏆 *${title} — ${monthName} ${year}* (${deals.length} deals)\n\n` +
      lines.join('\n\n') +
      `\n\n💰 *Total Won Value: ${formatINR(totalValue)}*`;
  } catch (err) {
    console.error('getWonCustomers error:', err.message);
    return '❌ Could not fetch won customers.';
  }
}

/** Active deals with full stage + items detail */
async function getActiveDealsDetail(scopeOrPhone) {
  try {
    const supabase = getSupabase();
    const scope = typeof scopeOrPhone === 'object' && scopeOrPhone !== null
      ? scopeOrPhone
      : await getAccessibleSalespersonPhonesForBot(scopeOrPhone);

    if (scope.isManager && (!scope.phones || scope.phones.length === 0)) {
      return '✅ No active deals in pipeline. You currently have no salespersons assigned to your team.';
    }

    let query = supabase
      .from('deals')
      .select('*, deal_items(*)')
      .not('stage', 'in', '("won","lost")')
      .order('created_at', { ascending: false })
      .limit(15);
    query = applySalespersonFilter(query, scope.phones, 'salesperson_phone');

    const { data: deals } = await query;

    if (!deals || deals.length === 0) {
      return '✅ No active deals in pipeline right now.';
    }

    const lines = deals.map((d, i) => {
      const items = (d.deal_items || []).map(it => `     • ${it.sku_text || 'Item'}: ${it.quantity} ${it.unit}`).join('\n');
      return `${i + 1}. *${d.customer_name}* [${d.stage}]\n${items || '     (no items yet)'}\n   💰 ${d.total_amount > 0 ? formatINR(d.total_amount) : 'TBD'}`;
    });

    const title = scope.targetRepName
      ? `${scope.targetRepName}'s Active Pipeline Deals`
      : (scope.isAdmin ? 'Company Active Pipeline Deals' : (scope.isManager ? 'Team Active Pipeline Deals' : 'Active Pipeline Deals'));

    return `📋 *${title} (${deals.length})*\n\n` + lines.join('\n\n');
  } catch (err) {
    console.error('getActiveDealsDetail error:', err.message);
    return '❌ Could not fetch active deals.';
  }
}

/** Full registered customer list */
async function getCustomerList(scopeOrPhone) {
  try {
    const supabase = getSupabase();
    const scope = typeof scopeOrPhone === 'object' && scopeOrPhone !== null
      ? scopeOrPhone
      : await getAccessibleSalespersonPhonesForBot(scopeOrPhone);

    if (scope.isManager && (!scope.phones || scope.phones.length === 0)) {
      return '👥 No customers registered under your assigned sales team yet.';
    }

    let query = supabase
      .from('recurring_customers')
      .select('customer_name, contact_person, customer_address, customer_phone, customer_gst')
      .eq('is_active', true)
      .order('customer_name', { ascending: true })
      .limit(20);
    query = applySalespersonFilter(query, scope.phones, 'assigned_salesperson_phone');

    const { data: customers } = await query;

    if (!customers || customers.length === 0) {
      return scope.isManager
        ? '👥 No customers registered under your assigned sales team yet.'
        : '📋 No customers registered under your account yet.';
    }

    const lines = customers.map((c, i) =>
      `${i + 1}. *${c.customer_name}*\n` +
      `   👤 ${c.contact_person || 'N/A'} | 📍 ${c.customer_address || 'N/A'} | 📱 ${c.customer_phone || 'N/A'}` +
      (c.customer_gst ? `\n   🧾 GST: ${c.customer_gst}` : '')
    );

    const title = scope.targetRepName
      ? `${scope.targetRepName}'s Customer List`
      : (scope.isAdmin ? 'Company Customer List' : (scope.isManager ? 'Team Customer List' : 'Your Customer List'));

    return `👥 *${title} (${customers.length})*\n\n` + lines.join('\n\n');
  } catch (err) {
    console.error('getCustomerList error:', err.message);
    return '❌ Could not fetch customer list.';
  }
}

/** Active rate sheet from DB */
async function getRateSheet() {
  try {
    const { getLatestActiveRatesText } = require('./gemini');
    const rates = await getLatestActiveRatesText();
    if (!rates) return '❌ No active rate sheet found. Please contact your Sales Lead.';
    const now = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full' });
    return `💹 *Active Metal Rate Sheet*\n📅 ${now}\n\n${rates}\n\n_Rates managed by Admin via Enlight Sales OS_`;
  } catch (err) {
    console.error('getRateSheet error:', err.message);
    return '❌ Could not fetch rate sheet.';
  }
}

/** Customer visits list */
async function getVisitList(scopeOrPhone, text = '') {
  try {
    const supabase = getSupabase();
    const { start, end, monthName, year } = getMonthRangeFromQuery(text);
    const scope = typeof scopeOrPhone === 'object' && scopeOrPhone !== null
      ? scopeOrPhone
      : await getAccessibleSalespersonPhonesForBot(scopeOrPhone);

    if (scope.isManager && (!scope.phones || scope.phones.length === 0)) {
      return `📍 No visits logged for ${monthName} ${year}. You currently have no salespersons assigned to your team.`;
    }

    let query = supabase
      .from('customer_visits')
      .select('*')
      .gte('visit_date', start)
      .lte('visit_date', end)
      .order('visit_date', { ascending: false });
    query = applySalespersonFilter(query, scope.phones, 'salesperson_phone');

    const { data: visits } = await query;

    if (!visits || visits.length === 0) {
      return `📍 No visits logged for ${monthName} ${year}.`;
    }

    const lines = visits.map((v, i) =>
      `${i + 1}. *${v.customer_name}*\n   📅 ${new Date(v.visit_date).toLocaleDateString('en-IN')}\n   📝 ${v.notes || 'No notes'}`
    );

    const title = scope.targetRepName
      ? `${scope.targetRepName}'s Customer Visits`
      : (scope.isAdmin ? 'Company Customer Visits' : (scope.isManager ? 'Team Customer Visits' : 'Customer Visits'));

    return `📍 *${title} — ${monthName} ${year}* (${visits.length})\n\n` + lines.join('\n\n');
  } catch (err) {
    console.error('getVisitList error:', err.message);
    return '❌ Could not fetch visit list.';
  }
}

async function getVisitSummary(scopeOrPhone, text = '') {
  try {
    const supabase = getSupabase();
    const { start, end, monthName, year } = getMonthRangeFromQuery(text);
    const scope = typeof scopeOrPhone === 'object' && scopeOrPhone !== null
      ? scopeOrPhone
      : await getAccessibleSalespersonPhonesForBot(scopeOrPhone);

    if (scope.isManager && (!scope.phones || scope.phones.length === 0)) {
      return `📊 *KRA 9 Team Visits - ${monthName} ${year}*\n\nNo visits logged. You currently have no salespersons assigned to your team.`;
    }

    let query = supabase
      .from('customer_visits')
      .select('*')
      .gte('visited_at', start)
      .lte('visited_at', end)
      .order('visited_at', { ascending: false });
    query = applySalespersonFilter(query, scope.phones, 'salesperson_phone');

    const { data: visits } = await query;

    if (!visits || visits.length === 0) {
      return `📊 *KRA 9 - ${monthName} ${year}*\n\nNo visits logged this month yet.\n\nLog a visit:\n"visited ABC Fabricators today, met Rahul, discussed pricing"`;
    }

    const visitList = visits.slice(0, 5).map((v, i) =>
      `${i + 1}. ${v.customer_name || 'Unknown'} - ${new Date(v.visited_at).toLocaleDateString('en-IN')}`
    ).join('\n');

    const title = scope.targetRepName
      ? `${scope.targetRepName}'s KRA 9 Visits`
      : (scope.isAdmin ? 'Company KRA 9' : (scope.isManager ? 'Team KRA 9' : 'KRA 9'));

    return `📊 *${title} - ${monthName} ${year}*\n\n` +
      `Total visits: ${visits.length}\n\n` +
      `Recent visits:\n${visitList}\n\n` +
      `_Target: 10 visits/week, 3 field days/week_`;
  } catch (error) {
    console.error('getVisitSummary error:', error);
    return '❌ Could not fetch visit summary.';
  }
}

/** Payment aging / outstanding list */
async function getPaymentAging(scopeOrPhone) {
  try {
    const supabase = getSupabase();
    const scope = typeof scopeOrPhone === 'object' && scopeOrPhone !== null
      ? scopeOrPhone
      : await getAccessibleSalespersonPhonesForBot(scopeOrPhone);

    if (scope.isManager && (!scope.phones || scope.phones.length === 0)) {
      return '💰 No outstanding payments found. You currently have no salespersons assigned to your team.';
    }

    let dealsQuery = supabase
      .from('deals')
      .select('customer_name, total_amount, payment_terms, created_at, status')
      .eq('stage', 'won')
      .not('status', 'eq', 'payment_collected')
      .order('created_at', { ascending: true })
      .limit(15);
    dealsQuery = applySalespersonFilter(dealsQuery, scope.phones, 'salesperson_phone');

    let ptQuery = supabase
      .from('payment_tracking')
      .select('customer_name, invoice_amount, outstanding, due_date, status')
      .neq('status', 'collected')
      .order('due_date', { ascending: true })
      .limit(15);
    ptQuery = applySalespersonFilter(ptQuery, scope.phones, 'salesperson_phone');

    const [{ data: deals }, { data: ptRecords }] = await Promise.all([dealsQuery, ptQuery]);
    const today = new Date();
    let rows = [];

    if (ptRecords && ptRecords.length > 0) {
      rows = ptRecords.map((p, i) => {
        let dueDisplay = 'Due date TBD';
        let overdueStr = '';
        if (p.due_date) {
          const due = new Date(p.due_date);
          if (due.getFullYear() > 1980) {
            const daysLeft = Math.ceil((due - today) / (1000 * 60 * 60 * 24));
            const overdue = daysLeft < 0;
            dueDisplay = due.toLocaleDateString('en-IN');
            overdueStr = overdue
              ? ` ⚠️ (${Math.abs(daysLeft)}d overdue)`
              : ` (${daysLeft}d left)`;
          }
        }
        const outstanding = Number(p.outstanding) || Number(p.invoice_amount) || 0;
        return `${i + 1}. *${p.customer_name}*\n` +
          `   Outstanding: ${formatINR(outstanding)}\n` +
          `   Due: ${dueDisplay}${overdueStr}`;
      });

      const totalOutstanding = ptRecords.reduce((s, p) => s + (Number(p.outstanding) || Number(p.invoice_amount) || 0), 0);
      const title = scope.targetRepName
        ? `${scope.targetRepName}'s Outstanding Payments`
        : (scope.isAdmin ? 'Company Outstanding Payments' : (scope.isManager ? 'Team Outstanding Payments' : 'Outstanding Payments'));

      return `💰 *${title} (${ptRecords.length})*\n\n` +
        rows.join('\n\n') +
        `\n\n📊 *Total Outstanding: ${formatINR(totalOutstanding)}*`;
    }

    if (!deals || deals.length === 0) {
      return '✅ No outstanding payments! All collections up to date.';
    }

    rows = deals.map((d, i) => {
      let dueDisplay = 'Due date TBD';
      let overdueStr = '';
      if (d.payment_terms && d.created_at) {
        const termDays = parseInt((d.payment_terms.match(/\d+/) || ['30'])[0]);
        const due = new Date(d.created_at);
        due.setDate(due.getDate() + termDays);
        const daysLeft = Math.ceil((due - today) / (1000 * 60 * 60 * 24));
        const overdue = daysLeft < 0;
        dueDisplay = due.toLocaleDateString('en-IN');
        overdueStr = overdue
          ? ` ⚠️ (${Math.abs(daysLeft)}d overdue)`
          : ` (${daysLeft}d left)`;
      }
      return `${i + 1}. *${d.customer_name}*\n` +
        `   Amount: ${formatINR(d.total_amount)}\n` +
        `   Due: ${dueDisplay}${overdueStr}`;
    });

    const totalOutstanding = deals.reduce((s, d) => s + (Number(d.total_amount) || 0), 0);
    const title = scope.targetRepName
      ? `${scope.targetRepName}'s Outstanding Payments`
      : (scope.isAdmin ? 'Company Outstanding Payments' : (scope.isManager ? 'Team Outstanding Payments' : 'Outstanding Payments'));

    return `💰 *${title} (${deals.length})*\n\n` +
      rows.join('\n\n') +
      `\n\n📊 *Total Outstanding: ${formatINR(totalOutstanding)}*`;
  } catch (err) {
    console.error('getPaymentAging error:', err.message);
    return '❌ Could not fetch payment aging.';
  }
}

/** Lost deals breakdown with reasons */
async function getLostDeals(scopeOrPhone, text = '') {
  try {
    const supabase = getSupabase();
    const { start, end, monthName, year } = getMonthRangeFromQuery(text);
    const scope = typeof scopeOrPhone === 'object' && scopeOrPhone !== null
      ? scopeOrPhone
      : await getAccessibleSalespersonPhonesForBot(scopeOrPhone);

    if (scope.isManager && (!scope.phones || scope.phones.length === 0)) {
      return `✅ No lost deals found in ${monthName} ${year}. You currently have no salespersons assigned to your team.`;
    }

    let query = supabase
      .from('deals')
      .select('customer_name, total_amount, lost_reason, created_at')
      .eq('stage', 'lost')
      .gte('created_at', start)
      .lte('created_at', end)
      .order('created_at', { ascending: false });
    query = applySalespersonFilter(query, scope.phones, 'salesperson_phone');

    const { data: deals } = await query;

    if (!deals || deals.length === 0) {
      return `✅ No lost deals in ${monthName} ${year}.`;
    }

    const lines = deals.map((d, i) =>
      `${i + 1}. *${d.customer_name}*\n   Amount: ${formatINR(d.total_amount)}\n   Reason: ${d.lost_reason || 'Not specified'}`
    );

    const totalLost = deals.reduce((s, d) => s + (Number(d.total_amount) || 0), 0);
    const title = scope.targetRepName
      ? `${scope.targetRepName}'s Lost Deals`
      : (scope.isAdmin ? 'Company Lost Deals' : (scope.isManager ? 'Team Lost Deals' : 'Lost Deals'));

    return `❌ *${title} — ${monthName} ${year}* (${deals.length})\n\n` +
      lines.join('\n\n') +
      `\n\n📉 *Total Lost Value: ${formatINR(totalLost)}*`;
  } catch (err) {
    console.error('getLostDeals error:', err.message);
    return '❌ Could not fetch lost deals.';
  }
}

// Shared category → handler router (used by both admin, manager, and salesperson paths)
async function routeToHandler(category, text, scope, supabase) {
  switch (category) {
    case 'dashboard_link': {
      const dashboardUrl = process.env.DASHBOARD_URL || 'https://enlight-sales-frontend.vercel.app';
      return `🔗 *Enlight Sales OS Portal*\n\n👉 ${dashboardUrl}\n\nEnter your registered WhatsApp number to log in.`;
    }
    case 'sales_summary':
      return await getSalesThisMonth(scope, text);
    case 'kra_status':
      return await getKRAStatus(scope, text);
    case 'visit_summary':
      return await getVisitSummary(scope, text);
    case 'payment_summary':
      return await getPaymentSummary(scope);
    case 'complaint_summary':
      return await getComplaintSummary(scope);
    case 'full_report':
      return await generateFullKRAReport(scope, getMonthRangeFromQuery(text));
    case 'deals_this_week':
      return await getDealsThisWeek(scope);
    case 'pending_deals':
      return await getPendingDeals(scope);
    case 'pending_inquiries':
      return await getPendingInquiries(scope);
    case 'new_customers_summary':
      return await getNewCustomerSummary(scope);
    case 'won_customers':
      return await getWonCustomers(scope, text);
    case 'active_deals_detail':
      return await getActiveDealsDetail(scope);
    case 'customer_list':
      return await getCustomerList(scope);
    case 'rate_sheet':
      return await getRateSheet();
    case 'visit_list':
      return await getVisitList(scope, text);
    case 'payment_aging':
      return await getPaymentAging(scope);
    case 'lost_deals':
      return await getLostDeals(scope, text);
    default:
      return null;
  }
}

// Main query router with strict RBAC:
// - Admin: can view all data or query any salesperson/manager by name
// - Sales Manager: can view only their assigned salespersons' data; unauthorized to view other salespersons
// - Salesperson: can view only their own data
async function handleQuery(text, senderPhone) {
  const lower = text.toLowerCase();
  const supabase = getSupabase();

  // 1. Resolve role and access scope for sender
  const userScope = await getAccessibleSalespersonPhonesForBot(senderPhone);
  let effectiveScope = { ...userScope };

  // 2. Fetch all employees to check if query mentions a salesperson by name
  let targetSalespersonName = null;
  try {
    const { classifyQueryType } = require('./gemini');
    const classification = await classifyQueryType(text);
    if (classification && classification.target_salesperson) {
      targetSalespersonName = classification.target_salesperson;
    }
  } catch (err) {
    // semantic classifier fallback
  }

  // Also check direct text for other salesperson names if semantic classifier missed it
  const { data: allEmployees } = await supabase
    .from('employees')
    .select('*')
    .eq('is_active', true);

  const matchedEmp = (allEmployees || []).find((emp) => {
    if (!emp.name) return false;
    const empNameLower = emp.name.toLowerCase().trim();
    if (targetSalespersonName && targetSalespersonName.toLowerCase().includes(empNameLower)) return true;
    if (lower.includes(empNameLower)) return true;
    const parts = empNameLower.split(/\s+/);
    return parts.some(part => part.length > 3 && lower.includes(part));
  });

  // 3. Security Guardrails & Cross-Salesperson Access Control
  if (matchedEmp) {
    const isSelf = matchedEmp.phone === senderPhone;

    if (!isSelf) {
      if (userScope.role === 'salesperson') {
        // Salesperson asking about another salesperson -> BLOCK
        return `⚠️ *Access Denied*\n\nYou are not authorized to view the performance or details of other salespeople. You can only query your own performance reports.`;
      }

      if (userScope.isManager) {
        // Sales Manager asking about a salesperson: check if salesperson is in assigned team
        const isAssigned = (userScope.assignedSalespersons || []).some(
          (a) => a.id === matchedEmp.id || a.phone === matchedEmp.phone
        );

        if (!isAssigned) {
          return `⚠️ *Access Denied*\n\nSalesperson *${matchedEmp.name}* is not assigned to your team. You can only view data for salespersons assigned under your management.`;
        }

        // Assigned -> allow and scope query to this specific rep
        effectiveScope = {
          ...userScope,
          phones: [matchedEmp.phone],
          targetRepName: matchedEmp.name,
        };
      }

      if (userScope.isAdmin) {
        // Admin asking about a specific salesperson -> ALLOW
        effectiveScope = {
          ...userScope,
          phones: [matchedEmp.phone],
          targetRepName: matchedEmp.name,
        };
      }
    }
  }

  // 4. Semantic Router
  try {
    const { classifyQueryType } = require('./gemini');
    const classification = await classifyQueryType(text);

    if (classification && classification.confidence >= 0.70) {
      if (classification.category === 'blocked') {
        const dashboardUrl = process.env.DASHBOARD_URL || 'https://enlight-sales-frontend.vercel.app';
        if (userScope.isAdmin) {
          return `🔗 *This action requires Dashboard access.*\n\n` +
            `Admin operations like rate sheet management, pricing configuration, product analysis, and CRM admin tasks are available directly on the portal:\n\n` +
            `👉 ${dashboardUrl}\n\n` +
            `Log in with your admin credentials to proceed.`;
        }
        return `⚠️ *Query Not Supported*\n\nThis type of request is outside the bot's scope.\n\nI can only answer queries related to deals, customers, payments, visits, KRA performance, and steel rates.`;
      }
      if (classification.category !== 'general') {
        return await routeToHandler(classification.category, text, effectiveScope, supabase);
      }
    }
  } catch (err) {
    console.error('Semantic router error:', err.message);
  }

  // 5. Keyword fallback (backup for low-confidence semantic router)
  // Full KRA report
  if (lower.includes('full report') || lower.includes('monthly report') || lower.includes('report card') || (lower.includes('report') && lower.includes('kra'))) {
    return await generateFullKRAReport(effectiveScope, getMonthRangeFromQuery(text));
  }
  // KRA / performance
  if (lower.includes('kra') || lower.includes('target') || lower.includes('performance') ||
      lower.includes('performace') || lower.includes('achievement')) {
    return await getKRAStatus(effectiveScope, text);
  }
  // Sales summary
  if (lower.includes('sales') || lower.includes('this month') || lower.includes('is mahine')) {
    return await getSalesThisMonth(effectiveScope, text);
  }
  // Deals this week
  if (lower.includes('this week') || lower.includes('is hafte') || lower.includes('week deals')) {
    return await getDealsThisWeek(effectiveScope);
  }
  // Pending deals
  if (lower.includes('pending deal') || lower.includes('open deal') || lower.includes('pipeline')) {
    return await getPendingDeals(effectiveScope);
  }
  // Pending inquiries / review queue
  if (lower.includes('inquiry') || lower.includes('inquiries') || lower.includes('enquiry') || lower.includes('review queue')) {
    return await getPendingInquiries(effectiveScope);
  }
  // Won customers
  if (lower.includes('won') && (lower.includes('customer') || lower.includes('deal'))) {
    return await getWonCustomers(effectiveScope, text);
  }
  // Lost deals
  if (lower.includes('lost') || lower.includes('rejected deal')) {
    return await getLostDeals(effectiveScope, text);
  }
  // Active deals
  if ((lower.includes('active') || lower.includes('current') || lower.includes('my deals') || lower.includes('team deals')) && lower.includes('deal')) {
    return await getActiveDealsDetail(effectiveScope);
  }
  // Customer list
  if (lower.includes('customer list') || lower.includes('my customers') || lower.includes('team customers') || lower.includes('client list')) {
    return await getCustomerList(effectiveScope);
  }
  // Rate sheet
  if (lower.includes('rate') || lower.includes('bhav') || lower.includes('price list')) {
    return await getRateSheet();
  }
  // Visit list
  if (lower.includes('visit') || lower.includes('visited') || lower.includes('field visit')) {
    return await getVisitList(effectiveScope, text);
  }
  // Outstanding / payment aging (must come before generic 'payment')
  if (lower.includes('outstanding') || lower.includes('overdue') || lower.includes('baaki') ||
      lower.includes('due') || lower.includes('aging') || lower.includes('hasn') || lower.includes('nahi diya')) {
    return await getPaymentAging(effectiveScope);
  }
  // Payment summary (KRA 5 totals)
  if (lower.includes('payment') || lower.includes('collection')) {
    return await getPaymentSummary(effectiveScope);
  }
  // Complaints
  if (lower.includes('complaint') || lower.includes('shikayat')) {
    return await getComplaintSummary(effectiveScope);
  }
  // New customers KRA 2
  if (lower.includes('new customer') || lower.includes('kra 2')) {
    return await getNewCustomerSummary(effectiveScope);
  }
  // Dashboard link
  if (lower.includes('link') || lower.includes('login') || lower.includes('portal')) {
    const dashboardUrl = process.env.DASHBOARD_URL || 'https://enlight-sales-frontend.vercel.app';
    return `🔗 *Enlight Sales OS Portal*\n\n👉 ${dashboardUrl}\n\nEnter your registered WhatsApp number to log in.`;
  }

  // 6. Final fallback: route to conversational assistant
  return await handleConversationalQuery(text, senderPhone);
}

module.exports = { isQuery, handleQuery, getVisitSummary };
