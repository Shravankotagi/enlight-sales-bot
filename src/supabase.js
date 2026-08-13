const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  console.warn("WARNING: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing in environment variables.");
}

// Initialize Supabase client
const supabase = createClient(supabaseUrl || 'https://placeholder.supabase.co', supabaseServiceRoleKey || 'placeholder');

/**
 * Safely parses any value (string, number, formatting) into a numeric float or null.
 * Prevents database crashes when LLM outputs currency symbols, commas, or text.
 */
function sanitizeNumber(val) {
  if (val === undefined || val === null) return null;
  if (typeof val === 'number') {
    return isNaN(val) ? null : val;
  }
  const cleanStr = String(val)
    .replace(/[₹$,]/g, '') // remove currency symbols and commas
    .replace(/[^\d.-]/g, '') // strip any remaining non-numeric characters (except decimals and minus)
    .trim();
  const parsed = parseFloat(cleanStr);
  return isNaN(parsed) ? null : parsed;
}

/**
 * Looks up an employee record by their phone number.
 * @param {string} phone - The sender phone number (e.g. '919876543210')
 * @returns {{ employee_id, name, role } | null}
 */
async function getEmployeeByPhone(phone) {
  try {
    if (!phone) return null;
    const { data, error } = await supabase
      .from('employees')
      .select('employee_id, name, role')
      .eq('phone', phone)
      .eq('is_active', true)
      .single();
    if (error || !data) return null;
    return data;
  } catch (err) {
    console.warn('getEmployeeByPhone error:', err.message);
    return null;
  }
}

/**
 * Saves a raw inquiry to the Supabase inquiries table.
 * @param {Object} data - The inquiry data to save.
 */
async function saveInquiry(data) {
  try {
    const payload = {
      source_channel: data.source_channel || "whatsapp",
      raw_text: data.raw_text,
      media_urls: data.media_urls || [],
      voice_url: data.voice_url || null,
      sender_phone: data.sender_phone || data.salesperson_phone,
      sender_name: data.sender_name || null,
      whatsapp_message_id: data.message_id || null,
      status: data.status || "processed",
      created_at: new Date().toISOString(),
      salesperson_phone: data.salesperson_phone || data.sender_phone || null,
      employee_id: data.employee_id || null,
      inquiry_type: data.inquiry_type || null,
      ai_extraction_json: data.ai_extraction_json || null,
      overall_confidence: data.overall_confidence != null
        ? Number(data.overall_confidence)
        : (data.confidence != null ? Number(data.confidence) : 0.92),
    };

    const { data: savedRow, error } = await supabase
      .from('inquiries')
      .insert([payload])
      .select()
      .single();

    if (error) {
      throw error;
    }

    console.log('Successfully saved inquiry to Supabase:', savedRow.id);
    return savedRow;
  } catch (error) {
    console.error("Error in saveInquiry:", error.message || error);
    return null;
  }
}

/**
 * Retrieves all rows from the inquiries table.
 */
async function getInquiries() {
  try {
    const { data: inquiries, error } = await supabase
      .from('inquiries')
      .select('*');

    if (error) {
      throw error;
    }

    return inquiries;
  } catch (error) {
    console.error("Error in getInquiries:", error.message || error);
    throw error;
  }
}

async function saveDeal(inquiryId, extraction, senderPhone, employeeId) {
  try {
    const poDate = extraction.po_date || new Date().toISOString().split('T')[0];
    let poNumber = extraction.po_number || null;
    if (!poNumber && (extraction.inquiry_type === 'purchase_order' || extraction.stage === 'won')) {
      const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const randomNum = Math.floor(1000 + Math.random() * 9000);
      poNumber = `PO-${todayStr}-${randomNum}`;
    }

    // Save deal
    const { data: deal, error: dealError } = await supabase
      .from('deals')
      .insert({
        inquiry_id: inquiryId,
        stage: 'new_inquiry',
        po_number: poNumber,
        po_date: poDate,
        customer_name: extraction.customer?.name || null,
        customer_phone: extraction.customer?.phone || null,
        customer_gst: extraction.customer?.gst || null,
        customer_address: extraction.customer?.address || null,
        delivery_location: extraction.delivery_location || null,
        delivery_date: extraction.delivery_date || null,
        payment_terms: extraction.payment_terms || null,
        total_amount: sanitizeNumber(extraction.total_amount),
        inquiry_type: extraction.inquiry_type || 'unknown',
        overall_confidence: extraction.overall_confidence || 0,
        status: extraction.overall_confidence >= 0.85 ? 'auto_created' : 'needs_review',
        created_at: new Date().toISOString(),
        salesperson_phone: senderPhone || null,
        employee_id: employeeId || null,
      })
      .select()
      .single();

    if (dealError) {
      console.error('Error saving deal:', dealError);
      return null;
    }

    // Save line items
    if (extraction.line_items && extraction.line_items.length > 0) {
      console.log('DEBUG line_items:', JSON.stringify(extraction.line_items, null, 2));
      console.log('DEBUG deal_id:', deal.id);
      const lineItems = extraction.line_items.map(item => ({
        deal_id: deal.id,
        sku_text: item.sku_text || null,
        grade: item.grade || null,
        dimensions: item.dimensions || null,
        quantity: sanitizeNumber(item.quantity),
        unit: item.unit || null,
        rate: sanitizeNumber(item.rate),
        amount: sanitizeNumber(item.amount),
        confidence: item.confidence || 0,
        created_at: new Date().toISOString()
      }));

      const { error: itemsError } = await supabase
        .from('deal_items')
        .insert(lineItems);

      if (itemsError) {
        console.error('Error saving deal items:', itemsError);
      }
    }

    console.log('Deal saved successfully:', deal.id);
    return deal;
  } catch (error) {
    console.error('saveDeal error:', error);
    return null;
  }
}

async function ensureCustomerRecord(customerName, senderPhone, extraData = {}) {
  if (!customerName || !senderPhone) return null;
  const cleanName = customerName.trim();

  // 1. Check exact/case-insensitive match for this salesperson
  const { data: existing } = await supabase
    .from('recurring_customers')
    .select('*')
    .ilike('customer_name', cleanName)
    .eq('assigned_salesperson_phone', senderPhone)
    .limit(1);

  if (existing && existing.length > 0) {
    const rec = existing[0];
    const updatePayload = {};
    if (extraData.customer_phone && !rec.customer_phone) updatePayload.customer_phone = extraData.customer_phone;
    if (extraData.customer_gst && !rec.customer_gst) updatePayload.customer_gst = extraData.customer_gst;
    if (extraData.city && !rec.customer_address) updatePayload.customer_address = extraData.city;
    if (extraData.contact_person && !rec.contact_person) updatePayload.contact_person = extraData.contact_person;

    if (Object.keys(updatePayload).length > 0) {
      await supabase
        .from('recurring_customers')
        .update({ ...updatePayload, updated_at: new Date().toISOString() })
        .eq('id', rec.id);
    }
    return rec;
  }

  // 2. Insert new record with fallback for race conditions
  try {
    const { data: newCustomer } = await supabase
      .from('recurring_customers')
      .insert({
        customer_name: cleanName,
        assigned_salesperson_phone: senderPhone,
        customer_phone: extraData.customer_phone || null,
        customer_gst: extraData.customer_gst || null,
        customer_address: extraData.city || null,
        contact_person: extraData.contact_person || null,
        is_active: true,
        avg_order_frequency_days: 30,
      })
      .select()
      .single();
    return newCustomer;
  } catch (err) {
    const { data: fallback } = await supabase
      .from('recurring_customers')
      .select('*')
      .ilike('customer_name', cleanName)
      .limit(1);
    return fallback ? fallback[0] : null;
  }
}

async function checkAndLogNewCustomer(deal, senderPhone) {
  try {
    if (deal && deal.customer_name && senderPhone) {
      const customerName = deal.customer_name.trim();

      await ensureCustomerRecord(customerName, senderPhone, {
        customer_phone: deal.customer_phone || null,
        city: deal.delivery_location || null,
      });

      const { isNewCustomer, logNewCustomer } = require('./kra2');
      if (deal.inquiry_type === 'purchase_order' || deal.stage === 'won') {
        const newCustomer = await isNewCustomer(customerName, senderPhone);
        if (newCustomer) {
          console.log('New customer KRA 2 logged:', customerName);
          await logNewCustomer(deal, senderPhone);
        }
      }
    }
  } catch (error) {
    console.error('checkAndLogNewCustomer error:', error.message);
  }
}

/**
 * Uses Google Gemini to fuzzy match a customer name from a list of customer names.
 * Useful for handling salesperson typos, Hinglish, or shorthand customer names.
 * @param {string} text - The raw input text containing the customer name.
 * @param {string[]} customerList - The list of active customer names to match against.
 * @returns {Promise<string|null>} The matched customer name, or null if no match.
 */
async function fuzzyMatchCustomer(text, customerList) {
  if (!customerList || customerList.length === 0) return null;
  
  try {
    const { invokeWithFallback } = require('./core/modelRouter');
    const { HumanMessage } = require('@langchain/core/messages');

    const prompt = `
Given a user message and a list of customer names, identify which customer from the list the message is referring to.
The user might have spelling mistakes, typos, or written in Hinglish/mix languages (e.g. "Mehta steel" matches "Mehta Steel Limited", "Delta structural" matches "Delta Structural Steel").

List of customer names:
${customerList.map((c, i) => `${i + 1}. "${c}"`).join('\n')}

Message: "${text}"

Rules:
- If there is a high-confidence match from the list, return ONLY the index of the matched customer (1-based index).
- If there is absolutely no match or the message is about a different customer, return ONLY "0".
- Return ONLY the number (e.g. "1" or "0"), do not include any other text, markdown, or explanation.
`;

    const response = await invokeWithFallback([new HumanMessage(prompt)]);
    const textRes = (typeof response.content === 'string' ? response.content : JSON.stringify(response.content)).trim();
    const matchIndex = parseInt(textRes);
    
    if (!isNaN(matchIndex) && matchIndex > 0 && matchIndex <= customerList.length) {
      return customerList[matchIndex - 1];
    }
  } catch (err) {
    console.error('fuzzyMatchCustomer error:', err.message);
  }
  return null;
}

/**
 * Verifies if a customer is registered in the salesperson's account.
 * Handles exact matching and fuzzy matching (typos/Hinglish).
 * Returns the matched official name or null if not found.
 */
async function verifyAndGetCustomerName(customerName, senderPhone) {
  if (!customerName || !senderPhone) return null;
  
  try {
    const { data: customerRows } = await supabase
      .from('recurring_customers')
      .select('customer_name')
      .eq('assigned_salesperson_phone', senderPhone)
      .eq('is_active', true);

    if (!customerRows || customerRows.length === 0) return null;

    const customerList = customerRows.map(c => c.customer_name);

    // 1. Exact match (case insensitive, trimmed)
    const cleanInput = customerName.toLowerCase().trim();
    const exactMatch = customerList.find(c => c.toLowerCase().trim() === cleanInput);
    if (exactMatch) return exactMatch;

    // 2. Fuzzy match using Gemini
    const fuzzyMatch = await fuzzyMatchCustomer(customerName, customerList);
    if (fuzzyMatch) return fuzzyMatch;

  } catch (err) {
    console.error('verifyAndGetCustomerName error:', err.message);
  }
  return null;
}

/**
 * Checks if the customer has any missing fields (phone, gst, address, contact_person)
 * in recurring_customers. If yes, returns a friendly prompt for the salesperson.
 */
async function getCustomerMissingInfoPrompt(customerName, senderPhone) {
  try {
    const { data } = await supabase
      .from('recurring_customers')
      .select('customer_phone, customer_gst, customer_address, contact_person')
      .ilike('customer_name', `%${customerName}%`)
      .limit(1);

    if (!data || data.length === 0) return '';

    const customer = data[0];
    const missing = [];
    if (!customer.customer_phone)   missing.push('• 📱 *Mobile Number*');
    if (!customer.contact_person)   missing.push('• 👤 *Contact Person / Owner*');
    if (!customer.customer_address)  missing.push('• 📍 *City / Location*');
    if (!customer.customer_gst)      missing.push('• 🧾 *GSTIN* (optional)');

    if (missing.length > 0) {
      return `\n\n📌 *Missing profile details for ${customerName}:*\n` +
        missing.join('\n') +
        `\n\n_(You can update these details anytime by simply replying in your own words, e.g. "Supreme Steel phone is 9876543210 owner Mr. Kapoor" or "Supreme location is Nashik")_`;
    }
  } catch (err) {
    console.error('getCustomerMissingInfoPrompt error:', err.message);
  }
  return '';
}

/**
 * Saves or updates the active customer context session for a salesperson.
 */
async function saveActiveSession(salespersonPhone, customerName, intent = 'general') {
  if (!salespersonPhone || !customerName) return;
  try {
    const { error } = await supabase
      .from('conversation_sessions')
      .upsert({
        salesperson_phone: salespersonPhone,
        active_customer_name: customerName,
        last_intent: intent,
        updated_at: new Date().toISOString()
      });
    if (error) console.error('saveActiveSession error:', error.message);
  } catch (err) {
    console.error('saveActiveSession catch:', err.message);
  }
}

function getStartOfTodayISO() {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  return startOfToday.toISOString();
}

/**
 * Retrieves the active customer context for a salesperson (persists for the day, resets at 12:00 AM midnight).
 */
async function getActiveSession(salespersonPhone) {
  if (!salespersonPhone) return null;
  try {
    const startOfToday = getStartOfTodayISO();
    const { data, error } = await supabase
      .from('conversation_sessions')
      .select('active_customer_name')
      .eq('salesperson_phone', salespersonPhone)
      .gte('updated_at', startOfToday)
      .limit(1);

    if (error) {
      console.error('getActiveSession error:', error.message);
      return null;
    }
    if (data && data.length > 0) {
      return data[0].active_customer_name;
    }
  } catch (err) {
    console.error('getActiveSession catch:', err.message);
  }
  return null;
}

/**
 * Retrieves the full active session object for a salesperson (persists for the day, resets at 12:00 AM midnight).
 */
async function getFullActiveSession(salespersonPhone) {
  if (!salespersonPhone) return null;
  try {
    const startOfToday = getStartOfTodayISO();
    const { data, error } = await supabase
      .from('conversation_sessions')
      .select('*')
      .eq('salesperson_phone', salespersonPhone)
      .gte('updated_at', startOfToday)
      .limit(1);

    if (error) {
      console.error('getFullActiveSession error:', error.message);
      return null;
    }
    if (data && data.length > 0) {
      return data[0];
    }
  } catch (err) {
    console.error('getFullActiveSession catch:', err.message);
  }
  return null;
}

// Export default and named exports
module.exports = { 
  supabase, 
  saveInquiry, 
  getInquiries, 
  saveDeal, 
  getEmployeeByPhone, 
  ensureCustomerRecord,
  checkAndLogNewCustomer,
  fuzzyMatchCustomer,
  verifyAndGetCustomerName,
  getCustomerMissingInfoPrompt,
  saveActiveSession,
  getActiveSession,
  getFullActiveSession
};
