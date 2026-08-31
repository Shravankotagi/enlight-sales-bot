/**
 * memory.js - Persistent Multi-turn Context Window & Cross-Agent Session Memory for WhatsApp Bot
 *
 * Maintains a persistent rolling window of the exact last 7 messages per salesperson phone number
 * backed by Supabase `conversation_sessions.chat_history`, with an in-memory fast cache.
 *
 * Each message stores:
 * - role: 'user' | 'assistant'
 * - content: text message or image/document OCR action summary
 * - timestamp: ISO timestamp string
 * - agent: which agent handled it ('sales', 'visit', 'ocr', 'complaint', 'payment', 'retention', 'query')
 * - deal_id: any active deal ID or null
 * - customer_name: any active customer name or null
 *
 * Guaranteed isolation: Each WhatsApp account (salesperson phone) has its own independent
 * 7-message window and active customer/deal context (zero cross-talk).
 */

const { HumanMessage, AIMessage } = require('@langchain/core/messages');
const { supabase } = require('../supabase');

// Fast in-memory cache per canonical 10-digit salesperson phone
// Stores array of raw message objects: [{ role, content, timestamp, agent, deal_id, customer_name }]
const rawHistoryMap = new Map();
const MAX_MESSAGES = 7; // Rolling 7-message window

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
 * Normalizes a stored item into a standard 7-message item object.
 */
function normalizeMessageObj(item) {
  if (!item) return null;
  const role = (item.role === 'human' || item.role === 'user') ? 'user' : 'assistant';
  const content = typeof item.content === 'string' ? item.content : JSON.stringify(item.content || '');
  return {
    role,
    content,
    timestamp: item.timestamp || new Date().toISOString(),
    agent: item.agent || (role === 'user' ? 'salesperson' : 'general'),
    deal_id: item.deal_id || item.dealId || null,
    customer_name: item.customer_name || item.customerName || null,
  };
}

/**
 * Get raw recent chat history objects (up to 7 messages) for a salesperson.
 * Fetches from in-memory cache or PostgreSQL `conversation_sessions.chat_history`.
 */
async function getRawChatHistory(senderPhone) {
  if (!senderPhone) return [];
  const pKey = getCanonicalPhoneKey(senderPhone);
  if (!pKey) return [];

  // Check in-memory cache first
  if (rawHistoryMap.has(pKey)) {
    return rawHistoryMap.get(pKey);
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
      const rawList = session[0].chat_history
        .map(normalizeMessageObj)
        .filter(Boolean)
        .slice(-MAX_MESSAGES);

      rawHistoryMap.set(pKey, rawList);
      return rawList;
    }
  } catch (err) {
    console.error('[Memory] Error loading chat history from DB:', err.message);
  }

  return [];
}

/**
 * Get recent chat history as LangChain messages (up to 7 messages) for a salesperson.
 */
async function getChatHistory(senderPhone) {
  const rawList = await getRawChatHistory(senderPhone);
  return rawList.map(m => {
    if (m.role === 'user') return new HumanMessage(m.content);
    return new AIMessage(m.content);
  });
}

/**
 * Synchronous getter for when caller cannot await (returns in-memory cache).
 */
function getChatHistorySync(senderPhone) {
  if (!senderPhone) return [];
  const pKey = getCanonicalPhoneKey(senderPhone);
  const list = rawHistoryMap.get(pKey) || [];
  return list.map(m => {
    if (m.role === 'user') return new HumanMessage(m.content);
    return new AIMessage(m.content);
  });
}

/**
 * Append a single message or multiple messages to the 7-message context window.
 * Drops the oldest messages if count exceeds MAX_MESSAGES (7).
 * Persists to memory and PostgreSQL `conversation_sessions`.
 */
async function addChatMessage(senderPhone, messageObj) {
  if (!senderPhone || !messageObj) return;
  const pKey = getCanonicalPhoneKey(senderPhone);
  if (!pKey) return;

  const normalized = normalizeMessageObj(messageObj);
  if (!normalized) return;

  let history = await getRawChatHistory(senderPhone);
  history.push(normalized);

  // Maintain strict rolling 7-message window
  if (history.length > MAX_MESSAGES) {
    history = history.slice(-MAX_MESSAGES);
  }

  rawHistoryMap.set(pKey, history);

  // Persist to Supabase conversation_sessions
  try {
    const variants = getCanonicalPhoneVariants(senderPhone);
    const { data: existing } = await supabase
      .from('conversation_sessions')
      .select('salesperson_phone, active_customer_name')
      .in('salesperson_phone', variants)
      .limit(1);

    const primaryPhone = `91${pKey}`;
    const updatePayload = {
      chat_history: history,
      updated_at: new Date().toISOString(),
    };

    if (normalized.customer_name) {
      updatePayload.active_customer_name = normalized.customer_name;
    }

    if (existing && existing.length > 0) {
      await supabase
        .from('conversation_sessions')
        .update(updatePayload)
        .eq('salesperson_phone', existing[0].salesperson_phone);
    } else {
      await supabase
        .from('conversation_sessions')
        .insert({
          salesperson_phone: primaryPhone,
          ...updatePayload,
        });
    }
  } catch (err) {
    console.error('[Memory] Error persisting chat history to DB:', err.message);
  }
}

/**
 * Backward-compatible helper to append human message & assistant reply with metadata.
 */
async function addChatHistory(senderPhone, humanText, aiReplyText, meta = {}) {
  if (!senderPhone) return;
  const now = new Date().toISOString();
  const customerName = meta.customer_name || meta.customerName || null;
  const dealId = meta.deal_id || meta.dealId || null;
  const agent = meta.agent || 'orchestrator';

  if (humanText) {
    await addChatMessage(senderPhone, {
      role: 'user',
      content: humanText,
      timestamp: now,
      agent: 'salesperson',
      customer_name: customerName,
      deal_id: dealId,
    });
  }

  if (aiReplyText) {
    await addChatMessage(senderPhone, {
      role: 'assistant',
      content: aiReplyText,
      timestamp: new Date().toISOString(),
      agent,
      customer_name: customerName,
      deal_id: dealId,
    });
  }
}

/**
 * Returns structured cross-agent context for prompt injection across all agents.
 */
async function getCrossAgentContext(senderPhone) {
  const history = await getRawChatHistory(senderPhone);
  if (!history || history.length === 0) {
    return {
      messages: [],
      activeCustomer: null,
      activeDealId: null,
      lastAgent: null,
      formattedHistory: '',
    };
  }

  // Extract most recent active customer and deal ID from history
  let activeCustomer = null;
  let activeDealId = null;
  let lastAgent = null;

  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    if (!activeCustomer && item.customer_name) {
      activeCustomer = item.customer_name;
    }
    if (!activeDealId && item.deal_id) {
      activeDealId = item.deal_id;
    }
    if (!lastAgent && item.agent && item.agent !== 'salesperson') {
      lastAgent = item.agent;
    }
  }

  // Format 7-message transcript
  const transcriptLines = history.map((m, idx) => {
    const roleTag = m.role === 'user' ? 'Salesperson' : `Assistant (${m.agent || 'Bot'})`;
    const metaTag = [
      m.customer_name ? `Customer: ${m.customer_name}` : null,
      m.deal_id ? `Deal: #${m.deal_id}` : null,
    ].filter(Boolean).join(', ');

    return `[Msg ${idx + 1}/${history.length}] ${roleTag}${metaTag ? ` [${metaTag}]` : ''}: "${m.content.replace(/\n+/g, ' ')}"`;
  });

  return {
    messages: history,
    activeCustomer,
    activeDealId,
    lastAgent,
    formattedHistory: transcriptLines.join('\n'),
  };
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

    const crossCtx = await getCrossAgentContext(senderPhone);
    const activeCustomer = session?.[0]?.active_customer_name || crossCtx.activeCustomer;
    const lastIntent = session?.[0]?.last_intent || 'general';

    let historySection = '';
    if (crossCtx.formattedHistory) {
      historySection = `\n\n## ROLLING CONVERSATION HISTORY (Last ${crossCtx.messages.length} Messages across all agents):
${crossCtx.formattedHistory}`;
    }

    if (!activeCustomer) {
      return historySection;
    }

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

    return `${historySection}

## ACTIVE CONTEXT WINDOW (Memory for this Salesperson)
- Currently Active Customer: "${activeCustomer}"
- Active Deal ID: ${crossCtx.activeDealId ? `#${crossCtx.activeDealId}` : 'None'}
- Last Action/Intent: ${lastIntent}${profileSummary}

INSTRUCTIONS FOR CROSS-AGENT MEMORY & CONTEXT RESOLUTION:
1. If the salesperson refers to "that deal", "the deal", "this customer", "the same customer", "update it", or provides details without naming the customer, resolve it to "${activeCustomer}" and Deal ${crossCtx.activeDealId ? `#${crossCtx.activeDealId}` : 'active in context'}!
2. If profile info (location/city, GST number, mobile phone, contact person/owner) is provided WITHOUT naming a company, attribute it to "${activeCustomer}" and call update_customer_profile.
3. NEVER ask "which company" or treat location/GST replies as order searches when an active customer "${activeCustomer}" is in this context window!
4. If a message specifies a requirement or quantity (e.g. "Need 25 MT", "wants HR Coil", "create deal") WITHOUT repeating the customer name, assume it refers to "${activeCustomer}".
5. If the salesperson replies "Yes", "Confirm", "sahi hai", or gives a PO Number/Deal ID to a previous confirmation prompt, associate it with "${activeCustomer}".`;
  } catch (err) {
    console.error('[Memory] Error getting active context prompt:', err.message);
    return '';
  }
}

module.exports = {
  MAX_MESSAGES,
  getRawChatHistory,
  getChatHistory,
  getChatHistorySync,
  addChatMessage,
  addChatHistory,
  getCrossAgentContext,
  getActiveContextPrompt,
};

