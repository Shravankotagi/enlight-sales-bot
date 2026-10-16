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
  const taxable = money(rate * quantityToMt(Number(line.quantity) || 0, line.unit || 'MT'));
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
  const lines = existing || [];
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
  await supabase.from('inquiries').update({ pricing_status: 'sales_priced' }).eq('id', inquiry.id);
  await saveActiveSession(phone, 'Sales', 'general');
  const rates = priced.map((line) => `${line.sku_text || 'Line'} ₹${Number(line.rate_per_mt).toLocaleString('en-IN')}/MT`).join('\n');
  return { handled: true, reply: `${inquiry.procurement_number} is sales priced.\n${rates}` };
}

async function findSalesInquiry(supabase, phones, isAdmin, number) {
  let query = supabase.from('inquiries').select('id, procurement_number, pricing_status, delivery_location, salesperson_phone, ai_extraction_json').order('created_at', { ascending: false }).limit(300);
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

module.exports = {
  customerTargetNote,
  calculateSellRate,
  priceSalesLine,
  parseSalesPrices,
  prematureUpdateReply,
  orderRateReply,
  isSalesPriceText,
  rowsWithoutCredit,
  quantityToMt,
  handleSalesPriceChat,
};
