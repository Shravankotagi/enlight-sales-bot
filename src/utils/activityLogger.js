const { supabase } = require('../supabase');

/**
 * Log an activity event to activity_logs table in a non-blocking, fire-and-forget manner.
 */
function logBotActivity({ salesperson_name, salesperson_phone, description, module, customer_name }) {
  try {
    const payload = {
      timestamp: new Date().toISOString(),
      salesperson_name: salesperson_name || 'Sales Team',
      salesperson_phone: salesperson_phone || null,
      description,
      module,
      customer_name: customer_name || null,
      source: 'bot',
      action_type: 'activity',
    };

    Promise.resolve(
      supabase.from('activity_logs').insert(payload)
    )
      .then(({ error }) => {
        if (error) console.warn('Non-blocking bot activity log warning:', error.message);
      })
      .catch((err) => {
        console.warn('Non-blocking bot activity log error:', err?.message);
      });
  } catch (err) {
    console.warn('Non-blocking bot activity log exception:', err?.message);
  }
}

module.exports = { logBotActivity };
