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

function roundMt(value) {
  return Math.round((Number(value) || 0) * 1000) / 1000;
}

function weightMt(item) {
  const { convertLineItemToMt } = require('../utils/pricingEngine');
  const manualFlag = item?.is_manual_mt;
  const manual =
    manualFlag === true || manualFlag === 'true' || manualFlag === 1 || manualFlag === '1';
  const manualMt = Number(item?.converted_mt);
  if (manual && Number.isFinite(manualMt) && manualMt > 0) return roundMt(manualMt);

  const unit = String(item?.original_unit || item?.unit || 'MT').toLowerCase();
  const weighed = { ...(item || {}) };
  if (unit === 'mt' || unit === 'kg' || unit === 'kgs') {
    delete weighed.weight_mt;
    delete weighed.converted_mt;
  }
  const converted = Number(convertLineItemToMt(weighed));
  if (Number.isFinite(converted) && converted > 0) return roundMt(converted);
  if (PIECE_UNITS.has(unit)) return 0;
  const quantity = Math.max(0, Number(weighed.quantity ?? weighed.qty) || 0);
  if (unit === 'kg' || unit === 'kgs') return roundMt(quantity / 1000);
  return roundMt(quantity);
}

function lineSnapshot(item) {
  return {
    sku_text: String(item?.sku_text || item?.description || 'Material'),
    mt: weightMt(item),
  };
}

function tonnageReviewPatch(input) {
  const status = input?.pricingStatus || null;
  const open = Boolean(input?.reviewOpen);
  const canOpen = status === 'price_ready';
  const canUpdate = open && status === 'awaiting_price';
  if (!canOpen && !canUpdate) return null;
  if (!Array.isArray(input?.afterLines) || input.afterLines.length === 0) return null;

  const before = (input.beforeLines || []).map(lineSnapshot);
  const after = input.afterLines.map(lineSnapshot);
  const countNow = Math.max(before.length, after.length);
  let weightChanged = before.length !== after.length;
  for (let index = 0; index < countNow; index += 1) {
    if ((before[index]?.mt ?? 0) !== (after[index]?.mt ?? 0)) weightChanged = true;
  }
  if (!weightChanged) return null;

  const baseline = canUpdate && input.existingReview?.baseline?.length
    ? input.existingReview.baseline.map((line) => ({
      sku_text: line.sku_text || 'Material',
      mt: roundMt(line.mt),
    }))
    : before;
  const count = Math.max(baseline.length, after.length);
  const lines = [];
  let previous = 0;
  let next = 0;
  for (let index = 0; index < count; index += 1) {
    const from = roundMt(baseline[index]?.mt ?? 0);
    const to = roundMt(after[index]?.mt ?? 0);
    previous += from;
    next += to;
    if (from !== to) {
      lines.push({
        sku_text: after[index]?.sku_text || baseline[index]?.sku_text || 'Material',
        from_mt: from,
        to_mt: to,
      });
    }
  }
  previous = roundMt(previous);
  next = roundMt(next);
  const previousTotal = canUpdate && input.existingReview?.previous_total_mt != null
    ? roundMt(input.existingReview.previous_total_mt)
    : previous;

  if (!lines.length && previousTotal === next) {
    if (!canUpdate) return null;
    return {
      pricing_status: 'price_ready',
      tonnage_review_open: false,
      tonnage_review: null,
    };
  }

  return {
    pricing_status: 'awaiting_price',
    tonnage_review_open: true,
    tonnage_review: {
      changed_at: input.now || new Date().toISOString(),
      previous_total_mt: previousTotal,
      next_total_mt: next,
      lines,
      baseline,
    },
  };
}

async function commitInquiryUpdate(supabase, id, fields) {
  const first = await supabase.from('inquiries').update(fields).eq('id', id);
  if (!first?.error || !/tonnage_review/i.test(first.error.message || '')) return first;
  const retry = { ...fields };
  delete retry.tonnage_review_open;
  delete retry.tonnage_review;
  return supabase.from('inquiries').update(retry).eq('id', id);
}

module.exports = {
  tonnageReviewPatch,
  commitInquiryUpdate,
  weightMt,
};
