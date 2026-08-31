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
 * Main Follow-up Orchestrator:
 * Executes ONLY the two valid follow-up alert conditions:
 * 1. Condition 1 - Order Frequency Follow-up
 * 2. Condition 2 - Visit Interest Follow-up
 */
async function checkRecurringCustomers() {
  const supabase = getSupabase();
  try {
    console.log('[FollowUp Engine] Running specific follow-up alert checks...');

    // 1. Condition 1: Order Frequency Follow-up
    await checkOrderFrequencyFollowups(supabase);

    // 2. Condition 2: Visit Interest Follow-up
    await checkVisitInterestFollowups(supabase);

    console.log('[FollowUp Engine] Follow-up alert checks completed successfully.');
  } catch (error) {
    console.error('[FollowUp Engine] checkRecurringCustomers error:', error);
  }
}

/**
 * CONDITION 1 - Order Frequency Follow-up
 * - Customer has previously placed an order.
 * - Configured order frequency days have elapsed since their last order.
 * - Customer has not placed a new order or responded after the frequency period.
 * - Alert references customer name, last order details, and usual frequency.
 */
async function checkOrderFrequencyFollowups(supabase) {
  const now = new Date();

  // Fetch all active recurring customers
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
        .select('id, total_amount, won_at, created_at, po_number, stage, deal_items(*)')
        .ilike('customer_name', `%${customer.customer_name}%`)
        .eq('stage', 'won')
        .order('won_at', { ascending: false })
        .limit(1);

      const lastDeal = wonDeals && wonDeals.length > 0 ? wonDeals[0] : null;
      const lastOrderDateStr = lastDeal?.won_at || lastDeal?.created_at || customer.last_order_date;

      // Prerequisite: Customer MUST have previously placed an order
      if (!lastOrderDateStr) {
        // Customer has never ordered before - does NOT qualify for order frequency follow-up
        continue;
      }

      const lastOrderDate = new Date(lastOrderDateStr);
      if (isNaN(lastOrderDate.getTime())) continue;

      const daysSinceOrder = Math.floor((now - lastOrderDate) / (1000 * 60 * 60 * 24));
      const freqDays = Number(customer.avg_order_frequency_days) || 30;

      // Check if frequency has elapsed
      if (daysSinceOrder <= freqDays) {
        // Still within healthy order frequency window - NO ALERT
        continue;
      }

      // Check if any open or resolved follow-up task exists for this cycle
      const { data: existingTasks } = await supabase
        .from('followup_tasks')
        .select('*')
        .ilike('customer_name', `%${customer.customer_name}%`)
        .in('task_type', ['order_frequency_followup', 'kra3_retention'])
        .order('created_at', { ascending: false })
        .limit(1);

      const existingTask = existingTasks && existingTasks.length > 0 ? existingTasks[0] : null;

      if (existingTask) {
        // If task was already resolved AFTER the last order date, condition is already addressed
        if (existingTask.status === 'resolved' || existingTask.status === 'closed') {
          const resolvedDate = new Date(existingTask.resolved_at || existingTask.created_at);
          if (resolvedDate > lastOrderDate) {
            continue; // Already resolved for this ordering gap
          }
        }

        // If open task exists, manage 48-hour reminders and escalation
        if (existingTask.status === 'pending' || existingTask.status === 'reorder_expected') {
          const lastReminder = existingTask.reminder_sent_at ? new Date(existingTask.reminder_sent_at) : null;
          const hoursSinceReminder = lastReminder ? (now - lastReminder) / (1000 * 60 * 60) : 999;

          if (hoursSinceReminder < 48) {
            continue; // De-duplicate: wait 48 hours between reminders
          }

          const newCount = (existingTask.follow_up_count || 1) + 1;
          await supabase
            .from('followup_tasks')
            .update({
              follow_up_count: newCount,
              reminder_sent_at: now.toISOString(),
              escalated_at: newCount >= 3 ? now.toISOString() : null,
            })
            .eq('id', existingTask.id);

          // If 3rd reminder, escalate to Sales Manager / Admin
          if (newCount >= 3) {
            const salesLeadPhone = process.env.SALES_LEAD_PHONE;
            if (salesLeadPhone) {
              const escalationMsg =
                `🚨 *Customer Reorder Follow-up Escalation*\n\n` +
                `🏢 *${customer.customer_name}*\n` +
                `Assigned Rep: ${spPhone}\n` +
                `Last order: ${daysSinceOrder} days ago (Cycle: ${freqDays} days)\n` +
                `Reminders sent: ${newCount}\n\n` +
                `No response or new order received. Please follow up with the rep.`;
              await sendTextMessage(salesLeadPhone, escalationMsg);
            }
          }

          const message = buildOrderFrequencyMessage(customer, lastDeal, daysSinceOrder, freqDays, newCount, existingTask.id);
          await sendTextMessage(spPhone, message);
          console.log(`[Order Frequency Followup] Sent reminder #${newCount} to ${spPhone} for ${customer.customer_name}`);
        }
      } else {
        // Create new follow-up task and send initial alert
        const { data: newTask } = await supabase
          .from('followup_tasks')
          .insert({
            task_type: 'order_frequency_followup',
            customer_name: customer.customer_name,
            customer_phone: customer.customer_phone || lastDeal?.customer_phone || '',
            salesperson_phone: spPhone,
            due_date: new Date(now.getTime() + 48 * 60 * 60 * 1000).toISOString(),
            status: 'pending',
            reminder_sent_at: now.toISOString(),
            follow_up_count: 1,
            resolution_notes: `Order frequency elapsed: ${daysSinceOrder} days since last order (configured cycle: ${freqDays} days).`,
          })
          .select()
          .single();

        const message = buildOrderFrequencyMessage(customer, lastDeal, daysSinceOrder, freqDays, 1, newTask?.id);
        await sendTextMessage(spPhone, message);
        console.log(`[Order Frequency Followup] Sent initial alert to ${spPhone} for ${customer.customer_name}`);
      }

      await new Promise(r => setTimeout(r, 500));
    } catch (custErr) {
      console.error(`[Order Frequency Followup] Error for ${customer.customer_name}:`, custErr.message);
    }
  }
}

/**
 * CONDITION 2 - Visit Interest Follow-up
 * - A visit was logged where customer showed interest in a product.
 * - Customer mentioned they will think and decide within a few days (follow-up date reached).
 * - No order received from that customer since the visit.
 * - Alert references specific visit, customer name, and specific product of interest.
 */
async function checkVisitInterestFollowups(supabase) {
  const now = new Date();

  // Query all pending visit interest follow-up tasks
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

      const dueDate = task.due_date ? new Date(task.due_date) : null;
      if (!dueDate || now < dueDate) {
        // Scheduled follow-up date has not arrived yet - DO NOT ALERT YET
        continue;
      }

      // Check if the customer has placed ANY won order since the visit task was created
      const taskCreatedDate = task.created_at || new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const { data: recentOrders } = await supabase
        .from('deals')
        .select('id, total_amount, stage, won_at, created_at')
        .ilike('customer_name', `%${task.customer_name}%`)
        .eq('stage', 'won')
        .gte('created_at', taskCreatedDate);

      if (recentOrders && recentOrders.length > 0) {
        // Order already received from this customer! Auto-resolve task and do NOT alert
        await supabase
          .from('followup_tasks')
          .update({
            status: 'resolved',
            resolved_at: now.toISOString(),
            resolution_notes: `Order received (Deal #${recentOrders[0].id.slice(0, 8)}). Visit follow-up fulfilled 🎉`,
          })
          .eq('id', task.id);
        console.log(`[Visit Interest Followup] Auto-resolved task for ${task.customer_name} (Order received)`);
        continue;
      }

      // Manage alert de-duplication (first trigger upon reaching due date, then every 48h)
      const lastReminder = task.reminder_sent_at ? new Date(task.reminder_sent_at) : null;
      if (lastReminder) {
        const hoursSince = (now - lastReminder) / (1000 * 60 * 60);
        if (hoursSince < 48) {
          continue; // De-duplicate: wait 48 hours between reminders
        }
      }

      const newCount = (task.follow_up_count || 0) + 1;
      await supabase
        .from('followup_tasks')
        .update({
          follow_up_count: newCount,
          reminder_sent_at: now.toISOString(),
          escalated_at: newCount >= 3 ? now.toISOString() : null,
        })
        .eq('id', task.id);

      const message = buildVisitInterestMessage(task, newCount);
      await sendTextMessage(spPhone, message);
      console.log(`[Visit Interest Followup] Sent alert #${newCount} to ${spPhone} for ${task.customer_name}`);

      await new Promise(r => setTimeout(r, 500));
    } catch (taskErr) {
      console.error(`[Visit Interest Followup] Error for task ${task.id}:`, taskErr.message);
    }
  }
}

function buildOrderFrequencyMessage(customer, lastDeal, daysSinceOrder, freqDays, reminderCount, taskId) {
  const shortId = taskId ? taskId.substring(0, 8) : 'N/A';
  const reminderText = reminderCount > 1 ? `\n⚠️ *Reminder #${reminderCount}*` : '';

  const lastOrderDateStr = lastDeal?.won_at || lastDeal?.created_at || customer.last_order_date;
  const formattedLastDate = lastOrderDateStr ? new Date(lastOrderDateStr).toLocaleDateString('en-IN') : 'Previous Order';
  const lastAmtStr = lastDeal?.total_amount ? ` (${formatINR(lastDeal.total_amount)})` : '';

  return `🔔 *Order Frequency Follow-up Alert*${reminderText}\n\n` +
    `🏢 *${customer.customer_name}*\n` +
    `📅 Last Order: *${formattedLastDate}*${lastAmtStr}\n` +
    `⏳ Elapsed: *${daysSinceOrder} days ago*\n` +
    `⏱️ Configured Cycle: Every *${freqDays} days*\n\n` +
    `The order frequency period has elapsed without a repeat order.\n\n` +
    `Please follow up with the client and reply:\n` +
    `✅ *ORDERED ${customer.customer_name.split(' ')[0].toUpperCase()} [amount]*\n` +
    `🚗 *VISITED ${customer.customer_name.split(' ')[0].toUpperCase()} [outcome]*\n` +
    `📞 *CALLED ${customer.customer_name.split(' ')[0].toUpperCase()} [outcome]*\n` +
    `❌ *LOST ${customer.customer_name.split(' ')[0].toUpperCase()} [reason]*\n\n` +
    `Ref: ${shortId}`;
}

function buildVisitInterestMessage(task, reminderCount) {
  const shortId = task.id ? task.id.substring(0, 8) : 'N/A';
  const reminderText = reminderCount > 1 ? `\n⚠️ *Reminder #${reminderCount}*` : '';

  let notesContext = task.resolution_notes || '';
  let productStr = 'Discussed Steel Products';
  const prodMatch = notesContext.match(/interest in\s+([^.]+)/i) || notesContext.match(/requirement:\s*([^|\]]+)/i);
  if (prodMatch) {
    productStr = prodMatch[1].trim();
  }

  const visitDateStr = task.created_at ? new Date(task.created_at).toLocaleDateString('en-IN') : 'Recent Visit';

  return `🚗 *Visit Interest Follow-up Alert*${reminderText}\n\n` +
    `🏢 *${task.customer_name}*\n` +
    `📅 Visit Date: *${visitDateStr}*\n` +
    `📦 Product of Interest: *${productStr}*\n\n` +
    `During the visit, the customer showed interest and indicated a decision timeframe which is now due.\n` +
    `No order has been received yet.\n\n` +
    `Please follow up with the customer today to close this order and reply:\n` +
    `✅ *ORDERED ${task.customer_name.split(' ')[0].toUpperCase()} [amount]*\n` +
    `📞 *CALLED ${task.customer_name.split(' ')[0].toUpperCase()} [outcome]*\n` +
    `❌ *LOST ${task.customer_name.split(' ')[0].toUpperCase()} [reason]*\n\n` +
    `Ref: ${shortId}`;
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

      // Resolve the task
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
  checkRecurringCustomers,
  checkOrderFrequencyFollowups,
  checkVisitInterestFollowups,
  handleFollowUpReply,
  buildOrderFrequencyMessage,
  buildVisitInterestMessage,
};
