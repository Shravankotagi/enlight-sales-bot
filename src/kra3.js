const { createClient } = require('@supabase/supabase-js');
const { sendTextMessage } = require('./whatsapp');

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

/**
 * Format currency in Indian Rupees
 */
function formatINR(val) {
  if (!val || isNaN(val)) return '₹0';
  return '₹' + Number(val).toLocaleString('en-IN');
}

/**
 * Extracts follow-up duration X (in days) from user text, or returns defaultDays.
 * Handles "follow up in 5 days", "remind me after 7 days", "in 4 days", "3 din baad", etc.
 */
function extractFollowupDays(text, defaultDays = 3) {
  if (!text || typeof text !== 'string') return defaultDays;
  const lower = text.toLowerCase();

  const m1 = lower.match(/(?:follow\s*up|remind(?:\s*me)?|after|in|decide\s*in|within)\s*(?:in|after)?\s*(\d+)\s*(?:days?|din)/i);
  if (m1 && m1[1]) {
    const d = parseInt(m1[1], 10);
    if (!isNaN(d) && d > 0 && d <= 90) return d;
  }

  const m2 = lower.match(/\b(\d+)\s*(?:days?|din)\s*(?:baad|later|after|followup|follow\s*up)/i);
  if (m2 && m2[1]) {
    const d = parseInt(m2[1], 10);
    if (!isNaN(d) && d > 0 && d <= 90) return d;
  }

  return defaultDays;
}

/**
 * Finds Sales Manager phone for a given salesperson phone.
 */
async function getSalesManagerPhone(salespersonPhone, supabaseClient) {
  const supabase = supabaseClient || getSupabase();
  if (!salespersonPhone) return process.env.SALES_LEAD_PHONE || null;
  const clean = String(salespersonPhone).replace(/\D/g, '').slice(-10);

  try {
    const { data: emps } = await supabase
      .from('employees')
      .select('id, employee_id, phone, name, role, manager_phone, manager_id, reports_to_employee_id');

    if (!emps || emps.length === 0) return process.env.SALES_LEAD_PHONE || null;

    const rep = emps.find(e => (e.phone || '').replace(/\D/g, '').slice(-10) === clean);
    if (rep) {
      if (rep.manager_phone) return rep.manager_phone;
      if (rep.manager_id) {
        const mgr = emps.find(e => e.id === rep.manager_id);
        if (mgr?.phone) return mgr.phone;
      }
      if (rep.reports_to_employee_id) {
        const mgr = emps.find(e => e.employee_id === rep.reports_to_employee_id);
        if (mgr?.phone) return mgr.phone;
      }
    }

    // Fallback: active sales_manager
    const activeMgr = emps.find(e => (e.role === 'sales_manager' || e.role === 'manager') && e.phone);
    if (activeMgr?.phone) return activeMgr.phone;

  } catch (err) {
    console.warn('[FollowUp Engine] Manager phone lookup notice:', err.message);
  }

  return process.env.SALES_LEAD_PHONE || null;
}

/**
 * Formats enriched follow-up alert according to mandatory specifications.
 */
function buildEnrichedFollowupAlert({
  recipientRole = 'salesperson', // 'salesperson' | 'manager'
  customerName,
  dealId = null,
  poNumber = null,
  stage = null,
  product = 'Metal Requirements',
  lastAction = 'Initial Discussion',
  daysElapsed = 3,
  scheduleDays = 3,
  taskId = null,
  salespersonName = null,
}) {
  const isWon = stage === 'won' || Boolean(poNumber);
  const identifierStr = isWon
    ? (poNumber ? `PO: *${poNumber}*` : (dealId ? `Deal ID: *#${dealId}*` : ''))
    : (dealId ? `Deal ID: *#${dealId}*` : '');

  const productStr = product || 'Metal Requirements';
  const roleHeader = recipientRole === 'manager'
    ? `🚨 *Manager Follow-up Alert* (Day ${scheduleDays})`
    : `🔔 *Sales Follow-up Alert* (Day ${scheduleDays})`;

  const repLine = (recipientRole === 'manager' && salespersonName)
    ? `👤 Assigned Rep: *${salespersonName}*\n`
    : '';

  return `${roleHeader}\n\n` +
    `🏢 Customer: *${customerName}*\n` +
    (identifierStr ? `🔖 ${identifierStr}\n` : '') +
    `📦 Product: *${productStr}*\n` +
    `📝 Last Action: *${lastAction}*\n` +
    `⏳ Elapsed: *${daysElapsed} days since last activity*\n` +
    `${repLine}\n` +
    `*Follow up required with ${customerName} regarding ${productStr}*.\n\n` +
    `Reply to update or close:\n` +
    `• "Called ${customerName} [outcome]"\n` +
    `• "Visited ${customerName} [outcome]"\n` +
    `• "Ordered ${customerName} [amount]"\n` +
    `• "Lost ${customerName} [reason]"\n` +
    (taskId ? `\n_Ref: ${taskId.substring(0, 8)}_` : '');
}

/**
 * Main Follow-up Orchestrator:
 * Executes the two valid follow-up alert conditions:
 * 1. Condition 1 - Order Frequency Follow-up (Salesperson at X / 3 days, Manager at X+2 / 5 days)
 * 2. Condition 2 - Visit Interest Follow-up (Salesperson at X / 3 days, Manager at X+2 / 5 days)
 */
async function checkRecurringCustomers() {
  const supabase = getSupabase();
  try {
    console.log('[FollowUp Engine] Running configurable follow-up alert checks...');
    await checkOrderFrequencyFollowups(supabase);
    await checkVisitInterestFollowups(supabase);
    console.log('[FollowUp Engine] Follow-up alert checks completed successfully.');
  } catch (error) {
    console.error('[FollowUp Engine] checkRecurringCustomers error:', error);
  }
}

/**
 * CONDITION 1 - Order Frequency Follow-up
 */
async function checkOrderFrequencyFollowups(supabase) {
  const now = new Date();

  const { data: customers, error } = await supabase
    .from('recurring_customers')
    .select('*')
    .eq('is_active', true);

  if (error || !customers || customers.length === 0) return;

  for (const customer of customers) {
    try {
      const spPhone = customer.assigned_salesperson_phone;
      if (!spPhone) continue;

      // Find the most recent won order/deal for this customer
      const { data: wonDeals } = await supabase
        .from('deals')
        .select('id, total_amount, won_at, created_at, po_number, stage, product_name, material_grade, deal_items(*)')
        .ilike('customer_name', `%${customer.customer_name}%`)
        .eq('stage', 'won')
        .order('won_at', { ascending: false })
        .limit(1);

      const lastDeal = wonDeals && wonDeals.length > 0 ? wonDeals[0] : null;
      const lastOrderDateStr = lastDeal?.won_at || lastDeal?.created_at || customer.last_order_date;

      if (!lastOrderDateStr) continue; // Never ordered before

      const lastOrderDate = new Date(lastOrderDateStr);
      if (isNaN(lastOrderDate.getTime())) continue;

      const daysSinceOrder = Math.floor((now - lastOrderDate) / (1000 * 60 * 60 * 24));
      const freqDays = Number(customer.avg_order_frequency_days) || 30;

      // Order frequency has not elapsed yet
      if (daysSinceOrder <= freqDays) continue;

      const daysOverdue = daysSinceOrder - freqDays;
      const spThresholdDays = 3;
      const mgrThresholdDays = 5;

      // Check existing task for this cycle
      const { data: existingTasks } = await supabase
        .from('followup_tasks')
        .select('*')
        .ilike('customer_name', `%${customer.customer_name}%`)
        .in('task_type', ['order_frequency_followup', 'kra3_retention'])
        .order('created_at', { ascending: false })
        .limit(1);

      const existingTask = existingTasks && existingTasks.length > 0 ? existingTasks[0] : null;

      // If resolved after last order, skip
      if (existingTask && (existingTask.status === 'resolved' || existingTask.status === 'closed')) {
        const resolvedDate = new Date(existingTask.resolved_at || existingTask.created_at);
        if (resolvedDate > lastOrderDate) continue;
      }

      let currentTask = existingTask;
      if (!currentTask || currentTask.status === 'resolved' || currentTask.status === 'closed') {
        const { data: newTask } = await supabase
          .from('followup_tasks')
          .insert({
            task_type: 'order_frequency_followup',
            customer_name: customer.customer_name,
            customer_phone: customer.customer_phone || '',
            salesperson_phone: spPhone,
            due_date: new Date(lastOrderDate.getTime() + (freqDays + spThresholdDays) * 24 * 60 * 60 * 1000).toISOString(),
            status: 'pending',
            reminder_sent_at: null,
            escalated_at: null,
            follow_up_count: 0,
            resolution_notes: `Order frequency elapsed: ${daysSinceOrder} days since last order (configured cycle: ${freqDays} days).`,
          })
          .select()
          .single();
        currentTask = newTask;
      }

      const product = lastDeal?.product_name || lastDeal?.material_grade || 'HR / CR Steel Products';
      const lastAction = `Won Order (${lastDeal?.po_number || '#' + (lastDeal?.id || '').slice(0, 8)}) on ${lastOrderDate.toLocaleDateString('en-IN')}`;

      // 1. Salesperson Alert: Trigger at 3 days overdue (or every 3 days)
      if (daysOverdue >= spThresholdDays && (!currentTask?.reminder_sent_at || (now - new Date(currentTask.reminder_sent_at)) / (1000 * 60 * 60) >= 72)) {
        const spMsg = buildEnrichedFollowupAlert({
          recipientRole: 'salesperson',
          customerName: customer.customer_name,
          dealId: lastDeal?.id,
          poNumber: lastDeal?.po_number,
          stage: lastDeal?.stage,
          product,
          lastAction,
          daysElapsed: daysSinceOrder,
          scheduleDays: spThresholdDays,
          taskId: currentTask?.id,
        });

        await sendTextMessage(spPhone, spMsg);
        await supabase.from('followup_tasks').update({
          reminder_sent_at: now.toISOString(),
          follow_up_count: (currentTask?.follow_up_count || 0) + 1,
        }).eq('id', currentTask.id);

        console.log(`[Order Frequency Followup] Sent Salesperson alert (Day 3) to ${spPhone} for ${customer.customer_name}`);
      }

      // 2. Manager Alert: Trigger at 5 days overdue (or every 5 days)
      if (daysOverdue >= mgrThresholdDays && (!currentTask?.escalated_at || (now - new Date(currentTask.escalated_at)) / (1000 * 60 * 60) >= 120)) {
        const mgrPhone = await getSalesManagerPhone(spPhone, supabase);
        if (mgrPhone) {
          const mgrMsg = buildEnrichedFollowupAlert({
            recipientRole: 'manager',
            customerName: customer.customer_name,
            dealId: lastDeal?.id,
            poNumber: lastDeal?.po_number,
            stage: lastDeal?.stage,
            product,
            lastAction,
            daysElapsed: daysSinceOrder,
            scheduleDays: mgrThresholdDays,
            taskId: currentTask?.id,
            salespersonName: customer.assigned_salesperson_name || spPhone,
          });

          await sendTextMessage(mgrPhone, mgrMsg);
          await supabase.from('followup_tasks').update({
            escalated_at: now.toISOString(),
          }).eq('id', currentTask.id);

          console.log(`[Order Frequency Followup] Sent Manager alert (Day 5) to ${mgrPhone} for ${customer.customer_name}`);
        }
      }

      await new Promise(r => setTimeout(r, 300));
    } catch (custErr) {
      console.error(`[Order Frequency Followup] Error for ${customer.customer_name}:`, custErr.message);
    }
  }
}

/**
 * CONDITION 2 - Visit Interest Follow-up
 */
async function checkVisitInterestFollowups(supabase) {
  const now = new Date();

  const { data: visitTasks, error } = await supabase
    .from('followup_tasks')
    .select('*')
    .eq('task_type', 'visit_interest_followup')
    .eq('status', 'pending');

  if (error || !visitTasks || visitTasks.length === 0) return;

  for (const task of visitTasks) {
    try {
      const spPhone = task.salesperson_phone;
      if (!spPhone) continue;

      const createdDate = task.created_at ? new Date(task.created_at) : now;
      const daysSinceVisit = Math.floor((now - createdDate) / (1000 * 60 * 60 * 24));

      // Parse custom promised days X from notes, or default to 3
      const customDaysMatch = (task.resolution_notes || '').match(/decision timeframe:\s*(\d+)/i);
      const spScheduleDays = customDaysMatch ? parseInt(customDaysMatch[1], 10) : 3;
      const mgrScheduleDays = spScheduleDays + 2; // e.g. 5 days or X + 2

      // Check if any won deal was closed since the visit task was created
      const { data: recentOrders } = await supabase
        .from('deals')
        .select('id, total_amount, stage, won_at, po_number')
        .ilike('customer_name', `%${task.customer_name}%`)
        .eq('stage', 'won')
        .gte('created_at', task.created_at || new Date(now.getTime() - 14 * 86400000).toISOString());

      if (recentOrders && recentOrders.length > 0) {
        await supabase
          .from('followup_tasks')
          .update({
            status: 'resolved',
            resolved_at: now.toISOString(),
            resolution_notes: `Auto-resolved: Won order received (${recentOrders[0].po_number || '#' + recentOrders[0].id.slice(0, 8)})`,
          })
          .eq('id', task.id);
        console.log(`[Visit Interest Followup] Auto-resolved task for ${task.customer_name} (Order received)`);
        continue;
      }

      // Extract product details
      let product = 'Metal Requirements';
      const prodMatch = (task.resolution_notes || '').match(/interest in\s+([^.]+)/i) || (task.resolution_notes || '').match(/requirement:\s*([^|\]]+)/i);
      if (prodMatch) product = prodMatch[1].trim();

      const lastAction = `Site Visit logged on ${createdDate.toLocaleDateString('en-IN')}`;

      // 1. Salesperson Alert at X days (or default 3)
      if (daysSinceVisit >= spScheduleDays && (!task.reminder_sent_at || (now - new Date(task.reminder_sent_at)) / (1000 * 60 * 60) >= (spScheduleDays * 24))) {
        const spMsg = buildEnrichedFollowupAlert({
          recipientRole: 'salesperson',
          customerName: task.customer_name,
          dealId: null,
          poNumber: null,
          stage: null,
          product,
          lastAction,
          daysElapsed: daysSinceVisit,
          scheduleDays: spScheduleDays,
          taskId: task.id,
        });

        await sendTextMessage(spPhone, spMsg);
        await supabase.from('followup_tasks').update({
          reminder_sent_at: now.toISOString(),
          follow_up_count: (task.follow_up_count || 0) + 1,
        }).eq('id', task.id);

        console.log(`[Visit Interest Followup] Sent Salesperson alert (Day ${spScheduleDays}) to ${spPhone} for ${task.customer_name}`);
      }

      // 2. Manager Alert at X + 2 days (or default 5)
      if (daysSinceVisit >= mgrScheduleDays && (!task.escalated_at || (now - new Date(task.escalated_at)) / (1000 * 60 * 60) >= (mgrScheduleDays * 24))) {
        const mgrPhone = await getSalesManagerPhone(spPhone, supabase);
        if (mgrPhone) {
          const mgrMsg = buildEnrichedFollowupAlert({
            recipientRole: 'manager',
            customerName: task.customer_name,
            dealId: null,
            poNumber: null,
            stage: null,
            product,
            lastAction,
            daysElapsed: daysSinceVisit,
            scheduleDays: mgrScheduleDays,
            taskId: task.id,
            salespersonName: spPhone,
          });

          await sendTextMessage(mgrPhone, mgrMsg);
          await supabase.from('followup_tasks').update({
            escalated_at: now.toISOString(),
          }).eq('id', task.id);

          console.log(`[Visit Interest Followup] Sent Manager alert (Day ${mgrScheduleDays}) to ${mgrPhone} for ${task.customer_name}`);
        }
      }

      await new Promise(r => setTimeout(r, 300));
    } catch (taskErr) {
      console.error(`[Visit Interest Followup] Error for task ${task.id}:`, taskErr.message);
    }
  }
}

/**
 * Auto-resolves open follow-up tasks when a new activity is logged on that customer or deal.
 */
async function resolveCustomerFollowupTasks(customerName, senderPhone, activityType = 'activity_logged', dealId = null) {
  if (!customerName) return;
  const supabase = getSupabase();
  try {
    const nowIso = new Date().toISOString();
    let query = supabase
      .from('followup_tasks')
      .update({
        status: 'resolved',
        resolved_at: nowIso,
        resolution_notes: `Auto-resolved: ${activityType} logged by rep`,
      })
      .ilike('customer_name', `%${customerName}%`)
      .eq('status', 'pending');

    await query;
    console.log(`[FollowUp Engine] Auto-resolved pending follow-up tasks for ${customerName} (${activityType})`);
  } catch (err) {
    console.warn(`[FollowUp Engine] Error resolving follow-up tasks for ${customerName}:`, err.message);
  }
}

/**
 * Handles Salesperson reply to any follow-up task (resolves task & logs KRA 3 credit)
 */
async function handleFollowUpReply(text, senderPhone) {
  const supabase = getSupabase();
  const upper = text.toUpperCase().trim();

  const actions = ['VISITED', 'CALLED', 'LOST', 'ORDERED', 'FOLLOWED', 'FOLLOW-UP', 'FOLLOWUP'];
  const matchedAction = actions.find(a => upper.startsWith(a));

  if (!matchedAction) return null;

  try {
    const { data: openTasks } = await supabase
      .from('followup_tasks')
      .select('*')
      .eq('salesperson_phone', senderPhone)
      .eq('status', 'pending');

    let task = null;
    let customerKeyword = '';
    let outcome = '';

    if (openTasks && openTasks.length > 0) {
      task = openTasks.find(t => {
        if (!t.customer_name) return false;
        const nameLower = t.customer_name.toLowerCase();
        if (text.toLowerCase().includes(nameLower)) return true;
        const words = nameLower.split(/\s+/);
        return words.some(w => w.length > 3 && text.toLowerCase().includes(w));
      });
    }

    if (task) {
      customerKeyword = task.customer_name;
      let tempOutcome = text;
      const regexAction = new RegExp(`^${matchedAction}\\s*(up|with|about|for|recurring|customer|client|on)*\\s*`, 'i');
      tempOutcome = tempOutcome.replace(regexAction, '');
      if (tempOutcome.toLowerCase().includes(task.customer_name.toLowerCase())) {
        tempOutcome = tempOutcome.replace(new RegExp(task.customer_name, 'gi'), '');
      }
      outcome = tempOutcome.replace(/^[\s:,\-]+/, '').trim() || 'Completed follow-up';

      await supabase
        .from('followup_tasks')
        .update({
          status: 'resolved',
          resolved_at: new Date().toISOString(),
          resolution_notes: `${matchedAction}: ${outcome}`,
        })
        .eq('id', task.id);
    } else {
      let cleanText = text.replace(/^(visited|called|lost|ordered|followed up with|follow up with|followed|followup|follow-up)\s+/i, '');
      const parts = cleanText.split(/[\s:,\-]+/);
      customerKeyword = parts[0] || 'Customer';
      outcome = cleanText.replace(new RegExp(`^${customerKeyword}`, 'i'), '').replace(/^[\s:,\-]+/, '').trim() || 'Follow-up logged';
    }

    // Log KRA 3 retention credit
    await supabase.from('kra_logs').insert({
      salesperson_phone: senderPhone,
      kra_number: 3,
      kra_type: 'customer_retention',
      description: `${matchedAction} ${customerKeyword}: ${outcome}`,
      customer_name: task?.customer_name || customerKeyword,
      month: new Date().getMonth() + 1,
      year: new Date().getFullYear(),
    });

    const emojiMap = {
      VISITED: '🚗',
      CALLED: '📞',
      LOST: '❌',
      ORDERED: '🎉',
      FOLLOWED: '🔄',
      'FOLLOW-UP': '🔄',
      FOLLOWUP: '🔄',
    };
    const emoji = emojiMap[matchedAction.toUpperCase()] || '🔄';

    return `${emoji} *Follow-up Recorded*\n\n` +
      `Action: *${matchedAction}*\n` +
      `Customer: *${task?.customer_name || customerKeyword}*\n` +
      `Outcome: *${outcome}*\n\n` +
      `Customer Retention (KRA 3) updated! ✅`;
  } catch (error) {
    console.error('handleFollowUpReply error:', error);
    return '❌ Could not log follow-up. Please try again.';
  }
}

module.exports = {
  extractFollowupDays,
  getSalesManagerPhone,
  buildEnrichedFollowupAlert,
  checkRecurringCustomers,
  checkOrderFrequencyFollowups,
  checkVisitInterestFollowups,
  resolveCustomerFollowupTasks,
  handleFollowUpReply,
};

