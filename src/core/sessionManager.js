/**
 * sessionManager.js - Permanent Session Management & Rolling Buffer Engine for WhatsApp Bot
 *
 * Implements:
 * 1. Rolling 15-Message Context Buffer: Always keeps the last 15 messages per salesperson.
 * 2. Last Completed Activity Tracking: Stores detailed metadata when a flow completes (customer, deal ID, inquiry ID, PO number, specs, summary).
 * 3. Activity Continuation Detection: Automatically identifies if the next message is a continuation of the recently completed activity vs a new/different customer.
 * 4. Context Scoping: Provides the 15-message rolling buffer + activity fact sheet for continuations; returns an empty fresh session for unrelated/different customer activities.
 * 5. Intelligent Cross-Database Retrieval for Option 10: Query-driven multi-table search (deals, visits, complaints, customers, session logs) replacing the rigid 7-session text dump.
 */

const { supabase, getAccessibleSalespersonPhonesForBot, expandPhoneVariants } = require('../supabase');

// Fast in-memory cache: phoneKey -> { current_session, last_completed_activity, rolling_messages, saved_sessions }
const sessionCache = new Map();

const MAX_ROLLING_MESSAGES = 15;
const MAX_SAVED_SESSIONS = 15;

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

function generateSessionId() {
  return `sess_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
}

function normalizeCustomerKey(name) {
  if (!name) return '';
  return String(name).trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Normalizes legacy chat_history or existing session envelopes into a valid envelope.
 */
function normalizeSessionEnvelope(raw) {
  if (!raw) {
    return {
      current_session: null,
      last_completed_activity: null,
      rolling_messages: [],
      saved_sessions: [],
    };
  }

  // If already structured envelope
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const rolling = Array.isArray(raw.rolling_messages)
      ? raw.rolling_messages.slice(-MAX_ROLLING_MESSAGES)
      : [];
    const saved = Array.isArray(raw.saved_sessions)
      ? raw.saved_sessions.slice(-MAX_SAVED_SESSIONS)
      : [];

    return {
      current_session: raw.current_session || null,
      last_completed_activity: raw.last_completed_activity || null,
      rolling_messages: rolling,
      saved_sessions: saved,
    };
  }

  // If legacy message array
  if (Array.isArray(raw) && raw.length > 0) {
    const legacySession = {
      session_id: generateSessionId(),
      session_index: 1,
      started_at: raw[0]?.timestamp || new Date().toISOString(),
      ended_at: raw[raw.length - 1]?.timestamp || new Date().toISOString(),
      action_type: 'LEGACY_CONVERSATION',
      customer_name: raw.find(m => m.customer_name)?.customer_name || null,
      deal_id: raw.find(m => m.deal_id)?.deal_id || null,
      po_number: null,
      inquiry_id: null,
      summary: 'Previous conversation history',
      messages: raw.map(m => ({
        role: m.role === 'human' || m.role === 'user' ? 'user' : 'assistant',
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''),
        timestamp: m.timestamp || new Date().toISOString(),
        agent: m.agent || 'general',
        customer_name: m.customer_name || null,
        deal_id: m.deal_id || null,
      })),
    };

    const rolling = raw.map(m => ({
      role: m.role === 'human' || m.role === 'user' ? 'user' : 'assistant',
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''),
      timestamp: m.timestamp || new Date().toISOString(),
      agent: m.agent || 'general',
      customer_name: m.customer_name || null,
      deal_id: m.deal_id || null,
    })).slice(-MAX_ROLLING_MESSAGES);

    return {
      current_session: null,
      last_completed_activity: null,
      rolling_messages: rolling,
      saved_sessions: [legacySession],
    };
  }

  return {
    current_session: null,
    last_completed_activity: null,
    rolling_messages: [],
    saved_sessions: [],
  };
}

/**
 * Loads the session envelope from in-memory cache or Supabase conversation_sessions.
 */
async function getSessionEnvelope(senderPhone) {
  if (!senderPhone) {
    return { current_session: null, last_completed_activity: null, rolling_messages: [], saved_sessions: [] };
  }
  const pKey = getCanonicalPhoneKey(senderPhone);
  if (!pKey) {
    return { current_session: null, last_completed_activity: null, rolling_messages: [], saved_sessions: [] };
  }

  if (sessionCache.has(pKey)) {
    return sessionCache.get(pKey);
  }

  try {
    const variants = getCanonicalPhoneVariants(senderPhone);
    const { data: rows, error } = await supabase
      .from('conversation_sessions')
      .select('salesperson_phone, active_customer_name, last_intent, chat_history, updated_at')
      .in('salesperson_phone', variants)
      .order('updated_at', { ascending: false })
      .limit(1);

    if (error) {
      console.error('[SessionManager] DB fetch error:', error.message);
    }

    if (rows && rows.length > 0) {
      const envelope = normalizeSessionEnvelope(rows[0].chat_history);
      sessionCache.set(pKey, envelope);
      return envelope;
    }
  } catch (err) {
    console.error('[SessionManager] Error loading session envelope:', err.message);
  }

  const fresh = { current_session: null, last_completed_activity: null, rolling_messages: [], saved_sessions: [] };
  sessionCache.set(pKey, fresh);
  return fresh;
}

/**
 * Persists session envelope to cache and Supabase conversation_sessions table.
 */
async function persistSessionEnvelope(senderPhone, envelope) {
  if (!senderPhone || !envelope) return;
  const pKey = getCanonicalPhoneKey(senderPhone);
  if (!pKey) return;

  // Enforce retention limits
  if (Array.isArray(envelope.rolling_messages) && envelope.rolling_messages.length > MAX_ROLLING_MESSAGES) {
    envelope.rolling_messages = envelope.rolling_messages.slice(-MAX_ROLLING_MESSAGES);
  }
  if (Array.isArray(envelope.saved_sessions) && envelope.saved_sessions.length > MAX_SAVED_SESSIONS) {
    envelope.saved_sessions = envelope.saved_sessions.slice(-MAX_SAVED_SESSIONS);
  }

  sessionCache.set(pKey, envelope);

  try {
    const variants = getCanonicalPhoneVariants(senderPhone);
    const primaryPhone = `91${pKey}`;

    const activeCust = envelope.current_session?.customer_name || envelope.last_completed_activity?.customer_name || null;
    const updatePayload = {
      chat_history: envelope,
      updated_at: new Date().toISOString(),
    };
    if (activeCust) {
      updatePayload.active_customer_name = activeCust;
    }

    const { data: existing } = await supabase
      .from('conversation_sessions')
      .select('salesperson_phone, active_customer_name')
      .in('salesperson_phone', variants)
      .limit(1);

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
    console.error('[SessionManager] Error persisting session envelope:', err.message);
  }
}

/**
 * Generates an automated summary for a session based on its messages and actions.
 */
function buildAutoSessionSummary(session) {
  if (!session) return 'Completed sales activity session';
  if (session.summary && session.summary !== 'Incomplete session' && session.summary !== 'Active session') {
    return session.summary;
  }

  const action = session.action_type || 'General Discussion';
  const customer = session.customer_name ? ` for ${session.customer_name}` : '';
  const ref = session.po_number ? ` (PO: ${session.po_number})` : (session.inquiry_id ? ` (Inquiry: ${session.inquiry_id})` : '');

  const userMessages = (session.messages || []).filter(m => m.role === 'user').map(m => m.content);
  const snippet = userMessages.length > 0 ? ` - Details: ${userMessages[0].substring(0, 100)}` : '';

  return `${action}${customer}${ref}${snippet}`.trim();
}

/**
 * Starts a brand new catalog session at the exact moment the catalog menu is presented.
 * Finalizes any active ongoing session and archives it to saved_sessions.
 */
async function startNewCatalogSession(senderPhone, initialMenuPrompt = null) {
  const envelope = await getSessionEnvelope(senderPhone);
  const nowIso = new Date().toISOString();

  // 1. Finalize ongoing session if it had any interactions
  if (envelope.current_session && Array.isArray(envelope.current_session.messages) && envelope.current_session.messages.length > 0) {
    const prev = envelope.current_session;
    prev.ended_at = nowIso;
    prev.summary = buildAutoSessionSummary(prev);

    envelope.saved_sessions.push(prev);
    if (envelope.saved_sessions.length > MAX_SAVED_SESSIONS) {
      envelope.saved_sessions = envelope.saved_sessions.slice(-MAX_SAVED_SESSIONS);
    }
  }

  // 2. Compute next sequential index
  const lastIndex = envelope.saved_sessions.length > 0
    ? (envelope.saved_sessions[envelope.saved_sessions.length - 1].session_index || envelope.saved_sessions.length)
    : 0;
  const nextIndex = lastIndex + 1;

  // 3. Create fresh current_session
  const initialMessages = [];
  if (initialMenuPrompt) {
    initialMessages.push({
      role: 'assistant',
      content: initialMenuPrompt,
      timestamp: nowIso,
      agent: 'catalog_menu',
    });
  }

  envelope.current_session = {
    session_id: generateSessionId(),
    session_index: nextIndex,
    started_at: nowIso,
    ended_at: null,
    action_type: null,
    customer_name: null,
    deal_id: null,
    po_number: null,
    inquiry_id: null,
    summary: null,
    messages: initialMessages,
  };

  await persistSessionEnvelope(senderPhone, envelope);
  return envelope.current_session;
}

/**
 * Records a message in both the active session and the global 15-message rolling buffer.
 */
async function recordSessionMessage(senderPhone, role, content, metadata = {}) {
  if (!senderPhone || !content) return;
  const envelope = await getSessionEnvelope(senderPhone);
  const nowIso = new Date().toISOString();

  if (!envelope.current_session) {
    envelope.current_session = {
      session_id: generateSessionId(),
      session_index: (envelope.saved_sessions?.length || 0) + 1,
      started_at: nowIso,
      ended_at: null,
      action_type: metadata.action_type || metadata.action || null,
      customer_name: metadata.customer_name || metadata.customerName || null,
      deal_id: metadata.deal_id || metadata.dealId || null,
      po_number: metadata.po_number || metadata.poNumber || null,
      inquiry_id: metadata.inquiry_id || metadata.inquiryId || null,
      summary: metadata.summary || null,
      messages: [],
    };
  }

  const cleanRole = role === 'human' || role === 'user' ? 'user' : 'assistant';
  const msgObj = {
    role: cleanRole,
    content: typeof content === 'string' ? content : JSON.stringify(content),
    timestamp: nowIso,
    agent: metadata.agent || (cleanRole === 'user' ? 'salesperson' : 'bot'),
    customer_name: metadata.customer_name || metadata.customerName || envelope.current_session.customer_name || null,
    deal_id: metadata.deal_id || metadata.dealId || envelope.current_session.deal_id || null,
  };

  // 1. Add to active session messages
  envelope.current_session.messages.push(msgObj);

  // 2. Add to rolling 15-message window
  if (!Array.isArray(envelope.rolling_messages)) {
    envelope.rolling_messages = [];
  }
  envelope.rolling_messages.push(msgObj);
  if (envelope.rolling_messages.length > MAX_ROLLING_MESSAGES) {
    envelope.rolling_messages = envelope.rolling_messages.slice(-MAX_ROLLING_MESSAGES);
  }

  // Update session-level metadata if provided
  if (metadata.customer_name || metadata.customerName) {
    envelope.current_session.customer_name = metadata.customer_name || metadata.customerName;
  }
  if (metadata.action_type || metadata.action) {
    envelope.current_session.action_type = metadata.action_type || metadata.action;
  }
  if (metadata.deal_id || metadata.dealId) {
    envelope.current_session.deal_id = metadata.deal_id || metadata.dealId;
  }
  if (metadata.po_number || metadata.poNumber) {
    envelope.current_session.po_number = metadata.po_number || metadata.poNumber;
  }
  if (metadata.inquiry_id || metadata.inquiryId) {
    envelope.current_session.inquiry_id = metadata.inquiry_id || metadata.inquiryId;
  }
  if (metadata.summary) {
    envelope.current_session.summary = metadata.summary;
  }

  await persistSessionEnvelope(senderPhone, envelope);
}

/**
 * Finalizes the current session upon action execution or completion,
 * and records last_completed_activity so subsequent follow-ups retain context.
 */
async function finalizeCurrentSession(senderPhone, summaryOverride = null, metadata = {}) {
  const envelope = await getSessionEnvelope(senderPhone);
  if (!envelope.current_session) return;

  const nowIso = new Date().toISOString();
  const curr = envelope.current_session;
  curr.ended_at = nowIso;

  const finalAction = metadata.action_type || metadata.action || curr.action_type || 'ACTIVITY';
  const finalCustomer = metadata.customer_name || metadata.customerName || curr.customer_name || null;
  const finalDealId = metadata.deal_id || metadata.dealId || curr.deal_id || null;
  const finalPoNumber = metadata.po_number || metadata.poNumber || curr.po_number || null;
  const finalInquiryId = metadata.inquiry_id || metadata.inquiryId || curr.inquiry_id || null;
  const finalSummary = summaryOverride || curr.summary || buildAutoSessionSummary(curr);

  curr.action_type = finalAction;
  curr.customer_name = finalCustomer;
  curr.deal_id = finalDealId;
  curr.po_number = finalPoNumber;
  curr.inquiry_id = finalInquiryId;
  curr.summary = finalSummary;

  // Record last completed activity for follow-up continuation detection
  envelope.last_completed_activity = {
    action_type: finalAction,
    customer_name: finalCustomer,
    deal_id: finalDealId,
    po_number: finalPoNumber,
    inquiry_id: finalInquiryId,
    summary: finalSummary,
    completed_at: nowIso,
    extracted_data: metadata.extracted_data || metadata.draft || null,
  };

  // Archive to saved_sessions
  if (!Array.isArray(envelope.saved_sessions)) {
    envelope.saved_sessions = [];
  }
  envelope.saved_sessions.push(curr);
  if (envelope.saved_sessions.length > MAX_SAVED_SESSIONS) {
    envelope.saved_sessions = envelope.saved_sessions.slice(-MAX_SAVED_SESSIONS);
  }

  // Reset current_session so next distinct flow creates a clean boundary
  envelope.current_session = null;

  await persistSessionEnvelope(senderPhone, envelope);
}

/**
 * Activity Continuation Classifier.
 * Checks whether an incoming message is a continuation/follow-up to the last completed activity.
 */
function isActivityContinuation(incomingText, lastActivity) {
  if (!incomingText || typeof incomingText !== 'string' || !lastActivity) {
    return false;
  }

  const text = incomingText.trim().toLowerCase();
  if (text.length === 0) return false;

  // Ignore activities completed more than 48 hours ago
  if (lastActivity.completed_at) {
    const elapsedMs = Date.now() - new Date(lastActivity.completed_at).getTime();
    if (elapsedMs > 48 * 60 * 60 * 1000) {
      return false;
    }
  }

  const actCustomer = lastActivity.customer_name ? normalizeCustomerKey(lastActivity.customer_name) : '';
  const actInquiryId = lastActivity.inquiry_id ? String(lastActivity.inquiry_id).toLowerCase().replace(/[^a-z0-9]/g, '') : '';
  const actDealId = lastActivity.deal_id ? String(lastActivity.deal_id).toLowerCase().replace(/[^a-z0-9]/g, '') : '';
  const actPoNumber = lastActivity.po_number ? String(lastActivity.po_number).toLowerCase().replace(/[^a-z0-9]/g, '') : '';

  // 1. Check if message references the EXACT SAME customer
  if (actCustomer && actCustomer.length >= 3) {
    const cleanWords = text.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/);
    const joinedText = text.replace(/[^a-z0-9]/g, '');
    if (joinedText.includes(actCustomer) || cleanWords.some(w => w.length >= 4 && actCustomer.includes(w))) {
      return true;
    }
  }

  // 2. Check if message references the SAME Deal ID, Inquiry ID, or PO Number
  if (actInquiryId && text.replace(/[^a-z0-9]/g, '').includes(actInquiryId)) {
    return true;
  }
  if (actDealId && text.replace(/[^a-z0-9]/g, '').includes(actDealId)) {
    return true;
  }
  if (actPoNumber && text.replace(/[^a-z0-9]/g, '').includes(actPoNumber)) {
    return true;
  }

  // 3. Check for explicit continuation phrases (e.g. "change the product name", "update rate to 54000", "add one more item")
  const isDirectContinuationEdit =
    /^(?:change|update|edit|modify|correct|actually|also|make it|set|add|remove|delete|cancel this|send quote|dispatch quote|mail quote|what is the id|inquiry id kya hai)\b/i.test(text) ||
    /\b(?:change\s+(?:the\s+)?(?:product|rate|price|tonnage|quantity|specs?|delivery|location|payment|date|po|status))\b/i.test(text) ||
    /\b(?:update\s+(?:the\s+)?(?:rate|price|quantity|tonnage|delivery|status|stage))\b/i.test(text) ||
    /\b(?:actually\s+(?:rate|price|quantity|delivery|product|it))\b/i.test(text) ||
    /\b(?:add\s+(?:one\s+more\s+item|item|another\s+product))\b/i.test(text) ||
    /^(?:rate\s*[:=]|price\s*[:=]|delivery\s*[:=]|location\s*[:=]|quantity\s*[:=]|tonnage\s*[:=])\s*[\w\d]+/i.test(text);

  // 4. Check for referential pronouns ("it", "that deal", "that inquiry", "this order", "for this customer")
  const isReferentialPronoun =
    /\b(?:that\s+deal|that\s+inquiry|that\s+order|this\s+order|this\s+deal|the\s+inquiry|the\s+order|the\s+deal|same\s+customer|same\s+deal|for\s+it|update\s+it|change\s+it|cancel\s+it)\b/i.test(text);

  if (isDirectContinuationEdit || isReferentialPronoun) {
    return true;
  }

  return false;
}

/**
 * Resolves the scoped session context for LLM execution:
 * - If continuation -> returns the last 15 rolling messages + last completed activity fact sheet.
 * - If unrelated/new activity -> returns an empty fresh session context.
 */
async function getScopedSessionContext(senderPhone, incomingText) {
  const envelope = await getSessionEnvelope(senderPhone);
  const isContinuation = isActivityContinuation(incomingText, envelope.last_completed_activity);

  if (isContinuation) {
    return {
      isContinuation: true,
      messages: (envelope.rolling_messages || []).slice(-MAX_ROLLING_MESSAGES),
      lastActivity: envelope.last_completed_activity,
      activeCustomer: envelope.last_completed_activity?.customer_name || null,
    };
  }

  // If ongoing active session in progress (e.g. multi-step form collection)
  if (envelope.current_session && Array.isArray(envelope.current_session.messages) && envelope.current_session.messages.length > 0) {
    return {
      isContinuation: false,
      messages: envelope.current_session.messages,
      lastActivity: null,
      activeCustomer: envelope.current_session.customer_name || null,
    };
  }

  // Brand new / unrelated activity -> Clean fresh session
  return {
    isContinuation: false,
    messages: [],
    lastActivity: null,
    activeCustomer: null,
  };
}

/**
 * Option 10 Intelligent Cross-Database Semantic & Keyword Retrieval Engine.
 * Replaces the rigid 7-session text dump by querying live database records matching the user's specific query.
 */
async function searchDatabaseForOption10(senderPhone, queryText) {
  if (!senderPhone || !queryText || typeof queryText !== 'string') {
    return '';
  }

  try {
    const scope = await getAccessibleSalespersonPhonesForBot(senderPhone);
    const textLower = queryText.toLowerCase().trim();
    const cleanWords = textLower
      .replace(/[^\w\s-]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 3 && !['what', 'when', 'where', 'which', 'show', 'list', 'tell', 'last', 'week', 'this', 'that', 'from', 'with', 'have', 'been', 'deal', 'inquiry', 'order', 'visit', 'complaint', 'rate', 'quoted'].includes(w));

    let customerFilter = null;
    let dealIdFilter = null;
    let poFilter = null;

    // Detect deal/inquiry ID
    const dealMatch = textLower.match(/#?(?:DEAL|INQ)-([a-f0-9]{4,8})/i);
    if (dealMatch) dealIdFilter = dealMatch[1].toUpperCase();

    // Detect PO number
    const poMatch = textLower.match(/\b(?:PO|P\.O\.)\s*[-#:]?\s*([A-Za-z0-9/-]{3,20})\b/i);
    if (poMatch) poFilter = poMatch[1];

    // Detect customer name candidates from database
    let matchedCustomers = [];
    if (cleanWords.length > 0) {
      const orClauses = cleanWords.map(w => `customer_name.ilike.%${w}%`).join(',');
      const { data: custRows } = await supabase
        .from('recurring_customers')
        .select('customer_name, customer_phone, contact_person, customer_address, tier')
        .or(orClauses)
        .limit(5);

      if (custRows && custRows.length > 0) {
        matchedCustomers = custRows;
        customerFilter = custRows[0].customer_name;
      }
    }

    const targetPhones = expandPhoneVariants(scope.phones || (senderPhone ? [senderPhone] : []));

    // 1. Query Deals & Inquiries (matching customer, ID, or recent dates)
    let dealsQuery = supabase
      .from('deals')
      .select('id, inquiry_id, customer_name, stage, total_amount, po_number, inquiry_type, created_at, updated_at, salesperson_phone, deal_items(sku_text, dimensions, quantity, unit, rate, amount)')
      .order('created_at', { ascending: false })
      .limit(10);

    if (!scope.isAdmin && targetPhones.length > 0) {
      dealsQuery = dealsQuery.in('salesperson_phone', targetPhones);
    }

    if (dealIdFilter) {
      dealsQuery = dealsQuery.or(`id.ilike.%${dealIdFilter}%,inquiry_id.ilike.%${dealIdFilter}%`);
    } else if (poFilter) {
      dealsQuery = dealsQuery.ilike('po_number', `%${poFilter}%`);
    } else if (customerFilter) {
      dealsQuery = dealsQuery.ilike('customer_name', `%${customerFilter}%`);
    } else if (/\b(?:last\s+week|past\s+7\s+days|this\s+week)\b/i.test(textLower)) {
      const past7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      dealsQuery = dealsQuery.gte('created_at', past7);
    }

    const { data: matchedDeals } = await dealsQuery;

    // 2. Query Complaints (if query asks about complaints or quality or resolution)
    let complaintsQuery = supabase
      .from('complaints')
      .select('id, customer_name, complaint_type, description, status, corrective_action, resolved_at, created_at, po_number, reported_by')
      .order('created_at', { ascending: false })
      .limit(5);

    if (!scope.isAdmin && targetPhones.length > 0) {
      complaintsQuery = complaintsQuery.in('reported_by', targetPhones);
    }

    if (customerFilter) complaintsQuery = complaintsQuery.ilike('customer_name', `%${customerFilter}%`);
    if (poFilter) complaintsQuery = complaintsQuery.ilike('po_number', `%${poFilter}%`);

    const { data: matchedComplaints } = await complaintsQuery;

    // 3. Query Site Visits (if query asks about visits or meetings)
    let visitsQuery = supabase
      .from('customer_visits')
      .select('visited_at, customer_name, person_met, customer_address, remarks, salesperson_phone')
      .order('visited_at', { ascending: false })
      .limit(5);

    if (!scope.isAdmin && targetPhones.length > 0) {
      visitsQuery = visitsQuery.in('salesperson_phone', targetPhones);
    }

    if (customerFilter) visitsQuery = visitsQuery.ilike('customer_name', `%${customerFilter}%`);

    const { data: matchedVisits } = await visitsQuery;

    // Format results into clean intelligence context
    let contextBlock = `\n\n## 🔍 RELEVANT DATABASE RECORDS & RETRIEVAL CONTEXT (Matched for Query: "${queryText}")\n`;

    if (matchedCustomers.length > 0) {
      contextBlock += `### Matched Customer Profiles:\n`;
      matchedCustomers.forEach(c => {
        contextBlock += `- ${c.customer_name} | Contact: ${c.contact_person || 'N/A'} (${c.customer_phone || 'N/A'}) | Location: ${c.customer_address || 'N/A'}\n`;
      });
      contextBlock += '\n';
    }

    if (matchedDeals && matchedDeals.length > 0) {
      contextBlock += `### Matched Inquiries & Orders:\n`;
      matchedDeals.forEach(d => {
        const hex = (d.id || d.inquiry_id || '').replace(/-/g, '').slice(0, 6).toUpperCase();
        const cleanCode = hex ? `INQ-${hex}` : 'INQ';
        const items = (d.deal_items || []).map(i => `${i.sku_text || 'Product'}${i.dimensions ? ` (${i.dimensions})` : ''} - ${i.quantity || 0} ${i.unit || 'MT'}${i.rate ? ` @ ₹${i.rate}/MT` : ''}`).join('; ');
        const dateStr = d.created_at ? d.created_at.slice(0, 10) : 'Recent';
        contextBlock += `- #${cleanCode} | Customer: ${d.customer_name} | Stage: ${d.stage} | Items: [${items || 'No line items'}] | Date: ${dateStr}${d.po_number ? ` | PO: ${d.po_number}` : ''}\n`;
      });
      contextBlock += '\n';
    }

    if (matchedComplaints && matchedComplaints.length > 0) {
      contextBlock += `### Matched Customer Complaints:\n`;
      matchedComplaints.forEach(c => {
        const shortId = (c.id || '').replace(/-/g, '').slice(0, 6).toUpperCase();
        contextBlock += `- Complaint #${shortId} | Customer: ${c.customer_name} | Status: ${c.status} | Type: ${c.complaint_type} | Issue: "${c.description || 'N/A'}"${c.resolved_at ? ` | Resolved: ${c.resolved_at.slice(0, 10)}` : ''}\n`;
      });
      contextBlock += '\n';
    }

    if (matchedVisits && matchedVisits.length > 0) {
      contextBlock += `### Matched Customer Visits:\n`;
      matchedVisits.forEach(v => {
        const dateStr = v.visited_at ? v.visited_at.slice(0, 10) : 'Recent';
        contextBlock += `- Visit (${dateStr}) | Customer: ${v.customer_name} | Met: ${v.person_met || 'N/A'} | Location: ${v.customer_address || 'N/A'} | Notes: "${v.remarks || 'N/A'}"\n`;
      });
      contextBlock += '\n';
    }

    // Include recent session highlights if relevant
    const envelope = await getSessionEnvelope(senderPhone);
    const recentSessions = (envelope.saved_sessions || []).slice(-5);
    if (recentSessions.length > 0) {
      const relevantSessions = recentSessions.filter(s => {
        const summary = (s.summary || '').toLowerCase();
        const cust = (s.customer_name || '').toLowerCase();
        return cleanWords.some(w => summary.includes(w) || cust.includes(w)) || (customerFilter && cust.includes(customerFilter.toLowerCase()));
      });

      if (relevantSessions.length > 0) {
        contextBlock += `### Relevant Past Sessions:\n`;
        relevantSessions.forEach(s => {
          contextBlock += `- [${s.action_type || 'Activity'}] ${s.customer_name || 'Customer'}: ${s.summary || 'Completed session'}\n`;
        });
        contextBlock += '\n';
      }
    }

    return contextBlock.trim();
  } catch (err) {
    console.error('[SessionManager] Error in searchDatabaseForOption10:', err.message);
    return '';
  }
}

/**
 * Resets the active session in memory and DB.
 */
async function clearActiveSession(senderPhone) {
  const envelope = await getSessionEnvelope(senderPhone);
  envelope.current_session = null;
  await persistSessionEnvelope(senderPhone, envelope);
}

module.exports = {
  startNewCatalogSession,
  recordSessionMessage,
  finalizeCurrentSession,
  getSessionEnvelope,
  getScopedSessionContext,
  isActivityContinuation,
  searchDatabaseForOption10,
  clearActiveSession,
  MAX_ROLLING_MESSAGES,
  MAX_SAVED_SESSIONS,
};

