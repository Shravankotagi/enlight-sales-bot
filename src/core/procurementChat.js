const { isProcurementManager, isProcurementRole } = require('../utils/roles');

const OPEN_STATUSES = ['new', 'pending', 'review', 'draft', 'new_inquiry'];

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

function matchesProcurementScope(item, scope) {
  if (!scope) return false;
  const ids = scope.ids || [];
  if (item?.procurement_employee_id && ids.includes(item.procurement_employee_id)) {
    return true;
  }
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

function scopeFromEmployees(employee, employees) {
  const ownId = employee?.id ? [employee.id] : [];
  const manager = isProcurementManager(employee?.role);
  if (!manager) {
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

function formatInquiryLine(inquiry, salespersonName) {
  const number = inquiry?.procurement_number || 'No procurement number';
  const when = formatInquiryWhen(inquiry?.created_at);
  const place = inquiry?.delivery_location || 'Delivery not set';
  return `${number} · ${when ? `${when} · ` : ''}${salespersonName || 'Salesperson'} · ${productSummary(inquiry)} · ${place} · ${statusLabel(inquiry?.pricing_status)}`;
}

function menuRows(isManager) {
  const rows = [
    { id: 'proc_1', title: '1. Pending prices', description: 'Inquiries waiting for a base price' },
    { id: 'proc_2', title: '2. Current inquiries', description: 'Price ready or unavailable' },
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
  if (['2', 'proc_2', 'current', 'current inquiries', '2. current inquiries'].includes(clean)) return 'current';
  if (['3', 'proc_3', 'base price', 'log a base price', '3. log a base price'].includes(clean)) return 'base';
  if (['4', 'proc_4', 'my team', '4. my team'].includes(clean)) return 'team';
  return null;
}

function byNewest(rows) {
  return [...(rows || [])].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
}

function basePriceListResult(rows, employees) {
  const waiting = byNewest(rows).filter(isAwaitingPrice);
  const shown = waiting.slice(0, 7);
  if (!shown.length) {
    return { handled: true, reply: 'None are waiting for a base price.' };
  }
  const lines = shown.map((row) => formatInquiryLine(row, salespersonName(row, employees)));
  let reply = `Copy a procurement number, or the whole line, and send it.\n\n${lines.join('\n')}`;
  if (waiting.length > 7) reply += '\n\nView the rest in the Inquiries tab.';
  return { handled: true, reply };
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
  const scope = scopeFromEmployees(employee, employees || []);
  const session = await getFullActiveSession(phone);
  const intent = String(session?.last_intent || '');
  const clean = String(text || '').trim();
  const manager = isProcurementManager(employee.role);

  const showMenu = async () => {
    await saveActiveSession(phone, employee.name || 'Procurement', 'procurement|menu');
    return menuResult(manager);
  };

  if (!clean || /^(menu|hi|hello|hey|start)$/i.test(clean)) return showMenu();

  if (isProcurementCancel(clean)) {
    const menu = await showMenu();
    return { ...menu, reply: `Activity cancelled.\n\n${menu.reply}` };
  }

  if (isDetailsRequest(clean)) {
    const number = clean.toUpperCase().match(/PR-\d+/)[0];
    return inquiryDetailsReply(number, scope, employees || [], deps);
  }

  const choice = normalizeMenuChoice(clean);
  if (intent.startsWith('procurement|base|') && !choice) {
    const number = intent.slice('procurement|base|'.length);
    return saveBasePrices(clean, number, phone, employee, scope, employees || [], deps);
  }

  if (intent === 'procurement|team' && manager && !choice) {
    const person = findTeamPerson(clean, scope.team);
    if (person) {
      const rows = await loadInquiries(supabase);
      const mine = visibleInquiries(rows, scope).filter((row) => row.procurement_employee_id === person.id);
      await saveActiveSession(phone, employee.name || 'Procurement', 'procurement|menu');
      return { handled: true, reply: listReply(`*${person.name}*`, mine, employees || []) };
    }
    if (!questionKind(clean) && !/PR-\d+/i.test(clean)) {
      return { handled: true, reply: 'I could not find that person on your team. Reply with their name, or menu.' };
    }
  }

  if (choice === 'pending') {
    const rows = visibleInquiries(await loadInquiries(supabase), scope).filter(
      isAwaitingPrice,
    );
    return { handled: true, reply: listReply('*Pending prices*', rows, employees || []) };
  }
  if (choice === 'current') {
    const rows = visibleInquiries(await loadInquiries(supabase), scope).filter((row) =>
      ['price_ready', 'unavailable'].includes(row.pricing_status),
    );
    return { handled: true, reply: listReply('*Current inquiries*', rows, employees || []) };
  }
  if (choice === 'base') {
    await saveActiveSession(phone, employee.name || 'Procurement', 'procurement|ask');
    const rows = visibleInquiries(await loadInquiries(supabase), scope);
    return basePriceListResult(rows, employees || []);
  }
  if (choice === 'team' && manager) {
    const rows = visibleInquiries(await loadInquiries(supabase), scope);
    await saveActiveSession(phone, employee.name || 'Procurement', 'procurement|team');
    return { handled: true, reply: teamReply(scope.team, rows) };
  }
  if (choice === 'team' && !manager) {
    const menu = menuResult(false);
    return { ...menu, reply: `My team is available to a procurement manager.\n\n${menu.reply}` };
  }

  const numberMatch = clean.toUpperCase().match(/PR-\d+/);
  if (numberMatch) {
    return beginBasePrice(numberMatch[0], phone, employee, scope, employees || [], deps);
  }

  const asked = answerSalespersonQuestion(clean, await loadInquiries(supabase), employees || [], scope);
  if (asked) return asked;

  if (intent === 'procurement|ask') {
    return beginBasePrice(clean.toUpperCase(), phone, employee, scope, employees || [], deps);
  }

  return showMenu();
}

async function loadInquiries(supabase) {
  const { data } = await supabase
    .from('inquiries')
    .select('id, procurement_number, procurement_employee_id, status, pricing_status, salesperson_phone, employee_id, delivery_location, ai_extraction_json, created_at')
    .order('created_at', { ascending: false })
    .limit(500);
  return data || [];
}

async function inquiryDetailsReply(number, scope, employees, deps) {
  const rows = visibleInquiries(await loadInquiries(deps.supabase), scope);
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
  const summary = `${salespersonName(inquiry, employees)} · ${inquiry.delivery_location || 'Delivery not set'} · ${statusLabel(inquiry.pricing_status)}`;
  const listed = lines.map((line, index) => {
    const match = saved.find((row) => row.line_key === line.line_key);
    return `${index + 1}. ${linePriceDetail(line, match)}`;
  });
  return { handled: true, reply: `${header}\n${summary}\n${listed.join('\n')}` };
}

async function beginBasePrice(number, phone, employee, scope, employees, deps) {
  const rows = visibleInquiries(await loadInquiries(deps.supabase), scope);
  const inquiry = rows.find((row) => String(row.procurement_number || '').toUpperCase() === number.toUpperCase());
  if (!inquiry) {
    return { handled: true, reply: `${number} is not in your inquiries.` };
  }
  const lines = sourceLines(inquiry);
  await deps.saveActiveSession(phone, employee.name || 'Procurement', `procurement|base|${inquiry.procurement_number}`);
  const listed = lines
    .map((line, index) => `${index + 1}. ${line.sku_text} ${line.quantity || ''} ${line.unit || 'MT'}`.trim())
    .join('\n');
  return {
    handled: true,
    reply:
      `${inquiry.procurement_number}\n${listed}\n\n` +
      'Reply with one base price per line, in rupees per MT. Use unavailable for a line you cannot price.\n' +
      'Example:\n500\nunavailable: not in stock',
  };
}

async function saveBasePrices(text, number, phone, employee, scope, employees, deps) {
  const { supabase, saveActiveSession } = deps;
  const rows = visibleInquiries(await loadInquiries(supabase), scope);
  const inquiry = rows.find((row) => String(row.procurement_number || '').toUpperCase() === String(number).toUpperCase());
  if (!inquiry) {
    await saveActiveSession(phone, employee.name || 'Procurement', 'procurement|menu');
    return { handled: true, reply: `${number} is not in your inquiries.` };
  }
  const lines = sourceLines(inquiry);
  const parsed = parseBasePrices(text, lines.length);
  if (parsed.error) return { handled: true, reply: parsed.error };
  const { data: existing } = await supabase.from('inquiry_line_pricing').select('*').eq('inquiry_id', inquiry.id);
  const submitted = lines.map((line, index) => ({
    ...line,
    base_price_per_mt: parsed.lines[index].price,
    line_note: parsed.lines[index].note,
  }));
  const next = deriveProcurementLines(existing || [], submitted);
  const status = procurementStatus(next);
  const payload = next.map((line) => ({
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
  }));
  let { error } = await supabase.from('inquiry_line_pricing').upsert(payload, { onConflict: 'inquiry_id,line_key' });
  if (error && /credit_per_mt/i.test(error.message || '')) {
    const retry = await supabase
      .from('inquiry_line_pricing')
      .upsert(payload.map((row) => {
        const copy = { ...row };
        delete copy.credit_per_mt;
        return copy;
      }), { onConflict: 'inquiry_id,line_key' });
    error = retry.error;
  }
  if (error) return { handled: true, reply: 'The base price could not be saved. Try again from the dashboard.' };
  await supabase.from('inquiries').update({ pricing_status: status }).eq('id', inquiry.id);
  await saveActiveSession(phone, employee.name || 'Procurement', 'procurement|menu');
  const reply = status === 'price_ready'
    ? `${inquiry.procurement_number} is now Price ready. Sales can add transport, loading, credit, and margin.`
    : `${inquiry.procurement_number} is now Unavailable. Sales can send the decline from the dashboard.`;
  return { handled: true, reply };
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
