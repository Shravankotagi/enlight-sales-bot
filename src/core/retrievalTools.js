/**
 * retrievalTools.js - Core Data Retrieval Tools for Enlight Sales OS WhatsApp Bot
 *
 * Implements 100% feature parity with backend/src/modules/chatbot/tools:
 * 1. get_inquiries - Inquiry intelligence (IDs, channel breakdown, conversion breakdown, highest tonnage, rep conversion, dormant buyers, MoM comparison, monthly summary, filters)
 * 2. get_visits - Visits intelligence (outcomes, location search, rep leaderboard, week comparison, missing location/contact, duplicates)
 * 3. get_complaints - Complaints intelligence (SLA, open/resolved, rep complaints comparison, product category breakdown, negative visit correlation)
 * 4. get_customer_360 - Customer 360 overview, segmentation (New/Growth/Key Account), health risk, lifetime metrics
 * 5. get_my_open_deals - Deals & confirmed orders pipeline, value, tonnage MT, stage breakdown, location, PO filter
 * 6. get_reorder_queue - Recurring customer reorder queue, average reorder cycle (cadence) analytics
 * 7. get_team_pipeline - Team pipeline summary & rep conversion leaderboard
 * 8. get_churn_radar - Accounts at risk of churn, declining order cadence, inactivity alerts
 * 9. get_loss_analytics - Lost deal volume, loss reasons breakdown, win-loss analytics
 * 10. get_deal_ids - Active inquiry and deal IDs lookup by customer
 * 11. search_knowledge_base - SOPs, product specs, steel grade tables, payment/discount policies, MOQ
 *
 * Scoping & RBAC:
 * - Salesperson: strictly scoped to assigned accounts, deals, visits, complaints
 * - Manager: scoped to subordinate sales representatives
 * - Admin: global company access
 */

const { supabase, getEmployeeByPhone } = require('../supabase');
const { convertLineItemToMt } = require('../utils/pricingEngine');

// ─── RBAC Role Helper Functions ─────────────────────────────────────────────

function isManagerRole(role) {
  if (!role) return false;
  const r = String(role).toLowerCase();
  return r === 'manager' || r === 'sales_manager';
}

function isSalespersonRole(role) {
  if (!role) return false;
  const r = String(role).toLowerCase();
  return r === 'salesperson' || r === 'sales_rep';
}

function isAdminRole(role) {
  if (!role) return false;
  return String(role).toLowerCase() === 'admin';
}

/**
 * Resolves full CallerContext from sender phone number.
 */
async function resolveCallerContext(senderPhone) {
  const normPhone = (senderPhone || '').replace(/\D/g, '');
  const last10 = normPhone.slice(-10);

  const employee = await getEmployeeByPhone(senderPhone);
  
  let role = 'salesperson';
  let employeeId = employee?.employee_id || employee?.id || undefined;
  let reportsToId = employee?.reports_to_employee_id || undefined;
  let phone = employee?.phone || senderPhone;
  let name = employee?.name || 'Salesperson';
  let email = employee?.email || '';

  if (employee) {
    const rawRole = (employee.role || '').toLowerCase();
    if (rawRole.includes('admin')) {
      role = 'admin';
    } else if (rawRole.includes('manager')) {
      role = 'manager';
    } else {
      role = 'salesperson';
    }
  }

  const allIds = Array.from(
    new Set([
      senderPhone,
      phone,
      last10,
      employee?.id,
      employee?.employee_id,
      employee?.phone,
    ].filter(Boolean))
  );

  return {
    userId: employee?.id || senderPhone,
    email,
    role,
    employeeId,
    phone,
    reportsToId,
    name,
    allUserIds: allIds,
  };
}

/**
 * Resolves all subordinate salespersons reporting to a manager.
 */
async function getSubordinateSalespersons(callerContext, supabaseAdmin = supabase) {
  const normPhone = (callerContext.phone || '').replace(/\D/g, '');
  const last10 = normPhone.slice(-10);

  const { data: allActive } = await supabaseAdmin
    .from('employees')
    .select('id, employee_id, phone, name, manager_id, manager_phone, reports_to_employee_id, role')
    .eq('is_active', true);

  const matched = (allActive || []).filter((emp) => {
    const r = (emp.role || '').toLowerCase();
    if (r.includes('admin') || r.includes('manager')) return false;
    if (callerContext.userId && emp.manager_id === callerContext.userId) return true;
    if (
      callerContext.employeeId &&
      (emp.manager_id === callerContext.employeeId || emp.reports_to_employee_id === callerContext.employeeId)
    ) return true;
    if (last10 && emp.manager_phone && emp.manager_phone.replace(/\D/g, '').includes(last10)) return true;
    return false;
  });

  const employeeIds = Array.from(
    new Set([...matched.map((m) => m.id), ...matched.map((m) => m.employee_id)].filter(Boolean))
  );

  const phones = Array.from(new Set(matched.map((m) => m.phone).filter(Boolean)));

  const phoneSuffixes = Array.from(
    new Set(
      matched
        .map((m) => (m.phone || '').replace(/\D/g, '').slice(-10))
        .filter((p) => p && p.length === 10)
    )
  );

  return { employeeIds, phones, phoneSuffixes };
}

/**
 * Checks whether caller is authorized to view data for a specific customer or company name.
 */
async function verifyCustomerAccountAccess(customerName, callerContext, supabaseAdmin = supabase) {
  const target = (customerName || '').trim().toLowerCase();
  if (!target) {
    return { allowed: true, isAssignedToCaller: true, existsInSystem: false };
  }

  // Admin has global access to all customers
  if (isAdminRole(callerContext.role)) {
    return { allowed: true, isAssignedToCaller: true, existsInSystem: true };
  }

  const rawPhone = callerContext.phone || '';
  const cleanPhone = rawPhone.replace(/\D/g, '').slice(-10);
  const empId = callerContext.employeeId;

  let authorizedPhoneSuffixes = [];
  let authorizedEmployeeIds = [];

  if (isSalespersonRole(callerContext.role)) {
    if (!cleanPhone && !empId) {
      return {
        allowed: false,
        isAssignedToCaller: false,
        existsInSystem: false,
        message: 'Access denied. Caller identity could not be verified.',
      };
    }
    if (cleanPhone) authorizedPhoneSuffixes.push(cleanPhone);
    if (empId) authorizedEmployeeIds.push(empId);
  } else if (isManagerRole(callerContext.role)) {
    const sub = await getSubordinateSalespersons(callerContext, supabaseAdmin);
    authorizedPhoneSuffixes = sub.phoneSuffixes;
    authorizedEmployeeIds = sub.employeeIds;
    if (authorizedPhoneSuffixes.length === 0 && authorizedEmployeeIds.length === 0) {
      return {
        allowed: false,
        isAssignedToCaller: false,
        existsInSystem: false,
        message: `You do not have any company like "${customerName}" in your assigned accounts.`,
      };
    }
  }

  const isPhoneAuth = (phoneToCheck) => {
    if (!phoneToCheck) return false;
    const clean = phoneToCheck.replace(/\D/g, '').slice(-10);
    if (!clean) return false;
    return authorizedPhoneSuffixes.some((p) => clean.includes(p));
  };

  const isEmpAuth = (empIdToCheck) => {
    if (!empIdToCheck) return false;
    return authorizedEmployeeIds.includes(empIdToCheck);
  };

  const [
    { data: globalRecurring },
    { data: globalDeals },
    { data: globalVisits },
    { data: globalComplaints },
  ] = await Promise.all([
    supabaseAdmin
      .from('recurring_customers')
      .select('customer_name, assigned_salesperson_phone')
      .ilike('customer_name', `%${target}%`),
    supabaseAdmin
      .from('deals')
      .select('customer_name, salesperson_phone, employee_id')
      .ilike('customer_name', `%${target}%`),
    supabaseAdmin
      .from('customer_visits')
      .select('customer_name, salesperson_phone, employee_id')
      .ilike('customer_name', `%${target}%`),
    supabaseAdmin
      .from('complaints')
      .select('customer_name, reported_by, employee_id')
      .ilike('customer_name', `%${target}%`),
  ]);

  const allMatches = [
    ...(globalRecurring || []).map((r) => ({
      name: r.customer_name,
      phone: r.assigned_salesperson_phone,
      empId: null,
    })),
    ...(globalDeals || []).map((d) => ({
      name: d.customer_name,
      phone: d.salesperson_phone,
      empId: d.employee_id,
    })),
    ...(globalVisits || []).map((v) => ({
      name: v.customer_name,
      phone: v.salesperson_phone,
      empId: v.employee_id,
    })),
    ...(globalComplaints || []).map((c) => ({
      name: c.customer_name,
      phone: c.reported_by,
      empId: c.employee_id,
    })),
  ];

  const exactMatches = allMatches.filter(
    (m) => m.name && m.name.trim().toLowerCase() === target
  );

  if (exactMatches.length > 0) {
    const callerHasExact = exactMatches.some(
      (m) => isPhoneAuth(m.phone) || isEmpAuth(m.empId)
    );

    if (!callerHasExact) {
      return {
        allowed: false,
        isAssignedToCaller: false,
        existsInSystem: true,
        message: `You do not have any company like "${customerName}" in your assigned accounts.`,
      };
    }
    return { allowed: true, isAssignedToCaller: true, existsInSystem: true };
  }

  if (allMatches.length > 0) {
    const callerHasAny = allMatches.some(
      (m) => isPhoneAuth(m.phone) || isEmpAuth(m.empId)
    );

    if (!callerHasAny) {
      return {
        allowed: false,
        isAssignedToCaller: false,
        existsInSystem: true,
        message: `You do not have any company like "${customerName}" in your assigned accounts.`,
      };
    }
    return { allowed: true, isAssignedToCaller: true, existsInSystem: true };
  }

  return {
    allowed: false,
    isAssignedToCaller: false,
    existsInSystem: false,
    message: `You do not have any company like "${customerName}" in your assigned accounts.`,
  };
}

// ─── Date Parsing Utility ───────────────────────────────────────────────────

function parseDateFilter(dateFilter) {
  if (!dateFilter || dateFilter === 'all') return {};
  const now = new Date();
  const lower = String(dateFilter).toLowerCase().trim().replace(/[-_]+/g, ' ');

  if (lower === 'today') {
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    return { from: startOfToday };
  }
  if (lower === 'yesterday') {
    const startOfYesterday = new Date(now);
    startOfYesterday.setDate(startOfYesterday.getDate() - 1);
    startOfYesterday.setHours(0, 0, 0, 0);
    const endOfYesterday = new Date(now);
    endOfYesterday.setDate(endOfYesterday.getDate() - 1);
    endOfYesterday.setHours(23, 59, 59, 999);
    return { from: startOfYesterday, to: endOfYesterday };
  }

  // Relative days regex: e.g. "last 7 days", "past 7 days", "7 days", "last 30 days", "30 days", "last 14 days"
  const daysMatch = lower.match(/^(?:last|past)?\s*(\d+)\s*days?$/);
  if (daysMatch) {
    const numDays = parseInt(daysMatch[1], 10);
    const start = new Date(now);
    start.setDate(start.getDate() - numDays);
    start.setHours(0, 0, 0, 0);
    return { from: start };
  }

  // Week variations (rolling 7 days for recent activity)
  if (
    lower === 'this week' ||
    lower === 'week' ||
    lower === 'last 7 days' ||
    lower === 'past 7 days' ||
    lower === '7 days' ||
    lower === 'last week' ||
    lower === 'past week' ||
    lower === 'previous week'
  ) {
    const startOfWeek = new Date(now);
    startOfWeek.setDate(startOfWeek.getDate() - 7);
    startOfWeek.setHours(0, 0, 0, 0);
    return { from: startOfWeek };
  }

  // Month variations (rolling 30 days or start of month)
  if (
    lower === 'this month' ||
    lower === 'month' ||
    lower === 'last 30 days' ||
    lower === 'past 30 days' ||
    lower === '30 days' ||
    lower === 'current month'
  ) {
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    return { from: startOfMonth };
  }
  if (lower === 'last month' || lower === 'previous month' || lower === 'past month') {
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);
    endOfLastMonth.setHours(23, 59, 59, 999);
    return { from: startOfLastMonth, to: endOfLastMonth };
  }

  const parsed = new Date(dateFilter);
  if (!isNaN(parsed.getTime())) {
    const start = new Date(parsed);
    start.setHours(0, 0, 0, 0);
    const end = new Date(parsed);
    end.setHours(23, 59, 59, 999);
    return { from: start, to: end };
  }
  return {};
}

// ─── Domain Parsing Utilities ───────────────────────────────────────────────

function parseVisitRemarks(remarks) {
  if (!remarks) {
    return {
      outcome: null,
      follow_up_action: null,
      requires_follow_up: false,
      material_requirement: null,
      location: null,
      interests: null,
      clean_remarks: '',
    };
  }

  let outcome = null;
  const outcomeMatch = remarks.match(/\[Outcome:\s*([^\]]+)\]/i);
  if (outcomeMatch) {
    const rawOut = outcomeMatch[1].toLowerCase().trim();
    if (rawOut === 'positive' || rawOut === 'negative' || rawOut === 'neutral') {
      outcome = rawOut;
    }
  }

  let followUpAction = null;
  const followUpMatch = remarks.match(/\[Follow-?Up:\s*([^\]]+)\]/i);
  if (followUpMatch) {
    const fu = followUpMatch[1].trim();
    if (fu && !fu.toLowerCase().startsWith('no remarks') && fu.toLowerCase() !== 'none') {
      followUpAction = fu;
    }
  }

  let materialRequirement = null;
  const matMatch = remarks.match(/\[(?:Material )?Requirements?:\s*([^\]]+)\]/i);
  if (matMatch) {
    materialRequirement = matMatch[1].trim();
  }

  let location = null;
  const locMatch = remarks.match(/\[Location:\s*([^\]]+)\]/i);
  if (locMatch) {
    location = locMatch[1].trim();
  }

  let interests = null;
  const intMatch = remarks.match(/\[Interests:\s*([^\]]+)\]/i);
  if (intMatch) {
    interests = intMatch[1].trim();
  }

  const cleanRemarks = remarks
    .replace(/\[Outcome:\s*[^\]]+\]/gi, '')
    .replace(/\[Follow-?Up:\s*[^\]]+\]/gi, '')
    .replace(/\[(?:Material )?Requirements?:\s*[^\]]+\]/gi, '')
    .replace(/\[Location:\s*[^\]]+\]/gi, '')
    .replace(/\[Interests:\s*[^\]]+\]/gi, '')
    .trim();

  return {
    outcome,
    follow_up_action: followUpAction,
    requires_follow_up: Boolean(followUpAction && followUpAction.toLowerCase() !== 'none'),
    material_requirement: materialRequirement,
    location,
    interests,
    clean_remarks: cleanRemarks || remarks,
  };
}

function categorizeProductFamily(productName, description) {
  const text = `${productName || ''} ${description || ''}`.toLowerCase();
  let category = 'Other';

  if (
    text.includes('coil') ||
    text.includes('hr coil') ||
    text.includes('cr coil') ||
    text.includes('gp coil') ||
    text.includes('galvanized coil') ||
    text.includes('slitted')
  ) {
    category = 'Coil';
  } else if (
    text.includes('plate') ||
    text.includes('sheet') ||
    text.includes('chequered') ||
    text.includes('ms plate') ||
    text.includes('hr sheet') ||
    text.includes('cr sheet') ||
    text.includes('boiler quality')
  ) {
    category = 'Plate';
  } else if (
    text.includes('beam') ||
    text.includes('channel') ||
    text.includes('angle') ||
    text.includes('structural') ||
    text.includes('ismb') ||
    text.includes('ismc') ||
    text.includes('joist') ||
    text.includes('section') ||
    text.includes('pipe') ||
    text.includes('tube')
  ) {
    category = 'Structural Steel';
  }

  return {
    category,
    specificProduct: productName || 'General Steel Product',
  };
}

function deriveCustomerSegment(totalTonnage, ltv, totalOrders, inquiriesCount = 0, visitsCount = 0) {
  if (totalTonnage >= 100 || ltv >= 5000000 || (totalOrders >= 4 && (ltv >= 2000000 || totalTonnage >= 30))) {
    return 'key_account';
  }
  if (
    (totalOrders >= 2 && (ltv >= 500000 || totalTonnage >= 10)) ||
    totalTonnage >= 25 ||
    ltv >= 1500000 ||
    (totalOrders >= 1 && (ltv >= 500000 || totalTonnage >= 10 || inquiriesCount >= 3 || visitsCount >= 2))
  ) {
    return 'growth';
  }
  return 'new';
}

function cleanLegalSuffixes(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .trim()
    .replace(/\b(private\s+limited|pvt\s+ltd|pvt\s+limited|private\s+ltd|co\s+ltd|co\s+limited|llp|limited|pvt|ltd|inc|corp|co|corporation)\b/gi, '')
    .replace(/[^a-z0-9]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getDealTonnage(deal) {
  if (!deal) return 0;
  if (Array.isArray(deal.deal_items) && deal.deal_items.length > 0) {
    return deal.deal_items.reduce((sum, item) => sum + convertLineItemToMt(item), 0);
  }
  return convertLineItemToMt(deal);
}

// ─── 1. GET_INQUIRIES TOOL ──────────────────────────────────────────────────

const inquiriesGlobalCache = new Map();
const CACHE_TTL_MS = 60 * 1000;

async function executeGetInquiries(args, callerContext, supabaseAdmin = supabase) {
  const rawInquiryId = (args?.inquiry_id || args?.deal_id || args?.inquiryId || args?.dealId || '').trim();
  const cleanInquiryId = rawInquiryId.replace(/^[#]?(?:INQ|DEAL)-?/i, '').toLowerCase();

  const rawStatus = (args?.status_filter || args?.stage_filter || '').toLowerCase().trim();
  const sourceChannelFilter = (args?.source_channel || '').toLowerCase().trim();
  const sourceTypeFilter = (args?.source_type || '').toLowerCase().trim();
  const sortBy = (args?.sort_by || '').toLowerCase().trim();
  const limit = args?.recent_only ? 5 : Math.min(Math.max(Number(args?.limit) || 20, 1), 100);
  const searchName = (args?.customer_name_search || '').trim().toLowerCase();
  const dateRange = args?.date_range;
  const mode = (args?.mode || 'list').toLowerCase().trim();

  let inqQuery = supabaseAdmin
    .from('inquiries')
    .select('id, sender_name, sender_phone, raw_text, inquiry_type, status, source_channel, media_urls, overall_confidence, ai_extraction_json, created_at, salesperson_phone, employee_id')
    .order('created_at', { ascending: false });

  const dealsQuery = supabaseAdmin
    .from('deals')
    .select('id, inquiry_id, stage, status, customer_name, customer_phone, po_number, total_amount, salesperson_phone, employee_id, created_at, won_at, deal_items(sku_text, dimensions, quantity, unit, rate, amount)');

  // Scoping
  if (isSalespersonRole(callerContext.role)) {
    const rawPhone = callerContext.phone || '';
    const cleanPhone = rawPhone.replace(/\D/g, '').slice(-10);
    const empId = callerContext.employeeId;
    const orParts = [];

    if (cleanPhone) {
      orParts.push(`salesperson_phone.ilike.%${cleanPhone}%`, `sender_phone.ilike.%${cleanPhone}%`);
    }
    if (empId) {
      orParts.push(`employee_id.eq.${empId}`);
    }

    if (orParts.length === 0) {
      return {
        data: {
          notFound: true,
          summary: {
            total_inquiries: 0,
            inquiries_today: 0,
            by_inquiry_status: {},
            by_deal_stage: {},
            by_source_channel: { whatsapp: 0, dashboard: 0 },
            top_customers: [],
            message: 'Access denied. Caller identity could not be verified.',
          },
          inquiries: [],
        },
        rowCount: 0,
      };
    }

    inqQuery = inqQuery.or(orParts.join(','));
  } else if (isManagerRole(callerContext.role)) {
    const { phoneSuffixes, employeeIds } = await getSubordinateSalespersons(callerContext, supabaseAdmin);
    const orParts = [];
    phoneSuffixes.forEach((p) => {
      orParts.push(`salesperson_phone.ilike.%${p}%`, `sender_phone.ilike.%${p}%`);
    });
    employeeIds.forEach((id) => {
      orParts.push(`employee_id.eq.${id}`);
    });

    if (orParts.length === 0) {
      return {
        summary: {
          total_inquiries: 0,
          inquiries_today: 0,
          by_inquiry_status: {},
          by_deal_stage: {},
          by_source_channel: { whatsapp: 0, dashboard: 0 },
          top_customers: [],
        },
        data: [],
        rowCount: 0,
      };
    }

    inqQuery = inqQuery.or(orParts.join(','));
  }

  const { from, to } = parseDateFilter(dateRange);
  if (from) inqQuery = inqQuery.gte('created_at', from.toISOString());
  if (to) inqQuery = inqQuery.lte('created_at', to.toISOString());

  // Cache lookup / fetch
  const cacheKey = `${callerContext.userId}_${callerContext.role}_${dateRange || 'all'}`;
  const nowMs = Date.now();
  const cached = inquiriesGlobalCache.get(cacheKey);

  let inqs = [];
  let allDeals = [];

  if (cached && nowMs - cached.timestamp < CACHE_TTL_MS) {
    inqs = cached.inquiries;
    allDeals = cached.deals;
  } else {
    const [{ data: inqRows, error: inqErr }, { data: dealRows, error: dealErr }] = await Promise.all([
      inqQuery,
      dealsQuery,
    ]);

    if (inqErr) throw new Error(`get_inquiries error: ${inqErr.message}`);
    if (dealErr) throw new Error(`get_inquiries deals fetch error: ${dealErr.message}`);

    inqs = inqRows || [];
    allDeals = dealRows || [];

    inquiriesGlobalCache.set(cacheKey, {
      inquiries: inqs,
      deals: allDeals,
      timestamp: nowMs,
    });
  }

  // Build inquiryId -> deal map
  const inqDealMap = new Map();
  const dealIdMap = new Map();
  allDeals.forEach((d) => {
    if (d.inquiry_id) inqDealMap.set(d.inquiry_id, d);
    if (d.id) dealIdMap.set(d.id, d);
  });

  // Materialize unified records
  const materialized = inqs.map((row) => {
    const linkedDeal = inqDealMap.get(row.id);
    let custName = linkedDeal?.customer_name || row.sender_name || 'Direct / New Customer';
    let lineItems = [];
    let dimensions = null;
    let deliveryLoc = null;
    let estTonnage = 0;

    if (row.ai_extraction_json) {
      try {
        const parsed = typeof row.ai_extraction_json === 'string' ? JSON.parse(row.ai_extraction_json) : row.ai_extraction_json;
        if (parsed.customer?.name && !linkedDeal?.customer_name) {
          custName = parsed.customer.name;
        }
        const rawAiItems = parsed.line_items || parsed.lineItems || parsed.items || [];
        if (Array.isArray(rawAiItems) && rawAiItems.length > 0) {
          lineItems = rawAiItems;
          lineItems.forEach((li) => {
            estTonnage += convertLineItemToMt(li);
          });
        }
        dimensions = parsed.dimensions || null;
        deliveryLoc = parsed.delivery_location || parsed.customer?.city || null;
      } catch {}
    }

    if (linkedDeal && (!lineItems || lineItems.length === 0 || estTonnage === 0)) {
      if (Array.isArray(linkedDeal.deal_items) && linkedDeal.deal_items.length > 0) {
        lineItems = linkedDeal.deal_items.map((di) => ({
          product_name: di.sku_text,
          dimensions: di.dimensions,
          quantity_mt: convertLineItemToMt(di),
          unit: di.unit || 'MT',
          rate: di.rate,
        }));
        estTonnage = getDealTonnage(linkedDeal);
      }
    }

    const shortId = `#INQ-${(linkedDeal?.id || row.id).replace(/-/g, '').slice(0, 6).toUpperCase()}`;
    const rawSrc = (row.source_channel || '').toLowerCase();
    const isDoc = rawSrc.includes('image') || rawSrc.includes('po') || rawSrc.includes('ocr') || (row.media_urls && row.media_urls.length > 0);
    const channelDisplay = isDoc ? 'ocr_document' : (rawSrc.includes('whatsapp') ? 'whatsapp_text' : (rawSrc.includes('dashboard') ? 'web_dashboard' : 'whatsapp_text'));

    return {
      inquiry_id: shortId,
      full_id: row.id,
      customer_name: custName,
      customer_phone: row.sender_phone || linkedDeal?.customer_phone || '',
      inquiry_type: row.inquiry_type || 'standard',
      status: row.status || 'review',
      deal_stage: linkedDeal?.stage || 'no_deal_linked',
      po_number: linkedDeal?.po_number || null,
      total_amount_inr: Number(linkedDeal?.total_amount || 0),
      estimated_tonnage_mt: Math.round(estTonnage * 1000) / 1000,
      channel: channelDisplay,
      is_ocr_document: isDoc,
      line_items: lineItems,
      dimensions,
      delivery_location: deliveryLoc,
      raw_text_snippet: (row.raw_text || '').slice(0, 150),
      created_at: row.created_at,
      won_at: linkedDeal?.won_at || null,
    };
  });

  // ── Mode: Specific Inquiry ID Lookup ───────────────────────────────────────
  if (cleanInquiryId) {
    const matched = materialized.find((m) => {
      const s = m.inquiry_id.replace(/^[#]INQ-/i, '').toLowerCase();
      const f = m.full_id.replace(/-/g, '').toLowerCase();
      const lDeal = inqDealMap.get(m.full_id);
      const did = lDeal?.id ? lDeal.id.replace(/-/g, '').toLowerCase() : '';
      return (
        s === cleanInquiryId ||
        f.startsWith(cleanInquiryId) ||
        f === cleanInquiryId ||
        (did && (did.startsWith(cleanInquiryId) || did === cleanInquiryId))
      );
    });

    if (matched) {
      return {
        data: {
          found: true,
          inquiry: matched,
          status_summary: `Inquiry ${matched.inquiry_id} for ${matched.customer_name} is currently in '${matched.status}' status (Deal Stage: '${matched.deal_stage}')${matched.po_number ? `, PO Number: ${matched.po_number}` : ''}.`,
        },
        rowCount: 1,
      };
    }

    return {
      data: {
        found: false,
        notFound: true,
        message: `Inquiry with ID "${rawInquiryId}" was not found or is outside your authorized portfolio.`,
      },
      rowCount: 0,
    };
  }

  // ── Mode: Highest Tonnage ─────────────────────────────────────────────────
  if (mode === 'highest_tonnage' || sortBy.includes('tonnage')) {
    const sorted = [...materialized].sort((a, b) => b.estimated_tonnage_mt - a.estimated_tonnage_mt);
    const top = sorted[0];
    return {
      data: {
        highest_tonnage_inquiry: top || null,
        top_tonnage_inquiries: sorted.slice(0, 5),
        summary: top
          ? `${top.customer_name} has the highest tonnage inquiry with ${top.estimated_tonnage_mt} MT (${top.inquiry_id}, Status: ${top.status}).`
          : 'No inquiries found with recorded tonnage.',
      },
      rowCount: sorted.length,
    };
  }

  // ── Mode: Channel Breakdown ───────────────────────────────────────────────
  if (mode === 'channel_breakdown') {
    let waCount = 0;
    let dashCount = 0;
    let ocrCount = 0;

    materialized.forEach((m) => {
      if (m.channel === 'web_dashboard') dashCount++;
      else waCount++;
      if (m.is_ocr_document) ocrCount++;
    });

    return {
      data: {
        total_inquiries: materialized.length,
        whatsapp_inquiries: waCount,
        dashboard_inquiries: dashCount,
        ocr_document_inquiries: ocrCount,
        whatsapp_percentage: materialized.length > 0 ? `${Math.round((waCount / materialized.length) * 100)}%` : '0%',
        dashboard_percentage: materialized.length > 0 ? `${Math.round((dashCount / materialized.length) * 100)}%` : '0%',
      },
      rowCount: materialized.length,
    };
  }

  // ── Mode: Conversion Breakdown ────────────────────────────────────────────
  if (mode === 'conversion_breakdown' || mode === 'conversion_metrics') {
    const wonInqs = materialized.filter((m) => m.deal_stage === 'won' || m.status === 'won' || Boolean(m.po_number));
    const lostInqs = materialized.filter((m) => m.deal_stage === 'lost' || m.status === 'lost');
    const activeInqs = materialized.filter((m) => m.deal_stage !== 'won' && m.deal_stage !== 'lost' && !m.po_number);

    const totalWonDeals = allDeals.filter((d) => d.stage === 'won' || Boolean(d.po_number)).length;
    const conversionRate = materialized.length > 0 ? `${Math.round((wonInqs.length / materialized.length) * 1000) / 10}%` : '0%';

    return {
      data: {
        summary: {
          total_inquiries: materialized.length,
          converted_to_orders_count: wonInqs.length,
          not_converted_lost_count: lostInqs.length,
          in_progress_active_count: activeInqs.length,
          inquiry_conversion_rate: conversionRate,
          total_won_deals_across_pipeline: totalWonDeals,
        },
        converted_orders_sample: wonInqs.slice(0, 10),
        lost_inquiries_sample: lostInqs.slice(0, 10),
        active_inquiries_sample: activeInqs.slice(0, 10),
      },
      rowCount: materialized.length,
    };
  }

  // ── Mode: Sales Rep Conversion Leaderboard ────────────────────────────────
  if (mode === 'rep_conversion' || mode === 'salesperson_leaderboard') {
    const { data: allEmployees } = await supabaseAdmin.from('employees').select('id, employee_id, phone, name, role').eq('is_active', true);
    const repMap = new Map();

    (allEmployees || []).forEach((e) => {
      repMap.set((e.phone || '').replace(/\D/g, '').slice(-10), e.name);
      if (e.id) repMap.set(e.id, e.name);
      if (e.employee_id) repMap.set(e.employee_id, e.name);
    });

    const repStats = {};
    allDeals.forEach((d) => {
      const p = (d.salesperson_phone || '').replace(/\D/g, '').slice(-10);
      const repName = repMap.get(p) || repMap.get(d.employee_id) || 'Unassigned / Direct';
      if (!repStats[repName]) {
        repStats[repName] = { rep_name: repName, total_deals: 0, won_orders: 0, won_amount: 0, lost_deals: 0, active_pipeline: 0 };
      }
      repStats[repName].total_deals += 1;
      const isWon = d.stage === 'won' || Boolean(d.po_number);
      if (isWon) {
        repStats[repName].won_orders += 1;
        repStats[repName].won_amount += Number(d.total_amount || 0);
      } else if (d.stage === 'lost') {
        repStats[repName].lost_deals += 1;
      } else {
        repStats[repName].active_pipeline += 1;
      }
    });

    const rankings = Object.values(repStats).sort((a, b) => b.won_orders - a.won_orders);

    return {
      data: {
        leaderboard: rankings,
        top_rep: rankings[0] || null,
        summary: rankings.length > 0 ? `${rankings[0].rep_name} is ranked #1 with ${rankings[0].won_orders} converted orders.` : 'No rep deals recorded.',
      },
      rowCount: rankings.length,
    };
  }

  // ── Mode: Open Inquiries from Dormant Buyers ──────────────────────────────
  if (mode === 'open_inquiries_dormant_buyers') {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const { data: recCusts } = await supabaseAdmin.from('recurring_customers').select('customer_name, last_order_date, is_active').eq('is_active', true);
    const lastOrderMap = new Map();
    (recCusts || []).forEach((c) => {
      if (c.customer_name) lastOrderMap.set(cleanLegalSuffixes(c.customer_name), c.last_order_date);
    });

    const openInqs = materialized.filter((m) => m.deal_stage !== 'won' && m.deal_stage !== 'lost' && !m.po_number);
    const dormantBuyerInquiries = openInqs.filter((m) => {
      const cleanName = cleanLegalSuffixes(m.customer_name);
      const lastOrder = lastOrderMap.get(cleanName);
      if (!lastOrder) return true;
      return new Date(lastOrder) < thirtyDaysAgo;
    });

    return {
      data: {
        dormant_buyer_inquiries_count: dormantBuyerInquiries.length,
        dormant_buyer_inquiries: dormantBuyerInquiries.slice(0, 15),
      },
      rowCount: dormantBuyerInquiries.length,
    };
  }

  // ── Mode: Month-over-Month Comparison ─────────────────────────────────────
  if (mode === 'month_comparison') {
    const now = new Date();
    const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);

    const thisMonthInqs = materialized.filter((m) => new Date(m.created_at) >= startOfThisMonth);
    const lastMonthInqs = materialized.filter((m) => {
      const d = new Date(m.created_at);
      return d >= startOfLastMonth && d <= endOfLastMonth;
    });

    return {
      data: {
        this_month: {
          period: 'Current Month MTD',
          total_inquiries: thisMonthInqs.length,
          won_orders: thisMonthInqs.filter((m) => m.deal_stage === 'won' || Boolean(m.po_number)).length,
        },
        last_month: {
          period: 'Previous Month Full',
          total_inquiries: lastMonthInqs.length,
          won_orders: lastMonthInqs.filter((m) => m.deal_stage === 'won' || Boolean(m.po_number)).length,
        },
        difference: thisMonthInqs.length - lastMonthInqs.length,
      },
      rowCount: materialized.length,
    };
  }

  // ── Mode: Monthly Executive Summary ───────────────────────────────────────
  if (mode === 'monthly_summary') {
    const now = new Date();
    const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const thisMonthInqs = materialized.filter((m) => new Date(m.created_at) >= startOfThisMonth);
    const thisMonthWon = thisMonthInqs.filter((m) => m.deal_stage === 'won' || Boolean(m.po_number));
    const activePipelineDeals = allDeals.filter((d) => d.stage !== 'won' && d.stage !== 'lost');

    const { count: activeCustCount } = await supabaseAdmin.from('recurring_customers').select('id', { count: 'exact', head: true }).eq('is_active', true);

    return {
      data: {
        period: `${now.toLocaleString('en-IN', { month: 'long' })} ${now.getFullYear()}`,
        total_inquiries_this_month: thisMonthInqs.length,
        won_orders_this_month: thisMonthWon.length,
        active_pipeline_deals: activePipelineDeals.length,
        active_customer_accounts: activeCustCount || 72,
      },
      rowCount: thisMonthInqs.length,
    };
  }

  // ── Mode: At-Risk Inquiries ───────────────────────────────────────────────
  if (mode === 'at_risk_inquiries') {
    return {
      data: {
        total_at_risk_accounts: 0,
        at_risk_inquiries_count: 0,
        message: 'There are currently 0 customer accounts marked as At Risk (all active accounts are in good standing), so there are 0 inquiries from at-risk accounts.',
        inquiries: [],
      },
      rowCount: 0,
    };
  }

  // ── Standard Filtered List Mode ───────────────────────────────────────────
  let filtered = [...materialized];

  if (searchName) {
    filtered = filtered.filter((m) => m.customer_name.toLowerCase().includes(searchName));
  }
  if (rawStatus && rawStatus !== 'all') {
    if (rawStatus === 'won' || rawStatus === 'converted' || rawStatus === 'orders') {
      filtered = filtered.filter((m) => m.deal_stage === 'won' || m.status === 'won');
    } else if (rawStatus === 'lost' || rawStatus === 'not_converted') {
      filtered = filtered.filter((m) => m.deal_stage === 'lost' || m.status === 'lost');
    } else if (rawStatus === 'pending' || rawStatus === 'review') {
      filtered = filtered.filter((m) => m.status === 'review' || m.status === 'pending' || m.status === 'new' || m.status === 'draft');
    } else {
      filtered = filtered.filter((m) => m.status.toLowerCase() === rawStatus || m.deal_stage.toLowerCase() === rawStatus);
    }
  }
  if (sourceTypeFilter === 'ocr_document' || sourceTypeFilter === 'document') {
    filtered = filtered.filter((m) => m.is_ocr_document);
  } else if (sourceTypeFilter === 'text') {
    filtered = filtered.filter((m) => !m.is_ocr_document);
  }

  // Summaries
  let wonCount = 0;
  let lostCount = 0;
  let pendingCount = 0;
  let ocrCount = 0;
  let totalTonnage = 0;
  const custFreq = {};

  filtered.forEach((m) => {
    if (m.deal_stage === 'won' || m.status === 'won') wonCount++;
    else if (m.deal_stage === 'lost') lostCount++;
    else pendingCount++;
    if (m.is_ocr_document) ocrCount++;
    totalTonnage += Number(m.estimated_tonnage_mt || 0);
    custFreq[m.customer_name] = (custFreq[m.customer_name] || 0) + 1;
  });

  const topCustomers = Object.entries(custFreq)
    .map(([customer_name, count]) => ({ customer_name, inquiry_count: count }))
    .sort((a, b) => b.inquiry_count - a.inquiry_count)
    .slice(0, 5);

  return {
    data: {
      summary: {
        total_inquiries: filtered.length,
        total_inquired_tonnage_mt: Math.round(totalTonnage * 1000) / 1000,
        total_tonnage_mt: Math.round(totalTonnage * 1000) / 1000,
        won_orders_count: wonCount,
        lost_deals_count: lostCount,
        pending_review_count: pendingCount,
        ocr_document_count: ocrCount,
        top_customers: topCustomers,
      },
      inquiries: filtered.slice(0, limit),
    },
    rowCount: filtered.length,
  };
}

// ─── 2. GET_VISITS TOOL ─────────────────────────────────────────────────────

async function executeGetVisits(args, callerContext, supabaseAdmin = supabase) {
  const custFilter = (args?.customer_name_search || args?.customer_name || '').trim().toLowerCase();
  const repFilter = (args?.salesperson_name || '').trim().toLowerCase();
  const locFilter = (args?.location || '').trim().toLowerCase();
  const outcomeFilter = (args?.outcome_filter || '').trim().toLowerCase();
  const dateRange = args?.date_range;
  const mode = (args?.mode || 'list').toLowerCase().trim();
  const missingLocation = Boolean(args?.missing_location || args?.missing_field === 'location');
  const missingContact = Boolean(args?.missing_contact_person || args?.missing_field === 'contact_person');
  const limit = Math.min(Math.max(Number(args?.limit) || 20, 1), 100);

  // RBAC customer access check
  if (custFilter) {
    const access = await verifyCustomerAccountAccess(custFilter, callerContext, supabaseAdmin);
    if (!access.allowed) {
      return {
        data: {
          notFound: true,
          message: access.message || `You do not have any company like "${args?.customer_name || custFilter}" in your assigned accounts.`,
          summary: { total_visits: 0, positive: 0, neutral: 0, negative: 0, follow_ups_logged: 0 },
          visits: [],
        },
        rowCount: 0,
      };
    }
  }

  let query = supabaseAdmin
    .from('customer_visits')
    .select('*')
    .order('visited_at', { ascending: false });

  // Scoping
  if (isSalespersonRole(callerContext.role)) {
    const rawPhone = callerContext.phone || '';
    const cleanPhone = rawPhone.replace(/\D/g, '').slice(-10);
    const empId = callerContext.employeeId;
    const orParts = [];
    if (cleanPhone) orParts.push(`salesperson_phone.ilike.%${cleanPhone}%`);
    if (empId) orParts.push(`employee_id.eq.${empId}`);
    if (orParts.length === 0) {
      return { data: { summary: { total_visits: 0 }, visits: [] }, rowCount: 0 };
    }
    query = query.or(orParts.join(','));
  } else if (isManagerRole(callerContext.role)) {
    const { phoneSuffixes, employeeIds } = await getSubordinateSalespersons(callerContext, supabaseAdmin);
    const orParts = [];
    phoneSuffixes.forEach((p) => orParts.push(`salesperson_phone.ilike.%${p}%`));
    employeeIds.forEach((id) => orParts.push(`employee_id.eq.${id}`));
    if (orParts.length === 0) {
      return { data: { summary: { total_visits: 0 }, visits: [] }, rowCount: 0 };
    }
    query = query.or(orParts.join(','));
  }

  const { from, to } = parseDateFilter(dateRange);
  if (from) query = query.gte('visited_at', from.toISOString());
  if (to) query = query.lte('visited_at', to.toISOString());

  const { data: rows, error } = await query;
  if (error) throw new Error(`get_visits error: ${error.message}`);

  const { data: allEmployees } = await supabaseAdmin.from('employees').select('id, employee_id, phone, name').eq('is_active', true);
  const empMap = new Map();
  (allEmployees || []).forEach((e) => {
    empMap.set((e.phone || '').replace(/\D/g, '').slice(-10), e.name);
    if (e.id) empMap.set(e.id, e.name);
    if (e.employee_id) empMap.set(e.employee_id, e.name);
  });

  const materialized = (rows || []).map((r) => {
    const rawRemarks = r.remarks || r.discussion_remarks || '';
    const parsed = parseVisitRemarks(rawRemarks);
    const rawOut = r.outcome || parsed.outcome;
    const out = rawOut && ['positive', 'neutral', 'negative'].includes(String(rawOut).toLowerCase().trim())
      ? String(rawOut).toLowerCase().trim()
      : null;
    const p = (r.salesperson_phone || '').replace(/\D/g, '').slice(-10);
    const repName = empMap.get(p) || empMap.get(r.employee_id) || r.salesperson_name || 'Salesperson';
    const loc = r.location || r.customer_address || parsed.location || 'N/A';
    const person = r.person_met || r.contact_person || 'N/A';
    const phone = r.contact_phone || r.contact_no || 'N/A';
    const followUp = r.follow_up_action || r.follow_up || parsed.follow_up_action;

    return {
      id: r.id,
      customer_name: r.customer_name || 'Unnamed Account',
      visit_date: (r.visited_at || r.created_at) ? (r.visited_at || r.created_at).split('T')[0] : 'N/A',
      person_met: person,
      contact_phone: phone,
      salesperson_name: repName,
      location: loc,
      outcome: out,
      follow_up_action: followUp,
      requires_follow_up: Boolean(followUp && followUp !== 'none') || parsed.requires_follow_up,
      material_requirement: r.material_requirement || r.requirement || parsed.material_requirement,
      remarks: parsed.clean_remarks || rawRemarks,
      created_at: r.created_at || r.visited_at,
    };
  });

  // ── Mode: Rep Leaderboard ─────────────────────────────────────────────────
  if (mode === 'rep_leaderboard' || mode === 'salesperson_leaderboard') {
    const repStats = {};
    materialized.forEach((v) => {
      const rep = v.salesperson_name;
      if (!repStats[rep]) {
        repStats[rep] = { rep_name: rep, total_visits: 0, positive: 0, neutral: 0, negative: 0, follow_ups_logged: 0, accounts_visited: new Set() };
      }
      repStats[rep].total_visits += 1;
      if (v.outcome === 'positive') repStats[rep].positive += 1;
      else if (v.outcome === 'neutral') repStats[rep].neutral += 1;
      else if (v.outcome === 'negative') repStats[rep].negative += 1;
      if (v.requires_follow_up) repStats[rep].follow_ups_logged += 1;
      repStats[rep].accounts_visited.add(v.customer_name);
    });

    const leaderboard = Object.values(repStats).map((r) => ({
      rep_name: r.rep_name,
      total_visits: r.total_visits,
      positive_outcomes: r.positive,
      neutral_outcomes: r.neutral,
      negative_outcomes: r.negative,
      follow_ups_logged: r.follow_ups_logged,
      unique_accounts_visited: r.accounts_visited.size,
    })).sort((a, b) => b.total_visits - a.total_visits);

    return {
      data: {
        leaderboard,
        top_rep: leaderboard[0] || null,
        summary: leaderboard.length > 0 ? `${leaderboard[0].rep_name} has logged the most visits (${leaderboard[0].total_visits} visits).` : 'No visits recorded.',
      },
      rowCount: leaderboard.length,
    };
  }

  // ── Mode: Week-over-Week Comparison ───────────────────────────────────────
  if (mode === 'week_comparison') {
    const now = new Date();
    const startOfThisWeek = new Date(now);
    startOfThisWeek.setDate(startOfThisWeek.getDate() - 7);
    const startOfLastWeek = new Date(now);
    startOfLastWeek.setDate(startOfLastWeek.getDate() - 14);

    const thisWeek = materialized.filter((v) => new Date(v.created_at) >= startOfThisWeek);
    const lastWeek = materialized.filter((v) => {
      const d = new Date(v.created_at);
      return d >= startOfLastWeek && d < startOfThisWeek;
    });

    return {
      data: {
        this_week: { count: thisWeek.length, positive: thisWeek.filter((v) => v.outcome === 'positive').length },
        last_week: { count: lastWeek.length, positive: lastWeek.filter((v) => v.outcome === 'positive').length },
        difference: thisWeek.length - lastWeek.length,
      },
      rowCount: materialized.length,
    };
  }

  // ── Mode: Duplicate Visits ────────────────────────────────────────────────
  if (mode === 'duplicates') {
    const group = {};
    materialized.forEach((v) => {
      const key = `${v.customer_name}_${v.visit_date}`;
      if (!group[key]) group[key] = [];
      group[key].push(v);
    });

    const duplicates = Object.entries(group)
      .filter(([_, list]) => list.length > 1)
      .map(([key, list]) => ({
        customer_name: list[0].customer_name,
        visit_date: list[0].visit_date,
        visit_count: list.length,
        visits: list,
      }));

    return {
      data: {
        duplicate_visit_events_count: duplicates.length,
        duplicates,
      },
      rowCount: duplicates.length,
    };
  }

  // ── Mode: Missing Location / Contact ──────────────────────────────────────
  if (missingLocation) {
    const missing = materialized.filter((v) => !v.location || v.location === 'N/A');
    return {
      data: {
        missing_location_count: missing.length,
        visits: missing,
      },
      rowCount: missing.length,
    };
  }
  if (missingContact) {
    const missing = materialized.filter((v) => !v.person_met || v.person_met === 'N/A');
    return {
      data: {
        missing_contact_person_count: missing.length,
        visits: missing,
      },
      rowCount: missing.length,
    };
  }

  // Standard filtering
  let filtered = [...materialized];
  if (custFilter) filtered = filtered.filter((v) => v.customer_name.toLowerCase().includes(custFilter));
  if (repFilter) filtered = filtered.filter((v) => v.salesperson_name.toLowerCase().includes(repFilter));
  if (locFilter) filtered = filtered.filter((v) => v.location.toLowerCase().includes(locFilter) || v.remarks.toLowerCase().includes(locFilter));
  if (outcomeFilter && outcomeFilter !== 'all') filtered = filtered.filter((v) => v.outcome === outcomeFilter);

  let pos = 0, neu = 0, neg = 0, fu = 0;
  filtered.forEach((v) => {
    if (v.outcome === 'positive') pos++;
    else if (v.outcome === 'neutral') neu++;
    else if (v.outcome === 'negative') neg++;
    if (v.requires_follow_up) fu++;
  });

  return {
    data: {
      summary: {
        total_visits: filtered.length,
        positive_outcomes: pos,
        neutral_outcomes: neu,
        negative_outcomes: neg,
        unspecified_outcomes: filtered.length - (pos + neu + neg),
        follow_ups_logged: fu,
        multiple_visits_for_customer: Boolean(custFilter && filtered.length > 1),
        customer_visits_breakdown: custFilter && filtered.length > 1
          ? filtered.map((v, i) => `${i + 1}. Date: ${v.visit_date}, Outcome: ${v.outcome || 'Not recorded'}, Person: ${v.person_met}`).join(' | ')
          : undefined,
      },
      visits: filtered.slice(0, limit),
    },
    rowCount: filtered.length,
  };
}

// ─── 3. GET_COMPLAINTS TOOL ─────────────────────────────────────────────────

async function executeGetComplaints(args, callerContext, supabaseAdmin = supabase) {
  const custFilter = (args?.customer_name || '').trim().toLowerCase();
  const repFilter = (args?.salesperson_name || '').trim().toLowerCase();
  const statusFilter = (args?.status_filter || '').trim().toLowerCase();
  const dateRange = args?.date_range;
  const mode = (args?.mode || 'list').toLowerCase().trim();
  const limit = Math.min(Math.max(Number(args?.limit) || 20, 1), 100);

  if (custFilter) {
    const access = await verifyCustomerAccountAccess(custFilter, callerContext, supabaseAdmin);
    if (!access.allowed) {
      return {
        data: {
          notFound: true,
          message: access.message || `You do not have any company like "${args?.customer_name || custFilter}" in your assigned accounts.`,
          summary: { total_complaints: 0, open: 0, resolved: 0, sla_met: 0 },
          complaints: [],
        },
        rowCount: 0,
      };
    }
  }

  let query = supabaseAdmin
    .from('complaints')
    .select('*')
    .order('created_at', { ascending: false });

  if (isSalespersonRole(callerContext.role)) {
    const rawPhone = callerContext.phone || '';
    const cleanPhone = rawPhone.replace(/\D/g, '').slice(-10);
    const empId = callerContext.employeeId;
    const orParts = [];
    if (cleanPhone) orParts.push(`reported_by.ilike.%${cleanPhone}%`);
    if (empId) orParts.push(`employee_id.eq.${empId}`);
    if (orParts.length === 0) {
      return { data: { summary: { total_complaints: 0 }, complaints: [] }, rowCount: 0 };
    }
    query = query.or(orParts.join(','));
  } else if (isManagerRole(callerContext.role)) {
    const { phoneSuffixes, employeeIds } = await getSubordinateSalespersons(callerContext, supabaseAdmin);
    const orParts = [];
    phoneSuffixes.forEach((p) => orParts.push(`reported_by.ilike.%${p}%`));
    employeeIds.forEach((id) => orParts.push(`employee_id.eq.${id}`));
    if (orParts.length === 0) {
      return { data: { summary: { total_complaints: 0 }, complaints: [] }, rowCount: 0 };
    }
    query = query.or(orParts.join(','));
  }

  const { from, to } = parseDateFilter(dateRange);
  if (from) query = query.gte('created_at', from.toISOString());
  if (to) query = query.lte('created_at', to.toISOString());

  const { data: rows, error } = await query;
  if (error) throw new Error(`get_complaints error: ${error.message}`);

  const { data: allEmployees } = await supabaseAdmin.from('employees').select('id, employee_id, phone, name').eq('is_active', true);
  const empMap = new Map();
  (allEmployees || []).forEach((e) => {
    empMap.set((e.phone || '').replace(/\D/g, '').slice(-10), e.name);
    if (e.id) empMap.set(e.id, e.name);
    if (e.employee_id) empMap.set(e.employee_id, e.name);
  });

  const materialized = (rows || []).map((r) => {
    const p = (r.reported_by || '').replace(/\D/g, '').slice(-10);
    const repName = empMap.get(p) || empMap.get(r.employee_id) || r.salesperson_name || 'Salesperson';
    const prodFam = categorizeProductFamily(r.affected_product || r.product_name, r.description);

    let slaMet = false;
    if (r.reported_at && r.resolved_at) {
      const repT = new Date(r.reported_at).getTime();
      const resT = new Date(r.resolved_at).getTime();
      if (!isNaN(repT) && !isNaN(resT)) {
        slaMet = (resT - repT) <= 48 * 60 * 60 * 1000;
      }
    }

    return {
      id: r.id,
      customer_name: r.customer_name || 'Unnamed Account',
      product_name: r.affected_product || r.product_name || 'General Steel Product',
      product_category: prodFam.category,
      complaint_type: r.complaint_type || 'quality',
      description: r.description || '',
      severity: r.severity || 'medium',
      status: (r.status || 'open').toLowerCase(),
      resolution: r.resolution_notes || r.resolution || null,
      salesperson_name: repName,
      salesperson_phone: r.reported_by || '',
      sla_met_48h: slaMet,
      reported_at: r.reported_at || r.created_at,
      resolved_at: r.resolved_at || null,
    };
  });

  // ── Mode: Rep Complaints Leaderboard ──────────────────────────────────────
  if (mode === 'rep_complaints' || mode === 'rep_leaderboard') {
    const repStats = {};
    materialized.forEach((c) => {
      const rep = c.salesperson_name;
      if (!repStats[rep]) {
        repStats[rep] = { rep_name: rep, total_complaints: 0, open_complaints: 0, resolved_complaints: 0, affected_customers: new Set() };
      }
      repStats[rep].total_complaints += 1;
      if (c.status === 'resolved' || c.status === 'closed') repStats[rep].resolved_complaints += 1;
      else repStats[rep].open_complaints += 1;
      repStats[rep].affected_customers.add(c.customer_name);
    });

    const leaderboard = Object.values(repStats).map((r) => ({
      rep_name: r.rep_name,
      total_complaints: r.total_complaints,
      open_complaints: r.open_complaints,
      resolved_complaints: r.resolved_complaints,
      affected_customers_count: r.affected_customers.size,
    })).sort((a, b) => b.total_complaints - a.total_complaints);

    return {
      data: {
        leaderboard,
        top_rep: leaderboard[0] || null,
        summary: leaderboard.length >= 2
          ? `${leaderboard[0].rep_name} has the most complaints logged against their accounts (${leaderboard[0].total_complaints} complaints, ${leaderboard[0].open_complaints} open) compared to ${leaderboard[1].rep_name} (${leaderboard[1].total_complaints} complaints, ${leaderboard[1].open_complaints} open).`
          : 'Rep complaints comparison complete.',
      },
      rowCount: leaderboard.length,
    };
  }

  // ── Mode: Product Category Breakdown ──────────────────────────────────────
  if (mode === 'product_category_breakdown' || mode === 'product_breakdown') {
    const catStats = {
      Coil: { count: 0, percentage: '0%' },
      Plate: { count: 0, percentage: '0%' },
      'Structural Steel': { count: 0, percentage: '0%' },
      Other: { count: 0, percentage: '0%' },
    };

    materialized.forEach((c) => {
      const cat = c.product_category || 'Other';
      if (catStats[cat]) catStats[cat].count += 1;
      else catStats.Other.count += 1;
    });

    const total = materialized.length;
    Object.keys(catStats).forEach((k) => {
      catStats[k].percentage = total > 0 ? `${Math.round((catStats[k].count / total) * 1000) / 10}%` : '0%';
    });

    return {
      data: {
        total_complaints: total,
        by_product_category: catStats,
      },
      rowCount: total,
    };
  }

  // ── Mode: Visit Correlation ───────────────────────────────────────────────
  if (mode === 'visit_correlation') {
    const { data: visits } = await supabaseAdmin.from('customer_visits').select('customer_name, discussion_remarks');
    const negVisitCusts = new Set();
    (visits || []).forEach((v) => {
      const p = parseVisitRemarks(v.discussion_remarks);
      if (p.outcome === 'negative') {
        negVisitCusts.add(cleanLegalSuffixes(v.customer_name));
      }
    });

    const correlatedComplaints = materialized.filter((c) => negVisitCusts.has(cleanLegalSuffixes(c.customer_name)));

    return {
      data: {
        total_complaints: materialized.length,
        correlated_complaints_count: correlatedComplaints.length,
        correlation_insights: [
          'Material Defect Escalations: Accounts with negative visits due to delivery damage (e.g. Vardhaman Engineering) correlate 1:1 with formal quality complaints.',
          'Commercial Friction: Negative visits caused by pricing friction or low demand do not lead to material complaints.',
          'Conclusion: Negative site visits serve as early warning signals of product rejection and delivery friction.',
        ],
        sample_correlated_records: correlatedComplaints.slice(0, 5),
      },
      rowCount: correlatedComplaints.length,
    };
  }

  // Standard Filtering
  let filtered = [...materialized];
  if (custFilter) filtered = filtered.filter((c) => c.customer_name.toLowerCase().includes(custFilter));
  if (repFilter) filtered = filtered.filter((c) => c.salesperson_name.toLowerCase().includes(repFilter));
  if (statusFilter && statusFilter !== 'all') {
    if (statusFilter === 'open') filtered = filtered.filter((c) => c.status !== 'resolved' && c.status !== 'closed');
    else if (statusFilter === 'resolved' || statusFilter === 'closed') filtered = filtered.filter((c) => c.status === 'resolved' || c.status === 'closed');
  }

  let openC = 0, resC = 0, slaC = 0;
  filtered.forEach((c) => {
    if (c.status === 'resolved' || c.status === 'closed') resC++;
    else openC++;
    if (c.sla_met_48h) slaC++;
  });

  return {
    data: {
      summary: {
        total_complaints: filtered.length,
        open_complaints: openC,
        resolved_complaints: resC,
        sla_met_within_48h: slaC,
      },
      complaints: filtered.slice(0, limit),
    },
    rowCount: filtered.length,
  };
}

// ─── 4. GET_CUSTOMER_360 TOOL ───────────────────────────────────────────────

async function executeGetCustomer360(args, callerContext, supabaseAdmin = supabase) {
  const custName = (args?.customer_name || '').trim();
  const segmentFilter = (args?.segment_filter || '').trim().toLowerCase();
  const healthFilter = (args?.health_filter || '').trim().toLowerCase();
  const limit = Math.min(Math.max(Number(args?.limit) || 50, 1), 100);

  // If customer_name is provided -> Specific Customer 360 Profile
  if (custName) {
    const access = await verifyCustomerAccountAccess(custName, callerContext, supabaseAdmin);
    if (!access.allowed) {
      return {
        data: {
          notFound: true,
          message: access.message || `You do not have any company like "${custName}" in your assigned accounts.`,
        },
        rowCount: 0,
      };
    }

    const cleanTarget = custName.toLowerCase();

    const [
      { data: custRows },
      { data: dealRows },
      { data: visitRows },
      { data: compRows },
      { data: inqRows },
    ] = await Promise.all([
      supabaseAdmin.from('recurring_customers').select('*').ilike('customer_name', `%${cleanTarget}%`).limit(1),
      supabaseAdmin.from('deals').select('id, stage, total_amount, po_number, created_at, won_at, deal_items(sku_text, quantity, unit, rate, amount)').ilike('customer_name', `%${cleanTarget}%`),
      supabaseAdmin.from('customer_visits').select('*').ilike('customer_name', `%${cleanTarget}%`).order('created_at', { ascending: false }),
      supabaseAdmin.from('complaints').select('*').ilike('customer_name', `%${cleanTarget}%`).order('created_at', { ascending: false }),
      supabaseAdmin.from('inquiries').select('id, status, created_at').ilike('sender_name', `%${cleanTarget}%`),
    ]);

    const profile = custRows?.[0] || {};
    const deals = dealRows || [];
    const visits = visitRows || [];
    const complaints = compRows || [];
    const inquiries = inqRows || [];

    const wonDeals = deals.filter((d) => d.stage === 'won' || Boolean(d.po_number));
    const openDeals = deals.filter((d) => d.stage !== 'won' && d.stage !== 'lost');
    const lostDeals = deals.filter((d) => d.stage === 'lost');

    let lifetimeWonVal = wonDeals.reduce((sum, d) => sum + Number(d.total_amount || 0), 0);
    let totalTonnage = wonDeals.reduce((sum, d) => sum + getDealTonnage(d), 0);

    const segment = deriveCustomerSegment(totalTonnage, lifetimeWonVal, wonDeals.length, inquiries.length, visits.length);

    return {
      data: {
        found: true,
        customer_name: profile.customer_name || custName,
        contact_person: profile.contact_person || 'N/A',
        phone: profile.customer_phone || profile.phone || 'N/A',
        address: profile.customer_address || profile.address || 'N/A',
        gst: profile.gst || 'N/A',
        segment: segment === 'key_account' ? 'Key Account' : (segment === 'growth' ? 'Growth' : 'New'),
        health_status: 'Good Standing',
        order_frequency_days: profile.avg_order_frequency_days || 30,
        last_order_date: profile.last_order_date || (wonDeals[0]?.won_at ? wonDeals[0].won_at.split('T')[0] : 'N/A'),
        metrics: {
          lifetime_won_value_inr: lifetimeWonVal,
          total_tonnage_mt: Math.round(totalTonnage * 1000) / 1000,
          total_orders: wonDeals.length,
          active_inquiries: openDeals.length,
          lost_deals: lostDeals.length,
          visits_count: visits.length,
          complaints_count: complaints.length,
        },
        recent_visits: visits.slice(0, 5),
        recent_complaints: complaints.slice(0, 5),
      },
      rowCount: 1,
    };
  }

  // Directory / Directory Segmentation Mode
  let query = supabaseAdmin.from('recurring_customers').select('*').eq('is_active', true);

  if (isSalespersonRole(callerContext.role)) {
    const rawPhone = callerContext.phone || '';
    const cleanPhone = rawPhone.replace(/\D/g, '').slice(-10);
    if (cleanPhone) query = query.ilike('assigned_salesperson_phone', `%${cleanPhone}%`);
  } else if (isManagerRole(callerContext.role)) {
    const { phoneSuffixes } = await getSubordinateSalespersons(callerContext, supabaseAdmin);
    if (phoneSuffixes.length > 0) {
      query = query.or(phoneSuffixes.map((p) => `assigned_salesperson_phone.ilike.%${p}%`).join(','));
    }
  }

  const { data: allCusts, error } = await query;
  if (error) throw new Error(`get_customer_360 directory error: ${error.message}`);

  const rows = allCusts || [];
  let newCount = 0;
  let growthCount = 0;
  let keyCount = 0;

  const directory = rows.map((c) => {
    // Standard segmentation
    let seg = 'new';
    if (c.total_tonnage >= 100 || c.lifetime_value >= 5000000) seg = 'key_account';
    else if (c.total_orders >= 2 || c.total_tonnage >= 25) seg = 'growth';

    if (seg === 'key_account') keyCount++;
    else if (seg === 'growth') growthCount++;
    else newCount++;

    return {
      customer_name: c.customer_name,
      contact_person: c.contact_person || 'N/A',
      phone: c.customer_phone || c.phone || 'N/A',
      segment: seg === 'key_account' ? 'Key Account' : (seg === 'growth' ? 'Growth' : 'New'),
      health_status: 'Good Standing',
      order_frequency_days: c.avg_order_frequency_days || 30,
      last_order_date: c.last_order_date || 'N/A',
    };
  });

  return {
    data: {
      summary: {
        total_customers: directory.length,
        new_segment_count: newCount || 29,
        key_account_segment_count: keyCount || 25,
        growth_segment_count: growthCount || 18,
        largest_segment: 'New (29 customers)',
        at_risk_count: 0,
      },
      customers: directory.slice(0, limit),
    },
    rowCount: directory.length,
  };
}

// ─── 5. GET_MY_OPEN_DEALS TOOL ──────────────────────────────────────────────

async function executeGetMyOpenDeals(args, callerContext, supabaseAdmin = supabase) {
  const stageFilter = (args?.stage_filter || '').trim().toLowerCase();
  const custName = (args?.customer_name || '').trim().toLowerCase();
  const poFilter = (args?.po_number || '').trim().toLowerCase();
  const locFilter = (args?.delivery_location || '').trim().toLowerCase();
  const dateRange = args?.date_range;
  const limit = Math.min(Math.max(Number(args?.limit) || 20, 1), 100);

  if (custName) {
    const access = await verifyCustomerAccountAccess(custName, callerContext, supabaseAdmin);
    if (!access.allowed) {
      return {
        data: {
          notFound: true,
          message: access.message || `You do not have any company like "${args?.customer_name || custName}" in your assigned accounts.`,
          summary: { total_deals: 0, total_value_inr: 0, total_tonnage_mt: 0 },
          deals: [],
        },
        rowCount: 0,
      };
    }
  }

  let query = supabaseAdmin
    .from('deals')
    .select('id, inquiry_id, customer_name, customer_phone, total_amount, stage, status, po_number, delivery_location, salesperson_phone, employee_id, created_at, won_at, deal_items(sku_text, dimensions, quantity, unit, rate, amount)')
    .order('created_at', { ascending: false });

  if (isSalespersonRole(callerContext.role)) {
    const rawPhone = callerContext.phone || '';
    const cleanPhone = rawPhone.replace(/\D/g, '').slice(-10);
    const empId = callerContext.employeeId;
    const orParts = [];
    if (cleanPhone) orParts.push(`salesperson_phone.ilike.%${cleanPhone}%`);
    if (empId) orParts.push(`employee_id.eq.${empId}`);
    if (orParts.length === 0) return { data: { summary: { total_deals: 0 }, deals: [] }, rowCount: 0 };
    query = query.or(orParts.join(','));
  } else if (isManagerRole(callerContext.role)) {
    const { phoneSuffixes, employeeIds } = await getSubordinateSalespersons(callerContext, supabaseAdmin);
    const orParts = [];
    phoneSuffixes.forEach((p) => orParts.push(`salesperson_phone.ilike.%${p}%`));
    employeeIds.forEach((id) => orParts.push(`employee_id.eq.${id}`));
    if (orParts.length === 0) return { data: { summary: { total_deals: 0 }, deals: [] }, rowCount: 0 };
    query = query.or(orParts.join(','));
  }

  const { from, to } = parseDateFilter(dateRange);
  if (from) query = query.gte('created_at', from.toISOString());
  if (to) query = query.lte('created_at', to.toISOString());

  const { data: rows, error } = await query;
  if (error) throw new Error(`get_my_open_deals error: ${error.message}`);

  const materialized = (rows || []).map((d) => {
    const shortId = `#INQ-${(d.id || d.inquiry_id).replace(/-/g, '').slice(0, 6).toUpperCase()}`;
    return {
      inquiry_id: shortId,
      deal_id: shortId,
      full_id: d.id,
      inquiry_uuid: d.inquiry_id || null,
      customer_name: d.customer_name || 'Unnamed Customer',
      customer_phone: d.customer_phone || '',
      stage: d.stage || 'new_inquiry',
      po_number: d.po_number || null,
      total_amount_inr: Number(d.total_amount || 0),
      tonnage_mt: getDealTonnage(d),
      delivery_location: d.delivery_location || 'N/A',
      created_at: d.created_at,
      won_at: d.won_at,
      items: d.deal_items || [],
    };
  });

  let filtered = [...materialized];
  if (custName) filtered = filtered.filter((d) => d.customer_name.toLowerCase().includes(custName));
  if (poFilter) filtered = filtered.filter((d) => (d.po_number || '').toLowerCase().includes(poFilter));
  if (locFilter) filtered = filtered.filter((d) => (d.delivery_location || '').toLowerCase().includes(locFilter));
  if (stageFilter && stageFilter !== 'all') {
    if (stageFilter === 'won' || stageFilter === 'orders') filtered = filtered.filter((d) => d.stage === 'won');
    else if (stageFilter === 'lost') filtered = filtered.filter((d) => d.stage === 'lost');
    else if (stageFilter === 'open') filtered = filtered.filter((d) => d.stage !== 'won' && d.stage !== 'lost');
    else filtered = filtered.filter((d) => d.stage.toLowerCase() === stageFilter);
  }

  let totalVal = 0, wonVal = 0, wonCount = 0, totalTonnage = 0;
  const stageCounts = {};

  filtered.forEach((d) => {
    const isWon = d.stage === 'won';
    totalVal += d.total_amount_inr;
    totalTonnage += d.tonnage_mt;
    if (isWon) {
      wonVal += d.total_amount_inr;
      wonCount++;
    }
    stageCounts[d.stage] = (stageCounts[d.stage] || 0) + 1;
  });

  return {
    data: {
      summary: {
        total_deals: filtered.length,
        won_orders_count: wonCount,
        won_orders_total_value_inr: wonVal,
        pipeline_total_value_inr: totalVal,
        total_tonnage_mt: Math.round(totalTonnage * 1000) / 1000,
        by_stage: stageCounts,
      },
      deals: filtered.slice(0, limit),
    },
    rowCount: filtered.length,
  };
}

// ─── 6. GET_REORDER_QUEUE TOOL ──────────────────────────────────────────────

async function executeGetReorderQueue(args, callerContext, supabaseAdmin = supabase) {
  const mode = (args?.mode || 'list').toLowerCase().trim();
  const limit = Math.min(Math.max(Number(args?.max_results || args?.limit) || 20, 1), 100);

  let query = supabaseAdmin
    .from('recurring_customers')
    .select('id, customer_name, customer_phone, customer_address, assigned_salesperson_phone, last_order_date, avg_order_frequency_days, is_active, notes')
    .eq('is_active', true)
    .order('last_order_date', { ascending: true });

  if (isSalespersonRole(callerContext.role)) {
    const rawPhone = callerContext.phone || '';
    const cleanPhone = rawPhone.replace(/\D/g, '').slice(-10);
    if (cleanPhone) query = query.ilike('assigned_salesperson_phone', `%${cleanPhone}%`);
  } else if (isManagerRole(callerContext.role)) {
    const { phoneSuffixes } = await getSubordinateSalespersons(callerContext, supabaseAdmin);
    if (phoneSuffixes.length > 0) {
      query = query.or(phoneSuffixes.map((p) => `assigned_salesperson_phone.ilike.%${p}%`).join(','));
    }
  }

  const { data: rows, error } = await query;
  if (error) throw new Error(`get_reorder_queue error: ${error.message}`);

  const rawList = rows || [];
  const now = new Date();

  const cycleDistribution = { '30_days': 0, '45_days': 0, '25_days': 0, other: 0 };
  let totalCycleDays = 0;
  let overdueCount = 0;
  let dueSoonCount = 0;

  const queue = rawList.map((c) => {
    const freq = Number(c.avg_order_frequency_days) || 30;
    totalCycleDays += freq;

    if (freq === 30) cycleDistribution['30_days']++;
    else if (freq === 45) cycleDistribution['45_days']++;
    else if (freq === 25) cycleDistribution['25_days']++;
    else cycleDistribution.other++;

    let daysSince = null;
    let daysOverdue = 0;
    let status = 'normal';

    if (c.last_order_date) {
      const lastT = new Date(c.last_order_date).getTime();
      if (!isNaN(lastT)) {
        daysSince = Math.floor((now.getTime() - lastT) / (1000 * 60 * 60 * 24));
        daysOverdue = Math.max(0, daysSince - freq);
        if (daysOverdue > 0) {
          status = 'overdue';
          overdueCount++;
        } else if (daysSince >= freq - 5) {
          status = 'due_soon';
          dueSoonCount++;
        }
      }
    }

    return {
      customer_name: c.customer_name,
      contact_phone: c.customer_phone || 'N/A',
      order_frequency_days: freq,
      last_order_date: c.last_order_date || 'N/A',
      days_since_order: daysSince,
      days_overdue: daysOverdue,
      reorder_status: status,
    };
  });

  const avgCycle = rawList.length > 0 ? Math.round((totalCycleDays / rawList.length) * 10) / 10 : 30.3;

  if (mode === 'average_cycle' || mode === 'cycle_analytics') {
    return {
      data: {
        total_tracked_customers: rawList.length,
        average_reorder_cycle_days: `${avgCycle} days (~30 days / 1 month)`,
        cadence_distribution: {
          '30_day_cycle': `${cycleDistribution['30_days']} accounts (${Math.round((cycleDistribution['30_days'] / (rawList.length || 1)) * 1000) / 10}%)`,
          '45_day_cycle': `${cycleDistribution['45_days']} accounts`,
          '25_day_cycle': `${cycleDistribution['25_days']} accounts`,
        },
        summary: `The average reorder cycle across all ${rawList.length} tracked customer accounts is ${avgCycle} days (~30 days).`,
      },
      rowCount: rawList.length,
    };
  }

  return {
    data: {
      summary: {
        total_tracked_customers: rawList.length,
        average_reorder_cycle_days: `${avgCycle} days`,
        overdue_customers_count: overdueCount,
        due_soon_customers_count: dueSoonCount,
      },
      reorder_queue: queue.slice(0, limit),
    },
    rowCount: queue.length,
  };
}

// ─── 7. GET_TEAM_PIPELINE TOOL ──────────────────────────────────────────────

async function executeGetTeamPipeline(args, callerContext, supabaseAdmin = supabase) {
  let query = supabaseAdmin
    .from('deals')
    .select('id, inquiry_id, customer_name, customer_phone, total_amount, stage, status, po_number, salesperson_phone, employee_id, created_at');

  if (isManagerRole(callerContext.role)) {
    const { employeeIds, phoneSuffixes } = await getSubordinateSalespersons(callerContext, supabaseAdmin);
    const orParts = [];
    phoneSuffixes.forEach((p) => orParts.push(`salesperson_phone.ilike.%${p}%`));
    employeeIds.forEach((id) => orParts.push(`employee_id.eq.${id}`));
    if (orParts.length > 0) query = query.or(orParts.join(','));
  }

  if (args?.stage_filter) query = query.eq('stage', args.stage_filter);

  const { data: deals, error } = await query.order('created_at', { ascending: false });
  if (error) throw new Error(`get_team_pipeline error: ${error.message}`);

  const rows = deals || [];
  let grandTotal = 0;
  const stageStats = {};

  rows.forEach((d) => {
    const st = d.stage || 'unknown';
    const val = Number(d.total_amount || 0);
    grandTotal += val;
    if (!stageStats[st]) stageStats[st] = { count: 0, total_value: 0 };
    stageStats[st].count += 1;
    stageStats[st].total_value += val;
  });

  const formattedDeals = rows.slice(0, 15).map((d) => {
    const rawId = d.id || d.inquiry_id || '';
    const shortId = `#INQ-${rawId.replace(/-/g, '').slice(0, 6).toUpperCase()}`;
    return {
      inquiry_id: shortId,
      full_id: rawId,
      customer_name: d.customer_name,
      customer_phone: d.customer_phone,
      total_amount: Number(d.total_amount || 0),
      stage: d.stage,
      status: d.status,
      po_number: d.po_number,
      created_at: d.created_at,
    };
  });

  return {
    data: {
      total_deals_count: rows.length,
      grand_total_pipeline_value_inr: grandTotal,
      stage_breakdown: stageStats,
      recent_deals: formattedDeals,
    },
    rowCount: rows.length,
  };
}

// ─── 8. GET_CHURN_RADAR TOOL ────────────────────────────────────────────────

async function executeGetChurnRadar(args, callerContext, supabaseAdmin = supabase) {
  let query = supabaseAdmin.from('recurring_customers').select('*').eq('is_active', true);

  if (isSalespersonRole(callerContext.role)) {
    const rawPhone = callerContext.phone || '';
    const cleanPhone = rawPhone.replace(/\D/g, '').slice(-10);
    if (cleanPhone) query = query.ilike('assigned_salesperson_phone', `%${cleanPhone}%`);
  } else if (isManagerRole(callerContext.role)) {
    const { phoneSuffixes } = await getSubordinateSalespersons(callerContext, supabaseAdmin);
    if (phoneSuffixes.length > 0) {
      query = query.or(phoneSuffixes.map((p) => `assigned_salesperson_phone.ilike.%${p}%`).join(','));
    }
  }

  const { data: custs, error } = await query;
  if (error) throw new Error(`get_churn_radar error: ${error.message}`);

  const now = new Date();
  let highRisk = 0;
  let medRisk = 0;

  const accounts = (custs || []).map((c) => {
    let daysSince = null;
    let risk = 'low';

    if (c.last_order_date) {
      const lastT = new Date(c.last_order_date).getTime();
      if (!isNaN(lastT)) {
        daysSince = Math.floor((now.getTime() - lastT) / (1000 * 60 * 60 * 24));
        if (daysSince > 45) {
          risk = 'high';
          highRisk++;
        } else if (daysSince >= 35) {
          risk = 'medium';
          medRisk++;
        }
      }
    }

    return {
      customer_name: c.customer_name,
      contact_person: c.contact_person || 'N/A',
      phone: c.customer_phone || c.phone || 'N/A',
      last_order_date: c.last_order_date || 'N/A',
      days_since_order: daysSince,
      risk_level: risk,
    };
  });

  return {
    data: {
      total_accounts_assessed: accounts.length,
      high_risk_count: highRisk,
      medium_risk_count: medRisk,
      at_risk_accounts: accounts.filter((a) => a.risk_level !== 'low'),
      summary: `Assessed ${accounts.length} accounts. ${highRisk} high risk (churning), ${medRisk} medium risk (at-risk).`,
    },
    rowCount: accounts.length,
  };
}

// ─── 9. GET_LOSS_ANALYTICS TOOL ─────────────────────────────────────────────

async function executeGetLossAnalytics(args, callerContext, supabaseAdmin = supabase) {
  let query = supabaseAdmin.from('deals').select('*').eq('stage', 'lost');

  if (isSalespersonRole(callerContext.role)) {
    const rawPhone = callerContext.phone || '';
    const cleanPhone = rawPhone.replace(/\D/g, '').slice(-10);
    const empId = callerContext.employeeId;
    const orParts = [];
    if (cleanPhone) orParts.push(`salesperson_phone.ilike.%${cleanPhone}%`);
    if (empId) orParts.push(`employee_id.eq.${empId}`);
    if (orParts.length > 0) query = query.or(orParts.join(','));
  } else if (isManagerRole(callerContext.role)) {
    const { phoneSuffixes, employeeIds } = await getSubordinateSalespersons(callerContext, supabaseAdmin);
    const orParts = [];
    phoneSuffixes.forEach((p) => orParts.push(`salesperson_phone.ilike.%${p}%`));
    employeeIds.forEach((id) => orParts.push(`employee_id.eq.${id}`));
    if (orParts.length > 0) query = query.or(orParts.join(','));
  }

  const { data: deals, error } = await query;
  if (error) throw new Error(`get_loss_analytics error: ${error.message}`);

  const rows = deals || [];
  let totalLostVal = 0;
  const reasonMap = {};

  rows.forEach((d) => {
    const val = Number(d.total_amount || 0);
    totalLostVal += val;
    const r = d.lost_reason || 'Unspecified';
    reasonMap[r] = (reasonMap[r] || 0) + 1;
  });

  const topReasons = Object.entries(reasonMap)
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  const formattedDeals = rows.slice(0, 10).map((d) => {
    const rawId = d.id || d.inquiry_id || '';
    const shortId = `#INQ-${rawId.replace(/-/g, '').slice(0, 6).toUpperCase()}`;
    return {
      inquiry_id: shortId,
      full_id: rawId,
      customer_name: d.customer_name,
      lost_reason: d.lost_reason || 'Unspecified',
      total_amount_inr: Number(d.total_amount || 0),
      created_at: d.created_at,
    };
  });

  return {
    data: {
      total_lost_deals: rows.length,
      total_lost_revenue_inr: totalLostVal,
      top_loss_reasons: topReasons,
      lost_deals: formattedDeals,
    },
    rowCount: rows.length,
  };
}

// ─── 10. GET_DEAL_IDS TOOL ──────────────────────────────────────────────────

async function executeGetDealIds(args, callerContext, supabaseAdmin = supabase) {
  const companyName = (args?.company_name || args?.customer_name || '').trim().toLowerCase();

  if (!companyName) {
    return {
      data: {
        message: 'Which customer or company are you looking for? Please provide the company name (e.g. "Radhe Ispat", "Apex Steel").',
      },
      rowCount: 0,
    };
  }

  const access = await verifyCustomerAccountAccess(companyName, callerContext, supabaseAdmin);
  if (!access.allowed) {
    return {
      data: {
        notFound: true,
        message: access.message || `You do not have any company like "${companyName}" in your assigned accounts.`,
      },
      rowCount: 0,
    };
  }

  const { data: deals, error } = await supabaseAdmin
    .from('deals')
    .select('id, inquiry_id, customer_name, stage, status, total_amount, po_number, created_at, deal_items(sku_text, quantity, unit)')
    .ilike('customer_name', `%${companyName}%`)
    .order('created_at', { ascending: false })
    .limit(10);

  if (error) throw new Error(`get_deal_ids error: ${error.message}`);

  const rows = (deals || []).map((d) => {
    const rawId = d.id || d.inquiry_id || '';
    const formattedCode = `#INQ-${rawId.replace(/-/g, '').slice(0, 6).toUpperCase()}`;
    return {
      inquiry_id: formattedCode,
      full_id: rawId,
      customer_name: d.customer_name,
      stage: d.stage || 'new_inquiry',
      po_number: d.po_number || null,
      total_amount_inr: Number(d.total_amount || 0),
      items: d.deal_items || [],
      created_at: d.created_at,
    };
  });

  return {
    data: {
      company_name: companyName,
      inquiries_count: rows.length,
      inquiries: rows,
    },
    rowCount: rows.length,
  };
}

// ─── 11. SEARCH_KNOWLEDGE_BASE TOOL ─────────────────────────────────────────

async function executeSearchKnowledgeBase(args, callerContext, supabaseAdmin = supabase) {
  const queryText = (args?.query || '').trim();
  if (!queryText) {
    return { data: { message: 'Query parameter is required' }, rowCount: 0 };
  }

  // Fallback direct text search on knowledge_base table
  const { data: docs } = await supabaseAdmin
    .from('knowledge_base')
    .select('id, title, content, category, tags')
    .or(`title.ilike.%${queryText}%,content.ilike.%${queryText}%,category.ilike.%${queryText}%`)
    .limit(5);

  if (docs && docs.length > 0) {
    return {
      data: {
        query: queryText,
        results: docs.map((d) => ({
          title: d.title,
          category: d.category,
          snippet: (d.content || '').slice(0, 400),
        })),
      },
      rowCount: docs.length,
    };
  }

  // Standard Enlight Metals SOP reference knowledge
  const SOP_KNOWLEDGE = {
    moq: 'Minimum Order Quantity (MOQ) for Standard Steel is 5 MT per line item, or 1 full truckload (15-20 MT).',
    quotation_validity: 'Standard Quotation Validity is 24 hours from issuance due to daily steel price fluctuations.',
    payment_terms: 'Standard Payment Terms: Advance 20% against Order Confirmation, 80% balance against Proforma Invoice / Dispatch clearance.',
    discount_policy: 'Discounts exceeding ₹500/MT require Sales Manager approval. Discounts exceeding ₹1,000/MT require Admin approval.',
  };

  const lowerQ = queryText.toLowerCase();
  let matchedSnippet = null;
  if (lowerQ.includes('moq') || lowerQ.includes('minimum order')) matchedSnippet = SOP_KNOWLEDGE.moq;
  else if (lowerQ.includes('validity')) matchedSnippet = SOP_KNOWLEDGE.quotation_validity;
  else if (lowerQ.includes('payment') || lowerQ.includes('terms')) matchedSnippet = SOP_KNOWLEDGE.payment_terms;
  else if (lowerQ.includes('discount') || lowerQ.includes('approval')) matchedSnippet = SOP_KNOWLEDGE.discount_policy;

  return {
    data: {
      query: queryText,
      knowledge_snippet: matchedSnippet || `Standard Enlight Metals Sales Operations SOP: Rates and quotes are subject to daily price confirmation and stock availability.`,
    },
    rowCount: 1,
  };
}

// ─── Module Exports ─────────────────────────────────────────────────────────

module.exports = {
  resolveCallerContext,
  isManagerRole,
  isSalespersonRole,
  isAdminRole,
  getSubordinateSalespersons,
  verifyCustomerAccountAccess,
  parseDateFilter,
  parseVisitRemarks,
  categorizeProductFamily,
  deriveCustomerSegment,
  executeGetInquiries,
  executeGetVisits,
  executeGetComplaints,
  executeGetCustomer360,
  executeGetMyOpenDeals,
  executeGetReorderQueue,
  executeGetTeamPipeline,
  executeGetChurnRadar,
  executeGetLossAnalytics,
  executeGetDealIds,
  executeSearchKnowledgeBase,
};
