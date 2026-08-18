const { createClient } = require('@supabase/supabase-js');
const { sendTextMessage } = require('./whatsapp');

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
}

// Detect if message is a visit log
function isVisitLog(text) {
  const visitKeywords = [
    'visited', 'visit kiya', 'gaya tha', 'mil ke aaya',
    'customer visit', 'site visit', 'meeting done',
    'met with', 'mil gaye', 'gaya', 'visited today',
    'aaj gaya', 'site pe gaya', 'office gaya',
    'visited at', 'reached', 'factory visit'
  ];
  const lower = text.toLowerCase();
  return visitKeywords.some(k => lower.includes(k));
}

// Extract visit details from message using Google Gemini
async function extractVisitDetails(text, senderPhone) {
  try {
    const { invokeWithFallback } = require('./core/modelRouter');
    const { HumanMessage } = require('@langchain/core/messages');

    const prompt = `
Extract visit details from this salesperson message.
Return ONLY a JSON object, no markdown, no backticks:

{
  "is_valid_visit": true,
  "customer_name": "",
  "customer_address": "",
  "person_met": "",
  "contact_no": "",
  "remarks": "",
  "outcome": ""
}

Rules:
- is_valid_visit: Set to true if the text describes a completed customer visit that occurred today or in the past. Set to false if the message describes a future plan (e.g. "I will visit tomorrow"), a question (e.g. "Did anyone visit?"), or if it is unrelated to an actual completed visit.
- customer_name: company or person visited
- person_met: name of person they met (if mentioned)
- contact_no: phone number if mentioned, else null
- remarks: what was discussed or outcome
- outcome: one of "positive|neutral|negative|followup_required"
- Return ONLY the JSON object

Message: "${text}"
    `;

    const { safeParseJSON } = require('./utils/jsonUtils');
    const parsed = safeParseJSON(rawText, null);
    if (!parsed) throw new Error('Could not parse visit details JSON');
    return parsed;
  } catch (error) {
    console.error('extractVisitDetails error:', error.message);
    // Fallback: save raw text as remarks
    return {
      is_valid_visit: true,
      customer_name: null,
      customer_address: null,
      person_met: null,
      contact_no: null,
      remarks: text,
      outcome: 'neutral'
    };
  }
}

// Save visit to database
async function saveVisit(details, senderPhone) {
  const supabase = getSupabase();
  try {
    const { data, error } = await supabase
      .from('customer_visits')
      .insert({
        salesperson_phone: senderPhone,
        customer_name: details.customer_name,
        customer_address: details.customer_address,
        person_met: details.person_met,
        contact_no: details.contact_no,
        remarks: details.remarks,
        visited_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) throw error;
    console.log('Visit saved:', data.id);
    return data;
  } catch (error) {
    console.error('saveVisit error:', error.message);
    return null;
  }
}

// Get visit count for current week
async function getWeeklyVisitCount(senderPhone) {
  const supabase = getSupabase();
  try {
    const now = new Date();
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - now.getDay());
    weekStart.setHours(0, 0, 0, 0);

    const { data, error } = await supabase
      .from('customer_visits')
      .select('id, visited_at, customer_name')
      .eq('salesperson_phone', senderPhone)
      .gte('visited_at', weekStart.toISOString());

    if (error) throw error;

    // Count unique visit days
    const visitDays = new Set(
      data?.map(v => new Date(v.visited_at).toDateString())
    );

    return {
      count: data?.length || 0,
      days: visitDays.size,
      visits: data || []
    };
  } catch (error) {
    console.error('getWeeklyVisitCount error:', error.message);
    return { count: 0, days: 0, visits: [] };
  }
}

// Build confirmation message after visit logged
function buildVisitConfirmation(details, weekStats) {
  const remaining = Math.max(0, 10 - weekStats.count);
  const daysRemaining = Math.max(0, 3 - weekStats.days);
  
  const outcomeEmoji = {
    'positive': '😊',
    'order_received': '🎉',
    'follow_up_needed': '📞',
    'negative': '😔',
    'neutral': '👍'
  }[details.outcome] || '👍';

  return `✅ *Customer Visit Logged*\n\n` +
    `🏢 Customer: ${details.customer_name || 'Not specified'}\n` +
    (details.person_met ? `👤 Met: ${details.person_met}\n` : '') +
    (details.remarks ? `💬 Remarks: ${details.remarks}\n` : '') +
    `${outcomeEmoji} Outcome: ${details.outcome || 'neutral'}\n\n` +
    `📊 *This Week's Progress*\n` +
    `Visits: ${weekStats.count}/10` +
    (remaining > 0 ? ` (${remaining} more needed)` : ' ✅ Target met!') + '\n' +
    `Field days: ${weekStats.days}/3` +
    (daysRemaining > 0 ? ` (${daysRemaining} more days needed)` : ' ✅') + '\n\n' +
    `Updated Customer Visits Card! ✅`;
}

// Weekly Customer Visits check - send reminder if below target
async function checkWeeklyVisits() {
  const supabase = getSupabase();
  try {
    console.log('Running Customer Visits weekly check...');

    // Get all unique salesperson phones
    const { data: salespeople } = await supabase
      .from('customer_visits')
      .select('salesperson_phone')
      .limit(100);

    // Also get from recurring_customers
    const { data: rcSalespeople } = await supabase
      .from('recurring_customers')
      .select('assigned_salesperson_phone')
      .eq('is_active', true);

    // Combine unique phones
    const phones = new Set([
      ...(salespeople?.map(s => s.salesperson_phone) || []),
      ...(rcSalespeople?.map(s => s.assigned_salesperson_phone) || [])
    ]);

    for (const phone of phones) {
      if (!phone) continue;
      const stats = await getWeeklyVisitCount(phone);

      if (stats.count < 10 || stats.days < 3) {
        const remaining = Math.max(0, 10 - stats.count);
        const daysRemaining = Math.max(0, 3 - stats.days);

        // Calculate days left in week
        const now = new Date();
        const daysLeftInWeek = 6 - now.getDay();

        const message =
          `📊 *Customer Visits Weekly Update*\n\n` +
          `Visits this week: ${stats.count}/10\n` +
          `Field days: ${stats.days}/3\n\n` +
          (remaining > 0 ? `⚠️ ${remaining} more visits needed\n` : '✅ Visit target met!\n') +
          (daysRemaining > 0 ? `⚠️ ${daysRemaining} more field days needed\n` : '✅ Field days target met!\n') +
          `\n📅 ${daysLeftInWeek} days left this week\n\n` +
          `Log a visit by sending:\n` +
          `"visited [Company] today, met [Person], [outcome]"\n\n` +
          `Updated Customer Visits Card! ✅`;

        await sendTextMessage(phone, message);
        console.log(`Customer Visits reminder sent to ${phone}`);

        // Small delay
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    console.log('KRA 9 check complete');
  } catch (error) {
    console.error('checkWeeklyVisits error:', error.message);
  }
}

// Handle visit log from webhook
async function handleVisitLog(text, senderPhone) {
  try {
    console.log('Visit log detected:', text);

    // Extract visit details using Gemini
    const details = await extractVisitDetails(text, senderPhone);
    console.log('Visit details extracted:', JSON.stringify(details, null, 2));

    // React to Gemini understanding: only proceed if it is a valid, completed visit log
    if (!details.is_valid_visit || !details.customer_name) {
      console.log('Gemini determined this is not a valid completed visit. Skipping save.');
      return `⚠️ *Visit Not Logged*\n\nYour message does not appear to describe a completed customer visit. Visits can only be logged for completed meetings that have already occurred.`;
    }

    // Check for same-day duplicates (same customer, same salesperson, same day)
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const supabase = getSupabase();
    const { data: existingVisits, error: dupError } = await supabase
      .from('customer_visits')
      .select('id, visited_at')
      .eq('salesperson_phone', senderPhone)
      .ilike('customer_name', `%${details.customer_name}%`)
      .gte('visited_at', todayStart.toISOString())
      .lte('visited_at', todayEnd.toISOString());

    if (dupError) throw dupError;

    if (existingVisits && existingVisits.length > 0) {
      console.log(`Duplicate visit detected for ${details.customer_name} today. Skipping database save.`);
      const weekStats = await getWeeklyVisitCount(senderPhone);
      return `⚠️ *Duplicate Visit Detected*\n\nA visit for *${details.customer_name}* has already been logged by you today!\n\n` +
        `📊 *This Week's Progress*\n` +
        `Visits: ${weekStats.count}/10\n` +
        `Field days: ${weekStats.days}/3`;
    }

    // Save to database
    const visit = await saveVisit(details, senderPhone);

    // Log to KRA logs
    await supabase.from('kra_logs').insert({
      salesperson_phone: senderPhone,
      kra_number: 9,
      kra_type: 'customer_visit',
      description: `Visited ${details.customer_name || 'customer'}: ${details.remarks || ''}`,
      customer_name: details.customer_name,
      month: new Date().getMonth() + 1,
      year: new Date().getFullYear()
    });

    // Get weekly stats
    const weekStats = await getWeeklyVisitCount(senderPhone);

    // Build and return confirmation
    return buildVisitConfirmation(details, weekStats);
  } catch (error) {
    console.error('handleVisitLog error:', error.message);
    return '❌ Could not log visit. Please try again.';
  }
}

module.exports = {
  isVisitLog,
  handleVisitLog,
  checkWeeklyVisits,
  getWeeklyVisitCount
};
