const { createClient } = require('@supabase/supabase-js');

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

function getMonthRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(
    now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59
  );
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    monthName: now.toLocaleString('en-IN', { month: 'long' }),
    year: now.getFullYear()
  };
}

function formatINR(amount) {
  if (!amount) return '₹0';
  return '₹' + Number(amount).toLocaleString('en-IN');
}

async function generateFullKRAReport(scopeOrPhone, customMonthRange = null) {
  const supabase = getSupabase();
  const { getAccessibleSalespersonPhonesForBot } = require('./supabase');
  const scope = typeof scopeOrPhone === 'object' && scopeOrPhone !== null
    ? scopeOrPhone
    : await getAccessibleSalespersonPhonesForBot(scopeOrPhone);

  const { start, end, monthName, year } = customMonthRange || getMonthRange();
  const now = new Date();

  if (scope.isManager && (!scope.phones || scope.phones.length === 0)) {
    return `📊 *Team KRA Monthly Report - ${monthName} ${year}*\n\n📋 No data found. You currently have no salespersons assigned to your team.`;
  }

  try {
    let dealsQuery = supabase.from('deals').select('*, deal_items(*)').or(`and(created_at.gte.${start},created_at.lte.${end}),and(stage.eq.won,won_at.gte.${start},won_at.lte.${end})`);
    let inqQuery = supabase.from('inquiries').select('*').gte('created_at', start).lte('created_at', end);
    let kraLogsQuery = supabase.from('kra_logs').select('*').gte('created_at', start).lte('created_at', end);
    let visitsQuery = supabase.from('customer_visits').select('*').gte('visited_at', start).lte('visited_at', end);
    let complaintsQuery = supabase.from('complaints').select('*').gte('reported_at', start).lte('reported_at', end);
    let paymentsQuery = supabase.from('payment_tracking').select('*');
    let recurringQuery = supabase.from('recurring_customers').select('*').eq('is_active', true);

    if (scope.phones !== null) {
      if (scope.phones.length === 1) {
        dealsQuery = dealsQuery.eq('salesperson_phone', scope.phones[0]);
        inqQuery = inqQuery.eq('salesperson_phone', scope.phones[0]);
        kraLogsQuery = kraLogsQuery.eq('salesperson_phone', scope.phones[0]);
        visitsQuery = visitsQuery.eq('salesperson_phone', scope.phones[0]);
        complaintsQuery = complaintsQuery.eq('reported_by', scope.phones[0]);
        paymentsQuery = paymentsQuery.eq('salesperson_phone', scope.phones[0]);
        recurringQuery = recurringQuery.eq('assigned_salesperson_phone', scope.phones[0]);
      } else {
        dealsQuery = dealsQuery.in('salesperson_phone', scope.phones);
        inqQuery = inqQuery.in('salesperson_phone', scope.phones);
        kraLogsQuery = kraLogsQuery.in('salesperson_phone', scope.phones);
        visitsQuery = visitsQuery.in('salesperson_phone', scope.phones);
        complaintsQuery = complaintsQuery.in('reported_by', scope.phones);
        paymentsQuery = paymentsQuery.in('salesperson_phone', scope.phones);
        recurringQuery = recurringQuery.in('assigned_salesperson_phone', scope.phones);
      }
    }

    // Fetch all data in parallel
    const [
      dealsResult,
      inquiriesResult,
      kraLogsResult,
      visitsResult,
      complaintsResult,
      paymentsResult,
      recurringResult
    ] = await Promise.all([
      dealsQuery,
      inqQuery,
      kraLogsQuery,
      visitsQuery,
      complaintsQuery,
      paymentsQuery,
      recurringQuery
    ]);

    const deals = dealsResult.data || [];
    const inquiries = inquiriesResult.data || [];
    const kraLogs = kraLogsResult.data || [];
    const visits = visitsResult.data || [];
    const complaints = complaintsResult.data || [];
    const payments = paymentsResult.data || [];
    const recurring = recurringResult.data || [];

    // KRA 1 - Sales Achievement
    const dealsCreatedThisMonth = deals.filter(d => d.created_at >= start && d.created_at <= end);
    const wonDealsList = deals.filter(d => {
      if (d.stage !== 'won') return false;
      const dealDate = d.won_at || d.created_at;
      return dealDate >= start && dealDate <= end;
    });
    const totalDeals = dealsCreatedThisMonth.length;
    const wonDeals = wonDealsList.length;
    const totalValue = wonDealsList.reduce(
      (sum, d) => sum + (Number(d.total_amount) || 0), 0
    );

    // KRA 2 - New Customer Acquisition (distinct customer names)
    const newCustomers = new Set(
      kraLogs
        .filter(l => l.kra_number === 2 && l.kra_type === 'new_customer')
        .map(l => (l.customer_name || '').toLowerCase().trim())
        .filter(Boolean)
    ).size;

    // KRA 3 - Customer Retention (distinct active recurring customers who ordered)
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

    // KRA 4 - Enquiry Conversion (consistent with dashboard: won deals / total deals created)
    const totalInquiries = totalDeals;
    const conversionRate = totalInquiries > 0
      ? Math.round((wonDeals / totalInquiries) * 100)
      : 0;

    // KRA 5 - Payment Collection
    const pendingPayments = payments.filter(
      p => p.status === 'pending' || p.status === 'partial'
    );
    const collectedPayments = payments.filter(
      p => p.status === 'collected'
    );
    const overduePayments = pendingPayments.filter(
      p => p.due_date && new Date(p.due_date) < now
    );
    const collectedAmount = payments.reduce(
      (sum, p) => sum + (Number(p.collected_amount) || 0), 0
    );
    const totalOutstanding = pendingPayments.reduce(
      (sum, p) => sum + (p.outstanding !== null && p.outstanding !== undefined ? Number(p.outstanding) : Number(p.invoice_amount || 0)), 0
    );

    // KRA 6 - CRM Compliance (accurate: count distinct days with ANY kra_log OR deal/inquiry activity)
    const workingDays = 26;
    const activityDates = new Set([
      ...kraLogs.map(l => new Date(l.created_at).toDateString()),
      ...deals.map(d => new Date(d.created_at).toDateString()),
      ...inquiries.map(i => new Date(i.created_at).toDateString()),
    ]);
    const daysWithActivity = activityDates.size;
    const crmCompliance = Math.min(
      100, Math.round((daysWithActivity / workingDays) * 100)
    );

    // KRA 7 - Zero Rejection
    const rejections = kraLogs.filter(
      l => l.kra_number === 7
    ).length;

    // KRA 8 - Complaint Resolution
    const totalComplaints = complaints.length;
    const resolvedComplaints = complaints.filter(
      c => c.status === 'resolved'
    );
    const withinTarget = resolvedComplaints.filter(
      c => (c.resolution_time_hrs || 0) <= 48
    ).length;
    const avgResolutionTime = resolvedComplaints.length > 0
      ? Math.round(
          resolvedComplaints.reduce(
            (sum, c) => sum + (c.resolution_time_hrs || 0), 0
          ) / resolvedComplaints.length
        )
      : 0;

    // KRA 9 - Customer Visits
    const totalVisits = visits.length;
    const visitDays = new Set(
      visits.map(v => new Date(v.visited_at).toDateString())
    ).size;
    const weeksInMonth = 4;
    const targetVisits = weeksInMonth * 10;
    const targetDays = weeksInMonth * 3;

    // Build report
    const report =
      `📊 *MONTHLY PERFORMANCE & SALES REPORT*\n` +
      `${monthName} ${year}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +

      `*1️⃣ Sales Achievement*\n` +
      `Deals: ${totalDeals} | Won: ${wonDeals}\n` +
      `Value: ${formatINR(totalValue)}\n` +
      `${totalValue > 0 ? '✅' : '⚠️'} ` +
      `${totalValue > 0 ? 'Sales logged' : 'No sales yet'}\n\n` +

      `*2️⃣ New Customer Acquisition*\n` +
      `Acquired: ${newCustomers}/3\n` +
      `${newCustomers >= 3 ? '✅ Target met!' : `⚠️ ${3 - newCustomers} more needed`}\n\n` +

      `*3️⃣ Customer Retention & Order Frequency*\n` +
      `Recurring customers: ${recurring.length}\n` +
      `Ordered this month: ${uniqueRecurringWithOrder}\n` +
      `${retentionRate >= 80 ? '✅' : '⚠️'} Retention: ${retentionRate}%\n\n` +

      `*4️⃣ Enquiry & Pipeline Conversion*\n` +
      `Inquiries: ${totalInquiries} | Won: ${wonDeals}\n` +
      `${conversionRate >= 70 ? '✅' : '⚠️'} Rate: ${conversionRate}%` +
      ` (target: 70-80%)\n\n` +

      `*5️⃣ Payment Collection & Outstanding*\n` +
      `Collected: ${formatINR(collectedAmount)}\n` +
      `Pending: ${pendingPayments.length}\n` +
      `🔴 Overdue: ${overduePayments.length}\n` +
      `Outstanding: ${formatINR(totalOutstanding)}\n\n` +

      `*6️⃣ CRM & Zoho Bigin Sync*\n` +
      `Active days: ${daysWithActivity}/${workingDays}\n` +
      `${crmCompliance >= 90 ? '✅' : '⚠️'} Compliance: ${crmCompliance}%\n\n` +

      `*7️⃣ Order Accuracy & Zero Rejection*\n` +
      `${rejections === 0 ? '✅ Zero rejections!' : `⚠️ ${rejections} rejection(s) logged`}\n\n` +

      `*8️⃣ Customer Complaint Resolution*\n` +
      `Total: ${totalComplaints} | Resolved: ${resolvedComplaints.length}\n` +
      `Within 48h: ${withinTarget}/${resolvedComplaints.length}\n` +
      `${avgResolutionTime > 0 ? `Avg: ${avgResolutionTime}h\n` : ''}` +
      `${totalComplaints === 0 || withinTarget === resolvedComplaints.length ? '✅' : '⚠️'} ` +
      `${totalComplaints === 0 ? 'No complaints!' : 'Resolution tracked'}\n\n` +

      `*9️⃣ Field Customer Visits*\n` +
      `Visits: ${totalVisits}/${targetVisits}\n` +
      `Field days: ${visitDays}/${targetDays}\n` +
      `${totalVisits >= targetVisits ? '✅' : '⚠️'} ` +
      `${totalVisits >= targetVisits ? 'Visit target met!' : `${targetVisits - totalVisits} more visits needed`}\n\n` +

      `━━━━━━━━━━━━━━━━━━━━\n` +
      `_Generated by Enlight Sales OS_`;

    return report;
  } catch (error) {
    console.error('generateFullKRAReport error:', error.message);
    return '❌ Could not generate KRA report. Please try again.';
  }
}

module.exports = { generateFullKRAReport };
