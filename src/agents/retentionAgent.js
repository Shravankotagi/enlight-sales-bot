/**
 * KRA 3 - Customer Retention & Follow-up Agent
 *
 * DESIGN PRINCIPLES:
 * - Each follow-up is logged to KRA 3 (each activity counts).
 * - followup_tasks table tracks open follow-ups per customer - updated, never duplicated.
 * - ALL AI-extracted data is persisted to DB (no data is shown in chat but lost from storage).
 * - Follow-up date, order timeline, linked deal, and status ALL stored and in sync.
 *
 * EDGE CASES HANDLED:
 * 1.  Normal follow-up logged → KRA 3 log + update followup_tasks with full context
 * 2.  Reorder expected → sets task status to 'reorder_expected', due date = 7 days
 * 3.  Customer won't reorder (churn) → marks customer inactive, closes task
 * 4.  Missing customer name → ask for clarification
 * 5.  Customer not in recurring_customers → create minimal record
 * 6.  Duplicate follow-up task → update existing task, don't create new
 * 7.  Last contact date always updated in recurring_customers
 * 8.  Hinglish/casual messages → AI handles semantic parsing
 * 9.  Order expected timeline (e.g. "next week") captured and stored
 * 10. Previous quotation/deal linked by searching recent deals for this customer
 * 11. Follow-up status (e.g. "reviewing quotation") persisted to DB
 * 12. Scheduled follow-up date stored and displayed in response
 */

const { supabase } = require('../supabase');


const RETENTION_AGENT_PROMPT = `
You are the Specialized Customer Retention AI Agent (KRA 3) for Enlight Metals, a B2B metal distributor.
Your job is to parse customer follow-up reports, re-order inquiries, or client check-in notes.

The salesperson message may be informal, in Hinglish, or missing expected keywords.
Understand the meaning and context - do not look for specific words.

Input message can be English, Hindi, or Hinglish.

Extract into ONLY a JSON object (no prose, no markdown, no backticks):
{
  "customer_name": "<customer/company name, else null>",
  "followup_summary": "<detailed 2-3 line summary of the discussion, what was said, and the outcome - do NOT use generic text like 'Routine check-in'>",
  "followup_status": "<one of: reviewing_quotation | awaiting_decision | reorder_confirmed | price_negotiation | site_visit_pending | payment_pending | churned | routine_checkin>",
  "reorder_expected": <true if customer indicated they will order soon, else false>,
  "order_expected_timeline": "<when the customer expects to confirm/order, e.g. 'next week', 'by Friday', 'within 2 weeks', else null>",
  "previous_quotation_mentioned": <true if the customer mentioned reviewing a quote/quotation/PO, else false>,
  "is_churned": <true if customer clearly said they won't order anymore or switching supplier, else false>,
  "followup_days": <number of days after which to follow up - 3 for hot leads, 7 for warm, 14 for cold, default 7>,
  "confidence": <float 0.0 to 1.0>
}

Rules:
- "followup_status": Pick the most accurate single status:
  - "reviewing_quotation" → customer is reviewing a quote/proposal we sent
  - "awaiting_decision" → customer needs to decide / will confirm
  - "reorder_confirmed" → customer confirmed they will reorder
  - "price_negotiation" → customer is negotiating price
  - "site_visit_pending" → customer wants a site visit before deciding
  - "payment_pending" → customer owes payment
  - "churned" → customer won't order anymore
  - "routine_checkin" → no specific outcome, just a check-in call
- "reorder_expected": true if customer said "will order next week", "interested in reorder", "planning to buy", "confirm next week", etc.
- "is_churned": true ONLY if customer clearly indicated done / switching supplier / no more orders.
- "followup_summary": Must capture WHAT the customer said/decided, NOT just "follow-up noted". Be specific.
- Never set both reorder_expected and is_churned to true at the same time.
- "followup_days": Hot lead (confirming soon) = 3, Warm lead (interested) = 7, Cold lead = 14.

Return ONLY the JSON object.
`;

/**
 * Find existing open followup task for a customer.
 */
async function getExistingFollowupTask(customerName, senderPhone) {
  const { data } = await supabase
    .from('followup_tasks')
    .select('*')
    .ilike('customer_name', `%${customerName}%`)
    .eq('salesperson_phone', senderPhone)
    .not('status', 'in', '("resolved","closed")')
    .order('created_at', { ascending: false })
    .limit(1);

  return (data && data.length > 0) ? data[0] : null;
}

/**
 * Find the most recent deal for this customer to link follow-up.
 */
async function getLinkedDeal(customerName, senderPhone) {
  try {
    const { data } = await supabase
      .from('deals')
      .select('id, stage, total_amount, created_at, inquiry_type')
      .ilike('customer_name', `%${customerName}%`)
      .eq('salesperson_phone', senderPhone)
      .order('created_at', { ascending: false })
      .limit(1);
    return (data && data.length > 0) ? data[0] : null;
  } catch { return null; }
}

/**
 * Ensure customer exists in recurring_customers (role-scoped).
 */
async function ensureCustomerExists(customerName, senderPhone) {
  const { ensureCustomerRecord } = require('../supabase');
  const rec = await ensureCustomerRecord(customerName, senderPhone);
  return rec ? rec.id : null;
}

async function processRetentionMessage(text, senderPhone) {
  try {
    const { invokeWithFallback } = require('../core/modelRouter');
    const { HumanMessage, SystemMessage } = require('@langchain/core/messages');
    const response = await invokeWithFallback([
      new SystemMessage(RETENTION_AGENT_PROMPT),
      new HumanMessage('Salesperson message:\n' + text),
    ]);
    const rawText = typeof response.content === 'string' ? response.content : JSON.stringify(response.content || '');
    const { safeParseJSON } = require('../utils/jsonUtils');
    const data = safeParseJSON(rawText, null);
    if (!data) throw new Error('Could not parse retention JSON from LLM response');

    // Edge Case 4: Missing customer name
    if (!data.customer_name) {
      return `⚠️ *Retention Agent - Customer Name Missing*\n\nPlease specify the *Customer/Company Name* for this follow-up update.\nExample: _"Called Mehta Industries, they are planning a reorder next month"_`;
    }

    const customerName = data.customer_name.trim();

    // Verify official customer name
    const { verifyAndGetCustomerName, saveActiveSession } = require('../supabase');

    let officialCustomerName = await verifyAndGetCustomerName(customerName, senderPhone);
    let isNewProspect = false;

    if (!officialCustomerName) {
      // Auto-create prospect instead of rejecting
      isNewProspect = true;
      const { error: insertError } = await supabase.from('recurring_customers').insert({
        customer_name:              customerName,
        assigned_salesperson_phone: senderPhone,
        is_active:                  true,
        avg_order_frequency_days:   30,
      });
      if (!insertError) {
        console.log(`[RetentionAgent] Auto-created new prospect: ${customerName}`);
      }
      officialCustomerName = customerName;
    }

    const finalCustomerName     = officialCustomerName;
    const followupSummary       = data.followup_summary       || 'Routine check-in';
    const followupStatus        = data.followup_status        || 'routine_checkin';
    const reorderExpected       = !!data.reorder_expected;
    const orderExpectedTimeline = data.order_expected_timeline || null;
    const previousQuoteLinked   = !!data.previous_quotation_mentioned;
    const isChurned             = !!data.is_churned && !reorderExpected;
    const followupDays          = Number(data.followup_days) || (reorderExpected ? 7 : 14);

    // Calculate scheduled follow-up date
    const followupDate = new Date(Date.now() + followupDays * 24 * 60 * 60 * 1000);
    const followupDateStr = followupDate.toLocaleDateString('en-IN', {
      day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata'
    });

    // Edge Case 5: Ensure customer exists
    await ensureCustomerExists(finalCustomerName, senderPhone);

    // Save active session for context retention
    await saveActiveSession(senderPhone, finalCustomerName, 'followup_logged');

    // Link to previous deal if quotation was mentioned
    let linkedDealId = null;
    let linkedDealAmount = null;
    if (previousQuoteLinked) {
      const linkedDeal = await getLinkedDeal(finalCustomerName, senderPhone);
      if (linkedDeal) {
        linkedDealId     = linkedDeal.id;
        linkedDealAmount = linkedDeal.total_amount;
      }
    }

    // ── Churn path ────────────────────────────────────────────────────────────
    if (isChurned) {
      await supabase
        .from('recurring_customers')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .ilike('customer_name', `%${finalCustomerName}%`);

      await supabase
        .from('followup_tasks')
        .update({
          status:           'closed',
          followup_status:  'churned',
          resolved_at:      new Date().toISOString(),
          resolution_notes: followupSummary,
        })
        .ilike('customer_name', `%${finalCustomerName}%`)
        .eq('salesperson_phone', senderPhone)
        .not('status', 'in', '("resolved","closed")');

      await supabase.from('kra_logs').insert({
        salesperson_phone: senderPhone,
        kra_number:        3,
        kra_type:          'customer_churned',
        customer_name:     finalCustomerName,
        description:       `Churn Detected: ${finalCustomerName} - ${followupSummary}`,
        month: new Date().getMonth() + 1,
        year:  new Date().getFullYear(),
      });

      return `⚠️ *KRA 3 - Churn Signal Logged*\n\n` +
        `Customer: *${finalCustomerName}*\n` +
        `Status: *Marked Inactive - No Further Orders Expected*\n` +
        (followupSummary ? `Note: ${followupSummary}\n` : '') +
        `\nCustomer flagged in Retention Dashboard. 📉`;
    }

    // ── Normal follow-up path ─────────────────────────────────────────────────
    const taskStatus = reorderExpected ? 'reorder_expected' : 'pending';

    const taskPayload = {
      status:                   taskStatus,
      followup_status:          followupStatus,
      resolution_notes:         followupSummary,
      order_expected_timeline:  orderExpectedTimeline,
      next_followup_date:       followupDate.toISOString(),
      linked_deal_id:           linkedDealId,
    };

    const existingTask = await getExistingFollowupTask(finalCustomerName, senderPhone);

    if (existingTask) {
      // Update existing task - increment follow_up_count, try with new columns first
      const updateResult = await supabase
        .from('followup_tasks')
        .update({
          ...taskPayload,
          follow_up_count: (Number(existingTask.follow_up_count) || 0) + 1,
          updated_at:      new Date().toISOString(),
        })
        .eq('id', existingTask.id);

      if (updateResult.error) {
        // Fallback: update only safe columns (migration may not have run yet)
        await supabase.from('followup_tasks').update({
          status:           taskStatus,
          resolution_notes: followupSummary,
          follow_up_count:  (Number(existingTask.follow_up_count) || 0) + 1,
        }).eq('id', existingTask.id);
      }
    } else {
      // Create new task - try with all new columns first
      const insertResult = await supabase.from('followup_tasks').insert({
        task_type:                reorderExpected ? 'reorder_followup' : 'retention_followup',
        customer_name:            finalCustomerName,
        salesperson_phone:        senderPhone,
        follow_up_count:          1,
        due_date:                 followupDate.toISOString(),
        ...taskPayload,
      });

      if (insertResult.error) {
        // Fallback: insert only safe columns
        await supabase.from('followup_tasks').insert({
          task_type:         reorderExpected ? 'reorder_followup' : 'retention_followup',
          customer_name:     finalCustomerName,
          salesperson_phone: senderPhone,
          status:            taskStatus,
          resolution_notes:  followupSummary,
          follow_up_count:   1,
          due_date:          followupDate.toISOString(),
        });
      }
    }

    // Log KRA 3 with full business context
    const kraDescription = [
      `Follow-up: ${finalCustomerName}`,
      `Status: ${followupStatus}`,
      orderExpectedTimeline ? `Order expected: ${orderExpectedTimeline}` : null,
      `Next follow-up: ${followupDateStr}`,
      linkedDealId && linkedDealAmount && Number(linkedDealAmount) > 0
        ? `Linked deal: ₹${Number(linkedDealAmount).toLocaleString('en-IN')}`
        : linkedDealId ? `Linked deal: No amount recorded` : null,
      `Notes: ${followupSummary}`,
    ].filter(Boolean).join(' | ');

    await supabase.from('kra_logs').insert({
      salesperson_phone: senderPhone,
      kra_number:        3,
      kra_type:          'customer_retention',
      customer_name:     finalCustomerName,
      description:       kraDescription,
      month: new Date().getMonth() + 1,
      year:  new Date().getFullYear(),
    });

    // Count this month's follow-ups
    const { data: monthlyLogs } = await supabase
      .from('kra_logs')
      .select('id')
      .eq('salesperson_phone', senderPhone)
      .eq('kra_number', 3)
      .eq('kra_type', 'customer_retention')
      .eq('month', new Date().getMonth() + 1)
      .eq('year', new Date().getFullYear());

    const followupCount = monthlyLogs ? monthlyLogs.length : 1;

    const { getCustomerMissingInfoPrompt } = require('../supabase');
    const missingPrompt = await getCustomerMissingInfoPrompt(finalCustomerName, senderPhone);

    // Status display map
    const statusLabels = {
      reviewing_quotation: '📄 Reviewing Quotation',
      awaiting_decision:   '⏳ Awaiting Decision',
      reorder_confirmed:   '✅ Reorder Confirmed',
      price_negotiation:   '💬 Price Negotiation',
      site_visit_pending:  '🏭 Site Visit Pending',
      payment_pending:     '💰 Payment Pending',
      routine_checkin:     '📞 Routine Check-in',
    };

    return `🔄 *Customer Retention Follow-up Logged!*\n\n` +
      `Customer: *${finalCustomerName}*\n` +
      `Status: *${statusLabels[followupStatus] || followupStatus}*\n` +
      `Summary: ${followupSummary}\n` +
      (orderExpectedTimeline ? `📅 Order Expected: *${orderExpectedTimeline}*\n` : '') +
      (linkedDealId && linkedDealAmount && Number(linkedDealAmount) > 0
        ? `🔗 Linked Deal: *₹${Number(linkedDealAmount).toLocaleString('en-IN')}*\n`
        : '') +
      `📌 Next Follow-up Scheduled: *${followupDateStr}* (${followupDays} days)\n` +
      `Monthly Follow-ups: *${followupCount} logged this month*\n\n` +
      `Updated Customer Retention Card! ✅` + (missingPrompt || '');

  } catch (error) {
    console.error('Retention Agent Error:', error.message);
    return `⚠️ Could not process retention update: ${error.message}`;
  }
}

module.exports = { processRetentionMessage };
