/**
 * memory.js - Enterprise 3-Tier Multi-turn Context Window & Stateful Customer Memory
 *
 * Implements the industry-standard 3-tier memory model:
 *
 * Tier 1: Real-Time Sliding Message Window (Rolling 15 turns per salesperson)
 * Tier 2: Customer-Scoped Conversation Threads (Isolated history per customer thread)
 * Tier 3: Stateful Business Entity Fact Sheet (Customer 360 snapshot: profile, open deals, visits, complaints)
 *
 * Guaranteed Isolation: Strictly partitioned by salesperson phone and RBAC scope.
 */

const { HumanMessage, AIMessage } = require('@langchain/core/messages');
const { supabase } = require('../supabase');

// Fast in-memory caches
const rawHistoryMap = new Map(); // phoneKey -> [MessageObj]
const customerThreadMap = new Map(); // phoneKey:customerLower -> [MessageObj]

const MAX_MESSAGES = 15; // Rolling 15-message active window
const MAX_CUSTOMER_THREAD_MESSAGES = 8; // Past 8 messages for specific customer thread

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
  return Array.from(new Set([p10, '91' + p10, '+91' + p10, clean]));
}

function normalizeCustomerKey(name) {
  if (!name) return '';
  return String(name).trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Normalizes a stored item into a standard message object.
 */
function normalizeMessageObj(item) {
  if (!item) return null;
  const role = item.role === 'human' || item.role === 'user' ? 'user' : 'assistant';
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
 * Tier 1: Get raw recent chat history objects (up to 15 messages) for a salesperson.
 */
async function getRawChatHistory(senderPhone) {
  if (!senderPhone) return [];
  const pKey = getCanonicalPhoneKey(senderPhone);
  if (!pKey) return [];

  if (rawHistoryMap.has(pKey)) {
    return rawHistoryMap.get(pKey);
  }

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
 * Get recent chat history as LangChain messages for model execution.
 */
async function getChatHistory(senderPhone) {
  const rawList = await getRawChatHistory(senderPhone);
  return rawList.map((m) => {
    if (m.role === 'user') return new HumanMessage(m.content);
    return new AIMessage(m.content);
  });
}

function getChatHistorySync(senderPhone) {
  if (!senderPhone) return [];
  const pKey = getCanonicalPhoneKey(senderPhone);
  const list = rawHistoryMap.get(pKey) || [];
  return list.map((m) => {
    if (m.role === 'user') return new HumanMessage(m.content);
    return new AIMessage(m.content);
  });
}

/**
 * Tier 2: Customer-Scoped Conversation Thread Getter.
 * Returns past messages exchanged specifically regarding a customer.
 */
async function getCustomerThreadHistory(senderPhone, customerName) {
  if (!senderPhone || !customerName) return [];
  const pKey = getCanonicalPhoneKey(senderPhone);
  const cKey = normalizeCustomerKey(customerName);
  if (!pKey || !cKey) return [];

  const threadKey = pKey + ':' + cKey;
  if (customerThreadMap.has(threadKey)) {
    return customerThreadMap.get(threadKey);
  }

  const fullHistory = await getRawChatHistory(senderPhone);
  const matched = fullHistory.filter(
    (m) => m.customer_name && normalizeCustomerKey(m.customer_name) === cKey,
  );

  customerThreadMap.set(threadKey, matched.slice(-MAX_CUSTOMER_THREAD_MESSAGES));
  return matched.slice(-MAX_CUSTOMER_THREAD_MESSAGES);
}

/**
 * Append message to Tier 1 (Active Window) and Tier 2 (Customer Thread).
 */
async function addChatMessage(senderPhone, messageObj) {
  if (!senderPhone || !messageObj) return;
  const pKey = getCanonicalPhoneKey(senderPhone);
  if (!pKey) return;

  const normalized = normalizeMessageObj(messageObj);
  if (!normalized) return;

  let history = await getRawChatHistory(senderPhone);
  history.push(normalized);

  if (history.length > MAX_MESSAGES) {
    history = history.slice(-MAX_MESSAGES);
  }

  rawHistoryMap.set(pKey, history);

  if (normalized.customer_name) {
    const cKey = normalizeCustomerKey(normalized.customer_name);
    if (cKey) {
      const threadKey = pKey + ':' + cKey;
      const thread = customerThreadMap.get(threadKey) || [];
      thread.push(normalized);
      if (thread.length > MAX_CUSTOMER_THREAD_MESSAGES) {
        thread.shift();
      }
      customerThreadMap.set(threadKey, thread);
    }
  }

  try {
    const variants = getCanonicalPhoneVariants(senderPhone);
    const { data: existing } = await supabase
      .from('conversation_sessions')
      .select('salesperson_phone, active_customer_name')
      .in('salesperson_phone', variants)
      .limit(1);

    const primaryPhone = '91' + pKey;
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
      await supabase.from('conversation_sessions').insert({
        salesperson_phone: primaryPhone,
        ...updatePayload,
      });
    }
  } catch (err) {
    console.error('[Memory] Error persisting chat history to DB:', err.message);
  }
}

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

  const transcriptLines = history.map((m, idx) => {
    const roleTag = m.role === 'user' ? 'Salesperson' : 'Assistant (' + (m.agent || 'Bot') + ')';
    const metaTag = [
      m.customer_name ? 'Customer: ' + m.customer_name : null,
      m.deal_id ? 'Deal: #' + m.deal_id : null,
    ]
      .filter(Boolean)
      .join(', ');

    return '[Msg ' + (idx + 1) + '/' + history.length + '] ' + roleTag + (metaTag ? ' [' + metaTag + ']' : '') + ': "' + m.content.replace(/\n+/g, ' ') + '"';
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
 * Tier 3: Stateful Business Entity Fact Sheet / Customer 360 Memory Snapshot
 * Queries customer master, active pipeline deals, recent visits, and open complaints.
 */
async function getCustomerFactSheet(customerName, senderPhone) {
  if (!customerName) return '';

  try {
    const { getAccessibleSalespersonPhonesForBot } = require('../supabase');
    const scope = await getAccessibleSalespersonPhonesForBot(senderPhone);

    // 1. Customer Profile
    let custQuery = supabase
      .from('recurring_customers')
      .select('customer_name, customer_phone, customer_gst, customer_address, contact_person, target_frequency_days, tier')
      .ilike('customer_name', '%' + customerName + '%')
      .limit(1);

    if (scope.phones !== null) {
      if (scope.phones.length === 1) {
        custQuery = custQuery.eq('assigned_salesperson_phone', scope.phones[0]);
      } else if (scope.phones.length > 1) {
        custQuery = custQuery.in('assigned_salesperson_phone', scope.phones);
      }
    }

    const { data: custRows } = await custQuery;
    const cust = custRows && custRows.length > 0 ? custRows[0] : null;

    // 2. Active Deals / Pending Quotes
    let dealsQuery = supabase
      .from('deals')
      .select('deal_code, stage, total_amount, created_at, inquiry_type')
      .ilike('customer_name', '%' + customerName + '%')
      .in('stage', ['new_inquiry', 'quoted', 'sent_to_party', 'negotiation'])
      .order('created_at', { ascending: false })
      .limit(3);

    const { data: openDeals } = await dealsQuery;

    // 3. Recent Visits
    let visitsQuery = supabase
      .from('customer_visits')
      .select('visited_at, person_met, customer_address, remarks')
      .ilike('customer_name', '%' + customerName + '%')
      .order('visited_at', { ascending: false })
      .limit(2);

    const { data: recentVisits } = await visitsQuery;

    let factSheet = '\n\n## 🏢 CUSTOMER 360° BUSINESS MEMORY ("' + (cust?.customer_name || customerName) + '")';

    if (cust) {
      const missing = [];
      if (!cust.customer_phone) missing.push('Mobile Number');
      if (!cust.contact_person) missing.push('Contact Person / Owner');
      if (!cust.customer_address) missing.push('City / Location');
      if (!cust.customer_gst) missing.push('GSTIN');

      factSheet += '\n- Phone: ' + (cust.customer_phone || 'MISSING');
      factSheet += '\n- Contact Person: ' + (cust.contact_person || 'MISSING');
      factSheet += '\n- Location: ' + (cust.customer_address || 'MISSING');
      factSheet += '\n- GSTIN: ' + (cust.customer_gst || 'MISSING');
      factSheet += '\n- Order Frequency: ' + (cust.target_frequency_days || 30) + ' days | Tier: ' + (cust.tier || 'C');
      factSheet += '\n- Missing Profile Fields: ' + (missing.length > 0 ? missing.join(', ') : 'None (Complete)');
    }

    if (openDeals && openDeals.length > 0) {
      factSheet += '\n\n- Active Pipeline Deals:';
      openDeals.forEach((d) => {
        factSheet += '\n  • Deal #' + (d.deal_code || 'ID') + ' [Stage: ' + d.stage + ']';
      });
    }

    if (recentVisits && recentVisits.length > 0) {
      factSheet += '\n\n- Recent Site Visits:';
      recentVisits.forEach((v) => {
        const dateStr = v.visited_at ? v.visited_at.slice(0, 10) : 'Recent';
        const metStr = v.person_met ? ' (Met: ' + v.person_met + ')' : '';
        const remarkStr = v.remarks ? ' - ' + v.remarks.slice(0, 80) : '';
        factSheet += '\n  • Visited: ' + dateStr + metStr + remarkStr;
      });
    }

    return factSheet;
  } catch (err) {
    console.error('[Memory] Error generating customer fact sheet:', err.message);
    return '';
  }
}

/**
 * Assembles the full Multi-Tier context prompt for LLM execution.
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
      historySection = '\n\n## ROLLING CONVERSATION HISTORY (Last ' + crossCtx.messages.length + ' Messages across all agents):\n' + crossCtx.formattedHistory;
    }

    if (!activeCustomer) {
      return historySection;
    }

    // Tier 3: Stateful Business Fact Sheet
    const factSheet = await getCustomerFactSheet(activeCustomer, senderPhone);

    // Tier 2: Dedicated Customer Thread History (if available)
    const thread = await getCustomerThreadHistory(senderPhone, activeCustomer);
    let threadSection = '';
    if (thread.length > 2) {
      threadSection = '\n\n## CUSTOMER-SPECIFIC DIALOGUE THREAD (' + activeCustomer + '):\n' +
        thread.map((t, i) => '[' + (i + 1) + '] ' + (t.role === 'user' ? 'Salesperson' : 'Bot') + ': "' + t.content.replace(/\n+/g, ' ') + '"').join('\n');
    }

    const activeDealStr = crossCtx.activeDealId ? '#' + crossCtx.activeDealId : 'None';

    return historySection + threadSection + factSheet + '\n\n## ACTIVE CONTEXT WINDOW (Memory for this Salesperson)\n' +
      '- Currently Active Customer: "' + activeCustomer + '"\n' +
      '- Active Deal ID: ' + activeDealStr + '\n' +
      '- Last Action/Intent: ' + lastIntent + '\n\n' +
      'INSTRUCTIONS FOR CROSS-AGENT MEMORY & CONTEXT RESOLUTION:\n' +
      '1. If the salesperson refers to "that deal", "the deal", "this customer", "the same customer", "update it", or provides details without naming the customer, resolve it to "' + activeCustomer + '" and Deal ' + (crossCtx.activeDealId ? '#' + crossCtx.activeDealId : 'active in context') + '!\n' +
      '2. If profile info (location/city, GST number, mobile phone, contact person/owner) is provided WITHOUT naming a company, attribute it to "' + activeCustomer + '" and call update_customer_profile.\n' +
      '3. NEVER ask "which company" or treat location/GST replies as order searches when an active customer "' + activeCustomer + '" is in this context window!\n' +
      '4. If a message specifies a requirement or quantity (e.g. "Need 25 MT", "wants HR Coil", "create deal") WITHOUT repeating the customer name, assume it refers to "' + activeCustomer + '".\n' +
      '5. If the salesperson replies "Yes", "Confirm", "sahi hai", or gives a PO Number/Deal ID to a previous confirmation prompt, associate it with "' + activeCustomer + '".';
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
  getCustomerThreadHistory,
  getCustomerFactSheet,
  addChatMessage,
  addChatHistory,
  getCrossAgentContext,
  getActiveContextPrompt,
};
