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

// Fast in-memory cache per canonical 10-digit salesperson phone
const chatHistoryMap = new Map();
const MAX_TURNS = 5; // Keep exact last 5 conversations (10 messages: 5 human, 5 AI)

function getCanonicalPhoneKey(phone) {
  if (!phone) return '';
  const clean = String(phone).replace(/\D/g, '');
  return clean.slice(-10);
}

function getCanonicalPhoneVariants(phone) {
  if (!phone) return [];
  const clean = String(phone).replace(/\D/g, '');
  const p10 = clean.slice(-10);
  if (!p10) return [];
  return Array.from(new Set([p10, `91${p10}`, `+91${p10}`, clean]));
}

/**
 * Get recent chat history messages for a salesperson.
 * Fetches from in-memory cache or PostgreSQL `conversation_sessions`.
 * Strict 1-to-1 partitioning: Never accesses other salespeople's histories.
 */
async function getChatHistory(senderPhone) {
  if (!senderPhone) return [];
  const pKey = getCanonicalPhoneKey(senderPhone);
  if (!pKey) return [];

  // Check in-memory cache first
  if (chatHistoryMap.has(pKey)) {
    return chatHistoryMap.get(pKey);
  }

  // Load from Supabase conversation_sessions
  try {
    const variants = getCanonicalPhoneVariants(senderPhone);
    const { data: session } = await supabase
      .from('conversation_sessions')
      .select('chat_history')
      .in('salesperson_phone', variants)
      .order('updated_at', { ascending: false })
      .limit(1);

    if (session && session.length > 0 && Array.isArray(session[0].chat_history)) {
      const rawList = session[0].chat_history;
      const history = rawList.slice(-MAX_TURNS * 2).map(m => {
        if (m.role === 'human') return new HumanMessage(m.content);
        return new AIMessage(m.content);
      });
      chatHistoryMap.set(pKey, history);
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
  const pKey = getCanonicalPhoneKey(senderPhone);
  return chatHistoryMap.get(pKey) || [];
}

/**
 * Append a human message and AI message to the salesperson's chat history.
 * Persists to both memory cache and PostgreSQL `conversation_sessions`.
 * Strict isolation: Persisted strictly under this salesperson's phone identifier.
 */
async function addChatHistory(senderPhone, humanText, aiReplyText) {
  if (!senderPhone) return;
  const pKey = getCanonicalPhoneKey(senderPhone);
  if (!pKey) return;

  let history = chatHistoryMap.get(pKey) || [];

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

  chatHistoryMap.set(pKey, history);

  // Format serializable JSON list
  const serialized = history.map(m => ({
    role: (m._getType?.() === 'human' || m.constructor?.name === 'HumanMessage') ? 'human' : 'ai',
    content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
  }));

  // Persist to Supabase conversation_sessions asynchronously
  try {
    const variants = getCanonicalPhoneVariants(senderPhone);
    const { data: existing } = await supabase
      .from('conversation_sessions')
      .select('salesperson_phone')
      .in('salesperson_phone', variants)
      .limit(1);

    const primaryPhone = `91${pKey}`;

    if (existing && existing.length > 0) {
      await supabase
        .from('conversation_sessions')
        .update({
          chat_history: serialized,
          updated_at: new Date().toISOString(),
        })
        .eq('salesperson_phone', existing[0].salesperson_phone);
    } else {
      await supabase
        .from('conversation_sessions')
        .insert({
          salesperson_phone: primaryPhone,
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
 * Strictly enforces RBAC:
 * - Salesperson sees only active customer session created by themselves
 * - Customer profile metrics/fields are fetched strictly within caller's authorized scope
 */
async function getActiveContextPrompt(senderPhone) {
  if (!senderPhone) return '';
  const variants = getCanonicalPhoneVariants(senderPhone);

  try {
    const { data: session } = await supabase
      .from('conversation_sessions')
      .select('active_customer_name, last_intent, updated_at')
      .in('salesperson_phone', variants)
      .order('updated_at', { ascending: false })
      .limit(1);

    if (!session || session.length === 0 || !session[0].active_customer_name) {
      return '';
    }

    const activeCustomer = session[0].active_customer_name;
    const lastIntent = session[0].last_intent || 'general';

    const { getAccessibleSalespersonPhonesForBot } = require('../supabase');
    const scope = await getAccessibleSalespersonPhonesForBot(senderPhone);

    // Fetch customer profile from recurring_customers strictly within authorized scope
    let custQuery = supabase
      .from('recurring_customers')
      .select('customer_name, customer_phone, customer_gst, customer_address, contact_person, assigned_salesperson_phone')
      .ilike('customer_name', `%${activeCustomer}%`)
      .limit(1);

    if (scope.phones !== null) {
      if (scope.phones.length === 1) {
        custQuery = custQuery.eq('assigned_salesperson_phone', scope.phones[0]);
      } else if (scope.phones.length > 1) {
        custQuery = custQuery.in('assigned_salesperson_phone', scope.phones);
      }
    }

    const { data: custData } = await custQuery;
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
