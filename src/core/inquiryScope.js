const { expandPhoneVariants, isPhoneInScope } = require('../supabase');

function last10(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : '';
}

/** null means the caller may see every row. An empty list means they may see none. */
function scopeSuffixes(scope, senderPhone) {
  if (!scope || scope.isAdmin || scope.phones === null || scope.phones === undefined) return null;
  const raw = Array.isArray(scope.phones) && scope.phones.length
    ? scope.phones
    : (senderPhone ? [senderPhone] : []);
  const seen = new Set();
  const suffixes = [];
  for (const phone of raw) {
    const key = last10(phone);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    suffixes.push(key);
  }
  return suffixes;
}

function scopePhonesFor(scope, senderPhone) {
  const suffixes = scopeSuffixes(scope, senderPhone);
  if (suffixes == null) return null;
  return expandPhoneVariants(suffixes);
}

function phoneOrClause(suffixes, columns) {
  const parts = [];
  for (const suffix of suffixes || []) {
    for (const column of columns) parts.push(`${column}.ilike.%${suffix}%`);
  }
  return parts.join(',');
}

function customerLabel(record) {
  const ai = record?.ai_extraction_json || {};
  return String(
    record?.customer_name
    || record?.sender_name
    || ai.customer_name
    || ai.companyName
    || ai.customer?.name
    || '',
  ).trim();
}

function strippedName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\b(private\s+limited|pvt\s+ltd|pvt\s+limited|private\s+ltd|co\s+ltd|co\s+limited|llp|limited|pvt|ltd|inc|corp|co|corporation)\b/gi, '')
    .replace(/[^a-z0-9]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function ownerPhoneFor(customerName, ownerMap) {
  if (!customerName || !ownerMap || !ownerMap.size) return '';
  const clean = String(customerName).trim().toLowerCase();
  if (ownerMap.has(clean)) return ownerMap.get(clean);
  const stripped = strippedName(clean);
  if (!stripped) return '';
  for (const [name, phone] of ownerMap.entries()) {
    const other = strippedName(name);
    if (other && (stripped === other || stripped.startsWith(other) || other.startsWith(stripped))) return phone;
  }
  return '';
}

function exactOwnerPhone(customerName, ownerMap) {
  if (!customerName || !ownerMap || !ownerMap.size) return '';
  const clean = String(customerName).trim().toLowerCase();
  if (ownerMap.has(clean)) return ownerMap.get(clean);
  const stripped = strippedName(clean);
  if (!stripped) return '';
  for (const [name, phone] of ownerMap.entries()) {
    if (strippedName(name) === stripped) return phone;
  }
  return '';
}

function orderInSalesScope(record, scopePhones, ownerMap) {
  if (scopePhones == null) return true;
  if (!Array.isArray(scopePhones) || scopePhones.length === 0) return false;
  const phones = [record?.salesperson_phone, record?.sender_phone];
  if (phones.some((phone) => phone && isPhoneInScope(phone, scopePhones))) return true;
  const owner = exactOwnerPhone(customerLabel(record), ownerMap);
  return Boolean(owner && isPhoneInScope(owner, scopePhones));
}

async function loadCustomerOwnerMap(supabase) {
  const map = new Map();
  if (!supabase?.from) return map;
  const { data, error } = await supabase
    .from('recurring_customers')
    .select('customer_name, assigned_salesperson_phone, is_active');
  if (error) return map;
  for (const row of data || []) {
    if (row?.is_active === false) continue;
    const name = String(row?.customer_name || '').trim().toLowerCase();
    if (!name || !row?.assigned_salesperson_phone || map.has(name)) continue;
    map.set(name, row.assigned_salesperson_phone);
  }
  return map;
}

function recordInSalesScope(record, scopePhones, ownerMap, deal) {
  if (scopePhones == null) return true;
  if (!Array.isArray(scopePhones) || scopePhones.length === 0) return false;
  const phones = [record?.salesperson_phone, record?.sender_phone, deal?.salesperson_phone];
  if (phones.some((phone) => phone && isPhoneInScope(phone, scopePhones))) return true;
  const name = customerLabel(record) || customerLabel(deal);
  const owner = ownerPhoneFor(name, ownerMap);
  return Boolean(owner && isPhoneInScope(owner, scopePhones));
}

function safeName(value) {
  return String(value || '').replace(/[%_,().*]/g, '').trim();
}

const OPTIONAL_INQUIRY_COLUMNS = ['display_stage', 'pricing_status', 'tonnage_review_open', 'procurement_number'];
const INQUIRY_PAGE_SIZE = 1000;

function selectWithoutOptionalColumns(select) {
  return String(select || '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => {
      const name = part.split('(')[0].trim();
      return name && !OPTIONAL_INQUIRY_COLUMNS.includes(name);
    })
    .join(', ');
}

function isOptionalColumnError(error) {
  return /display_stage|pricing_status|tonnage_review|procurement_number/i.test(error?.message || '');
}

async function readInquirySelect(supabase, select, refine) {
  const run = (columns) => refine(supabase.from('inquiries').select(columns));
  let columns = select;
  let result = await run(columns);
  if (result?.error && isOptionalColumnError(result.error)) {
    const fallback = selectWithoutOptionalColumns(select);
    if (fallback && fallback !== select) {
      columns = fallback;
      result = await run(columns);
    }
  }
  if (result?.error) throw new Error('Inquiry list could not be loaded.');
  return { rows: result?.data || [], columns };
}

async function loadInquiryPages(supabase, select, { includeAllTypes = false } = {}) {
  const rows = [];
  let columns = select;
  for (let from = 0; ; from += INQUIRY_PAGE_SIZE) {
    const page = await readInquirySelect(supabase, columns, (query) => {
      const scoped = includeAllTypes ? query : query.neq('inquiry_type', 'purchase_order');
      return scoped
        .order('created_at', { ascending: false })
        .range(from, from + INQUIRY_PAGE_SIZE - 1);
    });
    columns = page.columns;
    const firstId = page.rows[0]?.id;
    if (firstId && rows.some((row) => row.id === firstId)) break;
    rows.push(...page.rows);
    if (page.rows.length < INQUIRY_PAGE_SIZE) break;
  }
  return rows;
}

async function linkedDealsByInquiry(supabase, ids) {
  const byInquiry = new Map();
  for (let index = 0; index < ids.length; index += 100) {
    const chunk = ids.slice(index, index + 100);
    const { data, error } = await supabase
      .from('deals')
      .select('id, inquiry_id, salesperson_phone, customer_name, created_at')
      .in('inquiry_id', chunk);
    if (error) continue;
    for (const deal of data || []) {
      if (!deal?.inquiry_id) continue;
      const current = byInquiry.get(deal.inquiry_id);
      if (!current || String(deal.created_at || '') > String(current.created_at || '')) {
        byInquiry.set(deal.inquiry_id, deal);
      }
    }
  }
  return byInquiry;
}

async function inquiriesForSalesScope(supabase, scope, senderPhone, select, options = {}) {
  const suffixes = scopeSuffixes(scope, senderPhone);
  if (suffixes && suffixes.length === 0) return [];
  const rows = await loadInquiryPages(supabase, select, options);
  const ownerMap = await loadCustomerOwnerMap(supabase);
  const scopePhones = scopePhonesFor(scope, senderPhone);
  let scoped = rows;
  if (scopePhones != null) {
    const deals = await linkedDealsByInquiry(supabase, rows.map((row) => row.id).filter(Boolean));
    scoped = rows.filter((row) => recordInSalesScope(row, scopePhones, ownerMap, deals.get(row.id)));
  }
  if (!options.dashboardSet) return scoped;
  return scoped.filter(isDashboardInquiry);
}

async function dealsForSalesScope(supabase, scope, senderPhone, select, options = {}) {
  const suffixes = scopeSuffixes(scope, senderPhone);
  if (suffixes && suffixes.length === 0) return [];
  const orderBy = options.orderBy || 'created_at';
  let query = supabase.from('deals').select(select).order(orderBy, { ascending: false, nullsFirst: false });
  if (options.stage) query = query.eq('stage', options.stage);
  if (suffixes) query = query.or(phoneOrClause(suffixes, ['salesperson_phone']));
  const { data } = await query.limit(500);
  const ownerMap = await loadCustomerOwnerMap(supabase);
  const scopePhones = scopePhonesFor(scope, senderPhone);
  const rows = [...(data || [])];
  if (suffixes && suffixes.length) {
    const names = [];
    for (const [name, phone] of ownerMap.entries()) {
      if (isPhoneInScope(phone, scopePhones)) names.push(name);
    }
    const clause = names
      .map(safeName)
      .filter((name) => name.length >= 3)
      .slice(0, 20)
      .map((name) => options.exactCustomerOwner
        ? `customer_name.ilike.${name}`
        : `customer_name.ilike.%${name}%`)
      .join(',');
    if (clause) {
      let extraQuery = supabase
        .from('deals')
        .select(select)
        .or(clause)
        .order(orderBy, { ascending: false, nullsFirst: false });
      if (options.stage) extraQuery = extraQuery.eq('stage', options.stage);
      const { data: extra } = await extraQuery.limit(200);
      const seen = new Set(rows.map((row) => row.id));
      for (const row of extra || []) {
        if (!seen.has(row.id)) rows.push(row);
      }
    }
  }
  const staged = options.stage ? rows.filter((row) => row.stage === options.stage) : rows;
  if (scopePhones == null) return staged;
  const allow = options.exactCustomerOwner
    ? (row) => orderInSalesScope(row, scopePhones, ownerMap)
    : (row) => recordInSalesScope(row, scopePhones, ownerMap);
  return staged.filter(allow);
}

function dashboardInquiryCode(id) {
  const raw = String(id || '');
  if (!raw) return '';
  return `INQ-${raw.substring(0, 6).toUpperCase()}`;
}

function hasCommercialLine(lines) {
  return Array.isArray(lines) && lines.some((line) => (
    (Number(line?.quantity) > 0 || Number(line?.quantity_tons) > 0 || Number(line?.quantity_mt) > 0)
    && (line?.sku_text || line?.product_name || line?.product || line?.description)
  ));
}

/** Same inclusion rule as the dashboard inquiry list. */
function isDashboardInquiry(item) {
  if (!item) return false;
  const rawText = String(item.raw_text || '').trim();
  const aiJson = item.ai_extraction_json || {};
  const channel = String(item.source_channel || '').toLowerCase();
  if (
    item.inquiry_type === 'inquiry'
    || item.inquiry_type === 'purchase_order'
    || item.inquiry_type === 'quotation_sent'
    || channel.includes('whatsapp')
    || channel.includes('dashboard')
    || channel.includes('assistant')
    || channel.includes('chatbot')
    || channel === 'manual'
    || channel === 'form'
    || channel === 'upload'
    || item.source_channel === 'whatsapp'
    || item.source_channel === 'whatsapp_text'
    || item.source_channel === 'whatsapp_image'
    || item.source_channel === 'whatsapp_po'
    || item.source_channel === 'web_dashboard'
    || item.source_channel === 'dashboard'
    || item.source_channel === 'ai_assistant'
  ) {
    return true;
  }
  if (
    rawText.startsWith('[Inquiry Attachment:')
    || rawText.startsWith('[Inquiry Document Attached]')
    || rawText.startsWith('[PO Document Attached:')
    || (Array.isArray(item.media_urls) && item.media_urls.length > 0)
  ) {
    return true;
  }
  const lineItems = aiJson.line_items || aiJson.lineItems || [];
  if (hasCommercialLine(lineItems)) return true;
  if (item.sender_name || item.customer_name || aiJson.companyName || aiJson.customer_name) return true;
  if (
    /test industries\s*\d*/i.test(rawText)
    || /test customer\s*\d*/i.test(rawText)
    || /test prospect\s*\d*/i.test(rawText)
    || /^test\s+(industries|customer|corp|company)\b/i.test(item.customer_name || '')
    || /^test\s+(industries|customer|corp|company)\b/i.test(aiJson.companyName || '')
    || /^test\s+(industries|customer|corp|company)\b/i.test(aiJson.customer?.name || '')
  ) {
    return false;
  }
  const nonInquiry = [
    /^(hi|hello|hey|namaste)\b/i,
    /^(show|list|tell|what|how|why|where|can you|give me|is there|which customers|now show|change)\b/i,
    /\b(policy|moq|sop|guideline|portal|login|dashboard)\b/i,
    /^(visited|met with|site visit|meeting with)\b/i,
    /^new customer\b/i,
    /^(deal|we have won|won the|lost the|paid|advance)\b/i,
    /\b(paid\s+₹?|paid\s+rs|advance\s+via|via\s+cheque|via\s+rtgs|via\s+neft)\b/i,
    /^#deal-\w+/i,
    /^\d+$/,
    /^this is the new inquiry$/i,
    /^we have received a new inquiry/i,
    /^document received$/i,
    /^ded$/i,
  ];
  if (nonInquiry.some((pattern) => pattern.test(rawText.toLowerCase()))) return false;
  const hasMetalKeyword = /\b(mt|tons?|kg|coils?|sheets?|plates?|rebar|tmt|steel|hr|cr|gp|gc|pipe|tube)\b/i.test(rawText);
  if (!hasMetalKeyword && !aiJson.customer?.name && !aiJson.customer_name && !item.customer_name) return false;
  return true;
}

function isInquiryCode(text) {
  return /^(?:#)?(?:INQ|DEAL)-[A-Z0-9]+(?:-[A-Z0-9]+)?$/i.test(String(text || '').trim());
}

module.exports = {
  last10,
  scopeSuffixes,
  scopePhonesFor,
  phoneOrClause,
  customerLabel,
  ownerPhoneFor,
  loadCustomerOwnerMap,
  recordInSalesScope,
  orderInSalesScope,
  inquiriesForSalesScope,
  dealsForSalesScope,
  readInquirySelect,
  dashboardInquiryCode,
  isDashboardInquiry,
  isInquiryCode,
};
