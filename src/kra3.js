const { createClient } = require('@supabase/supabase-js');
const { sendTextMessage } = require('./whatsapp');

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

// Check which recurring customers haven't ordered this month
async function checkRecurringCustomers() {
  const supabase = getSupabase();
  
  try {
    console.log('Running KRA 3 check - recurring customers...');
    
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
      .toISOString();
    
    // Get all active recurring customers
    const { data: customers, error } = await supabase
      .from('recurring_customers')
      .select('*')
      .eq('is_active', true);
    
    if (error) throw error;
    if (!customers || customers.length === 0) {
      console.log('No recurring customers found');
      return;
    }
    
    console.log(`Checking ${customers.length} recurring customers...`);
    
    for (const customer of customers) {
      await checkCustomer(customer, monthStart, now, supabase);
      // Small delay between customers to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    console.log('KRA 3 check complete');
  } catch (error) {
    console.error('checkRecurringCustomers error:', error);
  }
}

async function checkCustomer(customer, monthStart, now, supabase) {
  try {
    // Check if this customer has a deal this month
    const { data: deals } = await supabase
      .from('deals')
      .select('id, created_at, total_amount')
      .ilike('customer_name', `%${customer.customer_name}%`)
      .gte('created_at', monthStart);
    
    const hasOrderThisMonth = deals && deals.length > 0;
    
    if (hasOrderThisMonth) {
      console.log(`✅ ${customer.customer_name} - has order this month`);
      
      // Update last_order_date
      await supabase
        .from('recurring_customers')
        .update({ 
          last_order_date: new Date().toISOString().split('T')[0],
          updated_at: new Date().toISOString()
        })
        .eq('id', customer.id);
      return;
    }
    
    // Calculate days since last order
    const lastOrderDate = customer.last_order_date 
      ? new Date(customer.last_order_date) 
      : null;
    const daysSinceOrder = lastOrderDate 
      ? Math.floor((now - lastOrderDate) / (1000 * 60 * 60 * 24))
      : null;
    
    console.log(`⚠️ ${customer.customer_name} - no order this month. Days since last order: ${daysSinceOrder}`);
    
    // Check if we already sent a follow-up task this month
    const { data: existingTask } = await supabase
      .from('followup_tasks')
      .select('id, follow_up_count, reminder_sent_at, status')
      .eq('customer_name', customer.customer_name)
      .eq('task_type', 'kra3_retention')
      .gte('created_at', monthStart)
      .single();
    
    if (existingTask) {
      // Task exists - check if we need to send a reminder
      await handleExistingTask(existingTask, customer, daysSinceOrder, supabase);
    } else {
      // Create new follow-up task and send first alert
      await createFollowUpTask(customer, daysSinceOrder, supabase);
    }
  } catch (error) {
    console.error(`checkCustomer error for ${customer.customer_name}:`, error.message);
  }
}

async function createFollowUpTask(customer, daysSinceOrder, supabase) {
  try {
    // Create follow-up task
    const { data: task } = await supabase
      .from('followup_tasks')
      .insert({
        task_type: 'kra3_retention',
        customer_name: customer.customer_name,
        customer_phone: customer.customer_phone,
        salesperson_phone: customer.assigned_salesperson_phone,
        due_date: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
        status: 'pending',
        reminder_sent_at: new Date().toISOString(),
        follow_up_count: 1
      })
      .select()
      .single();
    
    // Send WhatsApp alert to salesperson
    const message = buildFollowUpMessage(customer, daysSinceOrder, 1, task?.id);
    console.log('Sending to phone:', customer.assigned_salesperson_phone);
    await sendTextMessage(customer.assigned_salesperson_phone, message);
    
    console.log(`📱 Follow-up sent to ${customer.assigned_salesperson_phone} for ${customer.customer_name}`);
  } catch (error) {
    console.error('createFollowUpTask error:', error.message);
  }
}

async function handleExistingTask(task, customer, daysSinceOrder, supabase) {
  try {
    if (task.status === 'resolved') return;
    
    const lastReminder = new Date(task.reminder_sent_at);
    const hoursSinceReminder = (Date.now() - lastReminder) / (1000 * 60 * 60);
    
    // Send reminder every 48 hours
    if (hoursSinceReminder < 48) {
      console.log(`⏳ ${customer.customer_name} - reminder sent ${Math.round(hoursSinceReminder)}h ago, skipping`);
      return;
    }
    
    const newCount = (task.follow_up_count || 1) + 1;
    
    // Update task
    await supabase
      .from('followup_tasks')
      .update({
        follow_up_count: newCount,
        reminder_sent_at: new Date().toISOString(),
        escalated_at: newCount >= 3 
          ? new Date().toISOString() 
          : null
      })
      .eq('id', task.id);
    
    // Send escalation to Sales Lead if 3rd reminder
    if (newCount >= 3) {
      const salesLeadPhone = process.env.SALES_LEAD_PHONE;
      if (salesLeadPhone) {
        const escalationMsg = 
          `🚨 *Customer Retention Escalation*\n\n` +
          `${customer.customer_name} has not ordered this month.\n` +
          `Assigned salesperson has been reminded ${newCount} times.\n` +
          `Days since last order: ${daysSinceOrder || 'Unknown'}\n\n` +
          `Please follow up with the salesperson.`;
        await sendTextMessage(salesLeadPhone, escalationMsg);
      }
    }
    
    // Send follow-up to salesperson
    const message = buildFollowUpMessage(
      customer, daysSinceOrder, newCount, task.id
    );
    await sendTextMessage(customer.assigned_salesperson_phone, message);
    
    console.log(`📱 Reminder #${newCount} sent for ${customer.customer_name}`);
  } catch (error) {
    console.error('handleExistingTask error:', error.message);
  }
}

function buildFollowUpMessage(customer, daysSinceOrder, reminderCount, taskId) {
  const shortId = taskId ? taskId.substring(0, 8) : 'N/A';
  const daysText = daysSinceOrder 
    ? `Last order: ${daysSinceOrder} days ago` 
    : 'No recent order on record';
  const reminderText = reminderCount > 1 
    ? `\n⚠️ Reminder #${reminderCount}` 
    : '';
  
  return `🔔 *Customer Retention Follow-up Alert*${reminderText}\n\n` +
    `🏢 *${customer.customer_name}*\n` +
    `${daysText}\n` +
    `Usual order: every ${customer.avg_order_frequency_days} days\n\n` +
    `No order logged this month.\n\n` +
    `Please follow up and reply:\n` +
    `✅ *VISITED ${customer.customer_name.split(' ')[0].toUpperCase()} [outcome]*\n` +
    `📞 *CALLED ${customer.customer_name.split(' ')[0].toUpperCase()} [outcome]*\n` +
    `❌ *LOST ${customer.customer_name.split(' ')[0].toUpperCase()} [reason]*\n` +
    `🔄 *ORDERED ${customer.customer_name.split(' ')[0].toUpperCase()} [amount]*\n\n` +
    `Ref: ${shortId}`;
}

// Handle salesperson reply to follow-up
async function handleFollowUpReply(text, senderPhone) {
  const supabase = getSupabase();
  const upper = text.toUpperCase().trim();
  
  const actions = ['VISITED', 'CALLED', 'LOST', 'ORDERED', 'FOLLOWED', 'FOLLOW-UP', 'FOLLOWUP'];
  const matchedAction = actions.find(a => upper.startsWith(a));
  
  if (!matchedAction) return null;
  
  try {
    // 1. Fetch all pending KRA 3 tasks for this salesperson to match customer name dynamically
    const { data: openTasks } = await supabase
      .from('followup_tasks')
      .select('*')
      .eq('salesperson_phone', senderPhone)
      .eq('status', 'pending')
      .eq('task_type', 'kra3_retention');

    let task = null;
    let customerKeyword = '';
    let outcome = '';

    if (openTasks && openTasks.length > 0) {
      // Find a task whose customer name is mentioned in the text (case-insensitive)
      task = openTasks.find(t => {
        if (!t.customer_name) return false;
        const nameLower = t.customer_name.toLowerCase();
        // Check if full customer name is in the message
        if (text.toLowerCase().includes(nameLower)) return true;
        // Check if any word of length > 3 of the customer name is in the message (e.g. "Supreme")
        const words = nameLower.split(/\s+/);
        return words.some(word => word.length > 3 && text.toLowerCase().includes(word));
      });

      // Fuzzy match fallback using Gemini if no literal match is found
      if (!task) {
        console.log('No literal customer match, trying fuzzy matching...');
        const { fuzzyMatchCustomer } = require('./supabase');
        const customerList = openTasks.map(t => t.customer_name).filter(Boolean);
        const matchedName = await fuzzyMatchCustomer(text, customerList);
        if (matchedName) {
          console.log(`Fuzzy matched customer: ${matchedName}`);
          task = openTasks.find(t => t.customer_name === matchedName);
        }
      }
    }

    if (task) {
      customerKeyword = task.customer_name;
      // The outcome is everything in the text except action and customer name
      let tempOutcome = text;
      // Remove action keyword and common filler words immediately following it
      const regexAction = new RegExp(`^${matchedAction}\\s*(up|with|about|for|recurring|customer|client|on)*\\s*`, 'i');
      tempOutcome = tempOutcome.replace(regexAction, '');
      // Remove customer name (if present)
      if (tempOutcome.toLowerCase().includes(task.customer_name.toLowerCase())) {
        tempOutcome = tempOutcome.replace(new RegExp(task.customer_name, 'gi'), '');
      } else {
        // Remove first word of customer name
        const firstWord = task.customer_name.split(' ')[0];
        if (firstWord.length > 3) {
          tempOutcome = tempOutcome.replace(new RegExp(firstWord, 'gi'), '');
        }
      }
      // Clean up punctuation at the start or end of outcome
      outcome = tempOutcome.replace(/^[\s:,\-]+/, '').trim() || 'Completed follow-up';
    } else {
      // FALLBACK: Clean action and filler words to extract customer keyword and outcome
      let cleanText = text;
      const regexPrefix = /^(visited|called|lost|ordered|followed up with recurring customer|followed up with customer|followed up with|follow up with|followed|followup|follow-up|following up)\s+/i;
      cleanText = cleanText.replace(regexPrefix, '');
      cleanText = cleanText.replace(/^(customer|client|company)\s+/i, '');

      const parts = cleanText.split(/[\s:,\-]+/);
      customerKeyword = parts[0] || '';
      outcome = cleanText.replace(new RegExp(`^${customerKeyword}`, 'i'), '').replace(/^[\s:,\-]+/, '').trim() || 'No details provided';

      // Fallback DB query using keyword
      if (customerKeyword) {
        const { data: tasks } = await supabase
          .from('followup_tasks')
          .select('*')
          .eq('salesperson_phone', senderPhone)
          .eq('status', 'pending')
          .eq('task_type', 'kra3_retention')
          .ilike('customer_name', `%${customerKeyword}%`)
          .order('created_at', { ascending: false })
          .limit(1);
      }
    }

    if (!task) {
      // No pending task found — still log the follow-up as a free-form activity
      console.log('No active pending KRA 3 task found. Logging as free-form follow-up for:', customerKeyword);

      await supabase.from('kra_logs').insert({
        salesperson_phone: senderPhone,
        kra_number: 3,
        kra_type: 'customer_retention',
        description: `Follow-up: ${text}`,
        customer_name: customerKeyword || null,
        month: new Date().getMonth() + 1,
        year: new Date().getFullYear()
      });

      return `🔄 *Customer Retention Follow-up Logged*\n\n` +
        (customerKeyword ? `Customer: ${customerKeyword}\n` : '') +
        `Status: Follow-up recorded\n\n` +
        `Updated Customer Retention Card! ✅`;
    }

    if (task) {
      // Resolve the task
      await supabase
        .from('followup_tasks')
        .update({
          status: 'resolved',
          resolved_at: new Date().toISOString(),
          resolution_notes: `${matchedAction}: ${outcome}`
        })
        .eq('id', task.id);
    }
    
    // Log KRA activity
    await supabase
      .from('kra_logs')
      .insert({
        salesperson_phone: senderPhone,
        kra_number: 3,
        kra_type: 'customer_retention',
        description: `${matchedAction} ${customerKeyword}: ${outcome}`,
        customer_name: task?.customer_name || customerKeyword,
        month: new Date().getMonth() + 1,
        year: new Date().getFullYear()
      });
    
    // Build confirmation message
    const emojiMap = {
      'VISITED': '🏢', 'CALLED': '📞', 
      'LOST': '❌', 'ORDERED': '✅',
      'FOLLOWED': '🔄', 'FOLLOW-UP': '🔄', 'FOLLOWUP': '🔄'
    };
    const emoji = emojiMap[matchedAction.toUpperCase()] || '🔄';
    
    return `${emoji} *Customer Retention Updated*\n\n` +
      `Action: ${matchedAction}\n` +
      `Customer: ${task?.customer_name || customerKeyword}\n` +
      `Outcome: ${outcome}\n\n` +
      `Updated Customer Retention Card! ✅`;
  } catch (error) {
    console.error('handleFollowUpReply error:', error);
    return '❌ Could not log follow-up. Please try again.';
  }
}

module.exports = { 
  checkRecurringCustomers, 
  handleFollowUpReply,
  buildFollowUpMessage
};
