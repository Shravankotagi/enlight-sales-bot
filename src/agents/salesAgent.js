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
  "customer_name": "<company/customer name, else null>",
  "target_stage": "new_inquiry|qualified|quoted|negotiation|won|lost",
  "line_items": [
    {
      "product_requirement": "<specific product name e.g. CR Sheets, MS Plates, HR Coil>",
      "quantity_mt": <numeric tonnage for this specific item e.g. 20>,
      "rate_per_mt": <numeric per-MT price if mentioned in message, else null>
    }
  ],
  "total_amount": <numeric total deal value in rupees ONLY if explicitly mentioned in text, else 0>,
  "delivery_location": "<city/address if mentioned, else null>",
  "delivery_date": "<delivery deadline if mentioned, else null>",
  "po_number": "<PO number if mentioned, else null>",
  "po_date": "<PO date YYYY-MM-DD if mentioned, else null>",
  "loss_reason": "<inferred reason if deal was lost, else null>",
  "confidence": <float 0.0 to 1.0>
}

Rules for line_items:
- If multiple materials/products are mentioned (e.g. "20 MT CR sheets and 10 MT of MS plates"), create a SEPARATE object in line_items for EACH material!
- Extract the exact tonnage (quantity_mt) for each material individually.
- If only 1 material is mentioned, line_items should contain 1 object.

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

    const { invokeWithFallback } = require('../core/modelRouter');
    const response = await invokeWithFallback([
      new SystemMessage(SALES_AGENT_PROMPT),
      new HumanMessage('Salesperson message:\n' + text),
    ]);
    const rawText = typeof response.content === 'string' ? response.content : JSON.stringify(response.content || '');
    const { safeParseJSON } = require('../utils/jsonUtils');
    const data = safeParseJSON(rawText, null);

    if (!data || data.confidence < 0.3) {
      return `❓ I couldn't clearly understand the deal update. Could you please specify the customer name and status (e.g. "Mehta Engineering 20 MT CR sheets quote sent")?`;
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
          `Please reply with the product name (e.g. _HR Coil_, _CR Sheet_, _TMT Bar_, _MS Plates_) so I can check our active rate sheet and calculate the quotation for KRA 1 & Sales Pipeline! 📈`;
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
        `Please confirm the per MT rate for *${unlistedMaterialName}* (e.g. reply _"${unlistedMaterialName} rate is 54000"_) so I can calculate the deal total and update KRA 1 & Sales Pipeline! 📈`;
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
        stage: dbStage,
        po_date: poDate,
        po_number: poNumber,
      };

      if (actualCustomerPhone) updatePayload.customer_phone = actualCustomerPhone;
      if (data.delivery_location) updatePayload.delivery_location = data.delivery_location;
      if (data.delivery_date) updatePayload.delivery_date = data.delivery_date;
      if (dealAmount > 0) updatePayload.total_amount = dealAmount;

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

      await supabase.from('deals').update(updatePayload).eq('id', dealId);

      // Clean old deal items if new line items are provided
      if (processedItems.length > 0) {
        await supabase.from('deal_items').delete().eq('deal_id', dealId);
        for (const pItem of processedItems) {
          await supabase.from('deal_items').insert({
            deal_id: dealId,
            sku_text: pItem.pName,
            quantity: pItem.qty > 0 ? pItem.qty : null,
            unit: 'MT',
            rate: pItem.rate > 0 ? pItem.rate : null,
            amount: pItem.itemAmount > 0 ? pItem.itemAmount : null,
            created_at: new Date().toISOString(),
          });
        }
      }
    } else {
      // ---- CREATE new deal ----
      if (dbStage === 'lost' && (!data.loss_reason || data.loss_reason === 'Not specified')) {
        const { data: tempDeal } = await supabase
          .from('deals')
          .insert({
            customer_name:     finalCustomerName,
            salesperson_phone: senderPhone,
            customer_phone:    actualCustomerPhone,
            stage:             'negotiation',
            total_amount:      dealAmount || 0,
            inquiry_type:      'inquiry',
            po_date:           poDate,
            po_number:         poNumber,
          })
          .select()
          .single();

        if (tempDeal) {
          const { saveActiveSession } = require('../supabase');
          await saveActiveSession(senderPhone, finalCustomerName, `pending_loss_reason|${tempDeal.id}|${finalCustomerName}`);
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
            quantity: pItem.qty > 0 ? pItem.qty : null,
            unit: 'MT',
            rate: pItem.rate > 0 ? pItem.rate : null,
            amount: pItem.itemAmount > 0 ? pItem.itemAmount : null,
            created_at: new Date().toISOString(),
          });
        }
      }
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
        console.log(`[SalesAgent] Logged KRA 1 for won deal: ${finalCustomerName} = ₹${dealAmount}`);
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
    const totalQty = processedItems.reduce((s, i) => s + i.qty, 0);

    let itemsBreakdownStr = '';
    if (processedItems.length > 0) {
      itemsBreakdownStr = processedItems
        .map((pi) => `  • *${pi.pName}*: ${pi.qty > 0 ? pi.qty + ' MT' : ''} ${pi.rate > 0 ? '@ ₹' + pi.rate.toLocaleString('en-IN') + '/MT = ₹' + pi.itemAmount.toLocaleString('en-IN') : ''}`)
        .join('\n');
    }

    const activeDeal = existingDeal || { id: dealId };
    const dealCode = getDealCode(activeDeal);

    if (dbStage === 'won') {
      let resultMsg =
        `🎉 *DEAL WON & PURCHASE ORDER GENERATED!* 🏆\n\n` +
        `Customer: *${finalCustomerName}*\n` +
        `Deal ID: *${dealCode}*\n` +
        `Official PO Number: *${poNumber}* 📄\n` +
        `Total Value: *₹${Number(dealAmount).toLocaleString('en-IN')}* + GST\n` +
        (poDate ? `PO Date: *${poDate}*\n` : '') +
        `\nSynced live to KRA 1 Sales Achievement & Zoho Bigin CRM! ✅`;

      if (missingPrompt) {
        resultMsg += `\n\n${missingPrompt}`;
      }
      return resultMsg;
    }

    let resultMsg =
      `💼 *Sales Inquiry & Pipeline Logged!* 🏗️\n\n` +
      `Customer: *${finalCustomerName}*\n` +
      `Deal ID: *${dealCode}*\n` +
      `Stage: *${dbStage.toUpperCase()} 📄*\n` +
      (itemsBreakdownStr ? `Line Items:\n${itemsBreakdownStr}\n` : '') +
      (totalQty > 0 ? `Total Quantity: *${totalQty} MT*\n` : '') +
      `Calculated Deal Total: *${formattedAmount}* + GST\n` +
      `PO Date: *${poDate}*\n\n` +
      `Synced live to Sales Pipeline & KRA 1 Dashboard! ✅`;

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
async function processSalesImage(imageBuffer, mimeType, senderPhone) {
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
    const customerPhone = extraction.customer.phone || '9123456789';

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

    // 1. Save Inquiry to Supabase (so it appears in web dashboard Inquiries tab with image attached!)
    const savedInq = await saveInquiry({
      source_channel: 'whatsapp',
      raw_text: extraction.po_number
        ? `[Inquiry Attachment: ${extraction.po_number}.jpg] ${rawSummary}`
        : `[Inquiry Attachment: steel_inquiry_po.jpg] ${rawSummary}`,
      media_urls: [base64Data],
      sender_phone: senderPhone,
      sender_name: finalCustomerName,
      customer_name: finalCustomerName,
      customer_phone: customerPhone,
      salesperson_phone: senderPhone,
      status: 'review',
      overall_confidence: extraction.overall_confidence || 0.95,
      ai_extraction_json: extraction,
    });

    // 2. Process deal update - Generate Deal ID (Ref No) for new inquiry; PO Number is ONLY added when client finalizes deal!
    const dealRefCode = extraction.po_number
      ? `#DEAL-${extraction.po_number.replace(/^PO-?/i, '')}`
      : `#DEAL-${Math.floor(1000 + Math.random() * 9000)}`;
    const stage = 'review';

    let totalVal = extraction.total_amount || 0;
    if (totalVal <= 0 && extraction.line_items && extraction.line_items.length > 0) {
      totalVal = extraction.line_items.reduce((s, i) => s + ((i.quantity || 0) * (i.rate || 0)), 0);
    }

    // 3. Save Deal to Supabase deals table (PO number left null until deal is won by client)
    const { data: newDeal, error: dealErr } = await supabase
      .from('deals')
      .insert({
        inquiry_id: savedInq?.id || null,
        customer_name: finalCustomerName,
        salesperson_phone: senderPhone,
        customer_phone: customerPhone,
        stage: stage,
        total_amount: totalVal || 0,
        inquiry_type: 'inquiry',
        delivery_location: extraction.delivery_location || null,
        delivery_date: extraction.delivery_date || null,
        payment_terms: extraction.payment_terms || null,
        po_date: extraction.po_date || new Date().toISOString().split('T')[0],
        po_number: null, // PO number is null for inquiries
        status: 'needs_review',
      })
      .select()
      .single();

    if (dealErr) {
      console.error('[SalesAgent] Error inserting deal from image vision:', dealErr.message || dealErr);
    }

    // 4. Save Deal Items
    if (newDeal && extraction.line_items && extraction.line_items.length > 0) {
      for (const item of extraction.line_items) {
        await supabase.from('deal_items').insert({
          deal_id: newDeal.id,
          sku_text: item.sku_text || 'Hot Rolled Steel Coil',
          dimensions: item.dimensions || null,
          quantity: item.quantity || 50,
          unit: item.unit || 'MT',
          rate: item.rate || 55000,
          amount: (item.quantity || 50) * (item.rate || 55000),
          created_at: new Date().toISOString(),
        });
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

    const frontendUrl = process.env.FRONTEND_URL || 'https://enlight-sales-frontend.vercel.app';
    const inquiryEditLink = savedInq?.id ? `${frontendUrl}/inquiries?id=${savedInq.id}` : `${frontendUrl}/inquiries`;

    let replyMsg =
      `📄 *INQUIRY / SALES DEAL LOGGED!* 🏗️\n\n` +
      `Customer: *${finalCustomerName}*\n` +
      `Deal ID: *${dealRefCode}*\n` +
      `Stage: *REVIEW 📄*\n` +
      (itemsBreakdown ? `Line Items:\n${itemsBreakdown}\n` : '') +
      (totalVal > 0 ? `Estimated Deal Total: *₹${Number(totalVal).toLocaleString('en-IN')}* + GST\n` : '') +
      `Delivery Location: *${extraction.delivery_location || 'Mumbai Warehouse'}*\n\n` +
      `✏️ *Review & Finalize Quotation:* \n` +
      `${inquiryEditLink}\n\n` +
      `✅ Logged live to Inquiries tab & Sales Pipeline!`;

    return replyMsg;

    return replyMsg;
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
