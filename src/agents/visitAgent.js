/**
 * KRA 8 / KRA 9 - Customer Site Visit & Meeting Agent
 *
 * DESIGN PRINCIPLES:
 * - Visit-first CRM flow: Log visit -> Auto-create prospect if new -> Extract details -> Request missing mandatory fields.
 * - Never reject a visit because the customer isn't registered yet.
 * - Strict Zero-Hallucination: Never fabricate outcome, follow-up actions, discussion notes, or contact numbers.
 * - Required Fields Enforcement: Customer Name, Person Met, Contact Phone, City / Location, Visit Date, Visit Outcome, Meeting Remarks.
 * - Multi-Turn Gating: If required fields are missing, cache state in conversation_sessions and conversationally request missing fields.
 * - Deterministic Relative Date & Weekday Resolution: "yesterday", "last Monday", "this Friday", "3 days ago", "10th September".
 * - Smart Visit Corrections: Resolve target visit by date / customer directly without unnecessary disambiguation; handle numbered disambiguation replies without new visit gating.
 * - Strict WhatsApp Formatting: Zero emojis, hyphen bullet lists (- ), official Card Name "Customer Visits Card".
 * - Parity across em-os-bot and em-os-backend.
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
  "person_met": "<full name and/or designation of person met (e.g. 'Mr. Vivek Jain, Purchase Manager'), else null>",
  "contact_no": "<10-digit phone number of person met if EXPLICITLY stated in message, else null>",
  "city": "<city or location of the customer/visit if mentioned (e.g. 'Nashik', 'Mumbai', 'Pune'), else null>",
  "visit_date": "<explicit or relative date mentioned e.g. 'yesterday', 'day before yesterday', 'last Monday', '9/9/2026', '10th September', 'today', else null>",
  "product_interests": "<steel products the customer is interested in, comma-separated (e.g. 'CR Sheets, MS Plates', 'HR Coil'), else null>",
  "remarks": "<factual 1-3 line summary of what was discussed, what was shown/introduced, and meeting context strictly based on user message. If no discussion details were mentioned, output null>",
  "visit_outcome": "<'positive', 'neutral', or 'negative' ONLY if explicitly stated or clearly indicated. If not mentioned, output null>",
  "material_requirement": "<steel product or requirement description mentioned (e.g. 'MS plate order', '50 MT HR Coil'), else null>",
  "follow_up_action": "<specific next action explicitly stated in the message (e.g. 'Send MS plate samples', 'Share quotation by tomorrow'), else null>",
  "followup_days": <number of days mentioned by customer to think/decide before ordering e.g. 3, 5, 7, else null>,
  "confidence": <float 0.0 to 1.0>
}

Rules:
- "customer_name": Extract the EXACT company/customer name stated. NEVER guess or invent company names.
- "person_met": Extract the person name and/or designation met. If none mentioned, output null. NEVER invent names.
- "contact_no": ONLY if a phone number is explicitly stated. Otherwise null - NEVER invent.
- "city": Extract the city or location of the visit if mentioned. Otherwise null - NEVER invent.
- "visit_outcome": Output "positive", "neutral", or "negative" ONLY if explicitly mentioned or clearly stated by the salesperson (e.g. "positive discussion", "meeting went well", "rejected", "not interested", "neutral check-in"). If no outcome is mentioned, output null. DO NOT default to positive or neutral.
- "remarks": Extract the actual discussion details, meeting summary, or purpose. If the user only said "Visited XYZ", output null. NEVER fabricate generic text like "Site visit conducted with XYZ Steel" or "Market presence".
- "follow_up_action": ONLY extract a follow-up action if explicitly stated (e.g. "follow-up needed to send samples", "send quote tomorrow"). If no follow-up was mentioned, output null. NEVER invent actions like "Routine follow-up" or "Collect required quantity".
- "visit_date": Extract any mentioned date, relative date, or weekday ("yesterday", "last Monday", "parso", "today", "10th September").

Return ONLY the JSON object.
`;

const CONTINUATION_PROMPT = `
You are updating pending customer visit details for a CRM visit log.

Salesperson follow-up message:
"{text}"

Extract any provided or updated fields:
{
  "person_met": "<updated full name and/or designation of person met if provided, else null>",
  "contact_no": "<updated phone number of person met if provided, else null>",
  "city": "<updated city / location if provided, else null>",
  "visit_date": "<updated date if provided e.g. 'yesterday', 'last Monday', '9 Sep 2026', else null>",
  "visit_outcome": "<'positive', 'neutral', or 'negative' if stated or clearly implied, else null>",
  "remarks": "<updated or additional discussion notes if provided, else null>",
  "product_interests": "<updated product interests if provided, else null>",
  "material_requirement": "<updated material requirement if provided, else null>",
  "follow_up_action": "<updated follow up action if provided, else null>",
  "is_unrelated_command": <true if the salesperson is ignoring this visit flow and giving an unrelated query or creating an unrelated deal/order for another company, else false>
}

Rules:
- "contact_no": Extract phone numbers (e.g. 9822012345, +91-9822012345, 98220 12345).
- "visit_outcome": "positive", "neutral", or "negative" if mentioned (e.g. "positive", "went well", "good", "deal positive" -> positive; "neutral", "okay", "routine" -> neutral; "negative", "rejected", "not interested" -> negative).
- "is_unrelated_command": true ONLY if the message is clearly a separate new inquiry for a different company or an unrelated command/query (e.g. "check my kra", "Delta steel needs 100 MT").

Return ONLY the JSON object.
`;

const CORRECTION_EXTRACTION_PROMPT = `
You are the Specialized Operational AI Agent for Enlight Metals CRM (Customer Site Visits - KRA 9).
The user is requesting to correct or update details of a previously logged customer site visit or meeting.

Input message can be English, Hindi, or Hinglish.

Extract the correction request into ONLY a valid JSON object (no markdown, no backticks):
{
  "customer_name": "<exact customer/company name if explicitly mentioned in message, else null>",
  "target_field": "person_met|contact_no|customer_address|visit_outcome|remarks",
  "new_value": "<the new/corrected value to set (e.g. 'neutral', 'Suresh Patel', '9822012345')>",
  "old_value": "<the old/incorrect value mentioned to be replaced (e.g. 'positive', 'Rajesh Sharma'), else null>",
  "visit_date": "<explicit date or relative date mentioned for the visit e.g. '10th September', 'yesterday', 'last Monday', '9 Sep 2026', else null>",
  "is_last_visit_reference": <true if message refers to 'my last visit', 'recent visit', 'previous visit', etc., else false>
}

Rules:
- "target_field":
  * "person_met" if updating contact person, person met, who they met (e.g. "Suresh Patel instead of Rajesh Sharma")
  * "contact_no" if updating phone number or mobile number
  * "customer_address" if updating location, city, or address (e.g. "Nashik not Pune")
  * "visit_outcome" if updating visit outcome (positive, neutral, negative)
  * "remarks" if updating discussion notes or remarks
- "new_value": The value it SHOULD be (e.g. "neutral", "Suresh Patel")
- "old_value": The value it should NOT be / was previously (e.g. "positive", "Rajesh Sharma")
- "visit_date": Extract any explicit or relative date specified in the request (e.g. "10th September", "yesterday", "last Monday").
- "customer_name": Extract exact company name if mentioned, otherwise null.

Return ONLY the JSON object.
`;

/**
 * Format a Date object into standard display and storage metadata
 */
function formatResolvedDate(d) {
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const day = d.getDate();
  const monthStr = months[d.getMonth()];
  const year = d.getFullYear();
  return {
    dateObj: d,
    isoString: d.toISOString(),
    formattedDisplay: `${day} ${monthStr} ${year}`,
    month: d.getMonth() + 1,
    year: year,
  };
}

/**
 * Deterministic Date Resolver: Handles relative expressions ("yesterday", "day before yesterday", "parso",
 * relative weekdays like "last Monday", "this Tuesday", "3 days ago") and natural explicit dates.
 */
function resolveVisitDate(text, dateFromLlm) {
  const now = new Date();
  const lowerText = (text || '').toLowerCase();
  const lowerLlm = (dateFromLlm || '').toLowerCase().trim();

  // 1. Check relative date keywords in LLM output or text
  if (
    lowerLlm.includes('day before yesterday') ||
    lowerLlm.includes('parso') ||
    lowerText.includes('day before yesterday') ||
    /\bparso(?:n)?\b/.test(lowerText)
  ) {
    const d = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
    return formatResolvedDate(d);
  }

  if (
    lowerLlm.includes('tarso') ||
    lowerText.includes('tarso') ||
    /\btarso(?:n)?\b/.test(lowerText) ||
    lowerText.includes('3 days ago') ||
    lowerLlm.includes('3 days ago')
  ) {
    const d = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
    return formatResolvedDate(d);
  }

  // "N days ago" / "N din pehle"
  const nDaysAgoMatch =
    lowerText.match(/\b(\d+)\s*(?:days?\s+ago|din\s+pehle)\b/i) ||
    lowerLlm.match(/\b(\d+)\s*(?:days?\s+ago|din\s+pehle)\b/i);
  if (nDaysAgoMatch) {
    const n = parseInt(nDaysAgoMatch[1], 10);
    if (!isNaN(n) && n > 0 && n <= 365) {
      const d = new Date(now.getTime() - n * 24 * 60 * 60 * 1000);
      return formatResolvedDate(d);
    }
  }

  if (
    lowerLlm.includes('yesterday') ||
    lowerLlm.includes('kal') ||
    lowerText.includes('yesterday') ||
    /\bkal\b/.test(lowerText)
  ) {
    const d = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);
    return formatResolvedDate(d);
  }

  // 2. Relative Weekdays: "last Monday", "last week Monday", "this Monday", "on Monday", "Monday ko", "pichle somwar"
  const weekdayMap = {
    sunday: 0,
    raviwar: 0,
    itwar: 0,
    monday: 1,
    somwar: 1,
    tuesday: 2,
    mangalwar: 2,
    wednesday: 3,
    budhwar: 3,
    thursday: 4,
    guruwar: 4,
    veervar: 4,
    friday: 5,
    shukrawar: 5,
    saturday: 6,
    shaniwar: 6,
  };

  const weekdayRegex =
    /\b(?:(last(?:\s+week)?|past(?:\s+week)?|previous(?:\s+week)?|this(?:\s+week)?|on|pichle(?:\s+hafte)?)\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday|somwar|mangalwar|budhwar|guruwar|veervar|shukrawar|shaniwar|raviwar|itwar)(?:\s+ko)?\b/i;
  const matchWeekday =
    lowerText.match(weekdayRegex) || lowerLlm.match(weekdayRegex);

  if (matchWeekday) {
    const prefix = (matchWeekday[1] || '').toLowerCase();
    const dayName = matchWeekday[2].toLowerCase();
    const targetDay = weekdayMap[dayName];

    if (targetDay !== undefined) {
      const currentDay = now.getDay(); // 0-6 (0 is Sunday, 4 is Thursday)
      let diff = currentDay - targetDay;
      if (
        prefix.includes('last') ||
        prefix.includes('past') ||
        prefix.includes('previous') ||
        prefix.includes('pichle')
      ) {
        if (diff <= 0) {
          diff += 7;
        }
      } else if (prefix === 'this') {
        if (diff < 0) {
          diff += 7;
        }
      } else {
        if (diff <= 0) {
          diff += 7;
        }
      }
      const d = new Date(now.getTime() - diff * 24 * 60 * 60 * 1000);
      return formatResolvedDate(d);
    }
  }

  // 3. Explicit date from LLM (e.g. "2026-09-09" or ISO format)
  if (lowerLlm && !['today', 'aaj', 'null'].includes(lowerLlm)) {
    const parsed = new Date(dateFromLlm);
    if (!isNaN(parsed.getTime())) {
      return formatResolvedDate(parsed);
    }
  }

  // 4. Regex for ISO format YYYY-MM-DD
  const isoMatch = lowerText.match(/\b(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})\b/);
  if (isoMatch) {
    const year = parseInt(isoMatch[1], 10);
    const month = parseInt(isoMatch[2], 10) - 1;
    const day = parseInt(isoMatch[3], 10);
    const d = new Date(year, month, day);
    if (!isNaN(d.getTime())) {
      return formatResolvedDate(d);
    }
  }

  // 5. Regex for DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY
  const dmyMatch = lowerText.match(
    /\b(\d{1,2})[\/\-\.](\d{1,2})(?:[\/\-\.](\d{2,4}))?\b/,
  );
  if (dmyMatch) {
    const day = parseInt(dmyMatch[1], 10);
    const month = parseInt(dmyMatch[2], 10) - 1;
    let year = dmyMatch[3] ? parseInt(dmyMatch[3], 10) : now.getFullYear();
    if (year < 100) year += 2000;
    const d = new Date(year, month, day);
    if (!isNaN(d.getTime())) {
      return formatResolvedDate(d);
    }
  }

  const monthNames = [
    'jan',
    'feb',
    'mar',
    'apr',
    'may',
    'jun',
    'jul',
    'aug',
    'sep',
    'oct',
    'nov',
    'dec',
  ];

  // 6. Regex for Day Month: "10th September", "9th Sep", "9 September", "5th September 2026"
  const dayMonthMatch =
    lowerText.match(
      /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+(\d{2,4}))?\b/i,
    ) ||
    lowerLlm.match(
      /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+(\d{2,4}))?\b/i,
    );

  if (dayMonthMatch) {
    const day = parseInt(dayMonthMatch[1], 10);
    const month = monthNames.findIndex((m) =>
      dayMonthMatch[2].toLowerCase().startsWith(m),
    );
    let year = dayMonthMatch[3]
      ? parseInt(dayMonthMatch[3], 10)
      : now.getFullYear();
    if (year < 100) year += 2000;
    if (month >= 0) {
      const d = new Date(year, month, day);
      if (!isNaN(d.getTime())) {
        return formatResolvedDate(d);
      }
    }
  }

  // 7. Regex for Month Day: "September 5th", "Sep 5", "September 5, 2026"
  const monthDayMatch =
    lowerText.match(
      /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*,?\s*(\d{2,4}))?\b/i,
    ) ||
    lowerLlm.match(
      /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*,?\s*(\d{2,4}))?\b/i,
    );

  if (monthDayMatch) {
    const month = monthNames.findIndex((m) =>
      monthDayMatch[1].toLowerCase().startsWith(m),
    );
    const day = parseInt(monthDayMatch[2], 10);
    let year = monthDayMatch[3]
      ? parseInt(monthDayMatch[3], 10)
      : now.getFullYear();
    if (year < 100) year += 2000;
    if (month >= 0) {
      const d = new Date(year, month, day);
      if (!isNaN(d.getTime())) {
        return formatResolvedDate(d);
      }
    }
  }

  // Default to today
  return formatResolvedDate(now);
}

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

/**
 * Builds conversational prompt requesting missing required fields
 */
function buildMissingFieldsPrompt(visitState, missingFields) {
  let reply = `Customer Visit Details Needed\n\n`;
  reply += `I have noted the initial visit details for ${visitState.customer_name}:\n`;
  reply += `- Customer: ${visitState.customer_name}\n`;
  reply += `- Visit Date: ${visitState.visit_date_display}\n`;
  reply += `- Location: ${visitState.city || 'Not provided'}\n`;
  reply += `- Person Met: ${visitState.person_met || 'Not provided'}\n`;
  reply += `- Contact Phone: ${visitState.contact_no || 'Not provided'}\n`;
  reply += `- Outcome: ${visitState.visit_outcome ? visitState.visit_outcome.charAt(0).toUpperCase() + visitState.visit_outcome.slice(1) : 'Not provided'}\n`;
  reply += `- Discussion Notes: ${visitState.remarks || 'Not provided'}\n`;
  if (visitState.product_interests)
    reply += `- Product Interests: ${visitState.product_interests}\n`;
  if (visitState.material_requirement)
    reply += `- Requirement: ${visitState.material_requirement}\n`;
  if (visitState.follow_up_action)
    reply += `- Follow-up: ${visitState.follow_up_action}\n`;

  reply += `\nTo log this visit to your Customer Visits Card, please provide the following required details:\n`;
  missingFields.forEach((f, idx) => {
    reply += `${idx + 1}. ${f}\n`;
  });

  reply += `\n(Reply with the details to complete logging this visit)`;
  return reply;
}

/**
 * Validates required visit fields (Customer Name, Person Met, Contact Phone, City, Outcome, Remarks, Date)
 */
function getMissingRequiredFields(visitState) {
  const missing = [];
  if (!visitState.person_met || visitState.person_met === 'Not provided') {
    missing.push('Person Met (Name or designation of person met)');
  }
  if (!visitState.contact_no || visitState.contact_no === 'Not provided') {
    missing.push('Contact Phone (Mobile number of person met)');
  }
  if (!visitState.city || visitState.city === 'Not provided') {
    missing.push('City / Location (Location of visit or office)');
  }
  if (
    !visitState.visit_outcome ||
    !['positive', 'neutral', 'negative'].includes(
      visitState.visit_outcome.toLowerCase(),
    )
  ) {
    missing.push('Visit Outcome (Positive / Neutral / Negative)');
  }
  if (!visitState.remarks || visitState.remarks === 'Not provided') {
    missing.push(
      'Discussion Notes / Remarks (What was discussed during the meeting)',
    );
  }
  return missing;
}

/**
 * Saves completed visit to customer_visits, kra_logs, recurring_customers, and triggers sync
 */
async function saveCompletedVisit(visitState, senderPhone) {
  const {
    customer_name,
    person_met,
    contact_no,
    city,
    visit_outcome,
    remarks,
    product_interests,
    material_requirement,
    follow_up_action,
    followup_days,
    visit_date_iso,
    visit_date_display,
    visit_date_month,
    visit_date_year,
    is_new_prospect,
  } = visitState;

  // Match or auto-onboard
  const {
    verifyAndGetCustomerName,
    saveActiveSession,
  } = require('../supabase');
  let officialCustomerName = await verifyAndGetCustomerName(
    customer_name,
    senderPhone,
  );
  let isNew = is_new_prospect;
  if (!officialCustomerName) {
    isNew = true;
    officialCustomerName = await autoOnboardProspect(
      customer_name,
      senderPhone,
      {
        city,
        contact_no,
        person_met,
      },
    );
  }
  const finalCustomerName = officialCustomerName || customer_name;

  // Infer outcome from remarks if visit_outcome is not explicitly provided
  let finalOutcome = visit_outcome ? visit_outcome.toLowerCase() : null;
  if (!finalOutcome && remarks) {
    const lowerRem = remarks.toLowerCase();
    if (
      /\b(?:negative|bad|rejected|rejection|unsuccessful|declined|not\s+(?:at\s+all\s+)?inter(?:e)?sted|uninterested|no\s+interest|not\s+buying|not\s+interested|no\s+(?:immediate\s+)?need|no\s+requirement|refused|unfavorable|dissatisfied|cancelled|lost)\b/i.test(
        lowerRem,
      ) ||
      /\b(?:nahi\s+chahiye|interest\s+nahi|mana\s+kar\s+diya|reject\s+hua)\b/i.test(
        lowerRem,
      )
    ) {
      finalOutcome = 'negative';
    } else if (
      /\b(?:positive|went\s+well|good|great|successful|favorable|interested|keen|promising|order\s+confirmed|deal\s+done)\b/i.test(
        lowerRem,
      ) &&
      !/\b(?:not\s+|no\s+|nahi\s+)(?:positive|good|great|interested|keen|promising)\b/i.test(
        lowerRem,
      )
    ) {
      finalOutcome = 'positive';
    } else if (
      /\b(?:neutral|routine|okay|ok|normal|general\s+visit|courtesy\s+visit|check-?in|introductory|introduction)\b/i.test(
        lowerRem,
      )
    ) {
      finalOutcome = 'neutral';
    }
  }

  // Format metaTags in remarks
  const metaTags = [];
  if (finalOutcome)
    metaTags.push(
      `[Outcome: ${finalOutcome.charAt(0).toUpperCase() + finalOutcome.slice(1)}]`,
    );
  if (city) metaTags.push(`[Location: ${city}]`);
  if (material_requirement)
    metaTags.push(`[Requirement: ${material_requirement}]`);
  if (follow_up_action) metaTags.push(`[FollowUp: ${follow_up_action}]`);
  if (product_interests) metaTags.push(`[Interests: ${product_interests}]`);

  const fullRemarks =
    metaTags.length > 0
      ? remarks
        ? `${metaTags.join(' ')} ${remarks}`
        : metaTags.join(' ')
      : remarks || null;

  // Insert into customer_visits
  const { error: visitErr } = await supabase.from('customer_visits').insert({
    customer_name: finalCustomerName,
    salesperson_phone: senderPhone,
    customer_address: city,
    person_met: person_met,
    contact_no: contact_no,
    remarks: fullRemarks,
    visited_at: visit_date_iso || new Date().toISOString(),
  });
  if (visitErr) {
    console.error(
      '[VisitAgent] customer_visits insert error:',
      visitErr.message,
    );
  }

  // Update customer master profile in recurring_customers
  if (city || contact_no || person_met) {
    const custUpdate = { updated_at: new Date().toISOString() };
    if (city) custUpdate.city = city;
    if (contact_no) custUpdate.customer_phone = contact_no;
    if (person_met) custUpdate.contact_person = person_met;
    await supabase
      .from('recurring_customers')
      .update(custUpdate)
      .ilike('customer_name', `%${finalCustomerName}%`);
  }

  // Log KRA 9 with full business context
  const kraDescription = [
    `Visit: ${finalCustomerName}`,
    city ? `Location: ${city}` : null,
    isNew ? 'NEW PROSPECT' : null,
    person_met ? `Met: ${person_met}` : null,
    finalOutcome ? `Outcome: ${finalOutcome}` : null,
    product_interests ? `Interests: ${product_interests}` : null,
    material_requirement ? `Requirement: ${material_requirement}` : null,
    follow_up_action ? `Follow-up: ${follow_up_action}` : null,
    remarks ? `Notes: ${remarks}` : null,
  ]
    .filter(Boolean)
    .join(' | ');

  await supabase.from('kra_logs').insert({
    salesperson_phone: senderPhone,
    kra_number: 9,
    kra_type: 'customer_visit',
    customer_name: finalCustomerName,
    description: kraDescription,
    month: visit_date_month || new Date().getMonth() + 1,
    year: visit_date_year || new Date().getFullYear(),
  });

  // Log to activity_logs
  try {
    await supabase.from('activity_logs').insert({
      timestamp: new Date().toISOString(),
      salesperson_name: 'Sales Team',
      salesperson_phone: senderPhone,
      description: `Site visit logged for ${finalCustomerName}${city ? ` at ${city}` : ''}${person_met ? ` (Met: ${person_met})` : ''}`,
      module: 'Visits',
      customer_name: finalCustomerName,
      source: 'bot',
      action_type: 'visit_logged',
    });
  } catch (e) {
    console.warn('[VisitAgent] activity_logs insert notice:', e.message);
  }

  // Log KRA 2 if new prospect
  if (isNew) {
    try {
      const { isKRA2AlreadyLogged } = require('./customerAgent');
      const alreadyLoggedKRA2 = await isKRA2AlreadyLogged(
        senderPhone,
        finalCustomerName,
      );
      if (!alreadyLoggedKRA2) {
        await supabase.from('kra_logs').insert({
          salesperson_phone: senderPhone,
          kra_number: 2,
          kra_type: 'new_customer',
          customer_name: finalCustomerName,
          description: `New Customer Onboarded via Visit: ${finalCustomerName}`,
          month: visit_date_month || new Date().getMonth() + 1,
          year: visit_date_year || new Date().getFullYear(),
        });
      }
    } catch (e) {
      console.error('[VisitAgent] KRA 2 auto-logging error:', e.message);
    }
  }

  // Resolve pending follow-up tasks
  try {
    const { resolveCustomerFollowupTasks } = require('../kra3');
    await resolveCustomerFollowupTasks(
      finalCustomerName,
      senderPhone,
      'site_visit_logged',
    );
  } catch (rErr) {
    console.warn(
      '[VisitAgent] Follow-up task auto-resolution notice:',
      rErr.message,
    );
  }

  // Schedule follow-up task if positive outcome and interest
  const interestProducts = product_interests || material_requirement;
  if (finalOutcome === 'positive' && interestProducts) {
    try {
      const { extractFollowupDays } = require('../kra3');
      const promisedDays = extractFollowupDays(
        remarks || '',
        Number(followup_days) || 3,
      );
      const visitDueDate = new Date(
        Date.now() + promisedDays * 24 * 60 * 60 * 1000,
      ).toISOString();

      await supabase.from('followup_tasks').insert({
        task_type: 'visit_interest_followup',
        customer_name: finalCustomerName,
        customer_phone: contact_no || '',
        salesperson_phone: senderPhone,
        due_date: visitDueDate,
        status: 'pending',
        reminder_sent_at: null,
        escalated_at: null,
        follow_up_count: 0,
        resolution_notes: `Visit Interest Follow-up: Customer showed interest in ${interestProducts}. Promised decision timeframe: ${promisedDays} days. Notes: ${remarks}`,
      });
    } catch (fErr) {
      console.error(
        '[VisitAgent] Follow-up task creation notice:',
        fErr.message,
      );
    }
  }

  // Count visits this month
  const targetMonth = visit_date_month || new Date().getMonth() + 1;
  const targetYear = visit_date_year || new Date().getFullYear();
  const { data: visitLogs } = await supabase
    .from('kra_logs')
    .select('id')
    .eq('salesperson_phone', senderPhone)
    .eq('kra_number', 9)
    .eq('month', targetMonth)
    .eq('year', targetYear);

  const totalVisits = visitLogs ? visitLogs.length : 1;

  // Sync to Zoho Bigin
  syncActivity('visit', {
    customerName: finalCustomerName,
    personMet: person_met,
    remarks,
    visitOutcome: finalOutcome,
    materialRequirement: material_requirement,
    followUpAction: follow_up_action,
    productInterests: product_interests,
    senderPhone,
  });

  // Save active session for context retention
  await saveActiveSession(senderPhone, finalCustomerName, 'visit_logged');

  // Build formatted reply (ZERO EMOJIS, CLEAN HYPHENS, CARD NAME)
  let reply = isNew
    ? `New Prospect Added & Customer Visit Logged\n\n`
    : `Customer Visit Logged\n\n`;

  reply += `Customer: ${finalCustomerName}\n`;
  reply += `- Visit Date: ${visit_date_display}\n`;
  if (city) reply += `- Location: ${city}\n`;
  if (person_met) reply += `- Person Met: ${person_met}\n`;
  if (contact_no) reply += `- Contact Phone: ${contact_no}\n`;
  if (finalOutcome)
    reply += `- Outcome: ${finalOutcome.charAt(0).toUpperCase() + finalOutcome.slice(1)}\n`;
  if (remarks) reply += `- Discussion Notes: ${remarks}\n`;
  if (product_interests) reply += `- Product Interests: ${product_interests}\n`;
  if (material_requirement) reply += `- Requirement: ${material_requirement}\n`;
  if (follow_up_action) reply += `- Follow-up: ${follow_up_action}\n`;

  reply += `\nTotal Visits This Month: ${totalVisits}\n\n`;
  reply += `Updated Customer Visits Card!`;

  if (material_requirement || product_interests) {
    reply += `\n\nPotential Opportunity: To create a sales pipeline deal for this requirement, reply "Create deal for ${finalCustomerName}".`;
  }

  return reply;
}

/**
 * Handles multi-turn continuation when user supplies missing visit details
 */
async function handlePendingVisitContinuation(text, senderPhone, storedState) {
  const { saveActiveSession } = require('../supabase');

  // 1. Cancellation check
  if (/^(?:cancel|discard|abort|stop|exit)$/i.test(text.trim())) {
    await saveActiveSession(senderPhone, 'Unknown', 'general');
    return `Visit logging for ${storedState.customer_name} cancelled.`;
  }

  // 2. Invoke LLM to extract fields from continuation reply
  const { invokeWithFallback } = require('../core/modelRouter');
  const { HumanMessage, SystemMessage } = require('@langchain/core/messages');
  const { safeParseJSON } = require('../utils/jsonUtils');

  let extracted = {};
  try {
    const response = await invokeWithFallback([
      new SystemMessage(CONTINUATION_PROMPT),
      new HumanMessage(`Salesperson follow-up message:\n${text}`),
    ]);
    const rawText = (
      typeof response.content === 'string'
        ? response.content
        : JSON.stringify(response.content)
    ).trim();
    const cleaned = rawText
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    extracted = safeParseJSON(cleaned, {}) || {};
  } catch (err) {
    console.warn(
      '[VisitAgent] Continuation extraction fallback notice:',
      err.message,
    );
  }

  // 3. Regex Fallbacks for robustness
  const phoneMatch = text.match(/(?:\+91[\-\s]?)?([6-9]\d{9})\b/);
  if (phoneMatch && !extracted.contact_no) {
    extracted.contact_no = phoneMatch[1];
  }

  if (!extracted.visit_outcome) {
    if (
      /\b(?:negative|bad|rejected|rejection|unsuccessful|declined|not\s+(?:at\s+all\s+)?inter(?:e)?sted|uninterested|no\s+interest|not\s+buying|not\s+interested|no\s+(?:immediate\s+)?need|no\s+requirement|refused|unfavorable|dissatisfied|cancelled|lost)\b/i.test(
        text,
      ) ||
      /\b(?:nahi\s+chahiye|interest\s+nahi|mana\s+kar\s+diya|reject\s+hua)\b/i.test(
        text,
      )
    ) {
      extracted.visit_outcome = 'negative';
    } else if (
      /\b(?:positive|went\s+well|good|great|successful|favorable|interested|keen|promising|order\s+confirmed|deal\s+done)\b/i.test(
        text,
      ) &&
      !/\b(?:not\s+|no\s+|nahi\s+)(?:positive|good|great|interested|keen|promising)\b/i.test(
        text,
      )
    ) {
      extracted.visit_outcome = 'positive';
    } else if (
      /\b(?:neutral|routine|okay|ok|normal|general\s+visit|courtesy\s+visit|check-?in|introductory|introduction)\b/i.test(
        text,
      )
    ) {
      extracted.visit_outcome = 'neutral';
    }
  }

  // If unrelated command and no fields extracted, release session
  if (
    extracted.is_unrelated_command &&
    !extracted.contact_no &&
    !extracted.visit_outcome &&
    !extracted.person_met &&
    !extracted.remarks &&
    !extracted.city
  ) {
    await saveActiveSession(senderPhone, 'Unknown', 'general');
    return null; // Allows orchestrator to handle as a fresh turn
  }

  // 4. Merge newly extracted fields into storedState
  if (extracted.person_met) storedState.person_met = extracted.person_met;
  if (extracted.contact_no) storedState.contact_no = extracted.contact_no;
  if (extracted.city) storedState.city = extracted.city;
  if (extracted.visit_outcome)
    storedState.visit_outcome = extracted.visit_outcome.toLowerCase();
  if (extracted.remarks) {
    storedState.remarks = storedState.remarks
      ? `${storedState.remarks}. ${extracted.remarks}`
      : extracted.remarks;
  }
  if (extracted.product_interests)
    storedState.product_interests = extracted.product_interests;
  if (extracted.material_requirement)
    storedState.material_requirement = extracted.material_requirement;
  if (extracted.follow_up_action)
    storedState.follow_up_action = extracted.follow_up_action;

  if (extracted.visit_date) {
    const resolved = resolveVisitDate(text, extracted.visit_date);
    storedState.visit_date_iso = resolved.isoString;
    storedState.visit_date_display = resolved.formattedDisplay;
    storedState.visit_date_month = resolved.month;
    storedState.visit_date_year = resolved.year;
  }

  // 5. Re-check missing required fields
  const missingFields = getMissingRequiredFields(storedState);

  if (missingFields.length > 0) {
    await saveActiveSession(
      senderPhone,
      storedState.customer_name,
      `pending_visit_details|${storedState.customer_name}|${JSON.stringify(storedState)}`,
    );
    return buildMissingFieldsPrompt(storedState, missingFields);
  }

  // 6. All required fields are present -> Save completed visit!
  return await saveCompletedVisit(storedState, senderPhone);
}

/**
 * Handles ambiguous or explicit visit corrections
 */
async function handleVisitCorrection(text, senderPhone) {
  try {
    const { invokeWithFallback } = require('../core/modelRouter');
    const { HumanMessage, SystemMessage } = require('@langchain/core/messages');
    const { safeParseJSON } = require('../utils/jsonUtils');
    const {
      saveActiveSession,
      verifyAndGetCustomerName,
    } = require('../supabase');

    const response = await invokeWithFallback([
      new SystemMessage(CORRECTION_EXTRACTION_PROMPT),
      new HumanMessage('User correction request:\n' + text),
    ]);
    const rawText = (
      typeof response.content === 'string'
        ? response.content
        : JSON.stringify(response.content)
    ).trim();
    const cleaned = rawText
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    const data = safeParseJSON(cleaned, null);

    let customerName = data?.customer_name || null;
    let targetField = data?.target_field || 'person_met';
    let newValue = data?.new_value || null;
    let oldValue = data?.old_value || null;
    let visitDateRef = data?.visit_date || null;

    if (!newValue) {
      const matchShouldBe = text.match(
        /(?:it\s*should\s*be|should\s*be|set\s*to|is|to)\s+([A-Za-z0-9\s]+?)(?:\s+(?:not|instead\s*of|from)\s+([A-Za-z0-9\s]+))?$/i,
      );
      if (matchShouldBe) {
        newValue = matchShouldBe[1].trim();
        if (matchShouldBe[2]) oldValue = matchShouldBe[2].trim();
      }
    }

    if (!newValue) {
      return `Visit Correction\n\nPlease specify the corrected detail (e.g. "Change the outcome to Neutral for the visit at ABC Steel on 10th September").`;
    }

    // Standardize outcome string if field is visit_outcome
    if (
      targetField === 'visit_outcome' ||
      /\b(?:positive|neutral|negative)\b/i.test(newValue)
    ) {
      targetField = 'visit_outcome';
      if (/\bpositive\b/i.test(newValue)) newValue = 'Positive';
      else if (/\bnegative\b/i.test(newValue)) newValue = 'Negative';
      else if (/\bneutral\b/i.test(newValue)) newValue = 'Neutral';
    }

    // Check if text or extraction contains date reference
    if (!visitDateRef) {
      const dateMatch = text.match(
        /\b(?:\d{1,2}(?:st|nd|rd|th)?\s+(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)|yesterday|last\s+\w+|parso)\b/i,
      );
      if (dateMatch) {
        visitDateRef = dateMatch[0];
      }
    }

    // Fetch recent visits to resolve target
    let query = supabase
      .from('customer_visits')
      .select(
        'id, customer_name, customer_address, person_met, contact_no, remarks, visited_at, salesperson_phone, outcome',
      )
      .order('visited_at', { ascending: false })
      .limit(15);

    if (senderPhone) {
      query = query.or(
        `salesperson_phone.eq.${senderPhone},salesperson_phone.is.null`,
      );
    }

    const { data: recentVisits, error: fetchErr } = await query;
    if (fetchErr) {
      console.error(
        '[VisitAgent] Error fetching recent visits for correction:',
        fetchErr.message,
      );
    }

    const visitsList = recentVisits || [];
    if (visitsList.length === 0) {
      return `No recent customer visit records were found to update. Please log the visit first or specify the customer name.`;
    }

    let targetVisit = null;

    // 1. If customerName was mentioned, filter by customer first
    let candidateVisits = visitsList;
    if (customerName) {
      const matchedCustName = await verifyAndGetCustomerName(
        customerName,
        senderPhone,
      );
      const custFilterName = matchedCustName || customerName;
      const matchedByCust = visitsList.filter(
        (v) =>
          v.customer_name &&
          v.customer_name.toLowerCase().includes(custFilterName.toLowerCase()),
      );
      if (matchedByCust.length > 0) {
        candidateVisits = matchedByCust;
      }
    }

    // 2. If date was mentioned, filter candidate visits by date!
    if (visitDateRef) {
      const resolvedDate = resolveVisitDate(text, visitDateRef);
      const targetDateObj = resolvedDate.dateObj;
      const targetDay = targetDateObj.getDate();
      const targetMonth = targetDateObj.getMonth();
      const targetYear = targetDateObj.getFullYear();

      const matchedByDate = candidateVisits.filter((v) => {
        if (!v.visited_at) return false;
        const vD = new Date(v.visited_at);
        return (
          vD.getDate() === targetDay &&
          vD.getMonth() === targetMonth &&
          vD.getFullYear() === targetYear
        );
      });

      if (matchedByDate.length === 1) {
        targetVisit = matchedByDate[0];
      } else if (matchedByDate.length > 1) {
        candidateVisits = matchedByDate;
      }
    }

    // 3. If old_value mentioned, filter by old_value
    if (!targetVisit && oldValue) {
      const oldLower = oldValue.toLowerCase().trim();
      const matchedByOld = candidateVisits.filter((v) => {
        const pMet = (v.person_met || '').toLowerCase();
        const rem = (v.remarks || '').toLowerCase();
        const vOut = (v.outcome || '').toLowerCase();
        const outTagMatch = rem.match(/\[Outcome:\s*([^\]]+)\]/i);
        const outTag = outTagMatch ? outTagMatch[1].toLowerCase().trim() : '';
        return (
          pMet.includes(oldLower) ||
          rem.includes(oldLower) ||
          vOut === oldLower ||
          outTag === oldLower ||
          rem.includes(`[outcome: ${oldLower}]`)
        );
      });
      if (matchedByOld.length === 1) {
        targetVisit = matchedByOld[0];
      } else if (matchedByOld.length > 1) {
        candidateVisits = matchedByOld;
      }
    }

    // 4. If exactly 1 candidate remaining, pick it
    if (!targetVisit && candidateVisits.length === 1) {
      targetVisit = candidateVisits[0];
    }

    // 5. If multiple candidates still remain, present clean disambiguation choices
    if (!targetVisit && candidateVisits.length > 1) {
      const candidateSummaries = candidateVisits.slice(0, 4).map((v, idx) => {
        const vDate = new Date(v.visited_at);
        const day = vDate.getDate();
        const monthNames = [
          'Jan',
          'Feb',
          'Mar',
          'Apr',
          'May',
          'Jun',
          'Jul',
          'Aug',
          'Sep',
          'Oct',
          'Nov',
          'Dec',
        ];
        const dateStr = `${day} ${monthNames[vDate.getMonth()]} ${vDate.getFullYear()}`;
        const outTagMatch = (v.remarks || '').match(/\[Outcome:\s*([^\]]+)\]/i);
        const recordedOutcome =
          v.outcome || (outTagMatch ? outTagMatch[1] : null) || 'Not recorded';
        const formattedOutcome =
          recordedOutcome.charAt(0).toUpperCase() + recordedOutcome.slice(1);
        return {
          index: idx + 1,
          id: v.id,
          customer_name: v.customer_name,
          date: dateStr,
          outcome: formattedOutcome,
          person_met: v.person_met || 'Not recorded',
          remarks: v.remarks ? v.remarks.slice(0, 60) : 'No remarks',
        };
      });

      const choicesText = candidateSummaries
        .map(
          (c) =>
            `${c.index}. ${c.customer_name} (${c.date}) - Outcome: ${c.outcome} - Contact: ${c.person_met}`,
        )
        .join('\n');

      const sessionPayload = {
        target_field: targetField,
        new_value: newValue,
        old_value: oldValue,
        candidates: candidateSummaries,
      };

      await saveActiveSession(
        senderPhone,
        candidateVisits[0].customer_name || 'Multiple',
        `waiting_for_visit_update_selection|${JSON.stringify(sessionPayload)}`,
      );

      return (
        `Which visit to ${candidateVisits[0].customer_name} would you like to update?\n\n` +
        `Please select which visit to update to ${newValue}:\n\n` +
        `${choicesText}\n\n` +
        `Reply with the number (e.g. "1") or visit date.`
      );
    }

    if (!targetVisit) {
      targetVisit = candidateVisits[0] || visitsList[0];
    }

    // Apply update to targetVisit
    return await applyVisitFieldUpdate(
      targetVisit,
      targetField,
      newValue,
      oldValue,
      senderPhone,
    );
  } catch (err) {
    console.error('[VisitAgent] handleVisitCorrection error:', err.message);
    return `Error updating visit details: ${err.message}`;
  }
}

/**
 * Applies update to a specific visit record and updates CRM master
 */
async function applyVisitFieldUpdate(
  targetVisit,
  targetField,
  newValue,
  oldValue,
  senderPhone,
) {
  const { saveActiveSession } = require('../supabase');
  const updatePayload = {};
  let fieldLabel = 'Contact Person';

  if (targetField === 'person_met') {
    updatePayload.person_met = newValue;
    fieldLabel = 'Contact Person';
  } else if (targetField === 'contact_no') {
    updatePayload.contact_no = newValue;
    fieldLabel = 'Contact Phone';
  } else if (targetField === 'customer_address') {
    updatePayload.customer_address = newValue;
    fieldLabel = 'Location';
  } else if (targetField === 'visit_outcome') {
    fieldLabel = 'Outcome';
    const normOut =
      newValue.charAt(0).toUpperCase() + newValue.slice(1).toLowerCase();
    newValue = normOut;
    updatePayload.outcome = normOut.toLowerCase();
    // Update outcome tag in remarks
    let updatedRemarks = targetVisit.remarks || '';
    if (/\[Outcome:\s*[^\]]+\]/i.test(updatedRemarks)) {
      updatedRemarks = updatedRemarks.replace(
        /\[Outcome:\s*[^\]]+\]/i,
        `[Outcome: ${normOut}]`,
      );
    } else {
      updatedRemarks = `[Outcome: ${normOut}] ${updatedRemarks}`.trim();
    }
    updatePayload.remarks = updatedRemarks;
  } else if (targetField === 'remarks') {
    updatePayload.remarks = newValue;
    fieldLabel = 'Discussion Notes';
  } else {
    updatePayload.person_met = newValue;
  }

  const { error: updateErr } = await supabase
    .from('customer_visits')
    .update(updatePayload)
    .eq('id', targetVisit.id);

  if (updateErr) {
    console.error(
      '[VisitAgent] customer_visits update error:',
      updateErr.message,
    );
    return `Could not update visit record: ${updateErr.message}`;
  }

  // Update customer master profile if contact info was changed
  if (
    targetField === 'person_met' ||
    targetField === 'contact_no' ||
    targetField === 'customer_address'
  ) {
    const custUpdate = { updated_at: new Date().toISOString() };
    if (targetField === 'person_met') custUpdate.contact_person = newValue;
    if (targetField === 'contact_no') custUpdate.customer_phone = newValue;
    if (targetField === 'customer_address') custUpdate.city = newValue;

    await supabase
      .from('recurring_customers')
      .update(custUpdate)
      .ilike('customer_name', `%${targetVisit.customer_name}%`);
  }

  // Log to activity_logs
  try {
    await supabase.from('activity_logs').insert({
      timestamp: new Date().toISOString(),
      salesperson_name: 'Sales Team',
      salesperson_phone: senderPhone,
      description: `Visit updated for ${targetVisit.customer_name}: ${fieldLabel} changed to "${newValue}"${oldValue ? ` (was "${oldValue}")` : ''}`,
      module: 'Visits',
      customer_name: targetVisit.customer_name,
      source: 'bot',
      action_type: 'visit_updated',
    });
  } catch (e) {
    console.warn('[VisitAgent] activity_logs notice:', e.message);
  }

  await saveActiveSession(senderPhone, targetVisit.customer_name, 'general');

  const vDate = new Date(targetVisit.visited_at);
  const day = vDate.getDate();
  const monthNames = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const visitDateStr = `${day} ${monthNames[vDate.getMonth()]} ${vDate.getFullYear()}`;

  return (
    `Customer Visit Updated\n\n` +
    `Customer: ${targetVisit.customer_name}\n` +
    `- Visit Date: ${visitDateStr}\n` +
    `- Updated ${fieldLabel}: ${newValue}${oldValue ? ` (was ${oldValue})` : ''}\n\n` +
    `Updated Customer Visits Card!`
  );
}

/**
 * Handles disambiguation selection reply (e.g. "1", "2", or date) for visit update
 */
async function handleVisitUpdateSelection(text, senderPhone, sessionPayload) {
  const { saveActiveSession } = require('../supabase');
  const cleanInput = text.trim();
  const candidates = sessionPayload.candidates || [];

  if (candidates.length === 0) {
    await saveActiveSession(senderPhone, 'Unknown', 'general');
    return null;
  }

  // 1. Check numeric selection (e.g. "1", "2")
  const numMatch = cleanInput.match(/^([1-9]\d?)$/);
  let chosenCandidate = null;

  if (numMatch) {
    const idx = parseInt(numMatch[1], 10);
    chosenCandidate = candidates.find((c) => c.index === idx);
  }

  // 2. Check date or person match in text
  if (!chosenCandidate) {
    const lower = cleanInput.toLowerCase();
    chosenCandidate = candidates.find(
      (c) =>
        lower.includes(c.date.toLowerCase()) ||
        lower.includes(c.person_met.toLowerCase()) ||
        lower.includes(c.customer_name.toLowerCase()),
    );
  }

  if (!chosenCandidate && candidates.length > 0) {
    chosenCandidate = candidates[0];
  }

  // Fetch full visit row for the selected ID
  const { data: rows } = await supabase
    .from('customer_visits')
    .select('*')
    .eq('id', chosenCandidate.id)
    .limit(1);

  if (!rows || rows.length === 0) {
    await saveActiveSession(senderPhone, 'Unknown', 'general');
    return `Could not find the selected visit record.`;
  }

  const targetVisit = rows[0];
  return await applyVisitFieldUpdate(
    targetVisit,
    sessionPayload.target_field,
    sessionPayload.new_value,
    sessionPayload.old_value,
    senderPhone,
  );
}

/**
 * Defense-in-depth Sanitizer: Strictly eliminates any unmentioned or hallucinated fields.
 */
function sanitizeExtractedVisitData(data, rawText) {
  const text = (rawText || '').toLowerCase();
  const res = { ...data };

  // 1. Follow-up action: if no explicit follow-up phrases in raw text, force null
  if (res.follow_up_action) {
    const hasFollowUpKeyword =
      /\b(?:follow\s*up|next\s*step|send|share|dispatch|mail|email|sample|samples|quote|quotation|proposal|call\s+back|meet\s+again|discuss\s+again)\b/i.test(
        text,
      );
    const isGenericHallucination =
      /collect required quantity|follow up for upcoming material|routine follow-up|follow up with customer/i.test(
        res.follow_up_action,
      );
    if (!hasFollowUpKeyword || isGenericHallucination) {
      res.follow_up_action = null;
    }
  }

  // 2. Visit outcome: if not explicitly stated, force null
  if (res.visit_outcome) {
    const norm = res.visit_outcome.toLowerCase().trim();
    if (!['positive', 'neutral', 'negative'].includes(norm)) {
      res.visit_outcome = null;
    } else {
      const hasNegativeIndicator =
        /\b(?:negative|bad|rejected|rejection|unsuccessful|declined|not\s+(?:at\s+all\s+)?inter(?:e)?sted|uninterested|no\s+interest|not\s+buying|not\s+interested|no\s+(?:immediate\s+)?need|no\s+requirement|refused|unfavorable|dissatisfied|cancelled|lost)\b/i.test(
          text,
        ) ||
        /\b(?:nahi\s+chahiye|interest\s+nahi|mana\s+kar\s+diya|reject\s+hua)\b/i.test(
          text,
        );
      const hasPositiveIndicator =
        /\b(?:positive|good|great|successful|well|went well|deal|closed|interested|interest|favorable|ordered|order)\b/i.test(
          text,
        ) && !hasNegativeIndicator;
      const hasNeutralIndicator =
        /\b(?:neutral|routine|check\s*in|okay|ok|normal|average|no immediate)\b/i.test(
          text,
        );

      if (norm === 'positive' && !hasPositiveIndicator) {
        res.visit_outcome = null;
      } else if (norm === 'negative' && !hasNegativeIndicator) {
        res.visit_outcome = null;
      } else if (norm === 'neutral' && !hasNeutralIndicator) {
        res.visit_outcome = null;
      }
    }
  }

  // 3. Remarks: check for generic filler hallucinations
  if (res.remarks) {
    const isFiller =
      /^(?:site visit conducted|visited|meeting conducted|on-site meeting|routine visit|field visit|visit conducted|market presence)\b/i.test(
        res.remarks.trim(),
      );
    if (isFiller && text.trim().length <= 40) {
      res.remarks = null;
    }
  }

  // 4. Contact number: ensure it matches an actual phone number in raw text
  if (res.contact_no) {
    const digits = res.contact_no.replace(/\D/g, '');
    if (!text.replace(/\D/g, '').includes(digits) || digits.length < 10) {
      res.contact_no = null;
    }
  }

  // 5. Person met: ensure not identical to customer company name
  if (
    res.person_met &&
    res.customer_name &&
    res.person_met.toLowerCase() === res.customer_name.toLowerCase()
  ) {
    res.person_met = null;
  }

  return res;
}

/**
 * Deterministic Regex-based Extraction Fallback (when LLM is unreachable)
 */
function extractVisitDeterministic(text) {
  const lower = (text || '').toLowerCase();
  const raw = text || '';

  // Customer Name
  let customerName = null;
  const custMatch =
    raw.match(
      /(?:visited|field visit to|meeting at|met with|visit with|met)\s+([A-Za-z0-9&.,\s'-]+?)(?:\s+(?:in|at|today|yesterday|spoke|met|discussed|outcome|neutral|positive|negative|contact|,|\.|$))/i,
    ) ||
    raw.match(
      /(?:visited|field visit to|meeting at|met with|visit with|met)\s+([A-Za-z0-9&.,\s'-]+)/i,
    );
  if (custMatch) {
    customerName = custMatch[1]
      .replace(/\b(?:today|yesterday|spoke|met|discussed|outcome|in|at)\b.*$/i, '')
      .trim();
  }

  // City / Location
  let city = null;
  const cityMatch = raw.match(
    /\b(?:in|at)\s+(Kolhapur|Mumbai|Pune|Nashik|Bhiwandi|Taloja|Navi Mumbai|Nagpur|Thane|Aurangabad|Surat|Ahmedabad|Delhi|Rajkot|Indore|Goa|Chennai|Bengaluru|Hyderabad|Jaipur|Vadodara)\b/i,
  );
  if (cityMatch) {
    city = cityMatch[1].trim();
  }

  // Person Met
  let personMet = null;
  const personMatch =
    raw.match(
      /(?:spoke with|met their purchase manager|met purchase manager|met|contact person is|spoke to)\s+((?:Mr\.|Ms\.|Mrs\.|Dr\.)?\s*[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/i,
    ) ||
    raw.match(
      /(?:spoke with|met)\s+([A-Za-z\s]+?)(?:\s*(?:\.|\,|-|\(|contact|phone|number|outcome))/i,
    );
  if (personMatch) {
    personMet = personMatch[1].trim();
  }

  // Phone
  let contactNo = null;
  const phoneMatch = raw.match(/(?:\+91[\-\s]?)?([6-9]\d{9})\b/);
  if (phoneMatch) {
    contactNo = phoneMatch[1];
  }

  // Outcome
  let visitOutcome = null;
  if (
    /\b(?:negative|bad|rejected|rejection|unsuccessful|declined|not\s+(?:at\s+all\s+)?inter(?:e)?sted|uninterested|no\s+interest|not\s+buying|not\s+interested|no\s+(?:immediate\s+)?need|no\s+requirement|refused|unfavorable|dissatisfied|cancelled|lost)\b/i.test(
      lower,
    ) ||
    /\b(?:nahi\s+chahiye|interest\s+nahi|mana\s+kar\s+diya|reject\s+hua)\b/i.test(
      lower,
    )
  ) {
    visitOutcome = 'negative';
  } else if (
    /\b(?:positive|went\s+well|good|great|successful|favorable|interested|keen|promising|order\s+confirmed|deal\s+done)\b/i.test(
      lower,
    ) &&
    !/\b(?:not\s+|no\s+|nahi\s+)(?:positive|good|great|interested|keen|promising)\b/i.test(
      lower,
    )
  ) {
    visitOutcome = 'positive';
  } else if (
    /\b(?:neutral|routine|okay|ok|normal|general\s+visit|courtesy\s+visit|check-?in|introductory|introduction)\b/i.test(
      lower,
    )
  ) {
    visitOutcome = 'neutral';
  }

  // Follow-up
  let followUpAction = null;
  const followUpMatch = raw.match(
    /(?:follow-up needed to|follow up needed to|next step is to|next step:|follow-up:|follow up:)\s*([^.,]+)/i,
  );
  if (followUpMatch) {
    followUpAction = followUpMatch[1].trim();
  }

  // Material Requirement / Product Interests
  let materialRequirement = null;
  let productInterests = null;
  const reqMatch = raw.match(
    /(?:discussed|requirement for|needs|requires|order for)\s+([^.,]+?(?:order|requirement|coils?|plates?|sheets?|bars?|ton|mt|kg|tonnes?))/i,
  );
  if (reqMatch) {
    materialRequirement = reqMatch[1].trim();
  }
  const prodMatch = raw.match(
    /\b(HR Coils?|CR Sheets?|MS Plates?|GI Sheets?|TMT Bars?|Structural Steel|Plates?|Sheets?|Coils?)\b/i,
  );
  if (prodMatch) {
    productInterests = prodMatch[0].trim();
  }

  // Remarks
  let remarks = null;
  if (
    lower.includes('discussed') ||
    lower.includes('requirement') ||
    lower.includes('response')
  ) {
    const remMatch = raw.match(
      /(?:discussed|neutral response|positive discussion|response,)\s*([^.,]+)/i,
    );
    if (remMatch) {
      remarks = remMatch[0].trim();
    }
  }

  return {
    customer_name: customerName,
    is_new_prospect: false,
    person_met: personMet,
    contact_no: contactNo,
    city: city,
    visit_date: 'today',
    product_interests: productInterests,
    remarks: remarks,
    visit_outcome: visitOutcome,
    material_requirement: materialRequirement,
    follow_up_action: followUpAction,
    followup_days: null,
    confidence: 0.8,
  };
}

/**
 * Main entry point for processing salesperson visit reports
 */
async function processVisitMessage(text, senderPhone) {
  try {
    const {
      getFullActiveSession,
      saveActiveSession,
      verifyAndGetCustomerName,
    } = require('../supabase');
    const activeSession = await getFullActiveSession(senderPhone);

    // 0a. Check for active disambiguation selection
    if (
      activeSession?.last_intent?.startsWith(
        'waiting_for_visit_update_selection|',
      )
    ) {
      const parts = activeSession.last_intent.split('|');
      const payloadJson = parts.slice(1).join('|');
      const { safeParseJSON } = require('../utils/jsonUtils');
      const sessionPayload = safeParseJSON(payloadJson, null);
      if (sessionPayload) {
        const reply = await handleVisitUpdateSelection(
          text,
          senderPhone,
          sessionPayload,
        );
        if (reply) return reply;
      }
    }

    // 0b. Check for active multi-turn pending visit details session
    if (activeSession?.last_intent?.startsWith('pending_visit_details|')) {
      const parts = activeSession.last_intent.split('|');
      const payloadJson = parts.slice(2).join('|');
      const { safeParseJSON } = require('../utils/jsonUtils');
      const storedState = safeParseJSON(payloadJson, null);
      if (storedState) {
        const isNewVisitIntent =
          /\b(visited|met with|meeting at|site visit|factory visit|plant visit|market visit|field visit)\b/i.test(
            text,
          ) &&
          !text.toLowerCase().includes(storedState.customer_name.toLowerCase());
        if (!isNewVisitIntent) {
          const continuationReply = await handlePendingVisitContinuation(
            text,
            senderPhone,
            storedState,
          );
          if (continuationReply) {
            return continuationReply;
          }
        }
      }
    }

    // 1. Check for correction requests
    const isCorrection =
      /(?:correct|correction|update|change|fix|modify)\b.*?\b(?:contact\s*person|person\s*met|outcome|remarks?|location|phone|number|last\s*visit|visit)\b/i.test(
        text,
      ) ||
      /(?:change\s+the\s+outcome|update\s+the\s+outcome|outcome\s+from|outcome\s+to)\b/i.test(
        text,
      ) ||
      /(?:it\s*should\s*be|should\s*be)\b.*?\b(?:not|instead\s*of)\b/i.test(
        text,
      );

    if (isCorrection) {
      return await handleVisitCorrection(text, senderPhone);
    }

    // 2. Extract visit data using LLM with deterministic fallback
    let data = null;
    try {
      const { invokeWithFallback } = require('../core/modelRouter');
      const { HumanMessage, SystemMessage } = require('@langchain/core/messages');
      const response = await invokeWithFallback([
        new SystemMessage(VISIT_AGENT_PROMPT),
        new HumanMessage('Salesperson message:\n' + text),
      ]);
      const rawText = (
        typeof response.content === 'string'
          ? response.content
          : JSON.stringify(response.content)
      ).trim();
      const cleaned = rawText
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
      const { safeParseJSON } = require('../utils/jsonUtils');
      data = safeParseJSON(cleaned, null);
    } catch (llmErr) {
      console.warn(
        '[VisitAgent] LLM extraction failed, using deterministic fallback:',
        llmErr.message,
      );
    }

    if (!data || !data.customer_name) {
      const fallbackData = extractVisitDeterministic(text);
      if (fallbackData && fallbackData.customer_name) {
        data = { ...(data || {}), ...fallbackData };
      }
    }

    // 3. Customer name validation
    if (!data || !data.customer_name) {
      return `Customer Visit - Customer Name Missing\n\nPlease specify the Customer or Company you visited.\nExample: Visited Mehta Engineering in Pune, met Mr. Sharma (9876543210), outcome positive, discussed CR Sheets.`;
    }

    const customerName = data.customer_name.trim();

    // 4. Resolve date from text and LLM (includes relative weekdays)
    const resolvedDate = resolveVisitDate(text, data.visit_date);

    // 5. Customer matching
    let officialCustomerName = await verifyAndGetCustomerName(
      customerName,
      senderPhone,
    );
    let isNewProspect = false;

    if (!officialCustomerName) {
      isNewProspect = true;
    }

    const finalCustomerName = officialCustomerName || customerName;

    // 6. Duplicate Visit Safeguard (within 10 minutes)
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { data: recentVisits } = await supabase
      .from('customer_visits')
      .select('id, visited_at')
      .eq('salesperson_phone', senderPhone)
      .ilike('customer_name', `%${finalCustomerName}%`)
      .gte('visited_at', tenMinutesAgo)
      .limit(1);

    const isBareNameMsg =
      text.trim().length <= 40 &&
      !text.toLowerCase().includes('visited') &&
      !text.toLowerCase().includes('met') &&
      !text.toLowerCase().includes('introduced');

    if (recentVisits && recentVisits.length > 0 && isBareNameMsg) {
      console.log(
        `[VisitAgent] Suppressing duplicate visit for "${finalCustomerName}" (already logged ${recentVisits[0].visited_at})`,
      );
      await saveActiveSession(
        senderPhone,
        finalCustomerName,
        'profile_updated',
      );
      return (
        `Visit Already Logged for ${finalCustomerName}\n\n` +
        `Your visit with ${finalCustomerName} is already recorded on your Customer Visits Card!\n\n` +
        `Updated Customer Visits Card!`
      );
    }

    // 7. Construct initial visit state
    const currentVisitState = {
      customer_name: finalCustomerName,
      is_new_prospect: isNewProspect,
      person_met: data.person_met ? data.person_met.trim() : null,
      contact_no: data.contact_no ? data.contact_no.trim() : null,
      city: data.city ? data.city.trim() : null,
      visit_date_iso: resolvedDate.isoString,
      visit_date_display: resolvedDate.formattedDisplay,
      visit_date_month: resolvedDate.month,
      visit_date_year: resolvedDate.year,
      visit_outcome:
        data.visit_outcome &&
        ['positive', 'neutral', 'negative'].includes(
          data.visit_outcome.toLowerCase(),
        )
          ? data.visit_outcome.toLowerCase()
          : null,
      remarks: data.remarks ? data.remarks.trim() : null,
      product_interests: data.product_interests
        ? data.product_interests.trim()
        : null,
      material_requirement: data.material_requirement
        ? data.material_requirement.trim()
        : null,
      follow_up_action: data.follow_up_action
        ? data.follow_up_action.trim()
        : null,
      followup_days: data.followup_days || null,
    };

    // 8. Sanitize extracted fields against raw user text
    const sanitizedState = sanitizeExtractedVisitData(currentVisitState, text);

    // 9. Save completed visit directly!
    return await saveCompletedVisit(sanitizedState, senderPhone);
  } catch (error) {
    console.error('Visit Agent Error:', error.message);
    return `Could not process site visit update: ${error.message}`;
  }
}

module.exports = {
  processVisitMessage,
  handleVisitCorrection,
  handlePendingVisitContinuation,
  handleVisitUpdateSelection,
  resolveVisitDate,
  sanitizeExtractedVisitData,
  extractVisitDeterministic,
};
