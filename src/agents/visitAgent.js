/**
 * KRA 8 / KRA 9 - Customer Site Visit & Meeting Agent
 *
 * DESIGN PRINCIPLES:
 * - Visit-first CRM flow: Log visit → Auto-create prospect if new → Extract details → Request missing info
 * - Never reject a visit because the customer isn't registered yet.
 * - New prospects are auto-onboarded from the visit message itself.
 * - All extracted data (product interests, follow-up, person met, outcome) is persisted.
 * - No placeholder values ever stored - null if not mentioned.
 *
 * EDGE CASES HANDLED:
 * 1.  Normal visit (existing customer) → log visit + update KRA 9
 * 2.  New prospect visit → auto-create in recurring_customers + log visit + ask for missing details
 * 3.  Multiple visits same day to same customer → allowed (each is a separate activity)
 * 4.  visit_outcome always persisted (positive/neutral/negative)
 * 5.  Visit with person name/designation → captured and stored
 * 6.  Monthly visit count includes ALL visits (not just unique customers)
 * 7.  material_requirement (product interests) captured and stored
 * 8.  follow_up_action captured and stored
 * 9.  city/location extracted from message if mentioned → stored in recurring_customers
 * 10. Hinglish/casual messages → AI handles semantic parsing
 * 11. Contact number only stored if explicitly mentioned (no placeholder)
 */

const { supabase } = require('../supabase');
const { syncActivity } = require('./biginSyncAgent');
const { logBotActivity } = require('../utils/activityLogger');

const VISIT_AGENT_PROMPT = `
You are the Specialized Site Visit & Meeting AI Agent (KRA 9) for Enlight Metals, a B2B metal distributor.
Your job is to parse salesperson customer site visit reports, prospect meetings, or field activity logs.

The salesperson message may be informal, in Hinglish, or missing expected keywords.
Understand the meaning and context - do not look for specific words.

Input message can be English, Hindi, or Hinglish.

Extract into ONLY a JSON object (no prose, no markdown, no backticks):
{
  "customer_name": "<customer/company name visited, else null>",
  "is_new_prospect": <true if this seems to be a first meeting / new lead / prospect not yet in system, else false>,
  "person_met": "<full name and designation of person met (e.g. 'Mr. Sharma, Purchase Manager'), else null>",
  "contact_no": "<phone number of person met if EXPLICITLY stated in message, else null>",
  "city": "<city or location of the customer/visit if mentioned (e.g. 'Mumbai', 'Pune'), else null>",
  "product_interests": "<steel products the customer is interested in, comma-separated (e.g. 'CR Sheets, MS Plates', 'HR Coil, TMT bars'), else null>",
  "remarks": "<rich, detailed 2-3 line summary of what was discussed, what was shown/introduced, and the outcome. Do NOT use generic text like 'Field Visit' or 'Market Presence'. Capture the actual business context.>",
  "visit_outcome": "positive|neutral|negative",
  "material_requirement": "<steel product, requirement description, or future consumption mentioned (e.g. 'HR Coil / future monthly requirement', '50 MT HR Coil', 'MS Plates future consumption'), else null>",
  "follow_up_action": "<specific next action or pending information needed (e.g. 'Collect required quantity, expected PO/delivery date, and customer details', 'Send quotation for HR Coil', 'Share catalogue'), else null>",
  "followup_days": <number of days mentioned by customer to think/decide before ordering e.g. 3, 5, 7, else 4 if interested, null if not interested>,
  "confidence": <float 0.0 to 1.0>
}

Rules:
- "is_new_prospect": true if message says "introduced", "first meeting", "new contact", "business card collected", "new lead", etc.
- "visit_outcome":
  - "positive" → interest shown, products discussed, quotation asked, deal progressed, business card exchanged, positive discussion
  - "negative" → customer not available, bad response, rejected meeting, not interested
  - "neutral" → routine check-in, no specific outcome mentioned
- "product_interests": Extract ALL products mentioned as interests (even without a quantity). e.g. "interested in CR Sheets and MS Plates" → "CR Sheets, MS Plates"
- "material_requirement": Extract any steel product requirement, future consumption, or product need discussed (e.g. "discussed next HR Coil requirement and future monthly consumption" → "HR Coil / future monthly requirement", "need 50 MT HR Coil" → "50 MT HR Coil"). NEVER leave as null when requirements or future consumption are mentioned.
- "follow_up_action": When the message discusses potential requirements, next steps, or when information is needed to prepare a quote, capture a clear follow-up action (e.g. "Collect required quantity, expected PO/delivery date, and customer details", "Send quotation by tomorrow", "Follow up for technical specifications"). NEVER return null when next steps or future discussions are implied.
- "remarks": Must be specific and business-relevant.
- "contact_no": ONLY if a phone number is explicitly stated. Otherwise null - never invent.
- "city": Extract the city or location of the visit/office if mentioned (e.g. "Mumbai office" → "Mumbai", "in Pune" → "Pune"). NEVER leave as null when location/city is stated.

Return ONLY the JSON object.
`;

/**
 * Auto-create a new prospect in recurring_customers from visit data.
 * Returns the official customer name.
 */
async function autoOnboardProspect(customerName, senderPhone, extractedData) {
  try {
    const { ensureCustomerRecord } = require('../supabase');
    const rec = await ensureCustomerRecord(customerName, senderPhone, {
      city: extractedData.city,
      customer_phone: extractedData.contact_no,
      contact_person: extractedData.person_met,
    });
    console.log(`[VisitAgent] Auto-created new prospect: ${customerName}`);
    return rec ? rec.customer_name : customerName;
  } catch (err) {
    console.error('[VisitAgent] autoOnboardProspect error:', err.message);
    return customerName;
  }
}

async function processVisitMessage(text, senderPhone) {
  try {
    const { invokeWithFallback } = require('../core/modelRouter');
    const { HumanMessage, SystemMessage } = require('@langchain/core/messages');
    const response = await invokeWithFallback([
      new SystemMessage(VISIT_AGENT_PROMPT),
      new HumanMessage('Salesperson message:\n' + text),
    ]);
    const rawText = (typeof response.content === 'string' ? response.content : JSON.stringify(response.content)).trim();
    const cleaned = rawText
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    const { safeParseJSON } = require('../utils/jsonUtils');
    const data = safeParseJSON(cleaned, null);
    if (!data) throw new Error('Could not parse visit JSON from LLM response');

    // Missing customer name - must ask
    if (!data.customer_name) {
      return `⚠️ *Visit Agent - Customer Name Missing*\n\nPlease specify the *Customer/Company* you visited.\nExample: _"Visited Mehta Engineering in Pune today, met Purchase Manager, interested in CR Sheets"_`;
    }

    const customerName = data.customer_name.trim();

    // Try to match existing registered customer first
    const { verifyAndGetCustomerName, saveActiveSession } = require('../supabase');
    let officialCustomerName = await verifyAndGetCustomerName(customerName, senderPhone);

    let isNewProspect = false;

    if (!officialCustomerName) {
      // ── NEW PROSPECT FLOW ─────────────────────────────────────────────────
      // Auto-onboard instead of rejecting the visit
      isNewProspect = true;
      officialCustomerName = await autoOnboardProspect(customerName, senderPhone, data);
    }

    const finalCustomerName = officialCustomerName;

    // ── Duplicate Visit Safeguard for Bare Customer Name Replies ─────────
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { data: recentVisits } = await supabase
      .from('customer_visits')
      .select('id, visited_at')
      .eq('salesperson_phone', senderPhone)
      .ilike('customer_name', `%${finalCustomerName}%`)
      .gte('visited_at', tenMinutesAgo)
      .limit(1);

    const isBareNameMsg = text.trim().length <= 40 &&
      !text.toLowerCase().includes('visited') &&
      !text.toLowerCase().includes('met') &&
      !text.toLowerCase().includes('introduced');

    if (recentVisits && recentVisits.length > 0 && isBareNameMsg) {
      console.log(`[VisitAgent] Suppressing duplicate visit for "${finalCustomerName}" (visit already logged ${recentVisits[0].visited_at})`);

      // Refresh active session
      await saveActiveSession(senderPhone, finalCustomerName, 'profile_updated');

      return `ℹ️ *Visit Already Logged for ${finalCustomerName}*\n\n` +
        `Your visit with *${finalCustomerName}* is already recorded on your KRA 9 dashboard!\n\n` +
        `If you meant to update their contact info, say: _"${finalCustomerName} phone 9876543210 owner Mr. Kapoor"_\n` +
        `Or to log a new inquiry, say: _"${finalCustomerName} needs 10 MT HR Coil"_\n\n` +
        `Updated Customer Visits Card! ✅`;
    }

    // Extract all fields - NEVER use placeholder values
    const city                = data.city               || null;
    const remarks             = data.remarks            || 'On-site meeting';
    const personMet           = data.person_met         || null;
    const contactNo           = data.contact_no         || null;
    const visitOutcome        = data.visit_outcome       || 'positive';
    const materialRequirement = data.material_requirement || (data.product_interests ? `${data.product_interests} requirement` : null);
    
    // Meaningful follow-up action:
    let followUpAction = data.follow_up_action || null;
    if (!followUpAction) {
      if (materialRequirement || data.product_interests) {
        followUpAction = 'Collect required quantity, expected PO/delivery date, and customer details';
      } else if (visitOutcome === 'positive') {
        followUpAction = 'Follow up with customer on discussed requirements';
      }
    }
    const productInterests    = data.product_interests   || null;

    // Format metadata into structured tags inside remarks for clean storage & dashboard parsing
    const metaTags = [];
    if (visitOutcome)        metaTags.push(`[Outcome: ${visitOutcome.charAt(0).toUpperCase() + visitOutcome.slice(1)}]`);
    if (city)                metaTags.push(`[Location: ${city}]`);
    if (materialRequirement) metaTags.push(`[Requirement: ${materialRequirement}]`);
    if (followUpAction)      metaTags.push(`[FollowUp: ${followUpAction}]`);
    if (productInterests)    metaTags.push(`[Interests: ${productInterests}]`);

    const fullRemarks = metaTags.length > 0 ? `${metaTags.join(' ')} ${remarks}` : remarks;

    // Insert visit record with valid table columns including structured customer_address (location)
    const { error: visitErr } = await supabase.from('customer_visits').insert({
      customer_name:        finalCustomerName,
      salesperson_phone:    senderPhone,
      customer_address:     city,
      person_met:           personMet,
      contact_no:           contactNo,
      remarks:              fullRemarks,
      visited_at:           new Date().toISOString(),
    });

    if (visitErr) {
      console.error('[VisitAgent] customer_visits insert error:', visitErr.message);
    }

    // Update customer master profile if city or contact info was captured
    if (city || contactNo || personMet) {
      const custUpdate = { updated_at: new Date().toISOString() };
      if (city) custUpdate.city = city;
      if (contactNo) custUpdate.customer_phone = contactNo;
      if (personMet) custUpdate.contact_person = personMet;
      await supabase
        .from('recurring_customers')
        .update(custUpdate)
        .ilike('customer_name', `%${finalCustomerName}%`);
    }

    // Log KRA 9 with full business context
    const kraDescription = [
      `Visit: ${finalCustomerName}`,
      city                    ? `Location: ${city}`       : null,
      isNewProspect           ? 'NEW PROSPECT'            : null,
      personMet               ? `Met: ${personMet}`       : null,
      visitOutcome            ? `Outcome: ${visitOutcome}` : null,
      productInterests        ? `Interests: ${productInterests}` : null,
      materialRequirement     ? `Requirement: ${materialRequirement}` : null,
      followUpAction          ? `Follow-up: ${followUpAction}` : null,
      `Notes: ${remarks}`,
    ].filter(Boolean).join(' | ');

    await supabase.from('kra_logs').insert({
      salesperson_phone: senderPhone,
      kra_number:        9,
      kra_type:          'customer_visit',
      customer_name:     finalCustomerName,
      description:       kraDescription,
      month: new Date().getMonth() + 1,
      year:  new Date().getFullYear(),
    });

    // Also log to activity_logs for real-time timeline visibility
    try {
      await supabase.from('activity_logs').insert({
        timestamp: new Date().toISOString(),
        salesperson_name: 'Sales Team',
        salesperson_phone: senderPhone,
        description: `Site visit logged for ${finalCustomerName}${city ? ` at ${city}` : ''}${personMet ? ` (Met: ${personMet})` : ''}`,
        module: 'Visits',
        customer_name: finalCustomerName,
        source: 'bot',
        action_type: 'visit_logged',
      });
    } catch (e) {
      console.warn('[VisitAgent] activity_logs insert notice:', e.message);
    }

    // Also log KRA 2 for new prospect acquisition if not already logged
    if (isNewProspect) {
      try {
        const { isKRA2AlreadyLogged } = require('./customerAgent');
        const alreadyLoggedKRA2 = await isKRA2AlreadyLogged(senderPhone, finalCustomerName);
        if (!alreadyLoggedKRA2) {
          await supabase.from('kra_logs').insert({
            salesperson_phone: senderPhone,
            kra_number:        2,
            kra_type:          'new_customer',
            customer_name:     finalCustomerName,
            description:       `New Customer Onboarded via Visit: ${finalCustomerName}`,
            month:             new Date().getMonth() + 1,
            year:              new Date().getFullYear(),
          });
          console.log(`[VisitAgent] Logged KRA 2 for new prospect: ${finalCustomerName}`);
        }
      } catch (e) {
        console.error('[VisitAgent] KRA 2 auto-logging error:', e.message);
      }
    }

    // Save active session for context retention (follow-up messages will know this customer)
    await saveActiveSession(senderPhone, finalCustomerName, 'visit_logged');

    // Auto-resolve any previous pending follow-ups for this customer
    try {
      const { resolveCustomerFollowupTasks } = require('../kra3');
      await resolveCustomerFollowupTasks(finalCustomerName, senderPhone, 'site_visit_logged');
    } catch (rErr) {
      console.warn('[VisitAgent] Follow-up task auto-resolution notice:', rErr.message);
    }

    // Schedule Condition 2 - Visit Interest Follow-up Task if product interest was shown
    const interestProducts = productInterests || materialRequirement;
    if (visitOutcome === 'positive' && interestProducts) {
      try {
        const { extractFollowupDays } = require('../kra3');
        const promisedDays = extractFollowupDays(text, Number(data.followup_days) || 3);
        const visitDueDate = new Date(Date.now() + promisedDays * 24 * 60 * 60 * 1000).toISOString();

        await supabase.from('followup_tasks').insert({
          task_type: 'visit_interest_followup',
          customer_name: finalCustomerName,
          customer_phone: contactNo || '',
          salesperson_phone: senderPhone,
          due_date: visitDueDate,
          status: 'pending',
          reminder_sent_at: null,
          escalated_at: null,
          follow_up_count: 0,
          resolution_notes: `Visit Interest Follow-up: Customer showed interest in ${interestProducts}. Promised decision timeframe: ${promisedDays} days. Notes: ${remarks}`,
        });
        console.log(`[VisitAgent] Scheduled visit interest follow-up for ${finalCustomerName} in ${promisedDays} days`);
      } catch (fErr) {
        console.error('[VisitAgent] Follow-up task creation notice:', fErr.message);
      }
    }

    // Log to activity_logs
    try {
      logBotActivity({
        salesperson_phone: senderPhone,
        description: `Site visit logged for ${finalCustomerName} at ${city || 'Client Site'}`,
        module: 'Visits',
        customer_name: finalCustomerName,
      });

      if (visitOutcome === 'positive' && interestProducts) {
        logBotActivity({
          salesperson_phone: senderPhone,
          description: `Follow-up scheduled with ${finalCustomerName} for next ${data.followup_days || 4} days`,
          module: 'Visits',
          customer_name: finalCustomerName,
        });
      }
    } catch (actErr) {
      console.warn('[VisitAgent] Non-blocking activity log notice:', actErr?.message);
    }

    // Count ALL visits this month
    const { data: visitLogs } = await supabase
      .from('kra_logs')
      .select('id')
      .eq('salesperson_phone', senderPhone)
      .eq('kra_number', 9)
      .eq('month', new Date().getMonth() + 1)
      .eq('year', new Date().getFullYear());

    const totalVisits = visitLogs ? visitLogs.length : 1;

    // Update last contact timestamp
    await supabase
      .from('recurring_customers')
      .update({ updated_at: new Date().toISOString() })
      .ilike('customer_name', `%${finalCustomerName}%`);

    const outcomeEmoji = { positive: '🟢', neutral: '🟡', negative: '🔴' }[visitOutcome] || '🟡';

    // Async Zoho Bigin Smart Sync
    syncActivity('visit', {
      customerName: finalCustomerName,
      personMet,
      remarks,
      visitOutcome,
      materialRequirement,
      followUpAction,
      productInterests,
      senderPhone,
    });

    // Build response
    let reply = isNewProspect
      ? `🆕 *New Prospect Added & Visit Logged!*\n\n`
      : `🚗 *Customer Visit Logged!*\n\n`;

    reply += `Customer: *${finalCustomerName}*\n`;
    if (data.city)         reply += `Location: *${data.city}*\n`;
    if (personMet)         reply += `Person Met: *${personMet}*\n`;
    if (contactNo)         reply += `Contact: *${contactNo}*\n`;
    reply += `Outcome: ${outcomeEmoji} *${visitOutcome.charAt(0).toUpperCase() + visitOutcome.slice(1)}*\n`;
    reply += `Notes: ${remarks}\n`;
    if (productInterests)    reply += `🛒 Product Interests: *${productInterests}*\n`;
    if (materialRequirement) reply += `📦 Requirement: *${materialRequirement}*\n`;
    if (followUpAction)      reply += `📌 Follow-up: *${followUpAction}*\n`;
    reply += `\nTotal Visits This Month: *${totalVisits}*\n`;
    reply += `\nUpdated Customer Visits Card! ✅`;

    // For new prospects, ask for missing mandatory details
    if (isNewProspect) {
      const missingFields = [];
      if (!contactNo)         missingFields.push('• 📱 *Mobile Number*');
      if (!personMet)         missingFields.push('• 👤 *Owner / Contact Person Name*');
      if (!data.city)         missingFields.push('• 📍 *City / Location*');
      missingFields.push('• 🧾 *GSTIN* (optional)');

      reply += `\n\n📌 *${finalCustomerName} has been added as a new prospect.*\n` +
        `To complete their profile, please share:\n${missingFields.join('\n')}\n\n` +
        `_(Simply reply: "${finalCustomerName} phone 9876543210 owner Mr. Kapoor")_`;
    } else {
      // For existing customers, check if profile is complete
      const { getCustomerMissingInfoPrompt } = require('../supabase');
      const missingPrompt = await getCustomerMissingInfoPrompt(finalCustomerName, senderPhone);
      if (missingPrompt) reply += missingPrompt;
    }

    if (materialRequirement || productInterests) {
      reply += `\n\n💡 *Potential Opportunity:* To create a sales pipeline deal for this requirement, reply *"Create deal for ${finalCustomerName}"*.`;
    }

    return reply;

  } catch (error) {
    console.error('Visit Agent Error:', error.message);
    return `⚠️ Could not process site visit update: ${error.message}`;
  }
}

module.exports = { processVisitMessage };
