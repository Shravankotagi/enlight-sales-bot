/**
 * Dedicated Centralized Pricing Engine for Enlight Sales OS (Bot)
 * 
 * Responsibilities:
 * - Rate lookup from active/latest rate sheets with dimension compatibility check
 * - Line item amount calculation (quantity * rate)
 * - Strict Forward GST calculation (baseAmount * 0.18) - never reverse calculated
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
  if (!rawUnit || typeof rawUnit !== 'string') return 'KG';
  const u = rawUnit.trim().toUpperCase();
  if (['KG', 'KGS', 'KILOGRAM', 'KILOGRAMS'].includes(u)) return 'KG';
  if (['MT', 'TON', 'TONS', 'TONNE', 'TONNES', 'METRIC TON', 'METRIC TONS', 'MTS', 'T'].includes(u)) return 'MT';
  if (['NOS', 'NO', 'NO.', 'NUMBER', 'NUMBERS', 'PCS', 'PC', 'PIECE', 'PIECES', 'SHEET', 'SHEETS', 'PLATE', 'PLATES', 'COIL', 'COILS', 'BUNDLE', 'BUNDLES', 'BAR', 'BARS', 'PIPE', 'PIPES', 'TUBE', 'TUBES'].includes(u)) return 'Nos';
  return rawUnit.trim();
}

/**
 * Converts any individual line item to Metric Tonnes (MT) using exact steel dimension formulas.
 * Density: 7.85 g/cm3.
 */
function convertLineItemToMt(item) {
  if (!item) return 0;
  const qty = Number(item.quantity ?? item.quantity_mt ?? item.quantityTons ?? item.qty ?? 0);
  const rawUnit = (item.unit || 'KG').trim();
  const normUnit = normalizeUnit(rawUnit);

  if (!qty || qty <= 0) return 0;

  const sizeText = [
    item.dimensions,
    item.spec,
    item.specification,
    item.sku_text,
    item.description,
    item.product,
    item.product_name,
    item.name,
  ]
    .filter(Boolean)
    .join(' ');
  const hasExplicitSize = /\d/.test(sizeText);
  const canUseStoredWeight = normUnit === 'MT' || normUnit === 'KG' || hasExplicitSize;

  // Priority 0: Stored normalized weight from database or Gemini unit converter
  if (
    canUseStoredWeight &&
    item.weight_mt !== undefined &&
    item.weight_mt !== null &&
    !isNaN(Number(item.weight_mt)) &&
    Number(item.weight_mt) > 0
  ) {
    return Number(item.weight_mt);
  }
  if (
    item.converted_mt !== undefined &&
    item.converted_mt !== null &&
    !isNaN(Number(item.converted_mt)) &&
    Number(item.converted_mt) > 0
  ) {
    return Number(item.converted_mt);
  }

  // 1. MT: No conversion needed
  if (normUnit === 'MT') return qty;

  // 2. KG: MT = KG / 1000
  if (normUnit === 'KG') return qty / 1000;

  const combinedText = [
    item.sku_text || item.product_name || item.description || item.name || '',
    item.dimensions || item.specs || item.spec || item.specification || '',
    item.description || '',
  ].join(' ').toLowerCase();

  // 3a. TMT Rebars: (Dia^2 / 162) * Len * Qty / 1000
  if (combinedText.includes('tmt') || combinedText.includes('rebar')) {
    const diaMatch =
      combinedText.match(/(\d+(?:\.\d+)?)\s*(?:mm|dia|diameter)\b/) ||
      combinedText.match(/\btmt\s*[-/]?\s*(\d{1,2})\b/) ||
      combinedText.match(/\b(\d{1,2})\s*[-/]?\s*tmt\b/);
    const dia = diaMatch ? parseFloat(diaMatch[1]) : 12; // Standard 12mm TMT fallback
    const lenMatch = combinedText.match(/(\d+(?:\.\d+)?)\s*(?:m|meter|mtr)\b/);
    const len = lenMatch ? parseFloat(lenMatch[1]) : 12; // Standard 12m TMT
    return Math.round(((((dia * dia) / 162) * len * qty) / 1000) * 1000) / 1000;
  }

  // 3b. Round Bars: (pi/4) * (Dia_cm^2) * Len_cm * 7.85 / 1000 * Qty / 1000
  if (combinedText.includes('round bar') || combinedText.includes('bright bar') || (combinedText.includes('round') && !combinedText.includes('pipe') && !combinedText.includes('tube'))) {
    const diaMatch = combinedText.match(/(\d+(?:\.\d+)?)\s*(?:mm|dia|diameter)\b/);
    const dia = diaMatch ? parseFloat(diaMatch[1]) : 16; // Standard 16mm Round Bar fallback
    const lenMatch = combinedText.match(/(\d+(?:\.\d+)?)\s*(?:m|meter|mtr)\b/);
    const len = lenMatch ? parseFloat(lenMatch[1]) : 6; // Standard 6m Round Bar
    const diaCm = dia / 10;
    const lenCm = len * 100;
    const wtKg = (Math.PI / 4) * (diaCm * diaCm) * lenCm * (7.85 / 1000) * qty;
    return Math.round((wtKg / 1000) * 1000) / 1000;
  }

  // 3c. Flat Bars & GI Earthing Strip: Width(mm) * Thickness(mm) * 0.00785 * Length(m) * Qty / 1000
  if (
    combinedText.includes('flat bar') ||
    combinedText.includes('ms flat') ||
    combinedText.includes('earthing strip') ||
    (combinedText.includes('flat') && !combinedText.includes('sheet') && !combinedText.includes('plate'))
  ) {
    const flatMatch = combinedText.match(
      /(\d+(?:\.\d+)?)\s*(?:mm)?\s*[xX*×]\s*(\d+(?:\.\d+)?)/
    );
    let widthMm = 50;
    let thkMm = 6;
    if (flatMatch) {
      const v1 = parseFloat(flatMatch[1]);
      const v2 = parseFloat(flatMatch[2]);
      widthMm = Math.max(v1, v2);
      thkMm = Math.min(v1, v2);
    }
    const lenMatch = combinedText.match(/(\d+(?:\.\d+)?)\s*(?:m|meter|mtr)\b/);
    const lenM = lenMatch ? parseFloat(lenMatch[1]) : 6;
    const galvanizeFactor = combinedText.includes('earthing') || combinedText.includes('gi') ? 1.05 : 1.0;
    const wtKg = widthMm * thkMm * 0.00785 * lenM * galvanizeFactor * qty;
    return Math.round((wtKg / 1000) * 1000) / 1000;
  }

  // 3d. Square Bars: Side(mm)^2 * 0.00785 * Length(m) * Qty / 1000
  if (
    combinedText.includes('square bar') ||
    (combinedText.includes('square') && combinedText.includes('bar'))
  ) {
    const sqMatch = combinedText.match(/(\d+(?:\.\d+)?)\s*(?:mm)?/);
    const sideMm = sqMatch ? parseFloat(sqMatch[1]) : 12; // Standard 12mm square bar fallback
    const lenMatch = combinedText.match(/(\d+(?:\.\d+)?)\s*(?:m|meter|mtr)\b/);
    const lenM = lenMatch ? parseFloat(lenMatch[1]) : 6;
    const wtKg = sideMm * sideMm * 0.00785 * lenM * qty;
    return Math.round((wtKg / 1000) * 1000) / 1000;
  }

  // 3e. Angles: (A + B - t) * t * 0.00785 * Len * Qty / 1000
  if (combinedText.includes('angle') || combinedText.includes('isa')) {
    const angle3Match = combinedText.match(
      /(\d+(?:\.\d+)?)\s*(?:mm)?\s*[xX*×]\s*(\d+(?:\.\d+)?)\s*(?:mm)?\s*[xX*×]\s*(\d+(?:\.\d+)?)/
    );
    const angle2Match = combinedText.match(
      /(\d+(?:\.\d+)?)\s*(?:mm)?\s*[xX*×]\s*(\d+(?:\.\d+)?)/
    );
    let a = 50;
    let b = 50;
    let t = 5;
    if (angle3Match) {
      a = parseFloat(angle3Match[1]);
      b = parseFloat(angle3Match[2]);
      t = parseFloat(angle3Match[3]);
    } else if (angle2Match) {
      const v1 = parseFloat(angle2Match[1]);
      const v2 = parseFloat(angle2Match[2]);
      a = Math.max(v1, v2);
      b = a;
      t = Math.min(v1, v2);
    }
    const lenMatch = combinedText.match(/(\d+(?:\.\d+)?)\s*(?:m|meter|mtr)\b/);
    const len = lenMatch ? parseFloat(lenMatch[1]) : 6;
    return Math.round((((a + b - t) * t * 0.00785 * len * qty) / 1000) * 1000) / 1000;
  }

  // 3f. Channels (ISMC):
  if (combinedText.includes('channel') || combinedText.includes('ismc')) {
    const sizeMatch =
      combinedText.match(/(?:ismc|channel)\s*(\d{2,3})/i) ||
      combinedText.match(/(\d{2,3})\s*(?:mm)?\s*channel/i);
    const size = sizeMatch ? parseInt(sizeMatch[1], 10) : 100;
    const CHANNEL_WT = {
      75: 7.14,
      100: 9.56,
      125: 13.1,
      150: 16.8,
      175: 19.6,
      200: 22.3,
      250: 30.4,
    };
    const wtPerMeter = CHANNEL_WT[size] || size * 0.0956;
    const lenMatch = combinedText.match(/(\d+(?:\.\d+)?)\s*(?:m|meter|mtr)\b/);
    const len = lenMatch ? parseFloat(lenMatch[1]) : 6;
    const wtKg = wtPerMeter * len * qty;
    return Math.round((wtKg / 1000) * 1000) / 1000;
  }

  // 3g. Beams (ISMB / Joists):
  if (combinedText.includes('beam') || combinedText.includes('ismb') || combinedText.includes('joist')) {
    const sizeMatch =
      combinedText.match(/(?:ismb|beam)\s*(\d{2,3})/i) ||
      combinedText.match(/(\d{2,3})\s*(?:mm)?\s*beam/i);
    const size = sizeMatch ? parseInt(sizeMatch[1], 10) : 150;
    const BEAM_WT = {
      100: 11.5,
      125: 13.3,
      150: 15.0,
      175: 19.3,
      200: 25.4,
      250: 37.3,
      300: 44.2,
    };
    const wtPerMeter = BEAM_WT[size] || size * 0.1;
    const lenMatch = combinedText.match(/(\d+(?:\.\d+)?)\s*(?:m|meter|mtr)\b/);
    const len = lenMatch ? parseFloat(lenMatch[1]) : 6;
    const wtKg = wtPerMeter * len * qty;
    return Math.round((wtKg / 1000) * 1000) / 1000;
  }

  // 3h. MS Pipes & Tubes (Round Pipe, Square Pipe, Rectangular Tube):
  const isPipe =
    combinedText.includes('pipe') ||
    combinedText.includes('tube') ||
    combinedText.includes('shs') ||
    combinedText.includes('rhs') ||
    combinedText.includes('square');
  if (isPipe) {
    const isSquareOrRect =
      combinedText.includes('square') ||
      combinedText.includes('rect') ||
      combinedText.includes('shs') ||
      combinedText.includes('rhs');
    const lenMatch = combinedText.match(/(\d+(?:\.\d+)?)\s*(?:m|meter|mtr)\b/);
    const len = lenMatch ? parseFloat(lenMatch[1]) : 6;
    const crossSectionText = combinedText.replace(
      /[xX*×]\s*\d+(?:\.\d+)?\s*(?:m|meter|mtr)\b/g,
      ''
    );
    const dim3Match = crossSectionText.match(
      /(\d+(?:\.\d+)?)\s*(?:mm)?\s*[xX*×]\s*(\d+(?:\.\d+)?)\s*(?:mm)?\s*[xX*×]\s*(\d+(?:\.\d+)?)/
    );
    const dim2Match = crossSectionText.match(
      /(\d+(?:\.\d+)?)\s*(?:mm)?\s*[xX*×]\s*(\d+(?:\.\d+)?)/
    );

    if (isSquareOrRect) {
      if (dim3Match) {
        const w = parseFloat(dim3Match[1]);
        const h = parseFloat(dim3Match[2]);
        const t = parseFloat(dim3Match[3]);
        const wtPerMeter = (w + h - 2 * t) * t * 0.0157;
        const wtKg = wtPerMeter * len * qty;
        return Math.round(((wtKg / 1000) * 1000)) / 1000;
      } else if (dim2Match) {
        const side = parseFloat(dim2Match[1]);
        const t = parseFloat(dim2Match[2]);
        const wtPerMeter = (side - t) * t * 0.0314;
        const wtKg = wtPerMeter * len * qty;
        return Math.round(((wtKg / 1000) * 1000)) / 1000;
      } else {
        // Square/Rect tube fallback: 50x50x2.5mm, 6m
        const wtPerMeter = (50 - 2.5) * 2.5 * 0.0314;
        const wtKg = wtPerMeter * len * qty;
        return Math.round(((wtKg / 1000) * 1000)) / 1000;
      }
    } else {
      // Round pipe: (OD - t) * t * 0.02466 * len * qty / 1000
      let od = 50;
      let t = 2.5;
      if (dim2Match) {
        od = Math.max(parseFloat(dim2Match[1]), parseFloat(dim2Match[2]));
        t = Math.min(parseFloat(dim2Match[1]), parseFloat(dim2Match[2]));
      }
      const wtKg = (od - t) * t * 0.02466 * len * qty;
      return Math.round(((wtKg / 1000) * 1000)) / 1000;
    }
  }

  // 3i. Cable Trays (Perforated & Ladder): Girth(m) * Thk(mm) * 7.85 * Length(m) * Qty / 1000
  if (combinedText.includes('cable tray')) {
    let widthMm = 300;
    const wMatch = combinedText.match(/(\d+(?:\.\d+)?)\s*(?:mm\s*width|mm\s*w\b|\bwidth\s*(\d+)|w\s*(\d+))/);
    if (wMatch) {
      widthMm = parseFloat(wMatch[1] || wMatch[2] || wMatch[3]);
    } else {
      const dimMatch = combinedText.match(/(\d+(?:\.\d+)?)\s*(?:mm)?\s*[xX*×]\s*(\d+(?:\.\d+)?)/);
      if (dimMatch) {
        const v1 = parseFloat(dimMatch[1]);
        const v2 = parseFloat(dimMatch[2]);
        widthMm = Math.max(v1, v2);
      }
    }
    const collarMm = 50; // standard 50mm collar
    const girthM = (widthMm + 2 * collarMm) / 1000;
    const lenM = 2.5; // standard 2.5m section
    const thkMm = 1.6; // standard 1.6mm sheet
    const isLadder = combinedText.includes('ladder');
    const factor = isLadder ? 0.55 : 0.88;
    const wtPerPieceKg = girthM * lenM * thkMm * 7.85 * factor;
    return Math.round(((wtPerPieceKg * qty) / 1000) * 1000) / 1000;
  }

  // 3j. Slotted Angle:
  if (combinedText.includes('slotted angle')) {
    const wtPerPieceKg = 3.5; // standard 40x40x2mm 2.5m piece
    return Math.round(((wtPerPieceKg * qty) / 1000) * 1000) / 1000;
  }

  // 3k. Solar Mounting Structure / Purlins:
  if (
    combinedText.includes('solar') ||
    combinedText.includes('purlin') ||
    combinedText.includes('mounting structure')
  ) {
    const wtPerPieceKg = 17.5; // Standard 3.2m C/Z purlin piece
    return Math.round(((wtPerPieceKg * qty) / 1000) * 1000) / 1000;
  }

  // 3l. Sheets / Plates / Coils: Length(m) * Width(m) * Thickness(mm) * 7.85 * Qty / 1000
  let thickness = null;
  const thkMatch = combinedText.match(/(\d+(?:\.\d+)?)\s*(?:mm\s*thk|mm\s*thickness|\bthk\b)/);
  if (thkMatch) {
    const candidate = parseFloat(thkMatch[1]);
    if (candidate <= 50) {
      thickness = candidate;
    }
  }

  let widthM = null;
  let lengthM = null;

  const dim3Match = combinedText.match(
    /(\d+(?:\.\d+)?)\s*(?:mm|m)?\s*[xX*×]\s*(\d+(?:\.\d+)?)\s*(?:mm|m)?\s*[xX*×]\s*(\d+(?:\.\d+)?)\s*(?:mm|m)?/
  );
  if (dim3Match) {
    const n1 = parseFloat(dim3Match[1]);
    const n2 = parseFloat(dim3Match[2]);
    const n3 = parseFloat(dim3Match[3]);
    const sorted = [n1, n2, n3].sort((a, b) => a - b);
    if (!thickness && sorted[0] <= 50) thickness = sorted[0];
    const w = sorted[1];
    const l = sorted[2];
    widthM = w > 20 ? w / 1000 : w;
    lengthM = l > 20 ? l / 1000 : l;
  } else {
    const dim2Match = combinedText.match(
      /(\d+(?:\.\d+)?)\s*(?:mm|m)?\s*[xX*×]\s*(\d+(?:\.\d+)?)\s*(?:mm|m)?/
    );
    if (dim2Match) {
      const d1 = parseFloat(dim2Match[1]);
      const d2 = parseFloat(dim2Match[2]);
      const w = Math.min(d1, d2);
      const l = Math.max(d1, d2);
      widthM = w > 20 ? w / 1000 : w;
      lengthM = l > 20 ? l / 1000 : l;
    }
  }

  const isSheetOrPlate =
    combinedText.includes('sheet') ||
    combinedText.includes('plate') ||
    combinedText.includes('chequered') ||
    combinedText.includes('checker') ||
    combinedText.includes('cr ') ||
    combinedText.includes('hr ') ||
    combinedText.includes('hrpo') ||
    combinedText.includes('galvalume') ||
    combinedText.includes('gp ') ||
    combinedText.includes('gi ') ||
    normUnit === 'Sheets' ||
    normUnit === 'Plates';

  if (isSheetOrPlate && thickness && widthM && lengthM) {
    const isChequered =
      combinedText.includes('chequered') || combinedText.includes('checker');
    const wtKgPerPc = isChequered
      ? lengthM * widthM * (thickness * 7.85 + 2.1)
      : lengthM * widthM * thickness * 7.85;
    return Math.round(((wtKgPerPc * qty) / 1000) * 1000) / 1000;
  }

  // If the unit is discrete and unconvertible, do NOT return qty as MT
  if (['Nos', 'Pcs', 'Pieces', 'Units', 'Bundles', 'Sheets', 'Plates', 'Coils'].includes(normUnit)) {
    return null;
  }

  return qty;
}

/**
 * Converts a quantity to its Metric Ton (MT) equivalent.
 */
function convertToMt(quantity, rawUnit) {
  return convertLineItemToMt({ quantity, unit: rawUnit });
}

const SELLER_GST_CONFIG = {
  companyName: 'Enlight Metals Private Limited',
  gstin: '27AAICE5263E1ZN',
  stateName: 'Maharashtra',
  stateCode: '27',
  placeOfSupplyLabel: 'Maharashtra (27)',
  gstRate: 18,
};

const INDIAN_GST_STATES = [
  { code: '01', name: 'Jammu and Kashmir', keywords: ['jammu and kashmir', 'jammu & kashmir', 'j&k', 'jammu', 'srinagar', 'kathua', 'samba', 'bari brahmana', 'udhampur', 'anantnag', 'baramulla', 'pulwama'] },
  { code: '02', name: 'Himachal Pradesh', keywords: ['himachal pradesh', 'himachal', 'baddi', 'parwanoo', 'nalagarh', 'barotiwala', 'kala amb', 'paonta sahib', 'shimla', 'solan', 'una', 'mandi', 'kullu', 'dharamshala', 'kangra'] },
  { code: '03', name: 'Punjab', keywords: ['punjab', 'ludhiana', 'amritsar', 'jalandhar', 'patiala', 'bathinda', 'mohali', 'sas nagar', 'mandi gobindgarh', 'gobindgarh', 'khanna', 'phagwara', 'hoshiarpur', 'batala', 'pathankot', 'moga', 'rajpura', 'zirakpur', 'dera bassi', 'kapurthala', 'sangrur', 'barnala', 'firozpur', 'ferozepur'] },
  { code: '04', name: 'Chandigarh', keywords: ['chandigarh'] },
  { code: '05', name: 'Uttarakhand', keywords: ['uttarakhand', 'uttaranchal', 'dehradun', 'haridwar', 'roorkee', 'rudrapur', 'pantnagar', 'haldwani', 'kashipur', 'sitarganj', 'kichha', 'kotdwar', 'rishikesh', 'selaqui', 'bhagwanpur', 'nainital'] },
  { code: '06', name: 'Haryana', keywords: ['haryana', 'gurugram', 'gurgaon', 'faridabad', 'manesar', 'panipat', 'sonipat', 'rohtak', 'hisar', 'karnal', 'ambala', 'yamunanagar', 'bhiwani', 'rewari', 'bawal', 'dharuhera', 'bahadurgarh', 'palwal', 'ballabhgarh', 'kundli', 'jhajjar', 'jind', 'kaithal', 'kurukshetra', 'sirsa', 'panchkula'] },
  { code: '07', name: 'Delhi', keywords: ['new delhi', 'delhi', 'ncr delhi', 'okhla', 'bawana', 'naraina', 'mayapuri', 'wazirpur', 'patparganj', 'narela', 'mundka', 'dwarka', 'rohini'] },
  { code: '08', name: 'Rajasthan', keywords: ['rajasthan', 'jaipur', 'jodhpur', 'udaipur', 'kota', 'bhiwadi', 'neemrana', 'alwar', 'ajmer', 'bikaner', 'bhilwara', 'sikar', 'pali', 'sri ganganagar', 'bharatpur', 'chittorgarh', 'kishangarh', 'beawar', 'hanumangarh', 'jhunjhunu', 'churu', 'nagaur', 'barmer', 'jaisalmer', 'khushkhera', 'tapukara', 'sitapura'] },
  { code: '09', name: 'Uttar Pradesh', keywords: ['uttar pradesh', 'noida', 'greater noida', 'ghaziabad', 'kanpur', 'lucknow', 'agra', 'varanasi', 'meerut', 'prayagraj', 'allahabad', 'bareilly', 'aligarh', 'moradabad', 'saharanpur', 'gorakhpur', 'firozabad', 'jhansi', 'muzaffarnagar', 'mathura', 'dadri', 'sikandrabad', 'bulandshahr', 'hapur', 'modinagar', 'sahibabad', 'unnao', 'renukoot', 'sonbhadra', 'mirzapur'] },
  { code: '10', name: 'Bihar', keywords: ['bihar', 'patna', 'gaya', 'bhagalpur', 'muzaffarpur', 'purnia', 'darbhanga', 'bihar sharif', 'arrah', 'begusarai', 'katihar', 'munger', 'chhapra', 'danapur', 'bettiah', 'saharsa', 'hajipur', 'sasaram', 'siwan', 'motihari', 'bihta', 'barauni'] },
  { code: '11', name: 'Sikkim', keywords: ['sikkim', 'gangtok', 'rangpo', 'jorethang', 'namchi'] },
  { code: '12', name: 'Arunachal Pradesh', keywords: ['arunachal pradesh', 'arunachal', 'itanagar', 'naharlagun', 'tawang', 'pasighat'] },
  { code: '13', name: 'Nagaland', keywords: ['nagaland', 'dimapur', 'kohima', 'mokokchung'] },
  { code: '14', name: 'Manipur', keywords: ['manipur', 'imphal', 'thoubal', 'churachandpur'] },
  { code: '15', name: 'Mizoram', keywords: ['mizoram', 'aizawl', 'lunglei'] },
  { code: '16', name: 'Tripura', keywords: ['tripura', 'agartala', 'udaipur tripura', 'dharmanagar'] },
  { code: '17', name: 'Meghalaya', keywords: ['meghalaya', 'shillong', 'byrnihat', 'tura', 'jowai'] },
  { code: '18', name: 'Assam', keywords: ['assam', 'guwahati', 'dibrugarh', 'silchar', 'jorhat', 'nagaon', 'tinsukia', 'tezpur', 'bongaigaon', 'duliajan', 'digboi', 'sibsagar', 'sivasagar', 'golaghat', 'dispur', 'amingaon'] },
  { code: '19', name: 'West Bengal', keywords: ['west bengal', 'bengal', 'kolkata', 'calcutta', 'howrah', 'durgapur', 'asansol', 'siliguri', 'haldia', 'kharagpur', 'bardhaman', 'burdwan', 'malda', 'dankuni', 'hooghly', 'serampore', 'barrackpore', 'barasat', 'kalyani', 'bankura', 'purulia', 'medinipur', 'midnapore', 'jalpaiguri', 'uluberia', 'salt lake', 'rajarhat'] },
  { code: '20', name: 'Jharkhand', keywords: ['jharkhand', 'jamshedpur', 'ranchi', 'dhanbad', 'bokaro', 'adityapur', 'hazaribagh', 'deoghar', 'giridih', 'ramgarh', 'medininagar', 'daltonganj', 'chaibasa', 'gamharia', 'seraikela', 'dumka', 'koderma', 'patratu', 'sindri', 'jharia'] },
  { code: '21', name: 'Odisha', keywords: ['odisha', 'orissa', 'bhubaneswar', 'cuttack', 'rourkela', 'sambalpur', 'berhampur', 'brahmapur', 'angul', 'jharsuguda', 'balasore', 'baleswar', 'bhadrak', 'baripada', 'puri', 'jajpur', 'kalinganagar', 'paradeep', 'paradip', 'talcher', 'barbil', 'joda', 'keonjhar', 'kendujhar', 'sundargarh', 'rajgangpur', 'bargarh', 'rayagada', 'dhenkanal'] },
  { code: '22', name: 'Chhattisgarh', keywords: ['chhattisgarh', 'chhatisgarh', 'raipur', 'bhilai', 'durg', 'bilaspur', 'korba', 'raigarh', 'jagdalpur', 'ambikapur', 'rajnandgaon', 'dhamtari', 'mahasamund', 'champa', 'janjgir', 'bhatapara', 'tilda', 'siltara', 'urla', 'kumhari'] },
  { code: '23', name: 'Madhya Pradesh', keywords: ['madhya pradesh', 'indore', 'bhopal', 'pithampur', 'jabalpur', 'gwalior', 'ujjain', 'dewas', 'sagar', 'satna', 'ratlam', 'rewa', 'katni', 'singrauli', 'burhanpur', 'khandwa', 'bhind', 'chhindwara', 'guna', 'shivpuri', 'vidisha', 'chhatarpur', 'damoh', 'mandsaur', 'khargone', 'neemuch', 'sehore', 'mandideep', 'malanpur', 'banmore', 'hoshangabad', 'narmadapuram', 'itarsi', 'betul', 'morena', 'dhar'] },
  { code: '24', name: 'Gujarat', keywords: ['gujarat', 'gujrat', 'ahmedabad', 'surat', 'vadodara', 'baroda', 'rajkot', 'vapi', 'ankleshwar', 'bharuch', 'valsad', 'gandhinagar', 'sanand', 'halol', 'kalol', 'mehsana', 'morbi', 'jamnagar', 'bhavnagar', 'junagadh', 'gandhidham', 'mundra', 'kutch', 'bhuj', 'anand', 'nadiad', 'navsari', 'dahej', 'hazira', 'changodar', 'vatva', 'naroda', 'odhav', 'kathwada', 'chatral', 'kadi', 'himatnagar', 'palanpur', 'patan', 'surendranagar', 'amreli', 'porbandar', 'godhra', 'dahod'] },
  { code: '26', name: 'Dadra and Nagar Haveli and Daman and Diu', keywords: ['dadra and nagar haveli', 'daman and diu', 'silvassa', 'daman', 'diu', 'dadra'] },
  { code: '27', name: 'Maharashtra', keywords: ['maharashtra', 'pune', 'mumbai', 'navi mumbai', 'thane', 'chakan', 'bhosari', 'pimpri', 'chinchwad', 'talawade', 'ranjangaon', 'shirwal', 'satara', 'kolhapur', 'sangli', 'solapur', 'nashik', 'nagpur', 'aurangabad', 'chhatrapati sambhajinagar', 'sambhajinagar', 'jalna', 'ahmednagar', 'ahilyanagar', 'tarapur', 'palghar', 'vasai', 'virar', 'bhiwandi', 'kalyan', 'dombivli', 'ambarnath', 'badlapur', 'taloja', 'panvel', 'raigad', 'roha', 'mahad', 'ratnagiri', 'sindhudurg', 'wardha', 'amravati', 'akola', 'jalgaon', 'dhule', 'nandurbar', 'latur', 'nanded', 'osmanabad', 'dharashiv', 'beed', 'parbhani', 'hingoli', 'buldhana', 'washim', 'yavatmal', 'chandrapur', 'gadchiroli', 'gondia', 'bhandara', 'vasuli', 'khed', 'kurkumbh', 'jejuri', 'baramati', 'supa', 'waluj', 'shendra', 'chikalthana', 'butibori', 'hingna', 'kupwad', 'miraj', 'ichalkaranji', 'kagal', 'shiroli', 'ambad', 'satpur', 'sinnar', 'iglaspur', 'murbad', 'shahapur', 'wada', 'boisar', 'khopoli', 'patalganga', 'mahape', 'rabale', 'ttc industrial', 'turbhe', 'pawane', 'shirvane', 'nerul', 'vashi', 'belapur', 'kharghar', 'kalamboli', 'taloja midc', 'alibuag', 'pen'] },
  { code: '29', name: 'Karnataka', keywords: ['karnataka', 'bengaluru', 'bangalore', 'belagavi', 'belgaum', 'hubballi', 'hubli', 'dharwad', 'mysuru', 'mysore', 'mangaluru', 'mangalore', 'tumakuru', 'tumkur', 'peenya', 'bommasandra', 'jigani', 'bidadi', 'hoskote', 'dobbaspet', 'nelamangala', 'davanagere', 'ballari', 'bellary', 'hospet', 'hosapete', 'shivamogga', 'shimoga', 'kalaburagi', 'gulbarga', 'bidar', 'raichur', 'vijayapura', 'bijapur', 'bagalkot', 'gadag', 'haveri', 'udupi', 'chikkamagaluru', 'chikmagalur', 'hassan', 'mandya', 'kolar', 'chikkaballapur', 'ramanagara', 'chitradurga', 'koppal', 'yadgir'] },
  { code: '30', name: 'Goa', keywords: ['goa', 'panaji', 'panjim', 'margao', 'madgaon', 'vasco', 'mapusa', 'ponda', 'verna', 'kundaim', 'cuncolim', 'bicholim', 'mormugao'] },
  { code: '31', name: 'Lakshadweep', keywords: ['lakshadweep', 'kavaratti'] },
  { code: '32', name: 'Kerala', keywords: ['kerala', 'kochi', 'cochin', 'ernakulam', 'thiruvananthapuram', 'trivandrum', 'kozhikode', 'calicut', 'thrissur', 'trichur', 'kollam', 'palakkad', 'alappuzha', 'alleppey', 'kannur', 'kottayam', 'malappuram', 'kasaragod', 'pathanamthitta', 'idukki', 'wayanad', 'kanjikode', 'kalamassery', 'aluva', 'angamaly', 'perumbavoor'] },
  { code: '33', name: 'Tamil Nadu', keywords: ['tamil nadu', 'tamilnadu', 'chennai', 'madras', 'coimbatore', 'hosur', 'madurai', 'tiruchirappalli', 'trichy', 'salem', 'tiruppur', 'erode', 'vellore', 'thoothukudi', 'tuticorin', 'tirunelveli', 'ambattur', 'sriperumbudur', 'oragadam', 'chengalpattu', 'kanchipuram', 'thiruvallur', 'gumidipoondi', 'maraimalai', 'ranipet', 'ambur', 'krishnagiri', 'dharmapuri', 'namakkal', 'karur', 'dindigul', 'thanjavur', 'pudukkottai', 'sivakasi', 'virudhunagar', 'nagercoil', 'kanyakumari', 'cuddalore'] },
  { code: '34', name: 'Puducherry', keywords: ['puducherry', 'pondicherry', 'karaikal', 'mahe', 'yanam'] },
  { code: '35', name: 'Andaman and Nicobar Islands', keywords: ['andaman', 'nicobar', 'port blair'] },
  { code: '36', name: 'Telangana', keywords: ['telangana', 'hyderabad', 'secunderabad', 'cyberabad', 'medchal', 'patancheru', 'jeedimetla', 'balanagar', 'cherlapally', 'nacharam', 'uppal', 'shamshabad', 'kukatpally', 'sangareddy', 'zaheerabad', 'warangal', 'kazipet', 'karimnagar', 'nizamabad', 'khammam', 'ramagundam', 'mahbubnagar', 'nalgonda', 'suryapet', 'adilabad', 'mancherial', 'siddipet', 'medak', 'kothagudem'] },
  { code: '37', name: 'Andhra Pradesh', keywords: ['andhra pradesh', 'andhra', 'visakhapatnam', 'vizag', 'vijayawada', 'guntur', 'tirupati', 'nellore', 'sri city', 'sricity', 'kakinada', 'rajahmundry', 'eluru', 'ongole', 'kurnool', 'anantapur', 'kadapa', 'cuddapah', 'chittoor', 'vizianagaram', 'srikakulam', 'machilipatnam', 'bhimavaram', 'hindupur', 'nandyal', 'proddatur'] },
  { code: '38', name: 'Ladakh', keywords: ['ladakh', 'leh', 'kargil'] },
];

const GST_STATE_BY_CODE = (() => {
  const map = {};
  for (const s of INDIAN_GST_STATES) {
    map[s.code] = {
      stateName: s.name,
      stateCode: s.code,
      code: s.code,
      name: s.name,
      label: `${s.name} (${s.code})`,
    };
  }
  map['25'] = map['26'];
  map['28'] = map['37'];
  return map;
})();

function resolveStateFromGstin(gstin) {
  if (!gstin || typeof gstin !== 'string') return null;
  const cleaned = gstin.trim().toUpperCase().replace(/\s+/g, '');
  const codeMatch = cleaned.match(/^(\d{2})/);
  if (!codeMatch) return null;
  const code = codeMatch[1];
  return GST_STATE_BY_CODE[code] || null;
}

function resolveStateFromAddress(address) {
  if (!address || typeof address !== 'string') return null;
  const trimmed = address.trim();
  if (!trimmed) return null;

  const explicitCodeMatch = trimmed.match(/\((\d{2})\)/) || trimmed.match(/^(\d{2})$/);
  if (explicitCodeMatch && GST_STATE_BY_CODE[explicitCodeMatch[1]]) {
    return GST_STATE_BY_CODE[explicitCodeMatch[1]];
  }

  const gstinMatch = trimmed.toUpperCase().match(/\b(\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z])\b/);
  if (gstinMatch) {
    const fromGstin = resolveStateFromGstin(gstinMatch[1]);
    if (fromGstin) return fromGstin;
  }

  const lower = trimmed.toLowerCase();

  for (const s of INDIAN_GST_STATES) {
    const stateLower = s.name.toLowerCase();
    const stateRegex = new RegExp(`\\b${stateLower.replace(/\s+/g, '\\s+')}\\b`, 'i');
    if (stateRegex.test(lower)) {
      return GST_STATE_BY_CODE[s.code];
    }
  }

  for (const s of INDIAN_GST_STATES) {
    for (const kw of s.keywords) {
      const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
      const kwRegex = new RegExp(`\\b${escaped}\\b`, 'i');
      if (kwRegex.test(lower)) {
        return GST_STATE_BY_CODE[s.code];
      }
    }
  }

  const pinMatch = lower.match(/\b([1-8]\d{5})\b/);
  if (pinMatch) {
    const pin = pinMatch[1];
    const p2 = Number(pin.slice(0, 2));
    const p3 = Number(pin.slice(0, 3));
    if (p2 === 11) return GST_STATE_BY_CODE['07'];
    if (p2 === 12 || p2 === 13) return GST_STATE_BY_CODE['06'];
    if (p3 === 160) return GST_STATE_BY_CODE['04'];
    if (p2 >= 14 && p2 <= 16) return GST_STATE_BY_CODE['03'];
    if (p2 === 17) return GST_STATE_BY_CODE['02'];
    if (p3 === 194) return GST_STATE_BY_CODE['38'];
    if (p2 === 18 || p2 === 19) return GST_STATE_BY_CODE['01'];
    if ((p3 >= 246 && p3 <= 249) || (p3 >= 262 && p3 <= 263)) return GST_STATE_BY_CODE['05'];
    if (p2 >= 20 && p2 <= 28) return GST_STATE_BY_CODE['09'];
    if (p2 >= 30 && p2 <= 34) return GST_STATE_BY_CODE['08'];
    if (p3 === 396) return GST_STATE_BY_CODE['26'];
    if (p2 >= 36 && p2 <= 39) return GST_STATE_BY_CODE['24'];
    if (p3 === 403) return GST_STATE_BY_CODE['30'];
    if (p2 >= 40 && p2 <= 44) return GST_STATE_BY_CODE['27'];
    if (p2 >= 45 && p2 <= 48) return GST_STATE_BY_CODE['23'];
    if (p2 === 49) return GST_STATE_BY_CODE['22'];
    if (p2 === 50) return GST_STATE_BY_CODE['36'];
    if (p2 >= 51 && p2 <= 53) return GST_STATE_BY_CODE['37'];
    if (p2 >= 56 && p2 <= 59) return GST_STATE_BY_CODE['29'];
    if (p3 === 605) return GST_STATE_BY_CODE['34'];
    if (p2 >= 60 && p2 <= 64) return GST_STATE_BY_CODE['33'];
    if (p3 === 682) return GST_STATE_BY_CODE['31'];
    if (p2 >= 67 && p2 <= 69) return GST_STATE_BY_CODE['32'];
    if (p3 === 744) return GST_STATE_BY_CODE['35'];
    if (p3 === 737) return GST_STATE_BY_CODE['11'];
    if (p2 >= 70 && p2 <= 74) return GST_STATE_BY_CODE['19'];
    if (p2 >= 75 && p2 <= 77) return GST_STATE_BY_CODE['21'];
    if (p3 === 790 || p3 === 791 || p3 === 792) return GST_STATE_BY_CODE['12'];
    if (p3 === 793 || p3 === 794) return GST_STATE_BY_CODE['17'];
    if (p3 === 795) return GST_STATE_BY_CODE['14'];
    if (p3 === 796) return GST_STATE_BY_CODE['15'];
    if (p3 === 797 || p3 === 798) return GST_STATE_BY_CODE['13'];
    if (p3 === 799) return GST_STATE_BY_CODE['16'];
    if (p2 === 78) return GST_STATE_BY_CODE['18'];
    if (p3 >= 814 && p3 <= 835) return GST_STATE_BY_CODE['20'];
    if (p2 >= 80 && p2 <= 85) return GST_STATE_BY_CODE['10'];
  }

  return null;
}

function resolveCustomerState(input) {
  if (!input) return null;
  if (typeof input === 'string') {
    return resolveStateFromGstin(input) || resolveStateFromAddress(input);
  }
  const explicitState = input.customerState || input.state || input.placeOfSupply;
  if (explicitState) {
    const fromExplicit =
      resolveStateFromAddress(explicitState) ||
      resolveStateFromGstin(explicitState);
    if (fromExplicit) return fromExplicit;
  }
  const gstinVal = input.customerGstin || input.gstin;
  if (gstinVal) {
    const fromGstin = resolveStateFromGstin(gstinVal);
    if (fromGstin) return fromGstin;
  }
  const addrVal = input.customerAddress || input.address;
  if (addrVal) {
    const fromAddr = resolveStateFromAddress(addrVal);
    if (fromAddr) return fromAddr;
  }
  return null;
}

function resolvePlaceOfSupply(input) {
  let resolved = null;

  if (typeof input === 'string') {
    resolved = resolveStateFromAddress(input) || resolveStateFromGstin(input);
  } else if (input && typeof input === 'object') {
    const deliveryVal = input.deliveryAddress || input.deliveryLocation;
    if (deliveryVal) {
      resolved = resolveStateFromAddress(deliveryVal);
    }
    if (!resolved) {
      resolved = resolveCustomerState({
        customerState: input.customerState || input.state || input.placeOfSupply,
        customerGstin: input.customerGstin || input.gstin,
        customerAddress: input.customerAddress || input.address,
      });
    }
  }

  const finalState = resolved || {
    stateName: SELLER_GST_CONFIG.stateName,
    stateCode: SELLER_GST_CONFIG.stateCode,
    code: SELLER_GST_CONFIG.stateCode,
    name: SELLER_GST_CONFIG.stateName,
    label: SELLER_GST_CONFIG.placeOfSupplyLabel,
  };

  const isInterState = finalState.stateCode !== SELLER_GST_CONFIG.stateCode;
  return {
    ...finalState,
    isInterState,
    taxType: isInterState ? 'INTER_STATE' : 'INTRA_STATE',
  };
}

/**
 * Calculates line item financial values.
 *
 * @param {object} item - Line item with quantity, rate, etc.
 * @param {object} [options] - Optional { isInterState }
 * @returns {object} Normalized line item with exact calculated amount
 */
function calculateLineItem(item, options) {
  if (!item) return { quantity: 0, rate: 0, amount: 0, unit: 'MT', cgst_rate: 9, cgst_percent: 9, cgst_amount: 0, sgst_rate: 9, sgst_percent: 9, sgst_amount: 0, igst_rate: 0, igst_percent: 0, igst_amount: 0, is_inter_state: false, total_gst: 0, final_amount: 0, line_total: 0 };
  const opts = options && typeof options === 'object' ? options : undefined;
  const rawQuantity = Number(item.quantity ?? item.quantity_mt ?? item.qty ?? 0) || 0;
  let rawRate = Number(item.rate ?? item.rate_per_mt ?? item.price_per_mt ?? item.unitPrice ?? 0) || 0;
  const unit = normalizeUnit(item.unit);

  const conv = convertLineItemToMt(item);
  const effectiveMt = typeof conv === 'number' ? conv : (conv && conv.mt !== null && !isNaN(conv.mt) ? conv.mt : 0);

  let quantity = rawQuantity;
  let normalizedUnit = unit;
  let rate = rawRate;

  // 1. Convert to MT if convertible (KG or Nos with dimensions)
  if (effectiveMt > 0) {
    quantity = effectiveMt;
    normalizedUnit = 'MT';
  }

  // 2. Base Amount calculation
  let amount = 0;
  if (item.isManualAmount && item.amount !== undefined && Number(item.amount) > 0) {
    amount = Number(item.amount);
  } else if (item.amount && Number(item.amount) > 0) {
    amount = Number(item.amount);
  } else if (quantity > 0 && rate > 0) {
    amount = Math.round(quantity * rate * 100) / 100;
  }

  // If rate was missing/0, but amount and quantity exist, infer rate
  if (rate === 0 && quantity > 0 && amount > 0) {
    rate = Math.round((amount / quantity) * 100) / 100;
  }

  const isInterState =
    opts?.isInterState !== undefined
      ? Boolean(opts.isInterState)
      : Boolean(item.is_inter_state) ||
        ((Number(item.igst_rate) > 0 || Number(item.igst_amount) > 0) &&
          !Number(item.cgst_amount) &&
          !Number(item.sgst_amount));

  if (isInterState) {
    const igst_rate = Number(item.igst_rate !== undefined && Number(item.igst_rate) > 0 ? item.igst_rate : SELLER_GST_CONFIG.gstRate);
    const igst_amount = item.igst_amount !== undefined && Number(item.igst_amount) > 0 ? Number(item.igst_amount) : Math.round(amount * (igst_rate / 100) * 100) / 100;
    const total_gst = item.total_gst !== undefined && Number(item.total_gst) > 0 ? Number(item.total_gst) : igst_amount;
    const final_amount = item.final_amount !== undefined && Number(item.final_amount) > 0
      ? Number(item.final_amount)
      : Math.round((amount + total_gst) * 100) / 100;

    return {
      ...item,
      quantity,
      unit: normalizedUnit,
      rate,
      amount,
      cgst_rate: 0,
      cgst_percent: 0,
      cgst_amount: 0,
      sgst_rate: 0,
      sgst_percent: 0,
      sgst_amount: 0,
      igst_rate,
      igst_percent: igst_rate,
      igst_amount,
      is_inter_state: true,
      total_gst,
      final_amount,
      line_total: final_amount,
      ...(unit !== normalizedUnit ? { original_quantity: rawQuantity, original_unit: unit } : {}),
    };
  }

  // 3. Forward 18% GST (CGST 9% + SGST 9%)
  const cgst_rate = Number(item.cgst_rate !== undefined && Number(item.cgst_rate) > 0 ? item.cgst_rate : 9);
  const sgst_rate = Number(item.sgst_rate !== undefined && Number(item.sgst_rate) > 0 ? item.sgst_rate : 9);
  const cgst_amount = item.cgst_amount !== undefined && Number(item.cgst_amount) > 0 ? Number(item.cgst_amount) : Math.round(amount * (cgst_rate / 100) * 100) / 100;
  const sgst_amount = item.sgst_amount !== undefined && Number(item.sgst_amount) > 0 ? Number(item.sgst_amount) : Math.round(amount * (sgst_rate / 100) * 100) / 100;
  const total_gst = item.total_gst !== undefined && Number(item.total_gst) > 0 ? Number(item.total_gst) : Math.round((cgst_amount + sgst_amount) * 100) / 100;
  const final_amount = item.final_amount !== undefined && Number(item.final_amount) > 0
    ? Number(item.final_amount)
    : Math.round((amount + total_gst) * 100) / 100;

  return {
    ...item,
    quantity,
    unit: normalizedUnit,
    rate,
    amount,
    cgst_rate,
    cgst_percent: cgst_rate,
    cgst_amount,
    sgst_rate,
    sgst_percent: sgst_rate,
    sgst_amount,
    igst_rate: 0,
    igst_percent: 0,
    igst_amount: 0,
    is_inter_state: false,
    total_gst,
    final_amount,
    line_total: final_amount,
    ...(unit !== normalizedUnit ? { original_quantity: rawQuantity, original_unit: unit } : {}),
  };
}

/**
 * Calculates array of line items.
 *
 * @param {Array} lineItems - Array of raw line items
 * @param {object} [options] - Optional { isInterState }
 * @returns {Array} Array of normalized line items with calculated amounts
 */
function calculateLineItems(lineItems, options) {
  if (!Array.isArray(lineItems)) return [];
  return lineItems.map((item) => calculateLineItem(item, options));
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
 * Strict Forward GST calculation: always forward on line amount - never reverse calculated.
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
    // Mixed units or piece/count units: compute converted MT using physical formulas
    const tonnageRes = calculateTotalTonnageMt(processedItems);
    totalQuantityMt = tonnageRes.totalMt;
    totalQuantity = isUniformUnit
      ? processedItems.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0)
      : totalQuantityMt;
    formattedQuantity = tonnageRes.formattedText;
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
      calculationWarning = `Calculated total (₹${grandTotal.toLocaleString('en-IN')}) does not match PO document total (₹${statedGrand.toLocaleString('en-IN')}) - please review`;
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

/**
 * Calculates converted total tonnage in MT across all line items with precision and transparency.
 * RULE:
 * - If all line items have the SAME unit: directly sum their quantities (e.g. 60 MT + 60 MT = 120 MT).
 * - If line items have DIFFERENT units: convert each item to MT and sum into total MT.
 */
function calculateTotalTonnageMt(lineItems) {
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    return { totalMt: 0, hasUnconvertible: false, formattedText: '0.00 MT', summaryText: '0 Items' };
  }

  const validItems = lineItems.filter(i => {
    const q = Number(i.quantity ?? i.quantity_mt ?? i.qty ?? 0);
    return !isNaN(q) && q > 0;
  });

  if (validItems.length === 0) {
    return { totalMt: 0, hasUnconvertible: false, formattedText: '0.00 MT', summaryText: '0 Items' };
  }

  // 1. Group items by unit to build a clean commercial summary breakdown
  const unitTotals = new Map();
  for (const item of validItems) {
    const rawUnit = (item.unit || 'MT').trim();
    const normUnit = normalizeUnit(rawUnit);
    const q = Number(item.quantity ?? item.quantity_mt ?? item.qty ?? 0) || 0;
    unitTotals.set(normUnit, (unitTotals.get(normUnit) || 0) + q);
  }

  const breakdownParts = [];
  for (const [u, totalQ] of unitTotals.entries()) {
    const roundedQ = Math.round(totalQ * 1000) / 1000;
    breakdownParts.push(
      `${roundedQ.toLocaleString('en-IN', { maximumFractionDigits: 3 })} ${u}`
    );
  }
  const summaryText = breakdownParts.join(', ');
  const itemCountText = `${validItems.length} ${validItems.length === 1 ? 'item' : 'items'}`;

  // 2. Convert each line item to MT
  let totalMt = 0;
  let hasUnconvertible = false;
  const unconvertibleItems = [];

  for (const item of validItems) {
    const mt = convertLineItemToMt(item);
    if (mt !== null && !isNaN(mt)) {
      totalMt += mt;
    } else {
      hasUnconvertible = true;
      unconvertibleItems.push(`${item.quantity} ${item.unit}`);
    }
  }

  const roundedMt = Math.round(totalMt * 1000) / 1000;
  const formattedMtStr = roundedMt.toLocaleString('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  });

  // 3. Format result with clean dual representation
  const isPureMt = unitTotals.size === 1 && unitTotals.has('MT');
  let formattedText = `${formattedMtStr} MT`;

  if (isPureMt) {
    formattedText = `${formattedMtStr} MT`;
  } else if (roundedMt > 0) {
    formattedText = `${summaryText} • Est. Total Weight: ${formattedMtStr} MT`;
  } else if (hasUnconvertible) {
    formattedText = `${summaryText} (Weight conversion unavailable)`;
  }

  return {
    totalMt: roundedMt,
    hasUnconvertible,
    unconvertedDetails:
      unconvertibleItems.length > 0 ? unconvertibleItems.join(', ') : undefined,
    formattedText,
    summaryText,
    itemBreakdownText: `${summaryText} (${itemCountText})`,
  };
}

/**
 * Formats a number to Indian currency string (e.g. 1,23,456.78).
 */
function formatIndianCurrency(num, includeDecimals = false) {
  if (num === null || num === undefined || isNaN(Number(num))) {
    return '0.00';
  }
  const n = Number(num);
  const isNegative = n < 0;
  const absNum = Math.abs(n);

  const parts = absNum.toFixed(2).split('.');
  const integerPart = parts[0];
  const decimalPart = parts[1];

  let lastThree = integerPart.substring(integerPart.length - 3);
  const otherNumbers = integerPart.substring(0, integerPart.length - 3);
  if (otherNumbers !== '') {
    lastThree = ',' + lastThree;
  }
  const formattedInt = otherNumbers.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + lastThree;

  const result = includeDecimals ? `${formattedInt}.${decimalPart}` : formattedInt;
  return isNegative ? `-${result}` : result;
}

/**
 * Calculates standard GST 9% + 9% and Rounding financial breakdown for quotation / order displays.
 * Sub Total = Qty × Rate
 * CGST 9% = Sub Total × 0.09
 * SGST 9% = Sub Total × 0.09
 * Rounding adjustment
 * Total = Sub Total + CGST + SGST + Rounding
 */
function calculateQuotationBreakdown(baseAmount, lineItems, options) {
  const subtotal = Math.max(0, Number(baseAmount) || 0);
  const opts = options && typeof options === 'object' ? options : undefined;
  const isInterState =
    opts?.isInterState !== undefined
      ? Boolean(opts.isInterState)
      : Array.isArray(lineItems) &&
        lineItems.length > 0 &&
        lineItems.some((i) => Number(i?.igst_amount) > 0 || Number(i?.igst_rate) > 0) &&
        lineItems.every((i) => !Number(i?.cgst_amount) && !Number(i?.sgst_amount));

  let CGST = 0;
  let SGST = 0;
  let IGST = 0;

  if (isInterState) {
    IGST = Math.round(subtotal * 0.18 * 100) / 100;
    if (Array.isArray(lineItems) && lineItems.length > 0) {
      const sumIgst = lineItems.reduce((acc, item) => {
        const amt = Number(item.amount) || 0;
        const itemIgst =
          item.igst_amount !== undefined && Number(item.igst_amount) > 0
            ? Number(item.igst_amount)
            : Math.round(amt * 0.18 * 100) / 100;
        return acc + itemIgst;
      }, 0);
      if (sumIgst > 0) {
        IGST = Math.round(sumIgst * 100) / 100;
      }
    }
  } else {
    CGST = Math.round(subtotal * 0.09 * 100) / 100;
    SGST = Math.round(subtotal * 0.09 * 100) / 100;

    if (Array.isArray(lineItems) && lineItems.length > 0) {
      const sumCgst = lineItems.reduce((acc, item) => {
        const amt = Number(item.amount) || 0;
        const itemCgst =
          item.cgst_amount !== undefined && Number(item.cgst_amount) > 0
            ? Number(item.cgst_amount)
            : Math.round(amt * 0.09 * 100) / 100;
        return acc + itemCgst;
      }, 0);
      const sumSgst = lineItems.reduce((acc, item) => {
        const amt = Number(item.amount) || 0;
        const itemSgst =
          item.sgst_amount !== undefined && Number(item.sgst_amount) > 0
            ? Number(item.sgst_amount)
            : Math.round(amt * 0.09 * 100) / 100;
        return acc + itemSgst;
      }, 0);
      if (sumCgst > 0 || sumSgst > 0) {
        CGST = Math.round(sumCgst * 100) / 100;
        SGST = Math.round(sumSgst * 100) / 100;
      }
    }
  }

  const GST = Math.round((isInterState ? IGST : CGST + SGST) * 100) / 100;
  const exactTotal = subtotal + GST;
  const grandTotal = Math.round(exactTotal);
  const rounding = Math.round((grandTotal - exactTotal) * 100) / 100;

  const hasGstDecimals = (GST % 1 !== 0);
  const hasCgstDecimals = (CGST % 1 !== 0);
  const hasSgstDecimals = (SGST % 1 !== 0);
  const hasIgstDecimals = (IGST % 1 !== 0);
  const hasSubtotalDecimals = (subtotal % 1 !== 0);

  return {
    subtotal,
    CGST,
    SGST,
    IGST,
    GST,
    totalTax: GST,
    isInterState,
    taxType: isInterState ? 'INTER_STATE' : 'INTRA_STATE',
    rounding,
    grandTotal,
    formattedSubtotal: formatIndianCurrency(subtotal, hasSubtotalDecimals),
    formattedCGST: formatIndianCurrency(CGST, hasCgstDecimals),
    formattedSGST: formatIndianCurrency(SGST, hasSgstDecimals),
    formattedIGST: formatIndianCurrency(IGST, hasIgstDecimals),
    formattedGST: formatIndianCurrency(GST, hasGstDecimals),
    formattedRounding: rounding !== 0 ? (rounding > 0 ? `+₹${formatIndianCurrency(rounding, true)}` : `-₹${formatIndianCurrency(Math.abs(rounding), true)}`) : '₹0',
    formattedGrandTotal: `₹${formatIndianCurrency(grandTotal, false)}`,
  };
}

/**
 * Helper to format Indian currency values with or without decimals cleanly.
 */
function formatMoneyValue(num) {
  if (num === null || num === undefined || isNaN(Number(num))) return '0';
  const n = Number(num);
  const hasDec = (n % 1 !== 0);
  return n.toLocaleString('en-IN', {
    minimumFractionDigits: hasDec ? 2 : 0,
    maximumFractionDigits: 2,
  });
}

module.exports = {
  DEFAULT_GST_RATE,
  SELLER_GST_CONFIG,
  INDIAN_GST_STATES,
  resolveStateFromGstin,
  resolveStateFromAddress,
  resolveCustomerState,
  resolvePlaceOfSupply,
  normalizeUnit,
  convertToMt,
  convertLineItemToMt,
  extractDimensions,
  isDimensionCompatible,
  formatIndianCurrency,
  formatMoneyValue,
  calculateLineItem,
  calculateLineItems,
  calculateSubtotal,
  calculateGst,
  calculateGrandTotal,
  calculatePricingSummary,
  calculateQuotationBreakdown,
  calculateTotalTonnageMt,
};
