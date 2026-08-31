/**
 * memory.js - Persistent Multi-turn Context Window & Session Memory for WhatsApp Bot
 *
 * Maintains a persistent sliding window of conversation history (HumanMessage / AIMessage)
 * per salesperson phone number backed by Supabase `conversation_sessions.chat_history`,
 * with an in-memory fallback cache.
 *
 * Guaranteed isolation: Each WhatsApp account (salesperson phone) has its own independent
 * last 5 conversation turns (10 messages max) and active customer context.
 */

const { HumanMessage, AIMessage } = require('@langchain/core/messages');
const { supabase } = require('../supabase');

// Fast in-memory cache per salesperson phone
const chatHistoryMap = new Map();
const MAX_TURNS = 5; // Keep exact last 5 conversations (10 messages: 5 human, 5 AI)

/**
 * Get recent chat history messages for a salesperson.
 * Fetches from in-memory cache or PostgreSQL `conversation_sessions`.
 */
async function getChatHistory(senderPhone) {
  if (!senderPhone) return [];

  // Check in-memory cache first
  if (chatHistoryMap.has(senderPhone)) {
    return chatHistoryMap.get(senderPhone);
  }

  // Load from Supabase conversation_sessions
  try {
    const { data: session } = await supabase
      .from('conversation_sessions')
      .select('chat_history')
      .eq('salesperson_phone', senderPhone)
      .limit(1);

    if (session && session.length > 0 && Array.isArray(session[0].chat_history)) {
      const rawList = session[0].chat_history;
      const history = rawList.slice(-MAX_TURNS * 2).map(m => {
        if (m.role === 'human') return new HumanMessage(m.content);
        return new AIMessage(m.content);
      });
      chatHistoryMap.set(senderPhone, history);
      return history;
    }
  } catch (err) {
    console.error('[Memory] Error loading chat history from DB:', err.message);
  }

  return [];
}

/**
 * Synchronous getter for when caller cannot await (returns in-memory cache).
 */
function getChatHistorySync(senderPhone) {
  if (!senderPhone) return [];
  return chatHistoryMap.get(senderPhone) || [];
}

/**
 * Append a human message and AI message to the salesperson's chat history.
 * Persists to both memory cache and PostgreSQL `conversation_sessions`.
 */
async function addChatHistory(senderPhone, humanText, aiReplyText) {
  if (!senderPhone) return;

  let history = chatHistoryMap.get(senderPhone) || [];

  if (humanText) {
    history.push(new HumanMessage(humanText));
  }
  if (aiReplyText) {
    history.push(new AIMessage(aiReplyText));
  }

  // Keep exact last 5 turns (max 10 messages)
  if (history.length > MAX_TURNS * 2) {
    history = history.slice(-MAX_TURNS * 2);
  }

  chatHistoryMap.set(senderPhone, history);

  // Format serializable JSON list
  const serialized = history.map(m => ({
    role: (m._getType?.() === 'human' || m.constructor?.name === 'HumanMessage') ? 'human' : 'ai',
    content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
  }));

  // Persist to Supabase conversation_sessions asynchronously
  try {
    const { data: existing } = await supabase
      .from('conversation_sessions')
      .select('salesperson_phone')
      .eq('salesperson_phone', senderPhone)
      .limit(1);

    if (existing && existing.length > 0) {
      await supabase
        .from('conversation_sessions')
        .update({
          chat_history: serialized,
          updated_at: new Date().toISOString(),
        })
        .eq('salesperson_phone', senderPhone);
    } else {
      await supabase
        .from('conversation_sessions')
        .insert({
          salesperson_phone: senderPhone,
          chat_history: serialized,
          updated_at: new Date().toISOString(),
        });
    }
  } catch (err) {
    console.error('[Memory] Error persisting chat history to DB:', err.message);
  }
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

    return `\n\n## ACTIVE CONTEXT WINDOW (Memory for this Salesperson)
- Currently Active Customer: "${activeCustomer}"
- Last Action/Intent: ${lastIntent}${profileSummary}

INSTRUCTIONS FOR PROFILE UPDATES & MEMORY:
1. If the salesperson provides any profile info (location/city, GST number, mobile phone, contact person/owner) WITHOUT naming a company, it refers to the active customer "${activeCustomer}"!
2. Call update_customer_profile with customer_name: "${activeCustomer}" and the provided details (address_or_city, gst, phone, contact_person).
3. NEVER ask "which company" or treat location/GST replies as order searches when an active customer "${activeCustomer}" is in this context window!
4. If a message specifies a requirement or quantity (e.g. "Need 25 MT", "wants HR Coil", "create deal") WITHOUT repeating the customer name, assume it refers to "${activeCustomer}".
5. If the salesperson replies "Yes", "Confirm", "sahi hai", or gives a PO Number/Deal ID to a previous confirmation prompt, associate it with "${activeCustomer}".`;
  } catch (err) {
    console.error('[Memory] Error getting active context prompt:', err.message);
    return '';
  }
}

module.exports = {
  getChatHistory,
  getChatHistorySync,
  addChatHistory,
  getActiveContextPrompt,
};
