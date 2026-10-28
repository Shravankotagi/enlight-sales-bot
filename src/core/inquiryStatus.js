const { sourceLines, stageBadge, inquiryBadge } = require('./procurementChat');

const CUTOFF = new Date('2026-10-15T00:00:00+05:30').getTime();

function visiblePricingStatus(inquiry) {
  const status = inquiry?.pricing_status || null;
  if (status !== 'awaiting_price') return status;
  if (inquiry?.tonnage_review_open) return status;
  const created = inquiry?.created_at ? new Date(inquiry.created_at).getTime() : NaN;
  return !Number.isNaN(created) && created < CUTOFF ? null : status;
}

function displayStageFor(inquiry, deals = []) {
  if (inquiry?.display_stage) return String(inquiry.display_stage).toLowerCase();
  const linked = (deals || [])
    .filter((deal) => deal && (deal.inquiry_id === inquiry?.id || deal.id === inquiry?.id))
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))[0];
  const raw = linked?.stage || inquiry?.stage || inquiry?.status || 'new_inquiry';
  const stage = String(raw).toLowerCase().trim();
  if (stage === 'qualified') return 'quoted';
  if (stage === 'hold') return 'on_hold';
  if (stage === 'price_quote') return 'quoted';
  return ['new_inquiry', 'quoted', 'negotiation', 'on_hold', 'won', 'lost'].includes(stage)
    ? stage
    : 'new_inquiry';
}

function inquiryStatusLabel(inquiry, deals = []) {
  const pricing = visiblePricingStatus(inquiry);
  if (pricing === 'awaiting_price') return 'Awaiting Price';
  if (pricing === 'price_ready') return 'Price Ready';
  if (pricing === 'unavailable') return 'Unavailable';
  return stageBadge(displayStageFor(inquiry, deals));
}

async function loadLinePricing(supabase, inquiryIds) {
  const ids = (inquiryIds || []).filter(Boolean);
  if (!ids.length) return new Map();
  const { data } = await supabase.from('inquiry_line_pricing').select('*').in('inquiry_id', ids);
  const result = new Map();
  for (const row of data || []) {
    if (!result.has(row.inquiry_id)) result.set(row.inquiry_id, []);
    result.get(row.inquiry_id).push(row);
  }
  return result;
}

function money(value) {
  return Number(value || 0).toLocaleString('en-IN');
}

function lineFromStoredItem(item, index) {
  const sku = item?.sku_text || item?.description || item?.product_name || item?.product_requirement || 'Material';
  return {
    id: item?.id || null,
    line_key: String(item?.id || item?.line_key || `${index}:${sku}`),
    sku_text: sku,
    quantity: Number(item?.original_quantity ?? item?.quantity ?? item?.qty) || 0,
    unit: item?.original_unit || item?.unit || 'MT',
    dimensions: item?.dimensions || item?.spec || null,
    grade: item?.grade || null,
    weight_mt: item?.weight_mt ?? item?.converted_mt ?? null,
  };
}

function materialLines(inquiry) {
  const dealItems = Array.isArray(inquiry?.deal_items) ? inquiry.deal_items.filter(Boolean) : [];
  const inquiryItems = Array.isArray(inquiry?.inquiry_items) ? inquiry.inquiry_items.filter(Boolean) : [];
  const chosen = dealItems.length ? dealItems : inquiryItems;
  if (chosen.length) return chosen.map(lineFromStoredItem);
  const ai = inquiry?.ai_extraction_json || {};
  const aiLines = Array.isArray(ai.line_items) ? ai.line_items : ai.lineItems;
  if (!Array.isArray(aiLines) || !aiLines.length) return [];
  return sourceLines(inquiry);
}

function latestPricingRow(rows, line, index) {
  const saved = Array.isArray(rows) ? rows : [];
  const byKey = line?.line_key
    ? saved.filter((item) => item && item.line_key === line.line_key)
    : [];
  if (byKey.length) return byKey[byKey.length - 1];
  const sku = String(line?.sku_text || '').trim().toLowerCase();
  const bySku = sku
    ? saved.filter((item) => item && String(item.sku_text || '').trim().toLowerCase() === sku)
    : [];
  if (bySku.length) return bySku[bySku.length - 1];
  return saved[index] || {};
}

function pricingBreakdownLines(inquiry, rows = []) {
  const saved = rows || [];
  return materialLines(inquiry).map((line, index) => {
    const row = latestPricingRow(saved, line, index);
    const base = Number(row.sales_base_price_per_mt ?? row.procurement_base_price_per_mt) || 0;
    const transport = Number(row.transport_per_mt) || 0;
    const loading = Number(row.loading_per_mt) || 0;
    const credit = Number(row.credit_per_mt) || 0;
    const margin = Number(row.margin_per_mt) || 0;
    const rate = Number(row.rate_per_mt) || (base + transport + loading + credit + margin);
    const label = `${line.sku_text} ${line.quantity || ''} ${line.unit || 'MT'}`.replace(/\s+/g, ' ').trim();
    if (row.line_status === 'cannot_price') return `• ${label} — Unavailable`;
    if (!base) return `• ${label} — Awaiting price`;
    return `• ${label} — Base ₹${money(base)} + Transport ₹${money(transport)} + Loading ₹${money(loading)} + Credit ₹${money(credit)} + Margin ₹${money(margin)} = Rate ₹${money(rate)}/MT`;
  });
}

module.exports = {
  visiblePricingStatus,
  displayStageFor,
  inquiryStatusLabel,
  inquiryBadge,
  loadLinePricing,
  materialLines,
  latestPricingRow,
  pricingBreakdownLines,
};
