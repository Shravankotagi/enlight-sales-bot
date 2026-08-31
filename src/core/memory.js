/**
 * memory.js - Multi-turn Context Window & Session Memory for WhatsApp Bot
 *
 * Maintains a persistent sliding window of conversation history (HumanMessage / AIMessage)
 * per salesperson phone number, and retrieves active customer context from Supabase.
 */

const { HumanMessage, AIMessage } = require('@langchain/core/messages');
const { supabase } = require('../supabase');

// In-memory sliding window cache per salesperson phone
const chatHistoryMap = new Map();
const MAX_HISTORY_TURNS = 10;

/**
 * Get recent chat history messages for a salesperson.
 */
function getChatHistory(senderPhone) {
  if (!senderPhone) return [];
  return chatHistoryMap.get(senderPhone) || [];
}

/**
 * Append a human message and AI message to the salesperson's chat history.
 */
function addChatHistory(senderPhone, humanText, aiReplyText) {
  if (!senderPhone) return;

  let history = chatHistoryMap.get(senderPhone) || [];

  if (humanText) {
    history.push(new HumanMessage(humanText));
  }
  if (aiReplyText) {
    history.push(new AIMessage(aiReplyText));
  }

  // Keep only the most recent N turns (max 20 messages total)
  if (history.length > MAX_HISTORY_TURNS * 2) {
    history = history.slice(-MAX_HISTORY_TURNS * 2);
  }

  chatHistoryMap.set(senderPhone, history);
}

/**
 * Fetches active customer session & missing profile fields context for the LLM prompt.
 */
async function getActiveContextPrompt(senderPhone) {
  if (!senderPhone) return '';

  try {
    const { data: session } = await supabase
      .from('conversation_sessions')
      .select('active_customer_name, last_intent, updated_at')
      .eq('salesperson_phone', senderPhone)
      .order('updated_at', { ascending: false })
      .limit(1);

    if (!session || session.length === 0 || !session[0].active_customer_name) {
      return '';
    }

    const activeCustomer = session[0].active_customer_name;
    const lastIntent = session[0].last_intent || 'general';

    // Fetch customer profile from recurring_customers
    const { data: custData } = await supabase
      .from('recurring_customers')
      .select('customer_name, customer_phone, customer_gst, customer_address, contact_person')
      .ilike('customer_name', `%${activeCustomer}%`)
      .limit(1);

    const cust = custData && custData.length > 0 ? custData[0] : null;

    let profileSummary = '';
    if (cust) {
      const missing = [];
      if (!cust.customer_phone)   missing.push('Mobile Number');
      if (!cust.contact_person)   missing.push('Owner/Contact Person');
      if (!cust.customer_address)  missing.push('City/Location');
      if (!cust.customer_gst)      missing.push('GSTIN');

      profileSummary = `\nActive Customer Profile ("${cust.customer_name}"):
- Phone: ${cust.customer_phone || 'MISSING'}
- Owner/Contact: ${cust.contact_person || 'MISSING'}
- Location: ${cust.customer_address || 'MISSING'}
- GSTIN: ${cust.customer_gst || 'MISSING'}
- Missing Fields: ${missing.length > 0 ? missing.join(', ') : 'None (Fully Complete)'}`;
    }

    return `\n\n## ACTIVE CONTEXT WINDOW (Memory)
- Currently Active Customer: "${activeCustomer}"
- Last Action/Intent: ${lastIntent}${profileSummary}

INSTRUCTIONS FOR PROFILE UPDATES & MEMORY:
1. If the salesperson provides any profile info (mobile phone, owner name, location, or GST) WITHOUT specifying a company name, attribute it to the active customer "${activeCustomer}"!
2. Immediately call onboard_new_customer tool to update the customer's missing/blank fields.
3. NEVER ask "which company" if an active customer is present in this context window.
4. If a message specifies a quantity or requirement (e.g. "Need 25 MT", "change it to 30 MT", "wants HR Coil") WITHOUT repeating the customer name, assume it refers to "${activeCustomer}" and pass "${activeCustomer}" into tool call parameters!`;
  } catch (err) {
    console.error('[Memory] Error getting active context prompt:', err.message);
    return '';
  }
}

module.exports = {
  getChatHistory,
  addChatHistory,
  getActiveContextPrompt,
};
