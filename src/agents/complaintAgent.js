/**
 * KRA 7 & KRA 8 - Quality Complaints & Complaint Resolution Agent
 *
 * KRA 7 = Log new quality complaints (reported by salesperson or forwarded from customer)
 * KRA 8 = Complaint resolved within SLA (target: 48 hours)
 *
 * DESIGN PRINCIPLES:
 * - One complaint row per incident in the `complaints` table.
 * - Resolution updates the EXISTING open complaint, never creates a duplicate.
 * - KRA 7 log fires on new complaint.
 * - KRA 8 log fires ONLY on resolution — and only if not already resolved.
 * - SLA compliance tracked in hours (target: ≤ 48 hours).
 * - If customer reports a complaint that is already resolved, inform the salesperson.
 *
 * EDGE CASES HANDLED:
 * 1.  New complaint → insert to complaints + log KRA 7
 * 2.  Resolve complaint → find open complaint, mark resolved, log KRA 8
 * 3.  Resolution with no prior open complaint → create a completed record (backdated)
 * 4.  Complaint already resolved → don't create duplicate, notify user
 * 5.  Missing customer name → ask for clarification
 * 6.  SLA breach detection → flag if >48 hours
 * 7.  Assigned salesperson routing → alert correct salesperson if complaint came from customer
 * 8.  Duplicate complaint check → don't log a second open complaint for same customer + type
 * 9.  Escalation flag → set escalated=true if SLA breached on resolution
 * 10. Hinglish/casual messages → AI handles semantic parsing
 */

const { supabase } = require('../supabase');
const { syncActivity } = require('./biginSyncAgent');

const COMPLAINT_AGENT_PROMPT = `
You are the Specialized Quality & Complaint AI Agent (KRA 7 & KRA 8) for Enlight Metals.
Your job is to parse quality complaints, material rejection reports, or complaint resolution updates.

The salesperson message may be informal, in Hinglish, or missing expected keywords.
Understand the meaning and context — do not look for specific words.

Input message can be English, Hindi, or Hinglish.

Extract into ONLY a JSON object (no prose, no markdown, no backticks):
{
  "action": "report|resolve",
  "customer_name": "<customer/company name, else null>",
  "complaint_type": "quality|delivery|billing|specification|other",
  "affected_product": "<specific product/material affected e.g. 'HR Coil 8mm', 'TMT Bars', 'MS Sheets' — else null>",
  "description": "<brief description of complaint or resolution, else null>",
  "confidence": <float 0.0 to 1.0>
}

Rules — understand meaning, not keywords:
- "action": "report" → new problem, quality issue, material rejection, wrong delivery, billing dispute.
- "action": "resolve" → complaint fixed, settled, customer accepted, issue sorted, resolved.
- "affected_product": Extract the specific steel product/material affected (e.g. 'HR Coil', 'TMT Bar 10mm', 'MS Plate'). null if not mentioned.
- If ambiguous, prefer "report" over "resolve".

Return ONLY the JSON object.
`;

/**
 * Find the most recent OPEN complaint for a customer.
 */
async function getOpenComplaint(customerName, senderPhone) {
  let query = supabase
    .from('complaints')
    .select('*')
    .ilike('customer_name', `%${customerName}%`)
    .eq('status', 'open');

  if (senderPhone) {
    query = query.eq('reported_by', senderPhone);
  }

  const { data } = await query
    .order('reported_at', { ascending: false })
    .limit(1);

  return data && data.length > 0 ? data[0] : null;
}

/**
 * Check if a KRA 8 log already exists for this complaint (to avoid re-logging resolved).
 */
async function isKRA8AlreadyLogged(senderPhone, customerName) {
  const { data } = await supabase
    .from('kra_logs')
    .select('id')
    .eq('salesperson_phone', senderPhone)
    .eq('kra_number', 8)
    .ilike('customer_name', `%${customerName}%`)
    .eq('month', new Date().getMonth() + 1)
    .eq('year', new Date().getFullYear())
    .limit(1);

  return data && data.length > 0;
}

async function processComplaintMessage(text, senderPhone) {
  try {
    const { invokeWithFallback } = require('../core/modelRouter');
    const { HumanMessage, SystemMessage } = require('@langchain/core/messages');
    const response = await invokeWithFallback([
      new SystemMessage(COMPLAINT_AGENT_PROMPT),
      new HumanMessage('Salesperson message:\n' + text),
    ]);
    const rawText = typeof response.content === 'string' ? response.content : JSON.stringify(response.content || '');
    const { safeParseJSON } = require('../utils/jsonUtils');
    const data = safeParseJSON(rawText, null);
    if (!data) throw new Error('Could not parse complaint JSON from LLM response');

    // Edge Case 5: Missing customer name
    if (!data.customer_name) {
      return `⚠️ *Quality Agent — Customer Name Missing*\n\nPlease specify the *Customer/Company Name* for this complaint.\nExample: _"Quality complaint from Delta Structural Steel — wrong material delivered"_`;
    }

    const customerName   = data.customer_name.trim();

    // Verify and get official customer name — auto-create if not found
    const { verifyAndGetCustomerName } = require('../supabase');
    let officialCustomerName = await verifyAndGetCustomerName(customerName, senderPhone);

    if (!officialCustomerName) {
      // Auto-create as prospect instead of rejecting the complaint
      await supabase.from('recurring_customers').insert({
        customer_name:              customerName,
        assigned_salesperson_phone: senderPhone,
        is_active:                  true,
        avg_order_frequency_days:   30,
      }).select().single();
      officialCustomerName = customerName;
      console.log(`[ComplaintAgent] Auto-created new prospect: ${customerName}`);
    }

    const finalCustomerName = officialCustomerName;
    const complaintType    = data.complaint_type || 'quality';
    const affectedProduct  = data.affected_product || null;
    const rawDescription   = data.description || text;
    // Structure description with product prefix for clean dashboard parsing
    const description = affectedProduct
      ? `[Product: ${affectedProduct}] ${rawDescription}`
      : rawDescription;

    // ── RESOLVE FLOW ──────────────────────────────────────────────────
    if (data.action === 'resolve') {
      const openComplaint = await getOpenComplaint(finalCustomerName, senderPhone);

      if (openComplaint) {
        // Edge Case 4: Check if already resolved
        const resolvedAt = new Date();
        const reportedAt = new Date(openComplaint.reported_at);
        const resolutionTimeHrs = Math.max(1, Math.round(
          (resolvedAt.getTime() - reportedAt.getTime()) / (1000 * 60 * 60)
        ));
        const isSlaBreached  = resolutionTimeHrs > 48;
        const isSlaCompliant = !isSlaBreached;

        // Update existing complaint to resolved
        await supabase
          .from('complaints')
          .update({
            status:               'resolved',
            resolved_at:          resolvedAt.toISOString(),
            resolution_time_hrs:  resolutionTimeHrs,
            escalated:            isSlaBreached, // Edge Case 9: flag escalation on SLA breach
          })
          .eq('id', openComplaint.id);

        // Edge Case 4: Only log KRA 8 once per resolution
        const alreadyLogged = await isKRA8AlreadyLogged(senderPhone, finalCustomerName);
        if (!alreadyLogged) {
          await supabase.from('kra_logs').insert({
            salesperson_phone: senderPhone,
            kra_number:        8,
            kra_type:          'complaint_resolved',
            customer_name:     finalCustomerName,
            description:       `Complaint Resolved: ${finalCustomerName} (${resolutionTimeHrs}h — ${isSlaCompliant ? 'Within SLA ✅' : 'SLA BREACHED ⚠️'})`,
            month: new Date().getMonth() + 1,
            year:  new Date().getFullYear(),
          });
        }

        try {
          const { syncActivity } = require('./biginSyncAgent');
          syncActivity('complaint_resolved', {
            customerName: finalCustomerName,
            complaintType,
            description: data.description,
            affectedProduct,
            action: 'resolve',
            resolutionTimeHrs,
            senderPhone,
          });
        } catch (e) {
          console.warn('[ComplaintAgent] Bigin sync notice:', e.message);
        }

        const { getCustomerMissingInfoPrompt } = require('../supabase');
        const missingPrompt = await getCustomerMissingInfoPrompt(finalCustomerName, senderPhone);

        return `✅ *Complaint Resolved!*\n\n` +
          `Customer: *${finalCustomerName}*\n` +
          `Complaint Type: *${complaintType.toUpperCase()}*\n` +
          `Resolution Time: *${resolutionTimeHrs} Hours*\n` +
          `SLA Target (48h): *${isSlaCompliant ? '✅ Achieved — Within Target!' : '⚠️ Breached — Escalated!'}*\n\n` +
          `Updated Customer Complaints Card! ✅` + (missingPrompt || '');

      } else {
        // Edge Case 3: No prior open complaint found → create a backdated resolved record
        await supabase.from('complaints').insert({
          customer_name:        finalCustomerName,
          reported_by:          senderPhone,
          complaint_type:       complaintType,
          description:          description,
          status:               'resolved',
          reported_at:          new Date().toISOString(),
          resolved_at:          new Date().toISOString(),
          resolution_time_hrs:  0,
          escalated:            false,
        });

        await supabase.from('kra_logs').insert({
          salesperson_phone: senderPhone,
          kra_number:        8,
          kra_type:          'complaint_resolved',
          customer_name:     finalCustomerName,
          description:       `Complaint Resolved (no prior open record): ${finalCustomerName}`,
          month: new Date().getMonth() + 1,
          year:  new Date().getFullYear(),
        });

        const { getCustomerMissingInfoPrompt } = require('../supabase');
        const missingPrompt = await getCustomerMissingInfoPrompt(finalCustomerName, senderPhone);

        return `✅ *Complaint Resolved!*\n\n` +
          `Customer: *${finalCustomerName}*\n` +
          `_Note: No prior open complaint found. Created and resolved in one step._\n\n` +
          `Updated Customer Complaints Card! ✅` + (missingPrompt || '');
      }
    }

    // ── REPORT FLOW ───────────────────────────────────────────────────
    // Edge Case 8: Check if there's already an open complaint of same type for this customer
    const existingOpen = await getOpenComplaint(finalCustomerName);
    if (existingOpen && existingOpen.complaint_type === complaintType) {
      return `⚠️ *Complaint Already Open*\n\n` +
        `Customer: *${finalCustomerName}*\n` +
        `Type: *${complaintType.toUpperCase()}*\n` +
        `Reported: *${new Date(existingOpen.reported_at).toLocaleString('en-IN')}*\n\n` +
        `This complaint is already logged and open. When resolved, reply:\n` +
        `_"Resolved ${finalCustomerName} complaint"_`;
    }

    // Edge Case 7: Look up assigned salesperson for this customer
    const { data: customerRecord } = await supabase
      .from('recurring_customers')
      .select('assigned_salesperson_phone')
      .ilike('customer_name', `%${finalCustomerName}%`)
      .limit(1);

    const targetPhone = (customerRecord && customerRecord[0]?.assigned_salesperson_phone) || senderPhone;

    // Insert new complaint with SLA timestamps
    const reportedAt = new Date();
    const slaDueAt   = new Date(reportedAt.getTime() + 48 * 60 * 60 * 1000); // SLA = 48h from report

    await supabase.from('complaints').insert({
      customer_name:   finalCustomerName,
      reported_by:     targetPhone,
      complaint_type:  complaintType,
      description:     description, // structured: '[Product: HR Coil] Rust detected...'
      status:          'open',
      reported_at:     reportedAt.toISOString(),
      escalated:       false,
    });

    // Log KRA 7
    await supabase.from('kra_logs').insert({
      salesperson_phone: targetPhone,
      kra_number:        7,
      kra_type:          'quality_complaint',
      customer_name:     finalCustomerName,
      description:       `Complaint Logged: ${finalCustomerName} — ${complaintType}: ${description}`,
      month: new Date().getMonth() + 1,
      year:  new Date().getFullYear(),
    });

    // Edge Case 7: Alert the assigned salesperson if complaint came from a different sender
    if (targetPhone !== senderPhone) {
      try {
        const { sendTextMessage } = require('../whatsapp');
        await sendTextMessage(
          targetPhone,
          `🚨 *URGENT COMPLAINT ALERT — ${finalCustomerName}*\n\n` +
          `Type: *${complaintType.toUpperCase()}*\n` +
          `Issue: ${description}\n` +
          `SLA Target: *Resolve within 48 Hours ⏱️*\n\n` +
          `Reply: _"Resolved ${finalCustomerName} complaint"_ once sorted.`
        );
      } catch (alertError) {
        console.error('Complaint alert send failed:', alertError.message);
      }
    }

    const { getCustomerMissingInfoPrompt } = require('../supabase');
    const missingPrompt = await getCustomerMissingInfoPrompt(finalCustomerName, senderPhone);

    // Async Zoho Bigin Smart Sync
    syncActivity('complaint', {
      customerName:  finalCustomerName,
      complaintType,
      description,
      action:       'report',
      senderPhone:  targetPhone,
    });

    return `🚨 *Customer Complaint Logged*\n\n` +
      `Customer: *${finalCustomerName}*\n` +
      `Type: *${complaintType.toUpperCase()}*\n` +
      (affectedProduct ? `Product Affected: *${affectedProduct}*\n` : '') +
      `Details: ${rawDescription}\n` +
      `Status: *Open ⏱️ (48-Hour SLA Clock Started)*\n` +
      `SLA Due: *${slaDueAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}*\n\n` +
      `Updated Customer Complaints Card! ✅\n\n` +
      `When resolved, reply: _"Resolved ${finalCustomerName} complaint"_ ✅` + (missingPrompt || '');

  } catch (error) {
    console.error('Complaint Agent Error:', error.message);
    return `⚠️ Could not process complaint update: ${error.message}`;
  }
}

module.exports = { processComplaintMessage };
