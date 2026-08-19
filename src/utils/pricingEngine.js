/**
 * Dedicated Centralized Pricing Engine for Enlight Sales OS (Bot)
 * 
 * Responsibilities:
 * - Rate lookup from active/latest rate sheets with dimension compatibility check
 * - Line item amount calculation (quantity * rate)
 * - Strict Forward GST calculation (baseAmount * 0.18) — never reverse calculated
 * - Subtotal calculation (sum of line item amounts)
 * - Grand Total calculation (subtotal + forward GST)
 * - Full quotation & deal financial breakdown aggregation
 */

const DEFAULT_GST_RATE = 0.18;

/**
 * Extracts dimension tokens (e.g. "8mm", "1250x2500") from a string.
 */
function extractDimensions(str) {
  if (!str) return [];
  const matches = str.toLowerCase().match(/\b(\d+(?:\.\d+)?\s*(?:mm|cm|m|inch|x\d+)?)\b/g);
  if (!matches) return [];
  return matches.filter((m) => /\d+/.test(m) && (m.includes('mm') || m.includes('x') || m.includes('cm') || m.includes('inch')));
}

/**
 * Checks if dimensions requested in text match candidate SKU dimensions.
 * Prevents "HR Coil 8mm" from erroneously matching a "6mm" SKU or a dimension-less SKU.
 *
 * @param {string} requestedText - Product requirement text
 * @param {string} skuText - SKU from rate sheet
 * @returns {boolean}
 */
function isDimensionCompatible(requestedText, skuText) {
  const reqDims = extractDimensions(requestedText);
  const skuDims = extractDimensions(skuText);

  if (reqDims.length === 0 && skuDims.length === 0) return true;
  // If user requested a specific mm dimension, but candidate SKU has no dimension specified:
  // Reject so it triggers explicit price confirmation for that specific mm dimension!
  if (reqDims.length > 0 && skuDims.length === 0) return false;

  if (reqDims.length > 0 && skuDims.length > 0) {
    for (const rd of reqDims) {
      const rdClean = rd.replace(/\s+/g, '').toLowerCase();
      const rdNum = rdClean.replace(/[^\d.]/g, '');
      const skuHasMatchingDim = skuDims.some((sd) => {
        const sdClean = sd.replace(/\s+/g, '').toLowerCase();
        const sdNum = sdClean.replace(/[^\d.]/g, '');
        return rdClean === sdClean || rdNum === sdNum;
      });
      if (!skuHasMatchingDim) return false;
    }
  }

  return true;
}

/**
 * Look up product price per MT from active or latest rate sheet.
 *
 * @param {string} productText - Product name or description (e.g. "HR Coil 8mm")
 * @param {object} [supabaseClient] - Optional Supabase client instance (defaults to shared client)
 * @returns {Promise<{ price_per_mt: number, matched_sku: string } | null>}
 */
async function lookupRateSheetPrice(productText, supabaseClient) {
  if (!productText) return null;

  try {
    const supabase = supabaseClient || require('../supabase').supabase;
    const today = new Date().toISOString().split('T')[0];

    // 1. Fetch today's rate sheet
    let { data: latestSheet } = await supabase
      .from('rate_sheets')
      .select('id, date')
      .eq('date', today)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    // 2. Fallback to latest available sheet
    if (!latestSheet) {
      const { data: recentSheet } = await supabase
        .from('rate_sheets')
        .select('id, date')
        .order('date', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(1)
        .single();
      latestSheet = recentSheet;
    }

    if (!latestSheet) return null;

    const { data: items } = await supabase
      .from('rate_sheet_items')
      .select('sku_text, category, price_per_mt')
      .eq('rate_sheet_id', latestSheet.id);

    if (!items || items.length === 0) return null;

    const textLower = productText.toLowerCase();
    let matched = null;

    // Priority 1: Match on sku_text with dimension compatibility
    for (const i of items) {
      const skuLower = (i.sku_text || '').toLowerCase();
      if (!skuLower) continue;

      if (textLower.includes(skuLower) || skuLower.includes(textLower)) {
        if (isDimensionCompatible(productText, i.sku_text)) {
          matched = i;
          break;
        }
      }
    }

    // Priority 2: Match on category ONLY if dimension is compatible
    if (!matched) {
      for (const i of items) {
        const catLower = (i.category || '').toLowerCase();
        if (!catLower) continue;

        if (textLower.includes(catLower) || catLower.includes(textLower)) {
          if (isDimensionCompatible(productText, i.sku_text)) {
            matched = i;
            break;
          }
        }
      }
    }

    if (matched && Number(matched.price_per_mt) > 0) {
      return {
        price_per_mt: Number(matched.price_per_mt),
        matched_sku: matched.sku_text || matched.category,
      };
    }
    return null;
  } catch (err) {
    console.error('[PricingEngine] Rate sheet lookup error:', err.message);
    return null;
  }
}

/**
 * Calculates line item financial values.
 *
 * @param {object} item - Line item with quantity, rate, etc.
 * @returns {object} Normalized line item with exact calculated amount
 */
function calculateLineItem(item) {
  if (!item) return { quantity: 0, rate: 0, amount: 0 };
  const quantity = Number(item.quantity || item.quantity_mt || item.qty || 0) || 0;
  const rate = Number(item.rate || item.rate_per_mt || item.price_per_mt || item.unitPrice || 0) || 0;
  const amount = item.amount && Number(item.amount) > 0 
    ? Number(item.amount) 
    : Math.round(quantity * rate);

  return {
    ...item,
    quantity,
    rate,
    amount,
  };
}

/**
 * Calculates array of line items.
 *
 * @param {Array} lineItems - Array of raw line items
 * @returns {Array} Array of normalized line items with calculated amounts
 */
function calculateLineItems(lineItems) {
  if (!Array.isArray(lineItems)) return [];
  return lineItems.map(calculateLineItem);
}

/**
 * Calculates subtotal (sum of base amounts) across all line items.
 *
 * @param {Array} lineItems - Array of line items
 * @returns {number} Subtotal in INR (excl. GST)
 */
function calculateSubtotal(lineItems) {
  if (!Array.isArray(lineItems) || lineItems.length === 0) return 0;
  return lineItems.reduce((sum, item) => {
    const calculated = calculateLineItem(item);
    return sum + calculated.amount;
  }, 0);
}

/**
 * Strict Forward GST calculation: always forward on line amount — never reverse calculated.
 *
 * @param {number} baseAmount - Base material amount (excl. GST)
 * @param {number} [gstRate=0.18] - Applicable GST rate (default: 0.18 / 18%)
 * @returns {number} GST amount in INR rounded to nearest integer
 */
function calculateGst(baseAmount, gstRate = DEFAULT_GST_RATE) {
  const base = Number(baseAmount) || 0;
  if (base <= 0) return 0;
  return Math.round(base * gstRate);
}

/**
 * Calculates Grand Total (Subtotal + Forward GST).
 *
 * @param {number} baseAmount - Base material amount (excl. GST)
 * @param {number} [gstRate=0.18] - Applicable GST rate
 * @returns {number} Grand total in INR (incl. GST)
 */
function calculateGrandTotal(baseAmount, gstRate = DEFAULT_GST_RATE) {
  const base = Number(baseAmount) || 0;
  const gst = calculateGst(base, gstRate);
  return base + gst;
}

/**
 * Computes a full pricing summary breakdown.
 *
 * @param {Array|object} input - Line items array or object with lineItems / basic_amount
 * @param {object} [options] - Options (gstRate, defaultRate)
 * @returns {object} Complete pricing summary
 */
function calculatePricingSummary(input, options = {}) {
  const gstRate = options.gstRate || DEFAULT_GST_RATE;

  let rawItems = [];
  let explicitBase = 0;

  if (Array.isArray(input)) {
    rawItems = input;
  } else if (input && typeof input === 'object') {
    rawItems = input.line_items || input.lineItems || [];
    explicitBase = Number(input.basic_amount || input.subtotal || input.baseAmount || 0);
  }

  const processedItems = calculateLineItems(rawItems);
  const itemsSubtotal = calculateSubtotal(processedItems);
  const totalQuantity = processedItems.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);

  const subtotal = explicitBase > 0 ? explicitBase : itemsSubtotal;
  const gstAmount = calculateGst(subtotal, gstRate);
  const grandTotal = subtotal + gstAmount;

  return {
    lineItems: processedItems,
    totalQuantity,
    subtotal,
    gstAmount,
    grandTotal,
    gstRate,
  };
}

module.exports = {
  DEFAULT_GST_RATE,
  extractDimensions,
  isDimensionCompatible,
  lookupRateSheetPrice,
  calculateLineItem,
  calculateLineItems,
  calculateSubtotal,
  calculateGst,
  calculateGrandTotal,
  calculatePricingSummary,
};
