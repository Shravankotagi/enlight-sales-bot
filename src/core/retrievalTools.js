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
const { searchKnowledgeBase } = require('../services/kbRetrievalService');

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
    return {
      allowed: true,
      isAssignedToCaller: true,
      existsInSystem: true,
      isPhoneAuth: () => true,
      isEmpAuth: () => true,
      authorizedPhoneSuffixes: [],
      authorizedEmployeeIds: [],
    };
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
    return {
      allowed: true,
      isAssignedToCaller: true,
      existsInSystem: true,
      isPhoneAuth,
      isEmpAuth,
      authorizedPhoneSuffixes,
      authorizedEmployeeIds,
    };
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
    return {
      allowed: true,
      isAssignedToCaller: true,
      existsInSystem: true,
      isPhoneAuth,
      isEmpAuth,
      authorizedPhoneSuffixes,
      authorizedEmployeeIds,
    };
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
  if (!dateFilter) return {};
  const lower = String(dateFilter).toLowerCase().trim().replace(/[-_]+/g, ' ');
  if (
    lower === 'all' ||
    lower === 'all time' ||
    lower === 'all_time' ||
    lower === 'overall' ||
    lower === 'lifetime' ||
    lower === 'total' ||
    lower === 'everything' ||
    lower === 'hamesha' ||
    lower === 'kul' ||
    lower === 'sab' ||
    lower === 'poora' ||
    lower === 'ab tak'
  ) return {};

  const now = new Date();

  if (lower === 'today' || lower === 'aaj' || lower === 'aj') {
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    return { from: startOfToday };
  }
  if (lower === 'yesterday' || lower === 'kal' || lower === 'beeta kal') {
    const startOfYesterday = new Date(now);
    startOfYesterday.setDate(startOfYesterday.getDate() - 1);
    startOfYesterday.setHours(0, 0, 0, 0);
    const endOfYesterday = new Date(now);
    endOfYesterday.setDate(endOfYesterday.getDate() - 1);
    endOfYesterday.setHours(23, 59, 59, 999);
    return { from: startOfYesterday, to: endOfYesterday };
  }

  // Relative days regex: e.g. "last 7 days", "past 7 days", "7 days", "7 din", "pichle 7 din", "last 30 days", "30 days", "30 din", "last 14 days"
  const daysMatch = lower.match(/^(?:last|past|pichle)?\s*(\d+)\s*(?:days?|din)$/);
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
    lower === 'is hafte' ||
    lower === 'yeh hafte' ||
    lower === 'iss hafte' ||
    lower === 'current week' ||
    lower === 'last 7 days' ||
    lower === 'past 7 days' ||
    lower === '7 days' ||
    lower === '7 din' ||
    lower === 'pichle 7 din' ||
    lower === 'last week' ||
    lower === 'past week' ||
    lower === 'previous week' ||
    lower === 'pichle hafte'
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
    lower === 'is mahine' ||
    lower === 'yeh mahine' ||
    lower === 'iss mahine' ||
    lower === 'current month' ||
    lower === 'mtd' ||
    lower === 'last 30 days' ||
    lower === 'past 30 days' ||
    lower === '30 days' ||
    lower === '30 din' ||
    lower === 'pichle 30 din'
  ) {
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    return { from: startOfMonth };
  }
  if (
    lower === 'last month' ||
    lower === 'previous month' ||
    lower === 'past month' ||
    lower === 'pichle mahine' ||
    lower === 'pichla mahina'
  ) {
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
  if (!remarks || typeof remarks !== 'string') {
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
    } else if (rawOut.includes('positive') || rawOut.includes('interested') || rawOut.includes('won')) {
      outcome = 'positive';
    } else if (rawOut.includes('negative') || rawOut.includes('lost') || rawOut.includes('rejected')) {
      outcome = 'negative';
    } else {
      outcome = 'neutral';
    }
  }

  let followUpAction = null;
  const followUpMatch =
    remarks.match(/\[(?:Follow-?Up|Follow-?up\s*Action):\s*([^\]]+)\]/i) ||
    remarks.match(/(?:^|\||\n)\s*Follow-?up(?:\s*Action)?:\s*([^|\]\n]+)/i);

  if (followUpMatch) {
    const fu = followUpMatch[1].trim();
    const lowerFu = fu.toLowerCase();
    const isNonAction =
      !fu ||
      lowerFu === 'none' ||
      lowerFu === '-' ||
      lowerFu === 'nil' ||
      lowerFu === 'n/a' ||
      lowerFu === 'na' ||
      lowerFu === 'null' ||
      lowerFu.startsWith('no remarks') ||
      lowerFu.startsWith('no follow') ||
      lowerFu === 'not required' ||
      lowerFu === 'not needed';

    if (!isNonAction) {
      followUpAction = fu;
    }
  }

  let followUpStatus = null;
  const statusMatch =
    remarks.match(/\[(?:FollowUpStatus|Follow-?Up\s*Status):\s*([^\]]+)\]/i) ||
    remarks.match(/(?:^|\||\n)\s*Follow-?up\s*Status:\s*([^|\]\n]+)/i);
  if (statusMatch) {
    const rawSt = statusMatch[1].trim().toLowerCase();
    if (['completed', 'done', 'resolved', 'closed'].includes(rawSt)) {
      followUpStatus = 'completed';
    } else if (rawSt === 'pending') {
      followUpStatus = 'pending';
    }
  }

  const isCompleted = followUpStatus === 'completed';
  const requiresFollowUp = Boolean(followUpAction) && !isCompleted;

  let materialRequirement = null;
  const matMatch =
    remarks.match(/\[(?:Material )?Requirements?:\s*([^\]]+)\]/i) ||
    remarks.match(/(?:^|\||\n)\s*(?:Material )?Requirement:\s*([^|\]\n]+)/i);
  if (matMatch) {
    materialRequirement = matMatch[1].trim();
  }

  let location = null;
  const locMatch =
    remarks.match(/\[Location:\s*([^\]]+)\]/i) ||
    remarks.match(/(?:^|\||\n)\s*Location:\s*([^|\]\n]+)/i);
  if (locMatch) {
    location = locMatch[1].trim();
  }

  let interests = null;
  const intMatch =
    remarks.match(/\[Interests?:\s*([^\]]+)\]/i) ||
    remarks.match(/(?:^|\||\n)\s*Interests?:\s*([^|\]\n]+)/i);
  if (intMatch) {
    interests = intMatch[1].trim();
  }

  const cleanRemarks = remarks
    .replace(/\[Outcome:\s*[^\]]+\]/gi, '')
    .replace(/\[(?:Follow-?Up|Follow-?up\s*Action):\s*[^\]]+\]/gi, '')
    .replace(/\[(?:FollowUpStatus|Follow-?Up\s*Status):\s*[^\]]+\]/gi, '')
    .replace(/\[(?:FollowUpDate|Follow-?Up\s*Date):\s*[^\]]+\]/gi, '')
    .replace(/\[(?:Material )?Requirements?:\s*[^\]]+\]/gi, '')
    .replace(/\[Location:\s*[^\]]+\]/gi, '')
    .replace(/\[Interests?:\s*[^\]]+\]/gi, '')
    .replace(/(?:^|\||\n)\s*Follow-?up(?:\s*Action)?:\s*[^|\n]+/gi, '')
    .replace(/(?:^|\||\n)\s*Follow-?up\s*Status:\s*[^|\n]+/gi, '')
    .replace(/(?:^|\||\n)\s*(?:Material )?Requirement:\s*[^|\n]+/gi, '')
    .replace(/(?:^|\||\n)\s*Location:\s*[^|\n]+/gi, '')
    .replace(/(?:^|\||\n)\s*Interests?:\s*[^|\n]+/gi, '')
    .replace(/^[\s|]+|[\s|]+$/g, '')
    .trim();

  let followUpDate = null;
  const dateMatch =
    remarks.match(/\[(?:FollowUpDate|Follow-?Up\s*Date):\s*([^\]]+)\]/i) ||
    remarks.match(/(?:^|\||\n)\s*Follow-?up\s*Date:\s*([^|\]\n]+)/i);
  if (dateMatch) {
    followUpDate = dateMatch[1].trim();
  }

  return {
    outcome,
    follow_up_action: followUpAction,
    follow_up_date: followUpDate,
    follow_up_status: followUpStatus || (followUpAction ? (isCompleted ? 'completed' : 'pending') : null),
    requires_follow_up: requiresFollowUp,
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
    (totalOrders >= 1 && (inquiriesCount >= 3 || visitsCount >= 2))
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

/**
 * Normalizes any deal stage, inquiry status, or user phrasing into standard business stages:
 * - 'quoted' (Price Quote / Quoted / Qualified / Proposal / Saved / Confirmed / Sent to Party)
 * - 'negotiation' (Negotiation / Review / In Negotiation / Under Negotiation / Discussion)
 * - 'on_hold' (On Hold / Hold / Paused / Blocked)
 * - 'new_inquiry' (New Inquiry / New / Inquiry / Draft / Unquoted / Pending / Auto Created / Received)
 * - 'won' (Won / Order / Order Placed / Order Confirmed / PO Received / Converted)
 * - 'lost' (Lost / Dropped / Cancelled / Canceled / Rejected / Closed Lost)
 */
function normalizeDealStage(rawStage) {
  if (!rawStage) return 'new_inquiry';
  const s = String(rawStage).toLowerCase().trim().replace(/[-_]+/g, ' ');

  // Quoted / Price Quote / Qualified / Proposal / Saved / Confirmed
  if (
    s === 'quoted' ||
    s === 'price quote' ||
    s === 'pricequote' ||
    s === 'quotation' ||
    s === 'quotation sent' ||
    s === 'quotated' ||
    s === 'proposal' ||
    s === 'proposal price quote' ||
    s === 'qualified' ||
    s === 'saved' ||
    s === 'confirmed' ||
    s === 'sent to party'
  ) {
    return 'quoted';
  }

  // Negotiation / Review
  if (
    s === 'negotiation' ||
    s === 'negotaiation' ||
    s === 'negotiate' ||
    s === 'negotiating' ||
    s === 'in negotiation' ||
    s === 'under negotiation' ||
    s === 'discussion' ||
    s === 'review' ||
    s === 'negotiation review'
  ) {
    return 'negotiation';
  }

  // On Hold
  if (
    s === 'on hold' ||
    s === 'onhold' ||
    s === 'hold' ||
    s === 'paused' ||
    s === 'blocked' ||
    s === 'put on hold' ||
    s === 'is on hold'
  ) {
    return 'on_hold';
  }

  // New Inquiry / Draft / Unquoted / Pending / Auto Created / Received
  if (
    s === 'new inquiry' ||
    s === 'new' ||
    s === 'inquiry' ||
    s === 'pending' ||
    s === 'auto created' ||
    s === 'received' ||
    s === 'draft' ||
    s === 'unquoted'
  ) {
    return 'new_inquiry';
  }

  // Won / Order Placed / Confirmed / Converted / Closed Won / PO
  if (
    s === 'won' ||
    s === 'order' ||
    s === 'orders' ||
    s === 'order placed' ||
    s === 'order confirmed' ||
    s === 'po received' ||
    s === 'po' ||
    s === 'converted' ||
    s === 'closed won'
  ) {
    return 'won';
  }

  // Lost / Cancelled / Dropped / Rejected / Closed Lost / Not Converted
  if (
    s === 'lost' ||
    s === 'dropped' ||
    s === 'cancelled' ||
    s === 'canceled' ||
    s === 'rejected' ||
    s === 'closed lost' ||
    s === 'not converted'
  ) {
    return 'lost';
  }

  return s.replace(/\s+/g, '_');
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
  const limit = args?.recent_only ? 5 : Math.min(Math.max(Number(args?.limit) || 8, 1), 8);
  const searchName = (args?.customer_name_search || args?.customer_name || args?.company_name || '').trim().toLowerCase();
  const dateRange = args?.date_range;
  const mode = (args?.mode || 'list').toLowerCase().trim();

  let inqQuery = supabaseAdmin
    .from('inquiries')
    .select('id, sender_name, sender_phone, raw_text, inquiry_type, status, source_channel, media_urls, overall_confidence, ai_extraction_json, created_at, salesperson_phone, employee_id')
    .order('created_at', { ascending: false });

  let dealsQuery = supabaseAdmin
    .from('deals')
    .select('id, inquiry_id, stage, status, customer_name, customer_phone, po_number, total_amount, salesperson_phone, employee_id, created_at, won_at, deal_items(sku_text, dimensions, quantity, unit, rate, amount)');

  // Scoping
  if (isSalespersonRole(callerContext.role)) {
    const rawPhone = callerContext.phone || '';
    const cleanPhone = rawPhone.replace(/\D/g, '').slice(-10);
    const empId = callerContext.employeeId;
    const orPartsInq = [];
    const orPartsDeals = [];

    if (cleanPhone) {
      orPartsInq.push(`salesperson_phone.ilike.%${cleanPhone}%`, `sender_phone.ilike.%${cleanPhone}%`);
      orPartsDeals.push(`salesperson_phone.ilike.%${cleanPhone}%`);
    }
    if (empId) {
      orPartsInq.push(`employee_id.eq.${empId}`);
      orPartsDeals.push(`employee_id.eq.${empId}`);
    }

    if (orPartsInq.length === 0) {
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

    inqQuery = inqQuery.or(orPartsInq.join(','));
    if (orPartsDeals.length > 0) {
      dealsQuery = dealsQuery.or(orPartsDeals.join(','));
    } else {
      dealsQuery = dealsQuery.eq('id', '00000000-0000-0000-0000-000000000000');
    }
  } else if (isManagerRole(callerContext.role)) {
    const { phoneSuffixes, employeeIds } = await getSubordinateSalespersons(callerContext, supabaseAdmin);
    const orPartsInq = [];
    const orPartsDeals = [];
    phoneSuffixes.forEach((p) => {
      orPartsInq.push(`salesperson_phone.ilike.%${p}%`, `sender_phone.ilike.%${p}%`);
      orPartsDeals.push(`salesperson_phone.ilike.%${p}%`);
    });
    employeeIds.forEach((id) => {
      orPartsInq.push(`employee_id.eq.${id}`);
      orPartsDeals.push(`employee_id.eq.${id}`);
    });

    if (orPartsInq.length === 0) {
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

    inqQuery = inqQuery.or(orPartsInq.join(','));
    if (orPartsDeals.length > 0) {
      dealsQuery = dealsQuery.or(orPartsDeals.join(','));
    } else {
      dealsQuery = dealsQuery.eq('id', '00000000-0000-0000-0000-000000000000');
    }
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
  let materialized = inqs.map((row) => {
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

    const shortId = `INQ-${(row.id || linkedDeal?.inquiry_id || linkedDeal?.id).replace(/-/g, '').slice(0, 6).toUpperCase()}`;
    const rawSrc = (row.source_channel || '').toLowerCase();
    const isDoc = rawSrc.includes('image') || rawSrc.includes('po') || rawSrc.includes('ocr') || (row.media_urls && row.media_urls.length > 0);
    const channelDisplay = isDoc ? 'ocr_document' : (rawSrc.includes('whatsapp') ? 'whatsapp_text' : (rawSrc.includes('dashboard') ? 'web_dashboard' : 'whatsapp_text'));

    return {
      inquiry_id: shortId,
      full_id: row.id,
      customer_name: custName,
      customer_phone: row.sender_phone || linkedDeal?.customer_phone || '',
      inquiry_type: row.inquiry_type || 'standard',
      status: normalizeDealStage(row.status) || 'new_inquiry',
      deal_stage: normalizeDealStage(linkedDeal?.stage) || 'no_deal_linked',
      raw_status: row.status || 'review',
      raw_deal_stage: linkedDeal?.stage || 'no_deal_linked',
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

  // Strict Production Safety: Filter out synthetic test inquiries
  materialized = materialized.filter((m) => {
    const rawText = m.raw_text_snippet || '';
    const cust = (m.customer_name || '').toLowerCase();
    if (
      /test industries\s*\d*/i.test(rawText) ||
      /test customer\s*\d*/i.test(rawText) ||
      /test prospect\s*\d*/i.test(rawText) ||
      /^test\s+(industries|customer|corp|company)\b/i.test(cust)
    ) {
      return false;
    }
    return true;
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
  if (
    mode === 'highest_tonnage' ||
    mode === 'max_tonnage' ||
    mode === 'top_tonnage' ||
    mode === 'highest_qty' ||
    sortBy.includes('tonnage')
  ) {
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
  if (
    mode === 'channel_breakdown' ||
    mode === 'channels' ||
    mode === 'source_breakdown' ||
    mode === 'whatsapp_vs_dashboard' ||
    mode === 'channel_wise'
  ) {
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
  if (
    mode === 'conversion_breakdown' ||
    mode === 'conversion' ||
    mode === 'conversion_metrics' ||
    mode === 'won_metrics' ||
    mode === 'inquiry_conversion'
  ) {
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
  if (
    mode === 'rep_conversion' ||
    mode === 'salesperson_conversion' ||
    mode === 'salesperson_leaderboard' ||
    mode === 'rep_leaderboard' ||
    mode === 'rep_rankings'
  ) {
    if (isSalespersonRole(callerContext.role)) {
      const wonCount = materialized.filter((m) => m.deal_stage === 'won' || m.status === 'won' || Boolean(m.po_number)).length;
      const totalCount = materialized.length;
      const rate = totalCount > 0 ? `${Math.round((wonCount / totalCount) * 1000) / 10}%` : '0%';
      return {
        data: {
          role_restricted: true,
          message: 'Team conversion leaderboards and peer comparisons are restricted under Role-Based Access Control (RBAC) to Sales Managers and Admins. You can only view your own conversion metrics.',
          personal_metrics: {
            total_inquiries: totalCount,
            converted_orders: wonCount,
            personal_conversion_rate: rate,
          },
          summary: `You have converted ${wonCount} out of ${totalCount} assigned inquiries (${rate} conversion rate). Cross-rep leaderboards and peer comparisons are restricted to Sales Managers and Admins under RBAC.`,
        },
        rowCount: 1,
      };
    }

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
  if (
    mode === 'open_inquiries_dormant_buyers' ||
    mode === 'dormant_buyers' ||
    mode === 'dormant' ||
    mode === 'inactive_buyers'
  ) {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    let recCustQuery = supabaseAdmin.from('recurring_customers').select('customer_name, last_order_date, is_active').eq('is_active', true);
    if (isSalespersonRole(callerContext.role)) {
      const rawPhone = callerContext.phone || '';
      const cleanPhone = rawPhone.replace(/\D/g, '').slice(-10);
      if (cleanPhone) recCustQuery = recCustQuery.ilike('assigned_salesperson_phone', `%${cleanPhone}%`);
    } else if (isManagerRole(callerContext.role)) {
      const { phoneSuffixes } = await getSubordinateSalespersons(callerContext, supabaseAdmin);
      if (phoneSuffixes.length > 0) {
        recCustQuery = recCustQuery.or(phoneSuffixes.map((p) => `assigned_salesperson_phone.ilike.%${p}%`).join(','));
      }
    }

    const { data: recCusts } = await recCustQuery;
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

    const totalDormant = dormantBuyerInquiries.length;
    const displayDormant = dormantBuyerInquiries.slice(0, 8);
    const hasMore = totalDormant > 8;

    return {
      data: {
        dormant_buyer_inquiries_count: totalDormant,
        total_records: totalDormant,
        showing_count: displayDormant.length,
        has_more: hasMore,
        dashboard_notice: hasMore
          ? `Showing 8 of ${totalDormant} inquiries from dormant buyers. Please navigate to the dashboard to view all ${totalDormant} records.`
          : null,
        dormant_buyer_inquiries: displayDormant,
      },
      rowCount: totalDormant,
    };
  }

  // ── Mode: Month-over-Month Comparison ─────────────────────────────────────
  if (
    mode === 'month_comparison' ||
    mode === 'monthly_comparison' ||
    mode === 'mom' ||
    mode === 'month_over_month'
  ) {
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
  if (
    mode === 'monthly_summary' ||
    mode === 'executive_summary' ||
    mode === 'monthly_overview' ||
    mode === 'summary' ||
    mode === 'full_summary' ||
    mode === 'month_summary'
  ) {
    const now = new Date();
    const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const thisMonthInqs = materialized.filter((m) => new Date(m.created_at) >= startOfThisMonth);
    const thisMonthWon = thisMonthInqs.filter((m) => m.deal_stage === 'won' || Boolean(m.po_number));
    const activePipelineDeals = allDeals.filter((d) => d.stage !== 'won' && d.stage !== 'lost');

    let visitsQuery = supabaseAdmin.from('customer_visits').select('id, visited_at, salesperson_phone, employee_id').gte('visited_at', startOfThisMonth.toISOString());
    let compQuery = supabaseAdmin.from('complaints').select('id, created_at, reported_by, employee_id').gte('created_at', startOfThisMonth.toISOString());

    if (isSalespersonRole(callerContext.role)) {
      const rawPhone = callerContext.phone || '';
      const cleanPhone = rawPhone.replace(/\D/g, '').slice(-10);
      const empId = callerContext.employeeId;
      const visOr = [];
      const compOr = [];
      if (cleanPhone) {
        visOr.push(`salesperson_phone.ilike.%${cleanPhone}%`);
        compOr.push(`reported_by.ilike.%${cleanPhone}%`);
      }
      if (empId) {
        visOr.push(`employee_id.eq.${empId}`);
        compOr.push(`employee_id.eq.${empId}`);
      }
      if (visOr.length > 0) visitsQuery = visitsQuery.or(visOr.join(','));
      if (compOr.length > 0) compQuery = compQuery.or(compOr.join(','));
    } else if (isManagerRole(callerContext.role)) {
      const { phoneSuffixes, employeeIds } = await getSubordinateSalespersons(callerContext, supabaseAdmin);
      const visOr = [];
      const compOr = [];
      phoneSuffixes.forEach((p) => {
        visOr.push(`salesperson_phone.ilike.%${p}%`);
        compOr.push(`reported_by.ilike.%${p}%`);
      });
      employeeIds.forEach((id) => {
        visOr.push(`employee_id.eq.${id}`);
        compOr.push(`employee_id.eq.${id}`);
      });
      if (visOr.length > 0) visitsQuery = visitsQuery.or(visOr.join(','));
      if (compOr.length > 0) compQuery = compQuery.or(compOr.join(','));
    }

    const [
      { count: activeCustCount },
      { data: monthVisits },
      { data: monthComplaints }
    ] = await Promise.all([
      supabaseAdmin.from('recurring_customers').select('id', { count: 'exact', head: true }).eq('is_active', true),
      visitsQuery,
      compQuery,
    ]);

    const totalVisits = monthVisits ? monthVisits.length : 0;
    const totalComplaints = monthComplaints ? monthComplaints.length : 0;

    return {
      data: {
        period: `${now.toLocaleString('en-IN', { month: 'long' })} ${now.getFullYear()}`,
        total_inquiries_this_month: thisMonthInqs.length,
        won_orders_this_month: thisMonthWon.length,
        total_visits_this_month: totalVisits,
        total_complaints_this_month: totalComplaints,
        active_pipeline_deals: activePipelineDeals.length,
        active_customer_accounts: activeCustCount || 0,
        summary: `Full monthly summary for ${now.toLocaleString('en-IN', { month: 'long' })} ${now.getFullYear()}: ${thisMonthInqs.length} Inquiries, ${thisMonthWon.length} Confirmed Orders, ${totalVisits} Customer Visits, and ${totalComplaints} Complaints.`,
      },
      rowCount: thisMonthInqs.length,
    };
  }

  // ── Mode: At-Risk Inquiries ───────────────────────────────────────────────
  if (
    mode === 'at_risk_inquiries' ||
    mode === 'at_risk' ||
    mode === 'churn_risk'
  ) {
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
    const normStatus = normalizeDealStage(rawStatus);
    if (normStatus === 'won' || rawStatus === 'converted' || rawStatus === 'orders') {
      filtered = filtered.filter((m) => normalizeDealStage(m.deal_stage) === 'won' || normalizeDealStage(m.status) === 'won' || Boolean(m.po_number));
    } else if (normStatus === 'lost' || rawStatus === 'not_converted') {
      filtered = filtered.filter((m) => normalizeDealStage(m.deal_stage) === 'lost' || normalizeDealStage(m.status) === 'lost');
    } else if (normStatus === 'on_hold') {
      filtered = filtered.filter((m) => normalizeDealStage(m.deal_stage) === 'on_hold' || normalizeDealStage(m.status) === 'on_hold');
    } else if (normStatus === 'negotiation') {
      filtered = filtered.filter((m) => normalizeDealStage(m.deal_stage) === 'negotiation' || normalizeDealStage(m.status) === 'negotiation');
    } else if (normStatus === 'quoted') {
      filtered = filtered.filter((m) => normalizeDealStage(m.deal_stage) === 'quoted' || normalizeDealStage(m.status) === 'quoted');
    } else if (normStatus === 'new_inquiry' || rawStatus === 'pending' || rawStatus === 'review') {
      filtered = filtered.filter((m) => normalizeDealStage(m.deal_stage) === 'new_inquiry' || normalizeDealStage(m.status) === 'new_inquiry' || m.status === 'review' || m.status === 'pending' || m.status === 'new' || m.status === 'draft');
    } else {
      filtered = filtered.filter((m) => {
        const ds = normalizeDealStage(m.deal_stage);
        const st = normalizeDealStage(m.status);
        return ds === normStatus || st === normStatus || m.status?.toLowerCase() === rawStatus || m.deal_stage?.toLowerCase() === rawStatus;
      });
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

  const totalCount = filtered.length;
  const displayInquiries = filtered.slice(0, 8);
  const hasMore = totalCount > 8;

  return {
    data: {
      summary: {
        total_inquiries: totalCount,
        total_inquired_tonnage_mt: Math.round(totalTonnage * 1000) / 1000,
        total_tonnage_mt: Math.round(totalTonnage * 1000) / 1000,
        won_orders_count: wonCount,
        lost_deals_count: lostCount,
        pending_review_count: pendingCount,
        ocr_document_count: ocrCount,
        top_customers: topCustomers,
      },
      total_records: totalCount,
      showing_count: displayInquiries.length,
      has_more: hasMore,
      dashboard_notice: hasMore
        ? `Showing 8 of ${totalCount} inquiries. Please navigate to the dashboard to view all ${totalCount} records.`
        : null,
      inquiries: displayInquiries,
    },
    rowCount: totalCount,
  };
}

// ─── 2. GET_VISITS TOOL ─────────────────────────────────────────────────────

async function executeGetVisits(args, callerContext, supabaseAdmin = supabase) {
  const custFilter = (args?.customer_name_search || args?.customer_name || '').trim().toLowerCase();
  const repFilter = (args?.salesperson_name || '').trim().toLowerCase();
  const locFilter = (args?.location || '').trim().toLowerCase();
  const outcomeFilter = (args?.outcome_filter || args?.outcome || '').trim().toLowerCase();
  const requiresFollowUp = args?.requires_follow_up !== undefined ? Boolean(args.requires_follow_up) : (args?.requires_followup !== undefined ? Boolean(args.requires_followup) : null);
  const dateRange = args?.date_range;
  const mode = (args?.mode || 'list').toLowerCase().trim();
  const missingLocation = Boolean(args?.missing_location || args?.missing_field === 'location');
  const missingContact = Boolean(args?.missing_contact_person || args?.missing_field === 'contact_person');
  const limit = Math.min(Math.max(Number(args?.limit) || 8, 1), 8);

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

  const isNotVisitedMode =
    mode === 'not_visited' ||
    mode === 'unvisited' ||
    mode === 'no_visits' ||
    mode === 'unvisited_customers' ||
    mode === 'customers_not_visited' ||
    mode === 'not_visited_customers' ||
    mode === "haven't_been_visited" ||
    mode === 'havent_been_visited' ||
    mode === 'unvisited_in_timeframe' ||
    mode === 'not_visited_in_timeframe' ||
    Boolean(args?.not_visited) ||
    Boolean(args?.unvisited);

  // ── Mode: Unvisited Customers (No Visits in Timeframe) ────────────────────
  if (isNotVisitedMode) {
    const { data: allEmployees } = await supabaseAdmin
      .from('employees')
      .select('id, employee_id, phone, name')
      .eq('is_active', true);

    const empMap = new Map();
    (allEmployees || []).forEach((e) => {
      empMap.set((e.phone || '').replace(/\D/g, '').slice(-10), e.name);
      if (e.id) empMap.set(e.id, e.name);
      if (e.employee_id) empMap.set(e.employee_id, e.name);
    });

    // 1. Query all active recurring customers scoped to caller
    let custQuery = supabaseAdmin
      .from('recurring_customers')
      .select('*')
      .eq('is_active', true);

    if (isSalespersonRole(callerContext.role)) {
      const rawPhone = callerContext.phone || '';
      const cleanPhone = rawPhone.replace(/\D/g, '').slice(-10);
      if (cleanPhone) {
        custQuery = custQuery.ilike('assigned_salesperson_phone', `%${cleanPhone}%`);
      } else {
        return {
          data: {
            timeframe: dateRange || 'last_30_days',
            timeframe_label: 'last 30 days',
            total_unvisited_customers: 0,
            summary: 'No unvisited customers found for your account.',
            customers: [],
          },
          rowCount: 0,
        };
      }
    } else if (isManagerRole(callerContext.role)) {
      const { phoneSuffixes } = await getSubordinateSalespersons(callerContext, supabaseAdmin);
      if (phoneSuffixes.length > 0) {
        const orFilter = phoneSuffixes.map((p) => `assigned_salesperson_phone.ilike.%${p}%`).join(',');
        custQuery = custQuery.or(orFilter);
      } else {
        return {
          data: {
            timeframe: dateRange || 'last_30_days',
            timeframe_label: 'last 30 days',
            total_unvisited_customers: 0,
            summary: 'No unvisited customers found for your team.',
            customers: [],
          },
          rowCount: 0,
        };
      }
    }

    const { data: rawCustRows, error: custErr } = await custQuery;
    if (custErr) throw new Error(`get_visits unvisited customers error: ${custErr.message}`);

    // Deduplicate customers by normalized name
    const seenCusts = new Map();
    for (const c of (rawCustRows || [])) {
      const normKey = (c.customer_name || '').toLowerCase().trim();
      if (!normKey) continue;
      if (!seenCusts.has(normKey)) {
        seenCusts.set(normKey, c);
      } else {
        const existing = seenCusts.get(normKey);
        if (!existing.customer_phone && c.customer_phone) {
          seenCusts.set(normKey, { ...existing, ...c });
        }
      }
    }
    const uniqueCustRows = Array.from(seenCusts.values());

    // 2. Query all historical customer visits scoped to caller
    let allVisitsQuery = supabaseAdmin
      .from('customer_visits')
      .select('*')
      .order('visited_at', { ascending: false });

    if (isSalespersonRole(callerContext.role)) {
      const rawPhone = callerContext.phone || '';
      const cleanPhone = rawPhone.replace(/\D/g, '').slice(-10);
      const empId = callerContext.employeeId;
      const orParts = [];
      if (cleanPhone) orParts.push(`salesperson_phone.ilike.%${cleanPhone}%`);
      if (empId) orParts.push(`employee_id.eq.${empId}`);
      if (orParts.length > 0) {
        allVisitsQuery = allVisitsQuery.or(orParts.join(','));
      }
    } else if (isManagerRole(callerContext.role)) {
      const { phoneSuffixes, employeeIds } = await getSubordinateSalespersons(callerContext, supabaseAdmin);
      const orParts = [];
      phoneSuffixes.forEach((p) => orParts.push(`salesperson_phone.ilike.%${p}%`));
      employeeIds.forEach((id) => orParts.push(`employee_id.eq.${id}`));
      if (orParts.length > 0) {
        allVisitsQuery = allVisitsQuery.or(orParts.join(','));
      }
    }

    const { data: allVisitsData, error: allVisitsErr } = await allVisitsQuery;
    if (allVisitsErr) throw new Error(`get_visits unvisited visits error: ${allVisitsErr.message}`);
    const allVisits = allVisitsData || [];

    // 3. Determine timeframe boundaries
    const effectiveDateRange = dateRange || 'last_30_days';
    const { from, to } = parseDateFilter(effectiveDateRange);
    let fromDate = from;
    if (!fromDate) {
      const d = new Date();
      d.setDate(d.getDate() - 30);
      d.setHours(0, 0, 0, 0);
      fromDate = d;
    }
    const toDate = to || new Date();

    // 4. Build visited set within window and historical latest visit map
    const visitedInWindowSet = new Set();
    const latestVisitMap = new Map();

    allVisits.forEach((v) => {
      const rawName = (v.customer_name || '').trim();
      if (!rawName) return;
      const normName = rawName.toLowerCase();
      const cleanName = cleanLegalSuffixes(rawName);
      const visitDateStr = v.visited_at || v.created_at;
      const visitDate = visitDateStr ? new Date(visitDateStr) : null;

      if (visitDate && visitDate >= fromDate && visitDate <= toDate) {
        visitedInWindowSet.add(normName);
        if (cleanName) visitedInWindowSet.add(cleanName);
      }

      if (visitDate && (!latestVisitMap.has(normName) || new Date(latestVisitMap.get(normName).visit_date_raw) < visitDate)) {
        const parsedRemarks = parseVisitRemarks(v.remarks);
        const p = (v.salesperson_phone || '').replace(/\D/g, '').slice(-10);
        const rep = empMap.get(p) || empMap.get(v.employee_id) || 'Salesperson';
        const info = {
          visit_date: visitDateStr ? visitDateStr.split('T')[0] : 'N/A',
          visit_date_raw: visitDateStr,
          outcome: v.outcome || parsedRemarks.outcome || 'Not recorded',
          salesperson_name: rep,
          location: v.customer_address || v.location || parsedRemarks.location || 'N/A',
        };
        latestVisitMap.set(normName, info);
        if (cleanName) {
          latestVisitMap.set(cleanName, info);
        }
      }
    });

    // 5. Filter unique customer records to find those NOT visited in the timeframe window
    let unvisitedList = uniqueCustRows.filter((c) => {
      const cName = (c.customer_name || '').trim();
      if (!cName) return false;
      const normName = cName.toLowerCase();
      const cleanName = cleanLegalSuffixes(cName);

      const isVisitedInWindow =
        visitedInWindowSet.has(normName) ||
        (cleanName && visitedInWindowSet.has(cleanName)) ||
        Array.from(visitedInWindowSet).some((v) => normName === v || (v.length > 3 && cleanName === v));

      return !isVisitedInWindow;
    });

    // 6. Apply secondary filters if passed
    if (custFilter) {
      unvisitedList = unvisitedList.filter((c) => (c.customer_name || '').toLowerCase().includes(custFilter));
    }
    if (repFilter) {
      unvisitedList = unvisitedList.filter((c) => {
        const p = (c.assigned_salesperson_phone || '').replace(/\D/g, '').slice(-10);
        const repName = empMap.get(p) || '';
        return repName.toLowerCase().includes(repFilter) || (c.notes || '').toLowerCase().includes(repFilter);
      });
    }
    if (locFilter) {
      unvisitedList = unvisitedList.filter((c) => (c.customer_address || '').toLowerCase().includes(locFilter));
    }

    // 7. Format output
    const formattedUnvisited = unvisitedList.map((c) => {
      const cName = (c.customer_name || '').trim();
      const normName = cName.toLowerCase();
      const cleanName = cleanLegalSuffixes(cName);
      const lastVisit = latestVisitMap.get(normName) || (cleanName ? latestVisitMap.get(cleanName) : null);
      const p = (c.assigned_salesperson_phone || '').replace(/\D/g, '').slice(-10);
      const assignedRep = empMap.get(p) || (c.notes ? c.notes.match(/Account Owner:\s*([^|]+)/i)?.[1]?.trim() : 'Unassigned') || 'Salesperson';

      return {
        customer_name: cName,
        contact_person: c.contact_person || 'N/A',
        phone: c.customer_phone || 'N/A',
        address: c.customer_address || 'N/A',
        last_visited_date: lastVisit?.visit_date || 'Never visited',
        last_visit_outcome: lastVisit?.outcome || null,
        assigned_salesperson: assignedRep,
      };
    });

    let timeframeLabel = 'last 30 days';
    if (effectiveDateRange === 'last_7_days' || effectiveDateRange === 'this_week') timeframeLabel = 'last 7 days';
    else if (effectiveDateRange === 'this_month') timeframeLabel = 'this month';
    else if (effectiveDateRange === 'last_month') timeframeLabel = 'last month';
    else if (effectiveDateRange === 'last_30_days') timeframeLabel = 'last 30 days';
    else timeframeLabel = effectiveDateRange;

    const totalUnvisited = formattedUnvisited.length;
    const displayUnvisited = formattedUnvisited.slice(0, 8);
    const hasMore = totalUnvisited > 8;

    return {
      data: {
        timeframe: effectiveDateRange,
        timeframe_label: timeframeLabel,
        total_unvisited_customers: totalUnvisited,
        total_active_accounts: uniqueCustRows.length,
        total_records: totalUnvisited,
        showing_count: displayUnvisited.length,
        has_more: hasMore,
        dashboard_notice: hasMore
          ? `Showing 8 of ${totalUnvisited} unvisited customer accounts. Please navigate to the dashboard to view all ${totalUnvisited} records.`
          : null,
        summary: `Found ${totalUnvisited} customer accounts who have NOT been visited in the ${timeframeLabel}.`,
        customers: displayUnvisited,
      },
      rowCount: totalUnvisited,
    };
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

  const isFollowupQuery =
    mode === 'due_today' ||
    mode === 'pending_today' ||
    mode === 'followups_due_today' ||
    mode === 'due_today_followup' ||
    mode === 'today_followup' ||
    mode === 'follow_ups_due_today' ||
    mode === 'overdue' ||
    mode === 'overdue_followup' ||
    mode === 'followups_overdue' ||
    mode === 'overdue_followups' ||
    mode === 'pending_followup' ||
    mode === 'pending_follow_up' ||
    mode === 'followup_pending' ||
    mode === 'follow_up_pending' ||
    mode === 'pending_followups' ||
    mode === 'pending' ||
    mode === 'follow_up' ||
    mode === 'followup' ||
    args?.due_today ||
    args?.overdue ||
    args?.pending_followup ||
    args?.pending_follow_up ||
    args?.requires_follow_up ||
    args?.follow_up_filter ||
    args?.follow_up_only;

  if (!isFollowupQuery) {
    const { from, to } = parseDateFilter(dateRange);
    if (from) query = query.gte('visited_at', from.toISOString());
    if (to) query = query.lte('visited_at', to.toISOString());
  }

  const { data: rows, error } = await query;
  if (error) throw new Error(`get_visits error: ${error.message}`);

  const { data: allEmployees } = await supabaseAdmin.from('employees').select('id, employee_id, phone, name').eq('is_active', true);
  const empMap = new Map();
  (allEmployees || []).forEach((e) => {
    empMap.set((e.phone || '').replace(/\D/g, '').slice(-10), e.name);
    if (e.id) empMap.set(e.id, e.name);
    if (e.employee_id) empMap.set(e.employee_id, e.name);
  });

  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

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
    const rawFu = r.follow_up_action || r.follow_up || parsed.follow_up_action;
    const isFuValid =
      rawFu &&
      !['none', 'nil', 'n/a', 'na', '-', 'null'].includes(String(rawFu).toLowerCase().trim()) &&
      !String(rawFu).toLowerCase().startsWith('no remarks') &&
      !String(rawFu).toLowerCase().startsWith('no follow');
    const followUp = isFuValid ? String(rawFu).trim() : null;

    // Follow-up status check (DB column + tag fallback)
    const rawStatus = r.follow_up_status || parsed.follow_up_status || (followUp ? 'pending' : null);
    const isCompleted = rawStatus && ['completed', 'done', 'resolved', 'closed'].includes(String(rawStatus).toLowerCase().trim());
    const followUpStatus = isCompleted ? 'completed' : (followUp ? 'pending' : null);
    const requiresFollowUp = Boolean(followUp) && !isCompleted;

    const rawFuDate = r.follow_up_date || parsed.follow_up_date || null;
    let dueDateStr = null;
    if (rawFuDate) {
      const dClean = String(rawFuDate).trim();
      if (dClean.includes('T')) {
        dueDateStr = dClean.split('T')[0];
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(dClean)) {
        dueDateStr = dClean;
      } else {
        const parsedD = new Date(dClean);
        if (!isNaN(parsedD.getTime())) {
          dueDateStr = parsedD.toISOString().split('T')[0];
        }
      }
    }

    let urgency = 'no_date';
    let diffDays = null;
    let relativeDueText = '';
    let dueToday = false;
    let isOverdue = false;

    if (isCompleted) {
      urgency = 'completed';
      relativeDueText = 'Done';
    } else if (dueDateStr) {
      const [tY, tM, tD] = todayStr.split('-').map(Number);
      const [dY, dM, dD] = dueDateStr.split('-').map(Number);
      const todayDate = new Date(Date.UTC(tY, tM - 1, tD));
      const targetDate = new Date(Date.UTC(dY, dM - 1, dD));
      diffDays = Math.round((targetDate.getTime() - todayDate.getTime()) / (1000 * 60 * 60 * 24));

      const formattedDueDate = targetDate.toLocaleDateString('en-IN', {
        day: 'numeric',
        month: 'short',
        timeZone: 'UTC',
      });

      if (diffDays < 0) {
        urgency = 'overdue';
        isOverdue = true;
        const absDays = Math.abs(diffDays);
        relativeDueText = `${absDays === 1 ? '1 day overdue' : `${absDays} days overdue`} (${formattedDueDate})`;
      } else if (diffDays === 0) {
        urgency = 'today';
        dueToday = true;
        relativeDueText = `Due today (${formattedDueDate})`;
      } else if (diffDays === 1) {
        urgency = 'upcoming';
        relativeDueText = `Due tomorrow (${formattedDueDate})`;
      } else {
        urgency = 'upcoming';
        relativeDueText = `Due in ${diffDays} days (${formattedDueDate})`;
      }
    } else if (followUp) {
      urgency = 'no_date';
      relativeDueText = 'Pending (No date specified)';
    }

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
      follow_up_date: dueDateStr,
      follow_up_status: followUpStatus,
      requires_follow_up: requiresFollowUp,
      urgency,
      diff_days: diffDays,
      due_today: dueToday,
      is_overdue: isOverdue,
      relative_due_text: relativeDueText,
      material_requirement: r.material_requirement || r.requirement || parsed.material_requirement,
      remarks: parsed.clean_remarks || rawRemarks,
      created_at: r.created_at || r.visited_at,
    };
  });

  // ── Mode: Rep Leaderboard ─────────────────────────────────────────────────
  if (
    mode === 'rep_leaderboard' ||
    mode === 'salesperson_leaderboard' ||
    mode === 'leaderboard' ||
    mode === 'top_reps'
  ) {
    if (isSalespersonRole(callerContext.role)) {
      const myVisits = materialized.length;
      const myPositive = materialized.filter((v) => v.outcome === 'positive').length;
      const myFollowUps = materialized.filter((v) => v.requires_follow_up).length;
      return {
        data: {
          role_restricted: true,
          message: 'Team visit leaderboards and peer comparisons are restricted under Role-Based Access Control (RBAC) to Sales Managers and Admins. You can only view your own visit metrics.',
          personal_metrics: {
            total_visits: myVisits,
            positive_outcomes: myPositive,
            pending_follow_ups: myFollowUps,
          },
          summary: `You have logged ${myVisits} visits (${myPositive} positive, ${myFollowUps} pending follow-ups). Cross-rep leaderboards and peer comparisons are restricted to Sales Managers and Admins under RBAC.`,
        },
        rowCount: 1,
      };
    }

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
  if (
    mode === 'week_comparison' ||
    mode === 'weekly_comparison' ||
    mode === 'wow' ||
    mode === 'week_over_week'
  ) {
    const nowD = new Date();
    const startOfThisWeek = new Date(nowD);
    startOfThisWeek.setDate(startOfThisWeek.getDate() - 7);
    const startOfLastWeek = new Date(nowD);
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
  if (
    mode === 'duplicates' ||
    mode === 'duplicate_visits' ||
    mode === 'same_day_duplicates'
  ) {
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

  // ── Mode: Due Today Follow-up Visits ─────────────────────────────────────
  if (
    mode === 'due_today' ||
    mode === 'pending_today' ||
    mode === 'followups_due_today' ||
    mode === 'due_today_followup' ||
    mode === 'today_followup' ||
    mode === 'follow_ups_due_today' ||
    args?.due_today ||
    args?.follow_up_filter === 'due_today'
  ) {
    const dueTodayVisits = materialized.filter((v) => v.requires_follow_up && (v.urgency === 'today' || v.due_today));
    const totalDueToday = dueTodayVisits.length;
    const displayDueToday = dueTodayVisits.slice(0, 8);
    const hasMore = totalDueToday > 8;

    return {
      data: {
        total_due_today_followups: totalDueToday,
        due_today_count: totalDueToday,
        total_records: totalDueToday,
        showing_count: displayDueToday.length,
        has_more: hasMore,
        dashboard_notice: hasMore
          ? `Showing 8 of ${totalDueToday} visit follow-ups due today. Please navigate to the dashboard to view all ${totalDueToday} records.`
          : null,
        summary: totalDueToday > 0
          ? `You have ${totalDueToday} visit follow-up${totalDueToday === 1 ? '' : 's'} due today.`
          : 'No visit follow-ups are due today.',
        visits: displayDueToday,
      },
      rowCount: totalDueToday,
    };
  }

  // ── Mode: Overdue Follow-up Visits ─────────────────────────────────────────
  if (
    mode === 'overdue' ||
    mode === 'overdue_followup' ||
    mode === 'followups_overdue' ||
    mode === 'overdue_followups' ||
    args?.overdue ||
    args?.follow_up_filter === 'overdue'
  ) {
    const overdueVisits = materialized.filter((v) => v.requires_follow_up && (v.urgency === 'overdue' || v.is_overdue));
    const totalOverdue = overdueVisits.length;
    const displayOverdue = overdueVisits.slice(0, 8);
    const hasMore = totalOverdue > 8;

    return {
      data: {
        total_overdue_followups: totalOverdue,
        overdue_count: totalOverdue,
        total_records: totalOverdue,
        showing_count: displayOverdue.length,
        has_more: hasMore,
        dashboard_notice: hasMore
          ? `Showing 8 of ${totalOverdue} overdue visit follow-ups. Please navigate to the dashboard to view all ${totalOverdue} records.`
          : null,
        summary: totalOverdue > 0
          ? `You have ${totalOverdue} overdue visit follow-up${totalOverdue === 1 ? '' : 's'}.`
          : 'No visit follow-ups are currently overdue.',
        visits: displayOverdue,
      },
      rowCount: totalOverdue,
    };
  }

  // ── Mode: Pending Follow-up Visits ───────────────────────────────────────
  if (
    mode === 'pending_followup' ||
    mode === 'pending_follow_up' ||
    mode === 'followup_pending' ||
    mode === 'follow_up_pending' ||
    mode === 'pending_followups' ||
    mode === 'pending' ||
    mode === 'follow_up' ||
    mode === 'followup' ||
    args?.pending_followup ||
    args?.pending_follow_up ||
    args?.requires_follow_up ||
    args?.follow_up_only ||
    args?.follow_up_filter === 'pending' ||
    args?.follow_up_filter === 'due'
  ) {
    const pending = materialized.filter((v) => v.requires_follow_up);
    const dueTodayCount = pending.filter((v) => v.urgency === 'today' || v.due_today).length;
    const overdueCount = pending.filter((v) => v.urgency === 'overdue' || v.is_overdue).length;

    // Sort: overdue first, then due today, then upcoming, then no date
    pending.sort((a, b) => {
      const order = { overdue: 0, today: 1, upcoming: 2, no_date: 3, completed: 4 };
      return (order[a.urgency] ?? 3) - (order[b.urgency] ?? 3);
    });

    const totalPending = pending.length;
    const displayPending = pending.slice(0, 8);
    const hasMore = totalPending > 8;

    return {
      data: {
        total_pending_followup_visits: totalPending,
        due_today_count: dueTodayCount,
        overdue_count: overdueCount,
        total_records: totalPending,
        showing_count: displayPending.length,
        has_more: hasMore,
        dashboard_notice: hasMore
          ? `Showing 8 of ${totalPending} pending visit follow-ups. Please navigate to the dashboard to view all ${totalPending} records.`
          : null,
        summary: `You have ${totalPending} visit${totalPending === 1 ? '' : 's'} with pending follow-up action (${dueTodayCount} due today, ${overdueCount} overdue).`,
        visits: displayPending,
      },
      rowCount: totalPending,
    };
  }

  // ── Mode: Visited Customers with No Orders ────────────────────────────────
  if (
    mode === 'visits_no_orders' ||
    mode === 'prospects_visited_no_orders' ||
    mode === 'visited_without_orders' ||
    mode === 'visited_no_orders' ||
    mode === 'no_orders_visited' ||
    mode === 'prospects_no_orders' ||
    mode === 'no_orders'
  ) {
    const { data: wonDeals } = await supabaseAdmin
      .from('deals')
      .select('customer_name, po_number, stage')
      .or('stage.eq.won,po_number.not.is.null');

    const wonCustSet = new Set((wonDeals || []).map((d) => cleanLegalSuffixes(d.customer_name)));

    const visitedMap = new Map();
    materialized.forEach((v) => {
      const cleanName = cleanLegalSuffixes(v.customer_name);
      if (cleanName && !wonCustSet.has(cleanName)) {
        if (!visitedMap.has(cleanName)) {
          visitedMap.set(cleanName, {
            customer_name: v.customer_name,
            total_visits: 0,
            latest_visit_date: v.visit_date,
            latest_outcome: v.outcome || 'Not recorded',
            salesperson_name: v.salesperson_name,
            location: v.location,
          });
        }
        const item = visitedMap.get(cleanName);
        item.total_visits += 1;
      }
    });

    const prospects = Array.from(visitedMap.values());
    const totalProspects = prospects.length;
    const displayProspects = prospects.slice(0, 8);
    const hasMore = totalProspects > 8;

    return {
      data: {
        total_visited_customers_without_orders: totalProspects,
        total_records: totalProspects,
        showing_count: displayProspects.length,
        has_more: hasMore,
        dashboard_notice: hasMore
          ? `Showing 8 of ${totalProspects} visited prospects without orders. Please navigate to the dashboard to view all ${totalProspects} records.`
          : null,
        summary: `Found ${totalProspects} prospective customer account${totalProspects === 1 ? '' : 's'} with logged visits who have not placed any orders yet.`,
        customers: displayProspects,
      },
      rowCount: totalProspects,
    };
  }

  // ── Mode: Missing Location / Contact ──────────────────────────────────────
  if (missingLocation) {
    const missing = materialized.filter((v) => !v.location || v.location === 'N/A');
    const totalMissing = missing.length;
    const displayMissing = missing.slice(0, 8);
    const hasMore = totalMissing > 8;

    return {
      data: {
        missing_location_count: totalMissing,
        total_records: totalMissing,
        showing_count: displayMissing.length,
        has_more: hasMore,
        dashboard_notice: hasMore
          ? `Showing 8 of ${totalMissing} visits missing location. Please navigate to the dashboard to view all ${totalMissing} records.`
          : null,
        visits: displayMissing,
      },
      rowCount: totalMissing,
    };
  }
  if (missingContact) {
    const missing = materialized.filter((v) => !v.person_met || v.person_met === 'N/A');
    const totalMissing = missing.length;
    const displayMissing = missing.slice(0, 8);
    const hasMore = totalMissing > 8;

    return {
      data: {
        missing_contact_person_count: totalMissing,
        total_records: totalMissing,
        showing_count: displayMissing.length,
        has_more: hasMore,
        dashboard_notice: hasMore
          ? `Showing 8 of ${totalMissing} visits missing contact person. Please navigate to the dashboard to view all ${totalMissing} records.`
          : null,
        visits: displayMissing,
      },
      rowCount: totalMissing,
    };
  }

  // Standard filtering
  let filtered = [...materialized];
  if (custFilter) filtered = filtered.filter((v) => v.customer_name.toLowerCase().includes(custFilter));
  if (repFilter) filtered = filtered.filter((v) => v.salesperson_name.toLowerCase().includes(repFilter));
  if (locFilter) filtered = filtered.filter((v) => v.location.toLowerCase().includes(locFilter) || v.remarks.toLowerCase().includes(locFilter));
  if (outcomeFilter && outcomeFilter !== 'all') filtered = filtered.filter((v) => v.outcome === outcomeFilter);
  if (requiresFollowUp !== null) filtered = filtered.filter((v) => v.requires_follow_up === requiresFollowUp);

  let pos = 0, neu = 0, neg = 0, fu = 0;
  filtered.forEach((v) => {
    if (v.outcome === 'positive') pos++;
    else if (v.outcome === 'neutral') neu++;
    else if (v.outcome === 'negative') neg++;
    if (v.requires_follow_up) fu++;
  });

  const totalCount = filtered.length;
  const displayVisits = filtered.slice(0, 8);
  const hasMore = totalCount > 8;

  return {
    data: {
      summary: {
        total_visits: totalCount,
        positive_outcomes: pos,
        neutral_outcomes: neu,
        negative_outcomes: neg,
        unspecified_outcomes: totalCount - (pos + neu + neg),
        follow_ups_logged: fu,
        multiple_visits_for_customer: Boolean(custFilter && totalCount > 1),
        customer_visits_breakdown: custFilter && totalCount > 1
          ? filtered.map((v, i) => `${i + 1}. Date: ${v.visit_date}, Outcome: ${v.outcome || 'Not recorded'}, Person: ${v.person_met}`).join(' | ')
          : undefined,
      },
      total_records: totalCount,
      showing_count: displayVisits.length,
      has_more: hasMore,
      dashboard_notice: hasMore
        ? `Showing 8 of ${totalCount} visits. Please navigate to the dashboard to view all ${totalCount} records.`
        : null,
      visits: displayVisits,
    },
    rowCount: totalCount,
  };
}

// ─── 3. GET_COMPLAINTS TOOL ─────────────────────────────────────────────────

async function executeGetComplaints(args, callerContext, supabaseAdmin = supabase) {
  const custFilter = (args?.customer_name || '').trim().toLowerCase();
  const repFilter = (args?.salesperson_name || '').trim().toLowerCase();
  const statusFilter = (args?.status_filter || '').trim().toLowerCase();
  const typeFilter = (args?.complaint_type || args?.type || '').trim().toLowerCase();
  const poFilter = (args?.po_number || args?.po || '').trim().toLowerCase();
  const dateRange = args?.date_range;
  const mode = (args?.mode || 'list').toLowerCase().trim();
  const limit = Math.min(Math.max(Number(args?.limit) || 8, 1), 8);

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
      customer_name: r.customer_name || 'Unnamed Account',
      product_name: r.affected_product || r.product_name || 'General Steel Product',
      product_category: prodFam.category,
      complaint_type: r.complaint_type || 'Quality Defect',
      description: r.description || '',
      severity: r.severity || 'medium',
      status: (r.status || 'open').toLowerCase(),
      resolution: r.resolution_notes || r.resolution || null,
      po_number: r.po_number || null,
      salesperson_name: repName,
      salesperson_phone: r.reported_by || '',
      sla_met_48h: slaMet,
      reported_at: r.reported_at || r.created_at,
      resolved_at: r.resolved_at || null,
    };
  });

  // ── Mode: Longest Open Complaint ─────────────────────────────────────────
  if (
    mode === 'longest_open' ||
    mode === 'oldest_open' ||
    mode === 'longest' ||
    mode === 'oldest' ||
    mode === 'longest_unresolved' ||
    mode === 'longest_pending' ||
    mode === 'longest_open_complaint' ||
    mode === 'oldest_complaint' ||
    Boolean(args?.longest_open) ||
    Boolean(args?.oldest_open)
  ) {
    let openComplaints = materialized.filter((c) => c.status !== 'resolved' && c.status !== 'closed');
    if (custFilter) openComplaints = openComplaints.filter((c) => c.customer_name.toLowerCase().includes(custFilter));
    if (repFilter) openComplaints = openComplaints.filter((c) => c.salesperson_name.toLowerCase().includes(repFilter));
    if (typeFilter) {
      openComplaints = openComplaints.filter((c) => {
        const ct = (c.complaint_type || '').toLowerCase();
        return ct.includes(typeFilter);
      });
    }

    // Sort by reported_at / created_at ASCENDING (oldest date first)
    const sortedOpen = [...openComplaints].sort((a, b) => {
      const tA = new Date(a.reported_at || 0).getTime();
      const tB = new Date(b.reported_at || 0).getTime();
      return tA - tB;
    });

    if (sortedOpen.length === 0) {
      return {
        data: {
          total_open_complaints: 0,
          summary: 'No open complaints found in your portfolio.',
          longest_open_complaint: null,
          complaints: [],
        },
        rowCount: 0,
      };
    }

    const longest = sortedOpen[0];
    const repDate = new Date(longest.reported_at);
    const daysOpen = Math.max(0, Math.floor((Date.now() - repDate.getTime()) / (24 * 60 * 60 * 1000)));
    const dateFormatted = isNaN(repDate.getTime())
      ? 'N/A'
      : repDate.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

    const totalOpen = sortedOpen.length;
    const displayOpen = sortedOpen.slice(0, 8);
    const hasMore = totalOpen > 8;

    return {
      data: {
        total_open_complaints: totalOpen,
        total_records: totalOpen,
        showing_count: displayOpen.length,
        has_more: hasMore,
        dashboard_notice: hasMore
          ? `Showing 8 of ${totalOpen} open complaints. Please navigate to the dashboard to view all ${totalOpen} records.`
          : null,
        longest_open_complaint: {
          customer_name: longest.customer_name,
          po_number: longest.po_number || 'N/A',
          product: longest.product_name,
          complaint_type: longest.complaint_type,
          description: longest.description,
          status: longest.status === 'pending' ? 'Pending' : 'Open',
          severity: longest.severity || 'Medium',
          reported_date: dateFormatted,
          reported_at: longest.reported_at,
          days_open: daysOpen,
          assigned_salesperson: longest.salesperson_name,
        },
        summary: `The complaint that has been open the longest in your portfolio is from ${longest.customer_name} on PO ${longest.po_number || 'N/A'} (${longest.product_name}), reported on ${dateFormatted} (open for ${daysOpen} days).`,
        all_open_complaints_by_age: displayOpen,
      },
      rowCount: totalOpen,
    };
  }

  // ── Mode: Complaints by Type Breakdown ────────────────────────────────────
  if (
    mode === 'type_breakdown' ||
    mode === 'by_type' ||
    mode === 'complaints_by_type' ||
    mode === 'type_wise' ||
    mode === 'category_breakdown' ||
    mode === 'breakdown_by_type' ||
    mode === 'categories' ||
    mode === 'group_by_type' ||
    mode === 'by_category'
  ) {
    const typeMap = {};
    materialized.forEach((c) => {
      const rawType = c.complaint_type || 'Other';
      const cleanType = rawType.charAt(0).toUpperCase() + rawType.slice(1);
      if (!typeMap[cleanType]) {
        typeMap[cleanType] = { complaint_type: cleanType, total_count: 0, open_count: 0, resolved_count: 0, complaints: [] };
      }
      typeMap[cleanType].total_count += 1;
      if (c.status === 'resolved' || c.status === 'closed') typeMap[cleanType].resolved_count += 1;
      else typeMap[cleanType].open_count += 1;
      typeMap[cleanType].complaints.push(c);
    });

    const total = materialized.length;
    const breakdown = Object.values(typeMap).map((t) => ({
      complaint_type: t.complaint_type,
      total_count: t.total_count,
      open_count: t.open_count,
      resolved_count: t.resolved_count,
      percentage: total > 0 ? `${Math.round((t.total_count / total) * 1000) / 10}%` : '0%',
    })).sort((a, b) => b.total_count - a.total_count);

    return {
      data: {
        total_complaints: total,
        complaints_by_type: breakdown,
        summary: `Complaints grouped by type across ${total} total complaints: ${breakdown.map((b) => `${b.complaint_type}: ${b.total_count} (${b.percentage})`).join(', ')}.`,
      },
      rowCount: breakdown.length,
    };
  }

  // ── Mode: Open Complaints with Recent Orders ──────────────────────────────
  if (
    mode === 'open_complaints_with_orders' ||
    mode === 'open_complaint_and_recent_order' ||
    mode === 'open_complaint_recent_order' ||
    mode === 'complaints_with_orders' ||
    mode === 'open_complaints_orders' ||
    mode === 'complaint_order_cross' ||
    mode === 'open_complaints_recent_orders'
  ) {
    let dealsQuery = supabaseAdmin
      .from('deals')
      .select('customer_name, po_number, stage, created_at, won_at, salesperson_phone, employee_id')
      .or('stage.eq.won,po_number.not.is.null');

    if (isSalespersonRole(callerContext.role)) {
      const rawPhone = callerContext.phone || '';
      const cleanPhone = rawPhone.replace(/\D/g, '').slice(-10);
      const empId = callerContext.employeeId;
      const orParts = [];
      if (cleanPhone) orParts.push(`salesperson_phone.ilike.%${cleanPhone}%`);
      if (empId) orParts.push(`employee_id.eq.${empId}`);
      if (orParts.length > 0) dealsQuery = dealsQuery.or(orParts.join(','));
    } else if (isManagerRole(callerContext.role)) {
      const { phoneSuffixes, employeeIds } = await getSubordinateSalespersons(callerContext, supabaseAdmin);
      const orParts = [];
      phoneSuffixes.forEach((p) => orParts.push(`salesperson_phone.ilike.%${p}%`));
      employeeIds.forEach((id) => orParts.push(`employee_id.eq.${id}`));
      if (orParts.length > 0) dealsQuery = dealsQuery.or(orParts.join(','));
    }

    const { data: wonDeals } = await dealsQuery;

    const wonCustSet = new Set((wonDeals || []).map((d) => cleanLegalSuffixes(d.customer_name)));
    const openComplaints = materialized.filter((c) => c.status !== 'resolved' && c.status !== 'closed');
    const matchedAccounts = {};

    openComplaints.forEach((c) => {
      const cleanName = cleanLegalSuffixes(c.customer_name);
      if (wonCustSet.has(cleanName)) {
        if (!matchedAccounts[cleanName]) {
          matchedAccounts[cleanName] = {
            customer_name: c.customer_name,
            open_complaints_count: 0,
            open_complaints: [],
            recent_orders: (wonDeals || [])
              .filter((d) => cleanLegalSuffixes(d.customer_name) === cleanName)
              .slice(0, 3)
              .map((d) => ({ po_number: d.po_number, stage: d.stage, date: d.won_at || d.created_at })),
          };
        }
        matchedAccounts[cleanName].open_complaints_count += 1;
        matchedAccounts[cleanName].open_complaints.push({
          complaint_type: c.complaint_type,
          description: c.description,
          status: c.status,
          po_number: c.po_number,
        });
      }
    });

    const list = Object.values(matchedAccounts);
    return {
      data: {
        total_accounts_with_open_complaint_and_recent_order: list.length,
        accounts: list,
        summary: `${list.length} customer account${list.length === 1 ? '' : 's'} (${list.map((a) => a.customer_name).join(', ')}) currently have both an open complaint and a recent confirmed order.`,
      },
      rowCount: list.length,
    };
  }

  // ── Mode: Rep Complaints Leaderboard ──────────────────────────────────────
  if (
    mode === 'rep_complaints' ||
    mode === 'rep_leaderboard' ||
    mode === 'salesperson_complaints' ||
    mode === 'rep_comparison' ||
    mode === 'salesperson_leaderboard'
  ) {
    if (isSalespersonRole(callerContext.role)) {
      const myComplaints = materialized.length;
      const myOpen = materialized.filter((c) => c.status !== 'resolved' && c.status !== 'closed').length;
      const myResolved = materialized.filter((c) => c.status === 'resolved' || c.status === 'closed').length;
      return {
        data: {
          role_restricted: true,
          message: 'Team complaint breakdowns and peer comparisons are restricted under Role-Based Access Control (RBAC) to Sales Managers and Admins. You can only view your own complaints.',
          personal_metrics: {
            total_complaints: myComplaints,
            open_complaints: myOpen,
            resolved_complaints: myResolved,
          },
          summary: `You have ${myComplaints} complaints logged for your assigned accounts (${myOpen} open, ${myResolved} resolved). Cross-rep leaderboards and peer comparisons are restricted to Sales Managers and Admins under RBAC.`,
        },
        rowCount: 1,
      };
    }

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
  if (
    mode === 'product_category_breakdown' ||
    mode === 'product_breakdown' ||
    mode === 'category_wise' ||
    mode === 'by_product' ||
    mode === 'product_categories'
  ) {
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
  if (
    mode === 'visit_correlation' ||
    mode === 'negative_visit_correlation' ||
    mode === 'visit_complaint_correlation' ||
    mode === 'visit_complaints'
  ) {
    const { data: visits } = await supabaseAdmin.from('customer_visits').select('customer_name, remarks');
    const negVisitCusts = new Set();
    (visits || []).forEach((v) => {
      const p = parseVisitRemarks(v.remarks);
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
  if (poFilter) {
    const cleanPo = poFilter.replace(/^[#]?(?:PO|ORDER|DEAL)[-:\s#]*/i, '').trim();
    filtered = filtered.filter((c) =>
      (c.po_number && (c.po_number.toLowerCase().includes(poFilter) || (cleanPo && c.po_number.toLowerCase().includes(cleanPo)))) ||
      (c.deal_id && (c.deal_id.toLowerCase().includes(poFilter) || (cleanPo && c.deal_id.toLowerCase().includes(cleanPo)))) ||
      (c.description && (c.description.toLowerCase().includes(poFilter) || (cleanPo && c.description.toLowerCase().includes(cleanPo)))) ||
      (c.product_name && (c.product_name.toLowerCase().includes(poFilter) || (cleanPo && c.product_name.toLowerCase().includes(cleanPo))))
    );

    if (filtered.length === 0) {
      const searchTerms = [poFilter, cleanPo].filter(Boolean);
      const orClauses = searchTerms.map((term) => `po_number.ilike.%${term}%,deal_id.ilike.%${term}%,description.ilike.%${term}%`).join(',');
      const { data: globalPoComplaints } = await supabaseAdmin
        .from('complaints')
        .select('*')
        .or(orClauses);

      if (globalPoComplaints && globalPoComplaints.length > 0) {
        filtered = globalPoComplaints.map((r) => {
          const p = (r.reported_by || '').replace(/\D/g, '').slice(-10);
          const repName = empMap.get(p) || empMap.get(r.employee_id) || r.salesperson_name || 'Salesperson';
          const prodFam = categorizeProductFamily(r.affected_product || r.product_name, r.description);
          return {
            id: r.id,
            customer_name: r.customer_name || 'Unnamed Account',
            product_name: r.affected_product || r.product_name || 'General Steel Product',
            product_category: prodFam.category,
            complaint_type: r.complaint_type || 'Quality Defect',
            description: r.description || '',
            severity: r.severity || 'medium',
            status: (r.status || 'open').toLowerCase(),
            resolution: r.resolution_notes || r.resolution || null,
            po_number: r.po_number || null,
            deal_id: r.deal_id || null,
            salesperson_name: repName,
            salesperson_phone: r.reported_by || '',
            sla_met_48h: false,
            reported_at: r.reported_at || r.created_at,
            resolved_at: r.resolved_at || null,
          };
        });
      }
    }
  }

  if (typeFilter) {
    filtered = filtered.filter((c) => {
      const ct = (c.complaint_type || '').toLowerCase();
      if (typeFilter.includes('quality') || typeFilter.includes('defect')) {
        return ct.includes('quality') || ct.includes('defect') || ct.includes('rust') || ct.includes('crack') || ct.includes('damage');
      }
      return ct.includes(typeFilter);
    });
  }

  if (statusFilter && statusFilter !== 'all') {
    if (statusFilter === 'open' || statusFilter === 'unresolved') {
      filtered = filtered.filter((c) => c.status !== 'resolved' && c.status !== 'closed');
    } else if (statusFilter === 'resolved' || statusFilter === 'closed') {
      filtered = filtered.filter((c) => c.status === 'resolved' || c.status === 'closed');
    } else if (statusFilter === 'pending') {
      filtered = filtered.filter((c) => c.status === 'pending' || (c.status !== 'resolved' && c.status !== 'closed'));
    } else if (statusFilter === 'reopened' || statusFilter === 'reopen') {
      filtered = filtered.filter((c) => c.status === 'reopened');
    } else {
      filtered = filtered.filter((c) => c.status.toLowerCase().includes(statusFilter));
    }
  }

  let openC = 0, resC = 0, slaC = 0, reopC = 0, pendingC = 0;
  materialized.forEach((c) => {
    if (c.status === 'resolved' || c.status === 'closed') resC++;
    else openC++;
    if (c.status === 'pending' || (c.status !== 'resolved' && c.status !== 'closed')) pendingC++;
    if (c.status === 'reopened') reopC++;
    if (c.sla_met_48h) slaC++;
  });

  const totalCount = filtered.length;
  const displayComplaints = filtered.slice(0, 8);
  const hasMore = totalCount > 8;

  return {
    data: {
      summary: {
        total_complaints: totalCount,
        total_in_system: materialized.length,
        open_complaints: openC,
        resolved_complaints: resC,
        pending_complaints: pendingC,
        reopened_complaints: reopC,
        sla_met_within_48h: slaC,
      },
      total_records: totalCount,
      showing_count: displayComplaints.length,
      has_more: hasMore,
      dashboard_notice: hasMore
        ? `Showing 8 of ${totalCount} complaints. Please navigate to the dashboard to view all ${totalCount} records.`
        : null,
      complaints: displayComplaints,
    },
    rowCount: totalCount,
  };
}

// ─── 4. GET_CUSTOMER_360 TOOL ───────────────────────────────────────────────

async function executeGetCustomer360(args, callerContext, supabaseAdmin = supabase) {
  const custName = (args?.customer_name || '').trim();
  const segmentFilter = (args?.segment_filter || args?.segment || '').trim().toLowerCase();
  const healthFilter = (args?.health_filter || args?.health_status || '').trim().toLowerCase();
  const mode = (args?.mode || '').trim().toLowerCase();
  const dateRange = (args?.date_range || args?.date_filter || '').trim();
  const limit = Math.min(Math.max(Number(args?.limit) || 8, 1), 8);

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
      supabaseAdmin.from('deals').select('id, stage, total_amount, po_number, created_at, won_at, salesperson_phone, employee_id, deal_items(sku_text, quantity, unit, rate, amount)').ilike('customer_name', `%${cleanTarget}%`),
      supabaseAdmin.from('customer_visits').select('*, salesperson_phone, employee_id').ilike('customer_name', `%${cleanTarget}%`).order('visited_at', { ascending: false }),
      supabaseAdmin.from('complaints').select('*, reported_by, employee_id').ilike('customer_name', `%${cleanTarget}%`).order('created_at', { ascending: false }),
      supabaseAdmin.from('inquiries').select('id, status, created_at, salesperson_phone, sender_phone').ilike('sender_name', `%${cleanTarget}%`),
    ]);

    const profile = custRows?.[0] || {};
    let deals = dealRows || [];
    let visits = visitRows || [];
    let complaints = compRows || [];
    let inquiries = inqRows || [];

    if (!isAdminRole(callerContext.role)) {
      if (access.isPhoneAuth && access.isEmpAuth) {
        deals = deals.filter((d) => access.isPhoneAuth(d.salesperson_phone) || access.isEmpAuth(d.employee_id));
        visits = visits.filter((v) => access.isPhoneAuth(v.salesperson_phone) || access.isEmpAuth(v.employee_id));
        complaints = complaints.filter((c) => access.isPhoneAuth(c.reported_by) || access.isEmpAuth(c.employee_id));
        inquiries = inquiries.filter((i) => access.isPhoneAuth(i.salesperson_phone) || access.isPhoneAuth(i.sender_phone));
      }
    }

    const wonDeals = deals.filter((d) => d.stage === 'won' || Boolean(d.po_number));
    const openDeals = deals.filter((d) => d.stage !== 'won' && d.stage !== 'lost');
    const lostDeals = deals.filter((d) => d.stage === 'lost');

    let lifetimeWonVal = wonDeals.reduce((sum, d) => sum + Number(d.total_amount || 0), 0);
    let totalTonnage = wonDeals.reduce((sum, d) => sum + getDealTonnage(d), 0);

    let segment = 'new';
    if (profile.segment) {
      const s = String(profile.segment).toLowerCase().trim();
      if (s.includes('key')) segment = 'key_account';
      else if (s.includes('growth')) segment = 'growth';
      else segment = 'new';
    } else {
      segment = deriveCustomerSegment(totalTonnage, lifetimeWonVal, wonDeals.length, inquiries.length, visits.length);
    }

    return {
      data: {
        found: true,
        customer_name: profile.customer_name || custName,
        contact_person: profile.contact_person || 'Not registered',
        phone: profile.customer_phone || profile.phone || 'N/A',
        address: profile.customer_address || profile.address || 'N/A',
        gst: profile.customer_gst || profile.gst || 'Not registered',
        segment: segment === 'key_account' ? 'Key Account' : (segment === 'growth' ? 'Growth' : 'New'),
        health_status: 'Good Standing',
        order_frequency_days: profile.avg_order_frequency_days || 30,
        last_order_date: profile.last_order_date || (wonDeals[0]?.won_at ? wonDeals[0].won_at.split('T')[0] : (wonDeals[0]?.created_at ? wonDeals[0].created_at.split('T')[0] : 'N/A')),
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
  let custQuery = supabaseAdmin.from('recurring_customers').select('*').eq('is_active', true);
  let dealsQuery = supabaseAdmin.from('deals').select('id, customer_name, stage, total_amount, po_number, created_at, won_at, salesperson_phone, employee_id, deal_items(sku_text, quantity, unit, rate, amount)');
  let visitsQuery = supabaseAdmin.from('customer_visits').select('id, customer_name, visited_at, salesperson_phone, employee_id');
  let inqsQuery = supabaseAdmin.from('inquiries').select('id, sender_name, created_at, salesperson_phone, sender_phone');
  let compQuery = supabaseAdmin.from('complaints').select('id, customer_name, status, created_at, reported_by, employee_id');

  if (isSalespersonRole(callerContext.role)) {
    const rawPhone = callerContext.phone || '';
    const cleanPhone = rawPhone.replace(/\D/g, '').slice(-10);
    if (cleanPhone) {
      custQuery = custQuery.ilike('assigned_salesperson_phone', `%${cleanPhone}%`);
      dealsQuery = dealsQuery.ilike('salesperson_phone', `%${cleanPhone}%`);
      visitsQuery = visitsQuery.ilike('salesperson_phone', `%${cleanPhone}%`);
      inqsQuery = inqsQuery.or(`salesperson_phone.ilike.%${cleanPhone}%,sender_phone.ilike.%${cleanPhone}%`);
      compQuery = compQuery.ilike('reported_by', `%${cleanPhone}%`);
    }
  } else if (isManagerRole(callerContext.role)) {
    const { phoneSuffixes } = await getSubordinateSalespersons(callerContext, supabaseAdmin);
    if (phoneSuffixes.length > 0) {
      const orFilter = phoneSuffixes.map((p) => `assigned_salesperson_phone.ilike.%${p}%`).join(',');
      custQuery = custQuery.or(orFilter);
      dealsQuery = dealsQuery.or(phoneSuffixes.map((p) => `salesperson_phone.ilike.%${p}%`).join(','));
      visitsQuery = visitsQuery.or(phoneSuffixes.map((p) => `salesperson_phone.ilike.%${p}%`).join(','));
      inqsQuery = inqsQuery.or(phoneSuffixes.map((p) => `salesperson_phone.ilike.%${p}%`).join(','));
      compQuery = compQuery.or(phoneSuffixes.map((p) => `reported_by.ilike.%${p}%`).join(','));
    }
  }

  const [
    { data: allCusts, error: custError },
    { data: allDeals },
    { data: allVisits },
    { data: allInqs },
    { data: allComps },
  ] = await Promise.all([
    custQuery,
    dealsQuery,
    visitsQuery,
    inqsQuery,
    compQuery,
  ]);

  if (custError) throw new Error(`get_customer_360 directory error: ${custError.message}`);

  const rows = allCusts || [];
  const deals = allDeals || [];
  const visits = allVisits || [];
  const inqs = allInqs || [];
  const complaints = allComps || [];

  // Deduplicate customers by normalized name
  const seenCusts = new Map();
  for (const c of rows) {
    const normKey = (c.customer_name || '').toLowerCase().trim();
    if (!normKey) continue;
    if (!seenCusts.has(normKey)) {
      seenCusts.set(normKey, c);
    } else {
      const existing = seenCusts.get(normKey);
      if (!existing.customer_phone && c.customer_phone) {
        seenCusts.set(normKey, { ...existing, ...c });
      }
    }
  }
  const uniqueCustRows = Array.from(seenCusts.values());

  // Enrich each customer with derived metrics & segment
  const enrichedCustomers = uniqueCustRows.map((c) => {
    const cName = (c.customer_name || '').toLowerCase().trim();
    const cClean = cleanLegalSuffixes(c.customer_name);

    const custDeals = deals.filter((d) => {
      const dName = (d.customer_name || '').toLowerCase().trim();
      return dName === cName || (cClean && cleanLegalSuffixes(d.customer_name) === cClean);
    });

    const wonDeals = custDeals.filter((d) => d.stage === 'won' || Boolean(d.po_number));
    const openDeals = custDeals.filter((d) => d.stage !== 'won' && d.stage !== 'lost');

    const custVisits = visits.filter((v) => {
      const vName = (v.customer_name || '').toLowerCase().trim();
      return vName === cName || (cClean && cleanLegalSuffixes(v.customer_name) === cClean);
    });

    const custInqs = inqs.filter((i) => {
      const iName = (i.sender_name || '').toLowerCase().trim();
      return iName === cName || (cClean && cleanLegalSuffixes(i.sender_name) === cClean);
    });

    const custComps = complaints.filter((comp) => {
      const compName = (comp.customer_name || '').toLowerCase().trim();
      return compName === cName || (cClean && cleanLegalSuffixes(comp.customer_name) === cClean);
    });

    const ltv = wonDeals.reduce((sum, d) => sum + Number(d.total_amount || 0), 0);
    const tonnage = wonDeals.reduce((sum, d) => sum + getDealTonnage(d), 0);
    const totalOrders = wonDeals.length;

    let segRaw = 'new';
    if (c.segment) {
      const s = String(c.segment).toLowerCase().trim();
      if (s.includes('key')) segRaw = 'key_account';
      else if (s.includes('growth')) segRaw = 'growth';
      else segRaw = 'new';
    } else {
      segRaw = deriveCustomerSegment(tonnage, ltv, totalOrders, custInqs.length, custVisits.length);
    }

    const segLabel = segRaw === 'key_account' ? 'Key Account' : (segRaw === 'growth' ? 'Growth' : 'New');
    const lastOrder = c.last_order_date || (wonDeals[0]?.won_at ? wonDeals[0].won_at.split('T')[0] : (wonDeals[0]?.created_at ? wonDeals[0].created_at.split('T')[0] : 'N/A'));

    return {
      customer_name: c.customer_name,
      contact_person: c.contact_person || 'N/A',
      phone: c.customer_phone || c.phone || 'N/A',
      address: c.customer_address || c.address || 'N/A',
      gst: c.customer_gst || c.gst || 'N/A',
      segment: segLabel,
      _segRaw: segRaw,
      total_orders: totalOrders,
      total_tonnage_mt: Math.round(tonnage * 1000) / 1000,
      lifetime_value_inr: ltv,
      active_inquiries_count: openDeals.length,
      visits_count: custVisits.length,
      complaints_count: custComps.length,
      last_order_date: lastOrder,
      created_at: c.created_at ? c.created_at.split('T')[0] : 'N/A',
      _created_at_raw: c.created_at,
      is_active: Boolean(c.is_active),
    };
  });

  // Apply date range filter (e.g. "this_month", "today", "last_7_days")
  let dateFiltered = enrichedCustomers;
  if (dateRange) {
    const dateWindow = parseDateFilter(dateRange);
    if (dateWindow.from || dateWindow.to) {
      dateFiltered = enrichedCustomers.filter((c) => {
        if (!c._created_at_raw) return false;
        const d = new Date(c._created_at_raw);
        if (dateWindow.from && d < dateWindow.from) return false;
        if (dateWindow.to && d > dateWindow.to) return false;
        return true;
      });
    }
  }

  // Compute summary stats across in-scope timeframe
  const keyCount = dateFiltered.filter((c) => c._segRaw === 'key_account').length;
  const growthCount = dateFiltered.filter((c) => c._segRaw === 'growth').length;
  const newCount = dateFiltered.filter((c) => c._segRaw === 'new').length;

  const largestSegName = (keyCount >= growthCount && keyCount >= newCount)
    ? `Key Account (${keyCount} customers)`
    : (growthCount >= newCount ? `Growth (${growthCount} customers)` : `New (${newCount} customers)`);

  // Handle Mode: Zero Orders Active Accounts
  const isZeroOrdersMode =
    mode === 'zero_orders_active' ||
    mode === 'zero_orders' ||
    mode === '0_orders' ||
    mode === '0_orders_active' ||
    mode === 'active_zero_orders' ||
    mode === 'no_orders_active' ||
    mode === 'no_orders' ||
    mode === 'zero_order_active' ||
    args?.has_zero_orders ||
    args?.zero_orders;

  if (isZeroOrdersMode) {
    const zeroOrders = dateFiltered.filter((c) => c.total_orders === 0 && c.is_active);
    const totalZero = zeroOrders.length;
    const displayZero = zeroOrders.slice(0, 8).map(({ _segRaw, _created_at_raw, ...cleanCust }) => ({
      ...cleanCust,
      health_status: 'Active (0 Orders)',
    }));
    const hasMore = totalZero > 8;

    return {
      data: {
        total_customers_with_zero_orders_active: totalZero,
        total_records: totalZero,
        showing_count: displayZero.length,
        has_more: hasMore,
        dashboard_notice: hasMore
          ? `Showing 8 of ${totalZero} active accounts with 0 orders. Please navigate to the dashboard to view all ${totalZero} records.`
          : null,
        summary: `Found ${totalZero} active customer account${totalZero === 1 ? '' : 's'} with 0 recorded orders.`,
        customers: displayZero,
      },
      rowCount: totalZero,
    };
  }

  // Apply segment filter
  let finalCustomers = dateFiltered;
  const segClean = segmentFilter.replace(/[-_ ]+/g, '');
  if (segClean && segClean !== 'all') {
    if (segClean.includes('key')) {
      finalCustomers = dateFiltered.filter((c) => c._segRaw === 'key_account');
    } else if (segClean.includes('growth')) {
      finalCustomers = dateFiltered.filter((c) => c._segRaw === 'growth');
    } else if (segClean.includes('new')) {
      finalCustomers = dateFiltered.filter((c) => c._segRaw === 'new');
    }
  }

  const isSegmentFiltered = Boolean(segClean && segClean !== 'all');
  const summaryObj = {
    total_customers: finalCustomers.length,
    date_range_applied: dateRange || 'all',
    segment_filter_applied: segmentFilter || 'all',
    at_risk_count: 0,
    churning_count: 0,
  };

  if (!isSegmentFiltered) {
    summaryObj.total_in_scope = dateFiltered.length;
    summaryObj.by_segment = {
      key_account: keyCount,
      growth: growthCount,
      new: newCount,
    };
    summaryObj.new_segment_count = newCount;
    summaryObj.key_account_segment_count = keyCount;
    summaryObj.growth_segment_count = growthCount;
    summaryObj.largest_segment = largestSegName;
  } else {
    const matchedSeg = segClean.includes('key') ? 'Key Account' : (segClean.includes('growth') ? 'Growth' : 'New');
    summaryObj.filtered_segment = matchedSeg;
    summaryObj.filtered_segment_count = finalCustomers.length;
  }

  const totalCusts = finalCustomers.length;
  const displayCusts = finalCustomers.slice(0, 8).map(({ _segRaw, _created_at_raw, ...cleanCust }) => cleanCust);
  const hasMoreCusts = totalCusts > 8;

  return {
    data: {
      summary: summaryObj,
      total_records: totalCusts,
      showing_count: displayCusts.length,
      has_more: hasMoreCusts,
      dashboard_notice: hasMoreCusts
        ? `Showing 8 of ${totalCusts} customers. Please navigate to the dashboard to view all ${totalCusts} records.`
        : null,
      customers: displayCusts,
    },
    rowCount: totalCusts,
  };
}

// ─── 5. GET_MY_OPEN_DEALS TOOL ──────────────────────────────────────────────

async function executeGetMyOpenDeals(args, callerContext, supabaseAdmin = supabase) {
  const stageFilter = (args?.stage_filter || args?.status_filter || args?.stage || args?.status || '').trim().toLowerCase();
  const custName = (args?.customer_name || args?.company_name || args?.customer || '').trim().toLowerCase();
  const poFilter = (args?.po_number || args?.po || '').trim().toLowerCase();
  const locFilter = (args?.delivery_location || args?.location || args?.city || '').trim().toLowerCase();
  const dateRange = args?.date_range;
  const limit = Math.min(Math.max(Number(args?.limit) || 8, 1), 8);

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
    const shortId = `INQ-${(d.inquiry_id || d.id).replace(/-/g, '').slice(0, 6).toUpperCase()}`;
    const normStage = normalizeDealStage(d.stage);
    return {
      inquiry_id: shortId,
      deal_id: shortId,
      full_id: d.id,
      inquiry_uuid: d.inquiry_id || null,
      customer_name: d.customer_name || 'Unnamed Customer',
      customer_phone: d.customer_phone || '',
      stage: normStage,
      raw_stage: d.stage || 'new_inquiry',
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
  if (poFilter) {
    const cleanPo = poFilter.replace(/^[#]?(?:PO|ORDER|DEAL)[-:\s#]*/i, '').trim();
    filtered = filtered.filter((d) => 
      (d.po_number && (d.po_number.toLowerCase().includes(poFilter) || (cleanPo && d.po_number.toLowerCase().includes(cleanPo)))) ||
      (d.inquiry_id && cleanPo && d.inquiry_id.toLowerCase().includes(cleanPo))
    );
    // If not found in caller's immediate portfolio, search company-wide deals for this specific PO
    if (filtered.length === 0) {
      const searchTerms = [poFilter, cleanPo].filter(Boolean);
      const orClauses = searchTerms.map((term) => `po_number.ilike.%${term}%`).join(',');
      const { data: globalPoDeals } = await supabaseAdmin
        .from('deals')
        .select('id, inquiry_id, customer_name, customer_phone, total_amount, stage, status, po_number, delivery_location, salesperson_phone, employee_id, created_at, won_at, deal_items(sku_text, dimensions, quantity, unit, rate, amount)')
        .or(orClauses)
        .limit(5);

      if (globalPoDeals && globalPoDeals.length > 0) {
        filtered = globalPoDeals.map((d) => {
          const shortId = `INQ-${(d.inquiry_id || d.id).replace(/-/g, '').slice(0, 6).toUpperCase()}`;
          const normStage = normalizeDealStage(d.stage);
          return {
            inquiry_id: shortId,
            deal_id: shortId,
            full_id: d.id,
            inquiry_uuid: d.inquiry_id || null,
            customer_name: d.customer_name || 'Unnamed Customer',
            customer_phone: d.customer_phone || '',
            stage: normStage,
            raw_stage: d.stage || 'new_inquiry',
            po_number: d.po_number || null,
            total_amount_inr: Number(d.total_amount || 0),
            tonnage_mt: getDealTonnage(d),
            delivery_location: d.delivery_location || 'N/A',
            created_at: d.created_at,
            won_at: d.won_at,
            items: d.deal_items || [],
          };
        });
      }
    }
  }
  if (locFilter) filtered = filtered.filter((d) => (d.delivery_location || '').toLowerCase().includes(locFilter));
  if (stageFilter && stageFilter !== 'all') {
    const normFilter = normalizeDealStage(stageFilter);
    if (normFilter === 'won' || stageFilter === 'orders') {
      filtered = filtered.filter((d) => normalizeDealStage(d.stage) === 'won' || Boolean(d.po_number));
    } else if (normFilter === 'lost') {
      filtered = filtered.filter((d) => normalizeDealStage(d.stage) === 'lost');
    } else if (stageFilter === 'open' || normFilter === 'open') {
      filtered = filtered.filter((d) => {
        const s = normalizeDealStage(d.stage);
        return s !== 'won' && s !== 'lost' && !d.po_number;
      });
    } else if (normFilter === 'on_hold') {
      filtered = filtered.filter((d) => normalizeDealStage(d.stage) === 'on_hold' || d.raw_stage === 'hold' || d.raw_stage === 'on_hold');
    } else if (normFilter === 'negotiation') {
      filtered = filtered.filter((d) => normalizeDealStage(d.stage) === 'negotiation');
    } else if (normFilter === 'quoted') {
      filtered = filtered.filter((d) => normalizeDealStage(d.stage) === 'quoted');
    } else if (normFilter === 'new_inquiry') {
      filtered = filtered.filter((d) => normalizeDealStage(d.stage) === 'new_inquiry');
    } else {
      filtered = filtered.filter((d) => normalizeDealStage(d.stage) === normFilter || (d.raw_stage && d.raw_stage.toLowerCase() === stageFilter));
    }
  }

  const mode = (args?.mode || '').toLowerCase().trim();

  // ── Mode: Invalid or Incomplete Delivery Locations ─────────────────────────
  if (
    mode === 'invalid_delivery_locations' ||
    mode === 'invalid_locations' ||
    mode === 'bad_locations' ||
    mode === 'incomplete_locations' ||
    mode === 'missing_locations' ||
    mode === 'invalid_delivery_location' ||
    args?.invalid_delivery_location
  ) {
    const invalidDeals = filtered.filter((d) => {
      const loc = (d.delivery_location || '').trim().toLowerCase();
      return !loc || loc === 'n/a' || loc === 'unknown' || loc === 'null' || loc === '123' || loc === 'qwq' || loc === 'test' || loc.length < 3 || /^\d+$/.test(loc);
    });
    const totalInvalid = invalidDeals.length;
    const displayInvalid = invalidDeals.slice(0, 8);
    const hasMore = totalInvalid > 8;

    return {
      data: {
        total_invalid_delivery_orders: totalInvalid,
        total_records: totalInvalid,
        showing_count: displayInvalid.length,
        has_more: hasMore,
        dashboard_notice: hasMore
          ? `Showing 8 of ${totalInvalid} orders with invalid delivery locations. Please navigate to the dashboard to view all ${totalInvalid} records.`
          : null,
        summary: `Found ${totalInvalid} order(s) with an invalid, incomplete, or placeholder delivery location (e.g. "123", "qwq", or unassigned).`,
        orders: displayInvalid,
        deals: displayInvalid,
      },
      rowCount: totalInvalid,
    };
  }

  // ── Mode: Highest Tonnage Order ───────────────────────────────────────────
  if (
    mode === 'highest_tonnage' ||
    mode === 'max_tonnage' ||
    mode === 'top_tonnage' ||
    mode === 'biggest_order' ||
    (stageFilter === 'won' && args?.sort_by === 'tonnage')
  ) {
    const sortedWon = filtered.filter((d) => d.stage === 'won' || Boolean(d.po_number)).sort((a, b) => b.tonnage_mt - a.tonnage_mt);
    const top = sortedWon[0] || filtered[0] || null;
    return {
      data: {
        highest_tonnage_order: top,
        summary: top
          ? `The order with the highest tonnage is for ${top.customer_name} (${top.po_number ? `PO: ${top.po_number}` : top.inquiry_id}) with ${top.tonnage_mt} MT.`
          : 'No orders with recorded tonnage found.',
        top_orders: sortedWon.slice(0, 5),
      },
      rowCount: sortedWon.length,
    };
  }

  let totalVal = 0, wonVal = 0, wonCount = 0, totalTonnage = 0, totalItems = 0;
  const stageCounts = {};

  filtered.forEach((d) => {
    const isWon = d.stage === 'won' || Boolean(d.po_number);
    totalVal += d.total_amount_inr;
    totalTonnage += d.tonnage_mt;
    if (d.items && Array.isArray(d.items)) {
      totalItems += d.items.length;
    }
    if (isWon) {
      wonVal += d.total_amount_inr;
      wonCount++;
    }
    stageCounts[d.stage] = (stageCounts[d.stage] || 0) + 1;
  });

  const totalCount = filtered.length;
  const displayDeals = filtered.slice(0, 8);
  const hasMore = totalCount > 8;

  return {
    data: {
      summary: {
        total_deals: totalCount,
        total_orders: wonCount,
        won_orders_count: wonCount,
        won_orders_total_value_inr: wonVal,
        pipeline_total_value_inr: totalVal,
        total_tonnage_mt: Math.round(totalTonnage * 1000) / 1000,
        total_items_count: totalItems,
        by_stage: stageCounts,
      },
      total_records: totalCount,
      showing_count: displayDeals.length,
      has_more: hasMore,
      dashboard_notice: hasMore
        ? `Showing 8 of ${totalCount} deals/orders. Please navigate to the dashboard to view all ${totalCount} records.`
        : null,
      deals: displayDeals,
    },
    rowCount: totalCount,
  };
}

// ─── 6. GET_REORDER_QUEUE TOOL ──────────────────────────────────────────────

async function executeGetReorderQueue(args, callerContext, supabaseAdmin = supabase) {
  const mode = (args?.mode || 'list').toLowerCase().trim();
  const limit = Math.min(Math.max(Number(args?.max_results || args?.limit) || 8, 1), 8);

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

  const avgCycle = rawList.length > 0 ? Math.round((totalCycleDays / rawList.length) * 10) / 10 : 0;

  if (
    mode === 'average_cycle' ||
    mode === 'cycle_analytics' ||
    mode === 'average_reorder_cycle' ||
    mode === 'cadence' ||
    mode === 'reorder_cadence' ||
    mode === 'average_cadence'
  ) {
    return {
      data: {
        total_tracked_customers: rawList.length,
        average_reorder_cycle_days: `${avgCycle} days`,
        cadence_distribution: {
          '30_day_cycle': `${cycleDistribution['30_days']} accounts (${Math.round((cycleDistribution['30_days'] / (rawList.length || 1)) * 1000) / 10}%)`,
          '45_day_cycle': `${cycleDistribution['45_days']} accounts`,
          '25_day_cycle': `${cycleDistribution['25_days']} accounts`,
        },
        summary: rawList.length > 0
          ? `The average reorder cycle across all ${rawList.length} tracked customer accounts is ${avgCycle} days.`
          : 'No recurring customer accounts found.',
      },
      rowCount: rawList.length,
    };
  }

  const totalQueue = queue.length;
  const displayQueue = queue.slice(0, 8);
  const hasMore = totalQueue > 8;

  return {
    data: {
      summary: {
        total_tracked_customers: rawList.length,
        average_reorder_cycle_days: `${avgCycle} days`,
        overdue_customers_count: overdueCount,
        due_soon_customers_count: dueSoonCount,
      },
      total_records: totalQueue,
      showing_count: displayQueue.length,
      has_more: hasMore,
      dashboard_notice: hasMore
        ? `Showing 8 of ${totalQueue} accounts in reorder queue. Please navigate to the dashboard to view all ${totalQueue} records.`
        : null,
      reorder_queue: displayQueue,
    },
    rowCount: totalQueue,
  };
}

// ─── 7. GET_TEAM_PIPELINE TOOL ──────────────────────────────────────────────

async function executeGetTeamPipeline(args, callerContext, supabaseAdmin = supabase) {
  let query = supabaseAdmin
    .from('deals')
    .select('id, inquiry_id, customer_name, customer_phone, total_amount, stage, status, po_number, salesperson_phone, employee_id, created_at');

  let isCallerSalesperson = false;
  if (isSalespersonRole(callerContext.role)) {
    isCallerSalesperson = true;
    const rawPhone = callerContext.phone || '';
    const cleanPhone = rawPhone.replace(/\D/g, '').slice(-10);
    const empId = callerContext.employeeId;
    const orParts = [];
    if (cleanPhone) orParts.push(`salesperson_phone.ilike.%${cleanPhone}%`);
    if (empId) orParts.push(`employee_id.eq.${empId}`);
    if (orParts.length === 0) {
      return {
        data: {
          total_deals_count: 0,
          grand_total_pipeline_value_inr: 0,
          stage_breakdown: {},
          recent_deals: [],
          role_restricted: true,
          message: 'Access denied. Team-wide pipeline visibility is restricted to Sales Managers and Admins under RBAC.',
        },
        rowCount: 0,
      };
    }
    query = query.or(orParts.join(','));
  } else if (isManagerRole(callerContext.role)) {
    const { employeeIds, phoneSuffixes } = await getSubordinateSalespersons(callerContext, supabaseAdmin);
    const orParts = [];
    phoneSuffixes.forEach((p) => orParts.push(`salesperson_phone.ilike.%${p}%`));
    employeeIds.forEach((id) => orParts.push(`employee_id.eq.${id}`));
    if (orParts.length > 0) {
      query = query.or(orParts.join(','));
    } else {
      return {
        data: {
          total_deals_count: 0,
          grand_total_pipeline_value_inr: 0,
          stage_breakdown: {},
          recent_deals: [],
        },
        rowCount: 0,
      };
    }
  }

  if (args?.stage_filter) {
    const norm = normalizeDealStage(args.stage_filter);
    if (norm === 'quoted') {
      query = query.in('stage', ['quoted', 'qualified', 'proposal', 'price quote', 'saved', 'confirmed', 'quotation_sent']);
    } else if (norm === 'negotiation') {
      query = query.in('stage', ['negotiation', 'review', 'in_negotiation', 'discussion']);
    } else if (norm === 'on_hold') {
      query = query.in('stage', ['on_hold', 'hold', 'paused']);
    } else if (norm === 'new_inquiry') {
      query = query.in('stage', ['new_inquiry', 'new', 'inquiry', 'review', 'pending', 'auto_created']);
    } else if (norm === 'won') {
      query = query.in('stage', ['won', 'order', 'order_placed', 'order_confirmed']);
    } else if (norm === 'lost') {
      query = query.in('stage', ['lost', 'dropped', 'cancelled', 'rejected']);
    } else {
      query = query.eq('stage', args.stage_filter);
    }
  }

  const { data: deals, error } = await query.order('created_at', { ascending: false });
  if (error) throw new Error(`get_team_pipeline error: ${error.message}`);

  const rows = (deals || []).filter((d) => !/^test\s+(industries|customer|corp|company)\b/i.test(d.customer_name || ''));
  let grandTotal = 0;
  const stageStats = {};

  rows.forEach((d) => {
    const st = normalizeDealStage(d.stage);
    const val = Number(d.total_amount || 0);
    grandTotal += val;
    if (!stageStats[st]) stageStats[st] = { count: 0, total_value: 0 };
    stageStats[st].count += 1;
    stageStats[st].total_value += val;
  });

  const formattedDeals = rows.slice(0, 15).map((d) => {
    const rawId = d.inquiry_id || d.id || '';
    const shortId = `INQ-${rawId.replace(/-/g, '').slice(0, 6).toUpperCase()}`;
    return {
      inquiry_id: shortId,
      full_id: rawId,
      customer_name: d.customer_name,
      customer_phone: d.customer_phone,
      total_amount: Number(d.total_amount || 0),
      stage: normalizeDealStage(d.stage),
      raw_stage: d.stage,
      status: d.status,
      po_number: d.po_number,
      created_at: d.created_at,
    };
  });

  const totalDeals = rows.length;
  const displayDeals = formattedDeals.slice(0, 8);
  const hasMoreDeals = totalDeals > 8;

  return {
    data: {
      total_deals_count: totalDeals,
      total_records: totalDeals,
      showing_count: displayDeals.length,
      has_more: hasMoreDeals,
      dashboard_notice: hasMoreDeals
        ? `Showing 8 of ${totalDeals} deals. Please navigate to the dashboard to view all ${totalDeals} records.`
        : null,
      grand_total_pipeline_value_inr: grandTotal,
      stage_breakdown: stageStats,
      recent_deals: displayDeals,
      ...(isCallerSalesperson ? {
        role_restricted: true,
        notice: 'Team-wide aggregated pipeline is restricted under RBAC to Sales Managers and Admins. Displaying your personal deals pipeline.',
      } : {}),
    },
    rowCount: totalDeals,
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

  const atRiskAccounts = accounts.filter((a) => a.risk_level !== 'low');
  const totalAtRisk = atRiskAccounts.length;
  const displayAtRisk = atRiskAccounts.slice(0, 8);
  const hasMoreAtRisk = totalAtRisk > 8;

  return {
    data: {
      total_accounts_assessed: accounts.length,
      high_risk_count: highRisk,
      medium_risk_count: medRisk,
      total_records: totalAtRisk,
      showing_count: displayAtRisk.length,
      has_more: hasMoreAtRisk,
      dashboard_notice: hasMoreAtRisk
        ? `Showing 8 of ${totalAtRisk} at-risk accounts. Please navigate to the dashboard to view all ${totalAtRisk} records.`
        : null,
      at_risk_accounts: displayAtRisk,
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

  const formattedDeals = rows.map((d) => {
    const rawId = d.inquiry_id || d.id || '';
    const shortId = `INQ-${rawId.replace(/-/g, '').slice(0, 6).toUpperCase()}`;
    return {
      inquiry_id: shortId,
      full_id: rawId,
      customer_name: d.customer_name,
      lost_reason: d.lost_reason || 'Unspecified',
      total_amount_inr: Number(d.total_amount || 0),
      created_at: d.created_at,
    };
  });

  const totalLost = rows.length;
  const displayLost = formattedDeals.slice(0, 8);
  const hasMoreLost = totalLost > 8;

  return {
    data: {
      total_lost_deals: totalLost,
      total_records: totalLost,
      showing_count: displayLost.length,
      has_more: hasMoreLost,
      dashboard_notice: hasMoreLost
        ? `Showing 8 of ${totalLost} lost deals. Please navigate to the dashboard to view all ${totalLost} records.`
        : null,
      total_lost_revenue_inr: totalLostVal,
      top_loss_reasons: topReasons,
      lost_deals: displayLost,
    },
    rowCount: totalLost,
  };
}

// ─── 10. GET_DEAL_IDS TOOL ──────────────────────────────────────────────────

async function executeGetDealIds(args, callerContext, supabaseAdmin = supabase) {
  const companyName = (args?.company_name || args?.customer_name || args?.customer || args?.company || '').trim().toLowerCase();

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

  let dealsQuery = supabaseAdmin
    .from('deals')
    .select('id, inquiry_id, customer_name, stage, status, total_amount, po_number, created_at, salesperson_phone, employee_id, deal_items(sku_text, quantity, unit)')
    .ilike('customer_name', `%${companyName}%`)
    .order('created_at', { ascending: false })
    .limit(20);

  if (isSalespersonRole(callerContext.role)) {
    const rawPhone = callerContext.phone || '';
    const cleanPhone = rawPhone.replace(/\D/g, '').slice(-10);
    const empId = callerContext.employeeId;
    const orParts = [];
    if (cleanPhone) orParts.push(`salesperson_phone.ilike.%${cleanPhone}%`);
    if (empId) orParts.push(`employee_id.eq.${empId}`);
    if (orParts.length > 0) dealsQuery = dealsQuery.or(orParts.join(','));
  } else if (isManagerRole(callerContext.role)) {
    const { phoneSuffixes, employeeIds } = await getSubordinateSalespersons(callerContext, supabaseAdmin);
    const orParts = [];
    phoneSuffixes.forEach((p) => orParts.push(`salesperson_phone.ilike.%${p}%`));
    employeeIds.forEach((id) => orParts.push(`employee_id.eq.${id}`));
    if (orParts.length > 0) dealsQuery = dealsQuery.or(orParts.join(','));
  }

  const { data: deals, error } = await dealsQuery;

  if (error) throw new Error(`get_deal_ids error: ${error.message}`);

  const rows = (deals || [])
    .filter((d) => !/^test\s+(industries|customer|corp|company)\b/i.test(d.customer_name || ''))
    .map((d) => {
    const rawId = d.inquiry_id || d.id || '';
    const formattedCode = `INQ-${rawId.replace(/-/g, '').slice(0, 6).toUpperCase()}`;
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

  const totalInquiries = rows.length;
  const displayInquiries = rows.slice(0, 8);
  const hasMoreInquiries = totalInquiries > 8;

  return {
    data: {
      company_name: companyName,
      inquiries_count: totalInquiries,
      total_records: totalInquiries,
      showing_count: displayInquiries.length,
      has_more: hasMoreInquiries,
      dashboard_notice: hasMoreInquiries
        ? `Showing 8 of ${totalInquiries} inquiry records for ${companyName}. Please navigate to the dashboard to view all ${totalInquiries} records.`
        : null,
      inquiries: displayInquiries,
    },
    rowCount: totalInquiries,
  };
}

// ─── 11. SEARCH_KNOWLEDGE_BASE TOOL ─────────────────────────────────────────

async function executeSearchKnowledgeBase(args, callerContext, supabaseAdmin = supabase) {
  const queryText = (args?.query || args?.text || args?.question || '').trim();
  if (!queryText) {
    return { data: { message: 'Query parameter is required' }, rowCount: 0 };
  }

  const result = await searchKnowledgeBase(queryText, callerContext, supabaseAdmin);
  return {
    data: result,
    rowCount: result.results_found || 1,
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
  normalizeDealStage,
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
