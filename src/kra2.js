const { createClient } = require('@supabase/supabase-js');
const { sendTextMessage } = require('./whatsapp');

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

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

// Check if customer is new (no won deals before this month and not already logged in KRA 2)
async function isNewCustomer(customerName, salespersonPhone) {
  if (!customerName) return false;
  const supabase = getSupabase();
  try {
    const { start } = getMonthRange();

    // Check if there are any won deals before the current month
    const { data: previousWonDeals } = await supabase
      .from('deals')
      .select('id')
      .ilike('customer_name', `%${customerName}%`)
      .eq('stage', 'won')
      .lt('created_at', start);

    if (previousWonDeals && previousWonDeals.length > 0) {
      return false;
    }

    // Check if salesperson has already logged this customer as a new customer in KRA 2
    if (salespersonPhone) {
      const { data: existingLogs } = await supabase
        .from('kra_logs')
        .select('id')
        .eq('kra_number', 2)
        .eq('salesperson_phone', salespersonPhone)
        .ilike('customer_name', `%${customerName}%`);

      if (existingLogs && existingLogs.length > 0) {
        return false;
      }
    }

    return true;
  } catch (error) {
    console.error('isNewCustomer error:', error.message);
    return false;
  }
}

// Log new customer acquisition to KRA 2
async function logNewCustomer(deal, senderPhone) {
  const supabase = getSupabase();
  try {
    await supabase.from('kra_logs').insert({
      salesperson_phone: senderPhone,
      kra_number: 2,
      kra_type: 'new_customer',
      description: `New customer: ${deal.customer_name} - ${deal.inquiry_type}`,
      customer_name: deal.customer_name,
      value: deal.total_amount || 0,
      month: new Date().getMonth() + 1,
      year: new Date().getFullYear()
    });

    console.log('KRA 2 logged for new customer:', deal.customer_name);

    // Get current month new customer count
    const { start, end, monthName } = getMonthRange();
    const { data: newCustomers } = await supabase
      .from('kra_logs')
      .select('id')
      .eq('kra_number', 2)
      .eq('kra_type', 'new_customer')
      .eq('salesperson_phone', senderPhone)
      .gte('created_at', start)
      .lte('created_at', end);

    const count = newCustomers?.length || 1;
    const remaining = Math.max(0, 3 - count);

    // Send notification to salesperson
    const message =
      `🆕 *KRA 2 - New Customer Detected!*\n\n` +
      `🏢 ${deal.customer_name}\n` +
      `📋 Type: ${deal.inquiry_type}\n` +
      (deal.total_amount
        ? `💰 Value: ₹${Number(deal.total_amount).toLocaleString('en-IN')}\n`
        : '') +
      `\n📊 *${monthName} Progress*\n` +
      `New customers: ${count}/3\n` +
      (remaining > 0
        ? `${remaining} more needed to meet target`
        : `✅ Monthly target achieved!`);

    await sendTextMessage(senderPhone, message);
    return count;
  } catch (error) {
    console.error('logNewCustomer error:', error.message);
    return 0;
  }
}

// Get KRA 2 summary
async function getNewCustomerSummary(scopeOrPhone) {
  const supabase = getSupabase();
  try {
    const { getAccessibleSalespersonPhonesForBot } = require('./supabase');
    const scope = typeof scopeOrPhone === 'object' && scopeOrPhone !== null
      ? scopeOrPhone
      : await getAccessibleSalespersonPhonesForBot(scopeOrPhone);

    const { start, end, monthName, year } = getMonthRange();

    if (scope.isManager && (!scope.phones || scope.phones.length === 0)) {
      return `👥 *KRA 2 - New Customers*\n${monthName} ${year}\n\nAcquired: 0/3\n⚠️ No salespersons assigned to your team yet.`;
    }

    let query = supabase
      .from('kra_logs')
      .select('*')
      .eq('kra_number', 2)
      .eq('kra_type', 'new_customer')
      .gte('created_at', start)
      .lte('created_at', end);

    if (scope.phones !== null) {
      if (scope.phones.length === 1) {
        query = query.eq('salesperson_phone', scope.phones[0]);
      } else {
        query = query.in('salesperson_phone', scope.phones);
      }
    }

    const { data: logs } = await query;

    const count = logs?.length || 0;
    const remaining = Math.max(0, 3 - count);

    let msg = `👥 *KRA 2 - New Customers*\n` +
      `${monthName} ${year}\n\n` +
      `Acquired: ${count}/3\n` +
      (remaining > 0
        ? `⚠️ ${remaining} more needed\n`
        : `✅ Target achieved!\n`);

    if (logs && logs.length > 0) {
      msg += `\nNew customers this month:\n`;
      logs.forEach((l, i) => {
        msg += `${i + 1}. ${l.customer_name || 'Unknown'}\n`;
      });
    }

    return msg;
  } catch (error) {
    console.error('getNewCustomerSummary error:', error.message);
    return '❌ Could not fetch KRA 2 data.';
  }
}

module.exports = { isNewCustomer, logNewCustomer, getNewCustomerSummary, handleNewCustomerAnnouncement };

// Handle when salesperson directly announces a new customer (via Gemini intent routing)
async function handleNewCustomerAnnouncement(customerName, senderPhone) {
  const supabase = getSupabase();
  try {
    if (!customerName) {
      return `⚠️ Could not detect a customer name in your message. Please mention the customer name clearly.\n\nExample: _"New customer acquired: ABC Industries"_`;
    }

    // Check if already logged this customer in KRA 2
    const { data: existingLogs } = await supabase
      .from('kra_logs')
      .select('id')
      .eq('kra_number', 2)
      .eq('salesperson_phone', senderPhone)
      .ilike('customer_name', `%${customerName}%`);

    if (existingLogs && existingLogs.length > 0) {
      return `ℹ️ *Already Logged*\n\n${customerName} was already recorded as a new customer acquisition for you this month.`;
    }

    // Log to KRA 2
    const { monthName, year, start, end } = getMonthRange();
    await supabase.from('kra_logs').insert({
      salesperson_phone: senderPhone,
      kra_number: 2,
      kra_type: 'new_customer',
      description: `New customer onboarded: ${customerName}`,
      customer_name: customerName,
      value: 0,
      month: new Date().getMonth() + 1,
      year: new Date().getFullYear()
    });

    // Get updated count
    const { data: allLogs } = await supabase
      .from('kra_logs')
      .select('id')
      .eq('kra_number', 2)
      .eq('kra_type', 'new_customer')
      .eq('salesperson_phone', senderPhone)
      .gte('created_at', start)
      .lte('created_at', end);

    const count = allLogs?.length || 1;
    const remaining = Math.max(0, 3 - count);

    return `🆕 *KRA 2 - New Customer Logged!*\n\n` +
      `🏢 Customer: *${customerName}*\n` +
      `✅ Recorded as new customer acquisition\n\n` +
      `📊 *${monthName} ${year} Progress*\n` +
      `New customers: ${count}/3\n` +
      (remaining > 0
        ? `⚠️ ${remaining} more needed to meet target`
        : `✅ Monthly target achieved!`);
  } catch (error) {
    console.error('handleNewCustomerAnnouncement error:', error.message);
    return '❌ Could not log new customer. Please try again.';
  }
}

