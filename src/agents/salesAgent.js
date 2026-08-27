/**
 * KRA 1 - Sales Achievement & Pipeline Agent
 * Version: 2026.08.27 (Form Completion Rules & Multi-Scenario Optimization)
 *
 * DESIGN PRINCIPLES:
 * - A New Inquiry requires at minimum: Customer/Company Name AND at least one Product Name.
 * - Non-product fields alone (rate, delivery, payment terms) are treated as deal updates or require deal context.
 * - Missing mandatory fields (Company, Product, Qty+Unit, Rate, Delivery Location, Payment Terms) are tracked.
 * - Incomplete inquiries stay in "new_inquiry" stage and list remaining required fields with Deal ID.
 * - Complete inquiries confirm all fields are present.
 * - Updates using Deal ID or unique active deal merge fields without duplicate creation.
 */

const { HumanMessage, SystemMessage } = require('@langchain/core/messages');
const { supabase, verifyAndGetCustomerName, saveActiveSession } = require('../supabase');
const { syncActivity } = require('./biginSyncAgent');
const { logBotActivity } = require('../utils/activityLogger');
const { detectHsnCode } = require('../utils/hsnDetector');

const SALES_AGENT_PROMPT = `
You are the Specialized Sales Achievement & Pipeline Agent for Enlight Metals (B2B Steel Distributor).
Your job is to analyze salesperson messages reporting sales actions, deal status updates, stage changes, customer product requirements/inquiries, or updates to existing deals.

Input message can be English, Hindi, or Hinglish.

Extract into ONLY a JSON object (no markdown, no prose, no backticks):
{
  "action": "stage_update|purchase_order|inquiry|deal_update",
  "deal_id": "<deal ID if mentioned e.g. #DEAL-C538B6, DEAL-C538B6, or C538B6, else null>",
  "customer_name": "<exact company/customer name requesting material or placing order, else null>",
  "contact_person": "<full name of customer contact person/owner/proprietor if mentioned e.g. Rajesh Mehta, else null>",
  "customer_phone": "<customer phone number ONLY if explicitly provided in text e.g. 9812345670, else null>",
  "target_stage": "new_inquiry|qualified|quoted|negotiation|won|lost",
  "line_items": [
    {
      "product_requirement": "<specific product name e.g. CR Sheet, HR Sheet, CR Coil, HR Coil, MS Plates, TMT Bar>",
      "dimensions": "<explicit dimensions/thickness if stated e.g. 1mm 1250x2500, 1.2mm 1250x2500, 1.6mm 1250x2500, 6mm, 8mm, 2mm, else null>",
      "quantity": <numeric quantity e.g. 300, 200, 20>,
      "quantity_mt": <numeric quantity in MT or same as quantity>,
      "unit": "<exact unit mentioned: nos, pcs, sheets, kg, MT, etc, default MT>",
      "rate_per_mt": <numeric per-MT or unit price ONLY if explicitly mentioned in message, else null>
    }
  ],
  "total_amount": <numeric total deal value in rupees ONLY if explicitly mentioned in text, else 0>,
  "delivery_location": "<full exact address/city/location if mentioned e.g. Hunsal Village, Khopoli, Raigad, Maharashtra - 410203, Pune, else null>",
  "delivery_date": "<delivery deadline in YYYY-MM-DD format using current year 2026 if mentioned e.g. 2026-08-25 for 'before 25 August', else null>",
  "payment_terms": "<payment terms e.g. 45 days, 30 days credit, 100% advance, else null>",
  "preferred_make": "<preferred make/brand if stated e.g. Tata, JSW, SAIL, else null>",
  "po_number": "<PO number if mentioned, else null>",
  "po_date": "<PO date / target PO date in YYYY-MM-DD format using year 2026 e.g. 2026-08-28 for '28 August', else null>",
  "loss_reason": "<inferred reason if deal was lost, else null>",
  "confidence": <float 0.0 to 1.0>
}

CRITICAL EXTRACTION & FORM COMPLETION RULES:
1. WHAT MAKES A VALID NEW INQUIRY:
   - A New Inquiry requires at minimum: CUSTOMER/COMPANY NAME AND AT LEAST ONE PRODUCT NAME (e.g. HR Coil, CR Sheet, MS Plate, TMT Bar).
   - Company name alone, delivery location alone, rate alone, or payment terms alone do NOT constitute a New Inquiry.
   - If ONLY supporting fields (delivery, rate, payment terms, or quantity) are provided without a product name, action MUST be "deal_update" (not "inquiry").

2. MANDATORY FIELDS FOR INQUIRY COMPLETION:
   - Company Name ✱
   - Product Description / SKU ✱
   - Quantity and Unit ✱
   - Rate (₹) ✱
   - HSN/SAC ✱ (auto-detected)
   - Delivery Location / Address ✱
   - Payment Terms ✱

3. DEAL ID & EXISTING DEAL UPDATES:
   - If the salesperson mentions a Deal ID (e.g. "#DEAL-C538B6", "DEAL-C538B6", or "C538B6"), extract it into deal_id.
   - When deal_id is provided or inferred, update only the provided fields on that specific deal and never create a duplicate.

4. MULTIPLE LINE ITEMS:
   - Extract each item as a separate object in line_items array with product name, dimensions, quantity, unit, and rate.
   - Never drop dimensions (e.g. "1mm 1250x2500").

5. PAYMENT TERMS & DELIVERY:
   - "45 days" or "30 days" in credit context is payment_terms, never product quantity.
   - Extract full delivery location/address and city.

6. TARGET RATE:
   - If given, extract as rate_per_mt. If no rate is mentioned, rate_per_mt MUST be null.

Return ONLY the JSON object.
`;

const PRODUCT_FAMILIES = {
  hr_coil: ['hr coil', 'hot rolled coil', 'hot rolled', 'hr sheet', 'hr plate', 'hr strip'],
  cr_coil: ['cr coil', 'cold rolled coil', 'cold rolled'],
  cr_sheet: ['cr sheet', 'cold rolled sheet', 'crc sheet', 'cr sheets'],
  ms_plate: ['ms plate', 'ms plates', 'mild steel plate', 'chequered plate'],
  ms_sheet: ['ms sheet', 'mild steel sheet'],
  tmt_bar: ['tmt bar', 'tmt bars', 'rebars', 'tmt rebar', 'tmt'],
  gi_sheet: ['gi sheet', 'galvanized sheet', 'gp sheet', 'gi sheets'],
  gi_coil: ['gi coil', 'galvanized coil', 'gp coil', 'gi coils'],
  pipe: ['pipe', 'pipes', 'erw pipe', 'seamless pipe', 'ms pipe', 'gi pipe', 'tube', 'tubing'],
  structural: ['beam', 'beams', 'channel', 'channels', 'angle', 'angles', 'flat', 'flats', 'joist', 'column', 'section'],
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

async function isProductMatchForExistingDeal(dealId, newProductText) {
  if (!newProductText || !dealId) return true;

  const { data: items } = await supabase
    .from('deal_items')
    .select('sku_text')
    .eq('deal_id', dealId);

  if (!items || items.length === 0) return true;

  const newFamily = getProductFamily(newProductText);

  for (const item of items) {
    if (!item.sku_text) continue;
    const existingFamily = getProductFamily(item.sku_text);
    if (newFamily && existingFamily && newFamily === existingFamily) {
      return true;
    }
    if (newProductText.toLowerCase().trim() === item.sku_text.toLowerCase().trim()) {
      return true;
    }
  }

  return false;
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

  const structLoc = text.match(/(?:delivery\s+location|delivery\s+address|delivery\s+city|location|destination|ship\s+to|deliver\s+to|delivery\s+at)\s*[:=-]\s*([^\n\r,]+)/i);
  if (structLoc) {
    return structLoc[1].trim().replace(/^['"]|['"]$/g, '');
  }

  const phrases = [
    /(?:for\s+delivery\s+to|delivery\s+to|delivery\s+at|deliver\s+to|ship\s+to|destination|transport\s+to|bhejna\s+hai|deliver\s+karna\s+hai|delivering\s+to)\s+([A-Za-z\s]+?)(?:\s+before|\s+by|\s+on|\s+within|\s+deliver|\.|\n|$)/i,
    /([A-Za-z]+)\s+(?:delivery|chahiye|mein\s+deliver|pe\s+deliver)/i
  ];

  for (const p of phrases) {
    const m = text.match(p);
    if (m && m[1]) {
      const cand = m[1].trim();
      const matchedCity = KNOWN_STEEL_CITIES.find(c => c.toLowerCase() === cand.toLowerCase());
      if (matchedCity) return matchedCity;
      if (cand.length >= 3 && !['the', 'and', 'with', 'metal', 'steel', 'coil', 'sheet', 'deal', 'order', 'quotation', 'rate', 'price'].includes(cand.toLowerCase())) {
        return cand;
      }
    }
  }

  for (const city of KNOWN_STEEL_CITIES) {
    const cityRegex = new RegExp(`\\b${city}\\b`, 'i');
    if (cityRegex.test(lower)) {
      return city;
    }
  }

  return null;
}

function detectInvalidUnitInMessage(text) {
  if (!text) return null;
  const cleanText = text.replace(/(\d+),(\d+)/g, '$1$2');

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
    'tax', 'hsn', 'sac', 'pan', 'tan', 'cin', 'arn', 'e-way', 'eway'
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

function getDealCode(deal) {
  if (!deal) return '#DEAL-UNKNOWN';
  if (deal.deal_number) return `#${deal.deal_number}`;
  const code = (deal.id || '').substring(0, 6).toUpperCase();
  return `#DEAL-${code}`;
}

async function findDealByCodeOrId(codeOrId, senderPhone) {
  if (!codeOrId) return null;
  const clean = codeOrId.replace(/^#?DEAL-?/i, '').trim().toUpperCase();
  if (clean.length < 4) return null;

  const { data: deals } = await supabase
    .from('deals')
    .select('*, deal_items(*)')
    .order('created_at', { ascending: false })
    .limit(200);

  if (deals && deals.length > 0) {
    const found = deals.find(
      (d) =>
        (d.id || '').toUpperCase().startsWith(clean) ||
        (d.deal_number && d.deal_number.toUpperCase().includes(clean))
    );
    return found || null;
  }
  return null;
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
    if (scope.phones.length === 1) {
      query = query.eq('salesperson_phone', scope.phones[0]);
    } else if (scope.phones.length > 1) {
      query = query.in('salesperson_phone', scope.phones);
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
    let data = overrideData;

    if (!data) {
      const invalidUnitCheck = detectInvalidUnitInMessage(text);
      if (invalidUnitCheck) {
        return `*Invalid Quantity Unit*\n\n` +
          `You specified *${invalidUnitCheck.number} ${invalidUnitCheck.invalidUnit}*.\n\n` +
          `Metal products cannot be measured in *"${invalidUnitCheck.invalidUnit}"*.\n\n` +
          `Please specify the quantity using a valid unit (e.g. *15 MT*, *1500 Kg*, *100 Sheets*, or *50 Pcs*).`;
      }

      try {
        const { invokeWithFallback } = require('../core/modelRouter');
        const response = await invokeWithFallback([
          new SystemMessage(SALES_AGENT_PROMPT),
          new HumanMessage('Salesperson message:\n' + text),
        ]);
        const rawText = typeof response.content === 'string' ? response.content : JSON.stringify(response.content || '');
        const { safeParseJSON } = require('../utils/jsonUtils');
        data = safeParseJSON(rawText, null);
      } catch (llmErr) {
        console.warn('[SalesAgent] LLM extraction notice, utilizing rule-based engine:', llmErr.message);
      }

      if (!data || data.confidence < 0.3) {
        const textRaw = text || '';
        const textClean = textRaw.replace(/#?(?:DEAL-[A-F0-9]{4,6}|[A-F0-9]{6})\b/gi, '').replace(/\s+/g, ' ');
        const textLower = textClean.toLowerCase();

        let ruleDealId = null;
        const dealIdMatch = textRaw.match(/#?(DEAL-[A-F0-9]{4,6}|[A-F0-9]{6})/i);
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
            textClean.match(/\b(?:mark|move|update|set|change)\s+([A-Z0-9\s&.-]{2,40}?)\s+(?:deal\s+)?(?:as\s+|to\s+)?(won|lost|quoted|negotiation|qualified)\b/i) ||
            textClean.match(/^(?!new\b|log\b|create\b|add\b)([A-Z0-9\s&.-]{2,40}?)\s+(?:requires|require|needs|need|inquiry|rfq|po|order|want)\b/i) ||
            textClean.match(/(?:customer|company|client|pvt\.?\s*ltd\.?|ltd\.?|infra|steel|engineering|industries)\s+([A-Z0-9\s&.-]{3,35})/i);
          if (reqMatch) {
            const cand = reqMatch[1].trim();
            if (!['new', 'log', 'create', 'add', 'a', 'the', 'customer', 'unknown', 'max'].includes(cand.toLowerCase())) {
              ruleCustomer = cand;
            }
          }
        }

        let ruleAction = 'inquiry';
        let ruleStage = 'new_inquiry';
        const stageUpdateMatch = textClean.match(/\b(?:mark|move|update|set|change)\s+([A-Z0-9\s&.-]{2,40}?)\s+(?:deal\s+)?(?:as\s+|to\s+)?(won|lost|quoted|negotiation|qualified)\b/i) ||
          textClean.match(/([A-Z0-9\s&.-]{2,40}?)\s+(?:deal\s+)?(?:is\s+|moved\s+to\s+|marked\s+as\s+)?(won|lost|quoted|negotiation|qualified)\b/i);

        if (stageUpdateMatch) {
          ruleAction = 'stage_update';
          ruleStage = stageUpdateMatch[2].toLowerCase();
          if (!ruleCustomer && stageUpdateMatch[1]) {
            ruleCustomer = stageUpdateMatch[1].trim();
          }
        }

        let qty = 0;
        let unit = 'MT';
        const structQty = textRaw.match(/(?:quantity|qty)\s*[:=-]\s*(\d+(?:\.\d+)?)\s*([a-zA-Z]+)?/i);
        if (structQty) {
          qty = parseFloat(structQty[1]);
          if (structQty[2]) unit = structQty[2];
        } else {
          const qtyMatch = textRaw.match(/(\d+(?:\.\d+)?)\s*(mt|ton|tons|tonne|kg|kgs|pcs|piece|pieces|nos|sheet|sheets|plate|plates|coil|coils|bar|bars)/i);
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
          const mmM = textRaw.match(/(\d+(?:\.\d+)?)\s*mm(?:\s*x\s*\d+(?:\s*x\s*\d+)?)?/i);
          specDim = mmM ? mmM[0] : null;
        }

        let pReq = null;
        const structMat = textRaw.match(/(?:material|product(?:\s+name)?|product(?:\s+description)?|item)\s*[:=-]\s*([^\n\r]+)/i);
        if (structMat) {
          const mVal = structMat[1].trim();
          pReq = specDim && !mVal.toLowerCase().includes(specDim.toLowerCase()) ? `${mVal} ${specDim}` : mVal;
        } else if (/\b(hr\s*coil|hot\s*rolled\s*coil)\b/i.test(textLower)) {
          pReq = specDim ? `HR Coil ${specDim}` : 'HR Coil';
        } else if (/\b(cr\s*sheet|cold\s*rolled\s*sheet)\b/i.test(textLower)) {
          pReq = specDim ? `CR Sheets ${specDim}` : 'CR Sheets';
        } else if (/\b(cr\s*coil|cold\s*rolled\s*coil|cr)\b/i.test(textLower)) {
          pReq = specDim ? `CR Coil ${specDim}` : 'CR Coil';
        } else if (/\b(ms\s*plate|plates)\b/i.test(textLower)) {
          pReq = specDim ? `MS Plates ${specDim}` : 'MS Plates';
        } else if (/\b(ms\s*sheet)\b/i.test(textLower)) {
          pReq = specDim ? `MS Sheet ${specDim}` : 'MS Sheet 2mm';
        } else if (/\b(tmt\s*bar|tmt)\b/i.test(textLower)) {
          pReq = specDim ? `TMT Bar ${specDim}` : 'TMT Bar';
        } else if (/\b(gi\s*sheet|gi\s*coil)\b/i.test(textLower)) {
          pReq = specDim ? `GI Sheet ${specDim}` : 'GI Sheet';
        } else if (/\b(pipe|pipes|tube|tubes)\b/i.test(textLower)) {
          pReq = specDim ? `Steel Pipe ${specDim}` : 'Steel Pipe';
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

        data = {
          action: ruleAction,
          deal_id: ruleDealId,
          customer_name: ruleCustomer,
          contact_person: ruleContact,
          target_stage: ruleStage,
          customer_phone: rulePhone,
          line_items: pReq ? [
            {
              product_requirement: pReq,
              dimensions: specDim,
              quantity_mt: qty,
              quantity: qty,
              unit: unit,
              rate_per_mt: ruleRate,
            }
          ] : [],
          total_amount: 0,
          delivery_location: delLoc,
          payment_terms: rulePayment,
          delivery_date: null,
          confidence: 0.9,
        };
      }
    }

    const PRODUCT_KEYWORDS = [
      'hr coil', 'hot rolled', 'cr sheet', 'cold rolled', 'cr coil',
      'ms plate', 'ms plates', 'ms sheet', 'tmt bar', 'tmt bars',
      'gi coil', 'gi sheet', 'pipe', 'pipes', 'steel pipe', 'steel pipes',
      'angles', 'channels', 'beams', 'flats', 'rebars', 'sheet', 'plate',
      'coil', 'steel', 'metal', 'iron', 'structure', 'structures',
      'pickled', 'galvanized', 'erw pipe', 'seamless pipe', 'is 2062',
      'is 277', 'is 3589', 'e250', 'e350', 'fe 410', 'fe 500'
    ];

    const SALESPERSON_NAMES = [
      'rishabh', 'rishabh makwana', 'max', 'akruti', 'salesperson',
      'sales rep', 'dhananjay goel', 'rahul sharma', 'suresh sharma',
      'kumar varma', 'john', 'andrew', 'test', 'customer', 'client',
      'the customer', 'customer inquiry', 'web customer', 'unknown', 'self'
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

      const allWordsProduct = words.every((w) =>
        PRODUCT_KEYWORDS.includes(w) ||
        /^\d+(?:mm|mt|ton|tons|kg|gsm|br)?$/i.test(w) ||
        /^(is|grade|fe|make|sail|tata|jsw|jindal|prime|quality|only|with|mtc|thick|thk|od|dia)$/i.test(w)
      );
      if (allWordsProduct) return true;

      return false;
    }

    // ── CHECK 1: Deal ID Explicitly Provided in Message (Scenario 4) ────────
    const explicitDealIdMatch = text.match(/#?(DEAL-[A-F0-9]{4,6}|[A-F0-9]{6})/i);
    let targetExplicitDeal = null;
    if (explicitDealIdMatch || data.deal_id) {
      const dealCodeToFind = (explicitDealIdMatch ? explicitDealIdMatch[1] : data.deal_id);
      targetExplicitDeal = await findDealByCodeOrId(dealCodeToFind, senderPhone);
    }

    let customerName = data.customer_name;
    if (isInvalidCustomerName(customerName)) {
      customerName = null;
    }

    if (!customerName && targetExplicitDeal) {
      customerName = targetExplicitDeal.customer_name;
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
            rate,
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

    // ── SCENARIO 3: PARTIAL UPDATE WITHOUT PRODUCT NAME ────────────────────────
    // If NO product name is provided AND not explicitly a stage_update with a customer name:
    if (!hasAnyProductName && data.action !== 'stage_update' && data.target_stage !== 'won' && data.target_stage !== 'lost') {
      if (targetExplicitDeal) {
        // Handled below via Deal ID update path
      } else if (customerName) {
        const openDeals = await getAllOpenDealsForCustomer(customerName, senderPhone);
        if (openDeals.length === 1) {
          // Exactly 1 active open deal for this customer -> auto-assume that deal!
          targetExplicitDeal = openDeals[0];
          console.log(`[SalesAgent] Auto-assuming single active deal ${getDealCode(targetExplicitDeal)} for ${customerName}`);
        } else if (openDeals.length > 1) {
          return `Which deal is this update for? Please provide the Deal ID (e.g. ${getDealCode(openDeals[0])}) or company name.`;
        } else {
          return `Which deal or inquiry is this update for? Please provide the Deal ID (e.g. #DEAL-XXXXXX) or company name.`;
        }
      } else {
        // No product name and no customer name
        return `Which deal or inquiry is this for? Please provide the Deal ID (e.g. #DEAL-XXXXXX).`;
      }
    }

    // ── SCENARIO 4: UPDATE TO EXISTING DEAL (WITH DEAL ID OR AUTO-ASSUMED) ─────
    if (targetExplicitDeal && (!hasAnyProductName || data.action === 'deal_update')) {
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
      const existingItems = targetExplicitDeal.deal_items || [];
      if (existingItems.length > 0 && (hasRateUpdate || hasQtyUpdate)) {
        const firstRate = data.line_items?.[0]?.rate_per_mt;
        const firstQty = data.line_items?.[0]?.quantity || data.line_items?.[0]?.quantity_mt;

        for (const itm of existingItems) {
          const itemUpdates = {};
          if (firstRate && firstRate > 0) {
            itemUpdates.rate = firstRate;
            updatedLabels.push(`Rate (*Rs. ${Number(firstRate).toLocaleString('en-IN')}*)`);
          }
          if (firstQty && firstQty > 0) {
            itemUpdates.quantity = firstQty;
            updatedLabels.push(`Quantity (*${firstQty} ${itm.unit || 'MT'}*)`);
          }
          if (Object.keys(itemUpdates).length > 0) {
            if (itemUpdates.rate && (itemUpdates.quantity || itm.quantity)) {
              itemUpdates.amount = Number(itemUpdates.rate) * Number(itemUpdates.quantity || itm.quantity);
              updateFields.total_amount = itemUpdates.amount;
            }
            await supabase.from('deal_items').update(itemUpdates).eq('id', itm.id);
          }
        }
      }

      if (Object.keys(updateFields).length > 0) {
        await supabase.from('deals').update(updateFields).eq('id', dealId);
      }

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

      const updatedStr = updatedLabels.length > 0 ? `Updated: ${updatedLabels.join(', ')}\n` : '';

      if (completeness.isComplete) {
        return `*Deal Updated & Complete — ${dealCode}*\n\n` +
          `Customer: *${company}*\n` +
          `Stage: *${(refreshedDeal.stage || 'NEW INQUIRY').toUpperCase()}*\n` +
          updatedStr +
          `\nAll mandatory fields complete. Ready to progress to Qualified / Quoted! 📈`;
      } else {
        return `*Deal Updated — ${dealCode}*\n\n` +
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
      qualified: 'qualified',
      quoted: 'quoted',
      negotiation: 'negotiation',
      won: 'won',
      lost: 'lost',
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

    const dealIdMatch = text.match(/#?(DEAL-[A-F0-9]{4,6}|[A-F0-9]{6})/i);
    const numChoiceMatch = text.trim().match(/^([1-9])$/);

    const isExplicitNewInquiry =
      !dealIdMatch &&
      !numChoiceMatch &&
      (
        data.action === 'inquiry' ||
        (targetStage === 'new_inquiry' && dbStage === 'new_inquiry' && !data.po_number && !overrideData) ||
        /^\s*(log\s+new\s+inquiry|new\s+inquiry|new\s+deal|inquiry\s+for|requirement\s+for|company\s+name)/i.test(text)
      );

    if (dealIdMatch && openDeals.length > 0) {
      const targetCode = dealIdMatch[1].toUpperCase().replace('DEAL-', '');
      existingDeal = openDeals.find(d => (d.id || '').toUpperCase().includes(targetCode) || (d.deal_number && d.deal_number.toUpperCase().includes(targetCode)));
    } else if (!isExplicitNewInquiry) {
      if (openDeals.length === 1) {
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
        hsn_code: detectHsnCode(pi.pName),
        quantity: pi.qty,
        unit: pi.unit || 'MT',
        rate: pi.rate > 0 ? pi.rate : null,
        amount: pi.itemAmount > 0 ? pi.itemAmount : null,
      })),
      preferred_make: data.preferred_make || null,
      overall_confidence: data.confidence || 0.95,
    };

    let inqId = existingDeal?.inquiry_id || null;

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
            status: 'review',
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

    if (dealId) {
      const updatePayload = {
        customer_name: finalCustomerName,
        customer_phone: finalPhone,
        stage: dbStage,
        delivery_location: finalDeliveryLoc,
        delivery_date: finalDeliveryDate,
        payment_terms: finalPaymentTerms,
        total_amount: dealAmount || 0,
        inquiry_id: inqId,
        created_at: new Date().toISOString(),
      };

      if (dbStage === 'won') updatePayload.won_at = new Date().toISOString();

      await supabase.from('deals').update(updatePayload).eq('id', dealId);

      if (processedItems.length > 0) {
        await supabase.from('deal_items').delete().eq('deal_id', dealId);
        for (const pItem of processedItems) {
          await supabase.from('deal_items').insert({
            deal_id: dealId,
            sku_text: pItem.pName,
            dimensions: pItem.dimensions || (pItem.pName?.match(/(\d+(?:\.\d+)?)\s*mm/i) ? pItem.pName?.match(/(\d+(?:\.\d+)?)\s*mm/i)[1] + ' mm' : null),
                        quantity: pItem.qty > 0 ? pItem.qty : null,
            unit: pItem.unit || 'MT',
            rate: pItem.rate > 0 ? pItem.rate : null,
            amount: pItem.itemAmount > 0 ? pItem.itemAmount : null,
            created_at: new Date().toISOString(),
          });
        }
      }
      activeDealObj = { id: dealId, ...updatePayload };
    } else {
      const { data: newDeal, error: dealInsertErr } = await supabase
        .from('deals')
        .insert({
          inquiry_id:        inqId || null,
          customer_name:     finalCustomerName,
          salesperson_phone: senderPhone,
          customer_phone:    actualCustomerPhone,
          stage:             dbStage,
          total_amount:      dealAmount || 0,
          inquiry_type:      'inquiry',
          delivery_location: finalDeliveryLoc,
          delivery_date:     finalDeliveryDate,
          payment_terms:     finalPaymentTerms,
          po_date:           poDate,
          po_number:         poNumber,
          won_at:            dbStage === 'won' ? new Date().toISOString() : null,
          lost_reason:       dbStage === 'lost' ? data.loss_reason : null,
          created_at:        new Date().toISOString(),
        })
        .select()
        .single();

      if (newDeal) {
        dealId = newDeal.id;
        activeDealObj = newDeal;
        for (const pItem of processedItems) {
          await supabase.from('deal_items').insert({
            deal_id: dealId,
            sku_text: pItem.pName,
            dimensions: pItem.dimensions || (pItem.pName?.match(/(\d+(?:\.\d+)?)\s*mm/i) ? pItem.pName?.match(/(\d+(?:\.\d+)?)\s*mm/i)[1] + ' mm' : null),
                        quantity: pItem.qty > 0 ? pItem.qty : null,
            unit: pItem.unit || 'MT',
            rate: pItem.rate > 0 ? pItem.rate : null,
            amount: pItem.itemAmount > 0 ? pItem.itemAmount : null,
            created_at: new Date().toISOString(),
          });
        }
      }
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

    // EVALUATE MANDATORY FIELD COMPLETENESS
    const completeness = evaluateMandatoryFields({
      customerName: finalCustomerName,
      lineItems: processedItems,
      deliveryLocation: finalDeliveryLoc,
      paymentTerms: finalPaymentTerms,
      totalAmount: dealAmount,
    });

    if (dbStage === 'won') {
      let resultMsg =
        `*DEAL WON & ORDER CONFIRMED!*\n\n` +
        `Customer: *${finalCustomerName}*\n` +
        `Deal ID: *${dealCode}*\n` +
        `Official PO Number: *${poNumber}*\n` +
        `Total Value: *Rs. ${Number(dealAmount).toLocaleString('en-IN')}* + GST\n` +
        (poDate ? `PO Date: *${poDate}*\n` : '') +
        `\nUpdated Sales Achievement Card!`;
      return resultMsg;
    }

    // SCENARIO 2: ALL MANDATORY FIELDS COMPLETE
    if (completeness.isComplete) {
      let itemsBreakdownStr = processedItems
        .map((pi) => {
          const dimStr = pi.dimensions ? ` (${pi.dimensions})` : '';
          const unitStr = pi.unit || 'MT';
          const qtyStr = pi.qty > 0 ? `: ${pi.qty} ${unitStr}` : '';
          const rateStr = pi.rate > 0 ? ` @ Rs. ${Number(pi.rate).toLocaleString('en-IN')}/${unitStr}` : '';
          const amtStr = pi.itemAmount > 0 ? ` = Rs. ${Number(pi.itemAmount).toLocaleString('en-IN')}` : '';
          return `  • *${pi.pName}*${dimStr}${qtyStr}${rateStr}${amtStr}`;
        })
        .join('\n');

      const gstVal = calculateGst(dealAmount);
      const grandTot = calculateGrandTotal(dealAmount);

      return `*Inquiry Logged & Complete — ${dealCode}*\n\n` +
        `Customer: *${finalCustomerName}*\n` +
        `Stage: *NEW INQUIRY*\n` +
        `Line Items:\n${itemsBreakdownStr}\n` +
        (data.preferred_make ? `Preferred Make: *${data.preferred_make}*\n` : '') +
        `Delivery Location: *${finalDeliveryLoc}*\n` +
        `Payment Terms: *${finalPaymentTerms}*\n` +
        (dealAmount > 0 ? `Quotation Subtotal: *Rs. ${Number(dealAmount).toLocaleString('en-IN')}* + GST (Rs. ${Number(gstVal).toLocaleString('en-IN')})\nGrand Total: *Rs. ${Number(grandTot).toLocaleString('en-IN')}*\n` : '') +
        `\nAll mandatory fields complete. Logged to Sales Pipeline & Inquiries!`;
    }

    // SCENARIO 1: MINIMUM VIABLE INQUIRY (Some mandatory fields missing)
    let itemSummary = processedItems
      .map((pi) => {
        const dimStr = pi.dimensions ? ` (${pi.dimensions})` : '';
        const qtyStr = pi.qty > 0 ? ` - ${pi.qty} ${pi.unit || 'MT'}` : '';
        const rateStr = pi.rate > 0 ? ` @ Rs. ${Number(pi.rate).toLocaleString('en-IN')}` : '';
        return `• *${pi.pName}*${dimStr}${qtyStr}${rateStr}`;
      })
      .join('\n');

    return `*Inquiry Logged — Deal ID: ${dealCode}*\n\n` +
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
  findBestDeal,
  findDealByCodeOrId,
  detectInvalidUnitInMessage,
  extractDeliveryLocation,
  evaluateMandatoryFields,
};
