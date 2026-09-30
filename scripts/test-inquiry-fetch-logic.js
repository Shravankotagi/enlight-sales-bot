const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const { supabase } = require('../src/supabase');

function formatProductSummaryCompact(record) {
  if (Array.isArray(record.deal_items) && record.deal_items.length > 0) {
    const totalQty = record.deal_items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
    const unit = record.deal_items[0].unit || 'MT';
    const mainProduct = record.deal_items[0].sku_text || 'Steel Item';
    if (record.deal_items.length === 1) {
      const dim = record.deal_items[0].dimensions ? ` (${record.deal_items[0].dimensions})` : '';
      return `${totalQty} ${unit} ${mainProduct}${dim}`.trim();
    }
    const products = Array.from(new Set(record.deal_items.map(i => i.sku_text).filter(Boolean))).join(', ');
    return `${record.deal_items.length} Items (${totalQty} ${unit}) — ${products}`;
  }
  const ai = record.ai_extraction_json || {};
  const lineItems = ai.line_items || ai.lineItems || [];
  if (Array.isArray(lineItems) && lineItems.length > 0) {
    const totalQty = lineItems.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
    const unit = lineItems[0].unit || 'MT';
    const mainProduct = lineItems[0].sku_text || lineItems[0].product_name || ai.productType || 'Steel Item';
    if (lineItems.length === 1) {
      const dim = lineItems[0].dimensions ? ` (${lineItems[0].dimensions})` : '';
      return `${totalQty} ${unit} ${mainProduct}${dim}`.trim();
    }
    return `${lineItems.length} Items (${totalQty} ${unit}) — ${mainProduct}`;
  }
  return ai.productType || 'Steel Material';
}

function formatDateDDMMYYYY(dateVal) {
  if (!dateVal) return '25-09-2026';
  const d = new Date(dateVal);
  if (isNaN(d.getTime())) return '25-09-2026';
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}-${month}-${year}`;
}

function formatStageLabel(stage) {
  if (!stage) return 'New Inquiry';
  const s = stage.toLowerCase().trim();
  if (s === 'new_inquiry' || s === 'new' || s === 'review' || s === 'needs_review') return 'New Inquiry';
  if (s === 'quoted' || s === 'quotation_sent' || s === 'qualified' || s === 'saved' || s === 'confirmed') return 'Quoted';
  if (s === 'negotiation') return 'Negotiation';
  if (s === 'on_hold' || s === 'hold') return 'On Hold';
  if (s === 'won') return 'Won';
  if (s === 'lost') return 'Lost';
  return s.charAt(0).toUpperCase() + s.slice(1);
}


async function getInquiries() {
  const [{ data: inqs }, { data: deals }] = await Promise.all([
    supabase
      .from('inquiries')
      .select('id, sender_name, sender_phone, raw_text, ai_extraction_json, status, inquiry_type, created_at, salesperson_phone')
      .neq('inquiry_type', 'purchase_order')
      .order('created_at', { ascending: false }),
    supabase
      .from('deals')
      .select('id, inquiry_id, customer_name, customer_phone, po_number, stage, total_amount, payment_terms, delivery_location, created_at, salesperson_phone, deal_items(id, sku_text, grade, dimensions, quantity, unit, rate, amount)')
      .order('created_at', { ascending: false }),
  ]);

  const dealByInqId = new Map();
  const wonOrClosedInqIds = new Set();
  const terminalStages = new Set(['won', 'lost', 'closed', 'completed', 'cancelled', 'auto_created']);

  (deals || []).forEach(d => {
    const stage = (d.stage || '').toLowerCase().trim();
    const isTerminal = terminalStages.has(stage) || Boolean(d.po_number);
    if (d.inquiry_id) {
      if (isTerminal) {
        wonOrClosedInqIds.add(d.inquiry_id);
      } else if (!dealByInqId.has(d.inquiry_id)) {
        dealByInqId.set(d.inquiry_id, d);
      }
    }
  });

  const matched = [];
  const seenInqIds = new Set();

  // 1. Process Genuine Inquiries from inquiries table
  (inqs || []).forEach(inq => {
    if (wonOrClosedInqIds.has(inq.id)) return;
    if (terminalStages.has((inq.status || '').toLowerCase().trim())) return;
    const rawLower = (inq.raw_text || '').toLowerCase().trim();
    if (rawLower.startsWith('[po document attached:') || rawLower.includes('po number:')) return;

    const linkedDeal = dealByInqId.get(inq.id);
    const stage = (linkedDeal?.stage || inq.status || 'new_inquiry').toLowerCase().trim();
    if (terminalStages.has(stage)) return;

    const cleanCode = (inq.id || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toUpperCase();
    const displayId = `INQ-${cleanCode}`;
    const ai = inq.ai_extraction_json || {};
    const prodSummary = linkedDeal ? formatProductSummaryCompact(linkedDeal) : formatProductSummaryCompact(inq);
    const stageLabel = formatStageLabel(stage);
    const dateFormatted = formatDateDDMMYYYY(inq.created_at);

    matched.push({
      id: inq.id,
      deal_id: linkedDeal?.id || null,
      inquiry_id: inq.id,
      displayId,
      clean_code: cleanCode,
      customer_name: linkedDeal?.customer_name || inq.sender_name || ai.companyName || ai.customer_name || 'Customer',
      product_summary: prodSummary,
      stage: stageLabel,
      raw_stage: stage,
      date_formatted: dateFormatted,
      payment_terms: linkedDeal?.payment_terms || ai.paymentTerms || ai.payment_terms || 'Not specified',
      delivery_location: linkedDeal?.delivery_location || ai.deliveryLocation || ai.delivery_location || 'Not specified',
      total_amount: Number(linkedDeal?.total_amount) || Number(ai.totalAmount) || 0,
      deal_items: linkedDeal?.deal_items || ai.lineItems || ai.line_items || [],
      created_at: inq.created_at,
    });
    seenInqIds.add(inq.id);
  });

  // 2. Process standalone deals that have NO inquiry_id (created directly in CRM without an inquiry record)
  (deals || []).forEach(d => {
    if (d.inquiry_id && seenInqIds.has(d.inquiry_id)) return;
    if (d.inquiry_id) return; // If it has an inquiry_id but wasn't in inqs, it was filtered out (e.g. PO)
    const stage = (d.stage || 'new_inquiry').toLowerCase().trim();
    if (terminalStages.has(stage) || Boolean(d.po_number)) return;

    const cleanCode = (d.id || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toUpperCase();
    const displayId = `INQ-${cleanCode}`;
    const prodSummary = formatProductSummaryCompact(d);
    const stageLabel = formatStageLabel(stage);
    const dateFormatted = formatDateDDMMYYYY(d.created_at);

    matched.push({
      id: d.id,
      deal_id: d.id,
      inquiry_id: d.id,
      displayId,
      clean_code: cleanCode,
      customer_name: d.customer_name || 'Customer',
      product_summary: prodSummary,
      stage: stageLabel,
      raw_stage: stage,
      date_formatted: dateFormatted,
      payment_terms: d.payment_terms || 'Not specified',
      delivery_location: d.delivery_location || 'Not specified',
      total_amount: Number(d.total_amount) || 0,
      deal_items: d.deal_items || [],
      created_at: d.created_at,
    });
  });

  // Sort newest first by created_at strictly matching CRM Inquiries table sequence
  matched.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

  console.log(`Total open inquiries found: ${matched.length}`);
  console.log('Top 7 open inquiries:');
  matched.slice(0, 7).forEach((m, i) => {
    console.log(`  ${i + 1}. ${m.displayId} | ${m.customer_name} | ${m.product_summary} | ${m.stage} | ${m.date_formatted}`);
  });

  const has1DAA9E = matched.some(m => m.displayId.includes('1DAA9E') || m.id.includes('1daa9e'));
  console.log(`\nContains INQ-1DAA9E: ${has1DAA9E} (Must be false)`);
}

getInquiries();
