function money(value) {
  return Math.round(Number(value) * 100) / 100;
}

function nonNegative(value) {
  return Math.max(0, Number(value) || 0);
}

function quantityToMt(quantity, unit) {
  const normalized = String(unit || '').toLowerCase();
  if (normalized === 'kg' || normalized === 'kgs') return nonNegative(quantity) / 1000;
  return nonNegative(quantity);
}

const PIECE_UNITS = new Set([
  'nos',
  'no',
  'pcs',
  'pc',
  'pieces',
  'piece',
  'units',
  'unit',
  'sheets',
  'sheet',
  'plates',
  'plate',
  'bundles',
  'bundle',
  'coils',
  'coil',
]);

function weightMtForLine(line) {
  const { convertLineItemToMt } = require('../utils/pricingEngine');
  const converted = convertLineItemToMt(line);
  if (typeof converted === 'number' && Number.isFinite(converted) && converted > 0) {
    return Math.round(converted * 1000) / 1000;
  }
  if (PIECE_UNITS.has(String(line?.unit || '').toLowerCase())) return 0;
  return quantityToMt(Number(line?.quantity) || 0, line?.unit || 'MT');
}

function taxableFromRate(rate, line) {
  return money(rate * weightMtForLine(line));
}

function parseIndianAmount(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const match = String(value).replace(/[₹,\s]/g, '').match(/\d+(?:\.\d+)?/);
  if (!match) return null;
  const amount = Number(match[0]);
  return Number.isFinite(amount) ? amount : null;
}

function customerTargetNote(draft) {
  const rates = [];
  const header = parseIndianAmount(draft?.rate);
  if (header) rates.push(header);
  for (const item of draft?.line_items || []) {
    const rate = parseIndianAmount(item?.rate);
    if (rate) rates.push(rate);
  }
  const unique = Array.from(new Set(rates));
  const existing = String(draft?.additional_notes || '').trim();
  if (!unique.length) return existing || null;
  const target = `Customer target: ₹${unique.map((rate) => Number(rate).toLocaleString('en-IN')).join(', ')}/MT`;
  return existing ? `${existing}. ${target}` : target;
}

function salesPriceInquiryUpdate(inquiry) {
  const update = { pricing_status: 'sales_priced' };
  const stage = String(inquiry?.status || '').toLowerCase().trim();
  if (!['negotiation', 'on_hold', 'hold', 'won', 'lost'].includes(stage)) update.status = 'quoted';
  return update;
}

function calculateSellRate(line) {
  const base = nonNegative(line.sales_base_price_per_mt ?? line.procurement_base_price_per_mt);
  return money(
    base +
      nonNegative(line.transport_per_mt) +
      nonNegative(line.loading_per_mt) +
      nonNegative(line.credit_per_mt) +
      nonNegative(line.margin_per_mt),
  );
}

function gstSplit(amount, deliveryAddress = '') {
  const taxable = nonNegative(amount);
  const maharashtra = /\bmaharashtra\b|\bmh\b/i.test(deliveryAddress);
  if (maharashtra) {
    const cgst = money(taxable * 0.09);
    const sgst = money(taxable * 0.09);
    return { cgst_amount: cgst, sgst_amount: sgst, igst_amount: 0, total: money(cgst + sgst) };
  }
  const igst = money(taxable * 0.18);
  return { cgst_amount: 0, sgst_amount: 0, igst_amount: igst, total: igst };
}

function priceSalesLine(line, parts, deliveryAddress) {
  const base = nonNegative(line.procurement_base_price_per_mt);
  const next = {
    ...line,
    sales_base_price_per_mt: base,
    transport_per_mt: nonNegative(parts.transport_per_mt),
    loading_per_mt: nonNegative(parts.loading_per_mt),
    credit_per_mt: nonNegative(parts.credit_per_mt),
    margin_per_mt: nonNegative(parts.margin_per_mt),
  };
  const rate = calculateSellRate(next);
  const taxable = taxableFromRate(rate, line);
  const gst = gstSplit(taxable, deliveryAddress);
  return {
    ...next,
    rate_per_mt: rate,
    taxable_amount: taxable,
    cgst_amount: gst.cgst_amount,
    sgst_amount: gst.sgst_amount,
    igst_amount: gst.igst_amount,
    final_amount: money(taxable + gst.total),
    line_status: base > 0 ? 'priced' : line.line_status,
  };
}

function parseComponentGroup(text) {
  const bits = String(text || '')
    .split(/[,/]+/)
    .map((bit) => bit.trim())
    .filter((bit) => bit.length > 0);
  if (bits.length === 3) bits.splice(2, 0, '0');
  if (bits.length !== 4) {
    return { error: 'Send transport, loading, credit, and margin. A blank credit is 0.' };
  }
  const names = ['transport_per_mt', 'loading_per_mt', 'credit_per_mt', 'margin_per_mt'];
  const values = {};
  for (let index = 0; index < 4; index += 1) {
    const raw = bits[index];
    if (index === 2 && (raw == null || /^(blank|none|na|n\/a|-)$/i.test(raw))) {
      values.credit_per_mt = 0;
      continue;
    }
    if (raw == null) return { error: 'Margin is required. Credit can be blank.' };
    const amount = Number(String(raw).replace(/[₹,\s]/g, ''));
    if (!Number.isFinite(amount) || amount < 0) {
      return { error: 'Transport, loading, credit, and margin cannot be negative.' };
    }
    values[names[index]] = amount;
  }
  if (values.credit_per_mt == null) values.credit_per_mt = 0;
  return { parts: values };
}

function parseSalesPrices(text, lineCount) {
  const groups = String(text || '')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const chosen = groups.length === 1 && lineCount > 1 ? Array(lineCount).fill(groups[0]) : groups;
  if (chosen.length !== lineCount) {
    return { error: `Send ${lineCount} row${lineCount === 1 ? '' : 's'}: transport, loading, credit, margin.` };
  }
  const parsed = chosen.map(parseComponentGroup);
  const failed = parsed.find((item) => item.error);
  if (failed) return { error: failed.error };
  return { rows: parsed.map((item) => item.parts) };
}

function prematureUpdateReply({ pricingStatus, stage, hasRate }) {
  const terminal = ['quoted', 'won', 'lost', 'confirmed'].includes(String(stage || '').toLowerCase());
  if (!terminal && !hasRate) return null;
  if (!pricingStatus || pricingStatus === 'sales_priced') return null;
  if (pricingStatus === 'unavailable') {
    return 'Every line is unavailable. Send the decline from the dashboard. The assistant does not send that email.';
  }
  if (pricingStatus === 'price_ready') {
    return 'The base price is ready. Reply *Price this inquiry* and send transport, loading, credit, and margin. Quoted, Won, and Lost stay closed until that sales price is saved.';
  }
  return 'This inquiry is still waiting for a procurement base price. Quoted, Won, and Lost stay closed until the sales price is saved.';
}

function orderRateReply(pricingStatus) {
  if (!pricingStatus || pricingStatus === 'sales_priced') return null;
  if (pricingStatus === 'unavailable') {
    return 'Every line is unavailable, so this inquiry has no sales rate. Send the decline from the dashboard.';
  }
  return 'This order needs the saved sales rate. Reply *Price this inquiry* after procurement sets the base price. A price typed while logging the inquiry is not the sell rate.';
}

function isSalesPriceText(text) {
  return /^\s*price this inquiry\b/i.test(String(text || '')) || /^\s*price\s+PR-\d+/i.test(String(text || ''));
}

async function handleSalesPriceChat(text, phone, lastIntent, deps) {
  const { supabase, saveActiveSession, getAccessibleSalespersonPhonesForBot, expandPhoneVariants } = deps;
  const clean = String(text || '').trim();
  const scope = await getAccessibleSalespersonPhonesForBot(phone);
  const phones = expandPhoneVariants(scope.phones || [phone]);

  if (!String(lastIntent || '').startsWith('sales_price|lines|') || isSalesPriceText(clean)) {
    const number = (clean.match(/PR-\d+/i) || [])[0];
    const inquiry = await findSalesInquiry(supabase, phones, scope.isAdmin, number);
    if (!inquiry) {
      await saveActiveSession(phone, 'Sales', 'sales_price|ask');
      return { handled: true, reply: 'Reply with the procurement number, for example PR-10041.' };
    }
    return presentSalesPrice(inquiry, phone, deps);
  }

  if (lastIntent === 'sales_price|ask') {
    const number = (clean.match(/PR-\d+/i) || [clean])[0];
    const inquiry = await findSalesInquiry(supabase, phones, scope.isAdmin, number);
    if (!inquiry) return { handled: true, reply: `${number} is not one of your inquiries.` };
    return presentSalesPrice(inquiry, phone, deps);
  }

  const encoded = lastIntent.slice('sales_price|lines|'.length);
  let state;
  try {
    state = JSON.parse(encoded);
  } catch (err) {
    return { handled: true, reply: 'Reply *Price this inquiry* to start again.' };
  }
  const inquiry = await findSalesInquiry(supabase, phones, scope.isAdmin, state.number);
  if (!inquiry) return { handled: true, reply: 'That inquiry is no longer in your list.' };
  const { data: existing } = await supabase.from('inquiry_line_pricing').select('*').eq('inquiry_id', inquiry.id);
  const { sourceLines } = require('./procurementChat');
  const source = sourceLines(inquiry);
  const lines = (existing || []).map((row, index) => {
    const match = source.find((line) => line.line_key === row.line_key) || source[index] || {};
    return {
      ...row,
      sku_text: row.sku_text || match.sku_text,
      quantity: row.quantity ?? match.quantity,
      unit: row.unit || match.unit,
      dimensions: row.dimensions || match.dimensions,
      weight_mt: row.weight_mt ?? match.weight_mt,
    };
  });
  const parsed = parseSalesPrices(clean, lines.length || state.count || 1);
  if (parsed.error) return { handled: true, reply: parsed.error };
  const delivery = inquiry.delivery_location || inquiry.ai_extraction_json?.delivery_location || '';
  const priced = lines.map((line, index) => priceSalesLine(line, parsed.rows[index] || parsed.rows[0], delivery));
  const payload = priced.map((line) => ({
    inquiry_id: inquiry.id,
    line_key: line.line_key,
    sku_text: line.sku_text || null,
    quantity: line.quantity ?? null,
    unit: line.unit || null,
    procurement_base_price_per_mt: line.procurement_base_price_per_mt ?? null,
    sales_base_price_per_mt: line.sales_base_price_per_mt ?? null,
    transport_per_mt: line.transport_per_mt ?? null,
    loading_per_mt: line.loading_per_mt ?? null,
    credit_per_mt: line.credit_per_mt ?? null,
    margin_per_mt: line.margin_per_mt ?? null,
    rate_per_mt: line.rate_per_mt ?? null,
    taxable_amount: line.taxable_amount ?? null,
    cgst_amount: line.cgst_amount ?? null,
    sgst_amount: line.sgst_amount ?? null,
    igst_amount: line.igst_amount ?? null,
    final_amount: line.final_amount ?? null,
    line_status: line.line_status || 'priced',
    updated_at: new Date().toISOString(),
  }));
  let { error } = await supabase.from('inquiry_line_pricing').upsert(payload, { onConflict: 'inquiry_id,line_key' });
  if (error && /credit_per_mt/i.test(error.message || '')) {
    const retry = await supabase.from('inquiry_line_pricing').upsert(rowsWithoutCredit(payload), { onConflict: 'inquiry_id,line_key' });
    error = retry.error;
  }
  if (error) return { handled: true, reply: 'The sales price could not be saved. Use the inquiries page.' };
  await supabase.from('inquiries').update(salesPriceInquiryUpdate(inquiry)).eq('id', inquiry.id);
  await saveActiveSession(phone, 'Sales', 'general');
  const rates = priced.map((line) => `${line.sku_text || 'Line'} ₹${Number(line.rate_per_mt).toLocaleString('en-IN')}/MT`).join('\n');
  return { handled: true, reply: `${inquiry.procurement_number} is sales priced.\n${rates}` };
}

async function findSalesInquiry(supabase, phones, isAdmin, number) {
  let query = supabase.from('inquiries').select('id, procurement_number, status, pricing_status, delivery_location, salesperson_phone, ai_extraction_json').order('created_at', { ascending: false }).limit(300);
  if (!isAdmin && phones?.length) query = query.in('salesperson_phone', phones);
  const { data } = await query;
  if (!number) return null;
  const wanted = String(number).toUpperCase();
  return (data || []).find((row) => String(row.procurement_number || '').toUpperCase() === wanted) || null;
}

async function presentSalesPrice(inquiry, phone, deps) {
  if (inquiry.pricing_status === 'unavailable') {
    return { handled: true, reply: 'Every line is unavailable. Send the decline from the dashboard. The assistant does not send that email.' };
  }
  if (!inquiry.pricing_status || inquiry.pricing_status === 'awaiting_price') {
    return { handled: true, reply: `${inquiry.procurement_number || 'This inquiry'} is still waiting for a procurement base price.` };
  }
  const { data: lines } = await deps.supabase.from('inquiry_line_pricing').select('*').eq('inquiry_id', inquiry.id);
  const ready = lines || [];
  if (!ready.length) {
    return { handled: true, reply: 'The base price is not on the line yet. Ask procurement to save it first.' };
  }
  const listed = ready
    .map((line, index) => `${index + 1}. ${line.sku_text || 'Material'} base ₹${Number(line.procurement_base_price_per_mt || 0).toLocaleString('en-IN')}/MT`)
    .join('\n');
  await deps.saveActiveSession(
    phone,
    'Sales',
    `sales_price|lines|${JSON.stringify({ number: inquiry.procurement_number, count: ready.length })}`,
  );
  return {
    handled: true,
    reply:
      `${inquiry.procurement_number}\n${listed}\n\n` +
      'Reply with transport, loading, credit, and margin for each line, in rupees per MT. A blank credit is 0.\n' +
      'Example: 1000, 500, 0, 1500',
  };
}

function rowsWithoutCredit(rows) {
  return rows.map((row) => {
    const next = { ...row };
    delete next.credit_per_mt;
    return next;
  });
}

const FULL_PRICE_FIELDS = [
  { key: 'base', label: 'Base' },
  { key: 'transport_per_mt', label: 'Transport' },
  { key: 'loading_per_mt', label: 'Loading' },
  { key: 'credit_per_mt', label: 'Credit' },
  { key: 'margin_per_mt', label: 'Margin' },
];

function isFullPriceEntry(text) {
  const clean = String(text || '').trim().toLowerCase();
  return clean === 'menu_price'
    || clean === 'add price to inquiry'
    || clean === 'add price'
    || /^5\.\s*add price to inquiry$/.test(clean)
    || /^btn_price_current\|pr-\d+$/i.test(clean);
}

function isBareAddPriceChoice(text) {
  return /^(?:option\s*|choice\s*|#\s*)?5\.?$/i.test(String(text || '').trim());
}

function formatSalesWhen(value) {
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

function fullPriceStatusLabel(status) {
  if (status === 'price_ready') return 'Price ready';
  if (status === 'awaiting_price') return 'Awaiting price';
  return '';
}

function missingSentence(labels) {
  const words = labels.map((label, index) => (index === 0 ? label : label.toLowerCase()));
  if (words.length === 1) return `${words[0]} is still missing.`;
  const last = words[words.length - 1];
  return `${words.slice(0, -1).join(', ')} and ${last} are still missing.`;
}

function procurementNumberFrom(text) {
  const raw = String(text || '').trim();
  const only = raw.match(/^(?:PR[-\s]*)?(\d{3,})$/i);
  if (only) return `PR-${only[1]}`;
  const embedded = raw.match(/\bPR[-\s]*(\d+)\b/i);
  if (embedded) return `PR-${embedded[1]}`;
  return null;
}

function onlyPrefixedProcurementNumber(text) {
  const match = String(text || '').trim().match(/^PR[-\s]*(\d+)$/i);
  return match ? `PR-${match[1]}` : null;
}

function rupees(value) {
  return `₹${Number(value).toLocaleString('en-IN')}`;
}

const PRICE_SAVE_WORDS = new Set([
  'btn_price_save',
  'btn_confirm_yes',
  'save',
  'save this price',
  'save / yes',
  'save/yes',
  'yes',
  'y',
  'confirm',
  'haan',
  'ok',
  'sure',
  'sahi hai',
]);

function isPriceSave(text) {
  const clean = String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return PRICE_SAVE_WORDS.has(clean);
}

const PRICE_SAVE_BUTTONS = [
  { id: 'btn_price_save', title: 'Save' },
  { id: 'btn_confirm_cancel', title: 'Cancel' },
];

function parseLabeledPrices(text) {
  const found = {};
  const pattern = /\b(base|transport|loading|credit|margin)\b(?:\s+[a-z]+)?\s*[-:=]?\s*(blank|none|na|n\/a|-|\d[\d,]*(?:\.\d+)?)/gi;
  let match = pattern.exec(text);
  if (!match) return null;
  while (match) {
    const field = FULL_PRICE_FIELDS.find((item) => item.label.toLowerCase() === match[1].toLowerCase());
    const raw = match[2];
    if (field.key === 'credit_per_mt' && /^(blank|none|na|n\/a|-)$/i.test(raw)) {
      found[field.key] = 0;
    } else {
      const amount = Number(String(raw).replace(/[₹,\s]/g, ''));
      if (!Number.isFinite(amount) || amount < 0) {
        return { error: `${field.label} must be a price in rupees per MT.` };
      }
      found[field.key] = amount;
    }
    match = pattern.exec(text);
  }
  const missing = FULL_PRICE_FIELDS.filter((field) => found[field.key] == null).map((field) => field.label);
  if (missing.length) return { found, missing };
  return { parts: found };
}

function parseOneAmount(token, field) {
  const raw = String(token || '').trim();
  if (field.key === 'credit_per_mt' && /^(blank|none|na|n\/a|-)$/i.test(raw)) return { amount: 0 };
  const amount = Number(raw.replace(/[₹,\s]/g, ''));
  if (!Number.isFinite(amount) || amount < 0) {
    return { error: `${field.label} must be a price in rupees per MT.` };
  }
  return { amount };
}

function parseFullPriceTokens(tokens) {
  const parts = {};
  for (let index = 0; index < FULL_PRICE_FIELDS.length; index += 1) {
    const field = FULL_PRICE_FIELDS[index];
    const parsed = parseOneAmount(tokens[index], field);
    if (parsed.error) return parsed;
    parts[field.key] = parsed.amount;
  }
  return { parts };
}

function priceFullLine(line, parts, deliveryAddress) {
  const next = {
    ...line,
    sales_base_price_per_mt: nonNegative(parts.base),
    transport_per_mt: nonNegative(parts.transport_per_mt),
    loading_per_mt: nonNegative(parts.loading_per_mt),
    credit_per_mt: nonNegative(parts.credit_per_mt),
    margin_per_mt: nonNegative(parts.margin_per_mt),
  };
  const rate = calculateSellRate(next);
  const taxable = taxableFromRate(rate, line);
  const gst = gstSplit(taxable, deliveryAddress);
  return {
    ...next,
    rate_per_mt: rate,
    taxable_amount: taxable,
    cgst_amount: gst.cgst_amount,
    sgst_amount: gst.sgst_amount,
    igst_amount: gst.igst_amount,
    final_amount: money(taxable + gst.total),
    line_status: nonNegative(parts.base) > 0 ? 'priced' : (line.line_status || 'needs_price'),
  };
}

function encodeFullPrice(state) {
  return `sales_full|${JSON.stringify(state)}`;
}

function encodeFullPriceConfirm(number, rows) {
  return `sales_full|confirm|${JSON.stringify({ number, rows })}`;
}

function fullPricePrompt(inquiry, lines, lineIndex) {
  const listed = lines
    .map((line, index) => `${index + 1}. ${line.sku_text || 'Material'} ${line.quantity || ''} ${line.unit || 'MT'}`.replace(/\s+/g, ' ').trim())
    .join('\n');
  const current = lines[lineIndex] || {};
  const which = lines.length > 1 ? `Line ${lineIndex + 1}: ${current.sku_text || 'Material'}. ` : '';
  return `${inquiry.procurement_number}\n${listed}\n\n${which}Reply with base, transport, loading, credit, and margin, in rupees per MT.\nExample: 62000, 1000, 500, 0, 1500`;
}

async function salesPriceScope(phone, deps) {
  const scope = await deps.getAccessibleSalespersonPhonesForBot(phone);
  const phones = deps.expandPhoneVariants(scope.phones || [phone]);
  return { isAdmin: Boolean(scope.isAdmin), phones };
}

async function loadSalesInquiries(supabase, phones, isAdmin) {
  let query = supabase
    .from('inquiries')
    .select('id, procurement_number, status, pricing_status, procurement_employee_id, delivery_location, salesperson_phone, customer_name, ai_extraction_json, created_at')
    .order('created_at', { ascending: false })
    .limit(300);
  if (!isAdmin && phones?.length) query = query.in('salesperson_phone', phones);
  const { data } = await query;
  return data || [];
}

function findNumberedInquiry(rows, number) {
  const wanted = String(number || '').toUpperCase();
  return rows.find((row) => String(row.procurement_number || '').toUpperCase() === wanted) || null;
}

async function loadFullPriceLines(inquiry, deps) {
  const { sourceLines } = require('./procurementChat');
  const source = sourceLines(inquiry);
  const { data } = await deps.supabase.from('inquiry_line_pricing').select('*').eq('inquiry_id', inquiry.id);
  const existing = data || [];
  return source.map((line, index) => {
    const saved = existing.find((row) => row.line_key === line.line_key) || existing[index] || {};
    return {
      ...saved,
      line_key: line.line_key,
      sku_text: line.sku_text || saved.sku_text,
      quantity: line.quantity ?? saved.quantity,
      unit: line.unit || saved.unit || 'MT',
      dimensions: line.dimensions || saved.dimensions,
      weight_mt: line.weight_mt ?? saved.weight_mt,
      procurement_base_price_per_mt: saved.procurement_base_price_per_mt ?? null,
    };
  });
}

function salesProductSummary(inquiry) {
  const { sourceLines } = require('./procurementChat');
  const lines = sourceLines(inquiry);
  const first = lines[0] || {};
  const qty = first.quantity ? `${first.quantity} ${first.unit || 'MT'}` : (first.unit || 'MT');
  const more = lines.length > 1 ? ` +${lines.length - 1} more` : '';
  return `${first.sku_text || 'Material'} ${qty}${more}`.trim();
}

async function listFullPriceInquiries(supabase, phones, isAdmin, phone, deps) {
  const rows = (await loadSalesInquiries(supabase, phones, isAdmin))
    .filter((row) => row.pricing_status === 'awaiting_price' || row.pricing_status === 'price_ready')
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  await deps.saveActiveSession(phone, 'Sales', 'sales_full|list');
  if (!rows.length) return { handled: true, reply: 'None are awaiting a price or price ready.' };
  const shown = rows.slice(0, 10);
  const lines = shown.map((row) => {
    const when = formatSalesWhen(row.created_at);
    const customer = row.customer_name || row.ai_extraction_json?.customer_name || 'Customer';
    return `${row.procurement_number} · ${when ? `${when} · ` : ''}${customer} · ${salesProductSummary(row)} · ${fullPriceStatusLabel(row.pricing_status)}`;
  });
  let reply = `Copy a procurement number, or the whole line, and send it.\n\n${lines.join('\n')}`;
  if (rows.length > 10) reply += '\n\nView the rest in the Inquiries tab.';
  return { handled: true, reply };
}

async function beginFullPrice(number, phones, isAdmin, phone, deps) {
  const inquiry = findNumberedInquiry(await loadSalesInquiries(deps.supabase, phones, isAdmin), number);
  if (!inquiry) return { handled: true, reply: `${String(number).toUpperCase()} is not one of your inquiries.` };
  if (inquiry.pricing_status === 'unavailable') {
    return { handled: true, reply: 'Every line is unavailable. Send the decline from the dashboard. The assistant does not send that email.' };
  }
  if (inquiry.pricing_status !== 'awaiting_price' && inquiry.pricing_status !== 'price_ready') {
    return { handled: true, reply: `${inquiry.procurement_number} is not awaiting a price or price ready.` };
  }
  const lines = await loadFullPriceLines(inquiry, deps);
  if (!lines.length) return { handled: true, reply: `${inquiry.procurement_number} has no product lines.` };
  const state = { number: inquiry.procurement_number, count: lines.length, lineIndex: 0, partial: [], rows: [] };
  await deps.saveActiveSession(phone, 'Sales', encodeFullPrice(state));
  return { handled: true, reply: fullPricePrompt(inquiry, lines, 0) };
}

function namedParts(named) {
  const parts = {};
  for (const field of FULL_PRICE_FIELDS) parts[field.key] = named[field.key];
  return parts;
}

function applyFullPriceText(state, text) {
  const next = {
    number: state.number,
    count: state.count,
    lineIndex: state.lineIndex || 0,
    partial: [...(state.partial || [])],
    named: { ...(state.named || {}) },
    rows: [...(state.rows || [])],
  };
  const lines = String(text || '').split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const incoming = lines.length ? lines : [''];
  for (const line of incoming) {
    const labeled = parseLabeledPrices(line);
    if (labeled) {
      if (labeled.error) return labeled;
      const named = { ...next.named, ...(labeled.parts || labeled.found) };
      next.partial = [];
      const missing = FULL_PRICE_FIELDS.filter((field) => named[field.key] == null).map((field) => field.label);
      if (missing.length) {
        next.named = named;
        return { state: next, missing };
      }
      next.rows.push(namedParts(named));
      next.named = {};
      next.lineIndex += 1;
      if (next.lineIndex >= next.count) return { done: true, rows: next.rows };
      continue;
    }
    const tokens = line.split(/[,/]+/).map((bit) => bit.trim()).filter(Boolean);
    if (tokens.length === FULL_PRICE_FIELDS.length) {
      const parsed = parseFullPriceTokens(tokens);
      if (!parsed.error) {
        next.rows.push(parsed.parts);
        next.named = {};
        next.partial = [];
        next.lineIndex += 1;
        if (next.lineIndex >= next.count) return { done: true, rows: next.rows };
        continue;
      }
    }
    if (Object.keys(next.named).length) {
      const missingFields = FULL_PRICE_FIELDS.filter((field) => next.named[field.key] == null);
      if (tokens.length > missingFields.length) {
        return { error: 'Send base, transport, loading, credit, and margin.' };
      }
      for (let index = 0; index < tokens.length; index += 1) {
        const parsed = parseOneAmount(tokens[index], missingFields[index]);
        if (parsed.error) return parsed;
        next.named[missingFields[index].key] = parsed.amount;
      }
      const still = FULL_PRICE_FIELDS.filter((field) => next.named[field.key] == null).map((field) => field.label);
      next.partial = [];
      if (still.length) return { state: next, missing: still };
      next.rows.push(namedParts(next.named));
      next.named = {};
      next.lineIndex += 1;
      if (next.lineIndex >= next.count) return { done: true, rows: next.rows };
      continue;
    }
    const combined = next.partial.concat(tokens);
    if (!combined.length) continue;
    if (combined.length > FULL_PRICE_FIELDS.length) {
      return { error: 'Send base, transport, loading, credit, and margin.' };
    }
    if (combined.length < FULL_PRICE_FIELDS.length) {
      next.partial = combined;
      const missing = FULL_PRICE_FIELDS.slice(combined.length).map((field) => field.label);
      return { state: next, missing };
    }
    const parsed = parseFullPriceTokens(combined);
    if (parsed.error) return { error: parsed.error };
    next.rows.push(parsed.parts);
    next.partial = [];
    next.lineIndex += 1;
    if (next.lineIndex >= next.count) return { done: true, rows: next.rows };
  }
  if (next.partial.length) {
    const missing = FULL_PRICE_FIELDS.slice(next.partial.length).map((field) => field.label);
    return { state: next, missing };
  }
  if (Object.keys(next.named).length) {
    const missing = FULL_PRICE_FIELDS.filter((field) => next.named[field.key] == null).map((field) => field.label);
    return { state: next, missing };
  }
  return { state: next };
}

async function saveFullPrice(inquiry, partsRows, phone, deps) {
  const lines = await loadFullPriceLines(inquiry, deps);
  const delivery = inquiry.delivery_location || inquiry.ai_extraction_json?.delivery_location || '';
  const priced = lines.map((line, index) => priceFullLine(line, partsRows[index], delivery));
  const payload = priced.map((line) => ({
    inquiry_id: inquiry.id,
    line_key: line.line_key,
    sku_text: line.sku_text || null,
    quantity: line.quantity ?? null,
    unit: line.unit || null,
    procurement_base_price_per_mt: line.procurement_base_price_per_mt ?? null,
    sales_base_price_per_mt: line.sales_base_price_per_mt ?? null,
    transport_per_mt: line.transport_per_mt ?? null,
    loading_per_mt: line.loading_per_mt ?? null,
    credit_per_mt: line.credit_per_mt ?? null,
    margin_per_mt: line.margin_per_mt ?? null,
    rate_per_mt: line.rate_per_mt ?? null,
    taxable_amount: line.taxable_amount ?? null,
    cgst_amount: line.cgst_amount ?? null,
    sgst_amount: line.sgst_amount ?? null,
    igst_amount: line.igst_amount ?? null,
    final_amount: line.final_amount ?? null,
    line_status: line.line_status || 'priced',
    updated_at: new Date().toISOString(),
  }));
  let { error } = await deps.supabase.from('inquiry_line_pricing').upsert(payload, { onConflict: 'inquiry_id,line_key' });
  if (error && /credit_per_mt/i.test(error.message || '')) {
    const retry = await deps.supabase.from('inquiry_line_pricing').upsert(rowsWithoutCredit(payload), { onConflict: 'inquiry_id,line_key' });
    error = retry.error;
  }
  if (error) return { handled: true, reply: 'The sales price could not be saved. Use the inquiries page.' };
  await deps.supabase.from('inquiries').update(salesPriceInquiryUpdate(inquiry)).eq('id', inquiry.id);
  await deps.saveActiveSession(phone, 'Sales', 'general');
  const rates = priced.map((line) => `${line.sku_text || 'Line'} ${rupees(line.rate_per_mt)}/MT`).join('\n');
  return { handled: true, reply: `${inquiry.procurement_number} is sales priced.\n${rates}` };
}

async function presentFullPriceConfirmation(inquiry, partsRows, phone, deps) {
  const lines = await loadFullPriceLines(inquiry, deps);
  const delivery = inquiry.delivery_location || inquiry.ai_extraction_json?.delivery_location || '';
  const priced = lines.map((line, index) => priceFullLine(line, partsRows[index], delivery));
  const detail = priced.map((line, index) => (
    `${index + 1}. ${line.sku_text || 'Material'} ${line.quantity || ''} ${line.unit || 'MT'} — base ${rupees(line.sales_base_price_per_mt)}, transport ${rupees(line.transport_per_mt)}, loading ${rupees(line.loading_per_mt)}, credit ${rupees(line.credit_per_mt)}, margin ${rupees(line.margin_per_mt)}\nRate ${rupees(line.rate_per_mt)}/MT`
  )).join('\n');
  await deps.saveActiveSession(phone, 'Sales', encodeFullPriceConfirm(inquiry.procurement_number, partsRows));
  return {
    handled: true,
    reply: `${inquiry.procurement_number}\n${detail}\n\nSave this price?`,
    interactiveType: 'buttons',
    interactiveButtons: PRICE_SAVE_BUTTONS,
  };
}

async function confirmFullPrice(text, lastIntent, phones, isAdmin, phone, deps) {
  let state;
  try {
    state = JSON.parse(lastIntent.slice('sales_full|confirm|'.length));
  } catch (err) {
    return { handled: true, reply: 'Reply *Add Price to Inquiry* to start again.' };
  }
  const inquiry = findNumberedInquiry(await loadSalesInquiries(deps.supabase, phones, isAdmin), state.number);
  if (!inquiry) return { handled: true, reply: 'That inquiry is no longer in your list.' };
  if (isPriceSave(text)) return saveFullPrice(inquiry, state.rows, phone, deps);
  return presentFullPriceConfirmation(inquiry, state.rows, phone, deps);
}

async function continueFullPrice(text, lastIntent, phones, isAdmin, phone, deps) {
  let state;
  try {
    state = JSON.parse(lastIntent.slice('sales_full|'.length));
  } catch (err) {
    return { handled: true, reply: 'Reply *Add Price to Inquiry* to start again.' };
  }
  const restart = onlyPrefixedProcurementNumber(text);
  if (restart) return beginFullPrice(restart, phones, isAdmin, phone, deps);
  const inquiry = findNumberedInquiry(await loadSalesInquiries(deps.supabase, phones, isAdmin), state.number);
  if (!inquiry) return { handled: true, reply: 'That inquiry is no longer in your list.' };
  const lines = await loadFullPriceLines(inquiry, deps);
  const applied = applyFullPriceText(state, text);
  if (applied.error) return { handled: true, reply: applied.error };
  if (applied.done) return presentFullPriceConfirmation(inquiry, applied.rows, phone, deps);
  await deps.saveActiveSession(phone, 'Sales', encodeFullPrice(applied.state));
  const kept = applied.state.partial.length || Object.keys(applied.state.named || {}).length;
  if (applied.missing && kept) {
    return { handled: true, reply: missingSentence(applied.missing) };
  }
  return { handled: true, reply: fullPricePrompt(inquiry, lines, applied.state.lineIndex) };
}

async function handleFullSalesPrice(text, phone, lastIntent, deps) {
  const clean = String(text || '').trim();
  const intent = String(lastIntent || '');
  const { isAdmin, phones } = await salesPriceScope(phone, deps);
  const menu = clean.toLowerCase();
  if (menu === 'menu_price' || menu === 'add price to inquiry' || menu === 'add price' || menu === '5. add price to inquiry') {
    return listFullPriceInquiries(deps.supabase, phones, isAdmin, phone, deps);
  }
  const buttonNumber = (clean.match(/^btn_price_current\|(PR-\d+)$/i) || [])[1];
  if (buttonNumber) return beginFullPrice(buttonNumber, phones, isAdmin, phone, deps);
  if (intent.startsWith('sales_full|confirm|')) {
    return confirmFullPrice(clean, intent, phones, isAdmin, phone, deps);
  }
  if (intent.startsWith('sales_full|{')) {
    return continueFullPrice(clean, intent, phones, isAdmin, phone, deps);
  }
  if (isBareAddPriceChoice(clean)) {
    return listFullPriceInquiries(deps.supabase, phones, isAdmin, phone, deps);
  }
  const number = procurementNumberFrom(clean);
  if (number) return beginFullPrice(number, phones, isAdmin, phone, deps);
  await deps.saveActiveSession(phone, 'Sales', 'sales_full|list');
  return { handled: true, reply: 'Reply with the procurement number, for example PR-10041.' };
}

module.exports = {
  customerTargetNote,
  calculateSellRate,
  priceSalesLine,
  parseSalesPrices,
  prematureUpdateReply,
  orderRateReply,
  isSalesPriceText,
  isFullPriceEntry,
  isBareAddPriceChoice,
  rowsWithoutCredit,
  quantityToMt,
  handleSalesPriceChat,
  handleFullSalesPrice,
};
