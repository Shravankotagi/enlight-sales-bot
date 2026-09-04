/**
 * KRA 2 - New Customer Acquisition Agent
 *
 * DESIGN PRINCIPLES:
 * - One entry per NEW customer in recurring_customers table.
 * - KRA 2 log is only created ONCE per customer per salesperson (not on updates/re-onboarding).
 * - If customer already exists and is assigned to this salesperson → update profile, no new KRA 2 log.
 * - If customer exists but is assigned to a different salesperson → treat as new acquisition for this salesperson.
 *
 * EDGE CASES HANDLED:
 * 1.  New customer, full info → insert to recurring_customers + log KRA 2
 * 2.  New customer, partial info → insert with available info + prompt for missing fields
 * 3.  Customer already onboarded by THIS salesperson → update profile, NO duplicate KRA 2 log
 * 4.  Customer exists under different salesperson → count as new acquisition for this salesperson
 * 5.  Missing customer name → ask for clarification
 * 6.  Duplicate KRA 2 log prevention → check existing KRA logs before logging
 * 7.  Monthly progress count → computed from distinct customers, not raw log count
 * 8.  GST / phone / city all optional but prompted if missing
 * 9.  Hinglish/casual → AI handles semantic parsing
 */

const { supabase } = require('../supabase');
const { syncActivity } = require('./biginSyncAgent');

const CUSTOMER_AGENT_PROMPT = `
You are the Specialized Customer Onboarding & Profile AI Agent for Enlight Metals.
Your job is to parse customer onboarding, profile updates, and order cycle configurations.

The salesperson or admin message may be informal, in Hinglish, or missing expected keywords.
Understand the meaning and context - do not look for specific words.

Input message can be English, Hindi, or Hinglish.

Extract into ONLY a JSON object (no prose, no markdown, no backticks):
{
  "customer_name": "<new or existing company/customer name, else null>",
  "contact_person": "<contact person/owner name if mentioned, else null>",
  "phone": "<phone number if mentioned (digits only), else null>",
  "gst": "<GST number if mentioned, else null>",
  "city": "<city/location if mentioned, else null>",
  "order_frequency_days": <number of days for order cycle/frequency if mentioned (e.g. 45, 30), else null>,
  "confidence": <float 0.0 to 1.0>
}

Return ONLY the JSON object.
`;

function normalizeCompanyName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .trim()
    .replace(/\b(private\s+limited|pvt\s+ltd|pvt\s+limited|private\s+ltd|co\s+ltd|co\s+limited|llp|limited|pvt|ltd|inc|corp|co|corporation)\b/gi, '')
    .replace(/[^a-z0-9]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isExactDuplicate(name1, name2) {
  if (!name1 || !name2) return false;
  const str1 = name1.trim().toLowerCase();
  const str2 = name2.trim().toLowerCase();
  if (str1 === str2) return true;

  const n1 = normalizeCompanyName(name1);
  const n2 = normalizeCompanyName(name2);
  if (n1 && n2 && n1 === n2) return true;

  return false;
}

function cleanPhone(p) {
  if (!p) return '';
  const digits = String(p).replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

/**
 * Check if KRA 2 was already logged for this customer by this salesperson this month.
 * Prevents duplicate KRA 2 logs when the same customer info is re-sent.
 */
async function isKRA2AlreadyLogged(senderPhone, customerName) {
  const month = new Date().getMonth() + 1;
  const year  = new Date().getFullYear();

  const { data } = await supabase
    .from('kra_logs')
    .select('id')
    .eq('salesperson_phone', senderPhone)
    .eq('kra_number', 2)
    .eq('month', month)
    .eq('year', year)
    .ilike('customer_name', `%${customerName}%`)
    .limit(1);

  return data && data.length > 0;
}

/**
 * Count distinct customers onboarded this month by this salesperson.
 */
async function getMonthlyOnboardCount(senderPhone) {
  const month = new Date().getMonth() + 1;
  const year  = new Date().getFullYear();

  const { data } = await supabase
    .from('kra_logs')
    .select('customer_name')
    .eq('salesperson_phone', senderPhone)
    .eq('kra_number', 2)
    .eq('month', month)
    .eq('year', year);

  if (!data || data.length === 0) return 0;

  // Count distinct customer names
  const distinct = new Set(data.map(r => (r.customer_name || '').toLowerCase().trim()));
  return distinct.size;
}

async function processCustomerMessage(text, senderPhone) {
  try {
    const { getActiveSession, getFullActiveSession, saveActiveSession, getAccessibleSalespersonPhonesForBot } = require('../supabase');
    const scope = await getAccessibleSalespersonPhonesForBot(senderPhone);
    const senderCleanPhone = cleanPhone(senderPhone);

    // ── 1. Check if user is responding to an ongoing Duplicate Confirmation Session ──
    const fullSession = await getFullActiveSession(senderPhone);
    if (fullSession && fullSession.last_intent && fullSession.last_intent.startsWith('duplicate_check|')) {
      const cleanInput = text.trim().toLowerCase();
      let payload = null;
      try {
        payload = JSON.parse(fullSession.last_intent.replace('duplicate_check|', ''));
      } catch (e) { /* ignore parse error */ }

      if (payload) {
        const isYes = ['yes', 'y', 'ha', 'haa', 'haan', 'correct', 'confirm', 'sure', 'true', 'ok', 'okay', 'right', 'sahi', 'sahi hai'].includes(cleanInput) ||
                      cleanInput.startsWith('yes') || cleanInput.startsWith('ha ') || cleanInput.startsWith('haa');

        const isNo = ['no', 'n', 'nah', 'nahi', 'nope', 'cancel', 'wrong', 'galat', 'different'].includes(cleanInput) ||
                     cleanInput.startsWith('no') || cleanInput.startsWith('nahi');

        if (isYes) {
          // User confirmed YES: Link existing company to this salesperson's portfolio
          await saveActiveSession(senderPhone, payload.existingCustomerName, 'duplicate_confirmed');

          const updateData = {
            assigned_salesperson_phone: senderPhone,
            updated_at: new Date().toISOString(),
          };
          if (payload.newPayload?.phone) updateData.customer_phone = payload.newPayload.phone;
          if (payload.newPayload?.gst) updateData.customer_gst = payload.newPayload.gst;
          if (payload.newPayload?.city) updateData.customer_address = payload.newPayload.city;
          if (payload.newPayload?.contact_person) updateData.contact_person = payload.newPayload.contact_person;
          if (payload.newPayload?.order_frequency_days) updateData.avg_order_frequency_days = Number(payload.newPayload.order_frequency_days);

          await supabase
            .from('recurring_customers')
            .update(updateData)
            .eq('id', payload.existingId);

          // Log KRA 2
          const alreadyLogged = await isKRA2AlreadyLogged(senderPhone, payload.existingCustomerName);
          if (!alreadyLogged) {
            await supabase.from('kra_logs').insert({
              salesperson_phone: senderPhone,
              kra_number: 2,
              kra_type: 'new_customer',
              customer_name: payload.existingCustomerName,
              description: `Customer Linked: ${payload.existingCustomerName}`,
              month: new Date().getMonth() + 1,
              year: new Date().getFullYear(),
            });
          }

          const currentCount = await getMonthlyOnboardCount(senderPhone);
          return `✅ *Customer Linked Successfully!*\n\n` +
            `Company: *${payload.existingCustomerName}* is now linked to your customer portfolio.\n` +
            `Monthly Progress: *${currentCount} / 3 Onboarded*\n\n` +
            `_Updated in Enlight Sales OS._ ✅`;

        } else if (isNo) {
          // User confirmed NO: Ask for the correct company name
          await saveActiveSession(senderPhone, 'PENDING_CORRECT_NAME', 'duplicate_rejected');
          return `Understood! 👍 Please tell me the correct *Company Name* (e.g. _"Apex Infra Works phone 9822... location Pune"_) so I can create the accurate record.`;
        }
      }
    }

    // ── 2. LLM Extraction ──────────────────────────────────────────────────
    const { invokeWithFallback } = require('../core/modelRouter');
    const { HumanMessage, SystemMessage } = require('@langchain/core/messages');
    const response = await invokeWithFallback([
      new SystemMessage(CUSTOMER_AGENT_PROMPT),
      new HumanMessage('User message:\n' + text),
    ]);
    const rawText = typeof response.content === 'string' ? response.content : JSON.stringify(response.content || '');
    const { safeParseJSON } = require('../utils/jsonUtils');
    const data = safeParseJSON(rawText, null);
    if (!data) throw new Error('Could not parse customer onboarding JSON from LLM response');

    // ── 3. Session Context & Pending Resolution ─────────────────────────────
    let activeCustomer = await getActiveSession(senderPhone);

    if (!data.customer_name && activeCustomer && activeCustomer !== 'PENDING_PROFILE' && activeCustomer !== 'PENDING_CORRECT_NAME' && activeCustomer !== 'Unknown') {
      data.customer_name = activeCustomer;
    }

    if (!data.customer_name || data.customer_name.trim().toLowerCase() === 'unknown') {
      if (data.phone || data.contact_person || data.city || data.gst || data.order_frequency_days) {
        const payloadStr = JSON.stringify({
          phone: data.phone,
          contact_person: data.contact_person,
          city: data.city,
          gst: data.gst,
          order_frequency_days: data.order_frequency_days,
        });
        await saveActiveSession(senderPhone, 'PENDING_PROFILE', `pending_profile|${payloadStr}`);
        return `Oops! I missed getting the *Company Name* for this customer. 😅\n\n` +
          `Could you please tell me the Company Name for ${data.contact_person ? `*${data.contact_person}*` : 'this contact'}` +
          (data.phone ? ` with mobile number *${data.phone}*` : '') + `?\n\n` +
          `Once I have that, I'll get their profile recorded right away!`;
      }

      return `⚠️ *Customer Agent - Company Name Missing*\n\nPlease specify the *Customer / Company Name*.\nExample: _"Supreme Steel phone 9812345678 owner Mr Mehta location Pune order frequency 45 days"_`;
    }

    const customerName = data.customer_name.trim();

    // ── 4. Duplicate Detection Check Across All Customers ──────────────────
    const { data: allCustomers } = await supabase
      .from('recurring_customers')
      .select('id, customer_name, assigned_salesperson_phone, customer_phone, customer_gst, customer_address, contact_person, notes, avg_order_frequency_days');

    const exactMatch = (allCustomers || []).find(c => isExactDuplicate(customerName, c.customer_name));

    if (exactMatch) {
      const matchRepClean = cleanPhone(exactMatch.assigned_salesperson_phone);

      // Case A: Customer already exists under THIS salesperson
      if (matchRepClean === senderCleanPhone || (!matchRepClean && !scope.isAdmin)) {
        const updateFields = {
          customer_phone: data.phone || exactMatch.customer_phone || null,
          customer_gst: data.gst || exactMatch.customer_gst || null,
          customer_address: data.city || exactMatch.customer_address || null,
          contact_person: data.contact_person || exactMatch.contact_person || null,
          is_active: true,
          updated_at: new Date().toISOString(),
        };
        if (data.order_frequency_days) {
          updateFields.avg_order_frequency_days = Number(data.order_frequency_days);
        }
        if (!exactMatch.assigned_salesperson_phone) {
          updateFields.assigned_salesperson_phone = senderPhone;
        }

        await supabase
          .from('recurring_customers')
          .update(updateFields)
          .eq('id', exactMatch.id);

        return `✅ *Customer Profile Updated!*\n\n` +
          `Company: *${exactMatch.customer_name}* is already in your account.\n` +
          (data.order_frequency_days ? `Order Frequency: *Every ${data.order_frequency_days} days*\n` : '') +
          (data.contact_person ? `Contact: *${data.contact_person}*\n` : '') +
          (data.phone ? `Phone: *${data.phone}*\n` : '') +
          (data.city ? `Location: *${data.city}*\n` : '') +
          `\n_Profile updated in Enlight Sales OS._ ✅`;
      }

      // Case B: Customer is recorded under ANOTHER salesperson
      const { data: emps } = await supabase.from('employees').select('name, phone');
      let otherRepName = 'another salesperson';
      if (emps && exactMatch.assigned_salesperson_phone) {
        const emp = emps.find(e => cleanPhone(e.phone) === matchRepClean);
        if (emp && emp.name) otherRepName = emp.name;
      }

      // Save confirmation session
      const checkPayload = JSON.stringify({
        existingId: exactMatch.id,
        existingCustomerName: exactMatch.customer_name,
        existingPhone: exactMatch.customer_phone,
        existingGst: exactMatch.customer_gst,
        existingAddress: exactMatch.customer_address,
        existingContact: exactMatch.contact_person,
        newPayload: data,
      });

      await saveActiveSession(senderPhone, 'DUPLICATE_CHECK', `duplicate_check|${checkPayload}`);

      return `⚠️ *${exactMatch.customer_name}* is already recorded under *${otherRepName}*.\n\n` +
        `Is this the same customer?\n` +
        `👉 Reply *YES* to confirm and link to your portfolio, or *NO* with the correct company name.`;
    }

    // ── 5. Truly Brand New Customer: Create in Database ─────────────────────
    const { ensureCustomerRecord } = require('../supabase');
    await ensureCustomerRecord(customerName, senderPhone, {
      customer_phone: data.phone || null,
      customer_gst: data.gst || null,
      city: data.city || null,
      contact_person: data.contact_person || null,
      avg_order_frequency_days: data.order_frequency_days || 30,
    });

    // Save active session
    await saveActiveSession(senderPhone, customerName, 'onboarding_prompted');

    // Log KRA 2
    const alreadyLogged = await isKRA2AlreadyLogged(senderPhone, customerName);
    if (!alreadyLogged) {
      await supabase.from('kra_logs').insert({
        salesperson_phone: senderPhone,
        kra_number: 2,
        kra_type: 'new_customer',
        customer_name: customerName,
        description: `New Customer Onboarded: ${customerName}`,
        month: new Date().getMonth() + 1,
        year: new Date().getFullYear(),
      });
    }

    const currentCount = await getMonthlyOnboardCount(senderPhone);

    const missingInfo = [];
    if (!data.phone) missingInfo.push('• 📱 *Mobile Number*');
    if (!data.contact_person) missingInfo.push('• 👤 *Owner / Contact Person Name*');
    if (!data.city) missingInfo.push('• 📍 *City / Location*');
    if (!data.gst) missingInfo.push('• 🧾 *GSTIN* (optional)');

    const promptSuffix = missingInfo.length > 0
      ? `\n\n📌 *To complete ${customerName}'s profile, reply with:*\n${missingInfo.join('\n')}` +
        `\n\n_(e.g. "${customerName} phone 9876543210 owner Mr. Kapoor location Mumbai")_`
      : '';

    syncActivity('new_customer', {
      customerName,
      phone: data.phone || null,
      gst: data.gst || null,
      city: data.city || null,
      contactPerson: data.contact_person || null,
      senderPhone,
    });

    return `👤 *New Customer Onboarded!*\n\n` +
      `Company: *${customerName}*\n` +
      (data.contact_person ? `Contact/Owner: *${data.contact_person}*\n` : '') +
      (data.phone ? `Phone: *${data.phone}*\n` : '') +
      (data.city ? `City: *${data.city}*\n` : '') +
      `Monthly Progress: *${currentCount} / 3 Onboarded*\n\n` +
      `Updated New Customer Acquisition Card! ✅` +
      promptSuffix;

  } catch (error) {
    console.error('Customer Agent Error:', error.message);
    return `⚠️ Could not process customer onboarding: ${error.message}`;
  }
}

module.exports = { processCustomerMessage, isKRA2AlreadyLogged, normalizeCompanyName, isExactDuplicate };

