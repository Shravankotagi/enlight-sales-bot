/**
 * sessionManager.js - Permanent Session Management Engine for WhatsApp Bot
 *
 * Session Lifecycle:
 * - Every time the bot presents the catalog menu to the user -> a new session is created and started.
 * - Session boundary: catalog presented -> catalog presented again. Everything between belongs to one session.
 * - Each session is saved completely: all messages, selections, context, and data exchanged.
 *
 * Session Storage & Retention:
 * - Sessions are saved sequentially and indexed (1, 2, 3...).
 * - Maximum of last 7 sessions are retained per salesperson.
 * - Sessions older than the last 7 are dropped.
 *
 * LLM Context Injection:
 * - Options 1-8: Handled with current session context only (zero historical sessions passed).
 * - Option 9 (Other / General Query): The only trigger where the last 7 saved sessions are retrieved and passed to the LLM.
 */

const { supabase } = require('../supabase');

// Fast in-memory cache: phoneKey -> { current_session, saved_sessions }
const sessionCache = new Map();

const MAX_SAVED_SESSIONS = 7;

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

/**
 * Normalizes legacy chat_history or existing session envelopes into a valid envelope.
 */
function normalizeSessionEnvelope(raw) {
  if (!raw) {
    return {
      current_session: null,
      saved_sessions: [],
    };
  }

  // If already structured envelope
  if (typeof raw === 'object' && !Array.isArray(raw) && (raw.current_session !== undefined || raw.saved_sessions !== undefined)) {
    const saved = Array.isArray(raw.saved_sessions) ? raw.saved_sessions.slice(-MAX_SAVED_SESSIONS) : [];
    return {
      current_session: raw.current_session || null,
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

    return {
      current_session: null,
      saved_sessions: [legacySession],
    };
  }

  return {
    current_session: null,
    saved_sessions: [],
  };
}

/**
 * Loads the session envelope from in-memory cache or Supabase conversation_sessions.
 */
async function getSessionEnvelope(senderPhone) {
  if (!senderPhone) {
    return { current_session: null, saved_sessions: [] };
  }
  const pKey = getCanonicalPhoneKey(senderPhone);
  if (!pKey) {
    return { current_session: null, saved_sessions: [] };
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

  const fresh = { current_session: null, saved_sessions: [] };
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

  // Enforce 7-session retention cap
  if (Array.isArray(envelope.saved_sessions) && envelope.saved_sessions.length > MAX_SAVED_SESSIONS) {
    envelope.saved_sessions = envelope.saved_sessions.slice(-MAX_SAVED_SESSIONS);
  }

  sessionCache.set(pKey, envelope);

  try {
    const variants = getCanonicalPhoneVariants(senderPhone);
    const primaryPhone = `91${pKey}`;

    const activeCust = envelope.current_session?.customer_name || null;
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
 * Finalizes any active ongoing session and pushes it to saved_sessions (max 7).
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
 * Records a message (human input or bot reply) in the current active session.
 */
async function recordSessionMessage(senderPhone, role, content, metadata = {}) {
  if (!senderPhone || !content) return;
  const envelope = await getSessionEnvelope(senderPhone);
  const nowIso = new Date().toISOString();

  if (!envelope.current_session) {
    await startNewCatalogSession(senderPhone);
  }

  const cleanRole = role === 'human' || role === 'user' ? 'user' : 'assistant';
  const msgObj = {
    role: cleanRole,
    content: typeof content === 'string' ? content : JSON.stringify(content),
    timestamp: nowIso,
    agent: metadata.agent || (cleanRole === 'user' ? 'salesperson' : 'bot'),
    customer_name: metadata.customer_name || metadata.customerName || null,
    deal_id: metadata.deal_id || metadata.dealId || null,
  };

  envelope.current_session.messages.push(msgObj);

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
 * Finalizes the current session upon action execution or completion.
 */
async function finalizeCurrentSession(senderPhone, summaryOverride = null, metadata = {}) {
  const envelope = await getSessionEnvelope(senderPhone);
  if (!envelope.current_session) return;

  const nowIso = new Date().toISOString();
  const curr = envelope.current_session;
  curr.ended_at = nowIso;

  if (metadata.action_type || metadata.action) curr.action_type = metadata.action_type || metadata.action;
  if (metadata.customer_name || metadata.customerName) curr.customer_name = metadata.customer_name || metadata.customerName;
  if (metadata.deal_id || metadata.dealId) curr.deal_id = metadata.deal_id || metadata.dealId;
  if (metadata.po_number || metadata.poNumber) curr.po_number = metadata.po_number || metadata.poNumber;
  if (metadata.inquiry_id || metadata.inquiryId) curr.inquiry_id = metadata.inquiry_id || metadata.inquiryId;

  curr.summary = summaryOverride || buildAutoSessionSummary(curr);

  // Push to saved_sessions and enforce 7-session cap
  envelope.saved_sessions.push(curr);
  if (envelope.saved_sessions.length > MAX_SAVED_SESSIONS) {
    envelope.saved_sessions = envelope.saved_sessions.slice(-MAX_SAVED_SESSIONS);
  }

  // Reset current_session so next action or menu start creates a clean boundary
  envelope.current_session = null;

  await persistSessionEnvelope(senderPhone, envelope);
}

/**
 * Retrieves the last 7 saved sessions for a salesperson.
 */
async function getHistoricalSessions(senderPhone) {
  const envelope = await getSessionEnvelope(senderPhone);
  return (envelope.saved_sessions || []).slice(-MAX_SAVED_SESSIONS);
}

/**
 * Returns raw messages for the current active session only (used for Tier 1 memory).
 */
async function getCurrentSessionMessages(senderPhone) {
  const envelope = await getSessionEnvelope(senderPhone);
  if (!envelope.current_session || !Array.isArray(envelope.current_session.messages)) {
    return [];
  }
  return envelope.current_session.messages;
}

/**
 * Formats the last 7 sessions into a clean, rich context block for Option 9 (Other / General Query).
 * STRICTLY ONLY INJECTED ON OPTION 9.
 */
async function formatHistoricalSessionsForLLM(senderPhone) {
  const sessions = await getHistoricalSessions(senderPhone);
  if (!sessions || sessions.length === 0) {
    return '';
  }

  let text = `\n\n## RECENT CONVERSATION SESSIONS (Last ${sessions.length} Sessions History - Option 9 Reference Only)\n`;
  text += `The user previously conducted the following recent sessions before opening Option 9 (Other / General Query). Use this context to answer follow-ups, summarize recent activities, or clarify references without asking the user to repeat themselves:\n\n`;

  sessions.forEach((s, idx) => {
    const num = idx + 1;
    const startTime = s.started_at ? new Date(s.started_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'short', timeStyle: 'short' }) : 'Recent';
    const action = s.action_type || 'Sales Activity';
    const customer = s.customer_name ? ` | Customer: ${s.customer_name}` : '';
    const ref = s.po_number ? ` | PO: ${s.po_number}` : (s.inquiry_id ? ` | Ref: ${s.inquiry_id}` : (s.deal_id ? ` | Deal: ${s.deal_id}` : ''));
    const summary = s.summary ? `\n  - Outcome: ${s.summary}` : '';

    // Extract user discussion highlights
    const userNotes = (s.messages || [])
      .filter(m => m.role === 'user' && m.content && !/^(?:yes|y|no|1|2|3|confirm|edit|cancel)$/i.test(m.content.trim()))
      .map(m => m.content.trim().replace(/\n+/g, ' '))
      .slice(0, 3);
    const notesStr = userNotes.length > 0 ? `\n  - Discussion: "${userNotes.join('; ')}"` : '';

    text += `### Session #${num} (${startTime}) - [${action}]${customer}${ref}${summary}${notesStr}\n\n`;
  });

  return text.trim();
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
  getHistoricalSessions,
  getCurrentSessionMessages,
  formatHistoricalSessionsForLLM,
  getSessionEnvelope,
  clearActiveSession,
  MAX_SAVED_SESSIONS,
};
