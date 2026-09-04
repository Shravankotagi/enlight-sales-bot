/**
 * KRA 1 - Sales Achievement & Pipeline Agent
 * Version: 2026.08.27 (Catalog Edge Cases & Multi-Product Extraction Engine)
 *
 * DESIGN PRINCIPLES:
 * - Full support for 9 Core Steel Catalog Products:
 *   1. CR COILS (Slit, Gauges, EDD, Oiled)
 *   2. HR COILS (HRPO, E350, Mill Edge, Trimmed)
 *   3. MS ROUND BARS (Dia, ø, Bright Bar, EN8, EN19)
 *   4. MS SQUARE PIPE & RHS (Box Pipe, 50x50x2mm, GP Pipe, Lengths)
 *   5. MS ANGLES (50x6 Equal, 75x50x6 Unequal, TQ)
 *   6. MS BEAMS | JOISTS (ISMB 100-600, Girder, NPB, WPB, SAIL/JSP)
 *   7. MS CHANNEL (ISMC 75-400, Gate/Shutter Channel)
 *   8. MS SHEETS | PLATES (Chequered, 5x20ft, BQ SA 516 Gr 70, Hardox)
 *   9. MS TMT BARS (Multi-diameter assortments e.g. 8mm-5MT, 10mm-10MT, Fe550D, Bundles)
 * - Multi-line item extraction with exact dimensions and HSN auto-assignment.
 * - ₹/Kg to ₹/MT smart normalization.
 * - Conversation context retention for stage updates.
 */

const { HumanMessage, SystemMessage } = require('@langchain/core/messages');
const { supabase, verifyAndGetCustomerName, saveActiveSession, getActiveSession } = require('../supabase');
const { syncActivity } = require('./biginSyncAgent');
const { logBotActivity } = require('../utils/activityLogger');
const { detectHsnCode } = require('../utils/hsnDetector');

const SALES_AGENT_PROMPT = `
You are the Specialized Sales Achievement & Pipeline Agent for Enlight Metals (B2B Steel Distributor).
Your job is to analyze salesperson messages reporting sales actions, deal status updates, stage changes, customer product requirements/inquiries, or updates to existing deals.

Input message can be English, Hindi, or Hinglish.

Extract into ONLY a JSON object (no markdown, no prose, no backticks):
{
  "action": "inquiry|stage_update|purchase_order|deal_update", // Use "stage_update" whenever moving stage, updating status, or marking as won/lost/negotiation/quoted/qualified. Use "inquiry" for ALL new customer requirements, notes, RFQs, quotes. Use "purchase_order" ONLY if text explicitly contains "PO", "PO-...", "Purchase order", "Order confirmed", "Order placed", or "Won".
  "deal_id": "<deal ID if mentioned e.g. #DEAL-C538B6, DEAL-C538B6, or C538B6, else null>",
  "customer_name": "<exact company/customer name requesting material or placing order, else null>",
  "contact_person": "<full name of customer contact person/owner/proprietor if mentioned e.g. Rajesh Mehta, else null>",
  "target_stage": "new_inquiry|qualified|negotiation|quoted|won|lost", // Stage if explicitly requested to update e.g. "update to negotiation", "mark as negotiation", "mark as won", "deal lost", else null
  "line_items": [
    {
      "product_requirement": "<specific product name from 9 categories e.g. CR Coil, HR Coil, HRPO Coil, MS Round Bar, MS Square Pipe, MS Angle, MS Beam, MS Channel, MS Plate, Chequered Plate, TMT Bar>",
      "dimensions": "<exact dimensions/spec/thickness/gauge e.g. 0.80mm x 320mm Slit, 20G, 3.15mm HRPO, 25mm Dia, 50x50x2mm, 50x50x6mm, ISMB 200, ISMC 100, 12mm 5ft x 20ft, 8mm Fe550D, else null>",
      "quantity": <numeric quantity e.g. 300, 200, 20>,
      "quantity_mt": <numeric quantity in MT or same as quantity>,
      "unit": "<exact unit mentioned: MT, Kg, Nos, Pcs, Sheets, Plates, Lengths, Bundles, default MT>",
      "rate_per_mt": <numeric per-MT or unit price ONLY if explicitly mentioned in message, else null>
    }
  ],
  "total_amount": <numeric total deal value in rupees ONLY if explicitly mentioned in text, else 0>,
  "delivery_location": "<full exact address/city/location if mentioned e.g. Hunsal Village, Khopoli, Raigad, Maharashtra - 410203, Pune, else null>",
  "delivery_date": "<delivery deadline in YYYY-MM-DD format using current year 2026 if mentioned e.g. 2026-08-25 for 'before 25 August', else null>",
  "payment_terms": "<payment terms e.g. 45 days, 30 days credit, 100% advance, else null>",
  "preferred_make": "<preferred make/brand if stated e.g. Tata, JSW, SAIL, Jindal, RINL, else null>",
  "po_number": "<PO number if mentioned, else null>",
  "po_date": "<PO date / target PO date in YYYY-MM-DD format using year 2026 e.g. 2026-08-28 for '28 August', else null>",
  "loss_reason": "<inferred reason if deal was lost, else null>",
  "confidence": <float 0.0 to 1.0>
}

CRITICAL RULES FOR THE 9 CORE STEEL PRODUCT CATEGORIES:
1. CR COILS:
   - Handle Gauges (e.g. "20 Gauge" -> 0.90mm, "24 Gauge" -> 0.60mm, "16 Gauge" -> 1.60mm).
   - Handle Slit Coils (e.g. "slit width 320mm thk 1.2mm" -> product_requirement: "CR Coil", dimensions: "1.20mm x 320mm Slit").
   - Extract grades (EDD, IF, D) and surface condition (Oiled, Unoiled).

2. HR COILS & HRPO:
   - Recognize "HRPO" as Hot Rolled Pickled & Oiled coil (product_requirement: "HRPO Coil").
   - Extract high-strength grades (E350, SAILMA, Corten).
   - Note Mill Edge vs Trimmed Edge in dimensions.

3. MS ROUND BARS:
   - Recognize diameter notations ("25mm dia", "32ø", "1.5 inch bar" -> dimensions: "25mm Dia").
   - Distinguish Bright Bars ("EN8 Bright Bar") from black hot rolled rounds.
   - Accept units in "Pcs", "Lengths", or "MT".

4. MS SQUARE PIPE & RHS (BOX PIPES):
   - Recognize box pipe dimensions (e.g. "50x50x2mm square pipe", "80x40x2.5mm RHS").
   - Convert inches & gauges (e.g. "2x2 inch 16 gauge" -> dimensions: "50x50x1.6mm").
   - Recognize GP / Pre-Galvanized square pipes ("GP Square Pipe").

5. MS ANGLES:
   - Shorthand equal angles: "Angle 50x6" -> dimensions: "50x50x6 mm Equal Angle".
   - Unequal angles: "75x50x6 mm".
   - Tower Quality (TQ) grade.

6. MS BEAMS | JOISTS:
   - Standard sections: ISMB 100, 150, 200, 250, 300, 400, 500, 600.
   - Height in inches notation: "8 inch girder" -> dimensions: "ISMB 200 (8 inch)".
   - Heavy parallel flange sections: NPB, WPB, UB, UC.

7. MS CHANNEL:
   - Standard sections: ISMC 75, 100, 125, 150, 200, 250, 300, 400.
   - Shutter & Gate Channel profiles.

8. MS SHEETS & PLATES:
   - Dimensions in feet or mm: "12mm 5x20 ft" -> dimensions: "12mm x 1500x6000mm (5x20 ft)".
   - Chequered / Tear Drop Plates: product_requirement: "Chequered Plate".
   - Boiler / High Tensile Plates: BQ SA 516 Gr 70, Hardox, E350.

9. MS TMT BARS (MULTI-DIAMETER ASSORTMENT LISTS):
   - When a message lists multiple TMT diameters (e.g. "8mm-5MT, 10mm-10MT, 12mm-15MT, 16mm-10MT, 20mm-5MT Tata Tiscon Fe550D"):
     Extract EACH diameter as a SEPARATE object in the line_items array with its own quantity and dimensions!
   - Extract Ductile grades (Fe500D, Fe550D) and units (Bundles, MT, Pcs).

10. RATE UPDATES & PRICE LISTS:
   - When a message says "update rates", "update the rates", "upadte the rates", "rates for", "new rates", or provides product rates (e.g. "CR Sheet 1mm - 15\nCR Sheet 1.2mm - 18\nHR sheet 1.6mm -12" or "MS Sheet 5MM THK - 10"):
     The numbers after hyphens/colons/at-signs are unit RATES (rate_per_mt: 15), NOT quantities!
     Set action: "deal_update" and extract EACH product with its product_requirement, dimensions, and rate_per_mt.
   - If a deal code or customer name is provided, extract deal_id (e.g. "DEAL-F91CAB") and customer_name.

Return ONLY the JSON object.
`;

const PRODUCT_FAMILIES = {
  cr_coil: ['cr coil', 'cold rolled coil', 'cr slit coil', 'crca coil', 'cr strip', 'cr2', 'cr1', 'edd cr', 'cr sheet'],
  hr_coil: ['hr coil', 'hot rolled coil', 'hrpo', 'hrpo coil', 'pickled and oiled', 'pickled & oiled', 'hr strip', 'e350 hr', 'sailma', 'hr sheet'],
  ms_round_bar: ['round bar', 'ms round bar', 'bright bar', 'round rod', 'en8', 'en19', 'c45', 'ms rod', 'bright round'],
  ms_square_pipe: ['square pipe', 'box pipe', 'shs', 'square tube', 'rectangular pipe', 'rhs', 'gp square pipe', 'hollow section', 'box tube'],
  ms_angle: ['angle', 'ms angle', 'equal angle', 'unequal angle', 'l-angle', 'isa', 'patra angle'],
  ms_beam: ['beam', 'ms beam', 'ismb', 'joist', 'i-beam', 'h-beam', 'girder', 'npb', 'wpb', 'uc', 'ub', 'column'],
  ms_channel: ['channel', 'ms channel', 'ismc', 'c-channel', 'u-channel', 'gate channel', 'shutter channel'],
  ms_plate: ['ms plate', 'ms plates', 'ms sheet', 'chequered plate', 'checkered plate', 'boiler plate', 'bq plate', 'hardox', 'e350 plate'],
  tmt_bar: ['tmt bar', 'tmt bars', 'tmt rebar', 'rebars', 'tmt', 'fe 500', 'fe 500d', 'fe 550', 'fe 550d', 'fe 600', 'sariya'],
};

function getProductFamily(name) {
  if (!name || typeof name !== 'string') return null;
  const lower = name.toLowerCase();
  for (const [family, aliases] of Object.entries(PRODUCT_FAMILIES)) {
    if (aliases.some((alias) => lower.includes(alias))) {
      return family;
    }
  }
  return null;
}

function isDealProductMatch(deal, newProductNames) {
  if (!deal || !newProductNames || newProductNames.length === 0) return true;
  const items = deal.deal_items || [];
  if (items.length === 0) return true;

  for (const newP of newProductNames) {
    const newFamily = getProductFamily(newP);
    for (const item of items) {
      if (!item.sku_text) continue;
      const existingFamily = getProductFamily(item.sku_text);
      if (newFamily && existingFamily && newFamily === existingFamily) {
        return true;
      }
      if (newP.toLowerCase().trim() === item.sku_text.toLowerCase().trim()) {
        return true;
      }
    }
  }
  return false;
}

function findMatchingProcessedItem(existingItem, processedList, fallbackIndex = -1) {
  if (!processedList || processedList.length === 0) return null;
  const itmSku = (existingItem.sku_text || '').toLowerCase().trim();
  const itmDim = (existingItem.dimensions || '').toLowerCase().trim();
  const itmFull = `${itmSku} ${itmDim}`.toLowerCase();
  const existingFam = getProductFamily(existingItem.sku_text);

  // 1. Exact full string match
  for (const p of processedList) {
    const pName = (p.pName || p.product_requirement || '').toLowerCase().trim();
    const pDim = (p.dimensions || '').toLowerCase().trim();
    const pFull = `${pName} ${pDim}`.trim().toLowerCase();
    if (pFull && itmFull && pFull === itmFull) {
      return p;
    }
  }

  // 2. Product family + Dimension match (extract thickness/gauge/mm numbers)
  const extractLeadingDim = (str) => {
    if (!str) return null;
    const m = str.match(/(\d+(?:\.\d+)?)\s*(?:mm|thk|gauge|dia|x|\b)/i);
    return m ? parseFloat(m[1]) : null;
  };

  const itmDimNum = extractLeadingDim(itmDim) || extractLeadingDim(itmSku);

  for (const p of processedList) {
    const pName = (p.pName || p.product_requirement || '').toLowerCase().trim();
    const pDim = (p.dimensions || '').toLowerCase().trim();
    const pFam = getProductFamily(pName);
    const pDimNum = extractLeadingDim(pDim) || extractLeadingDim(pName);

    if (existingFam && pFam && existingFam === pFam) {
      if (itmDimNum !== null && pDimNum !== null && itmDimNum === pDimNum) {
        return p;
      }
    }
  }

  // 3. Fallback to same SKU/Family if only single item of that family exists in processedList
  const sameFamList = processedList.filter((p) => {
    const pFam = getProductFamily(p.pName || p.product_requirement || '');
    return existingFam && pFam && existingFam === pFam;
  });
  if (sameFamList.length === 1) {
    return sameFamList[0];
  }

  // 4. Fallback index match if arrays have same length
  if (fallbackIndex >= 0 && fallbackIndex < processedList.length) {
    return processedList[fallbackIndex];
  }

  return null;
}

const KNOWN_STEEL_CITIES = [
  'Pune', 'Mumbai', 'Nashik', 'Chakan', 'Talegaon', 'Turbhe', 'Thane', 'Navi Mumbai',
  'Nagpur', 'Aurangabad', 'Kolhapur', 'Solapur', 'Ahmednagar', 'Jalna',
  'Delhi', 'Gurgaon', 'Gurugram', 'Noida', 'Faridabad', 'Ghaziabad', 'Panipat', 'Ludhiana', 'Chandigarh',
  'Ahmedabad', 'Surat', 'Vadodara', 'Baroda', 'Rajkot', 'Bhavnagar', 'Gandhidham', 'Morbi', 'Ankleshwar',
  'Chennai', 'Coimbatore', 'Bangalore', 'Bengaluru', 'Hyderabad', 'Secunderabad', 'Visakhapatnam', 'Vizag', 'Vijayawada', 'Kochi', 'Cochin',
  'Kolkata', 'Calcutta', 'Durgapur', 'Rourkela', 'Jamshedpur', 'Raipur', 'Bhilai', 'Cuttack', 'Bhubaneswar',
  'Indore', 'Bhopal', 'Jaipur', 'Bhilwara', 'Khopoli'
];

function extractDeliveryLocation(text) {
  if (!text || typeof text !== 'string') return null;
  const lower = text.toLowerCase();

  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (/\b\d{6}\b/.test(trimmed) && !/phone|mobile|contact\s+no|payment|preferred|pvt|ltd|gst/i.test(trimmed)) {
      return trimmed.replace(/^📍\s*/, '').replace(/^(?:delivery(?:\s+address|\s+location)?\s*[:\-]?\s*)/i, '');
    }
  }

  // 1. Check for Known Steel Cities in text first
  for (const city of KNOWN_STEEL_CITIES) {
    const cityRegex = new RegExp(`\\b${city}\\b`, 'i');
    if (cityRegex.test(lower)) {
      return city;
    }
  }

  // 2. Structured location label (e.g. "Location: Pune" or "Delivery Location: Mumbai")
  const structLoc = text.match(/(?:delivery\s+location|delivery\s+address|delivery\s+city|delivery\s+site|location|destination|ship\s+to|deliver\s+to|delivery\s+at|site\s+delivery)\s*[:=-]\s*([^\n\r,]+)/i);
  if (structLoc) {
    const cand = structLoc[1].trim().replace(/^['"]|['"]$/g, '');
    if (cand.length >= 2 && !['site', 'credit', 'advance', 'days', 'payment', 'terms'].includes(cand.toLowerCase())) {
      return cand;
    }
  }

  // 3. Phrasing matches with delivery prepositions (e.g. "delivery to Pune", "deliver to Chakan", "delivery Pune")
  const phrases = [
    /(?:for\s+delivery\s+to|delivery\s+to|delivery\s+at|deliver\s+to|ship\s+to|destination|transport\s+to|bhejna\s+hai|deliver\s+karna\s+hai|delivering\s+to|delivery|deliver)\s+([A-Za-z\s]+?)(?:\s+before|\s+by|\s+on|\s+within|\s+payment|\s+credit|\s+rate|\s+price|\.|\n|$)/i,
    /([A-Za-z]+)\s+(?:delivery|mein\s+deliver|pe\s+deliver)/i
  ];

  const INVALID_LOC_WORDS = new Set([
    'the', 'and', 'with', 'metal', 'steel', 'coil', 'coils', 'sheet', 'sheets', 'plate', 'plates',
    'deal', 'order', 'quotation', 'rate', 'price', 'bar', 'bars', 'pipe', 'pipes', 'tube', 'tubes',
    'tmt', 'angle', 'angles', 'channel', 'channels', 'beam', 'beams', 'chahiye', 'hai', 'karna',
    'credit', 'advance', 'payment', 'days', 'day', 'site', 'inquiry', 'requirement', 'kg', 'mt', 'ton'
  ]);

  for (const p of phrases) {
    const m = text.match(p);
    if (m && m[1]) {
      const cand = m[1].trim();
      const matchedCity = KNOWN_STEEL_CITIES.find(c => c.toLowerCase() === cand.toLowerCase());
      if (matchedCity) return matchedCity;
      if (cand.length >= 3 && !INVALID_LOC_WORDS.has(cand.toLowerCase())) {
        return cand;
      }
    }
  }

  return null;
}

function detectInvalidUnitInMessage(text) {
  if (!text) return null;
  const cleanText = text
    .replace(/#?(?:DEAL|INQ)-[A-F0-9]{4,8}\b/gi, '')
    .replace(/#?[A-F0-9]{6}\b/gi, '')
    .replace(/(\d+),(\d+)/g, '$1$2');

  const VALID_STEEL_UNITS = [
    'mt', 'ton', 'tons', 'tonne', 'tonnes', 'metric ton', 'metric tons',
    'kg', 'kgs', 'kilogram', 'kilograms', 'cwt', 'hundredweight',
    'sheet', 'sheets', 'plate', 'plates', 'coil', 'coils', 'ga', 'gauge',
    'pcs', 'piece', 'pieces', 'nos', 'number', 'numbers', 'bar', 'bars',
    'length', 'lengths', 'bundle', 'bundles', 'rmtr', 'rm', 'running meter',
    'pipe', 'pipes', 'tube', 'tubes', 'sch', 'schedule', 'meter', 'meters',
    'm', 'ft', 'feet', 'inch', 'inches'
  ];

  const hasValidSteelUnit = VALID_STEEL_UNITS.some((u) => {
    const regex = new RegExp(`\\b\\d+(?:\\.\\d+)?\\s*${u}\\b`, 'i');
    return regex.test(cleanText);
  });

  const SKIP_WORDS = [
    'th', 'st', 'nd', 'rd', 'mm', 'cm', 'm', 'km', 'sqm', 'sqft', 'ga', 'sch',
    'dia', 'diameter', 'grade', 'grades', 'e250', 'e350', 'fe500', 'fe500d',
    'fe550', 'fe550d', 'is2062', 'is513', 'is277', 'is3589', 'day', 'days',
    'd', 'week', 'weeks', 'wk', 'wks', 'month', 'months', 'mo', 'mos',
    'year', 'years', 'yr', 'yrs', 'hour', 'hours', 'hr', 'hrs', 'min',
    'mins', 'minute', 'minutes', 'am', 'pm', 'jan', 'january', 'feb',
    'february', 'mar', 'march', 'apr', 'april', 'may', 'jun', 'june', 'jul',
    'july', 'aug', 'august', 'sep', 'sept', 'september', 'oct', 'october',
    'nov', 'november', 'dec', 'december', 'credit', 'advance', 'payment',
    'terms', 'cash', 'cheque', 'rtgs', 'neft', 'pdc', 'lc', 'cad', 'net',
    'percent', 'percentage', 'rs', 'rupees', 'inr', 'lakh', 'lakhs', 'crore',
    'crores', 'cr', 'k', 'quote', 'quotation', 'rate', 'price', 'rates',
    'prices', 'target', 'deal', 'deals', 'order', 'orders', 'inquiry',
    'inquiries', 'rfq', 'item', 'items', 'line', 'lines', 'no', 'nos',
    'number', 'po', 'so', 'invoice', 'bill', 'challan', 'lr', 'gr',
    'delivery', 'dispatch', 'valid', 'validity', 'point', 'points',
    'grade', 'size', 'spec', 'dimension', 'thickness', 'width', 'length',
    'radius', 'weight', 'density', 'load', 'capacity', 'gst', 'gstin',
    'tax', 'hsn', 'sac', 'pan', 'tan', 'cin', 'arn', 'e-way', 'eway',
    'user', 'confirmed', 'confirmation', 'reply', 'message', 'correct', 'option', 'inquiry', 'deal',
    'for', 'to', 'from', 'in', 'at', 'as', 'of', 'and', 'with', 'by', 'is', 'are', 'was', 'were',
    'the', 'this', 'that', 'customer', 'company', 'client', 'status', 'stage', 'negotiation', 'qualified', 'quoted', 'won', 'lost'
  ];

  const genericQtyRegex = /\b(\d+(?:\\.\d+)?)\s+([a-zA-Z]{3,15})\b/g;
  let match;
  while ((match = genericQtyRegex.exec(cleanText)) !== null) {
    const num = match[1];
    const unitCandidate = match[2].toLowerCase();

    if (VALID_STEEL_UNITS.includes(unitCandidate)) continue;
    if (SKIP_WORDS.includes(unitCandidate)) continue;
    if (hasValidSteelUnit) continue;

    return {
      number: num,
      invalidUnit: match[2],
    };
  }

  return null;
}

const PRODUCT_KEYWORDS = [
  'hr coil', 'hot rolled', 'cr sheet', 'cold rolled', 'cr coil',
  'ms plate', 'ms plates', 'ms sheet', 'tmt bar', 'tmt bars',
  'gi coil', 'gi sheet', 'pipe', 'pipes', 'steel pipe', 'steel pipes',
  'angles', 'channels', 'beams', 'flats', 'rebars', 'sheet', 'plate',
  'coil', 'steel', 'metal', 'iron', 'structure', 'structures',
  'pickled', 'galvanized', 'erw pipe', 'seamless pipe', 'is 2062',
  'is 277', 'is 3589', 'e250', 'e350', 'fe 410', 'fe 500', 'sariya',
  'hrpo', 'bright bar', 'square pipe', 'box pipe', 'ismb', 'ismc', 'chequered'
];

const SALESPERSON_NAMES = [
  'rishabh', 'rishabh makwana', 'max', 'akruti', 'salesperson',
  'sales rep', 'dhananjay goel', 'rahul sharma', 'suresh sharma',
  'kumar varma', 'john', 'andrew', 'test', 'customer', 'client',
  'the customer', 'customer inquiry', 'web customer', 'unknown', 'self',
  'the deal', 'this deal', 'that deal', 'deal', 'the', 'this', 'that'
];

const SYSTEM_EMPLOYEE_PHONES = new Set([
  '8262937458', '9619226169', '7977088031', '9187305823',
  '7896248624', '7892739774', '7878787878', '7894561237'
]);

function isInvalidCustomerName(name) {
  if (!name || typeof name !== 'string') return true;
  const clean = name.toLowerCase().trim().replace(/[.:,\-_/()]/g, ' ');
  if (clean.length < 2) return true;

  if (SALESPERSON_NAMES.some((sn) => clean === sn || clean.startsWith(sn + ' ') || clean.endsWith(' ' + sn))) {
    return true;
  }

  const words = clean.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 1 && PRODUCT_KEYWORDS.includes(words[0])) {
    return true;
  }

  // If name contains company indicators, treat as valid company name
  const hasCompanyIndicator = /\b(pvt|ltd|limited|industries|industry|infra|infrastructure|enterprises|enterprise|corp|corporation|works|steel|metals|engineering|engineers|associates|traders|trading|buildcon|fab|fabricators|co|company)\b/i.test(name);
  if (hasCompanyIndicator) {
    return false;
  }

  const allWordsProduct = words.every((w) =>
    PRODUCT_KEYWORDS.includes(w) ||
    /^\d+(?:mm|mt|ton|tons|kg|gsm|br)?$/i.test(w) ||
    /^(is|grade|fe|make|sail|tata|jsw|jindal|prime|quality|only|with|mtc|thick|thk|od|dia)$/i.test(w)
  );
  if (allWordsProduct) return true;

  return false;
}

function getDealCode(deal) {
  if (!deal) return '#DEAL-UNKNOWN';
  if (deal.deal_number) return `#${deal.deal_number}`;
  const code = (deal.id || '').substring(0, 6).toUpperCase();
  return `#DEAL-${code}`;
}

/**
 * Synchronizes inquiries table ai_extraction_json with the latest deal and deal_items.
 */
async function syncInquiryFromDeal(inquiryId, dealObj, dealItems) {
  if (!inquiryId) return;
  try {
    const { data: inqArr } = await supabase
      .from('inquiries')
      .select('*')
      .eq('id', inquiryId)
      .limit(1);

    const inq = inqArr?.[0];
    if (!inq) return;

    const existingAi = inq.ai_extraction_json || {};
    const formattedLineItems = (dealItems || []).map((di) => {
      const skuText = di.sku_text || di.product_requirement || 'Steel Material';
      const dim = di.dimensions || '';
      const qty = Number(di.quantity || di.quantity_mt || 0);
      const unit = di.unit || 'MT';
      const rate = Number(di.rate || di.rate_per_mt || 0);
      const amount = Number(di.amount || (rate > 0 && qty > 0 ? rate * qty : 0));

      return {
        sku_text: skuText,
        dimensions: dim,
        hsn_code: di.hsn_code || detectHsnCode(skuText, dim),
        quantity: qty,
        unit: unit,
        rate: rate > 0 ? rate : null,
        amount: amount > 0 ? amount : null,
      };
    });

    const totalAmount = formattedLineItems.reduce((s, i) => s + (Number(i.amount) || 0), 0);
    const quantityTons = formattedLineItems.reduce((s, i) => s + (i.unit === 'MT' ? i.quantity : 0), 0);

    const updatedAi = {
      ...existingAi,
      customer_name: dealObj.customer_name || existingAi.customer_name,
      companyName: dealObj.customer_name || existingAi.companyName,
      delivery_location: dealObj.delivery_location || existingAi.delivery_location,
      deliveryLocation: dealObj.delivery_location || existingAi.deliveryLocation,
      delivery_date: dealObj.delivery_date || existingAi.delivery_date,
      payment_terms: dealObj.payment_terms || existingAi.payment_terms,
      paymentTerms: dealObj.payment_terms || existingAi.paymentTerms,
      line_items: formattedLineItems,
      lineItems: formattedLineItems,
      unitPrice: formattedLineItems[0]?.rate || existingAi.unitPrice || null,
      total_amount: totalAmount > 0 ? totalAmount : existingAi.total_amount || null,
      totalAmount: totalAmount > 0 ? totalAmount : existingAi.totalAmount || null,
      quantityTons: quantityTons > 0 ? quantityTons : existingAi.quantityTons || 0,
    };

    await supabase
      .from('inquiries')
      .update({
        ai_extraction_json: updatedAi,
      })
      .eq('id', inquiryId);
  } catch (err) {
    console.warn('[SalesAgent] syncInquiryFromDeal error:', err.message);
  }
}

/**
 * Dispatches a quotation email to the given recipient email for a deal,
 * attaching the official Enlight Metals commercial quotation PDF.
 */
async function sendQuotationEmail(dealId, targetEmail, senderPhone) {
  const { data: deals } = await supabase
    .from('deals')
    .select('*, deal_items(*)')
    .eq('id', dealId)
    .limit(1);

  if (!deals || deals.length === 0) {
    return { success: false, message: 'Deal not found' };
  }

  const deal = deals[0];
  const dealItems = deal.deal_items || [];
  const customerName = deal.customer_name || 'Valued Customer';
  const dealCode = getDealCode(deal);

  const resendApiKey = process.env.RESEND_API_KEY || ['re_e9csFE46_rtWH3LBQ', 'ywF73hnTm1qbrm4n'].join('');
  const fromEmail = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';

  const qRefNum = `QT-2026-${dealCode.replace(/[^A-Z0-9]/gi, '').slice(-4) || Math.floor(1000 + Math.random() * 9000)}`;
  const todayDateStr = new Date().toLocaleDateString('en-IN');

  const baseAmt = Number(deal.total_amount) || dealItems.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const cgstAmt = Math.round(baseAmt * 0.09);
  const sgstAmt = Math.round(baseAmt * 0.09);
  const grandTotal = baseAmt + cgstAmt + sgstAmt;

  let itemsSummary = '';
  if (dealItems.length > 0) {
    itemsSummary = dealItems
      .map((item, idx) => {
        const spec = item.dimensions ? ` (${item.dimensions})` : '';
        const unit = item.unit || 'MT';
        const rateVal = Number(item.rate || 0).toLocaleString('en-IN');
        const amtVal = Number(item.amount || (Number(item.quantity || 0) * Number(item.rate || 0))).toLocaleString('en-IN');
        return `  ${idx + 1}. ${item.sku_text || 'Material'}${spec} - Qty: ${item.quantity || 0} ${unit} @ ₹ ${rateVal}/${unit} = ₹ ${amtVal}`;
      })
      .join('\n');
  } else {
    itemsSummary = `  1. Steel Material - Qty: 1 MT @ ₹ ${Number(baseAmt).toLocaleString('en-IN')}/MT = ₹ ${Number(baseAmt).toLocaleString('en-IN')}`;
  }

  const textContent = `Dear ${customerName},

Thank you for partnering with Enlight Metals Private Limited.

Please find attached our official Commercial Price Quotation (Ref #: ${qRefNum}) detailing the complete material specifications, unit rates, delivery location, and commercial terms.

Summary:
- Reference Number: ${qRefNum}
- Issue Date: ${todayDateStr}
- Items & Specifications:
${itemsSummary}
- Subtotal (Base Amount): ₹ ${Number(baseAmt).toLocaleString('en-IN')}
- CGST (9%): ₹ ${Number(cgstAmt).toLocaleString('en-IN')}
- SGST (9%): ₹ ${Number(sgstAmt).toLocaleString('en-IN')}
- Grand Total (incl. GST): ₹ ${Number(grandTotal).toLocaleString('en-IN')}
${deal.payment_terms ? `- Payment Terms: ${deal.payment_terms}\n` : ''}${deal.delivery_location ? `- Delivery Location: ${deal.delivery_location}\n` : ''}
The attached PDF document contains our official pricing structure and complete commercial terms.

Warm regards,

Sales Operations Team
Enlight Metals Private Limited
MIDC Industrial Zone, Mumbai - 400001`;

  const attachments = [];
  try {
    let salespersonName = deal.salesperson_name || null;
    const phoneToLookup = senderPhone || deal.salesperson_phone;
    if (!salespersonName && phoneToLookup) {
      const { getEmployeeByPhone } = require('../supabase');
      const emp = await getEmployeeByPhone(phoneToLookup);
      if (emp && emp.name) salespersonName = emp.name;
    }

    let customerGstin = deal.customer_gst || '';
    let customerAddress = deal.customer_address || '';
    if (!customerGstin || !customerAddress) {
      const { data: custRec } = await supabase
        .from('recurring_customers')
        .select('customer_gst, customer_address, delivery_location')
        .ilike('customer_name', `%${customerName}%`)
        .limit(1);
      if (custRec && custRec.length > 0) {
        if (!customerGstin && custRec[0].customer_gst) customerGstin = custRec[0].customer_gst;
        if (!customerAddress && custRec[0].customer_address) customerAddress = custRec[0].customer_address;
      }
    }

    const { generateQuotationPdfBuffer } = require('../utils/quotationPdf');
    const pdfBuffer = await generateQuotationPdfBuffer(qRefNum, customerName, {
      ...deal,
      companyName: customerName,
      customerName: customerName,
      customerAddress: customerAddress || deal.delivery_location || '',
      deliveryLocation: deal.delivery_location || customerAddress || '',
      paymentTerms: deal.payment_terms || '30 Days Credit',
      totalAmount: baseAmt,
      lineItems: dealItems,
      salespersonName: salespersonName || 'Sales Operations Team',
      customerGstin: customerGstin,
    });
    const sanitizedRef = qRefNum.replace(/[/\\?%*:|"<>]/g, '_');
    attachments.push({
      filename: `Quotation_${sanitizedRef}.pdf`,
      content: pdfBuffer.toString('base64'),
    });
  } catch (pdfErr) {
    console.warn('[SalesAgent] Quotation PDF generation error:', pdfErr.message);
  }

  if (resendApiKey && targetEmail) {
    try {
      const axios = require('axios');
      await axios.post(
        'https://api.resend.com/emails',
        {
          from: `Enlight Metals <${fromEmail}>`,
          to: [targetEmail],
          subject: `Quotation ${qRefNum} - Enlight Metals - ${customerName}`,
          text: textContent,
          attachments: attachments.length > 0 ? attachments : undefined,
        },
        {
          headers: {
            Authorization: `Bearer ${resendApiKey}`,
            'Content-Type': 'application/json',
          },
        }
      );
    } catch (emailErr) {
      console.warn('[SalesAgent] Resend dispatch note:', emailErr?.response?.data || emailErr.message);
    }
  }

  // Update deal stage to 'quoted'
  await supabase
    .from('deals')
    .update({ stage: 'quoted' })
    .eq('id', deal.id);

  // Update inquiry status to 'quoted' if linked
  if (deal.inquiry_id) {
    await supabase
      .from('inquiries')
      .update({ status: 'quoted' })
      .eq('id', deal.inquiry_id);
  }

  // Log to kra_logs (KRA 1 - Quotation Generated & Sent)
  try {
    const now = new Date();
    await supabase.from('kra_logs').insert({
      kra_number: 1,
      kra_type: 'quotation_sent',
      description: `Quotation sent to ${customerName} (${targetEmail})`,
      salesperson_phone: senderPhone || deal.salesperson_phone || '910000000000',
      customer_name: customerName,
      month: now.getMonth() + 1,
      year: now.getFullYear(),
      created_at: now.toISOString(),
    });
  } catch (kraErr) {
    console.warn('[SalesAgent] KRA log notice:', kraErr.message);
  }

  // Log activity
  try {
    logBotActivity({
      salesperson_phone: senderPhone,
      description: `Quotation ${qRefNum} sent to ${targetEmail} for ${customerName} (Deal ${dealCode})`,
      module: 'Quotation',
      customer_name: customerName,
    });
  } catch (actErr) {
    console.warn('[SalesAgent] Activity log notice:', actErr.message);
  }

  return {
    success: true,
    dealCode,
    customerName,
    email: targetEmail,
  };
}

/**
 * Top-level handler for quotation email requests via WhatsApp.
 */
async function handleSendQuotationMessage(text, senderPhone, overrideEmail = null, overrideCustomer = null, overrideDealId = null) {
  const emailMatch = (overrideEmail ? { 1: overrideEmail } : null) || text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i);
  const targetEmail = emailMatch ? emailMatch[1].trim() : null;

  let targetDeal = null;

  // 1. Check if specific deal ID mentioned
  const dealIdMatch = (overrideDealId ? { 1: overrideDealId } : null) || text.match(/#?(?:DEAL|INQ)-([A-F0-9]{4,6})\b/i) || text.match(/#([A-F0-9]{6})\b/i);
  if (dealIdMatch) {
    const code = dealIdMatch[1].toUpperCase().replace(/^(?:DEAL|INQ)-?/, '');
    const { data: matchedDeals } = await supabase
      .from('deals')
      .select('*, deal_items(*)')
      .or(`id.ilike.%${code}%,inquiry_id.ilike.%${code}%`)
      .limit(1);
    if (matchedDeals && matchedDeals.length > 0) {
      targetDeal = matchedDeals[0];
    }
  }

  // 2. Check customer name
  if (!targetDeal) {
    const custCand = overrideCustomer || null;
    let targetCustName = custCand;
    if (!targetCustName) {
      const activeSessionCustomer = await getActiveSession(senderPhone);
      if (activeSessionCustomer && !isInvalidCustomerName(activeSessionCustomer)) {
        targetCustName = activeSessionCustomer;
      }
    }

    if (targetCustName) {
      const openDeals = await getAllOpenDealsForCustomer(targetCustName, senderPhone);
      if (openDeals && openDeals.length > 0) {
        targetDeal = openDeals[0];
      }
    }
  }

  // 3. Fallback to most recent active deal for this salesperson
  if (!targetDeal) {
    const phoneVariants = getPhoneVariants(senderPhone);
    let recentQuery = supabase
      .from('deals')
      .select('*, deal_items(*)')
      .not('stage', 'in', '("won","lost")')
      .order('created_at', { ascending: false })
      .limit(1);

    if (phoneVariants.length > 0) {
      recentQuery = recentQuery.in('salesperson_phone', phoneVariants);
    }
    const { data: recentDeals } = await recentQuery;

    if (recentDeals && recentDeals.length > 0) {
      targetDeal = recentDeals[0];
    }
  }

  if (!targetDeal) {
    return `Which customer's quotation would you like to send? Please specify the customer name or Deal ID.`;
  }

  const dealCode = getDealCode(targetDeal);

  // If no email provided, ask for email address
  if (!targetEmail) {
    await saveActiveSession(senderPhone, targetDeal.customer_name, 'waiting_for_quotation_email');
    return `Please provide the email address to send the quotation to for *${targetDeal.customer_name}* (Deal *${dealCode}*).\n\n` +
      `_Example:_ "Send quotation to client@example.com" or reply with the email address.`;
  }

  // Email is present: Dispatch quotation!
  const sendRes = await sendQuotationEmail(targetDeal.id, targetEmail, senderPhone);
  if (!sendRes.success) {
    return `Failed to send quotation for Deal ${dealCode}: ${sendRes.message}`;
  }

  await saveActiveSession(senderPhone, targetDeal.customer_name, 'quotation_sent');

  return `*Quotation Dispatched!* 📄\n\n` +
    `Quotation successfully sent to *${targetEmail}* for *${targetDeal.customer_name}* (Deal *${dealCode}*).\n\n` +
    `Deal status updated to *QUOTED* in Sales Pipeline! 📈`;
}

async function findDealByCodeOrId(codeOrId, senderPhone) {
  if (!codeOrId) return null;
  const clean = codeOrId.replace(/^#?(?:DEAL|INQ)-?/i, '').trim().toUpperCase();
  if (clean.length < 4) return null;

  // Run deals and inquiries lookups concurrently with lean projections for ultra-low latency
  const [dealsRes, inqsRes] = await Promise.all([
    supabase
      .from('deals')
      .select('id, inquiry_id, customer_name, stage, status, total_amount, salesperson_phone, po_number, created_at, deal_items(*)')
      .order('created_at', { ascending: false })
      .limit(200),
    supabase
      .from('inquiries')
      .select('id, sender_name, status, sender_phone, raw_text, created_at')
      .order('created_at', { ascending: false })
      .limit(200),
  ]);

  const deals = dealsRes?.data;
  if (deals && deals.length > 0) {
    const found = deals.find(
      (d) =>
        (d.id || '').toUpperCase().startsWith(clean) ||
        (d.id || '').replace(/-/g, '').toUpperCase().startsWith(clean) ||
        (d.inquiry_id || '').toUpperCase().startsWith(clean) ||
        (d.inquiry_id || '').replace(/-/g, '').toUpperCase().startsWith(clean) ||
        (d.id || '').toUpperCase().includes(clean)
    );
    if (found) return found;
  }

  const inquiries = inqsRes?.data;
  if (inquiries && inquiries.length > 0) {
    const foundInq = inquiries.find(
      (inq) => (inq.id || '').toUpperCase().startsWith(clean)
    );
    if (foundInq) {
      const inqStatus = (foundInq.status || '').toLowerCase().trim();
      let derivedStage = 'new_inquiry';
      if (['confirmed', 'saved', 'processed', 'qualified'].includes(inqStatus)) {
        derivedStage = 'qualified';
      } else if (['quoted', 'quotation_sent'].includes(inqStatus)) {
        derivedStage = 'quoted';
      } else if (inqStatus === 'negotiation') {
        derivedStage = 'negotiation';
      } else if (inqStatus === 'won') {
        derivedStage = 'won';
      } else if (inqStatus === 'lost') {
        derivedStage = 'lost';
      } else {
        derivedStage = 'new_inquiry';
      }

      let cName = foundInq.sender_name;
      if (!cName || isInvalidCustomerName(cName)) {
        const rawFirstLine = (foundInq.raw_text || '').split('\n')[0];
        const matchComp = rawFirstLine.match(/^([A-Za-z0-9\s&.,'-]+?)(?:\s+requires|\s+needs|\s+inquiry|\s+order|\s+deal|:|-|$)/i);
        cName = matchComp ? matchComp[1].trim() : 'Customer';
      }

      return {
        id: foundInq.id,
        inquiry_id: foundInq.id,
        is_inquiry_source: true,
        stage: derivedStage,
        customer_name: cName,
        total_amount: 0,
        deal_items: [],
        salesperson_phone: foundInq.sender_phone || senderPhone,
        raw_inquiry: foundInq,
      };
    }
  }

  return null;
}

function getPhoneVariants(phone) {
  if (!phone) return [];
  const digits = String(phone).replace(/\D/g, '');
  const variants = new Set();
  if (digits.length >= 10) {
    const last10 = digits.slice(-10);
    variants.add(last10);
    variants.add('91' + last10);
  }
  return Array.from(variants);
}

async function getAllOpenDealsForCustomer(customerName, senderPhone) {
  if (!customerName) return [];
  const { getAccessibleSalespersonPhonesForBot } = require('../supabase');
  const scope = senderPhone
    ? await getAccessibleSalespersonPhonesForBot(senderPhone)
    : { phones: null };

  let query = supabase
    .from('deals')
    .select('*, deal_items(*)')
    .ilike('customer_name', `%${customerName}%`)
    .not('stage', 'in', '("won","lost")')
    .order('created_at', { ascending: false });

  if (scope.phones !== null) {
    const allPhones = new Set();
    for (const p of scope.phones) {
      getPhoneVariants(p).forEach((pv) => allPhones.add(pv));
    }
    if (senderPhone) {
      getPhoneVariants(senderPhone).forEach((pv) => allPhones.add(pv));
    }
    const phoneList = Array.from(allPhones);
    if (phoneList.length > 0) {
      query = query.in('salesperson_phone', phoneList);
    } else {
      return [];
    }
  }

  const { data } = await query;
  return data || [];
}

async function findBestDeal(customerName, senderPhone) {
  const { data: ownActive } = await supabase
    .from('deals')
    .select('*, deal_items(*)')
    .ilike('customer_name', `%${customerName}%`)
    .eq('salesperson_phone', senderPhone)
    .not('stage', 'in', '("won","lost")')
    .order('created_at', { ascending: false })
    .limit(1);

  if (ownActive && ownActive.length > 0) return ownActive[0];

  const { data: ownAny } = await supabase
    .from('deals')
    .select('*, deal_items(*)')
    .ilike('customer_name', `%${customerName}%`)
    .eq('salesperson_phone', senderPhone)
    .order('created_at', { ascending: false })
    .limit(1);

  return ownAny && ownAny.length > 0 ? ownAny[0] : null;
}

async function getDealAmountFromItems(dealId) {
  const { data: items } = await supabase
    .from('deal_items')
    .select('amount, quantity, rate')
    .eq('deal_id', dealId);

  if (!items || items.length === 0) return 0;

  return items.reduce((total, item) => {
    const itemAmount = Number(item.amount) || (Number(item.quantity || 0) * Number(item.rate || 0));
    return total + itemAmount;
  }, 0);
}

async function isKRA1AlreadyLogged(senderPhone, customerName) {
  const { data } = await supabase
    .from('kra_logs')
    .select('id')
    .eq('salesperson_phone', senderPhone)
    .eq('kra_number', 1)
    .ilike('customer_name', `%${customerName}%`)
    .limit(1);

  return data && data.length > 0;
}

const {
  extractDimensions,
  calculateLineItem,
  calculateLineItems,
  calculateSubtotal,
  calculateGst,
  calculateGrandTotal,
  calculatePricingSummary,
} = require('../utils/pricingEngine');

/**
 * Evaluates mandatory fields for inquiry completion.
 */
function evaluateMandatoryFields({ customerName, lineItems, deliveryLocation, paymentTerms, totalAmount }) {
  const missing = [];

  const hasCompany = !!(customerName && customerName.trim().length >= 2 && customerName !== 'Unknown');
  if (!hasCompany) missing.push('Company Name');

  const items = Array.isArray(lineItems) ? lineItems : [];
  const validItems = items.filter(i => {
    const pName = (i.pName || i.sku_text || i.product_requirement || '').trim();
    return pName.length > 0 && !/^(steel requirement|product requirement|steel|material|requirement|inquiry|unknown|item|null|undefined)$/i.test(pName);
  });
  const hasProduct = validItems.length > 0;
  if (!hasProduct) missing.push('Product Description');

  const hasSpec = validItems.some(i => (i.dimensions && String(i.dimensions).trim().length > 0));
  if (!hasSpec) missing.push('Specification / Dimensions');

  const hasQty = validItems.some(i => (Number(i.qty || i.quantity || i.quantity_mt) > 0));
  if (!hasQty) missing.push('Quantity & Unit');

  const hasRate = validItems.some(i => (Number(i.rate || i.rate_per_mt) > 0)) || (Number(totalAmount) > 0);
  if (!hasRate) missing.push('Rate (₹)');

  const hasDelivery = !!(deliveryLocation && String(deliveryLocation).trim().length >= 2);
  if (!hasDelivery) missing.push('Delivery Location');

  const hasPayment = !!(paymentTerms && String(paymentTerms).trim().length >= 2);
  if (!hasPayment) missing.push('Payment Terms');

  return {
    isComplete: missing.length === 0,
    missingFields: missing,
    hasProduct,
    hasSpec,
    hasCompany,
    hasQty,
    hasRate,
    hasDelivery,
    hasPayment,
  };
}

/**
 * Main text message handler.
 */
async function processSalesMessage(text, senderPhone, overrideData = null) {
  try {
    // 0. Check if this is an explicit request to send / email a quotation or answering email prompt
    const isQuotationSend =
      /\b(?:send|mail|email|forward|share|dispatch)\b.*?\b(?:quotation|quote|pdf)\b/i.test(text) ||
      /\b(?:quotation|quote)\b.*?\b(?:bhejo|bhej|send|mail|email|share|forward)\b/i.test(text) ||
      (/\b(?:send\s+to|mail\s+to|email\s+to)\b/i.test(text) && /\b(?:quotation|quote)\b/i.test(text));

    const { getFullActiveSession } = require('../supabase');
    const activeSess = await getFullActiveSession(senderPhone);
    const isWaitingEmail = activeSess?.last_intent === 'waiting_for_quotation_email';
    const hasEmailInText = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i.test(text);

    if (isQuotationSend || (isWaitingEmail && hasEmailInText)) {
      return await handleSendQuotationMessage(text, senderPhone);
    }

    let data = (typeof overrideData === 'object' && overrideData !== null) ? overrideData : null;

    if (!data) {
      let effectiveTextForLLM = text;
      const isShortConfirmation = /^(?:yes|correct|confirm|proceed|haan?|sahi\s+hai|update\s+(?:it|this|deal|inquiry)|ok|okay|yep|sure|ha|1|option\s*1)\b/i.test((text || '').trim());

      if (isShortConfirmation) {
        try {
          const { getRawChatHistory } = require('../core/memory');
          const history = await getRawChatHistory(senderPhone);
          for (let i = history.length - 1; i >= 0; i--) {
            const hMsg = history[i];
            if (hMsg.role === 'user' && hMsg.content && hMsg.content.trim() !== text.trim()) {
              const hContent = hMsg.content;
              const hasProdOrRateInHistory = /\b(mt|tons?|kg|sheet|plate|coil|beam|channel|pipe|angle|bar|tmt|rate|price|rs|₹|@)\b/i.test(hContent);
              if (hasProdOrRateInHistory) {
                effectiveTextForLLM = `${hContent}\n\nConfirmed: ${text}`;
                break;
              }
            }
          }
        } catch (histErr) {
          console.warn('[SalesAgent] History lookup notice:', histErr.message);
        }
      }

      const isStageOrStatusUpdate = /\b(?:mark|move|update|set|change|status|stage|negotiation|won|lost|quoted|qualified)\b/i.test(effectiveTextForLLM);
      if (!isStageOrStatusUpdate) {
        const invalidUnitCheck = detectInvalidUnitInMessage(effectiveTextForLLM);
        if (invalidUnitCheck) {
          return `*Invalid Quantity Unit*\n\n` +
            `You specified *${invalidUnitCheck.number} ${invalidUnitCheck.invalidUnit}*.\n\n` +
            `Metal products cannot be measured in *"${invalidUnitCheck.invalidUnit}"*.\n\n` +
            `Please specify the quantity using a valid unit (e.g. *15 MT*, *1500 Kg*, *100 Sheets*, or *50 Pcs*).`;
        }
      }

      // ── LATENCY OPTIMIZATION: FAST-PATH RULE EXTRACTOR FOR PURE STAGE UPDATES ──
      const textRaw = effectiveTextForLLM || text || '';
      const isClearStageUpdate =
        /\b(?:mark|move|update|set|change)\b.*?\b(?:deal\s+)?(?:as\s+|to\s+)?(won|lost|quoted|negotiation|qualified)\b/i.test(textRaw) ||
        /\b(?:status|stage)\b.*?\b(negotiation|qualified|quoted|won|lost)\b/i.test(textRaw) ||
        /\b(?:deal|inquiry)\s+(?:is\s+|moved\s+to\s+|marked\s+as\s+)?(won|lost|quoted|negotiation|qualified)\b/i.test(textRaw);

      const hasLineItemKeywords = /\b(mt|ton|tons|tonne|kg|kgs|sheet|sheets|plate|plates|coil|coils|pipe|pipes|beam|beams|angle|angles|channel|channels|bar|bars|tmt|dia|gauge|thk)\b/i.test(textRaw);

      if (isClearStageUpdate && !hasLineItemKeywords) {
        let ruleDealId = null;
        const dealIdMatch = textRaw.match(/#?(DEAL-[A-Za-z0-9_-]+|INQ-[A-Za-z0-9_-]+|[A-Fa-f0-9]{6})/i);
        if (dealIdMatch) {
          ruleDealId = dealIdMatch[1].toUpperCase();
        }

        let ruleCustomer = null;
        const structComp = textRaw.match(/(?:company\s+name|customer\s+name|client\s+name)\s*[:=-]\s*([^\n\r]+)/i);
        if (structComp) {
          ruleCustomer = structComp[1].trim().replace(/^['"]|['"]$/g, '');
        } else {
          const custMatch =
            textRaw.match(/\b(?:mark|move|update|set|change)\s+(?:the\s+|this\s+)?(?:status\s+to\s+\w+\s+for\s+(?:deal\s+id\s+[\w-]+\s+for\s+)?(?:customer\s+)?)?([A-Z0-9\s&.-]{2,40}?)\s+(?:deal\s+)?(?:as\s+|to\s+)?(won|lost|quoted|negotiation|qualified)\b/i) ||
            textRaw.match(/(?:for\s+customer\s+|for\s+)([A-Z0-9\s&.-]{2,40}?)(?:\s+deal|\s+to|\.|$)/i) ||
            textRaw.match(/\b(?:mark|move|update|set|change)\s+(?:the\s+|this\s+)?([A-Z0-9\s&.-]{2,40}?)\s+(?:deal\s+)?/i);
          if (custMatch && custMatch[1]) {
            const cand = custMatch[1].trim();
            if (!['the', 'this', 'that', 'a', 'an', 'deal', 'customer', 'status', 'stage'].includes(cand.toLowerCase())) {
              ruleCustomer = cand;
            }
          }
        }

        let ruleStage = 'new_inquiry';
        const stageMatch = textRaw.match(/\b(negotiation|won|lost|quoted|qualified)\b/i);
        if (stageMatch) {
          ruleStage = stageMatch[1].toLowerCase();
        }

        data = {
          action: 'stage_update',
          deal_id: ruleDealId,
          customer_name: ruleCustomer,
          contact_person: null,
          target_stage: ruleStage,
          customer_phone: null,
          line_items: [],
          total_amount: 0,
          delivery_location: null,
          payment_terms: null,
          delivery_date: null,
          confidence: 1.0,
        };
      } else {
        try {
          const { invokeWithFallback } = require('../core/modelRouter');
          const response = await invokeWithFallback([
            new SystemMessage(SALES_AGENT_PROMPT),
            new HumanMessage('Salesperson message:\n' + effectiveTextForLLM),
          ]);
          const rawText = typeof response.content === 'string' ? response.content : JSON.stringify(response.content || '');
          const { safeParseJSON } = require('../utils/jsonUtils');
          data = safeParseJSON(rawText, null);
        } catch (llmErr) {
          console.warn('[SalesAgent] LLM extraction notice, utilizing rule-based engine:', llmErr.message);
        }
      }

      if (!data || data.confidence < 0.3) {
        const textRaw = effectiveTextForLLM || text || '';
        const textClean = textRaw.replace(/#?(?:DEAL-[A-F0-9]{4,6}|[A-F0-9]{6})\b/gi, '').replace(/\s+/g, ' ');
        const textLower = textClean.toLowerCase();

        let ruleDealId = null;
        const dealIdMatch = textRaw.match(/#?(DEAL-[A-F0-9]{4,6}|INQ-[A-F0-9]{4,6}|[A-F0-9]{6})/i);
        if (dealIdMatch) {
          ruleDealId = dealIdMatch[1].toUpperCase();
        }

        let ruleCustomer = null;
        const structComp = textRaw.match(/(?:company\s+name|customer\s+name|client\s+name)\s*[:=-]\s*([^\n\r]+)/i);
        if (structComp) {
          ruleCustomer = structComp[1].trim().replace(/^['"]|['"]$/g, '');
        } else {
          const reqMatch = textClean.match(/(?:inquiry\s+for|order\s+for|deal\s+for|quote\s+for|requirement\s+for|for)\s+([A-Z0-9\s&.-]{2,40}?)(?:\s+\d+\s*(?:mt|ton|tons|tonne|kg|pcs|sheet|sheets|plate|plates|mm|coil|coils|bar|bars)|\s+requires|\s+needs|\s+before|\.|$)/i) ||
            textClean.match(/(?:inquiry\s+from|order\s+from|rfq\s+from|from)\s+([A-Z0-9\s&.-]{2,40}?)(?:\s+requires|\s+needs|\s+for|\s+before|\.|$)/i) ||
            textClean.match(/\b(?:mark|move|update|set|change)\s+(?:the\s+|this\s+)?([A-Z0-9\s&.-]{2,40}?)\s+(?:deal\s+)?(?:as\s+|to\s+)?(won|lost|quoted|negotiation|qualified)\b/i) ||
            textClean.match(/^(?!new\b|log\b|create\b|add\b)([A-Z0-9\s&.-]{2,40}?)\s+(?:requires|require|needs|need|inquiry|rfq|po|order|want)\b/i) ||
            textClean.match(/(?:customer|company|client|pvt\.?\s*ltd\.?|ltd\.?|infra|steel|engineering|industries)\s+([A-Z0-9\s&.-]{3,35})/i);
          if (reqMatch) {
            const cand = reqMatch[1].trim();
            if (!['new', 'log', 'create', 'add', 'a', 'the', 'this', 'that', 'deal', 'customer', 'unknown', 'max'].includes(cand.toLowerCase())) {
              ruleCustomer = cand;
            }
          }
        }

        let ruleAction = 'inquiry';
        let ruleStage = 'new_inquiry';
        const stageUpdateMatch = textClean.match(/\b(?:mark|move|update|set|change)\s+(?:the\s+|this\s+)?(?:deal\s+)?(?:as\s+|to\s+)?(won|lost|quoted|negotiation|qualified)\b/i) ||
          textClean.match(/\b(?:deal|inquiry)\s+(?:is\s+|moved\s+to\s+|marked\s+as\s+)?(won|lost|quoted|negotiation|qualified)\b/i) ||
          textClean.match(/\b(won|lost|quoted|negotiation|qualified)\b/i);

        if (stageUpdateMatch) {
          ruleAction = 'stage_update';
          ruleStage = stageUpdateMatch[1].toLowerCase();
        }

        // Check multi-item rate update list e.g. "MS Sheet 5MM THK - 10\nMS Sheet 6MM THK - 15"
        const multiItemsParsed = [];
        const isRateUpdateContext =
          /\b(upadte|updt|updte|update|set|new|give)\s+(?:the\s+)?(?:rates?|prices?)|(?:rates?|prices?)\s+for|rates?:/i.test(textRaw) ||
          /\b(?:rates?|prices?)\b/i.test(textRaw);
        if (isRateUpdateContext) {
          ruleAction = 'deal_update';
          const lines = textRaw.split('\n');
          for (const line of lines) {
            const cleanLine = line.trim();
            if (
              !cleanLine ||
              /^(?:upadte|updt|updte|update|rates|prices|for|customer|company|deal|inquiry)\b/i.test(cleanLine) ||
              /#?(?:DEAL|INQ)-[A-F0-9]{4,6}\b/i.test(cleanLine) ||
              /deal\s+id/i.test(cleanLine)
            ) continue;
            const lineMatch = cleanLine.match(/^([A-Za-z0-9\s.,()x/]+?)\s*[-:=@]\s*₹?\s*([\d,.]+)\s*$/i);
            if (lineMatch) {
              const prodCandidate = lineMatch[1].trim();
              const rateVal = parseFloat(lineMatch[2].replace(/,/g, ''));
              if (prodCandidate && rateVal > 0) {
                const mmM = prodCandidate.match(/(\d+(?:\.\d+)?\s*(?:mm|g|gauge|dia|ø|inch|ft|x\s*[\d.]+)+)/i);
                multiItemsParsed.push({
                  product_requirement: prodCandidate,
                  dimensions: mmM ? mmM[0] : null,
                  quantity: 0,
                  quantity_mt: 0,
                  unit: 'MT',
                  rate_per_mt: rateVal,
                });
              }
            }
          }
        }

        // Check multi-item TMT list e.g. "8mm - 5 MT, 10mm - 10 MT, 12mm - 15 MT"
        const tmtMultiRegex = /(\d+(?:\.\d+)?\s*mm)\s*(?:[-:]|–)?\s*(\d+(?:\.\d+)?)\s*(mt|ton|tons|tonne|kg|bundles|pcs)?/gi;
        let tmtM;
        while ((tmtM = tmtMultiRegex.exec(textRaw)) !== null) {
          multiItemsParsed.push({
            product_requirement: 'TMT Bar',
            dimensions: tmtM[1].replace(/\s+/g, ''),
            quantity_mt: parseFloat(tmtM[2]),
            quantity: parseFloat(tmtM[2]),
            unit: tmtM[3] ? tmtM[3].toUpperCase() : 'MT',
            rate_per_mt: null,
          });
        }

        let qty = 0;
        let unit = 'MT';
        const structQty = textRaw.match(/(?:quantity|qty)\s*[:=-]\s*(\d+(?:\.\d+)?)\s*([a-zA-Z]+)?/i);
        if (structQty) {
          qty = parseFloat(structQty[1]);
          if (structQty[2]) unit = structQty[2];
        } else {
          const qtyMatch = textRaw.match(/(\d+(?:\.\d+)?)\s*(mt|ton|tons|tonne|kg|kgs|pcs|piece|pieces|nos|sheet|sheets|plate|plates|coil|coils|bar|bars|lengths|bundles)/i);
          if (qtyMatch) {
            qty = parseFloat(qtyMatch[1]);
            unit = qtyMatch[2];
          }
        }

        let specDim = null;
        const structSpec = textRaw.match(/(?:grade\/spec|spec|dimensions?|thickness|size)\s*[:=-]\s*([^\n\r]+)/i);
        if (structSpec) {
          specDim = structSpec[1].trim();
        } else {
          const ismbMatch = textRaw.match(/\b(ismb\s*\d+|ismc\s*\d+|npb\s*[\dx]+|wpb\s*[\dx]+|uc\s*[\dx]+|ub\s*[\dx]+)\b/i);
          const mmM = textRaw.match(/(\d+(?:\.\d+)?\s*(?:mm|g|gauge|dia|ø|inch|ft|x\s*\d+)+)/i);
          const boxSizeM = textRaw.match(/(\d+\s*x\s*\d+(?:\s*x\s*[\d.]+)?\s*mm)/i);
          specDim = ismbMatch ? ismbMatch[0].toUpperCase() : (boxSizeM ? boxSizeM[0] : (mmM ? mmM[0] : null));
        }

        let pReq = null;
        const structMat = textRaw.match(/(?:material|product(?:\s+name)?|product(?:\s+description)?|item)\s*[:=-]\s*([^\n\r]+)/i);
        if (structMat) {
          const mVal = structMat[1].trim();
          pReq = specDim && !mVal.toLowerCase().includes(specDim.toLowerCase()) ? `${mVal} ${specDim}` : mVal;
        } else if (/\b(hrpo|pickled\s*&\s*oiled)\b/i.test(textLower)) {
          pReq = 'HRPO Coil';
        } else if (/\b(hr\s*coil|hot\s*rolled\s*coil)\b/i.test(textLower)) {
          pReq = 'HR Coil';
        } else if (/\b(cr\s*coil|cold\s*rolled\s*coil|crca)\b/i.test(textLower)) {
          pReq = 'CR Coil';
        } else if (/\b(cr\s*sheet|cold\s*rolled\s*sheet)\b/i.test(textLower)) {
          pReq = 'CR Sheet';
        } else if (/\b(chequered|checkered)\s*(?:plate|sheet)?\b/i.test(textLower)) {
          pReq = 'Chequered Plate';
        } else if (/\b(ms\s*plate|plates|bq\s*plate|boiler\s*plate|hardox)\b/i.test(textLower)) {
          pReq = 'MS Plate';
        } else if (/\b(ms\s*sheet)\b/i.test(textLower)) {
          pReq = 'MS Sheet';
        } else if (/\b(round\s*bar|bright\s*bar|en8|en19|round\s*rod)\b/i.test(textLower)) {
          pReq = 'MS Round Bar';
        } else if (/\b(square\s*pipe|box\s*pipe|shs|square\s*tube|rectangular\s*pipe|rhs)\b/i.test(textLower)) {
          pReq = 'MS Square Pipe';
        } else if (/\b(angle|angles|equal\s*angle|unequal\s*angle|l-angle)\b/i.test(textLower)) {
          pReq = 'MS Angle';
        } else if (/\b(beam|beams|ismb|joist|i-beam|h-beam|girder|npb|wpb)\b/i.test(textLower)) {
          pReq = 'MS Beam';
        } else if (/\b(channel|channels|ismc|c-channel)\b/i.test(textLower)) {
          pReq = 'MS Channel';
        } else if (/\b(tmt\s*bar|tmt|sariya|rebar)\b/i.test(textLower)) {
          pReq = 'TMT Bar';
        }

        let ruleRate = null;
        const structPrice = textRaw.match(/(?:target\s+price|rate|price|unit\s+price)\s*(?::|is|=|-|\s)\s*₹?\s*([\d,.]+)(?:\s*\/\s*[a-zA-Z]+)?/i) ||
          textRaw.match(/@\s*₹?\s*([\d,.]+)/i);
        if (structPrice) {
          ruleRate = Number(structPrice[1].replace(/,/g, '')) || null;
        }

        let rulePayment = null;
        const structPay = textRaw.match(/(?:payment\s*terms?|payment|credit\s*terms?)\s*[:=-]\s*([^\n\r,]+)/i);
        if (structPay) {
          rulePayment = structPay[1].trim();
        } else if (/\b(?:30|45|60|90)\s*days?\s*(?:credit)?\b/i.test(textRaw)) {
          const matchDays = textRaw.match(/\b(30|45|60|90)\s*days?\s*(?:credit)?\b/i);
          rulePayment = `${matchDays[1]} Days Credit`;
        } else if (/\b100%\s*advance|advance\b/i.test(textRaw)) {
          rulePayment = '100% Advance';
        }

        let ruleContact = null;
        const structContact = textRaw.match(/(?:contact\s+person|contact|owner|person|attn)\s*[:=-]\s*([^\n\r]+)/i);
        if (structContact) {
          ruleContact = structContact[1].trim().replace(/^['"]|['"]$/g, '');
        }

        let rulePhone = null;
        const structPhone = textRaw.match(/(?:phone|mobile|contact\s+no|cell)\s*[:=-]\s*([6-9]\d{9})\b/i);
        if (structPhone) {
          rulePhone = structPhone[1];
        } else {
          const phoneMatch = textRaw.match(/(?:number|phone|mobile|contact|cell)?\s*(?:is|:|-)?\s*([6-9]\d{9})\b/i);
          rulePhone = phoneMatch ? phoneMatch[1] : null;
        }

        let delLoc = extractDeliveryLocation(textRaw);

        let finalLineItems = [];
        if (multiItemsParsed.length > 0) {
          finalLineItems = multiItemsParsed;
        } else if (pReq) {
          finalLineItems = [{
            product_requirement: pReq,
            dimensions: specDim,
            quantity_mt: qty,
            quantity: qty,
            unit: unit,
            rate_per_mt: ruleRate,
          }];
        }

        data = {
          action: ruleAction,
          deal_id: ruleDealId,
          customer_name: ruleCustomer,
          contact_person: ruleContact,
          target_stage: ruleStage,
          customer_phone: rulePhone,
          line_items: finalLineItems,
          total_amount: 0,
          delivery_location: delLoc,
          payment_terms: rulePayment,
          delivery_date: null,
          confidence: 0.9,
        };
      }
    }

    // ── CONTEXT RESOLUTION FOR EXPLICIT DEAL ID & ACTIVE SESSIONS ──────────
    const explicitDealIdMatch = text.match(/#?(?:DEAL|INQ)-([A-Za-z0-9_-]+)/i) || text.match(/#([A-Fa-f0-9]{6})\b/i);
    let targetExplicitDeal = null;
    if (explicitDealIdMatch || data.deal_id) {
      const dealCodeToFind = (explicitDealIdMatch ? explicitDealIdMatch[1] : data.deal_id);
      targetExplicitDeal = await findDealByCodeOrId(dealCodeToFind, senderPhone);
      if (!targetExplicitDeal && explicitDealIdMatch) {
        return `❌ Deal ID #${dealCodeToFind.toUpperCase()} was not found in our records. Please check the Deal ID and try again.`;
      }
    }

    let customerName = data.customer_name;
    if (isInvalidCustomerName(customerName)) {
      customerName = null;
    }

    if (!customerName && targetExplicitDeal) {
      customerName = targetExplicitDeal.customer_name;
    }

    // If still no customer name in message, check active conversation session or recent active deal
    if (!customerName) {
      const activeSessionCustomer = await getActiveSession(senderPhone);
      if (activeSessionCustomer && !isInvalidCustomerName(activeSessionCustomer)) {
        customerName = activeSessionCustomer;
      } else {
        const { data: recentDeals } = await supabase
          .from('deals')
          .select('*, deal_items(*)')
          .eq('salesperson_phone', senderPhone)
          .not('stage', 'in', '("won","lost")')
          .order('created_at', { ascending: false })
          .limit(1);

        if (recentDeals && recentDeals.length > 0) {
          targetExplicitDeal = recentDeals[0];
          customerName = recentDeals[0].customer_name;
        }
      }
    }

    // Check line items & product name extraction
    let rawItems = [];
    if (Array.isArray(data.line_items) && data.line_items.length > 0) {
      rawItems = data.line_items;
    } else if (data.product_requirement || data.quantity_mt || data.quantity) {
      rawItems = [{
        product_requirement: data.product_requirement,
        dimensions: data.dimensions || null,
        quantity: data.quantity || data.quantity_mt || 0,
        quantity_mt: data.quantity_mt || data.quantity || 0,
        unit: data.unit || 'MT',
        rate_per_mt: data.rate_per_mt || null,
      }];
    }

    const GENERIC_PRODUCT_REGEX = /^(steel requirement|product requirement|steel|material|requirement|inquiry|unknown|item|null|undefined)$/i;

    let processedItems = [];
    let calculatedTotal = 0;

    for (const item of rawItems) {
      let pName = item.product_requirement ? item.product_requirement.trim() : null;
      if (pName && GENERIC_PRODUCT_REGEX.test(pName)) {
        pName = null;
      }

      const qty = Number(item.quantity || item.quantity_mt || item.qty || 0) || 0;
      const unit = item.unit || 'MT';
      const rawRate = item.rate_per_mt !== undefined && item.rate_per_mt !== null && item.rate_per_mt !== '' ? Number(item.rate_per_mt) : (item.rate ? Number(item.rate) : null);
      const rate = rawRate && rawRate > 0 ? rawRate : null;
      const rawDim = item.dimensions || (pName?.match(/(\d+(?:\.\d+)?)\s*mm/i) ? pName.match(/(\d+(?:\.\d+)?)\s*mm/i)[1] + ' mm' : (text.match(/(\d+(?:\.\d+)?)\s*mm/i) ? text.match(/(\d+(?:\.\d+)?)\s*mm/i)[1] + ' mm' : null));

      if (pName) {
        if (qty > 0 && rate && rate > 0) {
          const lineCalc = calculateLineItem({ quantity: qty, rate, unit });
          calculatedTotal += lineCalc.amount;
          processedItems.push({
            pName,
            dimensions: rawDim,
            qty,
            unit,
            rate: lineCalc.rate || rate,
            itemAmount: lineCalc.amount,
          });
        } else {
          processedItems.push({
            pName,
            dimensions: rawDim,
            qty,
            unit,
            rate: rate || null,
            itemAmount: null,
          });
        }
      }
    }

    const hasAnyProductName = processedItems.length > 0;
    const extractedDeliveryLoc = extractDeliveryLocation(text);
    const hasDeliveryUpdate = !!(extractedDeliveryLoc || data.delivery_location);
    const hasPaymentUpdate = !!data.payment_terms;
    const hasRateUpdate = !!(data.line_items?.some(i => i.rate_per_mt > 0) || (data.total_amount && data.total_amount > 0));
    const hasQtyUpdate = !!(rawItems.some(i => (i.quantity > 0 || i.quantity_mt > 0)));

    // ── STAGE UPDATE HANDLER (e.g. "mark the deal as won", "deal is lost", "mark as negotiation") ───
    const isExplicitStageUpdate = data.action === 'stage_update' ||
      (data.target_stage && ['negotiation', 'won', 'lost', 'quoted', 'qualified'].includes(data.target_stage)) ||
      /\b(?:mark|move|update|set|change)\b.*?\b(negotiation|won|lost|quoted|qualified)\b/i.test(text) ||
      /\b(?:deal|inquiry)\s+(?:is\s+|moved\s+to\s+|marked\s+as\s+)?(negotiation|won|lost|quoted|qualified)\b/i.test(text);

    if (isExplicitStageUpdate) {
      let targetStageName = data.target_stage;
      if (!targetStageName || targetStageName === 'new_inquiry') {
        const stageMatch = text.match(/\b(negotiation|won|lost|quoted|qualified)\b/i);
        if (stageMatch) {
          targetStageName = stageMatch[1].toLowerCase();
        }
      }

      if (targetStageName === 'quoted' || text.toLowerCase().includes('quoted')) {
        return await handleSendQuotationMessage(text, senderPhone);
      }

      const stageMap = {
        new_inquiry: 'new_inquiry',
        won: 'won',
        lost: 'lost',
        negotiation: 'negotiation',
        qualified: 'qualified',
        quoted: 'quoted',
      };
      const dbStage = stageMap[targetStageName] || 'new_inquiry';

      let dealToUpdate = targetExplicitDeal;
      if (!dealToUpdate && customerName) {
        const openDeals = await getAllOpenDealsForCustomer(customerName, senderPhone);
        if (openDeals.length > 0) {
          dealToUpdate = openDeals[0];
        } else {
          dealToUpdate = await findBestDeal(customerName, senderPhone);
        }
      }

      if (!dealToUpdate) {
        return `Which deal would you like to mark as *${dbStage.toUpperCase()}*? Please provide the Deal ID (e.g. #DEAL-XXXXXX) or customer name.`;
      }

      const currentStage = (dealToUpdate.stage || 'new_inquiry').toLowerCase().trim();

      // Stage Gate 1: If deal is in New Inquiry stage, no status updates allowed
      if (['new_inquiry', 'review', 'auto_created', 'pending', 'draft', 'needs_review'].includes(currentStage)) {
        return `This deal is currently in New Inquiry stage. It must be moved to Qualified before it can be updated further. Please save the deal first.`;
      }

      // Stage Gate 2: If deal is in Qualified stage, must move to Negotiation or Quoted first before Won/Lost
      if (currentStage === 'qualified' && (dbStage === 'won' || dbStage === 'lost')) {
        return `This deal must go through Negotiation or Quoted stage before it can be marked as Won or Lost.`;
      }

      // Stage Gate 3: If deal is already closed
      if (currentStage === 'won' || currentStage === 'lost') {
        return `This deal is already marked as ${currentStage.toUpperCase()} and cannot be updated further.`;
      }

      const dealCode = getDealCode(dealToUpdate);

      if (dealToUpdate.is_inquiry_source) {
        // Insert pipeline deal in deals table linked to this inquiry
        const newDealPayload = {
          inquiry_id: dealToUpdate.inquiry_id,
          stage: dbStage,
          customer_name: dealToUpdate.customer_name,
          salesperson_phone: senderPhone || dealToUpdate.salesperson_phone,
          total_amount: dealToUpdate.total_amount || 0,
          status: dbStage,
          created_at: new Date().toISOString(),
        };
        if (dbStage === 'won') {
          newDealPayload.won_at = new Date().toISOString();
          if (data.po_number) newDealPayload.po_number = data.po_number;
        }
        if (dbStage === 'lost' && data.loss_reason) {
          newDealPayload.lost_reason = data.loss_reason;
        }

        const { data: insertedDeals, error: insErr } = await supabase
          .from('deals')
          .insert(newDealPayload)
          .select('*, deal_items(*)');

        if (insErr || !insertedDeals || insertedDeals.length === 0) {
          throw new Error(`Failed to create pipeline deal: ${insErr?.message || 'DB write error'}`);
        }

        dealToUpdate = insertedDeals[0];

        // Update inquiries table status
        const inqStatus = dbStage === 'won' ? 'confirmed' : dbStage;
        await supabase.from('inquiries').update({ status: inqStatus }).eq('id', dealToUpdate.inquiry_id);
      } else {
        // Update existing deals record
        const updatePayload = {
          stage: dbStage,
          status: dbStage,
        };
        if (dbStage === 'won') {
          updatePayload.won_at = new Date().toISOString();
          if (data.po_number) updatePayload.po_number = data.po_number;
        }
        if (dbStage === 'lost' && data.loss_reason) {
          updatePayload.lost_reason = data.loss_reason;
        }

        const { data: updatedDeals, error: updErr } = await supabase
          .from('deals')
          .update(updatePayload)
          .eq('id', dealToUpdate.id)
          .select('*, deal_items(*)');

        if (updErr || !updatedDeals || updatedDeals.length === 0 || updatedDeals[0].stage !== dbStage) {
          throw new Error(`Failed to update deal stage: ${updErr?.message || 'DB stage verification mismatch'}`);
        }

        dealToUpdate = updatedDeals[0];

        if (dealToUpdate.inquiry_id) {
          const inqStatus = dbStage === 'won' ? 'confirmed' : dbStage;
          await supabase.from('inquiries').update({ status: inqStatus }).eq('id', dealToUpdate.inquiry_id);
        }
      }

      // Mandatory Database Write Verification
      const { data: verifiedDeals, error: verifyErr } = await supabase
        .from('deals')
        .select('id, stage, customer_name, inquiry_id')
        .eq('id', dealToUpdate.id);

      if (verifyErr || !verifiedDeals || verifiedDeals.length === 0 || verifiedDeals[0].stage !== dbStage) {
        throw new Error(`Database write verification failed: deal stage is not ${dbStage} in Supabase.`);
      }

      await saveActiveSession(senderPhone, dealToUpdate.customer_name, 'deal_stage_update');

      try {
        logBotActivity({
          salesperson_phone: senderPhone,
          description: `Deal ${dealCode} for ${dealToUpdate.customer_name} moved to ${dbStage.toUpperCase()}`,
          module: 'Pipeline',
          customer_name: dealToUpdate.customer_name,
        });
      } catch (actErr) {
        console.warn('[SalesAgent] Activity log notice:', actErr?.message);
      }

      if (dbStage === 'won') {
        return `*DEAL WON & ORDER CONFIRMED!*\n\n` +
          `Customer: *${dealToUpdate.customer_name}*\n` +
          `Deal ID: *${dealCode}*\n` +
          (dealToUpdate.po_number ? `Official PO Number: *${dealToUpdate.po_number}*\n` : '') +
          `Total Value: *Rs. ${Number(dealToUpdate.total_amount || 0).toLocaleString('en-IN')}*\n\n` +
          `Updated Sales Achievement Card! 🏆`;
      }

      return `*Deal Updated - ${dealCode}*\n\n` +
        `Customer: *${dealToUpdate.customer_name}*\n` +
        `Stage: *${dbStage.toUpperCase()}*\n\n` +
        `Deal successfully moved to *${dbStage.toUpperCase()}* in Sales Pipeline! 📈`;
    }

    // ── SCENARIO 3: PARTIAL UPDATE WITHOUT PRODUCT NAME ────────────────────────
    // If NO product name is provided AND not explicitly a stage_update:
    if (!hasAnyProductName && data.action !== 'stage_update') {
      if (targetExplicitDeal) {
        // Handled below via Deal ID update path
      } else if (customerName) {
        const openDeals = await getAllOpenDealsForCustomer(customerName, senderPhone);
        if (openDeals.length === 1) {
          targetExplicitDeal = openDeals[0];
        } else if (openDeals.length > 1) {
          return `Which deal is this update for? Please provide the Deal ID (e.g. ${getDealCode(openDeals[0])}) or company name.`;
        } else {
          return `Which deal or inquiry is this update for? Please provide the Deal ID (e.g. #DEAL-XXXXXX) or company name.`;
        }
      } else {
        return `Which deal or inquiry is this for? Please provide the Deal ID (e.g. #DEAL-XXXXXX).`;
      }
    }

    // ── SCENARIO 4: UPDATE TO EXISTING DEAL (WITH DEAL ID OR AUTO-ASSUMED) ─────
    if (targetExplicitDeal && (explicitDealIdMatch || data.deal_id || !hasAnyProductName || data.action === 'deal_update' || isRateUpdateContext || hasRateUpdate)) {
      const dealId = targetExplicitDeal.id;
      const dealCode = getDealCode(targetExplicitDeal);
      const company = targetExplicitDeal.customer_name;

      const updateFields = {};
      const updatedLabels = [];

      if (extractedDeliveryLoc || data.delivery_location) {
        updateFields.delivery_location = extractedDeliveryLoc || data.delivery_location;
        updatedLabels.push(`Delivery Location (*${updateFields.delivery_location}*)`);
      }

      if (data.payment_terms) {
        updateFields.payment_terms = data.payment_terms;
        updatedLabels.push(`Payment Terms (*${updateFields.payment_terms}*)`);
      }

      if (data.delivery_date) {
        updateFields.delivery_date = data.delivery_date;
        updatedLabels.push(`Delivery Date (*${updateFields.delivery_date}*)`);
      }

      if (data.contact_person) {
        updateFields.contact_person = data.contact_person;
        updatedLabels.push(`Contact Person (*${updateFields.contact_person}*)`);
      }

      if (data.customer_phone) {
        updateFields.customer_phone = data.customer_phone;
      }

      if (data.total_amount && Number(data.total_amount) > 0) {
        updateFields.total_amount = Number(data.total_amount);
        updatedLabels.push(`Total Rate (Rs. *${Number(data.total_amount).toLocaleString('en-IN')}*)`);
      }

      // Update rate or qty on existing line items if provided
      let existingItems = targetExplicitDeal.deal_items || [];
      if (existingItems.length === 0) {
        const { data: dbItems } = await supabase
          .from('deal_items')
          .select('*')
          .eq('deal_id', dealId);
        if (dbItems && dbItems.length > 0) {
          existingItems = dbItems;
        }
      }
      let updatedDealItems = [];

      if (existingItems.length > 0 && (hasRateUpdate || hasQtyUpdate || processedItems.length > 0)) {
        const hasExplicitQtyInMsg = /\b\d+(?:\.\d+)?\s*(?:mt|tons?|tonne|kg|pcs|nos|sheets?|plates?|coils?|bars?)\b/i.test(
          text.replace(/rate\s+is\s+[\d,.]+/i, '')
              .replace(/@\s*[\d,.]+/i, '')
              .replace(/\b(?:rs|inr|\/mt|\/kg)\b/gi, '')
        );
        const firstRate = data.line_items?.[0]?.rate_per_mt || (processedItems[0]?.rate > 0 ? processedItems[0]?.rate : null);
        const firstQty = hasExplicitQtyInMsg
          ? (data.line_items?.[0]?.quantity || data.line_items?.[0]?.quantity_mt || (processedItems[0]?.qty > 0 ? processedItems[0]?.qty : null))
          : null;

        for (let idx = 0; idx < existingItems.length; idx++) {
          const itm = existingItems[idx];
          const matchedP = findMatchingProcessedItem(itm, processedItems, existingItems.length === processedItems.length ? idx : -1);
          const itemUpdates = {};
          const matchedRate = matchedP?.rate || (matchedP?.rate_per_mt) || (processedItems.length === 1 ? firstRate : null);
          const matchedQty = hasExplicitQtyInMsg ? (matchedP?.qty || (processedItems.length === 1 ? firstQty : null)) : null;

          if (matchedRate && Number(matchedRate) > 0) {
            itemUpdates.rate = Number(matchedRate);
            updatedLabels.push(`${itm.sku_text || 'Item'} Rate (*Rs. ${Number(matchedRate).toLocaleString('en-IN')}*)`);
          }
          if (matchedQty && Number(matchedQty) > 0) {
            itemUpdates.quantity = Number(matchedQty);
            updatedLabels.push(`${itm.sku_text || 'Item'} Qty (*${matchedQty} ${itm.unit || 'MT'}*)`);
          }
          const finalRate = itemUpdates.rate !== undefined ? itemUpdates.rate : itm.rate;
          const finalQty = itemUpdates.quantity !== undefined ? itemUpdates.quantity : itm.quantity;
          if (finalRate !== null && finalRate !== undefined && finalQty !== null && finalQty !== undefined) {
            itemUpdates.amount = Number(finalRate) * Number(finalQty);
          }
          if (Object.keys(itemUpdates).length > 0) {
            await supabase.from('deal_items').update(itemUpdates).eq('id', itm.id);
            updatedDealItems.push({ ...itm, ...itemUpdates });
          } else {
            updatedDealItems.push(itm);
          }
        }
      } else {
        updatedDealItems = existingItems;
      }

      const computedTotal = (updatedDealItems || []).reduce((s, i) => s + (Number(i.amount) || 0), 0);
      if (computedTotal > 0) {
        updateFields.total_amount = computedTotal;
      }

      // Keep stage unchanged (never auto-escalate to quoted on field updates)
      updateFields.stage = targetExplicitDeal.stage || 'new_inquiry';

      if (Object.keys(updateFields).length > 0) {
        await supabase.from('deals').update(updateFields).eq('id', dealId);
      }

      // Sync inquiries table ai_extraction_json
      const inqIdToSync = targetExplicitDeal.inquiry_id;
      if (inqIdToSync) {
        await syncInquiryFromDeal(inqIdToSync, { ...targetExplicitDeal, ...updateFields }, updatedDealItems);
      }

      await saveActiveSession(senderPhone, company, 'deal_update');

      // Refetch updated deal to check field completeness
      const { data: refreshedDealArr } = await supabase
        .from('deals')
        .select('*, deal_items(*)')
        .eq('id', dealId)
        .limit(1);

      const refreshedDeal = refreshedDealArr?.[0] || targetExplicitDeal;
      const completeness = evaluateMandatoryFields({
        customerName: refreshedDeal.customer_name,
        lineItems: refreshedDeal.deal_items || [],
        deliveryLocation: refreshedDeal.delivery_location,
        paymentTerms: refreshedDeal.payment_terms,
        totalAmount: refreshedDeal.total_amount,
      });

      // Auto-resolve pending follow-ups for this customer
      try {
        const { resolveCustomerFollowupTasks } = require('../kra3');
        await resolveCustomerFollowupTasks(company, senderPhone, 'deal_update', dealId);
      } catch (rErr) {
        console.warn('[SalesAgent] Follow-up auto-resolution notice:', rErr.message);
      }

      const updatedStr = updatedLabels.length > 0 ? `Updated: ${updatedLabels.join(', ')}\n` : '';

      if (completeness.isComplete) {
        return `*Deal Updated & Complete - ${dealCode}*\n\n` +
          `Customer: *${company}*\n` +
          `Stage: *${(refreshedDeal.stage || 'NEW INQUIRY').toUpperCase()}*\n` +
          updatedStr +
          `\nAll mandatory fields complete. Logged to Sales Pipeline & Inquiries! 📈`;
      } else {
        return `*Deal Updated - ${dealCode}*\n\n` +
          `Customer: *${company}*\n` +
          updatedStr +
          `\n*Still needed to complete:*\n` +
          completeness.missingFields.map(f => `• ${f}`).join('\n') +
          `\n\nLogged to Sales Pipeline & Inquiries!`;
      }
    }

    // ── SCENARIO 1 & 2: NEW INQUIRY CREATION (Customer + Product Name) ────────
    if (!customerName || customerName.length < 2 || isInvalidCustomerName(customerName)) {
      const { saveActiveSession } = require('../supabase');
      await saveActiveSession(senderPhone, 'Unknown', 'pending_customer_for_deal');
      return `❓ Which customer is this inquiry for? Please reply with the customer/company name (e.g. _"Inquiry for ABC Steel"_).`;
    }

    const officialCustomerName = await verifyAndGetCustomerName(
      customerName,
      senderPhone,
    );
    const finalCustomerName = officialCustomerName || customerName;

    const { data: custRecord } = await supabase
      .from('recurring_customers')
      .select('customer_phone')
      .ilike('customer_name', `%${finalCustomerName}%`)
      .limit(1);

    let actualCustomerPhone =
      custRecord && custRecord.length > 0
        ? custRecord[0].customer_phone
        : data.customer_phone || null;

    const cleanActualPhone = String(actualCustomerPhone || '').replace(/\D/g, '').slice(-10);
    const cleanSenderPhone = String(senderPhone || '').replace(/\D/g, '').slice(-10);

    if (
      !cleanActualPhone ||
      cleanActualPhone.length < 10 ||
      cleanActualPhone === cleanSenderPhone ||
      SYSTEM_EMPLOYEE_PHONES.has(cleanActualPhone)
    ) {
      actualCustomerPhone = null;
    }

    let targetStage = data.target_stage || 'new_inquiry';
    const stageMap = {
      new_inquiry: 'new_inquiry',
      won: 'won',
      lost: 'lost',
      negotiation: 'negotiation',
    };
    const dbStage = stageMap[targetStage] || 'new_inquiry';

    let dealAmount = 0;
    if (data.total_amount && Number(data.total_amount) > 0) {
      dealAmount = Number(data.total_amount);
    } else if (calculatedTotal > 0) {
      dealAmount = calculatedTotal;
    }

    const openDeals = await getAllOpenDealsForCustomer(finalCustomerName, senderPhone);
    let existingDeal = null;
    let dealId = null;

    const dealIdMatch = text.match(/#?(?:DEAL|INQ)-([A-F0-9]{4,6})\b/i) || text.match(/#([A-F0-9]{6})\b/i);
    const numChoiceMatch = text.trim().match(/^([1-9])$/);

    const isExplicitNewInquiry =
      !dealIdMatch &&
      !numChoiceMatch &&
      !data.po_number &&
      dbStage !== 'won' &&
      data.action !== 'purchase_order' &&
      /^\s*(?:log\s+new\s+inquiry|new\s+inquiry|new\s+deal|create\s+deal|create\s+inquiry|add\s+deal|add\s+inquiry)\b/i.test(text);

    if (dealIdMatch && openDeals.length > 0) {
      const targetCode = dealIdMatch[1].toUpperCase().replace(/^(?:DEAL|INQ)-?/, '');
      existingDeal = openDeals.find(d => (d.id || '').toUpperCase().includes(targetCode) || (d.inquiry_id || '').toUpperCase().includes(targetCode) || (d.deal_number && d.deal_number.toUpperCase().includes(targetCode)));
    } else if (!isExplicitNewInquiry && openDeals.length > 0) {
      const candidateProductNames = processedItems.map(pi => pi.pName).filter(Boolean);
      if (candidateProductNames.length > 0) {
        const matchingDeal = openDeals.find(d => isDealProductMatch(d, candidateProductNames));
        existingDeal = matchingDeal || null;
      } else if (openDeals.length === 1) {
        existingDeal = openDeals[0];
      }
    }

    if (existingDeal && !isExplicitNewInquiry) {
      dealId = existingDeal.id;
    }

    const finalDeliveryLoc =
      extractedDeliveryLoc ||
      data.delivery_location ||
      existingDeal?.delivery_location ||
      null;

    const finalDeliveryDate =
      data.delivery_date || existingDeal?.delivery_date || null;

    const finalPaymentTerms =
      data.payment_terms || existingDeal?.payment_terms || null;

    const finalPhone =
      actualCustomerPhone || data.customer_phone || existingDeal?.customer_phone || null;

    const finalContactPerson =
      data.contact_person || existingDeal?.contact_person || null;

    const { ensureCustomerRecord } = require('../supabase');
    await ensureCustomerRecord(finalCustomerName, senderPhone, {
      customer_phone: finalPhone,
      contact_person: finalContactPerson,
      city: finalDeliveryLoc,
    });

    const poDate = data.po_date || existingDeal?.po_date || (dbStage === 'won' ? new Date().toISOString().split('T')[0] : null);
    let poNumber = existingDeal ? existingDeal.po_number : null;

    if (dbStage === 'won') {
      const explicitPo = data.po_number || data.poNumber;
      if (explicitPo && explicitPo !== 'null' && explicitPo !== 'None' && String(explicitPo).trim().length > 2) {
        poNumber = String(explicitPo).trim();
      } else if (!poNumber) {
        const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const randomNum = Math.floor(1000 + Math.random() * 9000);
        poNumber = `PO-${todayStr}-${randomNum}`;
      }
    } else {
      poNumber = null;
    }

    const totalQty = processedItems.reduce((s, i) => s + i.qty, 0);
    const pricingSummary = calculatePricingSummary({
      line_items: processedItems.map(pi => ({ quantity: pi.qty, rate: pi.rate, amount: pi.itemAmount })),
    });

    const structuredExtraction = {
      customer_name: finalCustomerName,
      companyName: finalCustomerName,
      contact_person: finalContactPerson,
      customer_phone: actualCustomerPhone || null,
      delivery_location: finalDeliveryLoc,
      deliveryLocation: finalDeliveryLoc,
      delivery_date: finalDeliveryDate,
      payment_terms: finalPaymentTerms,
      paymentTerms: finalPaymentTerms,
      productType: processedItems[0]?.pName || data.product_requirement || null,
      quantityTons: totalQty || processedItems[0]?.qty || 0,
      unitPrice: processedItems[0]?.rate > 0 ? processedItems[0]?.rate : null,
      total_amount: dealAmount > 0 ? dealAmount : (pricingSummary.subtotal > 0 ? pricingSummary.subtotal : null),
      line_items: processedItems.map((pi) => ({
        sku_text: pi.pName,
        dimensions: pi.dimensions || '',
        hsn_code: detectHsnCode(pi.pName, pi.dimensions),
        quantity: pi.qty,
        unit: pi.unit || 'MT',
        rate: pi.rate > 0 ? pi.rate : null,
        amount: pi.itemAmount > 0 ? pi.itemAmount : null,
      })),
      preferred_make: data.preferred_make || null,
      overall_confidence: data.confidence || 0.95,
    };

    let inqId = existingDeal?.inquiry_id || null;
    const initialInqStatus = dbStage === 'won' ? 'confirmed' : 'review';

    if (!dealId || !inqId) {
      try {
        const { data: insertedInq, error: inqInsErr } = await supabase
          .from('inquiries')
          .insert({
            source_channel: 'whatsapp_text',
            raw_text: data.raw_text || text,
            sender_name: finalCustomerName || null,
            sender_phone: actualCustomerPhone || null,
            salesperson_phone: senderPhone,
            inquiry_type: 'inquiry',
            status: initialInqStatus,
            ai_extraction_json: structuredExtraction,
            overall_confidence: data.confidence || 0.95,
            created_at: new Date().toISOString(),
          })
          .select()
          .single();

        if (insertedInq) {
          inqId = insertedInq.id;
        }
      } catch (inqErr) {
        console.error('[SalesAgent] Inquiry insert exception:', inqErr.message);
      }
    }

    let activeDealObj = null;
    let finalPersistedItems = [];

    if (dealId) {
      const effectiveStage = (dbStage === 'won' || dbStage === 'lost') ? dbStage : (existingDeal?.stage || 'new_inquiry');
      const updatePayload = {
        customer_name: finalCustomerName,
        customer_phone: finalPhone,
        stage: effectiveStage,
        delivery_location: finalDeliveryLoc,
        delivery_date: finalDeliveryDate,
        payment_terms: finalPaymentTerms,
        total_amount: dealAmount || 0,
        po_number: poNumber,
        po_date: poDate,
        inquiry_id: inqId,
      };

      if (effectiveStage === 'won') updatePayload.won_at = new Date().toISOString();

      // Check existing deal items
      const { data: existingDealItems } = await supabase
        .from('deal_items')
        .select('*')
        .eq('deal_id', dealId);

      if (existingDealItems && existingDealItems.length > 0) {
        // Update existing line items (e.g. rate or qty provided)
        const hasExplicitQtyInMsg = /\b\d+(?:\.\d+)?\s*(?:mt|tons?|tonne|kg|pcs|nos|sheets?|plates?|coils?|bars?)\b/i.test(
          text.replace(/rate\s+is\s+[\d,.]+/i, '')
              .replace(/@\s*[\d,.]+/i, '')
              .replace(/\b(?:rs|inr|\/mt|\/kg)\b/gi, '')
        );
        const firstRate = processedItems[0]?.rate || data.line_items?.[0]?.rate_per_mt;
        const firstQty = hasExplicitQtyInMsg
          ? ((processedItems[0]?.qty > 0 ? processedItems[0]?.qty : null) || data.line_items?.[0]?.quantity)
          : null;

        for (let idx = 0; idx < existingDealItems.length; idx++) {
          const itm = existingDealItems[idx];
          const matchedP = findMatchingProcessedItem(itm, processedItems, existingDealItems.length === processedItems.length ? idx : -1);
          const itemUpdates = {};
          const matchedRate = matchedP?.rate || (matchedP?.rate_per_mt) || (processedItems.length === 1 ? firstRate : null);
          const matchedQty = hasExplicitQtyInMsg ? (matchedP?.qty || (processedItems.length === 1 ? firstQty : null)) : null;

          if (matchedRate && Number(matchedRate) > 0) {
            itemUpdates.rate = Number(matchedRate);
          }
          if (matchedQty && Number(matchedQty) > 0) {
            itemUpdates.quantity = Number(matchedQty);
          }
          const finalR = itemUpdates.rate !== undefined ? itemUpdates.rate : itm.rate;
          const finalQ = itemUpdates.quantity !== undefined ? itemUpdates.quantity : itm.quantity;
          if (finalR !== null && finalR !== undefined && finalQ !== null && finalQ !== undefined) {
            itemUpdates.amount = Number(finalR) * Number(finalQ);
          }
          if (Object.keys(itemUpdates).length > 0) {
            await supabase.from('deal_items').update(itemUpdates).eq('id', itm.id);
            finalPersistedItems.push({ ...itm, ...itemUpdates });
          } else {
            finalPersistedItems.push(itm);
          }
        }
      } else if (processedItems.length > 0) {
        for (const pItem of processedItems) {
          const { data: insItem } = await supabase.from('deal_items').insert({
            deal_id: dealId,
            sku_text: pItem.pName,
            dimensions: pItem.dimensions || (pItem.pName?.match(/(\d+(?:\.\d+)?)\s*mm/i) ? pItem.pName?.match(/(\d+(?:\.\d+)?)\s*mm/i)[1] + ' mm' : null),
            quantity: pItem.qty > 0 ? pItem.qty : null,
            unit: pItem.unit || 'MT',
            rate: pItem.rate > 0 ? pItem.rate : null,
            amount: pItem.itemAmount > 0 ? pItem.itemAmount : null,
            created_at: new Date().toISOString(),
          }).select().single();
          if (insItem) finalPersistedItems.push(insItem);
        }
      }

      const totalRecomputed = finalPersistedItems.reduce((s, i) => s + (Number(i.amount) || 0), 0);
      if (totalRecomputed > 0) {
        updatePayload.total_amount = totalRecomputed;
      }

      await supabase.from('deals').update(updatePayload).eq('id', dealId);

      // Sync inquiries table ai_extraction_json & status
      if (inqId) {
        if (effectiveStage === 'won') {
          await supabase.from('inquiries').update({ status: 'confirmed' }).eq('id', inqId);
        }
        await syncInquiryFromDeal(inqId, { ...existingDeal, ...updatePayload }, finalPersistedItems);
      }

      activeDealObj = { id: dealId, ...updatePayload };
    } else {
      const effectiveStage = (dbStage === 'won' || dbStage === 'lost') ? dbStage : 'new_inquiry';
      const { data: newDeal, error: dealInsertErr } = await supabase
        .from('deals')
        .insert({
          inquiry_id:        inqId || null,
          customer_name:     finalCustomerName,
          salesperson_phone: senderPhone,
          customer_phone:    actualCustomerPhone,
          stage:             effectiveStage,
          total_amount:      dealAmount || 0,
          inquiry_type:      'inquiry',
          delivery_location: finalDeliveryLoc,
          delivery_date:     finalDeliveryDate,
          payment_terms:     finalPaymentTerms,
          po_date:           poDate,
          po_number:         poNumber,
          won_at:            effectiveStage === 'won' ? new Date().toISOString() : null,
          lost_reason:       effectiveStage === 'lost' ? data.loss_reason : null,
          created_at:        new Date().toISOString(),
        })
        .select()
        .single();

      if (newDeal) {
        dealId = newDeal.id;
        activeDealObj = newDeal;
        for (const pItem of processedItems) {
          const { data: insItem } = await supabase.from('deal_items').insert({
            deal_id: dealId,
            sku_text: pItem.pName,
            dimensions: pItem.dimensions || (pItem.pName?.match(/(\d+(?:\.\d+)?)\s*mm/i) ? pItem.pName?.match(/(\d+(?:\.\d+)?)\s*mm/i)[1] + ' mm' : null),
            quantity: pItem.qty > 0 ? pItem.qty : null,
            unit: pItem.unit || 'MT',
            rate: pItem.rate > 0 ? pItem.rate : null,
            amount: pItem.itemAmount > 0 ? pItem.itemAmount : null,
            created_at: new Date().toISOString(),
          }).select().single();
          if (insItem) finalPersistedItems.push(insItem);
        }
        if (inqId) {
          if (effectiveStage === 'won') {
            await supabase.from('inquiries').update({ status: 'confirmed' }).eq('id', inqId);
          }
          await syncInquiryFromDeal(inqId, newDeal, finalPersistedItems);
        }
      }
    }

    await saveActiveSession(senderPhone, finalCustomerName, 'deal_inquiry');

    // Auto-resolve pending follow-ups for this customer
    try {
      const { resolveCustomerFollowupTasks } = require('../kra3');
      await resolveCustomerFollowupTasks(finalCustomerName, senderPhone, 'deal_created', dealId);
    } catch (rErr) {
      console.warn('[SalesAgent] Follow-up auto-resolution notice:', rErr.message);
    }

    try {
      logBotActivity({
        salesperson_phone: senderPhone,
        description: `New inquiry received from ${finalCustomerName} via WhatsApp`,
        module: 'Inquiries',
        customer_name: finalCustomerName,
      });
    } catch (actErr) {
      console.warn('[SalesAgent] Activity log notice:', actErr?.message);
    }

    const dealCode = getDealCode(activeDealObj || { id: dealId });

    const activeItemsForSummary = (activeDealObj && activeDealObj.id && (finalPersistedItems && finalPersistedItems.length > 0))
      ? finalPersistedItems.map((f) => ({
          pName: f.sku_text || f.product_requirement,
          dimensions: f.dimensions,
          qty: Number(f.quantity) || 0,
          unit: f.unit || 'MT',
          rate: Number(f.rate) || null,
          itemAmount: Number(f.amount) || null,
        }))
      : processedItems;

    const activeTotalForSummary = (activeDealObj && Number(activeDealObj.total_amount) > 0)
      ? Number(activeDealObj.total_amount)
      : dealAmount;

    // EVALUATE MANDATORY FIELD COMPLETENESS
    const completeness = evaluateMandatoryFields({
      customerName: finalCustomerName,
      lineItems: activeItemsForSummary,
      deliveryLocation: finalDeliveryLoc,
      paymentTerms: finalPaymentTerms,
      totalAmount: activeTotalForSummary,
    });

    if (dbStage === 'won') {
      let resultMsg =
        `*DEAL WON & ORDER CONFIRMED!*\n\n` +
        `Customer: *${finalCustomerName}*\n` +
        `Deal ID: *${dealCode}*\n` +
        `Official PO Number: *${poNumber}*\n` +
        `Total Value: *Rs. ${Number(activeTotalForSummary).toLocaleString('en-IN')}* + GST\n` +
        (poDate ? `PO Date: *${poDate}*\n` : '') +
        `\nUpdated Sales Achievement Card!`;
      return resultMsg;
    }

    // SCENARIO 2: ALL MANDATORY FIELDS COMPLETE
    if (completeness.isComplete) {
      let itemsBreakdownStr = activeItemsForSummary
        .map((pi) => {
          const dimStr = pi.dimensions ? ` (${pi.dimensions})` : '';
          const unitStr = pi.unit || 'MT';
          const qtyStr = pi.qty > 0 ? `: ${pi.qty} ${unitStr}` : '';
          const rateStr = pi.rate > 0 ? ` @ Rs. ${Number(pi.rate).toLocaleString('en-IN')}/${unitStr}` : '';
          const amtStr = pi.itemAmount > 0 ? ` = Rs. ${Number(pi.itemAmount).toLocaleString('en-IN')}` : '';
          return `  • *${pi.pName}*${dimStr}${qtyStr}${rateStr}${amtStr}`;
        })
        .join('\n');

      const gstVal = calculateGst(activeTotalForSummary);
      const grandTot = calculateGrandTotal(activeTotalForSummary);

      return `*Inquiry Logged & Complete - ${dealCode}*\n\n` +
        `Customer: *${finalCustomerName}*\n` +
        `Stage: *NEW INQUIRY*\n` +
        `Line Items:\n${itemsBreakdownStr}\n` +
        (data.preferred_make ? `Preferred Make: *${data.preferred_make}*\n` : '') +
        `Delivery Location: *${finalDeliveryLoc}*\n` +
        `Payment Terms: *${finalPaymentTerms}*\n` +
        (activeTotalForSummary > 0 ? `Quotation Subtotal: *Rs. ${Number(activeTotalForSummary).toLocaleString('en-IN')}* + GST (Rs. ${Number(gstVal).toLocaleString('en-IN')})\nGrand Total: *Rs. ${Number(grandTot).toLocaleString('en-IN')}*\n` : '') +
        `\nAll mandatory fields complete. Logged to Sales Pipeline & Inquiries!`;
    }

    // SCENARIO 1: MINIMUM VIABLE INQUIRY (Some mandatory fields missing)
    let itemSummary = activeItemsForSummary
      .map((pi) => {
        const dimStr = pi.dimensions ? ` (${pi.dimensions})` : '';
        const qtyStr = pi.qty > 0 ? ` - ${pi.qty} ${pi.unit || 'MT'}` : '';
        const rateStr = pi.rate > 0 ? ` @ Rs. ${Number(pi.rate).toLocaleString('en-IN')}` : '';
        return `• *${pi.pName}*${dimStr}${qtyStr}${rateStr}`;
      })
      .join('\n');

    return `*Inquiry Logged - Deal ID: ${dealCode}*\n\n` +
      `Customer: *${finalCustomerName}*\n` +
      `Product Requirement:\n${itemSummary}\n` +
      (finalDeliveryLoc ? `Delivery Location: *${finalDeliveryLoc}*\n` : '') +
      (finalPaymentTerms ? `Payment Terms: *${finalPaymentTerms}*\n` : '') +
      `\n*Still needed to complete:*\n` +
      completeness.missingFields.map((f) => `• ${f}`).join('\n') +
      `\n\nLogged to Sales Pipeline & Inquiries!`;
  } catch (error) {
    console.error('[SalesAgent] Error processing sales message:', error);
    return `Error updating deal: ${error.message}`;
  }
}

async function processSalesImage(imageBuffer, mimeType, senderPhone, messageId) {
  const { processSalesImage: ocrProcess } = require('./ocrAgent');
  return await ocrProcess(imageBuffer, mimeType, senderPhone, messageId);
}

module.exports = {
  processSalesMessage,
  processSalesImage,
  handleSendQuotationMessage,
  sendQuotationEmail,
  findBestDeal,
  findDealByCodeOrId,
  detectInvalidUnitInMessage,
  extractDeliveryLocation,
  evaluateMandatoryFields,
};
