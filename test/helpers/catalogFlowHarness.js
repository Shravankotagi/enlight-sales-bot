const { createSupabaseMock } = require('./supabaseMock');
const { loadWithMocks } = require('./loadWithMocks');

// Creating the real client performs no I/O; only its pure helpers are used.
const realSupabase = require('../../src/supabase');

/**
 * Loads `core/catalogFlow` with Supabase, session storage, the LLM router and
 * activity logging replaced by in-memory fakes.
 *
 * Options:
 *   tables      seed rows for the fake Supabase client
 *   employees   { [phone10]: { name, role } } returned by getEmployeeByPhone
 *   scope       result of getAccessibleSalespersonPhonesForBot
 *   llm         (messages) => string; defaults to throwing so unexpected
 *               model calls fail the test
 */
function loadCatalogFlow({ tables = {}, employees = {}, scope, llm, envelope } = {}) {
  const db = createSupabaseMock({ tables });
  const sessions = new Map();
  const events = [];
  const last10 = (phone) => String(phone || '').replace(/\D/g, '').slice(-10);

  const supabaseExports = {
    supabase: db.client,
    async getFullActiveSession(phone) {
      return sessions.get(last10(phone)) || null;
    },
    async getActiveSession(phone) {
      return sessions.get(last10(phone)) || null;
    },
    async saveActiveSession(phone, customerName, lastIntent) {
      sessions.set(last10(phone), { customer_name: customerName, last_intent: lastIntent });
      events.push({ type: 'saveActiveSession', customerName, lastIntent });
    },
    async getEmployeeByPhone(phone) {
      return employees[last10(phone)] || null;
    },
    async getAccessibleSalespersonPhonesForBot(phone) {
      return scope || { isAdmin: false, isManager: false, phones: [last10(phone)] };
    },
    async ensureCustomerRecord() { return null; },
    async verifyAndGetCustomerName(name) { return { isValid: false, name }; },
    async getAssignedCustomersList() { return []; },
    // Pure helpers keep their production behavior.
    normalizeCoreCompanyName: realSupabase.normalizeCoreCompanyName,
    expandPhoneVariants: realSupabase.expandPhoneVariants,
    isPhoneInScope: realSupabase.isPhoneInScope,
    normalizePhone: realSupabase.normalizePhone,
    getPhoneVariants: realSupabase.getPhoneVariants,
  };

  const sessionManagerExports = {
    async startNewCatalogSession(phone, reply) { events.push({ type: 'startNewCatalogSession', reply }); },
    async recordSessionMessage(phone, role, text, meta) { events.push({ type: 'message', role, text, meta }); },
    async finalizeCurrentSession(phone, summary) { events.push({ type: 'finalizeCurrentSession', summary }); },
    async getSessionEnvelope(phone) {
      if (typeof envelope === 'function') return envelope(phone);
      return envelope || null;
    },
    async getScopedSessionContext() { return null; },
    async clearActiveSession(phone) { sessions.delete(last10(phone)); },
  };

  const modelRouterExports = {
    getModel() { throw new Error('LLM access is not mocked for this test'); },
    getPaidHighAccuracyModel() { throw new Error('LLM access is not mocked for this test'); },
    getLightweightModel() { throw new Error('LLM access is not mocked for this test'); },
    async invokeWithFallback(messages) {
      if (!llm) throw new Error('Unexpected LLM call in test');
      return { content: llm(messages) };
    },
  };

  const { mod, restore } = loadWithMocks('core/catalogFlow', {
    supabase: supabaseExports,
    'core/sessionManager': sessionManagerExports,
    'core/modelRouter': modelRouterExports,
    'utils/activityLogger': { async logBotActivity() {} },
  });

  return {
    catalogFlow: mod,
    db,
    sessions,
    events,
    setSession(phone, lastIntent, customerName = 'Customer') {
      sessions.set(last10(phone), { customer_name: customerName, last_intent: lastIntent });
    },
    getSession(phone) {
      return sessions.get(last10(phone)) || null;
    },
    restore,
  };
}

module.exports = { loadCatalogFlow };
