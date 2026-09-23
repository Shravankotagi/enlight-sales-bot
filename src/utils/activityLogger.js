const { supabase } = require('../supabase');

const employeeCache = new Map();
let lastCacheFetch = 0;

/**
 * Resolve salesperson name from phone using employees table cache
 */
async function resolveSalespersonName(phone, fallbackName) {
  if (fallbackName && fallbackName !== 'Sales Team') return fallbackName;
  if (!phone) return fallbackName || 'Sales Team';

  const cleanP = String(phone).replace(/\D/g, '');
  const last10 = cleanP.slice(-10);

  const now = Date.now();
  if (employeeCache.size === 0 || now - lastCacheFetch > 60000) {
    try {
      const { data } = await supabase.from('employees').select('name, phone');
      if (data && Array.isArray(data)) {
        employeeCache.clear();
        for (const emp of data) {
          if (emp.phone && emp.name) {
            const clean = String(emp.phone).replace(/\D/g, '');
            employeeCache.set(clean, emp.name);
            employeeCache.set(clean.slice(-10), emp.name);
          }
        }
        lastCacheFetch = now;
      }
    } catch (e) {
      // Ignore cache fetch error
    }
  }

  const found = employeeCache.get(cleanP) || employeeCache.get(last10);
  return found || fallbackName || 'Sales Team';
}

/**
 * Log an activity event to activity_logs table in a non-blocking, fire-and-forget manner.
 */
function logBotActivity({
  salesperson_name,
  salesperson_phone,
  description,
  module,
  customer_name,
  action_type = 'activity',
  entity_id = null,
  entity_type = null,
  change_detail = {},
  source = 'bot',
}) {
  try {
    // Normalize module name (TitleCase: Inquiries, Orders, Visits, Complaints, Customers)
    let normalizedModule = module || 'General';
    const lowerMod = String(normalizedModule).toLowerCase();
    if (lowerMod.includes('inquir')) normalizedModule = 'Inquiries';
    else if (lowerMod.includes('order') || lowerMod.includes('deal')) normalizedModule = 'Orders';
    else if (lowerMod.includes('visit')) normalizedModule = 'Visits';
    else if (lowerMod.includes('complaint')) normalizedModule = 'Complaints';
    else if (lowerMod.includes('customer')) normalizedModule = 'Customers';

    const cleanPhone = salesperson_phone ? String(salesperson_phone).replace(/\D/g, '') : null;

    // Fire and forget async resolution & insert
    Promise.resolve().then(async () => {
      try {
        const resolvedName = await resolveSalespersonName(cleanPhone, salesperson_name);

        const payload = {
          timestamp: new Date().toISOString(),
          salesperson_name: resolvedName,
          salesperson_phone: cleanPhone,
          actor_phone: cleanPhone,
          actor_name: resolvedName,
          description,
          module: normalizedModule,
          customer_name: customer_name || null,
          source: source || 'bot',
          action_type: action_type || 'activity',
          entity_id: entity_id ? String(entity_id) : null,
          entity_type: entity_type ? String(entity_type) : null,
          change_detail: change_detail || {},
        };

        const { error } = await supabase.from('activity_logs').insert(payload);
        if (error) {
          console.warn('[ActivityLogger] Non-blocking activity log warning:', error.message);
        }
      } catch (innerErr) {
        console.warn('[ActivityLogger] Non-blocking activity log insert error:', innerErr?.message);
      }
    }).catch((err) => {
      console.warn('[ActivityLogger] Non-blocking activity log task error:', err?.message);
    });
  } catch (err) {
    console.warn('[ActivityLogger] Non-blocking activity log exception:', err?.message);
  }
}

module.exports = { logBotActivity };
