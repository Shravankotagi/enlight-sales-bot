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
 * Normalizes unit string to standard casing and symbol.
 */
function normalizeUnit(rawUnit) {
  if (!rawUnit || typeof rawUnit !== 'string') return 'MT';
  const u = rawUnit.trim().toUpperCase();
  if (u === 'KG' || u === 'KGS' || u === 'KILOGRAM' || u === 'KILOGRAMS') return 'KG';
  if (u === 'MT' || u === 'TON' || u === 'TONS' || u === 'TONNE' || u === 'TONNES' || u === 'METRIC TON' || u === 'METRIC TONS') return 'MT';
  if (u === 'PCS' || u === 'PIECE' || u === 'PIECES') return 'Pcs';
  if (u === 'SHEET' || u === 'SHEETS') return 'Sheets';
  if (u === 'PLATE' || u === 'PLATES') return 'Plates';
  if (u === 'COIL' || u === 'COILS') return 'Coils';
  if (u === 'BAR' || u === 'BARS') return 'Bars';
  if (u === 'NOS' || u === 'NUMBER' || u === 'NUMBERS') return 'Nos';
  if (u === 'BUNDLE' || u === 'BUNDLES') return 'Bundles';
  if (u === 'PIPE' || u === 'PIPES' || u === 'TUBE' || u === 'TUBES') return 'Pipes';
  return rawUnit.trim();
}

/**
 * Converts a quantity to its Metric Ton (MT) equivalent.
 */
function convertToMt(quantity, rawUnit) {
  const norm = normalizeUnit(rawUnit);
  if (norm === 'KG') return quantity / 1000;
  if (norm === 'MT') return quantity;
  return quantity;
}

/**
 * Calculates line item financial values.
 *
 * @param {object} item - Line item with quantity, rate, etc.
 * @returns {object} Normalized line item with exact calculated amount
 */
function calculateLineItem(item) {
  if (!item) return { quantity: 0, rate: 0, amount: 0, unit: 'MT' };
  const quantity = Number(item.quantity || item.quantity_mt || item.qty || 0) || 0;
  const rate = Number(item.rate || item.rate_per_mt || item.price_per_mt || item.unitPrice || 0) || 0;
  const unit = normalizeUnit(item.unit);

  let amount = item.amount && Number(item.amount) > 0 ? Number(item.amount) : 0;
  if (!amount && quantity > 0 && rate > 0) {
    if (unit === 'KG' && rate > 1000) {
      amount = Math.round((quantity / 1000) * rate);
    } else {
      amount = Math.round(quantity * rate);
    }
  }

  return {
    ...item,
    quantity,
    rate,
    amount,
    unit,
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

  const distinctUnits = Array.from(new Set(processedItems.map(i => i.unit || 'MT')));
  const isUniformUnit = distinctUnits.length <= 1;
  const primaryUnit = isUniformUnit ? (distinctUnits[0] || 'MT') : 'MT';

  let totalQuantity = 0;
  let totalQuantityMt = 0;
  let formattedQuantity = '';

  if (primaryUnit === 'KG' && isUniformUnit) {
    totalQuantity = processedItems.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
    totalQuantityMt = totalQuantity / 1000;
    if (totalQuantityMt >= 1) {
      formattedQuantity = `${totalQuantityMt.toLocaleString('en-IN')} MT (${totalQuantity.toLocaleString('en-IN')} KG)`;
    } else {
      formattedQuantity = `${totalQuantity.toLocaleString('en-IN')} KG`;
    }
  } else if (primaryUnit === 'MT' && isUniformUnit) {
    totalQuantity = processedItems.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
    totalQuantityMt = totalQuantity;
    formattedQuantity = `${totalQuantity.toLocaleString('en-IN')} MT`;
  } else {
    totalQuantityMt = processedItems.reduce((sum, item) => sum + convertToMt(Number(item.quantity) || 0, item.unit), 0);
    totalQuantity = isUniformUnit
      ? processedItems.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0)
      : totalQuantityMt;
    formattedQuantity = isUniformUnit
      ? `${totalQuantity.toLocaleString('en-IN')} ${primaryUnit}`
      : `${totalQuantityMt.toLocaleString('en-IN')} MT`;
  }

  // Line-item derived subtotal always takes strict priority when line items exist
  let subtotal = 0;
  if (itemsSubtotal > 0) {
    subtotal = itemsSubtotal;
  } else if (explicitBase > 0) {
    subtotal = explicitBase;
  } else if (input && typeof input === 'object') {
    const rawTotal = Number(input.total_amount || input.totalAmount || input.grand_total || input.grandTotal || 0);
    if (rawTotal > 0) {
      subtotal = rawTotal;
    }
  }

  // Handle explicit GST components from PO documents (SGST + CGST / IGST)
  let explicitGst = 0;
  if (input && typeof input === 'object') {
    const sgst = Number(input.sgst_amount || 0);
    const cgst = Number(input.cgst_amount || 0);
    const igst = Number(input.igst_amount || 0);
    const statedGst = Number(input.gst_amount ?? input.gstAmount ?? 0);
    explicitGst = statedGst > 0 ? statedGst : (sgst + cgst + igst);
  }

  const calculatedGst = calculateGst(subtotal, gstRate);
  const gstAmount = explicitGst > 0 && Math.abs(explicitGst - calculatedGst) <= 5 ? explicitGst : calculatedGst;
  const grandTotal = subtotal + gstAmount;

  // Cross-verification against stated PO Grand Total
  let calculationWarning = null;
  if (input && typeof input === 'object') {
    const statedGrand = Number(input.grand_total || input.grandTotal || 0);
    if (statedGrand > 0 && Math.abs(statedGrand - grandTotal) > 2) {
      calculationWarning = `Calculated total (₹${grandTotal.toLocaleString('en-IN')}) does not match PO document total (₹${statedGrand.toLocaleString('en-IN')}) — please review`;
    }
  }

  return {
    lineItems: processedItems,
    totalQuantity,
    totalQuantityMt,
    unit: primaryUnit,
    formattedQuantity,
    subtotal,
    gstAmount,
    grandTotal,
    gstRate,
    calculationWarning,
  };
}

module.exports = {
  DEFAULT_GST_RATE,
  normalizeUnit,
  convertToMt,
  extractDimensions,
  isDimensionCompatible,
  calculateLineItem,
  calculateLineItems,
  calculateSubtotal,
  calculateGst,
  calculateGrandTotal,
  calculatePricingSummary,
};
