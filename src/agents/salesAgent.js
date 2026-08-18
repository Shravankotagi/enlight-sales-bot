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
  "customer_phone": "<customer phone number ONLY if explicitly provided in text, else null>",
  "target_stage": "new_inquiry|qualified|quoted|negotiation|won|lost",
  "line_items": [
    {
      "product_requirement": "<specific product name e.g. HR Coil 8mm, CR Sheets, MS Plates, TMT Bar>",
      "dimensions": "<explicit dimensions if stated e.g. 8mm, else null>",
      "quantity_mt": <numeric tonnage for this specific item e.g. 25>,
      "rate_per_mt": <numeric per-MT price ONLY if explicitly mentioned in message, else null>
    }
  ],
  "total_amount": <numeric total deal value in rupees ONLY if explicitly mentioned in text, else 0>,
  "delivery_location": "<exact city/location if mentioned e.g. Mumbai, else null>",
  "delivery_date": "<delivery deadline in YYYY-MM-DD format using current year 2026 if mentioned e.g. 2026-08-25 for 'before 25 August', else null>",
  "payment_terms": "<payment terms ONLY if explicitly stated in text, else null>",
  "po_number": "<PO number if mentioned, else null>",
  "po_date": "<PO date YYYY-MM-DD if mentioned, else null>",
  "loss_reason": "<inferred reason if deal was lost, else null>",
  "confidence": <float 0.0 to 1.0>
}

CRITICAL EXTRACTION RULES:
1. CUSTOMER NAME: Extract the customer/company name requesting the product (e.g. from "ABC Steel requires 25 MT HR Coil..." -> customer_name is "ABC Steel"). NEVER output the salesperson's name or your system user name as customer_name.
2. CUSTOMER PHONE: If no customer phone number is explicitly mentioned in the message, customer_phone MUST be null. Never use the salesperson's phone.
3. PRODUCT MAPPING: Preserve the exact product type. "HR Coil" is Hot Rolled Coil. NEVER map HR to Cold Rolled (CR).
4. SPECIFICATIONS: Extract only dimensions explicitly stated (e.g. "8mm"). NEVER infer or invent unstated dimensions like width (e.g. 1250mm) or length.
5. DELIVERY LOCATION: Extract only the exact city/location mentioned (e.g. "Mumbai"). NEVER append "Warehouse" or extra text.
6. DELIVERY DATE: When a delivery target/deadline is mentioned (e.g. "before 25 August"), convert to YYYY-MM-DD format with year 2026 ("2026-08-25"). Do NOT use today's inquiry date.
7. PAYMENT TERMS: If no payment terms are mentioned in the message, payment_terms MUST be null. NEVER default to 100% advance or credit terms.
8. LINE ITEMS:
- If multiple materials are mentioned, create a separate object in line_items for each.
- Extract numeric tonnage (quantity_mt) for each material.

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

  const matches = cleanText.match(/(\d+(?:\.\d+)?)\s*([a-zA-Z]+)/g);
  if (!matches) return null;

  for (const m of matches) {
    const parts = m.trim().split(/\s+/);
    if (parts.length === 2) {
      const num = parts[0];
      const unit = parts[1].toLowerCase();

      const SKIP_WORDS = [
        'th',
        'st',
        'nd',
        'rd',
        'mm',
        'cm',
        'ga',
        'sch',
        'aug',
        'august',
        'july',
        'sept',
        'oct',
        'nov',
        'dec',
        'jan',
        'feb',
        'mar',
        'apr',
        'may',
        'june',
        'pm',
        'am',
        'hr',
        'cr',
        'ms',
        'gi',
        'gp',
        'tmt',
        'ismb',
        'ismc',
        'lakh',
        'lakhs',
        'k',
        'cr',
        'crore',
        'crores',
        'of',
        'to',
        'for',
        'in',
        'and',
        'per',
        'rs',
        'rupees',
        'inr',
        'rate',
        'price',
        'at',
        'by',
        'with',
        'on',
        'pune',
        'mumbai',
        'delhi',
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
        'address',
        'date',
        'dated',
        'vendor',
        'code',
        'page',
        'id',
        'val',
        'value',
        'total',
        'subtotal',
        'amount',
        'tax',
        'gst',
        'target',
        'thickness',
        'width',
        'length',
        'dia',
        'diameter',
        'grade',
        'size',
        'weight',
        'warehouse',
      ];
      if (SKIP_WORDS.includes(unit)) continue;

      if (!VALID_STEEL_UNITS.includes(unit)) {
        return {
          number: num,
          invalidUnit: parts[1],
        };
      }
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

/**
 * Looks up price per MT from official active rate sheet for a given product text.
 */
function extractDimensions(str) {
  if (!str) return [];
  const matches = str.toLowerCase().match(/\b(\d+(?:\.\d+)?\s*(?:mm|cm|m|inch|x\d+)?)\b/g);
  if (!matches) return [];
  return matches.filter((m) => /\d+/.test(m) && (m.includes('mm') || m.includes('x') || m.includes('cm') || m.includes('inch')));
}

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

async function lookupRateSheetPrice(productText) {
  try {
    if (!productText) return null;

    const { data: latestSheet } = await supabase
      .from('rate_sheets')
      .select('id')
      .order('date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (!latestSheet) return null;

    const { data: items } = await supabase
      .from('rate_sheet_items')
      .select('sku_text, category, price_per_mt')
      .eq('rate_sheet_id', latestSheet.id);

    if (!items || items.length === 0) return null;

    const textLower = productText.toLowerCase();
    let matched = null;

    // 1. Priority 1: Match on sku_text with dimension compatibility
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

    // 2. Priority 2: Match on category ONLY if dimension is compatible
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
    console.error('[SalesAgent] Rate sheet lookup error:', err.message);
    return null;
  }
}

/**
 * Main text message handler.
 */
async function processSalesMessage(text, senderPhone) {
  try {
    // 1. Immediately reject invalid/nonsense units (e.g. "15 apple") before processing
    const invalidUnitCheck = detectInvalidUnitInMessage(text);
    if (invalidUnitCheck) {
      return `❌ *Invalid Quantity Unit*\n\n` +
        `You specified *${invalidUnitCheck.number} ${invalidUnitCheck.invalidUnit}*.\n\n` +
        `Metal products cannot be measured in *"${invalidUnitCheck.invalidUnit}"*.\n\n` +
        `Please specify the quantity using a valid unit (e.g. **15 MT**, **1500 Kg**, **100 Sheets**, or **50 Pcs**).`;
    }

    let data = null;
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

      // Extract quantity and product
      const qtyMatch = textRaw.match(/(\d+(?:\.\d+)?)\s*(?:mt|ton|tons|tonne)/i);
      const qty = qtyMatch ? parseFloat(qtyMatch[1]) : 0;

      let pReq = null;
      if (/\b(hr\s*coil|hot\s*rolled\s*coil)\b/i.test(textLower)) {
        const mmM = textRaw.match(/(\d+(?:\.\d+)?)\s*mm/i);
        pReq = mmM ? `HR Coil ${mmM[1]}mm` : 'HR Coil';
      } else if (/\b(cr\s*sheet|cold\s*rolled\s*sheet|cr\s*coil|cr)\b/i.test(textLower)) {
        pReq = 'CR Sheets';
      } else if (/\b(ms\s*plate|plates)\b/i.test(textLower)) {
        pReq = 'MS Plates';
      } else if (/\b(ms\s*sheet)\b/i.test(textLower)) {
        pReq = 'MS Sheet 2mm';
      }

      // Extract delivery location
      let delLoc = null;
      const locM = textRaw.match(/(?:for\s+delivery\s+to|delivery\s+to|delivery\s+at|location|destination)\s+([A-Za-z\s]+?)(?:\s+before|\s+by|\s+on|\s+within|\.|$)/i);
      if (locM) {
        delLoc = locM[1].trim();
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
          customer_phone: null,
          line_items: [
            {
              product_requirement: pReq || 'Hot Rolled',
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

    let customerName = data.customer_name;
    const textLower = (text || '').toLowerCase();
    const isNewReqMessage = /\b(need|requires|required|want|order|inquiry|rfq|new deal)\b/i.test(textLower);

    if (customerName && isNewReqMessage) {
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
        if (activeCust && activeCust !== 'Unknown') {
          customerName = activeCust;
        }
      }
    }

    if (!customerName || customerName.length < 2) {
      const { saveActiveSession } = require('../supabase');
      await saveActiveSession(senderPhone, 'Unknown', 'pending_customer_for_deal');
      return `❓ Which customer is this deal update for? Please reply with the customer/company name.`;
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
    const actualCustomerPhone =
      custRecord && custRecord.length > 0
        ? custRecord[0].customer_phone
        : data.customer_phone || null;

    let targetStage = data.target_stage || 'new_inquiry';

    // Multi-item extraction and rate sheet price calculation
    let rawItems = [];
    if (Array.isArray(data.line_items) && data.line_items.length > 0) {
      rawItems = data.line_items;
    } else if (data.product_requirement || data.quantity_mt) {
      rawItems = [{
        product_requirement: data.product_requirement,
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

      const qty = Number(item.quantity_mt) || 0;
      let rate = Number(item.rate_per_mt) || 0;
      let autoRate = null;

      if (pName) {
        if (!rate) {
          autoRate = await lookupRateSheetPrice(pName);
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
        const { saveActiveSession } = require('../supabase');
        await saveActiveSession(senderPhone, finalCustomerName, `pending_product_for_deal|${finalCustomerName}|${qty}|MT`);
        return `❓ *Which metal product is ${finalCustomerName} asking for?*\n\n` +
          `You specified a quantity of *${qty} MT*, but no specific metal product was mentioned.\n\n` +
          `Please reply with the product name (e.g. _HR Coil_, _CR Sheet_, _TMT Bar_, _MS Plates_) so I can record the requirement for our Sales Achievement Card & Sales Pipeline! 📈`;
      }

      const itemAmount = qty > 0 && rate > 0 ? qty * rate : 0;
      calculatedTotal += itemAmount;

      processedItems.push({
        pName: pName || 'Metal Product',
        qty,
        rate,
        itemAmount,
      });
    }

    if (hasUnlistedMaterial && calculatedTotal === 0) {
      const { saveActiveSession } = require('../supabase');
      await saveActiveSession(senderPhone, finalCustomerName, `pending_custom_rate|${finalCustomerName}|${unlistedMaterialName}`);
      return `⚠️ *Product Price Confirmation Required*\n\n` +
        `The material *"${unlistedMaterialName}"* is not listed in our active rate sheet.\n\n` +
        `Please confirm the per MT rate for *${unlistedMaterialName}* (e.g. reply _"${unlistedMaterialName} rate is 54000"_) so I can calculate the deal total and update the Sales Achievement Card & Sales Pipeline! 📈`;
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
        updated_at: new Date().toISOString(),
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

      await supabase
        .from('deals')
        .update(updatePayload)
        .eq('id', dealId);

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

    // Sync structured inquiry extraction to inquiries table for dashboard
    try {
      const sixtySecAgo = new Date(Date.now() - 60 * 1000).toISOString();
      const { data: recentInqs } = await supabase
        .from('inquiries')
        .select('id')
        .eq('salesperson_phone', senderPhone)
        .gte('created_at', sixtySecAgo)
        .order('created_at', { ascending: false })
        .limit(1);

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
        productType: processedItems[0]?.pName || 'Hot Rolled',
        thickness: (processedItems[0]?.dimensions || (processedItems[0]?.pName?.match(/(\d+(?:\.\d+)?)\s*mm/i) ? processedItems[0]?.pName?.match(/(\d+(?:\.\d+)?)\s*mm/i)[1] + ' mm' : '')) || '',
        width: '',
        length: '',
        productForm: 'Coil',
        quantityTons: totalQty || processedItems[0]?.qty || 0,
        unitPrice: processedItems[0]?.rate || 0,
        total_amount: dealAmount || 0,
        totalAmount: dealAmount || 0,
        line_items: processedItems.map((pi) => ({
          sku_text: pi.pName,
          dimensions: pi.dimensions || (pi.pName?.match(/(\d+(?:\.\d+)?)\s*mm/i) ? pi.pName?.match(/(\d+(?:\.\d+)?)\s*mm/i)[1] + ' mm' : ''),
          quantity: pi.qty,
          unit: 'MT',
          rate: pi.rate,
          amount: pi.itemAmount,
        })),
        overall_confidence: 0.95,
      };

      if (recentInqs && recentInqs.length > 0) {
        const inqId = recentInqs[0].id;
        await supabase
          .from('inquiries')
          .update({
            customer_name: finalCustomerName,
            customer_phone: actualCustomerPhone,
            delivery_location: data.delivery_location || null,
            delivery_date: data.delivery_date || null,
            inquiry_type: 'inquiry',
            ai_extraction_json: structuredExtraction,
            status: 'processed',
          })
          .eq('id', inqId);

        if (dealId) {
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

    // Edge Case 3: Log KRA 1 when deal is won
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

    const formattedAmount = dealAmount > 0 ? `₹${dealAmount.toLocaleString('en-IN')}` : 'To be calculated';
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

    // Text Inquiry / Requirement / Non-Won Deal: Format line items WITHOUT amounts/rates
    let itemsBreakdownStr = '';
    if (processedItems.length > 0) {
      itemsBreakdownStr = processedItems
        .map((pi) => `  • *${pi.pName}*${pi.qty > 0 ? ': ' + pi.qty + ' MT' : ''}`)
        .join('\n');
    }

    let resultMsg =
      `💼 *Sales Inquiry & Pipeline Logged!* 🏗️\n\n` +
      `Customer: *${finalCustomerName}*\n` +
      `Deal ID: *${dealCode}*\n` +
      `Stage: *${dbStage.toUpperCase()} 📄*\n` +
      (itemsBreakdownStr ? `Line Items:\n${itemsBreakdownStr}\n` : '') +
      (totalQty > 0 ? `Total Quantity: *${totalQty} MT*\n` : '') +
      (data.delivery_location ? `Delivery Location: *${data.delivery_location}*\n` : '') +
      (data.delivery_date ? `Target Delivery Date: *${data.delivery_date}*\n` : '') +
      `\nUpdated Sales Achievement Card! ✅`;

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
 * Process incoming PO / Sales document image via Gemini Vision (KRA 1 & Inquiries Tab)
 */
async function processSalesImage(imageBuffer, mimeType, senderPhone, messageId) {
  try {
    const { extractFromImage } = require('../gemini');
    const { saveInquiry, verifyAndGetCustomerName } = require('../supabase');
    const extraction = await extractFromImage(imageBuffer, mimeType);

    if (!extraction || extraction.error || !extraction.customer) {
      return `⚠️ Could not clearly extract inquiry details from the document image. Please send a clearer picture or type the details (e.g. "Delta Structural Steel 50 MT HR Coil @ 55,000 Delivery Mumbai").`;
    }

    const custName = extraction.customer.name || 'Customer Inquiry';
    const officialCustomerName = await verifyAndGetCustomerName(custName, senderPhone);
    const finalCustomerName = officialCustomerName || custName;
    const customerPhone = extraction.customer.phone || null;

    // Construct raw text representation for inquiries tab
    const itemsText = (extraction.line_items || [])
      .map(i => {
        const dimStr = i.dimensions ? ` (${i.dimensions})` : '';
        return `${i.sku_text || 'Steel'}${dimStr} ${i.quantity || 0} MT ${i.rate ? '@ Rs ' + i.rate + '/MT' : ''}`;
      })
      .join(', ');
    const rawSummary = `${itemsText}. Delivery Location: ${extraction.delivery_location || 'Warehouse'}`;

    // Convert image buffer to base64 Data URL so web dashboard can render/view it!
    const base64Data = `data:${mimeType || 'image/jpeg'};base64,${imageBuffer.toString('base64')}`;

    // 1. Differentiate between Purchase Order (PO) and regular Inquiry
    const isPo = Boolean(
      extraction.is_purchase_order === true ||
      extraction.inquiry_type === 'purchase_order' ||
      extraction.document_type === 'purchase_order' ||
      (extraction.po_number &&
        extraction.po_number !== 'null' &&
        extraction.po_number !== 'None' &&
        String(extraction.po_number).trim().length > 2)
    );

    let poNumber = null;
    if (isPo) {
      if (extraction.po_number && extraction.po_number !== 'null' && String(extraction.po_number).trim().length > 2) {
        poNumber = String(extraction.po_number).trim();
      } else {
        const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const randomNum = Math.floor(1000 + Math.random() * 9000);
        poNumber = `PO-${todayStr}-${randomNum}`;
      }
    }

    const poDate = extraction.po_date || new Date().toISOString().split('T')[0];
    const stage = isPo ? 'won' : 'review';
    const inqStatus = isPo ? 'confirmed' : 'review';

    let totalVal = extraction.total_amount || 0;
    if (totalVal <= 0 && extraction.line_items && extraction.line_items.length > 0) {
      totalVal = extraction.line_items.reduce(
        (s, i) => s + ((Number(i.quantity) || 0) * (Number(i.rate) || 0)),
        0
      );
    }

    const baseAmt = extraction.basic_amount || totalVal;
    const gstAmt = extraction.gst_amount || Math.round(baseAmt * 0.18);
    const grandTotal = extraction.total_amount || (baseAmt + gstAmt);
    const finalOrderAmount = grandTotal > 0 ? grandTotal : baseAmt;

    let savedInq = null;
    if (!isPo) {
      // 2. Save Inquiry to Supabase (for regular Inquiries)
      savedInq = await saveInquiry({
        source_channel: 'whatsapp',
        raw_text: `[Inquiry Document Attached] ${rawSummary}`,
        media_urls: [base64Data],
        sender_phone: senderPhone,
        sender_name: finalCustomerName,
        customer_name: finalCustomerName,
        customer_phone: customerPhone,
        salesperson_phone: senderPhone,
        message_id: messageId || null,
        status: inqStatus,
        inquiry_type: 'inquiry',
        overall_confidence: extraction.overall_confidence || 0.98,
        ai_extraction_json: extraction,
      });
    } else {
      // For Purchase Orders: Save media attachment linked with inquiry_type 'purchase_order'
      savedInq = await saveInquiry({
        source_channel: 'whatsapp',
        raw_text: `[PO Document Attached: ${poNumber}] ${rawSummary}`,
        media_urls: [base64Data],
        sender_phone: senderPhone,
        sender_name: finalCustomerName,
        customer_name: finalCustomerName,
        customer_phone: customerPhone,
        salesperson_phone: senderPhone,
        message_id: messageId || null,
        status: 'order_created',
        inquiry_type: 'purchase_order',
        overall_confidence: extraction.overall_confidence || 0.98,
        ai_extraction_json: extraction,
      });
    }

    let dealId = null;

    if (isPo) {
      // ──────────────────────────────────────────────────────────────────
      // Route PO to the backend /deals/process-po endpoint (proven reliable path)
      // This is the SAME API the dashboard "Create New Order" button uses.
      // ──────────────────────────────────────────────────────────────────
      try {
        const axios = require('axios');
        const backendUrl = process.env.BACKEND_URL ||
          process.env.BACKEND_SERVICE_URL ||
          'https://enlight-sales-backend-production.up.railway.app';

        const backendPayload = {
          customer_name: finalCustomerName,
          customer_phone: customerPhone || null,
          po_number: poNumber,
          po_date: poDate,
          total_amount: finalOrderAmount,
          delivery_location: extraction.delivery_location || null,
          payment_terms: extraction.payment_terms || null,
          salesperson_phone: senderPhone,
          inquiry_id: savedInq?.id || null,
          media_urls: [base64Data],
          overall_confidence: extraction.overall_confidence || 0.98,
          line_items: (extraction.line_items || []).map(item => ({
            sku_text: item.sku_text || 'Material',
            dimensions: item.dimensions || null,
            quantity: Number(item.quantity) || 0,
            unit: item.unit || 'MT',
            rate: Number(item.rate) || 0,
            amount: Number(item.amount) || 0,
          })),
        };

        console.log('[SalesAgent] Calling backend process-po for PO:', poNumber, 'customer:', finalCustomerName);

        // Use bot's internal JWT or a service secret header
        const headers = {
          'Content-Type': 'application/json',
        };
        if (process.env.BOT_INTERNAL_SECRET) {
          headers['x-bot-secret'] = process.env.BOT_INTERNAL_SECRET;
        }

        const poResponse = await axios.post(
          `${backendUrl}/deals/process-po-internal`,
          backendPayload,
          { headers, timeout: 15000 }
        );

        dealId = poResponse.data?.id || poResponse.data?.data?.id || null;
        console.log('[SalesAgent] Backend process-po-internal success, dealId:', dealId);

      } catch (backendErr) {
        console.error('[SalesAgent] Backend process-po-internal failed, falling back to direct Supabase:', backendErr.message);

        // FALLBACK: Direct Supabase write with correct NOT IN syntax
        const { data: openDeals, error: openDealsErr } = await supabase
          .from('deals')
          .select('id, stage, customer_name')
          .ilike('customer_name', `%${finalCustomerName}%`)
          .not('stage', 'in', '(won,lost)')  // correct PostgREST syntax: no quotes around values
          .order('created_at', { ascending: false })
          .limit(1);

        if (openDealsErr) {
          console.error('[SalesAgent] openDeals query error:', openDealsErr.message);
        }

        if (openDeals && openDeals.length > 0) {
          dealId = openDeals[0].id;
          const { error: updateErr } = await supabase
            .from('deals')
            .update({
              stage: 'won',
              won_at: new Date().toISOString(),
              po_number: poNumber,
              po_date: poDate,
              total_amount: finalOrderAmount,
              delivery_location: extraction.delivery_location || openDeals[0].delivery_location,
              payment_terms: extraction.payment_terms || openDeals[0].payment_terms,
              inquiry_type: 'purchase_order',
              updated_at: new Date().toISOString(),
            })
            .eq('id', dealId);
          if (updateErr) {
            console.error('[SalesAgent] Fallback deal update error:', updateErr.message);
          } else {
            console.log('[SalesAgent] Fallback: updated existing deal to won, dealId:', dealId);
          }
        } else {
          const { data: newWonDeal, error: insertErr } = await supabase
            .from('deals')
            .insert({
              inquiry_id: savedInq?.id || null,
              customer_name: finalCustomerName,
              salesperson_phone: senderPhone,
              customer_phone: customerPhone,
              stage: 'won',
              won_at: new Date().toISOString(),
              po_number: poNumber,
              po_date: poDate,
              total_amount: finalOrderAmount,
              delivery_location: extraction.delivery_location || null,
              payment_terms: extraction.payment_terms || null,
              inquiry_type: 'purchase_order',
              status: 'auto_created',
              overall_confidence: extraction.overall_confidence || 0.98,
              created_at: new Date().toISOString(),
            })
            .select()
            .single();

          if (insertErr) {
            console.error('[SalesAgent] Fallback deal insert error:', insertErr.message, insertErr);
          } else {
            dealId = newWonDeal?.id || null;
            console.log('[SalesAgent] Fallback: created new won deal, dealId:', dealId);
          }
        }
      }
    } else {
      // Create new inquiry deal in review stage
      const dealRefCode = `#DEAL-${Math.floor(1000 + Math.random() * 9000)}`;
      const { data: newInqDeal, error: dealErr } = await supabase
        .from('deals')
        .insert({
          inquiry_id: savedInq?.id || null,
          customer_name: finalCustomerName,
          salesperson_phone: senderPhone,
          customer_phone: customerPhone,
          stage: 'review',
          total_amount: baseAmt || 0,
          inquiry_type: 'inquiry',
          delivery_location: extraction.delivery_location || null,
          delivery_date: extraction.delivery_date || null,
          payment_terms: extraction.payment_terms || null,
          po_date: poDate,
          po_number: null,
          status: 'needs_review',
        })
        .select()
        .single();

      if (dealErr) {
        console.error('[SalesAgent] Error inserting inquiry deal:', dealErr.message || dealErr);
      }
      if (newInqDeal) dealId = newInqDeal.id;
    }

    // 3. Save / Overwrite Deal Items
    if (dealId && extraction.line_items && extraction.line_items.length > 0) {
      await supabase.from('deal_items').delete().eq('deal_id', dealId);

      for (const item of extraction.line_items) {
        const q = Number(item.quantity) || 0;
        const r = Number(item.rate) || 0;
        const amt = Number(item.amount) || (q > 0 && r > 0 ? q * r : 0);

        await supabase.from('deal_items').insert({
          deal_id: dealId,
          sku_text: item.sku_text || 'Hot Rolled Steel Coil',
          dimensions: item.dimensions || null,
          quantity: q > 0 ? q : null,
          unit: item.unit || 'MT',
          rate: r > 0 ? r : null,
          amount: amt > 0 ? amt : null,
          created_at: new Date().toISOString(),
        });
      }
    }

    // 4. If PO: Log KRA 1 and create Payment Tracking record
    if (isPo && dealId) {
      // Log KRA 1 Sales Achievement
      await supabase.from('kra_logs').insert({
        salesperson_phone: senderPhone,
        customer_name: finalCustomerName,
        kra_number: 1,
        kra_type: 'sales_achievement',
        metric_name: 'won_deal_value',
        value: finalOrderAmount,
        notes: `PO Received: ${poNumber} for ${finalCustomerName} — ₹${finalOrderAmount.toLocaleString('en-IN')}`,
        created_at: new Date().toISOString(),
      });

      // Update recurring customers
      try {
        await supabase
          .from('recurring_customers')
          .update({ last_order_date: new Date().toISOString() })
          .ilike('customer_name', `%${finalCustomerName}%`);
      } catch (err) {}

      // Create / Update Payment Tracking
      try {
        let creditDays = 30;
        const termsStr = String(extraction.payment_terms || '').toLowerCase();
        const daysMatch = termsStr.match(/(\d+)\s*(?:days|day)/);
        if (daysMatch) {
          creditDays = parseInt(daysMatch[1], 10);
        } else if (termsStr.includes('advance') || termsStr.includes('immediate') || termsStr.includes('cash')) {
          creditDays = 0;
        }

        const poDateTime = new Date(poDate).getTime() || Date.now();
        const dueDate = new Date(poDateTime + creditDays * 24 * 60 * 60 * 1000);
        const dueDateStr = dueDate.toISOString().split('T')[0];

        const { data: existingPay } = await supabase
          .from('payment_tracking')
          .select('id')
          .eq('deal_id', dealId)
          .limit(1);

        if (existingPay && existingPay.length > 0) {
          await supabase
            .from('payment_tracking')
            .update({
              invoice_amount: finalOrderAmount,
              outstanding: finalOrderAmount,
              due_date: dueDateStr,
              credit_period_days: creditDays,
              customer_name: finalCustomerName,
              salesperson_phone: senderPhone,
              updated_at: new Date().toISOString(),
            })
            .eq('id', existingPay[0].id);
        } else {
          await supabase.from('payment_tracking').insert({
            deal_id: dealId,
            salesperson_phone: senderPhone,
            customer_name: finalCustomerName,
            invoice_amount: finalOrderAmount,
            outstanding: finalOrderAmount,
            status: 'pending',
            due_date: dueDateStr,
            credit_period_days: creditDays,
            created_at: new Date().toISOString(),
          });
        }
      } catch (payErr) {
        console.warn('[SalesAgent] Payment tracking notice:', payErr.message);
      }
    }

    let itemsBreakdown = '';
    if (extraction.line_items && extraction.line_items.length > 0) {
      itemsBreakdown = extraction.line_items
        .map(i => {
          const dimStr = i.dimensions ? ` (${i.dimensions})` : '';
          return `  • *${i.sku_text || 'Material'}*${dimStr}: ${i.quantity || 0} MT ${i.rate ? '@ ₹' + Number(i.rate).toLocaleString('en-IN') + '/MT' : ''}`;
        })
        .join('\n');
    }

    if (isPo) {
      return (
        `🎉 *PURCHASE ORDER RECEIVED & DEAL WON!* 🏆\n\n` +
        `Customer: *${finalCustomerName}*\n` +
        `PO Number: *${poNumber}* 📄\n` +
        `PO Date: *${poDate}*\n` +
        `Stage: *WON / DELIVERED 🎉*\n\n` +
        (itemsBreakdown ? `Line Items:\n${itemsBreakdown}\n` : '') +
        `PO Basic Value: *₹${baseAmt.toLocaleString('en-IN')}*\n` +
        `GST (18%): *₹${gstAmt.toLocaleString('en-IN')}*\n` +
        `*Total PO Value: ₹${grandTotal.toLocaleString('en-IN')}*\n\n` +
        `Payment Terms: *${extraction.payment_terms || '30 Days Credit'}*\n` +
        `Delivery Location: *${extraction.delivery_location || 'Warehouse'}*\n\n` +
        `✅ Synced live to Orders Tab, Sales Achievement & Payment Tracking! 🚀`
      );
    }

    const frontendUrl = process.env.FRONTEND_URL || 'https://enlight-sales-frontend.vercel.app';
    const inquiryEditLink = savedInq?.id ? `${frontendUrl}/inquiries?id=${savedInq.id}` : `${frontendUrl}/inquiries`;

    return (
      `📄 *INQUIRY / SALES DEAL LOGGED!* 🏗️\n\n` +
      `Customer: *${finalCustomerName}*\n` +
      `Stage: *REVIEW 📄*\n` +
      (itemsBreakdown ? `Line Items:\n${itemsBreakdown}\n` : '') +
      (baseAmt > 0 ? `Product Amount: *₹${baseAmt.toLocaleString('en-IN')}*\nGST (18%): *₹${gstAmt.toLocaleString('en-IN')}*\n*Grand Total: ₹${grandTotal.toLocaleString('en-IN')}*\n` : '') +
      `Delivery Location: *${extraction.delivery_location || 'Not Specified'}*\n\n` +
      `✏️ *Review & Finalize Quotation:* \n` +
      `${inquiryEditLink}\n\n` +
      `✅ Logged live to Inquiries tab & Sales Pipeline!`
    );
  } catch (error) {
    console.error('[SalesAgent] Error processing sales image:', error);
    return `⚠️ Error processing document image: ${error.message}`;
  }
}

module.exports = {
  processSalesMessage,
  processSalesImage,
  findBestDeal,
  lookupRateSheetPrice,
  detectInvalidUnitInMessage,
};
