const { isProcurementManager, isProcurementRole } = require('../utils/roles');
const axios = require('axios');

const OPEN_STATUSES = ['new', 'pending', 'review', 'draft', 'new_inquiry'];
const ALL_INQUIRY_PAGE = 10;
const PRICING_CUTOFF_MS = new Date('2026-10-15T00:00:00+05:30').getTime();
const BADGE_ORDER = [
  'Awaiting Price',
  'Price Ready',
  'Unavailable',
  'New Inquiry',
  'Price Quote',
  'Negotiation',
  'On Hold',
  'Won',
  'Lost',
];

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

const PROCUREMENT_INQUIRY_DEFAULTS = {
  procurement_person: {
    'inquiries.view': true,
    'inquiries.manage': false,
    'inquiries.edit': true,
    'inquiries.delete': false,
    'inquiries.send_quote': false,
    'inquiries.scope_assigned': true,
    'inquiries.price_override': false,
    'inquiries.fill_base_prices': true,
    'inquiries.team_inquiries': false,
  },
  procurement_manager: {
    'inquiries.view': true,
    'inquiries.manage': false,
    'inquiries.edit': true,
    'inquiries.delete': true,
    'inquiries.send_quote': false,
    'inquiries.scope_assigned': false,
    'inquiries.price_override': true,
    'inquiries.fill_base_prices': true,
    'inquiries.team_inquiries': true,
  },
};

function resolveProcurementPermissions(employee) {
  const role = String(employee?.role || '').toLowerCase();
  const defaults = { ...(PROCUREMENT_INQUIRY_DEFAULTS[role] || {}) };
  const stored = employee?.permissions;
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return defaults;
  const overlay = {};
  for (const [key, value] of Object.entries(stored)) {
    if (typeof value === 'boolean') overlay[key] = value;
  }
  return { ...defaults, ...overlay };
}

function canViewInquiries(permissions) {
  return permissions['inquiries.view'] === true;
}

function canFillBasePrices(permissions) {
  return canViewInquiries(permissions)
    && permissions['inquiries.edit'] === true
    && permissions['inquiries.fill_base_prices'] === true;
}

function canSeeTeam(permissions) {
  return canViewInquiries(permissions) && permissions['inquiries.team_inquiries'] === true;
}

const BASE_PRICE_PERMISSION_REFUSAL = 'You can view inquiries, but you cannot enter a base price.';
const VIEW_PERMISSION_REFUSAL = 'You do not have permission to view inquiries.';

function matchesProcurementScope(item, scope) {
  if (!scope) return false;
  const ids = scope.ids || [];
  if (item?.procurement_employee_id && ids.includes(item.procurement_employee_id)) {
    return true;
  }
  if (scope.stampedOnly) return false;
  if (item?.procurement_employee_id) return false;
  const status = String(item?.status || '').toLowerCase();
  if (scope.includeUnassignedPool && OPEN_STATUSES.includes(status)) return true;
  const phones = scope.salespersonPhones || [];
  const employeeIds = scope.salespersonEmployeeIds || [];
  if (item?.employee_id && employeeIds.includes(item.employee_id)) return true;
  const phone = normalizePhone(item?.salesperson_phone || '');
  return Boolean(phone && phones.includes(phone));
}

function salespeopleRouted(employees, personIds) {
  const ids = new Set(personIds || []);
  const assigned = (employees || []).filter(
    (emp) =>
      ids.has(emp.assigned_procurement_employee_id) &&
      String(emp.role || '') === 'salesperson' &&
      emp.is_active !== false,
  );
  return {
    phones: assigned.map((emp) => normalizePhone(emp.phone)).filter((phone) => phone.length === 10),
    ids: assigned.map((emp) => emp.id).filter(Boolean),
  };
}

function scopeFromEmployees(employee, employees, permissions) {
  const ownId = employee?.id ? [employee.id] : [];
  const teamScope = permissions
    ? permissions['inquiries.team_inquiries'] === true
    : isProcurementManager(employee?.role);
  const assignedScope = permissions
    ? permissions['inquiries.scope_assigned'] === true
    : !isProcurementManager(employee?.role);
  if (permissions && !teamScope && !assignedScope) {
    return {
      ids: ownId,
      includeUnassignedPool: false,
      salespersonPhones: [],
      salespersonEmployeeIds: [],
      stampedOnly: true,
      team: [],
    };
  }
  if (!teamScope) {
    const routed = salespeopleRouted(employees, ownId);
    return {
      ids: ownId,
      includeUnassignedPool: false,
      salespersonPhones: routed.phones,
      salespersonEmployeeIds: routed.ids,
      team: [],
    };
  }
  const myPhone = normalizePhone(employee.phone);
  const reports = (employees || []).filter((emp) => {
    if (!emp?.id || emp.id === employee.id || emp.is_active === false) return false;
    const role = String(emp.role || '').toLowerCase();
    if (['admin', 'sales_manager', 'manager', 'procurement_manager'].includes(role)) return false;
    if (emp.manager_id && emp.manager_id === employee.id) return true;
    return Boolean(myPhone && normalizePhone(emp.manager_phone) === myPhone);
  });
  const team = reports.filter((emp) => String(emp.role || '').toLowerCase() === 'procurement_person');
  const routed = salespeopleRouted(employees, reports.map((emp) => emp.id));
  return {
    ids: Array.from(new Set([...ownId, ...reports.map((emp) => emp.id)])),
    includeUnassignedPool: true,
    salespersonPhones: routed.phones,
    salespersonEmployeeIds: routed.ids,
    team,
  };
}

function sourceLines(inquiry) {
  const ai = inquiry?.ai_extraction_json || {};
  const lines = ai.line_items || ai.lineItems || [];
  const source = lines.length
    ? lines
    : [{ sku_text: ai.productType || 'Material', quantity: ai.quantityTons || 0, unit: 'MT' }];
  return source.map((item, index) => ({
    line_key: String(item?.id || item?.line_key || `${index}:${item?.sku_text || 'line'}`),
    sku_text: item.sku_text || item.description || 'Material',
    quantity: Number(item.original_quantity ?? item.quantity ?? item.qty) || 0,
    unit: item.original_unit || item.unit || 'MT',
    dimensions: item.dimensions || item.spec || null,
    grade: item.grade || null,
    weight_mt: item.weight_mt ?? item.converted_mt ?? null,
  }));
}

function procurementStatus(lines) {
  if (lines.some((line) => line.line_status === 'priced')) return 'price_ready';
  if (lines.length && lines.every((line) => line.line_status === 'cannot_price')) return 'unavailable';
  return 'awaiting_price';
}

function deriveProcurementLines(existing, submitted) {
  return submitted.map((line) => {
    const raw = line.base_price_per_mt;
    const price = raw == null || raw === '' ? null : Math.max(0, Number(raw) || 0);
    const previous = (existing || []).find((item) => item.line_key === line.line_key) || {};
    return {
      ...previous,
      line_key: line.line_key,
      sku_text: line.sku_text || previous.sku_text,
      quantity: line.quantity ?? previous.quantity,
      unit: line.unit || previous.unit,
      procurement_base_price_per_mt: price && price > 0 ? price : null,
      line_status: price && price > 0 ? 'priced' : 'cannot_price',
      procurement_line_note: line.line_note || null,
    };
  });
}

function parseBaseToken(token) {
  const text = String(token || '').trim();
  if (!text || /^(blank|unavailable|cannot|na|n\/a|-)(\b|:|$)/i.test(text)) {
    const note = text.includes(':') ? text.split(':').slice(1).join(':').trim() : null;
    return { price: null, note: note || null };
  }
  const amount = Number(text.replace(/[₹,\s]/g, '').replace(/\/mt$/i, ''));
  if (!Number.isFinite(amount) || amount < 0) {
    return { error: 'Use a price in rupees per MT, or unavailable.' };
  }
  if (amount === 0) return { price: null, note: null };
  return { price: amount, note: null };
}

function parseBasePrices(text, lineCount) {
  let parts = String(text || '')
    .split(/\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 1 && lineCount > 1 && parts[0].includes(',')) {
    parts = parts[0].split(',').map((part) => part.trim()).filter(Boolean);
  }
  if (parts.length !== lineCount) {
    return {
      error: `Send ${lineCount} price${lineCount === 1 ? '' : 's'}, one for each line.`,
    };
  }
  const parsed = parts.map(parseBaseToken);
  const failed = parsed.find((item) => item.error);
  if (failed) return { error: failed.error };
  return { lines: parsed };
}

function statusLabel(status) {
  return {
    awaiting_price: 'Awaiting price',
    price_ready: 'Price ready',
    unavailable: 'Unavailable',
    sales_priced: 'Sales priced',
  }[status] || 'Awaiting price';
}

function preservedPricingStatus(inquiry) {
  const status = inquiry?.pricing_status || null;
  if (status !== 'awaiting_price') return status;
  const created = inquiry?.created_at ? new Date(inquiry.created_at).getTime() : NaN;
  if (!Number.isNaN(created) && created < PRICING_CUTOFF_MS) return null;
  return 'awaiting_price';
}

function displayStageKey(inquiry) {
  const stage = String(inquiry?.display_stage || '').toLowerCase().trim();
  return ['new_inquiry', 'quoted', 'negotiation', 'on_hold', 'won', 'lost'].includes(stage)
    ? stage
    : 'new_inquiry';
}

function filterStatusCount(label, inquiry) {
  const pricing = preservedPricingStatus(inquiry);
  const stage = displayStageKey(inquiry);
  if (label === 'Awaiting Price') return pricing === 'awaiting_price';
  if (label === 'Price Ready') return pricing === 'price_ready';
  if (label === 'Unavailable') return pricing === 'unavailable';
  const stages = {
    'New Inquiry': 'new_inquiry',
    'Price Quote': 'quoted',
    Negotiation: 'negotiation',
    'On Hold': 'on_hold',
    Won: 'won',
    Lost: 'lost',
  };
  return stage === stages[label];
}

function stageBadge(stage) {
  return {
    new_inquiry: 'New Inquiry',
    quoted: 'Price Quote',
    negotiation: 'Negotiation',
    on_hold: 'On Hold',
    won: 'Won',
    lost: 'Lost',
  }[stage] || 'New Inquiry';
}

function inquiryBadge(inquiry) {
  const pricing = preservedPricingStatus(inquiry);
  if (pricing === 'awaiting_price') return 'Awaiting Price';
  if (pricing === 'price_ready') return 'Price Ready';
  if (pricing === 'unavailable') return 'Unavailable';
  return stageBadge(displayStageKey(inquiry));
}

function productSummary(inquiry) {
  const lines = sourceLines(inquiry);
  const first = lines[0] || {};
  const more = lines.length > 1 ? ` +${lines.length - 1} more` : '';
  const qty = first.quantity ? `${first.quantity} ${first.unit || 'MT'}` : (first.unit || 'MT');
  return `${first.sku_text || 'Material'} ${qty}${more}`.trim();
}

function formatInquiryWhen(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(date);
  const read = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${read('day')} ${read('month')} ${read('year')}, ${read('hour')}:${read('minute')} ${read('dayPeriod').toLowerCase()}`;
}

function isAwaitingPrice(row) {
  return row?.pricing_status === 'awaiting_price';
}

function isDashboardAwaiting(row) {
  return preservedPricingStatus(row) === 'awaiting_price';
}

function realSalespersonPhone(phone) {
  const lower = String(phone || '').trim().toLowerCase();
  if (!lower || lower === 'unassigned' || lower === 'null' || lower === 'undefined') return '';
  const clean = lower.replace(/\D/g, '').slice(-10);
  if (clean.length < 10 || clean === '9975003940' || clean === '0000000000') return '';
  return String(phone).trim();
}

function stripCompanyName(value) {
  return String(value || '')
    .replace(/\b(private\s+limited|pvt\s+ltd|pvt\s+limited|private\s+ltd|co\s+ltd|co\s+limited|llp|limited|pvt|ltd|inc|corp|co|corporation)\b/gi, '')
    .replace(/[^a-z0-9]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function customerLabel(inquiry) {
  const ai = inquiry?.ai_extraction_json || {};
  return String(inquiry?.customer_name || ai.customer_name || ai.customer?.name || '').trim().toLowerCase();
}

function lookupOwnerPhone(name, owners) {
  if (!name || !owners || !owners.size) return '';
  if (owners.has(name)) return owners.get(name);
  const stripped = stripCompanyName(name);
  if (!stripped) return '';
  for (const [key, phone] of owners.entries()) {
    const other = stripCompanyName(key);
    if (other && (stripped === other || stripped.startsWith(other) || other.startsWith(stripped))) return phone;
  }
  return '';
}

function resolvedSalespersonPhone(inquiry, owners) {
  const stored = realSalespersonPhone(inquiry?.salesperson_phone);
  if (stored) return stored;
  const owner = lookupOwnerPhone(customerLabel(inquiry), owners);
  if (owner) return owner;
  const sender = realSalespersonPhone(inquiry?.sender_phone);
  if (sender) return sender;
  const raw = String(inquiry?.salesperson_phone || '').trim().toLowerCase();
  if (raw && raw !== 'unassigned' && raw !== 'null' && raw !== 'undefined') return String(inquiry.salesperson_phone).trim();
  const rawSender = String(inquiry?.sender_phone || '').trim().toLowerCase();
  if (rawSender && rawSender !== 'unassigned' && rawSender !== 'null' && rawSender !== 'undefined') {
    return String(inquiry.sender_phone).trim();
  }
  return '';
}

function withResolvedSalesperson(inquiry, owners) {
  const phone = resolvedSalespersonPhone(inquiry, owners);
  return phone ? { ...inquiry, salesperson_phone: phone } : inquiry;
}

function formatInquiryLine(inquiry, salespersonName, badge) {
  const number = inquiry?.procurement_number || 'No procurement number';
  const when = formatInquiryWhen(inquiry?.created_at);
  const place = inquiry?.delivery_location || 'Delivery not set';
  const status = badge || statusLabel(inquiry?.pricing_status);
  return `${number} · ${when ? `${when} · ` : ''}${salespersonName || 'Salesperson'} · ${productSummary(inquiry)} · ${place} · ${status}`;
}

function formatAllInquiryBlock(inquiry, name, badge) {
  const number = inquiry?.procurement_number || 'No procurement number';
  const when = formatInquiryWhen(inquiry?.created_at);
  const place = inquiry?.delivery_location || 'Delivery not set';
  return [
    `*${number}*`,
    badge,
    [when, name || 'Salesperson'].filter(Boolean).join(' · '),
    productSummary(inquiry),
    place,
  ].join('\n');
}

function menuRows(isManager) {
  const rows = [
    { id: 'proc_1', title: '1. Pending prices', description: 'Inquiries waiting for a base price' },
    { id: 'proc_2', title: '2. All inquiries', description: 'Every status, newest first' },
    { id: 'proc_3', title: '3. Log a base price', description: 'Enter a base price per line' },
  ];
  if (isManager) rows.push({ id: 'proc_4', title: '4. My team', description: 'People who report to you' });
  return rows;
}

function menuText(isManager) {
  const lines = ['*Procurement assistant*', ''];
  for (const row of menuRows(isManager)) lines.push(row.title);
  lines.push('', 'Reply with a number, or choose an action. Prices are rupees per MT.');
  return lines.join('\n');
}

function menuResult(isManager) {
  return {
    handled: true,
    reply: menuText(isManager),
    interactiveType: 'list',
    interactiveList: {
      bodyText: 'Procurement assistant. Choose an action.',
      buttonText: 'Choose Action',
      sections: [{ title: 'Procurement', rows: menuRows(isManager) }],
    },
  };
}

function normalizeMenuChoice(text) {
  const clean = String(text || '').trim().toLowerCase();
  if (['1', 'proc_1', 'pending', 'pending prices', '1. pending prices'].includes(clean)) return 'pending';
  if ([
    '2',
    'proc_2',
    'current',
    'current inquiries',
    '2. current inquiries',
    'all inquiries',
    '2. all inquiries',
  ].includes(clean)) return 'all';
  if (['3', 'proc_3', 'base price', 'log a base price', '3. log a base price'].includes(clean)) return 'base';
  if (['4', 'proc_4', 'my team', '4. my team'].includes(clean)) return 'team';
  return null;
}

function byNewest(rows) {
  return [...(rows || [])].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
}

function formatWeightMt(line) {
  const { convertLineItemToMt } = require('../utils/pricingEngine');
  const mt = Number(convertLineItemToMt(line));
  if (!Number.isFinite(mt) || mt <= 0) return '';
  return `${Math.round(mt * 1000) / 1000} MT`;
}

function lineQuantityText(line) {
  const unit = line.unit || 'MT';
  const qty = line.quantity ? `${line.quantity} ${unit}` : unit;
  const weight = formatWeightMt(line);
  if (!weight || weight === qty) return qty;
  return `${qty}\n${weight}`;
}

function lineStatusText(saved) {
  const price = Number(saved?.procurement_base_price_per_mt);
  if (saved && Number.isFinite(price) && price > 0) return `₹${price}/MT`;
  const note = String(saved?.procurement_line_note || '').trim();
  if (saved && (saved.line_status === 'cannot_price' || note)) {
    return note ? `Unavailable: ${note}` : 'Unavailable';
  }
  return 'Awaiting price';
}

function lineOffer(line, saved, index) {
  const rows = [`*${index + 1}. ${line.sku_text || 'Material'}*`];
  const spec = line.dimensions || line.grade || null;
  if (spec) rows.push(spec);
  rows.push(lineQuantityText(line));
  rows.push(lineStatusText(saved));
  return rows.join('\n');
}

function basePriceHeader(inquiry, employees) {
  const number = inquiry?.procurement_number || 'No procurement number';
  const when = formatInquiryWhen(inquiry?.created_at);
  const who = salespersonName(inquiry, employees);
  return [
    `*${number}*`,
    [when, who].filter(Boolean).join(' · '),
    inquiry?.delivery_location || 'Delivery not set',
    statusLabel(inquiry?.pricing_status),
  ].join('\n');
}

function latestSaved(rows, lineKey) {
  const matches = (rows || []).filter((row) => row.line_key === lineKey);
  return matches.length ? matches[matches.length - 1] : null;
}

function basePriceInquiryBlock(inquiry, employees, savedRows) {
  const saved = (savedRows || []).filter((row) => !row.inquiry_id || row.inquiry_id === inquiry.id);
  const lines = sourceLines(inquiry).map((line, index) => lineOffer(line, latestSaved(saved, line.line_key), index));
  return [basePriceHeader(inquiry, employees), ...lines].join('\n\n');
}

async function loadSavedLines(supabase, inquiryIds) {
  const ids = (inquiryIds || []).filter(Boolean);
  if (!ids.length) return [];
  const { data } = await supabase.from('inquiry_line_pricing').select('*').in('inquiry_id', ids);
  return data || [];
}

async function basePriceListResult(rows, employees, supabase) {
  const waiting = byNewest(rows).filter(isDashboardAwaiting);
  const shown = waiting.slice(0, 7);
  if (!shown.length) {
    return { handled: true, reply: 'None are waiting for a base price.' };
  }
  const saved = await loadSavedLines(supabase, shown.map((row) => row.id));
  const blocks = shown.map((row) => basePriceInquiryBlock(row, employees, saved));
  let reply = `Copy a procurement number, or the whole line, and send it.\n\n${blocks.join('\n\n')}`;
  if (waiting.length > 7) reply += '\n\nView the rest in the Inquiries tab.';
  return { handled: true, reply };
}

function readPricePair(chunk, lineCount) {
  const match = String(chunk || '').trim().match(/^(\d+)\s*[-–—:]?\s*(.*)$/);
  if (!match) return null;
  const line = Number(match[1]);
  const priceText = match[2].trim();
  if (!priceText) return line >= 1 && line <= lineCount ? { line } : null;
  if (line < 1 || line > lineCount) return { error: `Choose a line from 1 to ${lineCount}.` };
  return { line, priceText };
}

function parsePriceAssignments(text, lineCount) {
  const trimmed = String(text || '').trim();
  if (!trimmed || /^proc_line_\d+$/i.test(trimmed)) return null;
  const chunks = trimmed.split(/[\n,]+/).map((part) => part.trim()).filter(Boolean);
  if (chunks.length > 1) {
    const parsed = chunks.map((chunk) => readPricePair(chunk, lineCount));
    if (parsed.every((item) => item && item.priceText && !item.error)) {
      const byLine = new Map();
      for (const item of parsed) byLine.set(item.line, item.priceText);
      return { pairs: [...byLine.entries()].map(([line, priceText]) => ({ line, priceText })) };
    }
    const failed = parsed.find((item) => item?.error);
    if (failed) return { error: failed.error };
  }
  const one = readPricePair(trimmed, lineCount);
  if (!one) return null;
  if (one.error) return one;
  return { pairs: [one] };
}

function parseLineChoice(text, lineCount) {
  const trimmed = String(text || '').trim();
  const button = trimmed.match(/^proc_line_(\d+)$/i);
  if (button) {
    const line = Number(button[1]);
    if (line < 1 || line > lineCount) return { error: `Choose a line from 1 to ${lineCount}.` };
    return { line };
  }
  const both = trimmed.match(/^(\d+)\s+(.+)$/);
  if (both) {
    const line = Number(both[1]);
    if (line >= 1 && line <= lineCount) return { line, priceText: both[2].trim() };
  }
  if (/^\d+$/.test(trimmed) && lineCount > 1) {
    const line = Number(trimmed);
    if (line >= 1 && line <= lineCount) return { line };
  }
  return null;
}

function baseIntent(intent) {
  const rest = String(intent || '').slice('procurement|base|'.length);
  const [number, line] = rest.split('|');
  return { number, line: line ? Number(line) : null };
}

function isProcurementCancel(text) {
  const { isDiscardOrCancelIntent } = require('./catalogFlow');
  return isDiscardOrCancelIntent(text);
}

function isDetailsRequest(text) {
  const value = String(text || '');
  return /\b(details?|information)\b/i.test(value) && /PR-\d+/i.test(value);
}

function linePriceDetail(line, saved) {
  const label = `${line.sku_text} ${line.quantity || ''} ${line.unit || 'MT'}`.replace(/\s+/g, ' ').trim();
  const price = Number(saved?.procurement_base_price_per_mt);
  if (saved && Number.isFinite(price) && price > 0) return `${label} — ₹${price}/MT`;
  const note = String(saved?.procurement_line_note || '').trim();
  if (saved && (saved.line_status === 'cannot_price' || note)) {
    return note ? `${label} — Unavailable: ${note}` : `${label} — Unavailable`;
  }
  return `${label} — Awaiting price`;
}

function questionKind(text) {
  const clean = String(text || '').toLowerCase();
  if (!/\b(how many|count|left|pending|awaiting|unavailable|inquiries|price)\b/.test(clean)) return null;
  if (/\bunavailable\b/.test(clean)) return 'unavailable';
  if (/\bprice[\s-]*ready\b|\bcurrent\b/.test(clean)) return 'price_ready';
  if (/\bleft to price\b|\bawaiting\b|\bpending\b|\byet to price\b|\bremaining\b|\bto price\b/.test(clean)) {
    return 'awaiting_price';
  }
  if (/\bhow many\b|\bcount\b/.test(clean)) return 'awaiting_price';
  return null;
}

function scopedSalespeople(employees, scope) {
  const phones = new Set(scope?.salespersonPhones || []);
  return (employees || []).filter((emp) => {
    if (String(emp.role || '') !== 'salesperson' || emp.is_active === false) return false;
    return phones.has(normalizePhone(emp.phone));
  });
}

function findNamedSalesperson(text, salespeople) {
  const hay = String(text || '').toLowerCase();
  const ranked = (salespeople || [])
    .map((person) => ({ person, name: String(person.name || '').trim() }))
    .filter((item) => item.name && hay.includes(item.name.toLowerCase()))
    .sort((a, b) => b.name.length - a.name.length);
  return ranked[0]?.person || null;
}

function answerSalespersonQuestion(text, rows, employees, scope) {
  const kind = questionKind(text);
  if (!kind) return null;
  const person = findNamedSalesperson(text, scopedSalespeople(employees, scope));
  const named = String(text || '').match(/\bfor\s+[a-z]/i);
  if (!person) return named ? { handled: true, reply: 'That salesperson is not in your list.' } : null;
  const phone = normalizePhone(person.phone);
  const mine = visibleInquiries(rows, scope).filter((row) => normalizePhone(row.salesperson_phone) === phone);
  const count = mine.filter((row) => {
    if (kind === 'awaiting_price') return isAwaitingPrice(row);
    return row.pricing_status === kind;
  }).length;
  const noun = count === 1 ? 'inquiry' : 'inquiries';
  const detail = kind === 'price_ready' ? 'price ready' : kind === 'unavailable' ? 'unavailable' : 'left to price';
  return { handled: true, reply: `${person.name} has ${count} ${noun} ${detail}.` };
}

function visibleInquiries(rows, scope) {
  return (rows || []).filter((row) => matchesProcurementScope(row, scope));
}

function salespersonName(inquiry, employees) {
  const phone = normalizePhone(inquiry?.salesperson_phone);
  const match = (employees || []).find((emp) => normalizePhone(emp.phone) === phone);
  return match?.name || 'Salesperson';
}

function allInquiriesOffset(intent) {
  const match = String(intent || '').match(/^procurement\|all\|(\d+)$/);
  return match ? Number(match[1]) : null;
}

function allInquiriesText(rows, employees, offset) {
  const counts = Object.fromEntries(BADGE_ORDER.map((label) => [label, 0]));
  for (const row of rows) {
    for (const label of BADGE_ORDER) {
      if (filterStatusCount(label, row)) counts[label] += 1;
    }
  }
  const summary = BADGE_ORDER.map((label) => `${label}: ${counts[label] || 0}`).join('\n');
  const start = Math.max(0, offset || 0);
  const page = rows.slice(start, start + ALL_INQUIRY_PAGE);
  let body = 'None right now.';
  if (rows.length && page.length) {
    const lines = page.map((row) => formatAllInquiryBlock(row, salespersonName(row, employees), inquiryBadge(row)));
    const footer = start + ALL_INQUIRY_PAGE < rows.length
      ? 'Type next to see the next set of inquiries.'
      : 'There are no more inquiries.';
    body = `${lines.join('\n\n')}\n\n${footer}`;
  } else if (rows.length) {
    body = 'There are no more inquiries.';
  }
  return `*All inquiries*\n\n${summary}\n\n${body}`;
}

function listReply(title, rows, employees) {
  if (!rows.length) return `${title}\n\nNone right now.`;
  const lines = rows.slice(0, 15).map((row) => `• ${formatInquiryLine(row, salespersonName(row, employees))}`);
  const extra = rows.length > 15 ? `\n\n${rows.length - 15} more are on the dashboard.` : '';
  return `${title}\n\n${lines.join('\n')}${extra}`;
}

function teamReply(team, rows) {
  if (!team.length) return 'No procurement person reports to you yet.';
  const lines = team.map((person) => {
    const mine = (rows || []).filter((row) => row.procurement_employee_id === person.id);
    const pending = mine.filter((row) => row.pricing_status === 'awaiting_price').length;
    const ready = mine.filter((row) => row.pricing_status === 'price_ready').length;
    return `• ${person.name}: ${pending} pending, ${ready} price ready`;
  });
  return `*Your team*\n\n${lines.join('\n')}\n\nReply with a person's name to see their inquiries.`;
}

function findTeamPerson(text, team) {
  const needle = String(text || '').trim().toLowerCase();
  if (!needle) return null;
  return (
    team.find((person) => String(person.name || '').toLowerCase() === needle) ||
    team.find((person) => String(person.name || '').toLowerCase().includes(needle)) ||
    null
  );
}

async function handleProcurementChat(text, phone, deps) {
  const {
    getEmployeeByPhone,
    getFullActiveSession,
    saveActiveSession,
    supabase,
  } = deps;
  const employee = await getEmployeeByPhone(phone);
  if (!employee || !isProcurementRole(employee.role)) {
    return { handled: false };
  }
  const { data: employees } = await supabase
    .from('employees')
    .select('id, name, phone, role, is_active, manager_id, manager_phone, assigned_procurement_employee_id');
  const permissions = resolveProcurementPermissions(employee);
  const scope = scopeFromEmployees(employee, employees || [], permissions);
  const session = await getFullActiveSession(phone);
  const intent = String(session?.last_intent || '');
  const clean = String(text || '').trim();
  const showTeam = canSeeTeam(permissions);

  const showMenu = async () => {
    await saveActiveSession(phone, employee.name || 'Procurement', 'procurement|menu');
    return menuResult(showTeam);
  };

  if (!clean || /^(menu|hi|hello|hey|start)$/i.test(clean)) return showMenu();

  if (isProcurementCancel(clean)) {
    const menu = await showMenu();
    return { ...menu, reply: `Activity cancelled.\n\n${menu.reply}` };
  }

  if (isDetailsRequest(clean)) {
    if (!canViewInquiries(permissions)) {
      return { handled: true, reply: VIEW_PERMISSION_REFUSAL };
    }
    const number = clean.toUpperCase().match(/PR-\d+/)[0];
    return inquiryDetailsReply(number, scope, employees || [], deps);
  }

  const menuChoice = normalizeMenuChoice(clean);
  const choice = intent.startsWith('procurement|base|') && /^\d+$/.test(clean) ? null : menuChoice;
  const listedOffset = allInquiriesOffset(intent);
  if (listedOffset != null && !choice) {
    if (!canViewInquiries(permissions)) {
      return { handled: true, reply: VIEW_PERMISSION_REFUSAL };
    }
    if (/^next$/i.test(clean)) {
      return showAllInquiries(phone, employee, scope, employees || [], deps, listedOffset + ALL_INQUIRY_PAGE);
    }
    const pasted = clean.toUpperCase().match(/PR-\d+/);
    if (pasted) return inquiryDetailsReply(pasted[0], scope, employees || [], deps);
  }

  if (intent.startsWith('procurement|base|confirm|') && isBasePriceSave(clean)) {
    return commitConfirmedBasePrice(intent, phone, employee, scope, employees || [], deps);
  }
  if (intent.startsWith('procurement|base|confirm|') && !choice) {
    const draft = readBasePriceDraft(intent);
    if (!draft) return { handled: true, reply: 'Reply with the procurement number again.' };
    return saveBasePrices(clean, draft.n, null, phone, employee, scope, employees || [], deps);
  }
  if (intent.startsWith('procurement|base|') && !choice) {
    const parsedIntent = baseIntent(intent);
    return saveBasePrices(clean, parsedIntent.number, parsedIntent.line, phone, employee, scope, employees || [], deps);
  }

  if (intent === 'procurement|team' && showTeam && !choice) {
    const person = findTeamPerson(clean, scope.team);
    if (person) {
      const rows = await loadInquiries(deps);
      const mine = visibleInquiries(rows, scope).filter((row) => row.procurement_employee_id === person.id);
      await saveActiveSession(phone, employee.name || 'Procurement', 'procurement|menu');
      return { handled: true, reply: listReply(`*${person.name}*`, mine, employees || []) };
    }
    if (!questionKind(clean) && !/PR-\d+/i.test(clean)) {
      return { handled: true, reply: 'I could not find that person on your team. Reply with their name, or menu.' };
    }
  }

  if ((choice === 'pending' || choice === 'all') && !canViewInquiries(permissions)) {
    return { handled: true, reply: VIEW_PERMISSION_REFUSAL };
  }
  if (choice === 'pending') {
    const rows = await loadDashboardAwaiting(deps, scope, employees || []);
    return { handled: true, reply: listReply('*Pending prices*', rows, employees || []) };
  }
  if (choice === 'all') {
    return showAllInquiries(phone, employee, scope, employees || [], deps, 0);
  }
  if (choice === 'base' && !canFillBasePrices(permissions)) {
    return { handled: true, reply: BASE_PRICE_PERMISSION_REFUSAL };
  }
  if (choice === 'base') {
    await saveActiveSession(phone, employee.name || 'Procurement', 'procurement|ask');
    const rows = await loadDashboardAwaiting(deps, scope, employees || []);
    return basePriceListResult(rows, employees || [], supabase);
  }
  if (choice === 'team' && showTeam) {
    const rows = visibleInquiries(await loadInquiries(deps), scope);
    await saveActiveSession(phone, employee.name || 'Procurement', 'procurement|team');
    return { handled: true, reply: teamReply(scope.team, rows) };
  }
  if (choice === 'team' && !showTeam) {
    const menu = menuResult(false);
    return { ...menu, reply: `My team is not available for your access.\n\n${menu.reply}` };
  }

  const numberMatch = clean.toUpperCase().match(/PR-\d+/);
  if (numberMatch) {
    return beginBasePrice(numberMatch[0], phone, employee, scope, employees || [], deps);
  }

  const asked = answerSalespersonQuestion(clean, await loadInquiries(deps), employees || [], scope);
  if (asked) return asked;

  if (intent === 'procurement|ask') {
    const askedNumber = clean.toUpperCase().match(/PR-\d+/);
    return beginBasePrice(askedNumber ? askedNumber[0] : clean.toUpperCase(), phone, employee, scope, employees || [], deps);
  }

  return showMenu();
}

async function loadCanonicalInquiries(deps) {
  if (typeof deps.loadCanonicalInquiries === 'function') {
    return deps.loadCanonicalInquiries();
  }

  const botSecret = process.env.BOT_INTERNAL_SECRET || 'enlight_bot_secret_2026';

  try {
    const backendUrl = (process.env.CENTRAL_BACKEND_URL || process.env.BACKEND_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
    const response = await axios.get(`${backendUrl}/inquiries`, {
      headers: { 'x-bot-secret': botSecret },
      timeout: 15000,
    });
    const rows = Array.isArray(response.data) ? response.data : response.data?.data;
    if (!Array.isArray(rows)) throw new Error('Unexpected canonical inquiry response.');
    return rows;
  } catch (error) {
    throw new Error('Canonical inquiry service is unavailable. Please try again.');
  }
}

async function loadInquiries(deps) {
  return loadCanonicalInquiries(deps);
}

async function loadCustomerOwners(supabase, employees) {
  const { data, error } = await supabase
    .from('recurring_customers')
    .select('customer_name, assigned_salesperson_phone, updated_at')
    .order('updated_at', { ascending: false });
  if (error) return new Map();
  const phones = new Set();
  for (const emp of employees || []) {
    const clean = String(emp?.phone || '').replace(/\D/g, '');
    if (!clean) continue;
    phones.add(clean);
    phones.add(clean.slice(-10));
  }
  const owners = new Map();
  for (const row of data || []) {
    const name = String(row?.customer_name || '').trim().toLowerCase();
    const phone = realSalespersonPhone(row?.assigned_salesperson_phone);
    if (!name || !phone || owners.has(name)) continue;
    const last10 = phone.replace(/\D/g, '').slice(-10);
    if (phones.size && !phones.has(last10)) continue;
    owners.set(name, phone);
  }
  return owners;
}

async function loadScopedInquiries(deps, scope, employees) {
  const owners = await loadCustomerOwners(deps.supabase, employees);
  const rows = await loadCanonicalInquiries(deps);
  return byNewest(rows)
    .map((row) => withResolvedSalesperson(row, owners))
    .filter((row) => matchesProcurementScope(row, scope));
}

async function loadDashboardAwaiting(deps, scope, employees) {
  const owners = await loadCustomerOwners(deps.supabase, employees);
  const rows = await loadCanonicalInquiries(deps);
  return byNewest(rows)
    .map((row) => withResolvedSalesperson(row, owners))
    .filter((row) => isDashboardAwaiting(row) && matchesProcurementScope(row, scope));
}

async function findBasePriceInquiry(deps, scope, employees, number) {
  return (await loadScopedInquiries(deps, scope, employees))
    .find((row) => String(row.procurement_number || '').toUpperCase() === String(number).toUpperCase() && matchesProcurementScope(row, scope))
    || null;
}

async function showAllInquiries(phone, employee, scope, employees, deps, offset) {
  const rows = await loadScopedInquiries(deps, scope, employees);
  const lastPage = rows.length === 0 ? 0 : Math.floor((rows.length - 1) / ALL_INQUIRY_PAGE) * ALL_INQUIRY_PAGE;
  const start = Math.min(Math.max(0, offset || 0), lastPage);
  await deps.saveActiveSession(phone, employee.name || 'Procurement', `procurement|all|${start}`);
  return { handled: true, reply: allInquiriesText(rows, employees, start) };
}

async function inquiryDetailsReply(number, scope, employees, deps) {
  const rows = await loadScopedInquiries(deps, scope, employees);
  const inquiry = rows.find((row) => String(row.procurement_number || '').toUpperCase() === number.toUpperCase());
  if (!inquiry) {
    return { handled: true, reply: `${number} is not in your inquiries.` };
  }
  const { data: savedRows } = await deps.supabase
    .from('inquiry_line_pricing')
    .select('*')
    .eq('inquiry_id', inquiry.id);
  const saved = savedRows || [];
  const lines = sourceLines(inquiry);
  const when = formatInquiryWhen(inquiry.created_at);
  const header = `${inquiry.procurement_number}${when ? ` · ${when}` : ''}`;
  const badge = inquiryBadge(inquiry);
  const summary = `${salespersonName(inquiry, employees)} · ${inquiry.delivery_location || 'Delivery not set'} · ${badge}`;
  const listed = lines.map((line, index) => {
    const match = saved.find((row) => row.line_key === line.line_key);
    return `${index + 1}. ${linePriceDetail(line, match)}`;
  });
  return { handled: true, reply: `${header}\n${summary}\n${listed.join('\n')}` };
}

function awaitingPriceRefusal(number) {
  return {
    handled: true,
    reply: `${number} is not awaiting a price. Only an awaiting price inquiry can take a base price.`,
  };
}

async function beginBasePrice(number, phone, employee, scope, employees, deps) {
  if (!canFillBasePrices(resolveProcurementPermissions(employee))) {
    return { handled: true, reply: BASE_PRICE_PERMISSION_REFUSAL };
  }
  const inquiry = await findBasePriceInquiry(deps, scope, employees, number);
  if (!inquiry) {
    return { handled: true, reply: `${number} is not in your inquiries.` };
  }
  if (!isDashboardAwaiting(inquiry)) return awaitingPriceRefusal(number);
  const lines = sourceLines(inquiry);
  const saved = await loadSavedLines(deps.supabase, [inquiry.id]);
  await deps.saveActiveSession(phone, employee.name || 'Procurement', `procurement|base|${inquiry.procurement_number}`);
  const prompt = lines.length === 1
    ? 'Reply with the base price in rupees per MT, or unavailable.\nExample: 51000'
    : 'Reply with the line number and its base price, in rupees per MT.\nExample: 1 - 2300\nOr several: 1 2300, 2 2500, 4 unavailable: not in stock';
  return {
    handled: true,
    reply: `${basePriceInquiryBlock(inquiry, employees, saved)}\n\n${prompt}`,
  };
}

const BASE_PRICE_BUTTONS = [
  { id: 'btn_price_save', title: 'Save' },
  { id: 'btn_confirm_cancel', title: 'Cancel' },
];

function isBasePriceSave(text) {
  const clean = String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return ['btn_price_save', 'btn_confirm_yes', 'save', 'yes'].includes(clean);
}

function readBasePriceDraft(intent) {
  try {
    const data = JSON.parse(String(intent || '').slice('procurement|base|confirm|'.length));
    if (!data?.n || !Array.isArray(data.pairs) || !data.pairs.length) return null;
    return data;
  } catch {
    return null;
  }
}

function pairsToUpdates(lines, existing, pairs, inquiryId) {
  return pairs.map((pair) => {
    const source = lines[pair.line - 1];
    return {
      ...deriveProcurementLines(existing || [], [{
        ...source,
        base_price_per_mt: pair.price,
        line_note: pair.note,
      }])[0],
      inquiry_id: inquiryId,
    };
  });
}

function basePriceHeadline(inquiry, status) {
  if (status === 'price_ready') {
    return `${inquiry.procurement_number} is now Price ready. Sales can add transport, loading, credit, and margin.`;
  }
  if (status === 'unavailable') {
    return `${inquiry.procurement_number} is now Unavailable. Sales can send the decline from the dashboard.`;
  }
  return `${inquiry.procurement_number} still has lines awaiting a price.`;
}

async function previewBasePrice(inquiry, employees, existing, pairs, phone, employee, saveActiveSession) {
  const lines = sourceLines(inquiry);
  const updates = pairsToUpdates(lines, existing, pairs, inquiry.id);
  const status = mergedPricingStatus(lines, existing, updates);
  const keys = new Set(updates.map((row) => row.line_key));
  const savedRows = [...(existing || []).filter((row) => !keys.has(row.line_key)), ...updates];
  await saveActiveSession(
    phone,
    employee.name || 'Procurement',
    `procurement|base|confirm|${JSON.stringify({ n: inquiry.procurement_number, pairs })}`,
  );
  return {
    handled: true,
    reply: `*Save this base price?*\n\n${basePriceInquiryBlock({ ...inquiry, pricing_status: status }, employees, savedRows)}\n\nSave or Cancel.`,
    interactiveType: 'buttons',
    interactiveButtons: BASE_PRICE_BUTTONS,
  };
}

async function writeBasePriceUpdates(supabase, inquiry, updates) {
  const payload = updates.flatMap((line) => pricingPayload(inquiry, line));
  let { error } = await supabase.from('inquiry_line_pricing').upsert(payload, { onConflict: 'inquiry_id,line_key' });
  if (error && /credit_per_mt/i.test(error.message || '')) {
    const retry = await supabase.from('inquiry_line_pricing').upsert(payload.map((row) => {
      const copy = { ...row };
      delete copy.credit_per_mt;
      return copy;
    }), { onConflict: 'inquiry_id,line_key' });
    error = retry.error;
  }
  return error;
}

async function finishBasePriceSave(inquiry, employees, existing, updates, status, phone, employee, saveActiveSession) {
  await saveActiveSession(phone, employee.name || 'Procurement', `procurement|base|${inquiry.procurement_number}`);
  const keys = new Set(updates.map((row) => row.line_key));
  const savedRows = [...(existing || []).filter((row) => !keys.has(row.line_key)), ...updates];
  return {
    handled: true,
    reply: `${basePriceHeadline(inquiry, status)}\n\n${basePriceInquiryBlock({ ...inquiry, pricing_status: status }, employees, savedRows)}`,
  };
}

async function commitConfirmedBasePrice(intent, phone, employee, scope, employees, deps) {
  if (!canFillBasePrices(resolveProcurementPermissions(employee))) {
    return { handled: true, reply: BASE_PRICE_PERMISSION_REFUSAL };
  }
  const draft = readBasePriceDraft(intent);
  const { supabase, saveActiveSession } = deps;
  if (!draft) return { handled: true, reply: 'Reply with the procurement number again.' };
  const inquiry = await findBasePriceInquiry(deps, scope, employees, draft.n);
  if (!inquiry) {
    await saveActiveSession(phone, employee.name || 'Procurement', 'procurement|menu');
    return { handled: true, reply: `${draft.n} is not in your inquiries.` };
  }
  if (!isDashboardAwaiting(inquiry)) return awaitingPriceRefusal(draft.n);
  const lines = sourceLines(inquiry);
  const { data: existing } = await supabase.from('inquiry_line_pricing').select('*').eq('inquiry_id', inquiry.id);
  const updates = pairsToUpdates(lines, existing, draft.pairs, inquiry.id);
  const status = mergedPricingStatus(lines, existing, updates);
  const error = await writeBasePriceUpdates(supabase, inquiry, updates);
  if (error) return { handled: true, reply: 'The base price could not be saved. Try again from the dashboard.' };
  await supabase.from('inquiries').update({ pricing_status: status }).eq('id', inquiry.id);
  return finishBasePriceSave(inquiry, employees, existing, updates, status, phone, employee, saveActiveSession);
}

function mergedPricingStatus(lines, existing, updates) {
  const byKey = new Map([].concat(updates || []).map((row) => [row.line_key, row]));
  const merged = lines.map((line) => byKey.get(line.line_key) || latestSaved(existing, line.line_key) || { line_status: 'needs_price' });
  return procurementStatus(merged);
}

function pricingPayload(inquiry, line) {
  return [{
    inquiry_id: inquiry.id,
    line_key: line.line_key,
    sku_text: line.sku_text || null,
    quantity: line.quantity ?? null,
    unit: line.unit || null,
    procurement_base_price_per_mt: line.procurement_base_price_per_mt ?? null,
    procurement_line_note: line.procurement_line_note || null,
    line_status: line.line_status,
    sales_base_price_per_mt: line.sales_base_price_per_mt ?? null,
    transport_per_mt: line.transport_per_mt ?? null,
    loading_per_mt: line.loading_per_mt ?? null,
    credit_per_mt: line.credit_per_mt ?? null,
    margin_per_mt: line.margin_per_mt ?? null,
    rate_per_mt: line.rate_per_mt ?? null,
    updated_at: new Date().toISOString(),
  }];
}

async function saveBasePrices(text, number, selectedLine, phone, employee, scope, employees, deps) {
  if (!canFillBasePrices(resolveProcurementPermissions(employee))) {
    return { handled: true, reply: BASE_PRICE_PERMISSION_REFUSAL };
  }
  const { supabase, saveActiveSession } = deps;
  const inquiry = await findBasePriceInquiry(deps, scope, employees, number);
  if (!inquiry) {
    await saveActiveSession(phone, employee.name || 'Procurement', 'procurement|menu');
    return { handled: true, reply: `${number} is not in your inquiries.` };
  }
  if (!isDashboardAwaiting(inquiry)) return awaitingPriceRefusal(number);
  const lines = sourceLines(inquiry);
  const { data: existing } = await supabase.from('inquiry_line_pricing').select('*').eq('inquiry_id', inquiry.id);
  const assignments = parsePriceAssignments(text, lines.length);
  if (assignments?.error) return { handled: true, reply: assignments.error };
  if (assignments?.pairs?.length && assignments.pairs.every((pair) => pair.priceText)) {
    const pairs = [];
    for (const pair of assignments.pairs) {
      const token = parseBaseToken(pair.priceText);
      if (token.error) return { handled: true, reply: token.error };
      pairs.push({ line: pair.line, price: token.price, note: token.note });
    }
    return previewBasePrice(inquiry, employees, existing, pairs, phone, employee, saveActiveSession);
  }
  const choice = parseLineChoice(text, lines.length);
  if (choice?.error) return { handled: true, reply: choice.error };

  let lineIndex = choice?.line || (lines.length === 1 ? 1 : null);
  let priceText = choice?.priceText || null;
  if (!choice && selectedLine) {
    lineIndex = selectedLine;
    priceText = text;
  }
  if (!choice && !selectedLine && lines.length === 1) priceText = text;

  if (!lineIndex) {
    return {
      handled: true,
      reply: 'Reply with the line number and its base price, in rupees per MT.\nExample: 1 - 2300',
    };
  }
  if (!priceText) {
    const line = lines[lineIndex - 1];
    const match = latestSaved(existing, line.line_key);
    await saveActiveSession(phone, employee.name || 'Procurement', `procurement|base|${inquiry.procurement_number}|${lineIndex}`);
    return {
      handled: true,
      reply: `*${inquiry.procurement_number}*\n\n${lineOffer(line, match, lineIndex - 1)}\n\nReply with the base price in rupees per MT, or unavailable.`,
    };
  }

  const parsed = parseBaseToken(priceText);
  if (parsed.error) return { handled: true, reply: parsed.error };
  return previewBasePrice(
    inquiry,
    employees,
    existing,
    [{ line: lineIndex, price: parsed.price, note: parsed.note }],
    phone,
    employee,
    saveActiveSession,
  );
}

module.exports = {
  OPEN_STATUSES,
  normalizePhone,
  matchesProcurementScope,
  scopeFromEmployees,
  sourceLines,
  procurementStatus,
  deriveProcurementLines,
  parseBasePrices,
  formatInquiryLine,
  menuText,
  menuRows,
  menuResult,
  basePriceListResult,
  answerSalespersonQuestion,
  visibleInquiries,
  listReply,
  teamReply,
  findTeamPerson,
  isProcurementRole,
  handleProcurementChat,
};
