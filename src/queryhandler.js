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

// Detect if message is a query or an operational action
function isQuery(text) {
  if (!text || typeof text !== 'string') return false;
  const lowerText = text.toLowerCase().trim();

  // 1. If it looks like a steel order/inquiry (e.g. contains quantity and units or pricing request), it is NOT a chatbot query!
  const hasInquiryPatterns = 
    /\b\d+\s*(mt|kg|ton|pcs|sheet|coil|bar|flat|plate|mm|mtr)\b/i.test(lowerText) || 
    lowerText.includes('rate is') || 
    lowerText.includes('price is') ||
    lowerText.includes('target rate') ||
    /\b\d+\s*x\s*\d+/i.test(lowerText);
    
  if (hasInquiryPatterns) {
    return false;
  }

  // 2. Operational action logging patterns (visits, payments, complaints, onboarding, deal updates)
  const isActionLogging = 
    /\b(visited|met with|went to|meeting at|market visit|site visit)\b/i.test(lowerText) ||
    /\b(received payment|paid rs|paid inr|received advance|collected payment|advance of|payment received|neft done|upi done|cheque received)\b/i.test(lowerText) ||
    /\b(complaint about|defective material|damaged material|rejected material|material rejection|rust issue|quality complaint)\b/i.test(lowerText) ||
    /\b(new customer|add customer|onboard customer|register customer)\b/i.test(lowerText);

  const isExplicitQuery = 
    /\b(my visits|who did i visit|visit log|show visits|visit summary)\b/i.test(lowerText) ||
    /\b(pending payment|who hasn|overdue|payment aging|outstanding)\b/i.test(lowerText) ||
    /\b(complaint status|show complaints|complaint summary)\b/i.test(lowerText) ||
    /\b(customer list|my customers|which customers)\b/i.test(lowerText);

  if (isActionLogging && !isExplicitQuery) {
    return false;
  }

  const queryKeywords = [
    // 7 RBAC Tools queries
    'open deals', 'pending deals', 'my deals', 'meri deals', 'deals', 'pipeline',
    'customer 360', 'customer360', 'tell me about', 'profile of', 'about customer',
    'reorder queue', 'reorder', 'due for reorder', 'reorders',
    'knowledge base', 'sop', 'policy', 'guideline', 'guidelines', 'moq', 'minimum order',
    'quotation validity', 'discount slab', 'discount policy', 'approval matrix',
    'team pipeline', 'team sales', 'subordinates',
    'churn radar', 'churn risk', 'at risk', 'churn',
    'loss analytics', 'lost deals', 'why did we lose', 'loss reason', 'rejected deals',

    // Sales queries
    'my sales', 'meri sales', 'kitni sales', 'sales this month',
    'is mahine', 'this month', 'last month', 'pichle mahine',
    'deals this week', 'is hafte', 'active deals', 'current deals', 'won deals', 'won customers',
    'team sales', 'all sales', 'company sales', 'total sales',
    'pending deals', 'open deals', 'meri deals', 'team deals', 'my deals', 'lost deals', 'rejected deals',

    // Customer & Contact queries
    'customer list', 'which customers', 'kaun se customer',
    'not ordered', 'order nahi', 'inactive customers',
    'my customers', 'all customers', 'team customers', 'client list', 'client directory',
    'contact details', 'contact info', 'phone number', 'gst number', 'customer details',

    // Payment queries
    'outstanding', 'overdue', 'due payment',
    'pending payment', 'baaki payment', 'baaki list',
    'who hasn\'t paid', 'who hasnt paid', 'payment aging', 'collection due',

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

    // General / Command phrases & Conversational triggers
    'monthly report', 'sales report', 'status report', 'show me sales',
    'my reports', 'my report', 'all reports', 'show reports', 'report card',
    'report', 'reports', 'dashboard', 'login', 'link', 'website', 'portal', 'url',
    'new customers', 'onboarded customers', 'kra 2',
    'date', 'time', 'today', 'aaj', 'din', 'tarikh', 'time kya',
    'what is', 'tell me', 'help', 'how to', 'bot', 'give me', 'show me', 'list',
    'assistant', 'hello', 'hi', 'hey', 'namaste', 'joke', 'who are you', 'kaise ho', '?'
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

    // Match Dashboard logic: includes deals created in month OR won in month
    let query = supabase
      .from('deals')
      .select('*, deal_items(*)')
      .or(`and(created_at.gte.${start},created_at.lte.${end}),and(stage.eq.won,won_at.gte.${start},won_at.lte.${end})`);

    query = applySalespersonFilter(query, scope.phones, 'salesperson_phone');

    const { data: deals, error } = await query;
    if (error) throw error;

    const allDeals = deals || [];
    const wonDealsList = allDeals.filter(d => d.stage === 'won');
    const wonDealsCount = wonDealsList.length;
    const wonRevenue = wonDealsList.reduce((sum, d) => sum + (Number(d.total_amount) || 0), 0);
    const wonTonnage = wonDealsList.reduce((sum, d) => {
      const items = d.deal_items || [];
      return sum + items.reduce((iSum, it) => iSum + (Number(it.quantity) || 0), 0);
    }, 0);

    const totalCreatedDeals = allDeals.length;
    const totalPipelineValue = allDeals.reduce((sum, d) => sum + (Number(d.total_amount) || 0), 0);

    const title = scope.targetRepName
      ? `${scope.targetRepName}'s Sales Summary`
      : (scope.isAdmin ? 'Company Sales Summary' : (scope.isManager ? 'Team Sales Summary' : 'Sales Summary'));

    return `📊 *${title} - ${monthName} ${year}*\n\n` +
      `🏆 *Won Sales Achievement:*\n` +
      `• Won Revenue: *${formatINR(wonRevenue)}*\n` +
      `• Won Orders: *${wonDealsCount}*\n` +
      (wonTonnage > 0 ? `• Delivered Volume: *${wonTonnage.toLocaleString('en-IN')} MT*\n` : '') +
      `\n📋 *Pipeline Activity:*\n` +
      `• Deals Created: ${totalCreatedDeals}\n` +
      `• Total Pipeline Value: ${formatINR(totalPipelineValue)}\n\n` +
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
      .or(`and(created_at.gte.${start},created_at.lte.${end}),and(stage.eq.won,won_at.gte.${start},won_at.lte.${end})`);
    dealsQuery = applySalespersonFilter(dealsQuery, scope.phones, 'salesperson_phone');

    let inqQuery = supabase
      .from('inquiries')
      .select('*')
      .gte('created_at', start)
      .lte('created_at', end);
    inqQuery = applySalespersonFilter(inqQuery, scope.phones, 'salesperson_phone');

    const resolvedMonth = new Date(start).getMonth() + 1;
    const resolvedYear  = new Date(start).getFullYear();

    let kraLogsQuery = supabase
      .from('kra_logs')
      .select('*')
      .gte('created_at', start)
      .lte('created_at', end);
    kraLogsQuery = applySalespersonFilter(kraLogsQuery, scope.phones, 'salesperson_phone');

    let visitsQuery = supabase
      .from('customer_visits')
      .select('*')
      .gte('visited_at', start)
      .lte('visited_at', end);
    visitsQuery = applySalespersonFilter(visitsQuery, scope.phones, 'salesperson_phone');

    let paymentsQuery = supabase
      .from('payment_tracking')
      .select('*');
    paymentsQuery = applySalespersonFilter(paymentsQuery, scope.phones, 'salesperson_phone');

    let recurringQuery = supabase
      .from('recurring_customers')
      .select('*')
      .eq('is_active', true);
    recurringQuery = applySalespersonFilter(recurringQuery, scope.phones, 'assigned_salesperson_phone');

    let complaintsQuery = supabase
      .from('complaints')
      .select('*')
      .gte('reported_at', start)
      .lte('reported_at', end);
    complaintsQuery = applySalespersonFilter(complaintsQuery, scope.phones, 'reported_by');

    const [dealsRes, inqRes, kraLogsRes, visitsRes, paymentsRes, recurringRes, complaintsRes] = await Promise.all([
      dealsQuery,
      inqQuery,
      kraLogsQuery,
      visitsQuery,
      paymentsQuery,
      recurringQuery,
      complaintsQuery
    ]);

    const deals = dealsRes.data || [];
    const inquiries = inqRes.data || [];
    const kraLogs = kraLogsRes.data || [];
    const visits = visitsRes.data || [];
    const payments = paymentsRes.data || [];
    const recurring = recurringRes.data || [];
    const complaints = complaintsRes.data || [];

    // KRA 1: Won deals, Revenue & Delivered Tonnage
    const dealsCreatedThisMonth = deals.filter(d => d.created_at >= start && d.created_at <= end);
    const wonDeals = deals.filter(d => {
      if (d.stage !== 'won') return false;
      const dealDate = d.won_at || d.created_at;
      return dealDate >= start && dealDate <= end;
    });
    const wonCount = wonDeals.length;
    const wonValue = wonDeals.reduce((sum, d) => sum + (Number(d.total_amount) || 0), 0);
    const wonTonnage = wonDeals.reduce((sum, d) => {
      const items = d.deal_items || [];
      return sum + items.reduce((iSum, it) => iSum + (Number(it.quantity) || 0), 0);
    }, 0);

    // KRA 2: New Customers Acquired (distinct customer names)
    const newCustomersCount = new Set(
      kraLogs
        .filter(l => l.kra_number === 2 && l.kra_type === 'new_customer')
        .map(l => (l.customer_name || '').toLowerCase().trim())
        .filter(Boolean)
    ).size;

    // KRA 3: Retention (distinct recurring customers who ordered)
    const uniqueRecurringWithOrder = new Set(
      deals
        .filter(d =>
          recurring.some(r =>
            r.customer_name?.toLowerCase().trim() === d.customer_name?.toLowerCase().trim() ||
            (d.customer_name && r.customer_name && (
              d.customer_name.toLowerCase().includes(r.customer_name.toLowerCase()) ||
              r.customer_name.toLowerCase().includes(d.customer_name.toLowerCase())
            ))
          )
        )
        .map(d => d.customer_name?.toLowerCase().trim())
        .filter(Boolean)
    ).size;
    const retentionRate = recurring.length > 0
      ? Math.min(100, Math.round((uniqueRecurringWithOrder / recurring.length) * 100))
      : 0;

    // KRA 4: Enquiry Conversion (won deals / total deals created)
    const totalDealsCount = dealsCreatedThisMonth.length;
    const conversionRate = totalDealsCount > 0 ? Math.round((wonCount / totalDealsCount) * 100) : 0;

    // KRA 5: Payments
    const pendingPayments = payments.filter(p => p.status === 'pending' || p.status === 'partial');
    const totalCollected = payments.reduce((s, p) => s + (Number(p.collected_amount) || 0), 0);
    const totalOutstanding = pendingPayments.reduce((s, p) => s + (p.outstanding !== null && p.outstanding !== undefined ? Number(p.outstanding) : Number(p.invoice_amount || 0)), 0);

    // KRA 8: Complaints
    const openComplaints = complaints.filter(c => c.status === 'pending');

    // KRA 9: Visits
    const totalVisits = visits.length;

    const title = scope.targetRepName
      ? `${scope.targetRepName}'s Performance Scorecard`
      : (scope.isAdmin ? 'Company Performance Scorecard' : (scope.isManager ? 'Team Performance Scorecard' : 'Performance Scorecard'));

    return `🎯 *${title} - ${monthName} ${year}*\n\n` +
      `📋 *Sales Achievement Card*\n` +
      `   Won Revenue: *${formatINR(wonValue)}* | Orders: *${wonCount}*` +
      (wonTonnage > 0 ? ` | Volume: *${wonTonnage.toLocaleString('en-IN')} MT*` : '') + `\n\n` +
      `👥 *New Customer Acquisition Card*\n` +
      `   Acquired: *${newCustomersCount}/3* new customers\n\n` +
      `🔄 *Customer Retention Card*\n` +
      `   Active Accounts: *${uniqueRecurringWithOrder}/${recurring.length}* (${retentionRate}%)\n\n` +
      `📈 *Enquiry Conversion Card*\n` +
      `   Inquiries: *${totalDealsCount}* | Won: *${wonCount}* | Rate: *${conversionRate}%*\n\n` +
      `💵 *Payment Collection Card*\n` +
      `   Collected: *${formatINR(totalCollected)}* | Outstanding: *${formatINR(totalOutstanding)}*\n\n` +
      `⚠️ *Customer Complaints Card*\n` +
      `   Total Logged: *${complaints.length}* | Open: *${openComplaints.length}*\n\n` +
      `📍 *Customer Visits Card*\n` +
      `   Total Visits: *${totalVisits}* (Target: 10/wk)\n\n` +
      `_Full live metrics verified with Enlight Sales OS Dashboard_`;
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
      .or(`and(created_at.gte.${start},created_at.lte.${end}),and(won_at.gte.${start},won_at.lte.${end})`)
      .order('created_at', { ascending: false });
    query = applySalespersonFilter(query, scope.phones, 'salesperson_phone');

    const { data: deals } = await query;

    if (!deals || deals.length === 0) {
      return `📋 No won deals found for ${monthName} ${year}.`;
    }

    let srNo = 1;
    const lines = [];
    for (const deal of deals) {
      const items = deal.deal_items || [];
      const poStr = deal.po_number ? ` (PO: ${deal.po_number})` : '';
      if (items.length === 0) {
        lines.push(`${srNo++}. *${deal.customer_name}*${poStr}\n   💰 Value: ${formatINR(deal.total_amount)}`);
      } else {
        const itemLines = items.map(item =>
          `   • ${item.sku_text || 'Material'}: ${item.quantity || 0} ${item.unit || 'MT'}` +
          (item.rate ? ` @ ${formatINR(item.rate)}/MT` : '') +
          (item.amount ? ` = ${formatINR(item.amount)}` : '')
        ).join('\n');
        lines.push(`${srNo++}. *${deal.customer_name}*${poStr}\n${itemLines}\n   💰 *Total: ${formatINR(deal.total_amount)}*`);
      }
    }

    const totalValue = deals.reduce((s, d) => s + (Number(d.total_amount) || 0), 0);
    const totalTonnage = deals.reduce((s, d) => {
      const items = d.deal_items || [];
      return s + items.reduce((is, it) => is + (Number(it.quantity) || 0), 0);
    }, 0);

    const title = scope.targetRepName
      ? `${scope.targetRepName}'s Won Deals`
      : (scope.isAdmin ? 'Company Won Deals' : (scope.isManager ? 'Team Won Deals' : 'Won Deals'));

    return `🏆 *${title} — ${monthName} ${year}* (${deals.length} won orders)\n\n` +
      lines.join('\n\n') +
      `\n\n💰 *Total Won Revenue: ${formatINR(totalValue)}*` +
      (totalTonnage > 0 ? `\n📦 *Total Volume: ${totalTonnage.toLocaleString('en-IN')} MT*` : '');
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
      .gte('visited_at', start)
      .lte('visited_at', end)
      .order('visited_at', { ascending: false });
    query = applySalespersonFilter(query, scope.phones, 'salesperson_phone');

    const { data: visits } = await query;

    if (!visits || visits.length === 0) {
      return `📍 No visits logged for ${monthName} ${year}.`;
    }

    const lines = visits.map((v, i) =>
      `${i + 1}. *${v.customer_name || 'Customer'}*\n` +
      `   📅 ${new Date(v.visited_at).toLocaleDateString('en-IN')}\n` +
      (v.person_met ? `   👤 Contact: ${v.person_met}\n` : '') +
      (v.customer_address ? `   📍 Location: ${v.customer_address}\n` : '') +
      `   📝 Remarks: ${v.remarks || 'Visit completed'}`
    );

    const title = scope.targetRepName
      ? `${scope.targetRepName}'s Customer Visits`
      : (scope.isAdmin ? 'Company Customer Visits' : (scope.isManager ? 'Team Customer Visits' : 'Customer Visits'));

    return `📍 *${title} — ${monthName} ${year}* (${visits.length} visits)\n\n` + lines.join('\n\n');
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
      return `📊 *Customer Visits Card (Team) - ${monthName} ${year}*\n\nNo visits logged. You currently have no salespersons assigned to your team.`;
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
      return `📊 *Customer Visits Card - ${monthName} ${year}*\n\nNo visits logged this month yet.\n\nLog a visit:\n"visited ABC Fabricators today, met Rahul, discussed pricing"`;
    }

    const visitList = visits.slice(0, 5).map((v, i) =>
      `${i + 1}. ${v.customer_name || 'Unknown'} - ${new Date(v.visited_at).toLocaleDateString('en-IN')}`
    ).join('\n');

    const title = scope.targetRepName
      ? `${scope.targetRepName}'s Customer Visits`
      : (scope.isAdmin ? 'Company Customer Visits' : (scope.isManager ? 'Team Customer Visits' : 'Customer Visits Card'));

    return `📊 *${title} - ${monthName} ${year}*\n\n` +
      `Total visits: ${visits.length}\n\n` +
      `Recent visits:\n${visitList}\n\n` +
      `_Target: 10 visits/week, 3 field days/week_`;
  } catch (error) {
    console.error('getVisitSummary error:', error);
    return '❌ Could not fetch visit summary.';
  }
}

/** Inactive / Churn Risk customers (no order in 60+ days) */
async function getInactiveCustomers(scopeOrPhone) {
  try {
    const supabase = getSupabase();
    const scope = typeof scopeOrPhone === 'object' && scopeOrPhone !== null
      ? scopeOrPhone
      : await getAccessibleSalespersonPhonesForBot(scopeOrPhone);

    if (scope.isManager && (!scope.phones || scope.phones.length === 0)) {
      return '⚠️ No customer data found. You currently have no salespersons assigned to your team.';
    }

    let custQuery = supabase
      .from('recurring_customers')
      .select('*')
      .eq('is_active', true)
      .order('customer_name', { ascending: true });
    custQuery = applySalespersonFilter(custQuery, scope.phones, 'assigned_salesperson_phone');

    let dealsQuery = supabase
      .from('deals')
      .select('customer_name, created_at, stage')
      .eq('stage', 'won')
      .order('created_at', { ascending: false });
    dealsQuery = applySalespersonFilter(dealsQuery, scope.phones, 'salesperson_phone');

    const [{ data: customers }, { data: deals }] = await Promise.all([custQuery, dealsQuery]);

    if (!customers || customers.length === 0) {
      return '📋 No registered recurring customers found.';
    }

    const now = new Date();
    const inactiveList = [];
    for (const cust of customers) {
      const custName = (cust.customer_name || '').toLowerCase();
      const lastDeal = (deals || []).find(d => (d.customer_name || '').toLowerCase().includes(custName) || custName.includes((d.customer_name || '').toLowerCase()));
      const lastDate = lastDeal ? new Date(lastDeal.created_at) : (cust.last_order_date ? new Date(cust.last_order_date) : null);

      let daysSince = 999;
      if (lastDate && !isNaN(lastDate.getTime())) {
        daysSince = Math.floor((now - lastDate) / (1000 * 60 * 60 * 24));
      }

      if (daysSince >= 60) {
        inactiveList.push({
          name: cust.customer_name,
          contact: cust.contact_person,
          phone: cust.customer_phone,
          daysSince: daysSince === 999 ? 'No orders recorded' : `${daysSince} days ago`,
          lastDateStr: lastDate && !isNaN(lastDate.getTime()) ? lastDate.toLocaleDateString('en-IN') : 'None',
        });
      }
    }

    if (inactiveList.length === 0) {
      return '✅ All customers are active and ordering regularly (no churn risk > 60 days)!';
    }

    const lines = inactiveList.slice(0, 15).map((c, i) =>
      `${i + 1}. *${c.name}*\n` +
      `   ⏳ Last Order: ${c.daysSince} (${c.lastDateStr})\n` +
      `   👤 Contact: ${c.contact || 'N/A'} | 📱 ${c.phone || 'N/A'}`
    );

    const title = scope.targetRepName
      ? `${scope.targetRepName}'s Inactive Customers (Churn Risk)`
      : (scope.isAdmin ? 'Company Inactive Customers (Churn Risk)' : (scope.isManager ? 'Team Inactive Customers (Churn Risk)' : 'Inactive Customers (Churn Risk)'));

    return `⚠️ *${title} (${inactiveList.length} accounts)*\n\n` +
      lines.join('\n\n') +
      `\n\n_Reach out under Customer Retention Card to re-engage these accounts!_`;
  } catch (err) {
    console.error('getInactiveCustomers error:', err.message);
    return '❌ Could not fetch inactive customers.';
  }
}

/** Reorder Queue (customers due for reorder) */
async function getReorderQueue(scopeOrPhone) {
  try {
    const supabase = getSupabase();
    const scope = typeof scopeOrPhone === 'object' && scopeOrPhone !== null
      ? scopeOrPhone
      : await getAccessibleSalespersonPhonesForBot(scopeOrPhone);

    if (scope.isManager && (!scope.phones || scope.phones.length === 0)) {
      return '📋 No reorder queue data. You currently have no salespersons assigned to your team.';
    }

    let taskQuery = supabase
      .from('followup_tasks')
      .select('*')
      .in('status', ['reorder_expected', 'pending', 'open'])
      .order('due_date', { ascending: true })
      .limit(15);
    taskQuery = applySalespersonFilter(taskQuery, scope.phones, 'salesperson_phone');

    const { data: tasks } = await taskQuery;

    if (!tasks || tasks.length === 0) {
      return '✅ No open reorder tasks right now. Log follow-ups to add to reorder queue!';
    }

    const lines = tasks.map((t, i) => {
      const dueStr = t.due_date ? new Date(t.due_date).toLocaleDateString('en-IN') : 'This week';
      return `${i + 1}. *${t.customer_name}*\n` +
        `   📅 Follow-up Due: ${dueStr}\n` +
        `   📝 Notes: ${t.notes || t.remarks || 'Reorder expected'}`;
    });

    const title = scope.targetRepName
      ? `${scope.targetRepName}'s Reorder Queue`
      : (scope.isAdmin ? 'Company Reorder Queue' : (scope.isManager ? 'Team Reorder Queue' : 'Reorder Queue'));

    return `🔄 *${title} (${tasks.length})*\n\n` + lines.join('\n\n');
  } catch (err) {
    console.error('getReorderQueue error:', err.message);
    return '❌ Could not fetch reorder queue.';
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

    let ptQuery = supabase
      .from('payment_tracking')
      .select('customer_name, invoice_amount, outstanding, due_date, status')
      .neq('status', 'collected')
      .order('due_date', { ascending: true })
      .limit(15);
    ptQuery = applySalespersonFilter(ptQuery, scope.phones, 'salesperson_phone');

    let dealsQuery = supabase
      .from('deals')
      .select('customer_name, total_amount, payment_terms, created_at, status')
      .eq('stage', 'won')
      .not('status', 'eq', 'payment_collected')
      .order('created_at', { ascending: true })
      .limit(15);
    dealsQuery = applySalespersonFilter(dealsQuery, scope.phones, 'salesperson_phone');

    const [{ data: ptRecords }, { data: deals }] = await Promise.all([ptQuery, dealsQuery]);
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

async function getCustomer360(senderPhone, text, extractedName = null) {
  let customerName = extractedName;
  try {
    const supabase = getSupabase();
    const cleanPhone = (senderPhone || '').replace(/\D/g, '').slice(-10);

    if (!customerName) {
      customerName = text
        .replace(/customer\s*360\s*(for|of)?/gi, '')
        .replace(/360\s*view\s*(for|of)?/gi, '')
        .replace(/tell\s*me\s*about/gi, '')
        .replace(/profile\s*of/gi, '')
        .replace(/about\s*customer/gi, '')
        .replace(/[?.,]/g, '')
        .trim();
    }

    if (!customerName || customerName.length < 2) {
      return `❓ *Please specify the customer name.*\n\nExample: _"Customer 360 for Supreme Steel"_`;
    }

    // 1. Fetch profile
    let custQuery = supabase
      .from('recurring_customers')
      .select('*')
      .ilike('customer_name', `%${customerName}%`);
    if (cleanPhone) {
      custQuery = custQuery.ilike('assigned_salesperson_phone', `%${cleanPhone}%`);
    }
    const { data: profiles } = await custQuery.limit(1);
    const profile = profiles && profiles.length > 0 ? profiles[0] : null;

    // 2. Fetch deals
    let dealsQuery = supabase
      .from('deals')
      .select('id, stage, total_amount, customer_name, customer_phone, customer_gst, customer_address, delivery_location, payment_terms, po_number, created_at, deal_items(*)')
      .ilike('customer_name', `%${customerName}%`)
      .order('created_at', { ascending: false });
    if (cleanPhone) {
      dealsQuery = dealsQuery.ilike('salesperson_phone', `%${cleanPhone}%`);
    }
    const { data: deals } = await dealsQuery.limit(5);

    // 3. Fetch payment tracking
    let payQuery = supabase
      .from('payment_tracking')
      .select('*')
      .ilike('customer_name', `%${customerName}%`);
    if (cleanPhone) {
      payQuery = payQuery.ilike('salesperson_phone', `%${cleanPhone}%`);
    }
    const { data: payments } = await payQuery.limit(5);

    if (!profile && (!deals || deals.length === 0) && (!payments || payments.length === 0)) {
      return `🔍 *Customer 360 - ${customerName}*\n\nNo matching records found for "${customerName}" under your salesperson account.`;
    }

    const officialName = profile?.customer_name || deals?.[0]?.customer_name || customerName;
    const phone = profile?.customer_phone || deals?.[0]?.customer_phone || 'Not specified';
    const gst = profile?.customer_gst || deals?.[0]?.customer_gst || 'Not specified';
    const address = profile?.customer_address || deals?.[0]?.customer_address || 'Not specified';

    let dealsSection = '• No active deals recorded.';
    if (deals && deals.length > 0) {
      dealsSection = deals.map((d, i) => {
        const amt = d.total_amount ? `₹${Number(d.total_amount).toLocaleString('en-IN')}` : 'Amount TBD';
        const items = (d.deal_items || []).map(it => `${it.quantity_tons || it.quantity || ''} ${it.unit || 'MT'} ${it.product_name || it.sku_text || ''}`).filter(Boolean).join(', ');
        return `• *Deal #${d.id.substring(0, 8)}* (${d.stage || 'inquiry'})\n  Value: ${amt}${items ? `\n  Items: ${items}` : ''}`;
      }).join('\n\n');
    }

    let paySection = '• No past payment records or dues currently tracked for this account.';
    if (payments && payments.length > 0) {
      paySection = payments.map(p => {
        const out = p.total_amount_pending ? `Pending: ₹${Number(p.total_amount_pending).toLocaleString('en-IN')}` : 'Paid in full';
        return `• *Invoice:* ${p.invoice_number || 'N/A'} — ${out} (Status: ${p.status || 'active'})`;
      }).join('\n');
    }

    return `🏢 *Customer 360 Overview: ${officialName}*\n\n` +
      `📞 *Phone:* ${phone}\n` +
      `📋 *GST:* ${gst}\n` +
      `📍 *Address:* ${address}\n\n` +
      `📦 *Recent Deals:*\n${dealsSection}\n\n` +
      `💰 *Payment Status:*\n${paySection}`;
  } catch (err) {
    console.error('getCustomer360 error:', err.message);
    return `❌ Could not fetch Customer 360 for ${customerName || 'customer'}.`;
  }
}

async function getKnowledgeBaseAnswer(senderPhone, queryText) {
  try {
    const supabase = getSupabase();
    const apiKey = process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY_1 || process.env.GEMINI_API_KEY_2;
    
    // Generate query embedding via GoogleGenerativeAI with gemini-embedding-001
    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(apiKey);
    const embeddingModel = genAI.getGenerativeModel({ model: 'gemini-embedding-001' });
    const result = await embeddingModel.embedContent(queryText);
    const raw = result.embedding.values;
    const queryEmbedding = raw.length > 768 ? raw.slice(0, 768) : raw;

    let { data: chunks, error } = await supabase.rpc('match_kb_chunks', {
      query_embedding: queryEmbedding,
      match_count: 3,
      allowed_roles: ['all', 'salesperson', 'manager', 'admin'],
    });

    if (error) {
      const res2 = await supabase.rpc('match_kb_chunks', {
        query_embedding: JSON.stringify(queryEmbedding),
        match_count: 3,
        allowed_roles: ['all', 'salesperson', 'manager', 'admin'],
      });
      chunks = res2.data;
      error = res2.error;
    }

    if (!chunks || chunks.length === 0) {
      return `📚 *Knowledge Base*\n\nI couldn't find specific company policy documentation for "${queryText}". Please check with your sales manager or operations lead.`;
    }

    const topChunk = chunks[0];
    const sourceTitle = topChunk.title || 'Company Policy';

    return `📚 *Enlight Metals Knowledge Base*\n\n${topChunk.content.trim()}\n\n📄 _Source: ${sourceTitle}_`;
  } catch (err) {
    console.error('getKnowledgeBaseAnswer error:', err.message);
    return `⚠️ Could not search company knowledge base: ${err.message}`;
  }
}

async function getReorderQueue(senderPhone) {
  try {
    const supabase = getSupabase();
    const phoneStr = typeof senderPhone === 'object' ? senderPhone?.phone || (senderPhone?.phones && senderPhone.phones[0]) || '' : (senderPhone || '');
    const cleanPhone = phoneStr.replace(/\D/g, '').slice(-10);

    let query = supabase
      .from('recurring_customers')
      .select('id, customer_name, customer_phone, last_order_date, avg_order_frequency_days, notes')
      .eq('is_active', true)
      .order('last_order_date', { ascending: true })
      .limit(10);

    if (cleanPhone) {
      query = query.ilike('assigned_salesperson_phone', `%${cleanPhone}%`);
    }

    const { data: accounts, error } = await query;
    if (error || !accounts || accounts.length === 0) {
      return `🔄 *Reorder Queue*\n\nNo recurring customers currently flagged for reorder under your account.`;
    }

    const list = accounts.map((a, i) => {
      const lastDate = a.last_order_date ? new Date(a.last_order_date).toLocaleDateString('en-IN') : 'N/A';
      return `${i + 1}. *${a.customer_name}*\n   📞 ${a.customer_phone || 'N/A'} | Last Order: ${lastDate}\n   Frequency: Every ${a.avg_order_frequency_days || 30} days`;
    }).join('\n\n');

    return `🔄 *Recurring Customers Due for Reorder (${accounts.length})*\n\n${list}\n\n_Tip: Reach out to these clients to secure repeat orders this week._`;
  } catch (err) {
    console.error('getReorderQueue error:', err.message);
    return `❌ Could not fetch reorder queue.`;
  }
}

async function getChurnRadar(senderPhone) {
  try {
    const supabase = getSupabase();
    const phoneStr = typeof senderPhone === 'object' ? senderPhone?.phone || (senderPhone?.phones && senderPhone.phones[0]) || '' : (senderPhone || '');
    const cleanPhone = phoneStr.replace(/\D/g, '').slice(-10);

    let query = supabase
      .from('recurring_customers')
      .select('*')
      .limit(20);

    if (cleanPhone) {
      query = query.ilike('assigned_salesperson_phone', `%${cleanPhone}%`);
    }

    const { data: accounts, error } = await query;
    if (error || !accounts || accounts.length === 0) {
      return `⚠️ *Churn Radar*\n\nNo accounts currently flagged at churn risk under your account.`;
    }

    const now = Date.now();
    const atRisk = accounts.filter(a => {
      if (!a.last_order_date) return false;
      const last = new Date(a.last_order_date).getTime();
      const days = (now - last) / (1000 * 60 * 60 * 24);
      const expected = (a.avg_order_frequency_days || 30) * 1.5;
      return days > expected;
    });

    if (atRisk.length === 0) {
      return `✅ *Churn Radar*\n\nAll your recurring accounts are ordering within their healthy schedule!`;
    }

    const list = atRisk.map((a, i) => {
      const days = Math.round((now - new Date(a.last_order_date).getTime()) / (1000 * 60 * 60 * 24));
      return `${i + 1}. *${a.customer_name}*\n   Days since last order: *${days} days* (Avg cycle: ${a.avg_order_frequency_days || 30} days)`;
    }).join('\n\n');

    return `🚨 *Churn Risk Accounts (${atRisk.length})*\n\n${list}\n\n_Action: Schedule immediate retention visits/calls._`;
  } catch (err) {
    console.error('getChurnRadar error:', err.message);
    return `❌ Could not fetch churn radar.`;
  }
}

// Shared category → handler router (used by both admin, manager, and salesperson paths)
async function routeToHandler(category, text, scope, supabase, extra = {}) {
  const phone = typeof scope === 'object' ? scope.phone || (scope.phones && scope.phones[0]) : scope;
  switch (category) {
    case 'customer_360':
      return await getCustomer360(phone, text, extra.customer_name);
    case 'knowledge_base':
      return await getKnowledgeBaseAnswer(phone, text);
    case 'reorder_queue':
      return await getReorderQueue(scope);
    case 'churn_radar':
      return await getChurnRadar(phone);
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
    case 'inactive_customers':
    case 'churn_risk':
      return await getInactiveCustomers(scope);
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
        return await routeToHandler(classification.category, text, effectiveScope, supabase, classification);
      }
    }
  } catch (err) {
    console.error('Semantic router error:', err.message);
  }

  // 5. Keyword fallback (backup for low-confidence semantic router)
  // Customer 360 / Profile
  if (lower.includes('360') || lower.includes('customer profile') || lower.includes('tell me about') || lower.includes('profile of')) {
    return await getCustomer360(senderPhone, text);
  }
  // Knowledge base / SOP / Policy
  if (lower.includes('moq') || lower.includes('sop') || lower.includes('policy') || lower.includes('guideline') || lower.includes('discount slab') || lower.includes('validity')) {
    return await getKnowledgeBaseAnswer(senderPhone, text);
  }
  // Churn radar
  if (lower.includes('churn')) {
    return await getChurnRadar(senderPhone);
  }
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
  // Inactive customers / churn risk
  if (lower.includes('not ordered') || lower.includes('order nahi') || lower.includes('inactive') || lower.includes('churn')) {
    return await getInactiveCustomers(effectiveScope);
  }
  // Reorder queue
  if (lower.includes('reorder') || lower.includes('repeat order')) {
    return await getReorderQueue(effectiveScope);
  }
  // Customer list
  if (lower.includes('customer list') || lower.includes('my customers') || lower.includes('team customers') || lower.includes('client list') || lower.includes('all customers')) {
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

module.exports = { isQuery, handleQuery, getVisitSummary, getInactiveCustomers, getReorderQueue };
