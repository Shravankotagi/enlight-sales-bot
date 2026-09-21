/**
 * KRA 7 & KRA 8 - Quality Complaints & Complaint Resolution Agent
 *
 * KRA 7 = Log new quality complaints (reported by salesperson or forwarded from customer)
 * KRA 8 = Complaint resolved within SLA (target: 48 hours)
 *
 * ENFORCEMENTS & FLOWS:
 * 1. Multi-Complaint Support:
 *    - If a salesperson reports multiple complaints in one message (different companies or different items),
 *      each is extracted and created as an independent row in the database.
 * 2. PO Priority for Won Deals:
 *    - Won deals reference PO number as primary (e.g. "PO: DEW/RFQ/2026/089 (#INQ-1BBB57)").
 *    - Deals without PO or non-won deals reference Inquiry ID as primary.
 * 3. Exact Timestamps & Mandatory Resolution Notes.
 */

const { supabase, getAccessibleSalespersonPhonesForBot, expandPhoneVariants } = require('../supabase');
const { syncActivity } = require('./biginSyncAgent');
const { logBotActivity } = require('../utils/activityLogger');

const COMPLAINT_AGENT_PROMPT = `
You are the Specialized Quality & Complaint AI Agent (KRA 7 & KRA 8) for Enlight Metals.
Your job is to parse quality complaints, material rejection reports, or complaint resolution updates.

CRITICAL INSTRUCTION - MULTIPLE COMPLAINTS:
A salesperson message may contain MULTIPLE separate complaints for different companies or different issues (e.g. "Complaint from Dynamic Engineering: HR Coil rust. Complaint from Tech Industries: CR Sheet crack").
You MUST extract each distinct complaint as a separate item in the "complaints" array.

Extract into ONLY a JSON object (no prose, no markdown, no backticks):
{
  "complaints": [
    {
      "action": "report|resolve",
      "customer_name": "<customer/company name, else null>",
      "deal_id": "<inquiry ID e.g. 'INQ-C538B6', 'DEAL-C538B6' or UUID if mentioned in text, else null>",
      "po_number": "<PO number e.g. '6712', 'PO-2026-001' or 'DEW/RFQ/2026/089' if mentioned, else null>",
      "complaint_type": "quality|delivery|quantity|billing|specification|other",
      "affected_product": "<specific product/material affected e.g. 'HR Coil 12 MT', 'CR Sheet 1.20mm coils', 'MS Angle Bars' - else null>",
      "description": "<detailed description of complaint or resolution notes for this specific customer/incident>",
      "is_confirmation": <true if the user is replying 'yes', 'confirm', 'haan', 'correct', 'right', 'sahi hai' to a previous deal confirmation question, else false>,
      "confidence": <float 0.0 to 1.0>
    }
  ]
}

Rules:
- "action": "report" -> new issue, defect, rejection, wrong material, shortage, delivery delay, billing dispute.
- "action": "resolve" -> issue settled, sorted, material replaced, customer accepted, resolved.
- If multiple companies or separate complaint sentences exist, CREATE A SEPARATE ENTRY IN THE "complaints" ARRAY FOR EACH ONE!
- "affected_product": Extract specific steel category, dimensions, or product form for that specific complaint.
- "deal_id": Extract any #INQ-XXXXXX or #DEAL-XXXXXX mentioned (do NOT put PO numbers here).
- "po_number": Extract any PO number (PO #6712, PO-XXXX, Purchase Order #) mentioned (do NOT put Inquiry IDs here).
- Status at creation is ALWAYS "open". Ignore any user-supplied initial status such as "Status: In Progress".

Return ONLY the JSON object.
`;

function normalizeComplaintType(typeStr) {
  if (!typeStr || typeof typeStr !== 'string') return 'Quality Defect';
  const t = typeStr.trim().toLowerCase();
  if (t.includes('spec') || t.includes('mismatch')) return 'Specification Mismatch';
  if (t.includes('damage') || t.includes('physical') || t.includes('broken') || t.includes('crack') || t.includes('bend')) return 'Physical Damage';
  if (t.includes('short') || t.includes('qty') || t.includes('quantity') || t.includes('kam')) return 'Quantity Shortage';
  if (t.includes('delay') || t.includes('late') || t.includes('delivery')) return 'Delivery Delay';
  if (t.includes('bill') || t.includes('invoice') || t.includes('price') || t.includes('rate') || t.includes('amount')) return 'Billing Mismatch';
  if (t.includes('quality') || t.includes('rust') || t.includes('defect') || t.includes('reject')) return 'Quality Defect';
  if (t.includes('other')) return 'Other';
  return typeStr.trim().replace(/\b\w/g, l => l.toUpperCase());
}

/**
 * Fetch won deals (orders) with PO for a customer from the Orders module, strictly scoped by role.
 */
async function getCustomerActiveDeals(customerName, senderPhone) {
  if (!customerName) return [];
  const cleanCust = customerName.replace(/[.,'"]/g, '').trim();
  const scope = senderPhone
    ? await getAccessibleSalespersonPhonesForBot(senderPhone)
    : { phones: null, isAdmin: true };

  let query = supabase
    .from('deals')
    .select('id, inquiry_id, stage, po_number, customer_name, total_amount, delivery_location, created_at, salesperson_phone')
    .ilike('customer_name', `%${cleanCust}%`)
    .eq('stage', 'won')
    .order('created_at', { ascending: false });

  if (scope.phones !== null) {
    const targetPhones = expandPhoneVariants(scope.phones);
    if (targetPhones.length > 0) {
      query = query.in('salesperson_phone', targetPhones);
    } else {
      return [];
    }
  }

  const { data: deals } = await query.limit(10);

  if (!deals || deals.length === 0) return [];

  const dealIds = deals.map(d => d.id);
  const { data: items } = await supabase
    .from('deal_items')
    .select('deal_id, sku_text, dimensions, quantity, unit')
    .in('deal_id', dealIds);

  const itemMap = new Map();
  (items || []).forEach(it => {
    const list = itemMap.get(it.deal_id) || [];
    list.push(it);
    itemMap.set(it.deal_id, list);
  });

  return deals.map(d => {
    const rawInq = d.id;
    const cleanCode = rawInq.replace(/^(?:INQ|DEAL)-/i, '').replace(/[^a-zA-Z0-9]/g, '').substring(0, 6).toUpperCase();
    const dealCode = `#INQ-${cleanCode}`;
    const itms = itemMap.get(d.id) || [];
    const prodSummary = itms.length > 0
      ? itms.map(it => `${it.sku_text || 'Steel'} ${it.dimensions || ''} ${it.quantity ? `(${it.quantity} ${it.unit || 'MT'})` : ''}`.trim()).join(', ')
      : 'Steel Material';
    const dateFormatted = d.created_at ? new Date(d.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'numeric', year: 'numeric' }) : '';
    const loc = d.delivery_location ? `${d.delivery_location}` : '';

    return {
      ...d,
      deal_code: dealCode,
      clean_code: cleanCode,
      effective_deal_id: d.id,
      effective_po: d.po_number && d.po_number.trim() !== '' ? d.po_number.trim() : dealCode,
      items: itms,
      product_summary: prodSummary,
      date_formatted: dateFormatted,
      location: loc,
    };
  });
}

/**
 * Fetch active open inquiries (pre-won pipeline deals) for a customer, strictly scoped by role.
 */
async function getCustomerOpenInquiries(customerName, senderPhone) {
  if (!customerName) return [];
  const cleanCust = customerName.replace(/[.,'"]/g, '').trim();
  const scope = senderPhone
    ? await getAccessibleSalespersonPhonesForBot(senderPhone)
    : { phones: null, isAdmin: true };

  let query = supabase
    .from('deals')
    .select('id, stage, po_number, customer_name, total_amount, created_at, salesperson_phone')
    .ilike('customer_name', `%${cleanCust}%`)
    .neq('stage', 'won')
    .neq('stage', 'lost')
    .order('created_at', { ascending: false });

  if (scope.phones !== null) {
    const targetPhones = expandPhoneVariants(scope.phones);
    if (targetPhones.length > 0) {
      query = query.in('salesperson_phone', targetPhones);
    } else {
      return [];
    }
  }

  const { data: deals } = await query.limit(6);

  if (!deals || deals.length === 0) return [];

  const dealIds = deals.map(d => d.id);
  const { data: items } = await supabase
    .from('deal_items')
    .select('deal_id, sku_text, dimensions, quantity, unit')
    .in('deal_id', dealIds);

  const itemMap = new Map();
  (items || []).forEach(it => {
    const list = itemMap.get(it.deal_id) || [];
    list.push(it);
    itemMap.set(it.deal_id, list);
  });

  return deals.map(d => ({
    ...d,
    deal_code: `#INQ-${d.id.substring(0, 6).toUpperCase()}`,
    items: itemMap.get(d.id) || [],
  }));
}

/**
 * Find the most recent OPEN complaint for a customer or specific deal, scoped by role.
 */
async function getOpenComplaint(customerName, senderPhone, dealId = null) {
  const scope = senderPhone
    ? await getAccessibleSalespersonPhonesForBot(senderPhone)
    : { phones: null, isAdmin: true };

  let query = supabase
    .from('complaints')
    .select('*')
    .in('status', ['open', 'reported', 'reopened']);

  if (dealId) {
    query = query.eq('deal_id', dealId);
  } else if (customerName) {
    query = query.ilike('customer_name', `%${customerName.trim()}%`);
  }

  if (scope.phones !== null) {
    const targetPhones = expandPhoneVariants(scope.phones);
    if (targetPhones.length > 0) {
      query = query.in('reported_by', targetPhones);
    } else {
      return null;
    }
  }

  const { data } = await query
    .order('created_at', { ascending: false })
    .limit(1);

  return data && data.length > 0 ? data[0] : null;
}

/**
 * Extract steel product name from text using smart pattern recognition
 */
function extractProductFromText(text) {
  if (!text) return null;
  const str = String(text).trim();

  // Pattern 1: e.g. "60 MT MS plates", "15 MT CR Sheet 1.20mm", "10 MT HR Coil"
  const m1 = str.match(/(?:(\d+(?:\.\d+)?\s*(?:MT|tons?|kg|pcs?|nos?|bundle|bundles))\s+)?\b(MS\s+Plates?|MS\s+Sheets?|HR\s+Coils?|HR\s+Sheets?|CR\s+Coils?|CR\s+Sheets?|TMT\s+Bars?|GI\s+Sheets?|GI\s+Coils?|GP\s+Sheets?|GP\s+Coils?|Chequered\s+Plates?|MS\s+Pipes?|Seamless\s+Pipes?|ERW\s+Pipes?|Beams?|Channels?|Angles?|Flats?|Rounds?|Square\s+Bars?|Alloy\s+Steel|Stainless\s+Steel|IS\s+2062(?:\s+E250)?)\b(?:\s+([0-9.]+\s*mm(?:(?:\s*x\s*[0-9.]+\s*mm)+)?))?(?:\s+(\d+(?:\.\d+)?\s*(?:MT|tons?|kg|pcs?|nos?)))?/i);
  if (m1) {
    const qty = (m1[1] || m1[4] || '').trim();
    const prod = m1[2].trim();
    const dims = (m1[3] || '').trim();
    let res = prod;
    if (dims) res += ` ${dims}`;
    if (qty) res += ` (${qty})`;
    return res;
  }

  // Pattern 2: e.g. "MS Plate", "HR Coil", "CR Sheet", "TMT Bar"
  const m2 = str.match(/\b(MS\s+Plate|MS\s+Plates|MS\s+Sheet|MS\s+Sheets|HR\s+Coil|HR\s+Coils|HR\s+Sheet|HR\s+Sheets|CR\s+Coil|CR\s+Coils|CR\s+Sheet|CR\s+Sheets|TMT\s+Bar|TMT\s+Bars|GI\s+Sheet|GI\s+Sheets|GI\s+Coil|GI\s+Coils|Chequered\s+Plate|Chequered\s+Plates|MS\s+Pipe|MS\s+Pipes)\b/i);
  if (m2) {
    return m2[1];
  }

  return null;
}

/**
 * Resolve the real product name from explicit input, linked deal items, text, or fallback
 */
async function resolveProductFromContext(dealId, poNumber, customerName, affectedProduct, text, senderPhone = null) {
  // 1. If explicit affectedProduct is provided and NOT generic, use it
  if (affectedProduct && typeof affectedProduct === 'string') {
    const clean = affectedProduct.trim();
    const lower = clean.toLowerCase();
    if (
      clean.length > 1 &&
      lower !== 'general material' &&
      lower !== 'general steel material' &&
      lower !== 'steel material' &&
      lower !== 'material' &&
      lower !== 'steel' &&
      lower !== 'null' &&
      lower !== 'undefined' &&
      lower !== 'other'
    ) {
      return clean;
    }
  }

  // 2. Extract from raw message or description text
  const textProd = extractProductFromText(text);
  if (textProd) {
    return textProd;
  }

  // 3. Lookup from linked deal_items via dealId
  if (dealId) {
    try {
      const scope = senderPhone ? await getAccessibleSalespersonPhonesForBot(senderPhone) : { phones: null };
      const cleanDeal = String(dealId).replace(/^#?(?:DEAL|INQ)-?/i, '').trim().toUpperCase();
      let dealQuery = supabase
        .from('deals')
        .select('id, salesperson_phone, deal_items(sku_text, dimensions, quantity, unit)')
        .order('created_at', { ascending: false });

      if (scope.phones !== null) {
        const targetPhones = expandPhoneVariants(scope.phones);
        if (targetPhones.length > 0) dealQuery = dealQuery.in('salesperson_phone', targetPhones);
      }

      const { data: dealRows } = await dealQuery.limit(100);

      const foundDeal = (dealRows || []).find(
        (d) =>
          (d.id || '').toUpperCase().startsWith(cleanDeal) ||
          (d.id || '').replace(/-/g, '').toUpperCase().startsWith(cleanDeal),
      );

      if (foundDeal && foundDeal.deal_items && foundDeal.deal_items.length > 0) {
        const items = foundDeal.deal_items;
        const itemSummaries = items.map(it => {
          let s = it.sku_text || 'Steel Item';
          if (it.dimensions) s += ` ${it.dimensions}`;
          if (it.quantity) s += ` (${it.quantity} ${it.unit || 'MT'})`;
          return s.trim();
        });
        if (itemSummaries.length > 0) {
          return itemSummaries.join(', ');
        }
      }
    } catch (e) {
      console.warn('Error resolving product from dealId:', e.message);
    }
  }

  // 4. Lookup from linked deal_items via poNumber
  if (poNumber) {
    try {
      const scope = senderPhone ? await getAccessibleSalespersonPhonesForBot(senderPhone) : { phones: null };
      let poQuery = supabase
        .from('deals')
        .select('id, salesperson_phone, deal_items(sku_text, dimensions, quantity, unit)')
        .ilike('po_number', `%${poNumber.trim()}%`);

      if (scope.phones !== null) {
        const targetPhones = expandPhoneVariants(scope.phones);
        if (targetPhones.length > 0) poQuery = poQuery.in('salesperson_phone', targetPhones);
      }

      const { data: poDeals } = await poQuery.limit(1);

      if (poDeals && poDeals.length > 0 && poDeals[0].deal_items && poDeals[0].deal_items.length > 0) {
        const items = poDeals[0].deal_items;
        const itemSummaries = items.map(it => {
          let s = it.sku_text || 'Steel Item';
          if (it.dimensions) s += ` ${it.dimensions}`;
          if (it.quantity) s += ` (${it.quantity} ${it.unit || 'MT'})`;
          return s.trim();
        });
        if (itemSummaries.length > 0) {
          return itemSummaries.join(', ');
        }
      }
    } catch (e) {
      console.warn('Error resolving product from poNumber:', e.message);
    }
  }

  // 5. Lookup from customer's latest won deal
  if (customerName) {
    try {
      const activeDeals = await getCustomerActiveDeals(customerName, senderPhone);
      if (activeDeals && activeDeals.length > 0 && activeDeals[0].items && activeDeals[0].items.length > 0) {
        const items = activeDeals[0].items;
        const itemSummaries = items.map(it => {
          let s = it.sku_text || 'Steel Item';
          if (it.dimensions) s += ` ${it.dimensions}`;
          if (it.quantity) s += ` (${it.quantity} ${it.unit || 'MT'})`;
          return s.trim();
        });
        if (itemSummaries.length > 0) {
          return itemSummaries.join(', ');
        }
      }
    } catch (e) {
      console.warn('Error resolving product from customer won deals:', e.message);
    }
  }

  return 'Steel Material';
}

/**
 * Check if a KRA 8 log already exists for this complaint resolution.
 */
async function isKRA8AlreadyLogged(senderPhone, customerName) {
  const { data } = await supabase
    .from('kra_logs')
    .select('id')
    .eq('salesperson_phone', senderPhone)
    .eq('kra_number', 8)
    .ilike('customer_name', `%${customerName.trim()}%`)
    .eq('month', new Date().getMonth() + 1)
    .eq('year', new Date().getFullYear())
    .limit(1);

  return data && data.length > 0;
}

/**
 * Process a single complaint object.
 */
async function processSingleComplaint(data, originalText, senderPhone) {
  const { verifyAndGetCustomerName, saveActiveSession, getActiveSession, getFullActiveSession } = require('../supabase');

  // Check active session for pending confirmation draft
  const activeSessionObj = await getFullActiveSession(senderPhone);
  if (activeSessionObj && activeSessionObj.last_intent && activeSessionObj.last_intent.startsWith('complaint_confirm_deal|')) {
    const rawPayload = activeSessionObj.last_intent.replace('complaint_confirm_deal|', '');
    try {
      const draft = JSON.parse(rawPayload);
      const cleanInput = originalText.replace(/[.#️⃣*️⃣\s]/g, '').trim();
      const numIdx = parseInt(cleanInput, 10);

      let matchedCandidate = null;
      if (Array.isArray(draft.candidates) && draft.candidates.length > 0) {
        if (!isNaN(numIdx) && numIdx >= 1 && numIdx <= draft.candidates.length) {
          matchedCandidate = draft.candidates[numIdx - 1];
        } else {
          const candCleanText = originalText.replace(/^(?:PO|Purchase\s*Order|INQ|DEAL)[\s#:-]*/i, '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
          matchedCandidate = draft.candidates.find(c => {
            const cDealCode = (c.deal_code || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
            const cCleanCode = (c.clean_code || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
            const cPo = (c.po_number || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
            const cId = (c.id || '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
            return (
              (candCleanText.length >= 2 && cPo && (candCleanText.includes(cPo) || cPo.includes(candCleanText))) ||
              (candCleanText.length >= 3 && (cDealCode.includes(candCleanText) || candCleanText.includes(cDealCode) || cCleanCode === candCleanText || cId.startsWith(candCleanText)))
            );
          });
        }
      }

      const isAffirmative = /^(yes|haan|confirm|correct|right|sahi|sahi hai|yep|yup|ok|okay|ha|bilkul)$/i.test(originalText.trim()) || Boolean(data.is_confirmation);

      if (matchedCandidate) {
        if (!data.customer_name && draft.customer_name) data.customer_name = draft.customer_name;
        data.deal_id = matchedCandidate.effective_deal_id || matchedCandidate.inquiry_id || matchedCandidate.id;
        data.po_number = matchedCandidate.po_number || null;
        if (!data.affected_product && matchedCandidate.product_summary) data.affected_product = matchedCandidate.product_summary;
        if (draft.description) data.description = draft.description;
        if ((!data.complaint_type || data.complaint_type === 'other') && draft.complaintType) data.complaint_type = draft.complaintType;
        data.is_confirmation = true;
      } else if (isAffirmative) {
        if (!data.customer_name && draft.customer_name) data.customer_name = draft.customer_name;
        if (!data.deal_id && draft.dealId) data.deal_id = draft.dealId;
        if (!data.po_number && draft.poNumber) data.po_number = draft.poNumber;
        if (!data.affected_product && draft.product) data.affected_product = draft.product;
        if (draft.description) data.description = draft.description;
        if ((!data.complaint_type || data.complaint_type === 'other') && draft.complaintType) data.complaint_type = draft.complaintType;
        data.is_confirmation = true;
      }
    } catch (e) {
      console.warn('Error parsing complaint draft from session:', e.message);
    }
  }

  // Missing customer name check - try active session first
  if (!data.customer_name) {
    const activeCustomer = await getActiveSession(senderPhone);
    if (activeCustomer && activeCustomer.toLowerCase() !== 'unknown' && activeCustomer.toLowerCase() !== 'null') {
      data.customer_name = activeCustomer;
    }
  }

  if (!data.customer_name) {
    const dealIdMatch = originalText.match(/#?DEAL-([A-F0-9]{6})/i);
    if (dealIdMatch) {
      const shortCode = dealIdMatch[1].toLowerCase();
      const scope = await getAccessibleSalespersonPhonesForBot(senderPhone);
      let matchQuery = supabase
        .from('deals')
        .select('id, customer_name, po_number, salesperson_phone')
        .limit(100);

      if (scope.phones !== null) {
        const targetPhones = expandPhoneVariants(scope.phones);
        if (targetPhones.length > 0) {
          matchQuery = matchQuery.in('salesperson_phone', targetPhones);
        } else {
          matchQuery = null;
        }
      }

      if (matchQuery) {
        const { data: matchedDeals } = await matchQuery;
        const found = (matchedDeals || []).find(d => d.id.toLowerCase().startsWith(shortCode));
        if (found) {
          data.customer_name = found.customer_name;
          data.deal_id = found.id;
          if (found.po_number && !data.po_number) data.po_number = found.po_number;
        }
      }
    }
  }

  if (!data.customer_name) {
    return `⚠️ *Customer Complaints - Missing Information*\n\nPlease specify the *Customer / Company Name* for this complaint.\nExample: _"Quality complaint for Delta Structural Steel - surface rust on 10 MT HR Coil"_`;
  }

  const customerName = data.customer_name.trim();

  // Verify and get official customer name
  let officialCustomerName = await verifyAndGetCustomerName(customerName, senderPhone);

  if (!officialCustomerName) {
    await supabase.from('recurring_customers').insert({
      customer_name: customerName,
      assigned_salesperson_phone: senderPhone,
      is_active: true,
      avg_order_frequency_days: 30,
    }).select().single();
    officialCustomerName = customerName;
  }

  const finalCustomerName = officialCustomerName;
  const complaintType = normalizeComplaintType(data.complaint_type || 'Quality Defect');
  const affectedProduct = data.affected_product || null;
  const cleanDescription = data.description || originalText;

  // ── RESOLVE FLOW ──────────────────────────────────────────────────
  if (data.action === 'resolve') {
    const openComplaint = await getOpenComplaint(finalCustomerName, senderPhone, data.deal_id);

    let resolutionNotes = (data.description || '').trim();
    const isGenericResolveText = /^(resolved|resolve|issue sorted|fixed|done|ho gaya|settled)$/i.test(resolutionNotes);
    if (!resolutionNotes || isGenericResolveText) {
      return `ℹ️ *Resolution Notes Required for ${finalCustomerName}*\n\n` +
        `Please provide the resolution details (e.g. replacement material dispatched / commercial settlement).\n` +
        `Example: _"Resolved complaint for ${finalCustomerName} - replacement 10 MT plates dispatched and accepted."_`;
    }

    if (openComplaint) {
      const resolvedAt = new Date();
      const reportedAt = new Date(openComplaint.created_at || openComplaint.reported_at || Date.now());
      const resolutionTimeHrs = Math.max(1, Math.round(
        (resolvedAt.getTime() - reportedAt.getTime()) / (1000 * 60 * 60)
      ));
      const isSlaBreached = resolutionTimeHrs > 48;
      const isSlaCompliant = !isSlaBreached;

      // If openComplaint has 'General Material' or null for product, update it with real product!
      const existingProd = openComplaint.product_name || openComplaint.affected_product;
      const isGeneric = !existingProd || ['general material', 'general steel material', 'steel material', 'material', 'steel', 'null'].includes(existingProd.toLowerCase().trim());
      let updatedProduct = existingProd;
      if (isGeneric) {
        updatedProduct = await resolveProductFromContext(
          openComplaint.deal_id || data.deal_id,
          openComplaint.po_number || data.po_number,
          finalCustomerName,
          affectedProduct,
          openComplaint.description || cleanDescription || resolutionNotes,
          senderPhone
        );
      }

      const updatePayload = {
        status: 'resolved',
        resolution_notes: resolutionNotes,
        resolved_at: resolvedAt.toISOString(),
        resolution_time_hrs: resolutionTimeHrs,
        escalated: isSlaBreached,
      };
      if (isGeneric && updatedProduct && updatedProduct !== 'General Material') {
        updatePayload.product_name = updatedProduct;
        updatePayload.affected_product = updatedProduct;
      }

      await supabase
        .from('complaints')
        .update(updatePayload)
        .eq('id', openComplaint.id);

      const alreadyLogged = await isKRA8AlreadyLogged(senderPhone, finalCustomerName);
      if (!alreadyLogged) {
        await supabase.from('kra_logs').insert({
          salesperson_phone: senderPhone,
          kra_number: 8,
          kra_type: 'complaint_resolved',
          customer_name: finalCustomerName,
          description: `Complaint Resolved: ${finalCustomerName} (${resolutionTimeHrs}h - ${isSlaCompliant ? 'Within SLA ✅' : 'SLA BREACHED ⚠️'})`,
          month: new Date().getMonth() + 1,
          year: new Date().getFullYear(),
          created_at: resolvedAt.toISOString(),
        });
      }

      try {
        syncActivity('complaint_resolved', {
          customerName: finalCustomerName,
          complaintType,
          description: resolutionNotes,
          affectedProduct: updatedProduct || affectedProduct,
          action: 'resolve',
          resolutionTimeHrs,
          senderPhone,
        });
      } catch (e) {
        console.warn('[ComplaintAgent] Bigin sync notice:', e.message);
      }

      try {
        logBotActivity({
          salesperson_phone: senderPhone,
          description: `Complaint resolved for ${finalCustomerName}: ${resolutionNotes}`,
          module: 'Complaints',
          customer_name: finalCustomerName,
        });
      } catch (actErr) {
        console.warn('[ComplaintAgent] Activity log notice:', actErr?.message);
      }

      const orderRef = openComplaint.po_number
        ? `PO: *${openComplaint.po_number}* (#INQ-${(openComplaint.deal_id || '').substring(0, 6).toUpperCase()})`
        : openComplaint.deal_id ? `Inquiry: *#INQ-${openComplaint.deal_id.substring(0, 6).toUpperCase()}*` : '';

      await saveActiveSession(senderPhone, finalCustomerName, 'complaint_resolved');

      // Auto-resolve open follow-up tasks for this customer
      try {
        const { resolveCustomerFollowupTasks } = require('../kra3');
        await resolveCustomerFollowupTasks(finalCustomerName, senderPhone, 'complaint_resolved', openComplaint.deal_id);
      } catch (rErr) {
        console.warn('[ComplaintAgent] Follow-up auto-resolution notice:', rErr.message);
      }

      return `✅ *Customer Complaint Resolved!*\n\n` +
        `Customer: *${finalCustomerName}*\n` +
        (orderRef ? `Linked Order: ${orderRef}\n` : '') +
        `Product: *${updatedProduct || 'Steel Material'}*\n` +
        `Resolution Notes: ${resolutionNotes}\n` +
        `Resolution Time: *${resolutionTimeHrs} Hours*\n` +
        `SLA Target (48h): *${isSlaCompliant ? '✅ Achieved - Within SLA Target!' : '⚠️ Breached - Escalated!'}*\n\n` +
        `Updated Customer Complaints Card! ✅`;

    } else {
      const nowIso = new Date().toISOString();
      const resolvedDirectProduct = await resolveProductFromContext(
        data.deal_id,
        data.po_number,
        finalCustomerName,
        affectedProduct,
        cleanDescription || originalText || resolutionNotes,
        senderPhone
      );

      await supabase.from('complaints').insert({
        customer_name: finalCustomerName,
        deal_id: data.deal_id || null,
        po_number: data.po_number || null,
        product_name: resolvedDirectProduct,
        affected_product: resolvedDirectProduct,
        reported_by: senderPhone,
        complaint_type: complaintType,
        description: cleanDescription,
        resolution_notes: resolutionNotes,
        status: 'resolved',
        created_at: nowIso,
        reported_at: nowIso,
        resolved_at: nowIso,
        resolution_time_hrs: 0,
        escalated: false,
      });

      await saveActiveSession(senderPhone, finalCustomerName, 'complaint_resolved');

      return `✅ *Customer Complaint Resolved!*\n\n` +
        `Customer: *${finalCustomerName}*\n` +
        `Product: *${resolvedDirectProduct}*\n` +
        `Resolution Notes: ${resolutionNotes}\n` +
        `_Note: Created and marked resolved directly._\n\n` +
        `Updated Customer Complaints Card! ✅`;
    }
  }

  // ── REPORT / CREATE FLOW ───────────────────────────────────────────

  // Step 1: Identify reference type provided (PO Number vs Inquiry ID vs None)
  let rawPoCandidate = null;
  if (data.po_number && String(data.po_number).trim() && !/^(null|undefined|none|na|n\/a)$/i.test(String(data.po_number).trim())) {
    rawPoCandidate = String(data.po_number).trim();
  } else {
    const poMatch = originalText.match(/\b(?:PO|Purchase\s*Order)\b[\s#:-]*([A-Z0-9\/-]+)/i);
    if (poMatch && poMatch[1] && !/^(null|undefined|none|na|n\/a)$/i.test(poMatch[1].trim())) {
      rawPoCandidate = poMatch[1].trim();
    }
  }

  let cleanPo = null;
  if (rawPoCandidate) {
    cleanPo = rawPoCandidate
      .replace(/^\b(?:PO|Purchase\s*Order)\b[\s#:-]*/i, '')
      .replace(/^#+/, '')
      .trim();
    if (cleanPo.length < 2) cleanPo = null;
  }

  let rawInquiryCandidate = null;
  const inqMatch = (data.deal_id || '').match(/#?(?:DEAL|INQ)-([A-F0-9_-]{4,36})/i)
    || originalText.match(/#?(?:DEAL|INQ)-([A-F0-9_-]{4,36})/i)
    || (data.deal_id && !/^(null|undefined|none|na|n\/a)$/i.test(String(data.deal_id).trim()) ? [null, String(data.deal_id).replace(/^#?(?:DEAL|INQ)-/i, '').trim()] : null);

  if (inqMatch && inqMatch[1]) {
    rawInquiryCandidate = inqMatch[1].trim().toUpperCase();
  }

  let targetDealId = data.deal_id || null;
  let targetPoNumber = data.po_number || null;

  // Step 2: Fetch confirmed won orders from Orders module (deals table with stage = 'won') strictly scoped by role
  const activeWonDeals = await getCustomerActiveDeals(finalCustomerName, senderPhone);

  // Case A: PO Number or Inquiry ID explicitly provided by user
  if (cleanPo || rawInquiryCandidate) {
    const candInput = (cleanPo || rawInquiryCandidate).toUpperCase();

    const matchedDeal = activeWonDeals.find(d => {
      const dPo = (d.po_number || '').trim().toUpperCase();
      const dPoClean = dPo.replace(/^(?:PO|Purchase\s*Order)[\s#:-]*/i, '').replace(/^#+/, '');
      const dIdClean = (d.id || '').replace(/-/g, '').toUpperCase();
      const inqIdClean = (d.inquiry_id || '').replace(/-/g, '').toUpperCase();

      return (
        (dPo && (dPo === candInput || dPoClean === candInput || dPo.includes(candInput) || candInput.includes(dPoClean))) ||
        d.clean_code === candInput ||
        d.deal_code.toUpperCase() === candInput ||
        dIdClean.startsWith(candInput) ||
        inqIdClean.startsWith(candInput)
      );
    });

    if (matchedDeal) {
      targetDealId = matchedDeal.id;
      targetPoNumber = matchedDeal.po_number || null;
      if (!data.affected_product && matchedDeal.product_summary) {
        data.affected_product = matchedDeal.product_summary;
      }
    } else {
      // Check if it exists as an open inquiry in non-won stage
      const scope = await getAccessibleSalespersonPhonesForBot(senderPhone);
      let nonWonQuery = supabase
        .from('deals')
        .select('id, inquiry_id, customer_name, stage, salesperson_phone')
        .ilike('customer_name', `%${finalCustomerName.trim()}%`)
        .neq('stage', 'won');

      if (scope.phones !== null) {
        const targetPhones = expandPhoneVariants(scope.phones);
        if (targetPhones.length > 0) {
          nonWonQuery = nonWonQuery.in('salesperson_phone', targetPhones);
        } else {
          nonWonQuery = null;
        }
      }

      let nonWonDeals = [];
      if (nonWonQuery) {
        const { data: nwd } = await nonWonQuery.limit(20);
        nonWonDeals = nwd || [];
      }

      const nonWonMatch = (nonWonDeals || []).find(d => {
        const dId = (d.id || '').replace(/-/g, '').toUpperCase();
        const inqId = (d.inquiry_id || '').replace(/-/g, '').toUpperCase();
        return dId.startsWith(candInput) || inqId.startsWith(candInput);
      });

      if (nonWonMatch) {
        const stageName = (nonWonMatch.stage || 'inquiry').toUpperCase();
        const displayCode = `#INQ-${(nonWonMatch.id || nonWonMatch.inquiry_id).replace(/-/g, '').substring(0, 6).toUpperCase()}`;
        return `❌ *Cannot Log Complaint - Not an Order in Orders Module*\n\n` +
          `Inquiry *${displayCode}* is currently in *${stageName}* stage.\n\n` +
          `Complaints can only be logged for confirmed purchase orders (won deals) in the Orders module.`;
      }

      if (activeWonDeals.length > 0) {
        const availableList = activeWonDeals.map((d, idx) => {
          const poRef = d.po_number ? `PO: *${d.po_number}* (${d.deal_code})` : `*${d.deal_code}*`;
          const extra = [d.location, d.date_formatted].filter(Boolean).join(', ');
          return `${idx + 1}. ${poRef} — ${d.product_summary}${extra ? ` — ${extra}` : ''}`;
        }).join('\n');

        const primaryRef = activeWonDeals[0].po_number || activeWonDeals[0].deal_code;
        return `❌ *Cannot Log Complaint - Order Not Found in Orders Module*\n\n` +
          `Customer: *${finalCustomerName}*\n` +
          `Order / PO *"${cleanPo || rawInquiryCandidate}"* was not found in the Orders module.\n\n` +
          `*Available Confirmed Orders for ${finalCustomerName}:*\n` +
          `${availableList}\n\n` +
          `👉 Please reply with a valid *PO Number* (e.g. _"${primaryRef}"_) or *Inquiry ID* from the list above.`;
      } else {
        return `❌ *Cannot Log Complaint - No Confirmed Orders in Orders Module*\n\n` +
          `Customer: *${finalCustomerName}*\n` +
          `Order / PO *"${cleanPo || rawInquiryCandidate}"* was not found in the Orders module, and there are no confirmed won orders recorded for this customer.\n\n` +
          `Complaints can only be logged for confirmed purchase orders (won deals) present in the Orders module.`;
      }
    }
  }
  // Case B: Neither PO nor Inquiry ID was explicitly provided
  else if (!targetDealId) {
    if (activeWonDeals.length === 0) {
      return `❌ *Cannot Log Complaint - No Confirmed Orders in Orders Module*\n\n` +
        `Customer: *${finalCustomerName}*\n` +
        `No confirmed purchase orders (won deals) were found in the Orders module for this customer.\n\n` +
        `Complaints can only be logged for confirmed purchase orders present in the Orders module.`;
    }

    if (activeWonDeals.length === 1 && !data.is_confirmation) {
      const d = activeWonDeals[0];
      const itemSummary = d.product_summary || affectedProduct || 'Steel Material';
      const poDisplay = d.po_number ? `PO: *${d.po_number}* (${d.deal_code})` : `*${d.deal_code}*`;
      const resolvedDraftProd = affectedProduct || itemSummary;
      const draftPayload = JSON.stringify({
        customer_name: finalCustomerName,
        dealId: d.effective_deal_id || d.inquiry_id || d.id,
        poNumber: d.po_number || null,
        product: resolvedDraftProd,
        complaintType: complaintType,
        description: cleanDescription,
      });

      await saveActiveSession(senderPhone, finalCustomerName, `complaint_confirm_deal|${draftPayload}`);

      return `🔍 *Confirm Linked Order for Complaint*\n\n` +
        `Customer: *${finalCustomerName}*\n` +
        `Found 1 confirmed order in Orders module:\n` +
        `• ${poDisplay} — ${itemSummary}\n\n` +
        `Is this complaint for ${poDisplay}?\n` +
        `👉 Reply *"Yes"* to confirm, or provide the PO Number / Inquiry ID.`;
    } else if (activeWonDeals.length > 1 && !data.is_confirmation) {
      const dealListFormatted = activeWonDeals.map((d, idx) => {
        const poDisplay = d.po_number ? `PO: *${d.po_number}* (${d.deal_code})` : `*${d.deal_code}*`;
        const extra = [d.location, d.date_formatted].filter(Boolean).join(', ');
        return `${idx + 1}. ${poDisplay} — ${d.product_summary}${extra ? ` — ${extra}` : ''}`;
      }).join('\n');

      const samplePo = activeWonDeals[0].po_number || activeWonDeals[0].deal_code;
      const draftPayload = JSON.stringify({
        customer_name: finalCustomerName,
        product: affectedProduct || null,
        complaintType: complaintType,
        description: cleanDescription,
        candidates: activeWonDeals,
      });

      await saveActiveSession(senderPhone, finalCustomerName, `complaint_confirm_deal|${draftPayload}`);

      return `⚠️ *Multiple Confirmed Orders Found for ${finalCustomerName}*\n\n` +
        `Please specify which order or PO this complaint is about:\n\n` +
        `${dealListFormatted}\n\n` +
        `👉 Please reply with the *Number* (e.g. *1* or *2*) or the *PO Number* (e.g. _"${samplePo}"_) / *Inquiry ID*.`;
    } else if (activeWonDeals.length === 1 && data.is_confirmation) {
      targetDealId = activeWonDeals[0].effective_deal_id || activeWonDeals[0].inquiry_id || activeWonDeals[0].id;
      targetPoNumber = activeWonDeals[0].po_number || null;
    }
  }

  // Hard gating: ensure complaint cannot proceed without a valid won order in the Orders module
  if (!targetDealId) {
    return `❌ *Cannot Log Complaint - No Confirmed Order in Orders Module*\n\n` +
      `Complaints can only be logged for confirmed purchase orders present in the Orders module.`;
  }

  // Step 3: Insert new complaint record (Creation Status is strictly "open")
  const nowIso = new Date().toISOString();
  const reportedAt = new Date();
  const slaDueAt = new Date(reportedAt.getTime() + 48 * 60 * 60 * 1000); // 48h SLA

  const finalProduct = await resolveProductFromContext(
    targetDealId,
    targetPoNumber,
    finalCustomerName,
    affectedProduct,
    cleanDescription || originalText,
    senderPhone
  );

  // Sanitize description to remove any custom status prefix
  const sanitizedDescription = cleanDescription
    .replace(/^status:\s*(?:in progress|pending|open|resolved|closed)[,\s]*/i, '')
    .trim() || cleanDescription;

  const insertPayload = {
    customer_name: finalCustomerName,
    deal_id: targetDealId || null,
    po_number: targetPoNumber || null,
    product_name: finalProduct,
    affected_product: finalProduct,
    reported_by: senderPhone,
    complaint_type: complaintType,
    description: sanitizedDescription,
    status: 'open',
    created_at: nowIso,
    reported_at: nowIso,
    sla_due_at: slaDueAt.toISOString(),
    escalated: false,
  };

  const { error: insertError } = await supabase
    .from('complaints')
    .insert(insertPayload)
    .select()
    .single();

  if (insertError) {
    console.error('[ComplaintAgent] Error inserting complaint:', insertError);
  }

  await saveActiveSession(senderPhone, finalCustomerName, 'complaint_logged');

  // Log KRA 7
  await supabase.from('kra_logs').insert({
    salesperson_phone: senderPhone,
    kra_number: 7,
    kra_type: 'quality_complaint',
    customer_name: finalCustomerName,
    description: `Complaint Logged: ${finalCustomerName} - ${complaintType}: ${finalProduct}`,
    month: new Date().getMonth() + 1,
    year: new Date().getFullYear(),
    created_at: nowIso,
  });

  // Log to activity_logs
  try {
    const cleanCodeForLog = targetDealId ? (targetDealId.startsWith('DEAL-') || targetDealId.startsWith('INQ-') ? targetDealId.replace(/^(?:DEAL|INQ)-/, '') : targetDealId.substring(0, 6).toUpperCase()) : '';
    logBotActivity({
      salesperson_phone: senderPhone,
      description: `New complaint logged for ${finalCustomerName}${targetPoNumber ? ` (PO: ${targetPoNumber})` : targetDealId ? ` (Inquiry: #INQ-${cleanCodeForLog})` : ''}`,
      module: 'Complaints',
      customer_name: finalCustomerName,
    });
  } catch (actErr) {
    console.warn('[ComplaintAgent] Activity log notice:', actErr?.message);
  }

  // Auto-resolve pending follow-up tasks for this customer
  try {
    const { resolveCustomerFollowupTasks } = require('../kra3');
    await resolveCustomerFollowupTasks(finalCustomerName, senderPhone, 'complaint_logged', targetDealId);
  } catch (rErr) {
    console.warn('[ComplaintAgent] Follow-up auto-resolution notice:', rErr.message);
  }

  const cleanCode = targetDealId ? (targetDealId.startsWith('DEAL-') || targetDealId.startsWith('INQ-') ? targetDealId.replace(/^(?:DEAL|INQ)-/, '') : targetDealId.replace(/-/g, '').substring(0, 6).toUpperCase()) : '';
  const orderRef = targetPoNumber
    ? `PO: *${targetPoNumber}* ${cleanCode ? `(#INQ-${cleanCode})` : ''}`
    : cleanCode ? `Inquiry *#INQ-${cleanCode}*` : 'Unlinked';

  return `🚨 *Customer Complaint Logged*\n\n` +
    `Customer: *${finalCustomerName}*\n` +
    `Linked Ref: ${orderRef}\n` +
    `Product: *${finalProduct}*\n` +
    `Type: *${complaintType.toUpperCase()}*\n` +
    `Details: ${sanitizedDescription}\n` +
    `Status: *Open ⏱️ (48-Hour SLA Clock Started)*\n` +
    `SLA Due: *${slaDueAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}*\n\n` +
    `Updated Customer Complaints Card! ✅\n\n` +
    `When resolved, reply: _"Resolved complaint for ${finalCustomerName}: [resolution notes]"_ ✅`;
}

async function processComplaintMessage(text, senderPhone) {
  try {
    const { invokeWithFallback } = require('../core/modelRouter');
    const { HumanMessage, SystemMessage } = require('@langchain/core/messages');
    const response = await invokeWithFallback([
      new SystemMessage(COMPLAINT_AGENT_PROMPT),
      new HumanMessage('Salesperson message:\n' + text),
    ]);
    const rawText = typeof response.content === 'string' ? response.content : JSON.stringify(response.content || '');
    const { safeParseJSON } = require('../utils/jsonUtils');
    const data = safeParseJSON(rawText, null);
    if (!data) throw new Error('Could not parse complaint JSON from LLM response');

    // Extract list of complaints
    const rawComplaints = Array.isArray(data.complaints) && data.complaints.length > 0
      ? data.complaints
      : [data];

    const results = [];
    for (const comp of rawComplaints) {
      const res = await processSingleComplaint(comp, text, senderPhone);
      results.push(res);
    }

    return results.join('\n\n━━━━━━━━━━━━━━━━━━━━\n\n');

  } catch (error) {
    console.error('Complaint Agent Error:', error.message);
    return `⚠️ Could not process complaint: ${error.message}`;
  }
}

module.exports = { processComplaintMessage };
