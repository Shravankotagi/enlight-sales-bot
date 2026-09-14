const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  console.warn(
    'WARNING: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing in environment variables.',
  );
}

// Initialize Supabase client
const supabase = createClient(
  supabaseUrl || 'https://placeholder.supabase.co',
  supabaseServiceRoleKey || 'placeholder',
);

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

function normalizePhone(phone) {
  if (!phone) return '';
  return String(phone).replace(/\D/g, '').slice(-10);
}

/**
 * Looks up an employee record by their phone number.
 * @param {string} phone - The sender phone number (e.g. '919876543210')
 * @returns {{ id, employee_id, name, role, phone, manager_id, manager_phone } | null}
 */
async function getEmployeeByPhone(phone) {
  try {
    if (!phone) return null;
    const clean = String(phone).replace(/\D/g, '');
    const last10 = clean.slice(-10);
    const variants = Array.from(
      new Set([phone, clean, last10, `91${last10}`, `+91${last10}`]),
    );

    const { data, error } = await supabase
      .from('employees')
      .select('*')
      .in('phone', variants)
      .eq('is_active', true)
      .limit(1);

    if (error || !data || data.length === 0) return null;
    return data[0];
  } catch (err) {
    console.warn('getEmployeeByPhone error:', err.message);
    return null;
  }
}

/**
 * Resolves role-based access control phones list for a bot user:
 * - Admin: role = 'admin', phones = null (unrestricted, all data)
 * - Sales Manager: role = 'sales_manager', phones = [assigned_reps_phones] (empty array if 0 reps)
 * - Salesperson: role = 'salesperson', phones = [senderPhone]
 */
async function getAccessibleSalespersonPhonesForBot(senderPhone) {
  const employee = await getEmployeeByPhone(senderPhone);
  if (!employee) {
    return {
      role: 'salesperson',
      phones: [senderPhone],
      employee: null,
      isManager: false,
      isAdmin: false,
      assignedSalespersons: [],
    };
  }

  const role = (employee.role || 'salesperson').toLowerCase();
  const isAdmin = role.includes('admin');
  const isManager = role.includes('manager') || role === 'sales_manager';

  if (isAdmin) {
    return {
      role: 'admin',
      phones: null,
      employee,
      isManager: false,
      isAdmin: true,
      assignedSalespersons: [],
    };
  }

  if (isManager) {
    const { data: allActive } = await supabase
      .from('employees')
      .select('*')
      .eq('is_active', true);

    const normPhone = normalizePhone(senderPhone);
    const assigned = (allActive || []).filter((emp) => {
      const empRole = (emp.role || '').toLowerCase();
      if (empRole.includes('admin') || empRole.includes('manager'))
        return false;
      if (emp.manager_id && emp.manager_id === employee.id) return true;
      if (emp.manager_phone && normalizePhone(emp.manager_phone) === normPhone)
        return true;
      return false;
    });

    const teamPhones = Array.from(
      new Set(
        [employee.phone || senderPhone, ...assigned.map((a) => a.phone)].filter(
          Boolean,
        ),
      ),
    );
    return {
      role: 'sales_manager',
      phones: teamPhones,
      employee,
      isManager: true,
      isAdmin: false,
      assignedSalespersons: assigned,
    };
  }

  // Default Salesperson
  return {
    role: 'salesperson',
    phones: [employee.phone || senderPhone],
    employee,
    isManager: false,
    isAdmin: false,
    assignedSalespersons: [],
  };
}

/**
 * Saves a raw inquiry to the Supabase inquiries table.
 * @param {Object} data - The inquiry data to save.
 */
async function saveInquiry(data) {
  try {
    const payload = {
      source_channel: data.source_channel || 'whatsapp',
      raw_text: data.raw_text,
      media_urls: data.media_urls || [],
      voice_url: data.voice_url || null,
      sender_phone: data.sender_phone || data.salesperson_phone,
      sender_name: data.sender_name || null,
      whatsapp_message_id: data.message_id || null,
      status: data.status || 'processed',
      created_at: new Date().toISOString(),
      salesperson_phone: data.salesperson_phone || data.sender_phone || null,
      employee_id: data.employee_id || null,
      inquiry_type: data.inquiry_type || null,
      ai_extraction_json: data.ai_extraction_json || null,
      overall_confidence:
        data.overall_confidence != null
          ? Number(data.overall_confidence)
          : data.confidence != null
            ? Number(data.confidence)
            : 0.92,
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
    console.error('Error in saveInquiry:', error.message || error);
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
    console.error('Error in getInquiries:', error.message || error);
    throw error;
  }
}

async function saveDeal(inquiryId, extraction, senderPhone, employeeId) {
  try {
    const poDate = extraction.po_date || null;
    let poNumber = extraction.po_number || null;
    if (
      !poNumber &&
      (extraction.inquiry_type === 'purchase_order' ||
        extraction.stage === 'won')
    ) {
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
        status:
          extraction.overall_confidence >= 0.85
            ? 'auto_created'
            : 'needs_review',
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
      console.log(
        'DEBUG line_items:',
        JSON.stringify(extraction.line_items, null, 2),
      );
      console.log('DEBUG deal_id:', deal.id);
      const lineItems = extraction.line_items.map((item) => ({
        deal_id: deal.id,
        sku_text: item.sku_text || null,
        grade: item.grade || null,
        dimensions: item.dimensions || null,
        quantity: sanitizeNumber(item.quantity),
        unit: item.unit || null,
        rate: sanitizeNumber(item.rate),
        amount: sanitizeNumber(item.amount),
        confidence: item.confidence || 0,
        created_at: new Date().toISOString(),
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
  if (
    !cleanName ||
    cleanName.toLowerCase() === 'unknown' ||
    cleanName.toLowerCase() === 'null'
  ) {
    return null;
  }

  try {
    const scope = await getAccessibleSalespersonPhonesForBot(senderPhone);

    // 1. Check if customer already exists (role-scoped, or company-wide for Admin)
    let query = supabase
      .from('recurring_customers')
      .select('*')
      .ilike('customer_name', cleanName)
      .limit(1);

    if (scope.phones !== null) {
      if (scope.phones.length === 1) {
        query = query.eq('assigned_salesperson_phone', scope.phones[0]);
      } else if (scope.phones.length > 1) {
        query = query.in('assigned_salesperson_phone', scope.phones);
      }
    }

    let { data: existing } = await query;

    // If not found and sender is Admin, check company-wide regardless
    if ((!existing || existing.length === 0) && scope.isAdmin) {
      const { data: globalExisting } = await supabase
        .from('recurring_customers')
        .select('*')
        .ilike('customer_name', cleanName)
        .limit(1);
      existing = globalExisting;
    }

    if (existing && existing.length > 0) {
      const rec = existing[0];
      const updatePayload = {};
      if (
        extraData.customer_phone &&
        extraData.customer_phone !== rec.customer_phone
      )
        updatePayload.customer_phone = extraData.customer_phone;
      if (extraData.customer_gst && extraData.customer_gst !== rec.customer_gst)
        updatePayload.customer_gst = extraData.customer_gst;
      if (extraData.city && extraData.city !== rec.customer_address)
        updatePayload.customer_address = extraData.city;
      if (
        extraData.contact_person &&
        extraData.contact_person !== rec.contact_person
      )
        updatePayload.contact_person = extraData.contact_person;
      if (extraData.avg_order_frequency_days)
        updatePayload.avg_order_frequency_days = Number(
          extraData.avg_order_frequency_days,
        );
      if (extraData.assigned_salesperson_phone && scope.isAdmin)
        updatePayload.assigned_salesperson_phone =
          extraData.assigned_salesperson_phone;

      if (Object.keys(updatePayload).length > 0) {
        updatePayload.updated_at = new Date().toISOString();
        const { error: updErr } = await supabase
          .from('recurring_customers')
          .update(updatePayload)
          .eq('id', rec.id);
        if (updErr)
          console.error('[ensureCustomerRecord] update error:', updErr.message);
      }
      return rec;
    }

    // 2. Insert new record only if caller is Admin or explicit customer creation flow
    if (!scope.isAdmin && !extraData.allowCreate) {
      return null;
    }

    const insertPayload = {
      customer_name: cleanName,
      assigned_salesperson_phone:
        extraData.assigned_salesperson_phone || senderPhone,
      customer_phone: extraData.customer_phone || null,
      customer_gst: extraData.customer_gst || null,
      customer_address: extraData.city || null,
      contact_person: extraData.contact_person || null,
      is_active: true,
      avg_order_frequency_days:
        Number(extraData.avg_order_frequency_days) || 30,
    };

    const { data: newCustomer } = await supabase
      .from('recurring_customers')
      .insert(insertPayload)
      .select()
      .single();

    return newCustomer;
  } catch (err) {
    console.error('ensureCustomerRecord error:', err.message);
    try {
      const scope = await getAccessibleSalespersonPhonesForBot(senderPhone);
      let fallbackQuery = supabase
        .from('recurring_customers')
        .select('*')
        .ilike('customer_name', cleanName)
        .limit(1);

      if (scope.phones !== null) {
        if (scope.phones.length === 1) {
          fallbackQuery = fallbackQuery.eq(
            'assigned_salesperson_phone',
            scope.phones[0],
          );
        } else if (scope.phones.length > 1) {
          fallbackQuery = fallbackQuery.in(
            'assigned_salesperson_phone',
            scope.phones,
          );
        } else {
          return null;
        }
      }
      const { data: fallback } = await fallbackQuery;
      return fallback ? fallback[0] : null;
    } catch {
      return null;
    }
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

const DISTINCTIVE_INDUSTRY_WORDS = [
  'steel',
  'steels',
  'metal',
  'metals',
  'fabricator',
  'fabricators',
  'fabrication',
  'tube',
  'tubes',
  'pipe',
  'pipes',
  'motor',
  'motors',
  'infra',
  'infrastructure',
  'engineering',
  'engineers',
  'automotive',
  'automotives',
  'auto',
  'sheet',
  'sheets',
  'coil',
  'coils',
  'strip',
  'strips',
  'wire',
  'wires',
  'casting',
  'castings',
  'forging',
  'forgings',
  'alloy',
  'alloys',
  'power',
  'energy',
  'chemical',
  'chemicals',
  'tool',
  'tools',
  'solutions',
  'logistics',
  'trader',
  'traders',
  'trading',
  'industry',
  'industries',
  'enterprise',
  'enterprises',
  'work',
  'works',
  'hardware',
  'buildcon',
  'constructions',
  'construction',
];

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

const CORPORATE_LEGAL_SUFFIXES = [
  'pvt',
  'ltd',
  'private',
  'limited',
  'llp',
  'inc',
  'corp',
  'corporation',
  'co',
  'and',
  '&',
  'enterprises',
  'enterprise',
  'industries',
  'industry',
];

function normalizeCoreCompanyName(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .replace(/[.:,\-_/()&]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0 && !CORPORATE_LEGAL_SUFFIXES.includes(w))
    .join(' ')
    .trim();
}

function matchCustomerFromList(inputName, customerList) {
  if (!inputName || !customerList || customerList.length === 0) return null;
  const clean = inputName.trim().toLowerCase().replace(/\s+/g, ' ');

  // 1. Exact match (case-insensitive)
  const exact = customerList.find((c) => c.toLowerCase().trim() === clean);
  if (exact) return exact;

  // 2. Normalized Core Match (ignoring legal/corporate noise words)
  const cleanNorm = normalizeCoreCompanyName(clean);
  if (cleanNorm) {
    const normMatch = customerList.find(
      (c) => normalizeCoreCompanyName(c) === cleanNorm,
    );
    if (normMatch) return normMatch;
  }

  // 3. Prefix / Substring match on core name
  if (cleanNorm.length >= 3) {
    const subMatches = customerList.filter((c) => {
      const candNorm = normalizeCoreCompanyName(c);
      return (
        candNorm.startsWith(cleanNorm) ||
        candNorm.includes(cleanNorm) ||
        (cleanNorm.startsWith(candNorm) && candNorm.length >= 4)
      );
    });
    if (subMatches.length === 1) return subMatches[0];
  }

  // 4. Token Set / Word Overlap match
  const queryTokens = cleanNorm.split(' ').filter((t) => t.length >= 2);
  if (queryTokens.length > 0) {
    const tokenMatches = customerList.filter((c) => {
      const candTokens = normalizeCoreCompanyName(c)
        .split(' ')
        .filter((t) => t.length >= 2);
      return queryTokens.every((qt) => candTokens.includes(qt));
    });
    if (tokenMatches.length === 1) return tokenMatches[0];
  }

  // 5. Letter-to-letter Typo Match (Levenshtein distance per token)
  if (queryTokens.length > 0) {
    const typoScores = customerList.map((c) => {
      const candTokens = normalizeCoreCompanyName(c)
        .split(' ')
        .filter((t) => t.length >= 2);
      let matchedCount = 0;
      for (const qt of queryTokens) {
        const isMatched = candTokens.some((ct) => {
          if (qt === ct) return true;
          const maxDist = qt.length <= 4 ? 1 : 2;
          return levenshtein(qt, ct) <= maxDist;
        });
        if (isMatched) matchedCount++;
      }
      const matchRatio = matchedCount / queryTokens.length;
      return { customer: c, matchRatio };
    });

    const bestMatches = typoScores.filter((s) => s.matchRatio >= 1.0);
    if (bestMatches.length === 1) return bestMatches[0].customer;
  }

  return null;
}

function hasConflictingIndustryNoun(name1, name2) {
  if (!name1 || !name2) return false;
  const words1 = name1
    .toLowerCase()
    .replace(/[.:,\-_/()&]/g, ' ')
    .split(/\s+/);
  const words2 = name2
    .toLowerCase()
    .replace(/[.:,\-_/()&]/g, ' ')
    .split(/\s+/);

  const ind1 = words1.filter((w) => DISTINCTIVE_INDUSTRY_WORDS.includes(w));
  const ind2 = words2.filter((w) => DISTINCTIVE_INDUSTRY_WORDS.includes(w));

  if (ind1.length > 0 && ind2.length > 0) {
    const hasOverlap = ind1.some(
      (w1) =>
        ind2.includes(w1) ||
        ind2.some((w2) => w1.startsWith(w2) || w2.startsWith(w1)),
    );
    if (!hasOverlap) {
      return true;
    }
  }
  return false;
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
You are a Strict Entity Resolution Engine for B2B industrial company names.
Given a user-provided company name and a list of registered customer names, determine if ANY registered customer is the intended business entity.

Target Company Name: "${text}"

Registered Customer Candidates:
${customerList.map((c, i) => `${i + 1}. "${c}"`).join('\n')}

MATCHING RULES:
1. MATCH IF:
   - The candidate is the SAME company with minor spelling typos, phonetic differences, or abbreviations (e.g. "Omega Metal" matches "Omega Metal & Alloy Industries", "Matrix Steel" matches "Matrix Steel Fabricators", "Titanium Pipes" matches "Titanium Pipes & Flanges Corp").
   - The candidate is the SAME company with or without corporate suffixes (Pvt Ltd, Ltd, Corp, LLP, Enterprises, Works, Co.).
2. REJECT (RETURN ONLY "0") IF:
   - The candidate is a completely different company name and unrelated business.
   - There are multiple conflicting candidates and you cannot be certain.

If there is a definite match, return ONLY the 1-based index (e.g. "1").
If there is NO match, return ONLY "0".
`;

    const response = await invokeWithFallback([new HumanMessage(prompt)]);
    const textRes = (
      typeof response.content === 'string'
        ? response.content
        : JSON.stringify(response.content)
    ).trim();
    const matchIndex = parseInt(textRes, 10);

    if (
      !isNaN(matchIndex) &&
      matchIndex > 0 &&
      matchIndex <= customerList.length
    ) {
      return customerList[matchIndex - 1];
    }
  } catch (err) {
    console.error('fuzzyMatchCustomer error:', err.message);
  }
  return null;
}

/**
 * Fetches all active customers assigned to a salesperson or within their management scope.
 * Supports Admin (all active), Sales Manager (team assigned), and Salesperson (own assigned).
 * Handles both 10-digit and 12-digit phone formats.
 */
async function getAssignedCustomersList(senderPhone) {
  if (!senderPhone) return [];
  try {
    const scope = await getAccessibleSalespersonPhonesForBot(senderPhone);
    let query = supabase
      .from('recurring_customers')
      .select('*')
      .eq('is_active', true)
      .order('customer_name', { ascending: true });

    if (scope.phones !== null) {
      if (scope.phones.length === 0) return [];
      const phoneSet = new Set();
      for (const p of scope.phones) {
        if (!p) continue;
        const raw = String(p).replace(/\D/g, '');
        phoneSet.add(raw);
        if (raw.length === 10) phoneSet.add(`91${raw}`);
        if (raw.length === 12 && raw.startsWith('91')) phoneSet.add(raw.slice(2));
      }
      const targetPhones = Array.from(phoneSet);
      query = query.in('assigned_salesperson_phone', targetPhones);
    }

    const { data: customers, error } = await query;
    if (error) {
      console.error('[getAssignedCustomersList] error:', error.message);
      return [];
    }
    return customers || [];
  } catch (err) {
    console.error('[getAssignedCustomersList] exception:', err.message);
    return [];
  }
}

/**
 * Verifies if a customer is registered in the user's account / accessible scope.
 * Supports Admin (company-wide), Sales Manager (team-wide), and Salesperson (own assigned).
 * Handles exact matching and fuzzy matching (typos/letter-to-letter/Hinglish).
 * Returns the matched official name or null if not found.
 */
async function verifyAndGetCustomerName(customerName, senderPhone) {
  if (!customerName || !senderPhone) return null;
  const clean = customerName.trim();
  if (
    !clean ||
    clean.toLowerCase() === 'unknown' ||
    clean.toLowerCase() === 'null'
  )
    return null;

  try {
    // 1. Fetch assigned customers for this salesperson
    const assignedCustomers = await getAssignedCustomersList(senderPhone);
    const assignedNames = assignedCustomers.map((c) => c.customer_name).filter(Boolean);

    if (assignedNames.length > 0) {
      // Deterministic multi-stage match (exact, core normalized, prefix, token overlap, Levenshtein typo)
      const matched = matchCustomerFromList(clean, assignedNames);
      if (matched) return matched;

      // LLM fuzzy match fallback across assigned accounts if 1-20 candidates
      if (assignedNames.length <= 30) {
        const llmMatched = await fuzzyMatchCustomer(clean, assignedNames);
        if (llmMatched) return llmMatched;
      }
      return null;
    }

    // 2. If no assigned customers found in direct list (e.g. Admin or Global scope)
    const scope = await getAccessibleSalespersonPhonesForBot(senderPhone);
    if (scope.isAdmin) {
      let query = supabase
        .from('recurring_customers')
        .select('customer_name')
        .eq('is_active', true)
        .ilike('customer_name', `%${clean}%`)
        .limit(20);

      let { data: globalCandidates } = await query;
      if (!globalCandidates || globalCandidates.length === 0) {
        const words = clean.split(/\s+/).filter((w) => w.length > 2);
        if (words.length > 0) {
          const orTokens = words.map((w) => `customer_name.ilike.%${w}%`).join(',');
          const { data: wordCandidates } = await supabase
            .from('recurring_customers')
            .select('customer_name')
            .eq('is_active', true)
            .or(orTokens)
            .limit(20);
          globalCandidates = wordCandidates;
        }
      }

      if (globalCandidates && globalCandidates.length > 0) {
        const candidateNames = Array.from(new Set(globalCandidates.map((c) => c.customer_name)));
        const matched = matchCustomerFromList(clean, candidateNames);
        if (matched) return matched;

        const llmMatched = await fuzzyMatchCustomer(clean, candidateNames);
        if (llmMatched) return llmMatched;
      }
    }
  } catch (err) {
    console.error('verifyAndGetCustomerName error:', err.message);
  }
  return null;
}

/**
 * Updates an existing customer's profile and configuration in place (order frequency, contact, rep).
 * Supports full Admin, Sales Manager, and Salesperson role-scoping at scale.
 */
async function updateCustomerProfileRecord(
  senderPhone,
  customerName,
  updates = {},
) {
  if (!customerName || !senderPhone) {
    return { success: false, message: 'Customer name is required for update.' };
  }
  const cleanName = customerName.trim();
  if (!cleanName || cleanName.toLowerCase() === 'unknown') {
    return { success: false, message: 'Invalid customer name.' };
  }

  try {
    const scope = await getAccessibleSalespersonPhonesForBot(senderPhone);

    // 1. Fetch targeted customer candidates via indexed queries
    let query = supabase
      .from('recurring_customers')
      .select('*')
      .eq('is_active', true)
      .ilike('customer_name', `%${cleanName}%`)
      .limit(15);

    if (scope.phones !== null) {
      if (scope.phones.length === 1) {
        query = query.eq('assigned_salesperson_phone', scope.phones[0]);
      } else if (scope.phones.length > 1) {
        query = query.in('assigned_salesperson_phone', scope.phones);
      } else {
        return {
          success: false,
          message: 'No salespersons assigned to your team.',
        };
      }
    }

    let { data: customers } = await query;

    // If Admin and not found in filtered list, search company-wide
    if ((!customers || customers.length === 0) && scope.isAdmin) {
      const { data: adminCusts } = await supabase
        .from('recurring_customers')
        .select('*')
        .eq('is_active', true)
        .ilike('customer_name', `%${cleanName}%`)
        .limit(15);
      customers = adminCusts;
    }

    // If still empty, try word tokens
    if (!customers || customers.length === 0) {
      const stopWords = [
        'pvt',
        'ltd',
        'steel',
        'company',
        'corp',
        'enterprises',
        'private',
        'limited',
        'industries',
        'works',
      ];
      const words = cleanName
        .split(/\s+/)
        .filter((w) => w.length > 2 && !stopWords.includes(w.toLowerCase()));
      if (words.length > 0) {
        const orTokens = words
          .map((w) => `customer_name.ilike.%${w}%`)
          .join(',');
        let wordQuery = supabase
          .from('recurring_customers')
          .select('*')
          .eq('is_active', true)
          .or(orTokens)
          .limit(20);

        if (scope.phones !== null) {
          if (scope.phones.length === 1) {
            wordQuery = wordQuery.eq(
              'assigned_salesperson_phone',
              scope.phones[0],
            );
          } else if (scope.phones.length > 1) {
            wordQuery = wordQuery.in(
              'assigned_salesperson_phone',
              scope.phones,
            );
          }
        }

        const { data: wordCusts } = await wordQuery;
        customers = wordCusts;

        if ((!customers || customers.length === 0) && scope.isAdmin) {
          const { data: adminWordCusts } = await supabase
            .from('recurring_customers')
            .select('*')
            .eq('is_active', true)
            .or(orTokens)
            .limit(20);
          customers = adminWordCusts;
        }
      }
    }

    if (!customers || customers.length === 0) {
      return {
        success: false,
        message: `No registered customer found matching "${cleanName}".`,
      };
    }

    // 2. Exact or fuzzy match across targeted candidates
    let matched = customers.find(
      (c) => c.customer_name.toLowerCase().trim() === cleanName.toLowerCase(),
    );
    if (!matched) {
      matched = customers.find(
        (c) =>
          c.customer_name.toLowerCase().includes(cleanName.toLowerCase()) ||
          cleanName.toLowerCase().includes(c.customer_name.toLowerCase()),
      );
    }
    if (!matched) {
      const matchedName = await fuzzyMatchCustomer(
        cleanName,
        customers.map((c) => c.customer_name),
      );
      if (matchedName) {
        matched = customers.find((c) => c.customer_name === matchedName);
      }
    }

    if (!matched) {
      return {
        success: false,
        message: `Could not find any customer matching "${cleanName}".`,
      };
    }

    // 3. Build update payload
    const updatePayload = { updated_at: new Date().toISOString() };
    if (updates.order_frequency_days != null) {
      const freq = parseInt(updates.order_frequency_days, 10);
      if (!isNaN(freq) && freq > 0)
        updatePayload.avg_order_frequency_days = freq;
    }
    if (updates.contact_person)
      updatePayload.contact_person = updates.contact_person;
    if (updates.phone) updatePayload.customer_phone = updates.phone;
    if (updates.gst) updatePayload.customer_gst = updates.gst;
    if (updates.address_or_city)
      updatePayload.customer_address = updates.address_or_city;
    if (updates.is_active != null)
      updatePayload.is_active = Boolean(updates.is_active);

    // If Admin/Manager reassigning to another salesperson
    let targetRepEmployee = null;
    if (updates.assigned_salesperson && (scope.isAdmin || scope.isManager)) {
      const { data: allEmps } = await supabase
        .from('employees')
        .select('*')
        .eq('is_active', true);
      const targetLower = updates.assigned_salesperson.toLowerCase().trim();
      const foundEmp = (allEmps || []).find(
        (e) =>
          e.name?.toLowerCase().includes(targetLower) ||
          targetLower.includes(e.name?.toLowerCase()) ||
          e.phone === updates.assigned_salesperson,
      );
      if (foundEmp) {
        targetRepEmployee = foundEmp;
        updatePayload.assigned_salesperson_phone = foundEmp.phone;
      }
    }

    // 4. Update in place
    const { data: updatedRecord, error: updateError } = await supabase
      .from('recurring_customers')
      .update(updatePayload)
      .eq('id', matched.id)
      .select()
      .single();

    if (updateError) throw updateError;

    // Sync updated location / phone / contact person to the customer's latest visit record
    try {
      const visitUpdates = {};
      if (updates.address_or_city)
        visitUpdates.customer_address = updates.address_or_city;
      if (updates.phone) visitUpdates.contact_no = updates.phone;
      if (updates.contact_person)
        visitUpdates.person_met = updates.contact_person;

      if (Object.keys(visitUpdates).length > 0) {
        const { data: latestVisit } = await supabase
          .from('customer_visits')
          .select('id')
          .ilike('customer_name', `%${matched.customer_name}%`)
          .order('visited_at', { ascending: false })
          .limit(1);

        if (latestVisit && latestVisit.length > 0) {
          await supabase
            .from('customer_visits')
            .update(visitUpdates)
            .eq('id', latestVisit[0].id);
        }
      }
    } catch (vErr) {
      console.warn(
        'Syncing profile update to customer_visits notice:',
        vErr.message,
      );
    }

    // Get current assigned rep name for display
    let assignedRepName = targetRepEmployee ? targetRepEmployee.name : null;
    if (!assignedRepName && updatedRecord.assigned_salesperson_phone) {
      const { data: repData } = await supabase
        .from('employees')
        .select('name')
        .eq('phone', updatedRecord.assigned_salesperson_phone)
        .limit(1);
      if (repData && repData.length > 0) assignedRepName = repData[0].name;
    }

    return {
      success: true,
      customer: updatedRecord,
      assignedRepName,
      message:
        `✅ *Customer Profile Updated!*\n\n` +
        `🏢 Company: *${updatedRecord.customer_name}*\n` +
        (updates.order_frequency_days
          ? `📅 Order Frequency: *Every ${updatedRecord.avg_order_frequency_days} days*\n`
          : '') +
        (updatedRecord.contact_person
          ? `👤 Contact: *${updatedRecord.contact_person}*\n`
          : '') +
        (updatedRecord.customer_phone
          ? `📱 Phone: *${updatedRecord.customer_phone}*\n`
          : '') +
        (updatedRecord.customer_address
          ? `📍 Location: *${updatedRecord.customer_address}*\n`
          : '') +
        (assignedRepName
          ? `💼 Assigned Salesperson: *${assignedRepName}*\n`
          : '') +
        `\n_Updated live on Enlight Sales OS Dashboard!_ ✅`,
    };
  } catch (err) {
    console.error('updateCustomerProfileRecord error:', err.message);
    return {
      success: false,
      message: `❌ Could not update customer: ${err.message}`,
    };
  }
}

/**
 * Checks if the customer has any missing fields (phone, gst, address, contact_person)
 * in recurring_customers. If yes, returns a friendly prompt for the salesperson.
 */
async function getCustomerMissingInfoPrompt(customerName, senderPhone) {
  try {
    const scope = senderPhone
      ? await getAccessibleSalespersonPhonesForBot(senderPhone)
      : { phones: null };
    let query = supabase
      .from('recurring_customers')
      .select('customer_phone, customer_gst, customer_address, contact_person')
      .ilike('customer_name', `%${customerName}%`)
      .limit(1);

    if (scope.phones !== null) {
      if (scope.phones.length === 1) {
        query = query.eq('assigned_salesperson_phone', scope.phones[0]);
      } else if (scope.phones.length > 1) {
        query = query.in('assigned_salesperson_phone', scope.phones);
      } else {
        return '';
      }
    }

    const { data } = await query;

    if (!data || data.length === 0) return '';

    const customer = data[0];
    const missing = [];
    if (!customer.customer_phone) missing.push('• *Mobile Number*');
    if (!customer.contact_person) missing.push('• *Contact Person / Owner*');
    if (!customer.customer_address) missing.push('• *City / Location*');
    if (!customer.customer_gst) missing.push('• *GSTIN* (optional)');

    if (missing.length > 0) {
      return (
        `\n\n*Missing profile details for ${customerName}:*\n` +
        missing.join('\n') +
        `\n\n_(You can update these details anytime by simply replying in your own words, e.g. "Supreme Steel phone is 9876543210 owner Mr. Kapoor" or "Supreme location is Nashik")_`
      );
    }
  } catch (err) {
    console.error('getCustomerMissingInfoPrompt error:', err.message);
  }
  return '';
}

/**
 * Saves or updates the active customer context session for a salesperson.
 */
async function saveActiveSession(
  salespersonPhone,
  customerName,
  intent = 'general',
) {
  if (!salespersonPhone || !customerName) return;
  try {
    const clean = String(salespersonPhone).replace(/\D/g, '');
    const p10 = clean.slice(-10);
    const variants = p10
      ? Array.from(new Set([p10, `91${p10}`, `+91${p10}`, clean]))
      : [clean];

    const { data: existing } = await supabase
      .from('conversation_sessions')
      .select('salesperson_phone')
      .in('salesperson_phone', variants)
      .limit(1);

    const primaryPhone = `91${p10 || clean}`;

    if (existing && existing.length > 0) {
      await supabase
        .from('conversation_sessions')
        .update({
          active_customer_name: customerName,
          last_intent: intent,
          updated_at: new Date().toISOString(),
        })
        .eq('salesperson_phone', existing[0].salesperson_phone);
    } else {
      await supabase.from('conversation_sessions').insert({
        salesperson_phone: primaryPhone,
        active_customer_name: customerName,
        last_intent: intent,
        updated_at: new Date().toISOString(),
      });
    }
  } catch (err) {
    console.error('saveActiveSession catch:', err.message);
  }
}

function getStartOfTodayISO() {
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    0,
    0,
    0,
    0,
  );
  return startOfToday.toISOString();
}

/**
 * Retrieves the active customer context for a salesperson (persists for the day, resets at 12:00 AM midnight).
 */
async function getActiveSession(salespersonPhone) {
  if (!salespersonPhone) return null;
  try {
    const clean = String(salespersonPhone).replace(/\D/g, '');
    const p10 = clean.slice(-10);
    const variants = p10
      ? Array.from(new Set([p10, `91${p10}`, `+91${p10}`, clean]))
      : [clean];
    const startOfToday = getStartOfTodayISO();
    const { data, error } = await supabase
      .from('conversation_sessions')
      .select('active_customer_name')
      .in('salesperson_phone', variants)
      .gte('updated_at', startOfToday)
      .order('updated_at', { ascending: false })
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
    const clean = String(salespersonPhone).replace(/\D/g, '');
    const p10 = clean.slice(-10);
    const variants = p10
      ? Array.from(new Set([p10, `91${p10}`, `+91${p10}`, clean]))
      : [clean];
    const startOfToday = getStartOfTodayISO();
    const { data, error } = await supabase
      .from('conversation_sessions')
      .select('*')
      .in('salesperson_phone', variants)
      .gte('updated_at', startOfToday)
      .order('updated_at', { ascending: false })
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
  normalizePhone,
  getAccessibleSalespersonPhonesForBot,
  getAssignedCustomersList,
  ensureCustomerRecord,
  checkAndLogNewCustomer,
  fuzzyMatchCustomer,
  verifyAndGetCustomerName,
  getCustomerMissingInfoPrompt,
  saveActiveSession,
  getActiveSession,
  getFullActiveSession,
  updateCustomerProfileRecord,
  normalizeCoreCompanyName,
};
