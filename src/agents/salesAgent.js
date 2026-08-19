/**
 * KRA 1 - Sales Achievement & Pipeline Agent
 * Version: 2026.08.13-v2 (Production Build Fix)
 *
 * DESIGN PRINCIPLES:
 * - One deal per customer inquiry. Stage updates modify THAT deal, never create a new one.
 * - A "won" event logs to KRA 1. A "lost" event logs to KRA 4 loss analytics.
 * - KRA 5 (Payment) is NEVER touched here. Payment is explicitly separate.
 * - PO images mark the existing deal as won, never create a duplicate deal.
 * - Multi-item requirements (e.g. 20 MT CR Sheets + 10 MT MS Plates) extract as SEPARATE line items,
 *   match each against the rate sheet individually, and compute exact total.
 */

const { HumanMessage, SystemMessage } = require('@langchain/core/messages');
const { supabase, verifyAndGetCustomerName, saveActiveSession } = require('../supabase');
const { syncActivity } = require('./biginSyncAgent');

const SALES_AGENT_PROMPT = `
You are the Specialized Sales Achievement & Pipeline Agent for Enlight Metals (B2B Steel Distributor).
Your job is to analyze salesperson messages reporting sales actions, deal status updates, stage changes, or customer product requirements/inquiries.

Input message can be English, Hindi, or Hinglish.

Extract into ONLY a JSON object (no markdown, no prose, no backticks):
{
  "action": "stage_update|purchase_order|inquiry",
  "customer_name": "<exact company/customer name requesting material or placing order, else null>",
  "customer_phone": "<customer phone number ONLY if explicitly provided in text e.g. 9812345670, else null>",
  "target_stage": "new_inquiry|qualified|quoted|negotiation|won|lost",
  "line_items": [
    {
      "product_requirement": "<specific product name e.g. CR Coil, HR Coil, CR Sheets, MS Plates, TMT Bar>",
      "dimensions": "<explicit dimensions/thickness if stated e.g. 6mm, 8mm, 2mm, else null>",
      "quantity_mt": <numeric tonnage for this specific item e.g. 20>,
      "rate_per_mt": <numeric per-MT price ONLY if explicitly mentioned in message, else null>
    }
  ],
  "total_amount": <numeric total deal value in rupees ONLY if explicitly mentioned in text, else 0>,
  "delivery_location": "<exact city/location if mentioned e.g. Nashik, Mumbai, Pune, else null>",
  "delivery_date": "<delivery deadline in YYYY-MM-DD format using current year 2026 if mentioned e.g. 2026-08-25 for 'before 25 August', else null>",
  "payment_terms": "<payment terms ONLY if explicitly stated in text, else null>",
  "po_number": "<PO number if mentioned, else null>",
  "po_date": "<PO date / target PO date in YYYY-MM-DD format using year 2026 e.g. 2026-08-28 for '28 August', else null>",
  "loss_reason": "<inferred reason if deal was lost, else null>",
  "confidence": <float 0.0 to 1.0>
}

CRITICAL EXTRACTION RULES & CONTEXT DISAMBIGUATION:
1. CUSTOMER NAME: Extract the customer/company name requesting the product (e.g. from "New inquiry – company hai Suryansh Metals Pvt Ltd, 20 MT CR coil..." -> customer_name is "Suryansh Metals Pvt Ltd"). If no company is explicitly mentioned, customer_name MUST be null. NEVER output the salesperson's name as customer_name.
2. PRODUCT & QUANTITY: Extract product quantity whenever a number is directly associated with a valid metal unit (e.g. "20 MT", "50 tons", "1500 Kg", "100 Sheets", "50 Pcs"). "20 MT CR coil chahiye 6mm" -> product_requirement: "CR Coil", quantity_mt: 20, dimensions: "6mm".
3. SPECIFICATIONS: Extract thickness and dimensions explicitly stated (e.g. "6mm" -> dimensions: "6mm"). NEVER drop thickness/specifications when explicitly mentioned.
4. CUSTOMER PHONE: Extract 10-digit customer mobile/phone number if provided in the text (e.g. "number 9812345670" -> "9812345670").
5. TARGET PO DATE: When target PO date is mentioned, convert to YYYY-MM-DD format with year 2026 and assign to po_date.
6. PAYMENT TERMS: Extract payment terms and credit duration (e.g. "30 days credit"). "30 days" in payment context is credit duration in payment_terms, NEVER product quantity.
7. DELIVERY LOCATION: Extract exact city/location mentioned (e.g. "Nashik", "Mumbai").

Return ONLY the JSON object.
`;

/**
 * Check if a product text matches existing deal line items.
 * Returns true if the new product is the SAME category/family as existing items.
 */
async function isProductMatchForExistingDeal(dealId, newProductText) {
  if (!newProductText || !dealId) return true; // no product info → assume stage update

  const { data: items } = await supabase
    .from('deal_items')
    .select('sku_text')
    .eq('deal_id', dealId);

  if (!items || items.length === 0) return true; // no existing items → safe to update

  const newLower = newProductText.toLowerCase();
  const newKeywords = newLower.split(/\s+/).filter((w) => w.length > 2);

  for (const item of items) {
    if (!item.sku_text) continue;
    const existingLower = item.sku_text.toLowerCase();
    const hasMatch = newKeywords.some((kw) => existingLower.includes(kw));
    if (hasMatch) return true; // same product family → update existing deal
  }

  // No keyword match → different product → should be a new deal
  return false;
}

/**
 * Detects if a message contains a number with an invalid/non-steel unit (e.g. "15 apple", "20 boxes").
 */
function detectInvalidUnitInMessage(text) {
  if (!text) return null;
  // Remove commas inside numbers (e.g. "58,000" -> "58000")
  const cleanText = text.replace(/(\d+),(\d+)/g, '$1$2');

  const VALID_STEEL_UNITS = [
    // Commercial Billing & Mass Units
    'mt',
    'ton',
    'tons',
    'tonne',
    'tonnes',
    'metric ton',
    'metric tons',
    'kg',
    'kgs',
    'kilogram',
    'kilograms',
    'cwt',
    'hundredweight',

    // Flat Rolled Steel Shape & Physical Ordering Units (Sheets, Plates, Coils)
    'sheet',
    'sheets',
    'plate',
    'plates',
    'coil',
    'coils',
    'ga',
    'gauge',

    // Long & Structural Products (Rebar, Bars, Beams, Channels, Angles, Pipe)
    'pcs',
    'piece',
    'pieces',
    'nos',
    'number',
    'numbers',
    'bar',
    'bars',
    'length',
    'lengths',
    'bundle',
    'bundles',
    'rmtr',
    'rm',
    'running meter',
    'running meters',
    'pipe',
    'pipes',
    'tube',
    'tubes',
    'sch',
    'schedule',
    'meter',
    'meters',
    'm',
    'ft',
    'feet',
    'inch',
    'inches',
  ];

  // If the message contains at least one valid metal quantity unit (e.g. 30 MT, 50 tons, 1500 kg),
  // then do NOT fail the message on auxiliary dates, durations, or payment terms!
  const hasValidSteelUnit = VALID_STEEL_UNITS.some((u) => {
    const regex = new RegExp(`\\b\\d+(?:\\.\\d+)?\\s*${u}\\b`, 'i');
    return regex.test(cleanText);
  });

  const SKIP_WORDS = [
    // Ordinals, dimensions, and technical specs
    'th',
    'st',
    'nd',
    'rd',
    'mm',
    'cm',
    'm',
    'km',
    'sqm',
    'sqft',
    'ga',
    'sch',
    'dia',
    'diameter',
    'grade',
    'grades',
    'e250',
    'e350',
    'fe500',
    'fe500d',
    'fe550',
    'fe550d',
    'is2062',
    'is513',
    'is277',
    'is3589',

    // Time durations, deadlines, and dates
    'day',
    'days',
    'd',
    'week',
    'weeks',
    'wk',
    'wks',
    'month',
    'months',
    'mo',
    'mos',
    'year',
    'years',
    'yr',
    'yrs',
    'hour',
    'hours',
    'hr',
    'hrs',
    'min',
    'mins',
    'minute',
    'minutes',
    'am',
    'pm',
    'jan',
    'january',
    'feb',
    'february',
    'mar',
    'march',
    'apr',
    'april',
    'may',
    'jun',
    'june',
    'jul',
    'july',
    'aug',
    'august',
    'sep',
    'sept',
    'september',
    'oct',
    'october',
    'nov',
    'november',
    'dec',
    'december',

    // Payment, credit, financial, and percentage terms
    'credit',
    'advance',
    'payment',
    'terms',
    'cash',
    'cheque',
    'rtgs',
    'neft',
    'pdc',
    'lc',
    'cad',
    'net',
    'percent',
    'percentage',
    'pct',
    'pr',
    'lakh',
    'lakhs',
    'k',
    'cr',
    'crore',
    'crores',
    'rs',
    'rupees',
    'inr',
    'rate',
    'price',
    'val',
    'value',
    'total',
    'subtotal',
    'amount',
    'tax',
    'gst',

    // Prepositions, connectors, entity types, and locations
    'of',
    'to',
    'for',
    'in',
    'and',
    'per',
    'at',
    'by',
    'with',
    'on',
    'before',
    'after',
    'target',
    'pune',
    'mumbai',
    'delhi',
    'ahmedabad',
    'chennai',
    'hyderabad',
    'kolkata',
    'nagpur',
    'chakan',
    'talegaon',
    'turbhe',
    'requirement',
    'requirements',
    'req',
    'reqs',
    'inquiry',
    'inquiries',
    'quotation',
    'quotations',
    'quote',
    'quotes',
    'order',
    'orders',
    'po',
    'ref',
    'no',
    'num',
    'number',
    'item',
    'items',
    'spec',
    'specs',
    'specification',
    'specifications',
    'delivery',
    'location',
    'destination',
    'address',
    'date',
    'dated',
    'vendor',
    'code',
    'page',
    'id',
    'thickness',
    'width',
    'length',
    'size',
    'weight',
    'warehouse',
  ];

  const matches = cleanText.match(/(\d+(?:\.\d+)?)\s*([a-zA-Z]+)/g);
  if (!matches) return null;

  for (const m of matches) {
    const parts = m.trim().split(/\s+/);
    if (parts.length === 2) {
      const num = parts[0];
      const unit = parts[1].toLowerCase();

      if (SKIP_WORDS.includes(unit)) continue;
      if (VALID_STEEL_UNITS.includes(unit)) continue;

      // If message already has a confirmed valid steel quantity (e.g. 30 MT), don't flag unknown auxiliary words
      if (hasValidSteelUnit) continue;

      return {
        number: num,
        invalidUnit: parts[1],
      };
    }
  }

  return null;
}

/**
 * Gets human-readable Deal Code e.g. #DEAL-B8018B
 */
function getDealCode(deal) {
  if (!deal) return '#DEAL-UNKNOWN';
  if (deal.deal_number) return `#${deal.deal_number}`;
  const code = (deal.id || '').substring(0, 6).toUpperCase();
  return `#DEAL-${code}`;
}

/**
 * Fetch ALL open/active (non-won, non-lost) deals for a customer.
 */
async function getAllOpenDealsForCustomer(customerName, senderPhone) {
  if (!customerName) return [];
  const { data } = await supabase
    .from('deals')
    .select('*, deal_items(*)')
    .ilike('customer_name', `%${customerName}%`)
    .not('stage', 'in', '("won","lost")')
    .order('created_at', { ascending: false });

  return data || [];
}

/**
 * Finds the best matching existing deal for a customer.
 * Priority: salesperson's own deals → active stages first → most recent.
 */
async function findBestDeal(customerName, senderPhone) {
  const { data: ownActive } = await supabase
    .from('deals')
    .select('*')
    .ilike('customer_name', `%${customerName}%`)
    .eq('salesperson_phone', senderPhone)
    .not('stage', 'in', '("won","lost")')
    .order('created_at', { ascending: false })
    .limit(1);

  if (ownActive && ownActive.length > 0) return ownActive[0];

  const { data: ownAny } = await supabase
    .from('deals')
    .select('*')
    .ilike('customer_name', `%${customerName}%`)
    .eq('salesperson_phone', senderPhone)
    .order('created_at', { ascending: false })
    .limit(1);

  return ownAny && ownAny.length > 0 ? ownAny[0] : null;
}

/**
 * Gets deal item amounts to compute total_amount if not explicitly stated.
 */
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

/**
 * Checks if KRA 1 was already logged for a specific deal.
 */
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
  isDimensionCompatible,
  lookupRateSheetPrice,
  calculateLineItem,
  calculateLineItems,
  calculateSubtotal,
  calculateGst,
  calculateGrandTotal,
  calculatePricingSummary,
} = require('../utils/pricingEngine');

/**
 * Main text message handler.
 * Accepts optional overrideData (pre-extracted / merged context) for multi-step confirmation flows.
 */
async function processSalesMessage(text, senderPhone, overrideData = null) {
  try {
    let data = overrideData;

    if (!data) {
      // 1. Immediately reject invalid/nonsense units (e.g. "15 apple") before processing
      const invalidUnitCheck = detectInvalidUnitInMessage(text);
      if (invalidUnitCheck) {
        return `❌ *Invalid Quantity Unit*\n\n` +
          `You specified *${invalidUnitCheck.number} ${invalidUnitCheck.invalidUnit}*.\n\n` +
          `Metal products cannot be measured in *"${invalidUnitCheck.invalidUnit}"*.\n\n` +
          `Please specify the quantity using a valid unit (e.g. **15 MT**, **1500 Kg**, **100 Sheets**, or **50 Pcs**).`;
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
        console.warn('[SalesAgent] LLM extraction notice, utilizing rule-based extraction engine:', llmErr.message);
      }

      if (!data || data.confidence < 0.3) {
        // Deterministic rule-based extraction fallback
        const textRaw = text || '';
        const textLower = textRaw.toLowerCase();

        // Extract customer name
        let ruleCustomer = null;
        const reqMatch = textRaw.match(/^([A-Z0-9\s&.-]{2,40}?)\s+(?:requires|require|needs|need|inquiry|rfq|po|order|want)\b/i) ||
          textRaw.match(/(?:inquiry\s+from|order\s+from|rfq\s+from|from)\s+([A-Z0-9\s&.-]{2,40}?)(?:\s+requires|\s+needs|\s+for|\s+before|\.|$)/i) ||
          textRaw.match(/(?:customer|company|client|pvt\.?\s*ltd\.?|ltd\.?|infra|steel|engineering|industries)\s+([A-Z0-9\s&.-]{3,35})/i);
        if (reqMatch && reqMatch[1].trim().toLowerCase() !== 'max' && reqMatch[1].trim().toLowerCase() !== 'customer') {
          ruleCustomer = reqMatch[1].trim();
        }

        // Extract quantity, unit, and specification
        const qtyMatch = textRaw.match(/(\d+(?:\.\d+)?)\s*(?:mt|ton|tons|tonne)/i);
        const qty = qtyMatch ? parseFloat(qtyMatch[1]) : 0;

        const mmM = textRaw.match(/(\d+(?:\.\d+)?)\s*mm/i);
        const specDim = mmM ? `${mmM[1]}mm` : null;

        let pReq = null;
        if (/\b(hr\s*coil|hot\s*rolled\s*coil)\b/i.test(textLower)) {
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
        }

        // Extract customer phone
        const phoneMatch = textRaw.match(/(?:number|phone|mobile|contact|cell)?\s*(?:is|:|-)?\s*([6-9]\d{9})\b/i);
        const rulePhone = phoneMatch ? phoneMatch[1] : null;

        // Extract delivery location
        let delLoc = null;
        const locM = textRaw.match(/(?:for\s+delivery\s+to|delivery\s+to|delivery\s+at|deliver\s+karna\s+hai|location|destination)\s+([A-Za-z\s]+?)(?:\s+before|\s+by|\s+on|\s+within|\s+deliver|\.|$)/i);
        if (locM) {
          delLoc = locM[1].trim();
        } else if (textLower.includes('nashik')) {
          delLoc = 'Nashik';
        } else if (textLower.includes('mumbai')) {
          delLoc = 'Mumbai';
        } else if (textLower.includes('pune')) {
          delLoc = 'Pune';
        }

        // Extract delivery date
        let delDate = null;
        const dM = textRaw.match(/(?:before|by|on|delivery\s+date|delivery\s+before|delivery\s+by)\s+(\d{1,2}(?:st|nd|rd|th)?\s+(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*|\d{4}-\d{2}-\d{2}|\d{2}[-/]\d{2}[-/]\d{4})/i);
        if (dM) {
          const rawDateStr = dM[1].trim();
          const monthMap = {
            jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
            jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
            january: '01', february: '02', march: '03', april: '04', june: '06',
            july: '07', august: '08', september: '09', october: '10', november: '11', december: '12'
          };
          const parts = rawDateStr.toLowerCase().split(/\s+/);
          if (parts.length === 2) {
            const day = parts[0].replace(/\D/g, '').padStart(2, '0');
            const mKey = parts[1].replace(/[^a-z]/g, '');
            const month = monthMap[mKey] || '08';
            delDate = `2026-${month}-${day}`;
          } else {
            delDate = rawDateStr;
          }
        }

        if (ruleCustomer || pReq || qty > 0) {
          data = {
            action: 'inquiry',
            customer_name: ruleCustomer,
            target_stage: 'new_inquiry',
            customer_phone: rulePhone,
            line_items: [
              {
                product_requirement: pReq || 'CR Coil',
                dimensions: specDim,
                quantity_mt: qty,
                rate_per_mt: null,
              }
            ],
            total_amount: 0,
            delivery_location: delLoc,
            delivery_date: delDate,
            payment_terms: null,
            confidence: 0.9,
          };
        } else {
          return `❓ I couldn't clearly understand the deal update. Could you please specify the customer name and status (e.g. "Mehta Engineering 20 MT CR sheets quote sent")?`;
        }
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
      '8262937458', '9619226169', '7977088031', '9187305823', '9876543210',
      '9876543222', '7896248624', '7892739774', '7878787878', '7894561237'
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

    let customerName = data.customer_name;
    if (isInvalidCustomerName(customerName)) {
      customerName = null;
    }

    const textLower = (text || '').toLowerCase();
    const isNewReqMessage = /\b(need|requires|required|want|order|inquiry|rfq|new deal)\b/i.test(textLower);

    if (customerName && isNewReqMessage && !overrideData) {
      // Check if user actually wrote the company name in the text
      const nameWords = customerName.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
      const nameInText = nameWords.some((w) => textLower.includes(w));
      if (!nameInText) {
        customerName = null; // Ignore LLM history hallucination for new inquiries
      }
    }

    if (!customerName || customerName.length < 2) {
      if (!isNewReqMessage) {
        const { getActiveSession } = require('../supabase');
        const activeCust = await getActiveSession(senderPhone);
        if (activeCust && activeCust !== 'Unknown' && !isInvalidCustomerName(activeCust)) {
          customerName = activeCust;
        }
      }
    }

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

    // Strict safety check: Under no circumstance should any salesperson's / employee's phone ever be used as customer phone
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

    // Multi-item extraction and rate sheet price calculation
    let rawItems = [];
    if (Array.isArray(data.line_items) && data.line_items.length > 0) {
      rawItems = data.line_items;
    } else if (data.product_requirement || data.quantity_mt) {
      rawItems = [{
        product_requirement: data.product_requirement,
        dimensions: data.dimensions || null,
        quantity_mt: data.quantity_mt,
        rate_per_mt: data.rate_per_mt,
      }];
    }

    let processedItems = [];
    let calculatedTotal = 0;
    let hasUnlistedMaterial = false;
    let unlistedMaterialName = '';

    const GENERIC_PRODUCT_REGEX = /^(steel requirement|product requirement|steel|material|requirement|inquiry|unknown|item|null|undefined)$/i;

    for (const item of rawItems) {
      let pName = item.product_requirement ? item.product_requirement.trim() : null;
      if (pName && GENERIC_PRODUCT_REGEX.test(pName)) {
        pName = null;
      }

      const qty = Number(item.quantity_mt || item.quantity || item.qty || 0) || 0;
      let rate = Number(item.rate_per_mt || item.rate || item.unitPrice || 0) || 0;
      const rawDim = item.dimensions || (pName?.match(/(\d+(?:\.\d+)?)\s*mm/i) ? pName.match(/(\d+(?:\.\d+)?)\s*mm/i)[1] + ' mm' : (text.match(/(\d+(?:\.\d+)?)\s*mm/i) ? text.match(/(\d+(?:\.\d+)?)\s*mm/i)[1] + ' mm' : null));

      if (pName) {
        if (!rate) {
          const autoRate = await lookupRateSheetPrice(pName);
          if (autoRate) {
            rate = autoRate.price_per_mt;
            pName = autoRate.matched_sku || pName;
          } else if (qty > 0 || data.action === 'purchase_order') {
            hasUnlistedMaterial = true;
            unlistedMaterialName = pName;
          }
        }
      } else if (qty > 0) {
        // Quantity specified but NO specific metal product name was mentioned!
        const pendingContext = {
          action: data.action || 'inquiry',
          customer_name: finalCustomerName,
          customer_phone: actualCustomerPhone || data.customer_phone || null,
          target_stage: targetStage || 'new_inquiry',
          raw_text: data.raw_text || text,
          delivery_location: data.delivery_location || null,
          delivery_date: data.delivery_date || null,
          payment_terms: data.payment_terms || null,
          po_number: data.po_number || null,
          po_date: data.po_date || null,
          quantity_mt: qty,
          unit: 'MT',
          confidence: data.confidence || 0.95,
        };
        const { saveActiveSession } = require('../supabase');
        await saveActiveSession(
          senderPhone,
          finalCustomerName,
          `pending_product_for_deal|${finalCustomerName}|${qty}|MT|${JSON.stringify(pendingContext)}`
        );
        return `❓ *Which metal product is ${finalCustomerName} asking for?*\n\n` +
          `You specified a quantity of *${qty} MT*, but no specific metal product was mentioned.\n\n` +
          `Please reply with the product name (e.g. _HR Coil_, _CR Sheet_, _TMT Bar_, _MS Plates_) so I can record the requirement for your Sales Pipeline! 📈`;
      }

      const lineCalc = calculateLineItem({ quantity: qty, rate });
      const itemAmount = lineCalc.amount;
      calculatedTotal += itemAmount;

      processedItems.push({
        pName: pName || 'Metal Product',
        dimensions: rawDim,
        qty,
        rate,
        itemAmount,
      });
    }

    if (hasUnlistedMaterial && calculatedTotal === 0) {
      const pendingContext = {
        action: data.action || 'inquiry',
        customer_name: finalCustomerName,
        customer_phone: actualCustomerPhone || data.customer_phone || null,
        target_stage: targetStage || 'new_inquiry',
        raw_text: data.raw_text || text,
        unlisted_material: unlistedMaterialName,
        delivery_location: data.delivery_location || null,
        delivery_date: data.delivery_date || null,
        payment_terms: data.payment_terms || null,
        po_number: data.po_number || null,
        po_date: data.po_date || null,
        line_items: rawItems.map((ri, idx) => {
          const pi = processedItems[idx];
          return {
            product_requirement: pi?.pName || ri.product_requirement,
            dimensions: pi?.dimensions || ri.dimensions || (text.match(/(\d+(?:\.\d+)?)\s*mm/i) ? text.match(/(\d+(?:\.\d+)?)\s*mm/i)[1] + ' mm' : null),
            quantity_mt: pi?.qty || ri.quantity_mt || 0,
            rate_per_mt: pi?.rate || ri.rate_per_mt || null,
          };
        }),
        confidence: data.confidence || 0.95,
      };

      const { saveActiveSession } = require('../supabase');
      await saveActiveSession(
        senderPhone,
        finalCustomerName,
        `pending_custom_rate|${finalCustomerName}|${unlistedMaterialName}|${JSON.stringify(pendingContext)}`
      );
      return `⚠️ *Product Price Confirmation Required*\n\n` +
        `The material *"${unlistedMaterialName}"* is not listed in our active rate sheet.\n\n` +
        `Please confirm the per MT rate for *${unlistedMaterialName}* (e.g. reply _"54000"_ or _"${unlistedMaterialName} rate is 54000"_) so I can calculate the deal quotation and update your Sales Pipeline & Inquiries! 📈`;
    }

    let dealAmount = 0;
    if (data.total_amount && Number(data.total_amount) > 0) {
      dealAmount = Number(data.total_amount);
    } else if (calculatedTotal > 0) {
      dealAmount = calculatedTotal;
      if (targetStage === 'new_inquiry' || targetStage === 'qualified') {
        targetStage = 'quoted';
      }
    }

    const stageMap = {
      new_inquiry: 'new_inquiry',
      qualified: 'qualified',
      quoted: 'quoted',
      negotiation: 'negotiation',
      won: 'won',
      lost: 'lost',
    };
    const dbStage = stageMap[targetStage] || 'new_inquiry';

    if (!officialCustomerName) {
      const { ensureCustomerRecord } = require('../supabase');
      await ensureCustomerRecord(customerName, senderPhone, {
        customer_phone: data.customer_phone || null,
      });
      console.log(`[SalesAgent] Auto-created new prospect: ${customerName}`);
    }

    // MULTI-DEAL RESOLUTION: Fetch all active open deals for this client
    const openDeals = await getAllOpenDealsForCustomer(finalCustomerName, senderPhone);
    let existingDeal = null;
    let dealId = null;

    // Check if salesperson explicitly specified a Deal ID/Code in raw message e.g. #DEAL-B8018B or DEAL-B8018B or B8018B or index 1/2
    const dealIdMatch = text.match(/#?(DEAL-[A-F0-9]{4,6}|[A-F0-9]{6})/i);
    const numChoiceMatch = text.trim().match(/^([1-9])$/);

    if (dealIdMatch && openDeals.length > 0) {
      const targetCode = dealIdMatch[1].toUpperCase().replace('DEAL-', '');
      existingDeal = openDeals.find(d => (d.id || '').toUpperCase().includes(targetCode) || (d.deal_number && d.deal_number.toUpperCase().includes(targetCode)));
      if (existingDeal) {
        console.log(`[SalesAgent] Explicitly targeted deal ${getDealCode(existingDeal)} for ${finalCustomerName}`);
      }
    } else if (numChoiceMatch && openDeals.length > 0) {
      const idx = parseInt(numChoiceMatch[1], 10) - 1;
      if (openDeals[idx]) {
        existingDeal = openDeals[idx];
        console.log(`[SalesAgent] Selected deal #${idx + 1} (${getDealCode(existingDeal)}) for ${finalCustomerName}`);
      }
    }

    if (!existingDeal && openDeals.length === 1) {
      existingDeal = openDeals[0];
    } else if (!existingDeal && openDeals.length > 1) {
      // Multiple active open deals exist for this client and no specific Deal ID was mentioned!
      const isStageUpdateOrInquiry = data.action === 'stage_update' || !data.product_requirement;
      if (isStageUpdateOrInquiry) {
        const dealsListStr = openDeals.map((d, idx) => {
          const code = getDealCode(d);
          const itemsStr = (d.deal_items || []).map(i => `${i.quantity || ''} ${i.unit || 'MT'} ${i.sku_text || 'Product'}`).join(', ') || d.inquiry_type || 'Product Requirement';
          const valStr = d.total_amount > 0 ? ` (₹${Number(d.total_amount).toLocaleString('en-IN')})` : '';
          const stageStr = d.stage ? d.stage.toUpperCase() : 'OPEN';
          return `${idx + 1}️⃣ *${code}* — ${itemsStr}${valStr} [Stage: ${stageStr}]`;
        }).join('\n');

        const { saveActiveSession } = require('../supabase');
        await saveActiveSession(senderPhone, finalCustomerName, `pending_deal_choice|${finalCustomerName}|${dbStage}|${text}`);

        return `❓ *Multiple Active Deals Found for ${finalCustomerName}*\n\n` +
          `${finalCustomerName} has *${openDeals.length} active deals* in your sales pipeline:\n\n` +
          `${dealsListStr}\n\n` +
          `Please reply with the **Deal ID** (e.g. _"${getDealCode(openDeals[0])}"_) or option number to specify which deal to update! 📈`;
      }
    }

    if (existingDeal) {
      const isStageUpdateOnly =
        !data.product_requirement &&
        !data.quantity_mt &&
        rawItems.length === 0;
      const productMatchesExisting = await isProductMatchForExistingDeal(
        existingDeal.id,
        data.product_requirement ||
          (rawItems.length > 0 ? rawItems[0].product_requirement : null),
      );

      if (isStageUpdateOnly || productMatchesExisting) {
        dealId = existingDeal.id;
        console.log(
          `[SalesAgent] Updating existing deal ${getDealCode(existingDeal)} for ${finalCustomerName}`,
        );
      } else {
        dealId = null;
        console.log(
          `[SalesAgent] New product category detected — creating separate deal for ${finalCustomerName}`,
        );
      }
    }

    if (dealAmount === 0 && dealId) {
      const itemsTotal = await getDealAmountFromItems(dealId);
      dealAmount = itemsTotal > 0 ? itemsTotal : Number(existingDeal.total_amount || 0);
    }

    const poDate = data.po_date || new Date().toISOString().split('T')[0];
    let poNumber = existingDeal ? existingDeal.po_number : null;

    // PO is created ONLY after the deal is WON!
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
      poNumber = null; // Ensure PO remains null for non-won pipeline deals
    }

    if (dealId) {
      // ---- UPDATE existing deal ----
      const updatePayload = {
        customer_name: finalCustomerName,
        customer_phone: actualCustomerPhone,
        stage: dbStage,
        po_date: poDate,
        po_number: poNumber,
        delivery_location: data.delivery_location || null,
        delivery_date: data.delivery_date || null,
        payment_terms: data.payment_terms || null,
        total_amount: dealAmount || 0,
      };

      if (dbStage === 'won') updatePayload.won_at = new Date().toISOString();

      if (dbStage === 'lost') {
        if (data.loss_reason && data.loss_reason !== 'Not specified' && data.loss_reason.length > 2) {
          updatePayload.lost_reason = data.loss_reason;
        } else {
          const { saveActiveSession } = require('../supabase');
          await saveActiveSession(senderPhone, finalCustomerName, `pending_loss_reason|${dealId}|${finalCustomerName}`);
          return `❌ *Marking Deal as Lost: ${finalCustomerName}*\n\n` +
            `Please reply with the reason for rejection (reply with a number or type your own reason):\n\n` +
            `1️⃣ Price too high\n` +
            `2️⃣ Credit terms / Payment terms mismatch\n` +
            `3️⃣ Delivery timeline delay\n` +
            `4️⃣ Material unavailable / Out of stock\n` +
            `5️⃣ Spec mismatch\n` +
            `6️⃣ Competitor relationship\n` +
            `7️⃣ Customer silent / No response\n` +
            `8️⃣ Cancelled by customer`;
        }
      }

      const { error: dealUpdateErr } = await supabase
        .from('deals')
        .update(updatePayload)
        .eq('id', dealId);

      if (dealUpdateErr) {
        console.error('[SalesAgent] Deal update error:', dealUpdateErr);
      }

      if (processedItems.length > 0) {
        await supabase
          .from('deal_items')
          .delete()
          .eq('deal_id', dealId);

        for (const pItem of processedItems) {
          await supabase.from('deal_items').insert({
            deal_id: dealId,
            sku_text: pItem.pName,
            dimensions: pItem.dimensions || (pItem.pName?.match(/(\d+(?:\.\d+)?)\s*mm/i) ? pItem.pName?.match(/(\d+(?:\.\d+)?)\s*mm/i)[1] + ' mm' : null),
            quantity: pItem.qty > 0 ? pItem.qty : null,
            unit: 'MT',
            rate: pItem.rate > 0 ? pItem.rate : null,
            amount: pItem.itemAmount > 0 ? pItem.itemAmount : null,
            created_at: new Date().toISOString(),
          });
        }
      }
    } else {
      if (dbStage === 'lost' && !data.loss_reason) {
        const { getFullActiveSession, saveActiveSession } = require('../supabase');
        const session = await getFullActiveSession(senderPhone);
        const isLossReasonPrompted = session?.last_intent?.startsWith('pending_loss_reason|');

        if (!isLossReasonPrompted) {
          await saveActiveSession(
            senderPhone,
            finalCustomerName,
            `pending_loss_reason|null|${finalCustomerName}`,
          );

          return `❓ *Deal Marked as Lost — Reason Required*\n\n` +
            `Please specify why the deal for *${finalCustomerName}* was lost:\n\n` +
            `1️⃣ Price too high\n` +
            `2️⃣ Payment/Credit terms mismatch\n` +
            `3️⃣ Delivery timeline issue\n` +
            `4️⃣ Material unavailable / Out of stock\n` +
            `5️⃣ Spec mismatch\n` +
            `6️⃣ Competitor relationship\n` +
            `7️⃣ Customer silent / No response\n` +
            `8️⃣ Cancelled by customer`;
        }
      }

      const { data: newDeal, error: dealInsertErr } = await supabase
        .from('deals')
        .insert({
          customer_name:     finalCustomerName,
          salesperson_phone: senderPhone,
          customer_phone:    actualCustomerPhone,
          stage:             dbStage,
          total_amount:      dealAmount || 0,
          inquiry_type:      'inquiry',
          delivery_location: data.delivery_location || null,
          delivery_date:     data.delivery_date || null,
          payment_terms:     data.payment_terms || null,
          po_date:           poDate,
          po_number:         poNumber,
          won_at:            dbStage === 'won' ? new Date().toISOString() : null,
          lost_reason:       dbStage === 'lost' ? data.loss_reason : null,
        })
        .select()
        .single();

      if (dealInsertErr) {
        console.error('[SalesAgent] Fatal deals insert error:', dealInsertErr);
      }

      if (newDeal) {
        dealId = newDeal.id;
        for (const pItem of processedItems) {
          await supabase.from('deal_items').insert({
            deal_id: dealId,
            sku_text: pItem.pName,
            dimensions: pItem.dimensions || (pItem.pName?.match(/(\d+(?:\.\d+)?)\s*mm/i) ? pItem.pName?.match(/(\d+(?:\.\d+)?)\s*mm/i)[1] + ' mm' : null),
            quantity: pItem.qty > 0 ? pItem.qty : null,
            unit: 'MT',
            rate: pItem.rate > 0 ? pItem.rate : null,
            amount: pItem.itemAmount > 0 ? pItem.itemAmount : null,
            created_at: new Date().toISOString(),
          });
        }
      }
    }

    const totalQty = processedItems.reduce((s, i) => s + i.qty, 0);
    const pricingSummary = calculatePricingSummary({
      line_items: processedItems.map(pi => ({ quantity: pi.qty, rate: pi.rate, amount: pi.itemAmount })),
    });

    // Mandatory atomic sync to inquiries table for dashboard
    try {
      const structuredExtraction = {
        customer_name: finalCustomerName,
        companyName: finalCustomerName,
        customer_phone: actualCustomerPhone,
        customerPhone: actualCustomerPhone,
        delivery_location: data.delivery_location || null,
        deliveryLocation: data.delivery_location || null,
        delivery_date: data.delivery_date || null,
        deliveryDate: data.delivery_date || null,
        payment_terms: data.payment_terms || null,
        paymentTerms: data.payment_terms || null,
        productType: processedItems[0]?.pName || 'CR Coil',
        thickness: processedItems[0]?.dimensions || '',
        width: '',
        length: '',
        productForm: 'Coil',
        quantityTons: totalQty || processedItems[0]?.qty || 0,
        unitPrice: processedItems[0]?.rate || 0,
        total_amount: dealAmount || pricingSummary.subtotal,
        totalAmount: dealAmount || pricingSummary.subtotal,
        subtotal: pricingSummary.subtotal,
        gst_amount: pricingSummary.gstAmount,
        grand_total: pricingSummary.grandTotal,
        line_items: processedItems.map((pi) => ({
          sku_text: pi.pName,
          dimensions: pi.dimensions || '',
          quantity: pi.qty,
          unit: 'MT',
          rate: pi.rate,
          amount: pi.itemAmount,
        })),
        financialSummary: {
          subtotal: pricingSummary.subtotal,
          gstAmount: pricingSummary.gstAmount,
          grandTotal: pricingSummary.grandTotal,
        },
        overall_confidence: data.confidence || 0.95,
      };

      const isPurchaseOrder = dbStage === 'won' || data.action === 'purchase_order';
      let inqId = existingDeal?.inquiry_id || null;

      if (!isPurchaseOrder) {
        if (inqId) {
          const { error: inqUpdErr } = await supabase
            .from('inquiries')
            .update({
              sender_name: finalCustomerName,
              sender_phone: actualCustomerPhone || senderPhone,
              salesperson_phone: senderPhone,
              inquiry_type: 'inquiry',
              ai_extraction_json: structuredExtraction,
              status: 'review',
            })
            .eq('id', inqId);
          if (inqUpdErr) {
            console.error('[SalesAgent] Error updating inquiry for deal:', inqUpdErr);
          }
        } else {
          const { data: insertedInq, error: inqInsErr } = await supabase
            .from('inquiries')
            .insert({
              source_channel: 'whatsapp_text',
              raw_text: data.raw_text || text,
              sender_name: finalCustomerName || null,
              sender_phone: actualCustomerPhone || senderPhone,
              salesperson_phone: senderPhone,
              inquiry_type: 'inquiry',
              status: 'review',
              ai_extraction_json: structuredExtraction,
              overall_confidence: data.confidence || 0.95,
              created_at: new Date().toISOString(),
            })
            .select()
            .single();

          if (inqInsErr) {
            console.error('[SalesAgent] Error inserting inquiry for text message:', inqInsErr);
          } else if (insertedInq) {
            inqId = insertedInq.id;
            console.log('[SalesAgent] Successfully logged inquiry record for text message:', inqId);
          }
        }

        if (inqId && dealId) {
          await supabase
            .from('deals')
            .update({ inquiry_id: inqId })
            .eq('id', dealId);
        }
      }
    } catch (inqSyncErr) {
      console.error('[SalesAgent] Inquiries table sync error:', inqSyncErr.message);
    }

    // Update last_order_date in recurring_customers table ONLY when deal is won
    if (dbStage === 'won') {
      try {
        await supabase
          .from('recurring_customers')
          .update({ last_order_date: new Date().toISOString() })
          .ilike('customer_name', `%${finalCustomerName}%`);
      } catch (err) {
        console.error('[SalesAgent] Failed to update last_order_date:', err.message);
      }
    }

    // Edge Case 3: Log KRA 1 ONLY when deal is won
    if (dbStage === 'won' && dealId) {
      const alreadyLogged = await isKRA1AlreadyLogged(
        senderPhone,
        finalCustomerName,
      );
      if (!alreadyLogged) {
        await supabase.from('kra_logs').insert({
          salesperson_phone: senderPhone,
          customer_name: finalCustomerName,
          kra_number: 1,
          kra_type: 'sales_achievement',
          metric_name: 'won_deal_value',
          value: dealAmount,
          notes: `Won deal for ${finalCustomerName}: ₹${dealAmount.toLocaleString('en-IN')}`,
          created_at: new Date().toISOString(),
        });
        console.log(`[SalesAgent] Logged Sales Achievement for won deal: ${finalCustomerName} = ₹${dealAmount}`);
      }
    }

    // Trigger Zoho Bigin Sync
    try {
      const syncType = dbStage === 'won' ? 'deal_won' : dbStage === 'lost' ? 'deal_lost' : 'deal_stage';
      syncActivity(syncType, {
        customerName: finalCustomerName,
        dealId,
        amount: dealAmount,
        stage: dbStage,
        poNumber,
        paymentTerms: data.payment_terms,
        senderPhone,
      });
    } catch (e) {
      console.warn('[SalesAgent] Bigin sync trigger notice:', e.message);
    }

    const { getCustomerMissingInfoPrompt } = require('../supabase');
    const missingPrompt = await getCustomerMissingInfoPrompt(finalCustomerName, senderPhone);

    const activeDeal = existingDeal || { id: dealId };
    const dealCode = getDealCode(activeDeal);

    if (dbStage === 'won') {
      let resultMsg =
        `🎉 *DEAL WON & ORDER CONFIRMED!* 🏆\n\n` +
        `Customer: *${finalCustomerName}*\n` +
        `Deal ID: *${dealCode}*\n` +
        `Official PO Number: *${poNumber}* 📄\n` +
        `Total Value: *₹${Number(dealAmount).toLocaleString('en-IN')}* + GST\n` +
        (poDate ? `PO Date: *${poDate}*\n` : '') +
        `\nUpdated Sales Achievement Card! ✅`;

      if (missingPrompt) {
        resultMsg += `\n\n${missingPrompt}`;
      }
      return resultMsg;
    }

    // Text Inquiry / Non-Won Deal / Quoted: Format line items WITH specifications & rates
    let itemsBreakdownStr = '';
    if (processedItems.length > 0) {
      itemsBreakdownStr = processedItems
        .map((pi) => {
          const dimStr = pi.dimensions ? ` (${pi.dimensions})` : '';
          const rateStr = pi.rate > 0 ? ` @ ₹${Number(pi.rate).toLocaleString('en-IN')}/MT` : '';
          const amtStr = pi.itemAmount > 0 ? ` = ₹${Number(pi.itemAmount).toLocaleString('en-IN')}` : '';
          return `  • *${pi.pName}*${dimStr}${pi.qty > 0 ? ': ' + pi.qty + ' MT' : ''}${rateStr}${amtStr}`;
        })
        .join('\n');
    }

    const gstVal = calculateGst(dealAmount);
    const grandTot = calculateGrandTotal(dealAmount);

    let resultMsg =
      `💼 *Sales Inquiry & Pipeline Logged!* 🏗️\n\n` +
      `Customer: *${finalCustomerName}*\n` +
      `Deal ID: *${dealCode}*\n` +
      `Stage: *${dbStage.toUpperCase()} 📄*\n` +
      (itemsBreakdownStr ? `Line Items:\n${itemsBreakdownStr}\n` : '') +
      (totalQty > 0 ? `Total Quantity: *${totalQty} MT*\n` : '') +
      (dealAmount > 0 ? `Quotation Subtotal: *₹${Number(dealAmount).toLocaleString('en-IN')}* + GST (₹${Number(gstVal).toLocaleString('en-IN')})\nGrand Total: *₹${Number(grandTot).toLocaleString('en-IN')}*\n` : '') +
      (data.delivery_location ? `Delivery Location: *${data.delivery_location}*\n` : '') +
      (data.delivery_date ? `Target Delivery Date: *${data.delivery_date}*\n` : '') +
      `\nLogged to Sales Pipeline & Inquiries! 📋`;

    if (missingPrompt) {
      resultMsg += `\n\n${missingPrompt}`;
    }

    return resultMsg;
  } catch (error) {
    console.error('[SalesAgent] Error processing sales message:', error);
    return `⚠️ Error updating deal: ${error.message}`;
  }
}

/**
 * Process incoming PO / Sales document image via dedicated OCR Agent
 */
async function processSalesImage(imageBuffer, mimeType, senderPhone, messageId) {
  const { processSalesImage: ocrProcess } = require('./ocrAgent');
  return await ocrProcess(imageBuffer, mimeType, senderPhone, messageId);
}

module.exports = {
  processSalesMessage,
  processSalesImage,
  findBestDeal,
  lookupRateSheetPrice,
  detectInvalidUnitInMessage,
};
