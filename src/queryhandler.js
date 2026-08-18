const { createClient } = require('@supabase/supabase-js');
const { getPaymentSummary } = require('./kra5');
const { getComplaintSummary } = require('./kra8');
const { generateFullKRAReport } = require('./kraReport');
const { getNewCustomerSummary } = require('./kra2');
const { handleConversationalQuery } = require('./agents/assistantAgent');

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
    // Deal queries  
    'pending deals', 'open deals', 'meri deals',
    'my deals', 'deals this week', 'is hafte',
    'active deals', 'current deals', 'won deals', 'won customers',
    'lost deals', 'rejected deals',
    // Customer & Contact queries
    'customer list', 'which customers', 'kaun se customer',
    'not ordered', 'order nahi', 'inactive customers',
    'my customers', 'all customers', 'client list', 'client directory',
    'contact details', 'contact info', 'phone number', 'gst number', 'customer details',
    // Knowledge Base & Policy queries
    'sop', 'policy', 'moq', 'minimum order', 'guideline', 'guidelines',
    'discount slab', 'discount policy', 'quotation validity', 'approval matrix',
    // Payment queries
    'outstanding', 'overdue', 'due payment',
    'pending payment', 'baaki payment', 'baaki list',
    'who hasn\'t paid', 'payment aging', 'collection due',
    // Performance & Summary queries
    'my performance', 'performance report', 'target achievements',
    'performance', 'performace', 'status report', 'performance status',
    'target status', 'sales achievement', 'my target', 'my status',
    'kra status', 'kra report', 'my kra', 'churn radar', 'loss analytics',
    // Visit queries
    'my visits', 'visit log', 'who did i visit', 'field visits',
    'customer visits', 'site visits',
    // Rate / Price queries
    'rate sheet', 'current rates', 'today\'s rates', 'steel rates',
    'bhav', 'price list', 'rate list',
    // Inquiry queries
    'my inquiries', 'meri inquiries', 'pending inquiries',
    'review queue', 'kitni inquiries',
    // General / Command phrases
    'monthly report', 'sales report', 'status report', 'show me sales',
    'my reports', 'my report', 'all reports', 'show reports', 'report card',
    'report', 'reports', 'dashboard', 'login', 'link', 'website', 'portal', 'url',
    'new customers', 'onboarded customers', 'kra 2',
    // General conversational & date/pricing query triggers
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

// QUERY HANDLERS

async function getSalesThisMonth(senderPhone, text = '') {
  try {
    const supabase = getSupabase();
    const { start, end, monthName, year } = getMonthRangeFromQuery(text);

    const { data: deals, error } = await supabase
      .from('deals')
      .select('*, deal_items(*)')
      .eq('salesperson_phone', senderPhone)
      .gte('created_at', start)
      .lte('created_at', end);

    if (error) throw error;

    const totalDeals = deals?.length || 0;
    const wonDeals = deals?.filter(d => d.stage === 'won').length || 0;
    const totalAmount = deals?.reduce((sum, d) => sum + (Number(d.total_amount) || 0), 0) || 0;
    const totalItems = deals?.reduce((sum, d) => sum + (d.deal_items?.length || 0), 0) || 0;

    return `📊 *Sales Summary - ${monthName} ${year}*\n\n` +
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

async function getPendingDeals(senderPhone) {
  try {
    const supabase = getSupabase();

    const { data: deals, error } = await supabase
      .from('deals')
      .select('*')
      .not('stage', 'in', '("won","lost")')
      .order('created_at', { ascending: false })
      .limit(10);

    if (error) throw error;

    if (!deals || deals.length === 0) {
      return '✅ No pending deals right now!';
    }

    const dealList = deals.map((d, i) => 
      `${i + 1}. ${d.customer_name || 'Unknown'}\n` +
      `   Stage: ${d.stage} | ${d.inquiry_type}\n` +
      `   ${d.total_amount ? formatINR(d.total_amount) : 'Amount TBD'}`
    ).join('\n\n');

    return `📋 *Pending Deals (${deals.length})*\n\n${dealList}\n\n_Showing latest 10_`;
  } catch (error) {
    console.error('getPendingDeals error:', error);
    return '❌ Could not fetch pending deals.';
  }
}

async function getPendingInquiries() {
  try {
    const supabase = getSupabase();

    const { data: inquiries, error } = await supabase
      .from('inquiries')
      .select('*')
      .eq('status', 'review')
      .order('created_at', { ascending: false })
      .limit(10);

    if (error) throw error;

    if (!inquiries || inquiries.length === 0) {
      return '✅ No inquiries pending review!';
    }

    const list = inquiries.map((inq, i) =>
      `${i + 1}. ${inq.sender_name || inq.sender_phone}\n` +
      `   "${inq.raw_text?.substring(0, 50)}..."\n` +
      `   Confidence: ${Math.round((inq.overall_confidence || 0) * 100)}%`
    ).join('\n\n');

    return `⚠️ *Inquiries Needing Review (${inquiries.length})*\n\n${list}`;
  } catch (error) {
    console.error('getPendingInquiries error:', error);
    return '❌ Could not fetch inquiries.';
  }
}

async function getDealsThisWeek() {
  try {
    const supabase = getSupabase();
    const { start, end } = getWeekRange();

    const { data: deals, error } = await supabase
      .from('deals')
      .select('*, deal_items(*)')
      .gte('created_at', start)
      .lte('created_at', end)
      .order('created_at', { ascending: false });

    if (error) throw error;

    if (!deals || deals.length === 0) {
      return '📋 No deals logged this week yet.';
    }

    const totalAmount = deals.reduce((sum, d) => sum + (d.total_amount || 0), 0);
    const list = deals.map((d, i) =>
      `${i + 1}. ${d.customer_name || 'Unknown'} - ${d.inquiry_type}\n` +
      `   ${d.deal_items?.length || 0} items | ${formatINR(d.total_amount)}`
    ).join('\n\n');

    return `📊 *This Week's Deals (${deals.length})*\n\n${list}\n\n` +
      `💰 *Total: ${formatINR(totalAmount)}*`;
  } catch (error) {
    console.error('getDealsThisWeek error:', error);
    return '❌ Could not fetch this week deals.';
  }
}

async function getKRAStatus(senderPhone, text = '') {
  try {
    const supabase = getSupabase();
    const { start, end, monthName, year } = getMonthRangeFromQuery(text);

    // Get all deals this month for this salesperson
    const { data: deals } = await supabase
      .from('deals')
      .select('*, deal_items(*)')
      .eq('salesperson_phone', senderPhone)
      .gte('created_at', start)
      .lte('created_at', end);

    // Get all inquiries this month for this salesperson
    const { data: inquiries } = await supabase
      .from('inquiries')
      .select('*')
      .eq('salesperson_phone', senderPhone)
      .gte('created_at', start)
      .lte('created_at', end);

    const resolvedMonth = new Date(start).getMonth() + 1;
    const resolvedYear  = new Date(start).getFullYear();

    // Get KRA logs this month for KRA 2 (New Customers)
    const { data: kra2Logs } = await supabase
      .from('kra_logs')
      .select('id')
      .eq('salesperson_phone', senderPhone)
      .eq('kra_number', 2)
      .eq('kra_type', 'new_customer')
      .eq('month', resolvedMonth)
      .eq('year', resolvedYear);

    const totalDeals = deals?.length || 0;
    const wonDeals = deals?.filter(d => d.stage === 'won') || [];
    const wonCount = wonDeals.length;
    const wonValue = wonDeals.reduce((sum, d) => sum + (Number(d.total_amount) || 0), 0);

    const totalInquiries = inquiries?.length || 0;
    const conversionRate = totalInquiries > 0 
      ? Math.round((wonCount / totalInquiries) * 100) 
      : 0;

    const newCustomersCount = kra2Logs?.length || 0;

    return `🎯 *KRA Status - ${monthName} ${year}*\n\n` +
      `📋 *KRA 1 - Sales Achievement*\n` +
      `   Won Deals: ${wonCount} | Value: ${formatINR(wonValue)} (Total Created: ${totalDeals})\n\n` +
      `👥 *KRA 2 - New Customers*\n` +
      `   POs received: ${newCustomersCount} (target: 3)\n\n` +
      `🔄 *KRA 4 - Enquiry Conversion*\n` +
      `   Inquiries: ${totalInquiries} | Won: ${wonCount}\n` +
      `   Rate: ${conversionRate}% (target: 70-80%)\n\n` +
      `📊 *KRA 6 - CRM Compliance*\n` +
      `   Logged today via WhatsApp bot ✅\n\n` +
      `_Full KRA report available from Sales Lead_`;
  } catch (error) {
    console.error('getKRAStatus error:', error);
    return '❌ Could not fetch KRA status.';
  }
}

// ── NEW RICH DATA HANDLERS ────────────────────────────────────────────────

/** Won customer names + product + qty breakdown (mirrors KRA 1 breakdown card) */
async function getWonCustomers(senderPhone, text = '') {
  try {
    const supabase = getSupabase();
    const { start, end, monthName, year } = getMonthRangeFromQuery(text);

    const { data: deals } = await supabase
      .from('deals')
      .select('*, deal_items(*)')
      .eq('salesperson_phone', senderPhone)
      .eq('stage', 'won')
      .gte('created_at', start)
      .lte('created_at', end);

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
    return `🏆 *Won Customers — ${monthName} ${year}* (${deals.length} deals)\n\n` +
      lines.join('\n\n') +
      `\n\n💰 *Total Won Value: ${formatINR(totalValue)}*`;
  } catch (err) {
    console.error('getWonCustomers error:', err.message);
    return '❌ Could not fetch won customers.';
  }
}

/** Active deals with full stage + items detail */
async function getActiveDealsDetail(senderPhone) {
  try {
    const supabase = getSupabase();

    const { data: deals } = await supabase
      .from('deals')
      .select('*, deal_items(*)')
      .eq('salesperson_phone', senderPhone)
      .not('stage', 'in', '("won","lost")')
      .order('created_at', { ascending: false })
      .limit(15);

    if (!deals || deals.length === 0) {
      return '✅ No active deals in pipeline right now.';
    }

    const lines = deals.map((d, i) => {
      const items = (d.deal_items || []).map(it => `     • ${it.sku_text || 'Item'}: ${it.quantity} ${it.unit}`).join('\n');
      return `${i + 1}. *${d.customer_name}* [${d.stage}]\n${items || '     (no items yet)'}\n   💰 ${d.total_amount > 0 ? formatINR(d.total_amount) : 'TBD'}`;
    });

    return `📋 *Active Pipeline Deals (${deals.length})*\n\n` + lines.join('\n\n');
  } catch (err) {
    console.error('getActiveDealsDetail error:', err.message);
    return '❌ Could not fetch active deals.';
  }
}

/** Full registered customer list */
async function getCustomerList(senderPhone) {
  try {
    const supabase = getSupabase();

    const { data: customers } = await supabase
      .from('recurring_customers')
      .select('customer_name, contact_person, customer_address, customer_phone, customer_gst')
      .eq('assigned_salesperson_phone', senderPhone)
      .eq('is_active', true)
      .order('customer_name', { ascending: true })
      .limit(20);

    if (!customers || customers.length === 0) {
      return '📋 No customers registered under your account yet.';
    }

    const lines = customers.map((c, i) =>
      `${i + 1}. *${c.customer_name}*\n` +
      `   👤 ${c.contact_person || 'N/A'} | 📍 ${c.customer_address || 'N/A'} | 📱 ${c.customer_phone || 'N/A'}` +
      (c.customer_gst ? `\n   🧾 GST: ${c.customer_gst}` : '')
    );

    return `👥 *Your Customer List (${customers.length})*\n\n` + lines.join('\n\n');
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
async function getVisitList(senderPhone, text = '') {
  try {
    const supabase = getSupabase();
    const { start, end, monthName, year } = getMonthRangeFromQuery(text);

    const { data: visits } = await supabase
      .from('customer_visits')
      .select('*')
      .eq('salesperson_phone', senderPhone)
      .gte('visit_date', start)
      .lte('visit_date', end)
      .order('visit_date', { ascending: false });

    if (!visits || visits.length === 0) {
      return `📍 No visits logged for ${monthName} ${year}.`;
    }

    const lines = visits.map((v, i) =>
      `${i + 1}. *${v.customer_name}*\n   📅 ${new Date(v.visit_date).toLocaleDateString('en-IN')}\n   📝 ${v.notes || 'No notes'}`
    );

    return `📍 *Customer Visits — ${monthName} ${year}* (${visits.length})\n\n` + lines.join('\n\n');
  } catch (err) {
    console.error('getVisitList error:', err.message);
    return '❌ Could not fetch visit list.';
  }
}

/** Payment aging / outstanding list — derived from deals table (source of truth) */
async function getPaymentAging(senderPhone) {
  try {
    const supabase = getSupabase();

    // Source of truth: unpaid won deals with payment_terms
    const { data: deals } = await supabase
      .from('deals')
      .select('customer_name, total_amount, payment_terms, created_at, status')
      .eq('salesperson_phone', senderPhone)
      .eq('stage', 'won')
      .not('status', 'eq', 'payment_collected')
      .order('created_at', { ascending: true })
      .limit(15);

    // Also check payment_tracking for any overrides
    const { data: ptRecords } = await supabase
      .from('payment_tracking')
      .select('customer_name, invoice_amount, outstanding, due_date, status')
      .eq('salesperson_phone', senderPhone)
      .neq('status', 'collected')
      .order('due_date', { ascending: true })
      .limit(15);

    const today = new Date();

    // Prefer payment_tracking records (they have outstanding amounts), fall back to deals
    let rows = [];

    if (ptRecords && ptRecords.length > 0) {
      rows = ptRecords.map((p, i) => {
        // Calculate due date: use stored due_date only if it's valid (not null / epoch)
        let dueDisplay = 'Due date TBD';
        let overdueStr = '';
        if (p.due_date) {
          const due = new Date(p.due_date);
          // Guard against epoch (1970) values
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
      return `💰 *Outstanding Payments (${ptRecords.length})*\n\n` +
        rows.join('\n\n') +
        `\n\n📊 *Total Outstanding: ${formatINR(totalOutstanding)}*`;
    }

    // Fallback: derive from won deals
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
    return `💰 *Outstanding Payments (${deals.length})*\n\n` +
      rows.join('\n\n') +
      `\n\n📊 *Total Outstanding: ${formatINR(totalOutstanding)}*`;
  } catch (err) {
    console.error('getPaymentAging error:', err.message);
    return '❌ Could not fetch payment aging.';
  }
}

/** Lost deals breakdown with reasons */
async function getLostDeals(senderPhone, text = '') {
  try {
    const supabase = getSupabase();
    const { start, end, monthName, year } = getMonthRangeFromQuery(text);

    const { data: deals } = await supabase
      .from('deals')
      .select('customer_name, total_amount, lost_reason, created_at')
      .eq('salesperson_phone', senderPhone)
      .eq('stage', 'lost')
      .gte('created_at', start)
      .lte('created_at', end)
      .order('created_at', { ascending: false });

    if (!deals || deals.length === 0) {
      return `✅ No lost deals in ${monthName} ${year}.`;
    }

    const lines = deals.map((d, i) =>
      `${i + 1}. *${d.customer_name}*\n   Amount: ${formatINR(d.total_amount)}\n   Reason: ${d.lost_reason || 'Not specified'}`
    );

    const totalLost = deals.reduce((s, d) => s + (Number(d.total_amount) || 0), 0);
    return `❌ *Lost Deals — ${monthName} ${year}* (${deals.length})\n\n` +
      lines.join('\n\n') +
      `\n\n📉 *Total Lost Value: ${formatINR(totalLost)}*`;
  } catch (err) {
    console.error('getLostDeals error:', err.message);
    return '❌ Could not fetch lost deals.';
  }
}

// Shared category → handler router (used by both admin and salesperson paths)
async function routeToHandler(category, text, phone, isAdmin, supabase) {
  switch (category) {
    case 'dashboard_link': {
      const dashboardUrl = process.env.DASHBOARD_URL || 'https://enlight-sales-frontend.vercel.app';
      return `🔗 *Enlight Sales OS Portal*\n\n👉 ${dashboardUrl}\n\nEnter your registered WhatsApp number to log in.`;
    }
    case 'sales_summary':
      return await getSalesThisMonth(phone, text);
    case 'kra_status':
      return await getKRAStatus(phone, text);
    case 'visit_summary':
      return await getVisitSummary(phone, text);
    case 'payment_summary':
      return await getPaymentSummary(phone);
    case 'complaint_summary':
      return await getComplaintSummary(phone);
    case 'full_report':
      return await generateFullKRAReport(phone, getMonthRangeFromQuery(text));
    case 'deals_this_week':
      return await getDealsThisWeek(isAdmin ? null : phone);
    case 'pending_deals':
      return await getPendingDeals(phone);
    case 'pending_inquiries':
      return await getPendingInquiries(isAdmin ? null : phone);
    case 'new_customers_summary':
      return await getNewCustomerSummary(phone);
    case 'won_customers':
      return await getWonCustomers(phone, text);
    case 'active_deals_detail':
      return await getActiveDealsDetail(phone);
    case 'customer_list':
      return await getCustomerList(phone);
    case 'rate_sheet':
      return await getRateSheet();
    case 'visit_list':
      return await getVisitList(phone, text);
    case 'payment_aging':
      return await getPaymentAging(phone);
    case 'lost_deals':
      return await getLostDeals(phone, text);
    default:
      return null;
  }
}

// Main query router
async function handleQuery(text, senderPhone) {
  const lower = text.toLowerCase();
  const supabase = getSupabase();

  // ── Determine sender role ────────────────────────────────────────────────
  let senderRole = 'salesperson';
  let effectivePhone = senderPhone; // the phone used for DB queries
  try {
    const { data: senderEmp } = await supabase
      .from('employees')
      .select('role')
      .eq('phone', senderPhone)
      .single();
    if (senderEmp) senderRole = senderEmp.role || 'salesperson';
  } catch (e) { /* default to salesperson */ }

  const isAdmin = senderRole === 'admin';

  // ── Cross-salesperson protection (salesperson only) ─────────────────────
  if (!isAdmin) {
    try {
      const { data: otherEmployees } = await supabase
        .from('employees')
        .select('name')
        .neq('phone', senderPhone);

      if (otherEmployees && otherEmployees.length > 0) {
        for (const emp of otherEmployees) {
          if (emp.name) {
            const empNameLower = emp.name.toLowerCase().trim();
            const parts = empNameLower.split(/\s+/);
            const isMatch = lower.includes(empNameLower) ||
              parts.some(part => part.length > 3 && lower.includes(part));
            if (isMatch) {
              return `⚠️ *Access Denied*\n\nYou are not authorized to view the performance or KRA details of other salespeople. You can only query your own performance reports.`;
            }
          }
        }
      }
    } catch (err) {
      console.error('Cross-query check error:', err.message);
    }
  }

  // ── Admin: resolve target salesperson from query ─────────────────────────
  if (isAdmin) {
    try {
      const { classifyQueryType } = require('./gemini');
      const classification = await classifyQueryType(text);

      // If admin mentioned a specific salesperson, look up their phone
      if (classification && classification.target_salesperson) {
        const nameLower = classification.target_salesperson.toLowerCase().trim();
        const { data: allEmps } = await supabase
          .from('employees')
          .select('name, phone');

        if (allEmps) {
          const matched = allEmps.find(e => {
            const n = (e.name || '').toLowerCase();
            return n.includes(nameLower) || nameLower.includes(n.split(' ')[0]);
          });
          if (matched) effectivePhone = matched.phone;
        }
      }

      // Route using category
      if (classification && classification.category !== 'general' && classification.category !== 'blocked' && classification.confidence >= 0.65) {
        return await routeToHandler(classification.category, text, effectivePhone, isAdmin, supabase);
      }
    } catch (err) {
      console.error('Admin semantic router error:', err.message);
    }
  }

  // ── Salesperson: semantic router ─────────────────────────────────────────
  try {
    const { classifyQueryType } = require('./gemini');
    const classification = await classifyQueryType(text);

    if (classification && classification.confidence >= 0.70) {
      if (classification.category === 'blocked') {
        const dashboardUrl = process.env.DASHBOARD_URL || 'https://enlight-sales-frontend.vercel.app';
        if (isAdmin) {
          return `🔗 *This action requires Dashboard access.*\n\n` +
            `Admin operations like rate sheet management, pricing configuration, product analysis, and CRM admin tasks are available directly on the portal:\n\n` +
            `👉 ${dashboardUrl}\n\n` +
            `Log in with your admin credentials to proceed.`;
        }
        return `⚠️ *Query Not Supported*\n\nThis type of request is outside the bot's scope.\n\nI can only answer queries related to *your own* deals, customers, payments, visits, KRA performance, and steel rates.`;
      }
      if (classification.category !== 'general') {
        return await routeToHandler(classification.category, text, effectivePhone, isAdmin, supabase);
      }
    }
  } catch (err) {
    console.error('Semantic router error:', err.message);
  }

  // ── Keyword fallback (backup for low-confidence semantic router) ─────────
  // KRA / performance
  if (lower.includes('kra') || lower.includes('target') || lower.includes('performance') ||
      lower.includes('performace') || lower.includes('achievement')) {
    return await getKRAStatus(senderPhone, text);
  }
  // Sales summary
  if (lower.includes('sales') || lower.includes('this month') || lower.includes('is mahine')) {
    return await getSalesThisMonth(senderPhone, text);
  }
  // Won customers
  if (lower.includes('won') && (lower.includes('customer') || lower.includes('deal'))) {
    return await getWonCustomers(senderPhone, text);
  }
  // Lost deals
  if (lower.includes('lost') || lower.includes('rejected deal')) {
    return await getLostDeals(senderPhone, text);
  }
  // Active deals
  if ((lower.includes('active') || lower.includes('current') || lower.includes('my deals')) && lower.includes('deal')) {
    return await getActiveDealsDetail(senderPhone);
  }
  // Customer list
  if (lower.includes('customer list') || lower.includes('my customers') || lower.includes('client list')) {
    return await getCustomerList(senderPhone);
  }
  // Rate sheet
  if (lower.includes('rate') || lower.includes('bhav') || lower.includes('price list')) {
    return await getRateSheet();
  }
  // Visit list
  if (lower.includes('visit') || lower.includes('visited') || lower.includes('field visit')) {
    return await getVisitList(senderPhone, text);
  }
  // Outstanding / payment aging (must come before generic 'payment')
  if (lower.includes('outstanding') || lower.includes('overdue') || lower.includes('baaki') ||
      lower.includes('due') || lower.includes('aging') || lower.includes('hasn') || lower.includes('nahi diya')) {
    return await getPaymentAging(senderPhone);
  }
  // Payment summary (KRA 5 totals)
  if (lower.includes('payment') || lower.includes('collection')) {
    return await getPaymentSummary(senderPhone);
  }
  // Complaints
  if (lower.includes('complaint') || lower.includes('shikayat')) {
    return await getComplaintSummary(senderPhone);
  }
  // New customers KRA 2
  if (lower.includes('new customer') || lower.includes('kra 2')) {
    return await getNewCustomerSummary(senderPhone);
  }
  // Dashboard link
  if (lower.includes('link') || lower.includes('login') || lower.includes('portal')) {
    const dashboardUrl = process.env.DASHBOARD_URL || 'https://enlight-sales-frontend.vercel.app';
    return `🔗 *Enlight Sales OS Portal*\n\n👉 ${dashboardUrl}\n\nEnter your registered WhatsApp number to log in.`;
  }

  // ── Final fallback: route to conversational assistant ──────────────────
  return await handleConversationalQuery(text, senderPhone);
}

async function getVisitSummary(senderPhone, text = '') {
  try {
    const supabase = getSupabase();
    const { start, end, monthName, year } = getMonthRangeFromQuery(text);

    const { data: visits } = await supabase
      .from('customer_visits')
      .select('*')
      .eq('salesperson_phone', senderPhone)
      .gte('visited_at', start)
      .lte('visited_at', end)
      .order('visited_at', { ascending: false });

    if (!visits || visits.length === 0) {
      return `📊 *KRA 9 - ${monthName} ${year}*\n\nNo visits logged this month yet.\n\nLog a visit:\n"visited ABC Fabricators today, met Rahul, discussed pricing"`;
    }

    const visitList = visits.slice(0, 5).map((v, i) =>
      `${i + 1}. ${v.customer_name || 'Unknown'} - ${new Date(v.visited_at).toLocaleDateString('en-IN')}`
    ).join('\n');

    return `📊 *KRA 9 - ${monthName} ${year}*\n\n` +
      `Total visits: ${visits.length}\n\n` +
      `Recent visits:\n${visitList}\n\n` +
      `_Target: 10 visits/week, 3 field days/week_`;
  } catch (error) {
    console.error('getVisitSummary error:', error);
    return '❌ Could not fetch visit summary.';
  }
}

module.exports = { isQuery, handleQuery, getVisitSummary };
